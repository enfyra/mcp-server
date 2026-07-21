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
  DISCOVERY_FETCH_TIMEOUT_MS,
  ENFYRA_API_URL,
  SCRIPT_BACKED_TABLE_SET,
} from './tool-runtime-config.js';
import {
  firstDataRecord,
  getId,
  summarizeTable,
  unwrapData,
} from './tool-metadata-operations.js';

export function parseJsonArg(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

export function stringifyJsonArg(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function applyDeepFieldSelections(fields, deep) {
  const selectedFields = [...fields];
  const parsedDeep = parseJsonArg(deep, null);
  if (!parsedDeep || typeof parsedDeep !== 'object' || Array.isArray(parsedDeep)) {
    return { fields: selectedFields, autoAdded: [] };
  }
  if (selectedFields.some((field) => String(field).startsWith('-'))) {
    return { fields: selectedFields, autoAdded: [] };
  }
  const autoAdded = [];
  for (const relationName of Object.keys(parsedDeep)) {
    const alreadySelected = selectedFields.some((field) => {
      const text = String(field);
      return text === relationName || text.startsWith(`${relationName}.`);
    });
    if (alreadySelected) continue;
    selectedFields.push(relationName);
    autoAdded.push(relationName);
  }
  return { fields: selectedFields, autoAdded };
}

export async function reloadRoutesResult() {
  try {
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' });
    return {
      attempted: true,
      succeeded: true,
      result,
    };
  } catch (error) {
    return {
      attempted: true,
      succeeded: false,
      error: error?.message || String(error),
    };
  }
}

export function normalizeRestPath(path) {
  if (!path) return '/';
  if (/^https?:\/\//i.test(path)) {
    throw new Error('Only Enfyra API paths are allowed, not full external URLs');
  }
  return path.startsWith('/') ? path : `/${path}`;
}

export function pickCodeSummary(record, fieldName) {
  const code = record?.[fieldName];
  return {
    ...record,
    [fieldName]: typeof code === 'string'
      ? {
          length: code.length,
          preview: code.length > 700 ? `${code.slice(0, 700)}...` : code,
        }
      : code,
  };
}

export function summarizeMutationResult(result, action, tableName) {
  const record = firstDataRecord(result);
  return {
    action,
    tableName,
    id: getId(record),
    statusCode: result?.statusCode,
    success: result?.success,
    detailHint: `Use find_one_record or query_table with explicit fields to inspect ${tableName}.`,
  };
}

export async function getTableSummary(tableName) {
  return summarizeTable(await fetchTableMetadata(ENFYRA_API_URL, tableName));
}

export async function getPrimaryFieldName(tableName, table = null) {
  const resolvedTable = table ?? await getTableSummary(tableName);
  if (resolvedTable?.primaryKey) return resolvedTable.primaryKey;
  const metadata = await fetchMetadataContext(ENFYRA_API_URL);
  return metadata.dbType === 'mongodb' ? '_id' : 'id';
}

export async function fetchAll(path) {
  return unwrapData(await fetchAPI(ENFYRA_API_URL, path));
}

export function targetInstance() {
  return {
    apiBase: ENFYRA_API_URL.replace(/\/$/, ''),
    source: 'ENFYRA_API_URL environment variable used by this MCP server process',
  };
}

export async function discoveryFetch(path, { fallbackData = [], timeoutMs = DISCOVERY_FETCH_TIMEOUT_MS } = {}) {
  let timeoutId;
  try {
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Discovery request timeout after ${timeoutMs}ms for ${path}`));
      }, timeoutMs);
    });
    return await Promise.race([
      fetchAPI(ENFYRA_API_URL, path),
      timeout,
    ]);
  } catch (error) {
    return {
      statusCode: null,
      success: false,
      error: String(error?.message || error),
      data: fallbackData,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function collectPartialErrors(results) {
  return Object.entries(results)
    .filter(([, result]) => (result as AnyRecord)?.error)
    .map(([name, result]) => ({ name, error: (result as AnyRecord).error }));
}

export async function getMetadataTables(tableRef?: unknown) {
  const metadata = await fetchMetadataContext(ENFYRA_API_URL);
  if (tableRef !== undefined && tableRef !== null && tableRef !== '') {
    return {
      metadata,
      tables: [await fetchTableMetadataByRef(ENFYRA_API_URL, tableRef) as AnyRecord],
    };
  }
  const catalog = await fetchTableCatalog(ENFYRA_API_URL);
  return {
    metadata,
    tables: catalog as AnyRecord[],
  };
}

function resolveTableOrThrow(tables, tableName) {
  const table = tables.find((item) => item?.name === tableName || item?.alias === tableName);
  if (!table) throw new Error(`Unknown table "${tableName}"`);
  return table;
}

function resolveFieldOrThrow(table, fieldName, kind = 'column') {
  const list = kind === 'relation' ? table.relations || [] : table.columns || [];
  const field = list.find((item) => item.name === fieldName || item.propertyName === fieldName);
  if (!field) throw new Error(`Unknown ${kind} "${fieldName}" on table "${table.name}"`);
  return field;
}

export async function prepareGenericMutation(tableName, data) {
  const { tables } = await getMetadataTables(tableName);
  return prepareRecordMutation({
    fetchAPI,
    apiUrl: ENFYRA_API_URL,
    tables,
    tableName,
    data,
  });
}

export async function prepareGenericBatchMutation(tableName, records) {
  const { tables } = await getMetadataTables(tableName);
  return prepareRecordBatchMutation({
    fetchAPI,
    apiUrl: ENFYRA_API_URL,
    tables,
    tableName,
    records,
  });
}

export function assertKnowledgeForGenericMutation(tableName, data, { knowledgeAckKey, extensionKnowledgeAckKey }) {
  const payload = parseRecordData(data);
  assertDynamicCodeKnowledgeAckIf(SCRIPT_BACKED_TABLE_SET.has(tableName) && typeof payload.sourceCode === 'string', knowledgeAckKey);
  assertExtensionKnowledgeAckIf(tableName === 'enfyra_extension' && typeof payload.code === 'string', extensionKnowledgeAckKey);
}

export function assertKnowledgeForGenericBatchMutation(tableName, records, { knowledgeAckKey, extensionKnowledgeAckKey }) {
  const payloads = parseRecordBatchData(records);
  for (const payload of payloads) {
    assertDynamicCodeKnowledgeAckIf(SCRIPT_BACKED_TABLE_SET.has(tableName) && typeof payload.sourceCode === 'string', knowledgeAckKey);
    assertExtensionKnowledgeAckIf(tableName === 'enfyra_extension' && typeof payload.code === 'string', extensionKnowledgeAckKey);
  }
}

export function parseBulkItemsArg(name, value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array. Pass one object in the array for a single mutation.`);
  }
  if (parsed.length === 0) {
    throw new Error(`${name} must include at least one item.`);
  }
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${name}[${index}] must be a JSON object.`);
    }
  });
  return parsed;
}

export function assertMaxBulkItems(name, items, maxItems) {
  if (items.length > maxItems) {
    throw new Error(`${name} received ${items.length} items, above maxItems=${maxItems}. Split the batch deliberately.`);
  }
}

export function assertNoDuplicateBulkIds(name, items) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    const id = String(item.id ?? '');
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new Error(`${name} contains duplicate id(s): ${[...duplicates].join(', ')}. Split or merge duplicate writes so the sequential batch has one clear final mutation per record.`);
  }
}

export async function validateExtensionCodeForGenericMutation(tableName, payload, fallbackName) {
  if (tableName !== 'enfyra_extension' || typeof payload?.code !== 'string') return null;
  return validateExtensionCode(ENFYRA_API_URL, payload.code, payload.name || fallbackName);
}

export function parseQueryParamsArg(queryParams) {
  const parsed = parseJsonArg(queryParams, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('queryParams must be a JSON object string.');
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export function appendQuery(path, queryParams) {
  if (!queryParams) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${queryParams}`;
}
