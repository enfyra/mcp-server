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
  firstDataRecord,
  getId,
  refId,
} from './tool-metadata-operations.js';
import {
  DEFAULT_ME_PERMISSION_FIELDS,
  ENFYRA_API_URL,
  MCP_PERMISSION_REQUIREMENTS,
} from './tool-runtime-config.js';

function normalizePermissionRoute(routePath) {
  const value = String(routePath || '').trim();
  return value.startsWith('/') ? value : `/${value}`;
}

export function methodNames(permission) {
  return normalizeMethodNames((permission?.methods || []).map((method) => method?.name || method));
}

function permissionAllowedUserIds(permission) {
  return (permission?.allowedUsers || []).map((user) => String(refId(user))).filter(Boolean);
}

function permissionMatchesUser(permission, userId) {
  const allowed = permissionAllowedUserIds(permission);
  if (!allowed.length) return true;
  return userId ? allowed.includes(String(userId)) : false;
}

function directPermissionMatchesUser(permission, userId) {
  const allowed = permissionAllowedUserIds(permission);
  return userId ? allowed.includes(String(userId)) : false;
}

function userHasRoutePermission(user, routePath, method) {
  if (!user) return false;
  if (user.isRootAdmin) return true;

  const normalizedRoute = normalizePermissionRoute(routePath);
  const normalizedMethod = String(method || '').toUpperCase();
  const userId = getId(user);
  const directPermissions = user.allowedRoutePermissions || [];
  const rolePermissions = user.role?.routePermissions || [];

  const matchesRouteAndMethod = (permission) => (
    permission?.isEnabled !== false
    && permission?.route?.path === normalizedRoute
    && methodNames(permission).includes(normalizedMethod)
  );

  return directPermissions.some((permission) => (
    matchesRouteAndMethod(permission)
    && directPermissionMatchesUser(permission, userId)
  )) || rolePermissions.some((permission) => (
    matchesRouteAndMethod(permission)
    && permissionMatchesUser(permission, userId)
  ));
}

export function summarizePermissionProfile(user) {
  const requirements = MCP_PERMISSION_REQUIREMENTS.map((requirement) => {
    const methods = requirement.methods.map((method) => ({
      method,
      allowed: userHasRoutePermission(user, requirement.route, method),
    }));
    return {
      ...requirement,
      methods,
      allowed: methods.every((item) => item.allowed),
    };
  });

  return {
    user: user ? {
      id: getId(user),
      email: user.email || null,
      isRootAdmin: !!user.isRootAdmin,
      role: user.role ? {
        id: getId(user.role),
        name: user.role.name || null,
      } : null,
    } : null,
    permissionModel: {
      sameAsAdminUi: 'Mirrors Enfyra admin usePermissions(): root admin passes; otherwise direct allowedRoutePermissions are checked before role.routePermissions.',
      publicMethods: 'Anonymous REST access is controlled by route.publicMethods; this profile only reports authenticated route permissions for the configured token.',
    },
    mcpRequirements: requirements,
    missingRequirements: requirements
      .filter((item) => !item.allowed)
      .map((item) => ({
        area: item.area,
        route: item.route,
        methods: item.methods.filter((method) => !method.allowed).map((method) => method.method),
        tools: item.tools,
      })),
  };
}

export async function resolveCatalogToolAvailability(toolNames: string[]): Promise<Record<string, ToolAvailability>> {
  const fields = DEFAULT_ME_PERMISSION_FIELDS.join(',');
  const result = await fetchAPI(ENFYRA_API_URL, `/me?fields=${encodeURIComponent(fields)}`);
  const user = firstDataRecord(result);
  if (user?.isRootAdmin) {
    return Object.fromEntries(toolNames.map((name) => [name, {
      status: 'allowed',
      reason: 'The configured PAT belongs to a root administrator.',
    }]));
  }
  const requirements = summarizePermissionProfile(user).mcpRequirements;
  return Object.fromEntries(toolNames.map((name) => {
    const requirement = requirements.find((item) => item.tools.includes(name));
    if (!requirement) {
      return [name, {
        status: 'unknown',
        reason: 'No static admin-route capability mapping exists for this tool; Enfyra PAT/RBAC remains authoritative at execution time.',
      }];
    }
    return [name, requirement.allowed
      ? { status: 'allowed', reason: `Current PAT grants ${requirement.methods.map((item) => item.method).join(', ')} ${requirement.route}.` }
      : { status: 'denied', reason: `Current PAT lacks one or more required methods on ${requirement.route}.` }];
  }));
}
