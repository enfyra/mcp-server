/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

// Import modules
import { fetchAPI } from './fetch.js';
import {
  fetchMetadataContext,
  fetchTableCatalog,
  fetchTableMetadata,
  fetchTableMetadataByRef
} from './metadata-client.js';
import { parseRecordBatchData, parseRecordData, prepareRecordBatchMutation, prepareRecordMutation } from './mutation-guards.js';
import { validateExtensionCode } from './platform-operation-tools.js';
import {
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAckIf
} from './required-knowledge.js';
import {
  firstDataRecord,
  getId,
  summarizeTable,
  unwrapData,
} from './tool-metadata-operations.js';
import {
  AnyRecord,
  DISCOVERY_FETCH_TIMEOUT_MS,
  ENFYRA_API_URL,
  SCRIPT_BACKED_TABLE_SET,
} from './tool-runtime-config.js';

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
