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
export function registerSystemTools(server, ENFYRA_API_URL) {
  // ============================================================================
  // CACHE & SYSTEM TOOLS
  // ============================================================================
  
  server.tool('reload_all', 'Reload all caches (metadata, routes, GraphQL)', {
    globalRulesAckKey: globalRulesAckParam(z),
  }, async ({ globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload', { method: 'POST' });
    return jsonContent({ action: 'reloaded_all', result });
  });

  server.tool('reload_metadata', 'Reload metadata cache only', {
    globalRulesAckKey: globalRulesAckParam(z),
  }, async ({ globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/metadata', { method: 'POST' });
    return jsonContent({ action: 'reloaded_metadata', result });
  });

  server.tool('reload_routes', 'Reload routes cache only', {
    globalRulesAckKey: globalRulesAckParam(z),
  }, async ({ globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' });
    return jsonContent({ action: 'reloaded_routes', result });
  });

  server.tool('reload_graphql', 'Reload GraphQL schema', {
    globalRulesAckKey: globalRulesAckParam(z),
  }, async ({ globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/graphql', { method: 'POST' });
    return jsonContent({ action: 'reloaded_graphql', result });
  });
}
