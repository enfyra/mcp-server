/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
// Import modules
import { exchangeApiToken, refreshAccessToken, getValidToken, resetTokens, getTokenExpiry, initAuth } from './auth.js';
import { fetchAPI, validateFilter, validateTableName } from './fetch.js';
import {
  fetchMetadataContext,
  fetchMetadataTables,
  fetchTableCatalog,
  fetchTableMetadata,
  fetchTableMetadataByRef,
} from './metadata-client.js';
import { buildMcpServerInstructions, buildGraphqlUrls } from './mcp-instructions.js';
import { getExamples, listExampleCategories } from './mcp-examples.js';
import { WORKFLOW_SURFACES, discoverWorkflowRoutes } from './tool-routing.js';
import { getSupportedColumnTypesFromMetadata, registerTableTools } from './table-tools.js';
import { registerPlatformOperationTools, validateExtensionCode } from './platform-operation-tools.js';
import { registerRuntimeZoneTools } from './runtime-zone-tools.js';
import { registerOAuthProviderTools } from './oauth-tools.js';
import { registerDynamicRepositoryBuilder } from './dynamic-repository-builder.js';
import { buildDynamicScriptContextTypeContract } from './dynamic-script-context-contract.js';
import { assertCreateHandlerRouteBoundary } from './dynamic-endpoint-contract.js';
import { assertGenericRecordMutationAllowed, parseRecordBatchData, parseRecordData, prepareRecordBatchMutation, prepareRecordMutation, validatePortableScriptSource, validateScriptSourceIfPresent } from './mutation-guards.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAckIf,
  assertGlobalRulesAck,
  acknowledgeRequiredKnowledge,
  buildRequiredKnowledgePayload,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';
import { validateMainTableRoutePath } from './route-guards.js';
import { assertRecordFieldsReadable, buildDeletePostcondition, buildQuerySchemaReceipt } from './record-contracts.js';
import { installColumnarToolFormatter, jsonContent } from './response-format.js';
import { startMcpUsageTelemetry } from './mcp-usage-telemetry.js';
import { startRuntimeCacheSocket } from './runtime-cache-socket.js';
import { executeSequentialBatch } from './sequential-batch.js';
import { compactSourceFields, readSourceArtifactResource, writeSourceArtifact } from './source-artifacts.js';
import { installToolsetFilter, normalizeDynamicToolPacks, normalizeMcpProfile, normalizeMcpToolset, summarizeToolsetForInstructions } from './toolset-filter.js';
import { installToolAnnotations } from './tool-contracts.js';
import { installToolOutputContracts } from './tool-output-contracts.js';
import { registerToolCatalogTools } from './tool-catalog.js';
import { registerWorkflowToolPack } from './workflow-tool-packs.js';
import type { ToolAvailability } from './types.js';
import {
  findRoutePermission,
  mergeMethodNames,
  normalizeMethodNames,
  resolveRoleByNameOrId,
  routeAvailableMethodNames,
  routePublicMethodNames,
  summarizeRouteAccess,
  summarizeRoutePermission,
  validateMethodsForRoute,
} from './route-permission-tools.js';
import {
  AnyRecord,
  ENFYRA_API_URL,
} from './tool-runtime-config.js';
import {
  getId,
  refId,
  sameId,
  unwrapData,
} from './tool-metadata-operations.js';
import {
  collectPartialErrors,
  discoveryFetch,
  fetchAll,
  getMetadataTables,
  pickCodeSummary,
} from './tool-record-operations.js';

// ROUTE & HANDLER TOOLS
// ============================================================================

let _methodMap = null;

export function invalidateMethodMap() {
  _methodMap = null;
}

export async function getMethodMap() {
  if (_methodMap) return _methodMap;
  const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_method?limit=0');
  _methodMap = {};
  for (const m of result.data) {
    _methodMap[m.name] = m.id || m._id;
  }
  return _methodMap;
}

export function resolveMethodIds(methodMap, names) {
  return names.map(m => {
    const id = methodMap[m.toUpperCase()];
    if (!id) throw new Error(`Unknown method "${m}". Valid: ${Object.keys(methodMap).join(', ')}`);
    return { id };
  });
}

export async function getMethodIdNameMap() {
  const methodMap = await getMethodMap();
  return Object.fromEntries(Object.entries(methodMap).map(([method, id]) => [String(id), method]));
}

function withMethodNames(records, methodIdNameMap, field = 'methods') {
  return records.map((record) => ({
    ...record,
    [field]: Array.isArray(record?.[field])
      ? record[field].map((item) => ({
          ...item,
          name: item.name || methodIdNameMap[String(getId(item))] || null,
        }))
      : record?.[field],
  }));
}

export async function collectRestDefinitionState(tableRef?: unknown) {
  await getValidToken(ENFYRA_API_URL);
  const [
    metadataContext,
    routes,
    handlers,
    preHooks,
    postHooks,
    routePermissions,
    guards,
    guardRules,
    fieldPermissions,
    columnRules,
    methodIdNameMap,
  ] = await Promise.all([
    getMetadataTables(tableRef),
    fetchAll('/enfyra_route?limit=1000'),
    fetchAll('/enfyra_route_handler?limit=1000'),
    fetchAll('/enfyra_pre_hook?limit=1000'),
    fetchAll('/enfyra_post_hook?limit=1000'),
    fetchAll('/enfyra_route_permission?limit=1000'),
    fetchAll('/enfyra_guard?limit=1000'),
    fetchAll('/enfyra_guard_rule?limit=1000'),
    fetchAll('/enfyra_field_permission?limit=1000'),
    fetchAll('/enfyra_column_rule?limit=1000'),
    getMethodIdNameMap(),
  ]);

  return {
    ...metadataContext,
    routes,
    handlers,
    preHooks,
    postHooks,
    routePermissions,
    guards,
    guardRules,
    fieldPermissions,
    columnRules,
    methodIdNameMap,
  };
}

export async function collectFeatureSearchState() {
  const metadata = await discoveryFetch('/metadata');
  const tableCatalogResult = await discoveryFetch('/enfyra_table?fields=id,name,alias,description,isSingleRecord&limit=0&sort=name');
  const routesResult = await discoveryFetch('/enfyra_route?limit=500');
  const handlersResult = await discoveryFetch('/enfyra_route_handler?limit=500');
  const preHooksResult = await discoveryFetch('/enfyra_pre_hook?limit=500');
  const postHooksResult = await discoveryFetch('/enfyra_post_hook?limit=500');
  const routePermissionsResult = await discoveryFetch('/enfyra_route_permission?limit=500');
  const guardsResult = await discoveryFetch('/enfyra_guard?limit=500');
  const guardRulesResult = await discoveryFetch('/enfyra_guard_rule?limit=500');
  const fieldPermissionsResult = await discoveryFetch('/enfyra_field_permission?limit=500');
  const columnRulesResult = await discoveryFetch('/enfyra_column_rule?limit=500');
  const methodsResult = await discoveryFetch('/enfyra_method?limit=100');
  const methodIdNameMap = Object.fromEntries(
    unwrapData(methodsResult).map((method) => [String(getId(method)), method.name]),
  );
  const tableCatalog = unwrapData(tableCatalogResult);

  return {
    metadata,
    tables: await fetchMetadataTables(ENFYRA_API_URL, tableCatalog) as AnyRecord[],
    routes: unwrapData(routesResult),
    handlers: unwrapData(handlersResult),
    preHooks: unwrapData(preHooksResult),
    postHooks: unwrapData(postHooksResult),
    routePermissions: unwrapData(routePermissionsResult),
    guards: unwrapData(guardsResult),
    guardRules: unwrapData(guardRulesResult),
    fieldPermissions: unwrapData(fieldPermissionsResult),
    columnRules: unwrapData(columnRulesResult),
    methodIdNameMap,
    partialErrors: collectPartialErrors({
      metadata,
      tableCatalogResult,
      routesResult,
      handlersResult,
      preHooksResult,
      postHooksResult,
      routePermissionsResult,
      guardsResult,
      guardRulesResult,
      fieldPermissionsResult,
      columnRulesResult,
      methodsResult,
    }),
  };
}

export function enrichRoute(route, state) {
  const routeId = getId(route);
  const routeHandlers = state.handlers
    .filter((item) => sameId(refId(item.route), routeId))
    .map((item) => pickCodeSummary({
      ...item,
      method: item.method ? {
        ...item.method,
        name: state.methodIdNameMap[String(getId(item.method))] || item.method.name || null,
      } : item.method,
    }, 'sourceCode'));
  const routePreHooks = withMethodNames(
    state.preHooks.filter((item) => item.isGlobal || sameId(refId(item.route), routeId)),
    state.methodIdNameMap,
  ).map((item) => pickCodeSummary(item, 'code'));
  const routePostHooks = withMethodNames(
    state.postHooks.filter((item) => item.isGlobal || sameId(refId(item.route), routeId)),
    state.methodIdNameMap,
  ).map((item) => pickCodeSummary(item, 'code'));
  const routePermissions = withMethodNames(
    state.routePermissions.filter((item) => sameId(refId(item.route), routeId)),
    state.methodIdNameMap,
  );
  const routeGuards = withMethodNames(
    state.guards.filter((item) => item.isGlobal || sameId(refId(item.route), routeId)),
    state.methodIdNameMap,
  ).map((guard) => ({
    ...guard,
    rules: state.guardRules.filter((rule) => sameId(refId(rule.guard), getId(guard))),
  }));

  return {
    ...route,
    availableMethods: Array.isArray(route.availableMethods)
      ? route.availableMethods.map((method) => ({
          ...method,
          name: method.name || state.methodIdNameMap[String(getId(method))] || null,
        }))
      : route.availableMethods,
    publicMethods: Array.isArray(route.publicMethods)
      ? route.publicMethods.map((method) => ({
          ...method,
          name: method.name || state.methodIdNameMap[String(getId(method))] || null,
        }))
      : route.publicMethods,
    skipRoleGuardMethods: Array.isArray(route.skipRoleGuardMethods)
      ? route.skipRoleGuardMethods.map((method) => ({
          ...method,
          name: method.name || state.methodIdNameMap[String(getId(method))] || null,
        }))
      : route.skipRoleGuardMethods,
    handlers: routeHandlers,
    preHooks: routePreHooks,
    postHooks: routePostHooks,
    routePermissions,
    guards: routeGuards,
  };
}
