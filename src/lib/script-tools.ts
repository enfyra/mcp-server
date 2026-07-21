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
  SCRIPT_BACKED_TABLES,
  fetchScriptRecord,
  prepareGenericMutation,
  replaceOccurrence,
  scriptRecordLabel,
  sha256,
  sourcePreview,
  summarizeMutationResult,
} from './enfyra-tool-logic.js';

export function registerScriptTools(server, ENFYRA_API_URL) {
  server.tool(
    'get_script_source',
    [
      'Fetch the full editable source for one script-backed metadata record without preview truncation.',
      'Use search_runtime_zone first and pass the returned nextInspect.input to inspect the concrete record. The inspection already returns exact source artifacts.',
      'Call get_script_source only when a fresh artifact is needed for that located record. Never guess or probe record ids.',
    ].join(' '),
    {
      tableName: z.enum(SCRIPT_BACKED_TABLES).describe('Script-backed table to read'),
      id: z.string().describe('Concrete record id returned by search_runtime_zone, inspect output, or a successful create/update operation. Never guess an id.'),
    },
    async ({ tableName, id }) => {
      const { primaryKey, record, sourceField, sourceCode } = await fetchScriptRecord(tableName, id);
      const sourceArtifact = writeSourceArtifact({ tableName, id, fieldName: sourceField, source: sourceCode });
      return { content: [{ type: 'text', text: JSON.stringify({
        tableName,
        id,
        primaryKey,
        sourceField,
        sourceFile: sourceArtifact.tmpFile,
        sourcePreview: sourceArtifact.preview,
        sourceLength: sourceCode.length,
        sourceSha256: sha256(sourceCode),
        scriptLanguage: record.scriptLanguage || record.language || null,
        record: scriptRecordLabel(tableName, record),
      }, null, 2) }] };
    },
  );

  server.tool(
    'patch_script_source',
    [
      'Patch sourceCode on a script-backed record using exact search/replace with optional hash checking.',
      'By default this returns a preview only. Set apply=true to validate through /admin/script/validate and save.',
      'Use get_script_source first for long scripts, then patch only the exact block you intend to change.',
    ].join(' '),
    {
      tableName: z.enum(SCRIPT_BACKED_TABLES).describe('Script-backed table to patch'),
      id: z.string().describe('Record ID to patch'),
      oldText: z.string().describe('Exact text to replace'),
      newText: z.string().describe('Replacement text'),
      occurrence: z.enum(['first', 'all']).optional().default('all').describe('Replace first occurrence or all occurrences.'),
      expectedSourceSha256: z.string().optional().describe('Optional SHA-256 from get_script_source; fails if source changed.'),
      scriptLanguage: z.string().optional().describe('Script language to save. Defaults to existing scriptLanguage or javascript.'),
      apply: z.boolean().optional().default(false).describe('false returns preview only; true validates and saves.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when apply=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required when apply=true. Use dynamicCodeAckKey from get_enfyra_required_knowledge.'),
    },
    async ({ tableName, id, oldText, newText, occurrence, expectedSourceSha256, scriptLanguage, apply, globalRulesAckKey, knowledgeAckKey }) => {
      const { record, sourceField, sourceCode } = await fetchScriptRecord(tableName, id);
      if (sourceField !== 'sourceCode') {
        throw new Error(`patch_script_source only saves sourceCode records. Record uses "${sourceField}"; use update_records intentionally for this legacy field.`);
      }
      const beforeHash = sha256(sourceCode);
      if (expectedSourceSha256 && expectedSourceSha256 !== beforeHash) {
        throw new Error(`Source hash mismatch. Current sha256 is ${beforeHash}; re-read with get_script_source before patching.`);
      }
      const { occurrences, patched, replaced } = replaceOccurrence(sourceCode, oldText, newText, occurrence || 'all');
      const afterHash = sha256(patched);
      const payload = {
        action: apply ? 'patch_script_source_applied' : 'patch_script_source_preview',
        tableName,
        id,
        sourceField,
        sourceLengthBefore: sourceCode.length,
        sourceLengthAfter: patched.length,
        sourceSha256Before: beforeHash,
        sourceSha256After: afterHash,
        occurrences,
        replaced,
        preview: {
          before: sourcePreview(sourceCode, oldText),
          after: sourcePreview(patched, newText),
        },
        next: apply ? undefined : 'Call patch_script_source again with apply=true and expectedSourceSha256 set to sourceSha256Before to validate and save.',
      };
      if (!apply) {
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
      assertGlobalRulesAck(globalRulesAckKey);
      assertDynamicCodeKnowledgeAck(knowledgeAckKey);
      const language = scriptLanguage || record.scriptLanguage || 'javascript';
      const prepared = await prepareGenericMutation(
        tableName,
        JSON.stringify({ sourceCode: patched, scriptLanguage: language }),
      );
      const result = await fetchAPI(
        ENFYRA_API_URL,
        `/${tableName}/${encodeURIComponent(String(id))}`,
        { method: 'PATCH', body: JSON.stringify(prepared.payload) },
      );
      return { content: [{ type: 'text', text: JSON.stringify({
        ...payload,
        ...summarizeMutationResult(result, 'patch_script_source_applied', tableName),
        id,
        scriptLanguage: language,
        scriptValidation: prepared.scriptValidation,
      }, null, 2) }] };
    },
  );

  server.tool(
    'update_script_source',
    [
      'Update sourceCode on a script-backed record without forcing the caller to JSON-escape long code.',
      'Use this for enfyra_flow_step, enfyra_route_handler, enfyra_pre_hook, enfyra_post_hook, enfyra_websocket_event, enfyra_websocket, enfyra_oauth_config, and enfyra_bootstrap_script.',
      'The tool validates sourceCode through /admin/script/validate before saving and never accepts compiledCode.',
    ].join(' '),
    {
      tableName: z.enum([
        'enfyra_route_handler',
        'enfyra_pre_hook',
        'enfyra_post_hook',
        'enfyra_flow_step',
        'enfyra_websocket_event',
        'enfyra_websocket',
        'enfyra_oauth_config',
        'enfyra_bootstrap_script',
      ]).describe('Script-backed table to update'),
      id: z.string().describe('Record ID to update'),
      sourceCode: z.string().describe('Editable script sourceCode. Pass the raw code string; do not JSON-escape it yourself.'),
      scriptLanguage: z.string().optional().default('javascript').describe('Script language, usually javascript or typescript'),
      globalRulesAckKey: globalRulesAckParam(z),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
    },
    async ({ tableName, id, sourceCode, scriptLanguage, globalRulesAckKey, knowledgeAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      assertDynamicCodeKnowledgeAck(knowledgeAckKey);
      validateTableName(tableName);
      const prepared = await prepareGenericMutation(
        tableName,
        JSON.stringify({ sourceCode, scriptLanguage }),
      );
      const result = await fetchAPI(
        ENFYRA_API_URL,
        `/${tableName}/${encodeURIComponent(String(id))}`,
        { method: 'PATCH', body: JSON.stringify(prepared.payload) },
      );
      return { content: [{ type: 'text', text: JSON.stringify({
        ...summarizeMutationResult(result, 'updated_script_source', tableName),
        id,
        sourceLength: sourceCode.length,
        scriptLanguage,
        scriptValidation: prepared.scriptValidation,
      }, null, 2) }] };
    },
  );
}
