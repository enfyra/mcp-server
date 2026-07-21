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
  DEFAULT_ME_PERMISSION_FIELDS,
  ENFYRA_API_TOKEN,
  firstDataRecord,
  summarizePermissionProfile,
} from './enfyra-tool-logic.js';

export function registerIdentityTools(server, ENFYRA_API_URL) {
  // ============================================================================
  // AUTH & USER TOOLS
  // ============================================================================
  
  server.tool('get_current_user', 'Get current authenticated user info', {}, async () => {
    const result = await fetchAPI(ENFYRA_API_URL, '/me');
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.tool(
    'get_permission_profile',
    [
      'Inspect the current token permission profile using the same route-permission model as Enfyra admin UI usePermissions().',
      'Use this before debugging 403s or before relying on admin helper tools with a non-root API token.',
      'Reports which MCP tool groups need route permissions such as /admin/script/validate, /admin/test/run, /admin/flow/trigger/:id, and reload endpoints.',
    ].join(' '),
    {},
    async () => {
      const fields = DEFAULT_ME_PERMISSION_FIELDS.join(',');
      const result = await fetchAPI(ENFYRA_API_URL, `/me?fields=${encodeURIComponent(fields)}`);
      const user = firstDataRecord(result);
      return jsonContent(summarizePermissionProfile(user));
    },
  );

  server.tool('get_all_roles', 'Get all role definitions', {}, async () => {
    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_role?limit=100');
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('login', 'Force authentication to Enfyra and get a new access token', {
    apiToken: z.string().optional().describe('API token for MCP and automation'),
  }, async ({ apiToken }) => {
    const token = apiToken || ENFYRA_API_TOKEN;
    if (token) {
      initAuth(ENFYRA_API_URL, token);
      await exchangeApiToken(ENFYRA_API_URL, token);
      const expiry = getTokenExpiry();
      const expiryLabel = expiry === Infinity ? 'no expiration' : new Date(expiry).toISOString();
      return { content: [{ type: 'text', text: `Authenticated with API token.\nToken expires: ${expiryLabel}` }] };
    }
    throw new Error('ENFYRA_API_TOKEN required');
  });
}
