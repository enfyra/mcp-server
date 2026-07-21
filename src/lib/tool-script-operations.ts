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
  ENFYRA_API_URL,
  SCRIPT_BACKED_TABLES,
  SCRIPT_SOURCE_FIELDS,
} from './tool-runtime-config.js';
import {
  getPrimaryFieldName,
} from './tool-record-operations.js';
import {
  getId,
  unwrapData,
} from './tool-metadata-operations.js';

const METHOD_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function normalizeMethodNameInput(method) {
  const value = String(method || '').trim().toUpperCase();
  if (!METHOD_NAME_RE.test(value)) {
    throw new Error('Method must start with A-Z and contain only uppercase letters, numbers, or underscore.');
  }
  return value;
}

export function normalizeHexColorInput(value, fieldName) {
  const color = String(value || '').trim().toLowerCase();
  if (!HEX_COLOR_RE.test(color)) {
    throw new Error(`${fieldName} must be a full hex color such as #1d4ed8.`);
  }
  return color;
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function getScriptSourceField(record) {
  for (const field of SCRIPT_SOURCE_FIELDS) {
    if (typeof record?.[field] === 'string') return field;
  }
  if (record?.config && typeof record.config === 'object' && typeof record.config.code === 'string') {
    return 'config.code';
  }
  return null;
}

export function getRecordSource(record) {
  const field = getScriptSourceField(record);
  if (!field) return { field: null, sourceCode: '' };
  if (field === 'config.code') return { field, sourceCode: record.config.code };
  return { field, sourceCode: record[field] };
}

async function fetchRecordByPrimaryKey(tableName, id, fields = '*') {
  const primaryKey = await getPrimaryFieldName(tableName);
  const query = new URLSearchParams({
    filter: JSON.stringify({ [primaryKey]: { _eq: id } }),
    limit: '1',
    fields,
  });
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}?${query.toString()}`);
  const record = unwrapData(result)[0] || null;
  if (!record) throw new Error(`${tableName} record ${id} was not found.`);
  return { primaryKey, record };
}

export async function fetchScriptRecord(tableName, id) {
  validateTableName(tableName);
  if (!SCRIPT_BACKED_TABLES.includes(tableName)) {
    throw new Error(`Unsupported script-backed table "${tableName}". Supported: ${SCRIPT_BACKED_TABLES.join(', ')}`);
  }
  const { primaryKey, record } = await fetchRecordByPrimaryKey(tableName, id, '*');
  const { field, sourceCode } = getRecordSource(record);
  if (!field) {
    throw new Error(`${tableName} record ${id} does not expose a known editable source field.`);
  }
  return { primaryKey, record, sourceField: field, sourceCode };
}

function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    index = source.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

export function replaceOccurrence(source, oldText, newText, mode) {
  const occurrences = countOccurrences(source, oldText);
  if (occurrences === 0) {
    throw new Error('oldText was not found in the current source.');
  }
  if (mode === 'first') {
    return {
      occurrences,
      patched: source.replace(oldText, newText),
      replaced: 1,
    };
  }
  return {
    occurrences,
    patched: source.split(oldText).join(newText),
    replaced: occurrences,
  };
}

export function sourcePreview(source, aroundText) {
  if (!aroundText) return source.slice(0, 1200);
  const index = source.indexOf(aroundText);
  if (index === -1) return source.slice(0, 1200);
  const start = Math.max(0, index - 500);
  const end = Math.min(source.length, index + aroundText.length + 500);
  return `${start > 0 ? '...' : ''}${source.slice(start, end)}${end < source.length ? '...' : ''}`;
}

export function scriptRecordLabel(tableName, record) {
  const method = record.method?.name || null;
  const route = record.route?.path || null;
  const flow = record.flow?.name || null;
  const gateway = record.gateway?.path || null;
  return {
    tableName,
    id: getId(record),
    key: record.key || record.name || record.eventName || record.provider || null,
    route,
    method,
    flow,
    gateway,
  };
}

export function scriptTraceFields(tableName) {
  const common = 'id,_id,name,key,eventName,sourceCode,handlerScript,connectionHandlerScript,code,scriptLanguage';
  const byTable = {
    enfyra_route_handler: `${common},route.id,route.path,method.id,method.name`,
    enfyra_pre_hook: `${common},route.id,route.path,methods.id,methods.name,isGlobal`,
    enfyra_post_hook: `${common},route.id,route.path,methods.id,methods.name,isGlobal`,
    enfyra_flow_step: `${common},flow.id,flow.name`,
    enfyra_websocket_event: `${common},gateway.id,gateway.path`,
    enfyra_websocket: `${common},path`,
    enfyra_oauth_config: `${common},provider,redirectUri,appCallbackUrl,autoSetCookies,isEnabled`,
    enfyra_bootstrap_script: common,
  };
  return byTable[tableName] || '*';
}

export async function findMethodRecordByName(method) {
  const filter = encodeURIComponent(JSON.stringify({ name: { _eq: method } }));
  const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_method?filter=${filter}&limit=1&fields=id,_id,name,buttonColor,textColor,isSystem`);
  return unwrapData(result)[0] || null;
}

export function isNotFoundDeleteError(error: unknown) {
  const message = String((error as any)?.message || error || '').toLowerCase();
  return message.includes('api error (404)')
    || message.includes('not found')
    || message.includes('not exists')
    || message.includes('does not exist');
}
