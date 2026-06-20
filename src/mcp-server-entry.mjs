/**
 * Enfyra MCP — stdio server (loaded by index.mjs).
 */

import { config } from 'dotenv';
config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';

// Configuration
const ENFYRA_API_URL = process.env.ENFYRA_API_URL || 'http://localhost:3000/api';
const ENFYRA_API_TOKEN = process.env.ENFYRA_API_TOKEN || '';
const DISCOVERY_FETCH_TIMEOUT_MS = 12000;

// Import modules
import { exchangeApiToken, refreshAccessToken, getValidToken, resetTokens, getTokenExpiry, initAuth } from './lib/auth.js';
import { fetchAPI, validateFilter, validateTableName } from './lib/fetch.js';
import { buildMcpServerInstructions, buildGraphqlUrls } from './lib/mcp-instructions.js';
import { getExamples, listExampleCategories } from './lib/mcp-examples.js';
import { registerTableTools } from './lib/table-tools.js';
import { registerPlatformOperationTools } from './lib/platform-operation-tools.js';
import { prepareRecordMutation, validateScriptSourceIfPresent } from './lib/mutation-guards.js';
import { validateMainTableRoutePath } from './lib/route-guards.js';
import { installColumnarToolFormatter, jsonContent } from './lib/response-format.js';
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
} from './lib/route-permission-tools.js';

// Initialize auth module
initAuth(ENFYRA_API_URL, ENFYRA_API_TOKEN);

const CAPABILITY_AREAS = [
  {
    area: 'Schema and metadata',
    tables: ['enfyra_table', 'enfyra_column', 'enfyra_relation', 'enfyra_schema_migration'],
    workflow: 'Use table tools for table/column/relation schema changes. enfyra_column and enfyra_session are internal/no-route; do not CRUD them directly.',
  },
  {
    area: 'Dynamic REST API',
    tables: ['enfyra_route', 'enfyra_route_handler', 'enfyra_pre_hook', 'enfyra_post_hook', 'enfyra_route_permission', 'enfyra_method'],
    workflow: 'Create custom paths with create_route without mainTableId, then add handlers/hooks. mainTableId is only for canonical table routes like /table_name. Query enfyra_method before assigning route methods.',
  },
  {
    area: 'Auth, roles, sessions, OAuth',
    tables: ['enfyra_user', 'enfyra_role', 'enfyra_api_token', 'enfyra_session', 'enfyra_oauth_config', 'enfyra_oauth_account'],
    workflow: 'MCP auth exchanges ENFYRA_API_TOKEN through /auth/token/exchange. Configure an API token from Enfyra admin UI /me.',
  },
  {
    area: 'Guards and permissions',
    tables: ['enfyra_guard', 'enfyra_guard_rule', 'enfyra_field_permission', 'enfyra_column_rule'],
    workflow: 'Use route guard metadata for request gating, field permissions for record field access, and column rules for body validation.',
  },
  {
    area: 'GraphQL',
    tables: ['enfyra_graphql'],
    workflow: 'Enable per table through enfyra_graphql or update_table graphqlEnabled. GraphQL requires Bearer auth.',
  },
  {
    area: 'Files and storage',
    tables: ['enfyra_file', 'enfyra_file_permission', 'enfyra_folder', 'enfyra_storage_config'],
    workflow: 'Use file endpoints/helpers for uploads and asset streaming; metadata tables describe files, permissions, folders, and storage backends.',
  },
  {
    area: 'WebSocket',
    tables: ['enfyra_websocket', 'enfyra_websocket_event'],
    workflow: 'Socket.IO gateways/events are metadata-backed. Use admin test runner for handler scripts before relying on a real client.',
  },
  {
    area: 'Flows',
    tables: ['enfyra_flow', 'enfyra_flow_step', 'enfyra_flow_execution'],
    workflow: 'Create flows as small operation-sized steps via CRUD, test steps with test_flow_step/run_admin_test, trigger with trigger_flow. Split oversized scripts instead of adding more work to one step.',
  },
  {
    area: 'Extensions, menus, packages',
    tables: ['enfyra_extension', 'enfyra_menu', 'enfyra_package', 'enfyra_bootstrap_script'],
    workflow: 'Extensions are Vue SFC records. Use install_package for enfyra_package rather than raw CRUD.',
  },
  {
    area: 'Settings and platform config',
    tables: ['enfyra_setting', 'enfyra_cors_origin'],
    workflow: 'Settings and CORS origins are metadata-backed platform configuration.',
  },
];

const FILTER_OPERATORS = [
  '_eq',
  '_neq',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_in',
  '_not_in',
  '_nin',
  '_contains',
  '_starts_with',
  '_ends_with',
  '_between',
  '_is_null',
  '_is_not_null',
  '_and',
  '_or',
  '_not',
];

const FIELD_PERMISSION_CONDITION_OPERATORS = [
  '_eq',
  '_neq',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_in',
  '_not_in',
  '_nin',
  '_is_null',
  '_is_not_null',
  '_and',
  '_or',
  '_not',
];

const SCRIPT_BACKED_TABLES = [
  'enfyra_route_handler',
  'enfyra_pre_hook',
  'enfyra_post_hook',
  'enfyra_flow_step',
  'enfyra_websocket_event',
  'enfyra_websocket',
  'enfyra_graphql',
  'enfyra_bootstrap_script',
];

const SCRIPT_SOURCE_FIELDS = [
  'sourceCode',
  'handlerScript',
  'connectionHandlerScript',
  'code',
];

function normalizeTables(metadata) {
  const tablesSource = metadata?.data?.tables || metadata?.tables || metadata?.data || [];
  return Array.isArray(tablesSource)
    ? tablesSource
    : Object.values(tablesSource || {});
}

function getPrimaryColumn(table) {
  return (table?.columns || []).find((column) => column.isPrimary) || null;
}

function inferPrimaryKeyContext(tables) {
  const primaryColumns = tables
    .map((table) => ({ table: table.name, primaryKey: getPrimaryColumn(table)?.name || null }))
    .filter((item) => item.primaryKey);
  const counts = primaryColumns.reduce((acc, item) => {
    acc[item.primaryKey] = (acc[item.primaryKey] || 0) + 1;
    return acc;
  }, {});
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    dominantPrimaryKey: dominant,
    counts,
    inferredBackendFamily: dominant === '_id' ? 'mongodb-like' : dominant === 'id' ? 'sql-like' : 'unknown',
    exactDatabaseType: 'not exposed by current public/admin API; infer from metadata or add a backend context endpoint for exact mysql/postgres/mongodb',
    sampleTables: primaryColumns.slice(0, 12),
  };
}

function getMetadataDatabaseContext(metadata, tables) {
  const inferred = inferPrimaryKeyContext(tables);
  return {
    dbType: metadata?.dbType || metadata?.data?.dbType || null,
    pkField: metadata?.pkField || metadata?.data?.pkField || inferred.dominantPrimaryKey,
    inferredBackendFamily: inferred.inferredBackendFamily,
    primaryKeyCounts: inferred.counts,
    source: metadata?.dbType || metadata?.data?.dbType
      ? 'metadata'
      : 'inferred from table primary columns',
    sampleTables: inferred.sampleTables,
  };
}

function summarizeTable(table) {
  if (!table) return null;
  const relationFkColumnNames = new Set((table.relations || []).flatMap((relation) => {
    const propertyName = relation.propertyName;
    return propertyName
      ? [
          `${propertyName}Id`,
          `${propertyName}_id`,
          relation.fkCol,
          relation.fkColumn,
          relation.foreignKeyColumn,
        ].filter(Boolean).map((name) => String(name).toLowerCase())
      : [];
  }));
  const modelFacingColumns = (table.columns || []).filter((column) => (
    column.isPrimary || !relationFkColumnNames.has(String(column.name || '').toLowerCase())
  ));
  return {
    id: table.id ?? table._id,
    name: table.name,
    alias: table.alias,
    primaryKey: getPrimaryColumn(table)?.name || null,
    validateBody: table.validateBody,
    graphqlEnabled: table.graphqlEnabled,
    columns: modelFacingColumns.map((column) => ({
      id: column.id ?? column._id,
      name: column.name,
      type: column.type,
      isPrimary: !!column.isPrimary,
      isNullable: column.isNullable,
      isPublished: column.isPublished,
      isUpdatable: column.isUpdatable !== false,
      isEncrypted: column.isEncrypted === true,
    })),
    hiddenRelationColumnCount: (table.columns || []).length - modelFacingColumns.length,
    relations: (table.relations || []).map((relation) => ({
      id: relation.id ?? relation._id,
      propertyName: relation.propertyName,
      type: relation.type,
      targetTable: relation.targetTable?.name || relation.targetTableName || relation.targetTable,
      inversePropertyName: relation.inversePropertyName,
      mappedBy: relation.mappedBy?.propertyName || relation.mappedBy,
      isNullable: relation.isNullable,
      onDelete: relation.onDelete,
      isPublished: relation.isPublished,
    })),
  };
}

function summarizeRoutes(routesResult) {
  return (routesResult?.data || []).map((route) => ({
    id: route.id ?? route._id,
    path: route.path,
    mainTable: route.mainTable?.name || route.mainTableName || null,
    availableMethods: (route.availableMethods || []).map((method) => method.name).filter(Boolean),
    publicMethods: (route.publicMethods || []).map((method) => method.name).filter(Boolean),
    isEnabled: route.isEnabled,
  }));
}

function summarizeMetadata(metadata, { search, limit } = {}) {
  const tables = normalizeTables(metadata);
  const q = search ? search.toLowerCase() : null;
  const summarized = tables.map((table) => ({
    id: table.id ?? table._id,
    name: table.name,
    alias: table.alias,
    primaryKey: getPrimaryColumn(table)?.name || null,
    columnCount: (table.columns || []).length,
    relationCount: (table.relations || []).length,
    routeHint: `Use get_table_metadata({ tableName: "${table.name}" }) for fields and relations.`,
  }));
  const matched = q
    ? summarized.filter((table) => JSON.stringify(table).toLowerCase().includes(q))
    : summarized;
  const outputLimit = limit || 30;
  return {
    tableCount: tables.length,
    matchedTableCount: matched.length,
    returnedTableCount: Math.min(matched.length, outputLimit),
    search: search || null,
    tables: matched.slice(0, outputLimit),
  };
}

function unwrapData(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

function getId(record) {
  return record?.id ?? record?._id ?? null;
}

function sameId(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function refId(value) {
  return typeof value === 'object' && value !== null ? getId(value) : value;
}

function firstDataRecord(result) {
  return Array.isArray(result?.data) ? result.data[0] : result;
}

function resultRecordId(result) {
  return getId(firstDataRecord(result));
}

function parseJsonArg(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  return JSON.parse(value);
}

async function reloadRoutesResult() {
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

function normalizeRestPath(path) {
  if (!path) return '/';
  if (/^https?:\/\//i.test(path)) {
    throw new Error('Only Enfyra API paths are allowed, not full external URLs');
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function pickCodeSummary(record, fieldName) {
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

function summarizeMutationResult(result, action, tableName) {
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

async function getTableSummary(tableName) {
  const result = await fetchAPI(ENFYRA_API_URL, `/metadata/${tableName}`);
  const table = result?.data?.table || result?.data || result?.table || result;
  return summarizeTable(table);
}

async function getPrimaryFieldName(tableName) {
  const table = await getTableSummary(tableName);
  return table?.primaryKey || 'id';
}

async function fetchAll(path) {
  return unwrapData(await fetchAPI(ENFYRA_API_URL, path));
}

function targetInstance() {
  return {
    apiBase: ENFYRA_API_URL.replace(/\/$/, ''),
    source: 'ENFYRA_API_URL environment variable used by this MCP server process',
  };
}

async function discoveryFetch(path, { fallbackData = [], timeoutMs = DISCOVERY_FETCH_TIMEOUT_MS } = {}) {
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

function collectPartialErrors(results) {
  return Object.entries(results)
    .filter(([, result]) => result?.error)
    .map(([name, result]) => ({ name, error: result.error }));
}

async function getMetadataTables() {
  const metadata = await fetchAPI(ENFYRA_API_URL, '/metadata');
  return {
    metadata,
    tables: normalizeTables(metadata),
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

async function prepareGenericMutation(tableName, data) {
  const { tables } = await getMetadataTables();
  return prepareRecordMutation({
    fetchAPI,
    apiUrl: ENFYRA_API_URL,
    tables,
    tableName,
    data,
  });
}

function parseQueryParamsArg(queryParams) {
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

function appendQuery(path, queryParams) {
  if (!queryParams) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${queryParams}`;
}

const METHOD_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function normalizeMethodNameInput(method) {
  const value = String(method || '').trim().toUpperCase();
  if (!METHOD_NAME_RE.test(value)) {
    throw new Error('Method must start with A-Z and contain only uppercase letters, numbers, or underscore.');
  }
  return value;
}

function normalizeHexColorInput(value, fieldName) {
  const color = String(value || '').trim().toLowerCase();
  if (!HEX_COLOR_RE.test(color)) {
    throw new Error(`${fieldName} must be a full hex color such as #1d4ed8.`);
  }
  return color;
}

function sha256(value) {
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

function getRecordSource(record) {
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

async function fetchScriptRecord(tableName, id) {
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

function replaceOccurrence(source, oldText, newText, mode) {
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

function sourcePreview(source, aroundText) {
  if (!aroundText) return source.slice(0, 1200);
  const index = source.indexOf(aroundText);
  if (index === -1) return source.slice(0, 1200);
  const start = Math.max(0, index - 500);
  const end = Math.min(source.length, index + aroundText.length + 500);
  return `${start > 0 ? '...' : ''}${source.slice(start, end)}${end < source.length ? '...' : ''}`;
}

function scriptRecordLabel(tableName, record) {
  const method = record.method?.name || null;
  const route = record.route?.path || null;
  const flow = record.flow?.name || null;
  const gateway = record.gateway?.path || null;
  const gqlTable = record.table?.name || null;
  return {
    tableName,
    id: getId(record),
    key: record.key || record.name || record.eventName || null,
    route,
    method,
    flow,
    gateway,
    gqlTable,
  };
}

function scriptTraceFields(tableName) {
  const common = 'id,_id,name,key,eventName,sourceCode,handlerScript,connectionHandlerScript,code,scriptLanguage';
  const byTable = {
    enfyra_route_handler: `${common},route.id,route.path,method.id,method.name`,
    enfyra_pre_hook: `${common},route.id,route.path,methods.id,methods.name,isGlobal`,
    enfyra_post_hook: `${common},route.id,route.path,methods.id,methods.name,isGlobal`,
    enfyra_flow_step: `${common},flow.id,flow.name`,
    enfyra_websocket_event: `${common},gateway.id,gateway.path`,
    enfyra_websocket: `${common},path`,
    enfyra_graphql: `${common},table.id,table.name`,
    enfyra_bootstrap_script: common,
  };
  return byTable[tableName] || '*';
}

async function findMethodRecordByName(method) {
  const filter = encodeURIComponent(JSON.stringify({ name: { _eq: method } }));
  const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_method?filter=${filter}&limit=1&fields=id,_id,name,buttonColor,textColor,isSystem`);
  return unwrapData(result)[0] || null;
}

// Create MCP server — `instructions` is sent to the host (e.g. Claude Code) for the LLM; not README
const server = new McpServer(
  {
    name: 'enfyra-mcp',
    version: '1.0.0',
  },
  {
    instructions: buildMcpServerInstructions(ENFYRA_API_URL),
  },
);
installColumnarToolFormatter(server);

// ============================================================================
// METADATA TOOLS
// ============================================================================

server.tool('get_all_metadata', 'Get concise metadata summary for all tables. Use get_table_metadata or inspect_table for detail.', {
  includeFull: z.boolean().optional().default(false).describe('Return full raw metadata. Default false to keep MCP context small.'),
  search: z.string().optional().describe('Optional table-name/alias substring filter.'),
  limit: z.number().optional().describe('Maximum tables returned after search. Default 30.'),
}, async ({ includeFull, search, limit }) => {
  const result = await fetchAPI(ENFYRA_API_URL, '/metadata');
  const payload = includeFull
    ? result
    : {
        statusCode: result?.statusCode,
        success: result?.success,
        ...summarizeMetadata(result, { search, limit }),
        detailHint: 'Default response is capped and minimal. Call get_table_metadata({ tableName }) or inspect_table({ tableName }) for columns, relations, and route context.',
      };
  return jsonContent(payload);
});

server.tool('get_table_metadata', 'Get concise metadata for a specific table by name', {
  tableName: z.string().describe('Table name (e.g., "enfyra_user", "enfyra_route")'),
  includeFull: z.boolean().optional().default(false).describe('Return full raw table metadata. Default false to keep MCP context small.'),
}, async ({ tableName, includeFull }) => {
  const result = await fetchAPI(ENFYRA_API_URL, `/metadata/${tableName}`);
  const table = result?.data?.table || result?.data || result?.table || result;
  const payload = includeFull
    ? result
    : {
        statusCode: result?.statusCode,
        success: result?.success,
        table: summarizeTable(table),
        queryHint: `Use query_table({ tableName: "${tableName}", fields: [...] }) for records. query_table without fields returns only the primary key.`,
      };
  return jsonContent(payload);
});

server.tool(
  'get_enfyra_examples',
  [
    'Return concrete Enfyra examples by category.',
    'Use this before generating schemas, queries, handlers/hooks, SSR app auth, OAuth, Socket.IO, flows, files, or extensions so implementation details follow proven patterns.',
  ].join(' '),
  {
    category: z.enum(listExampleCategories().map((item) => item.key)).optional().describe('Example category key. Omit to list categories.'),
  },
  async ({ category }) => {
    const result = getExamples(category);
    return jsonContent(result);
  },
);

server.tool(
  'discover_enfyra_system',
  [
    'Call this first when you need to understand the live Enfyra instance.',
    'Returns a concise capability map from live metadata/routes/method rows, including schema management, REST route behavior, GraphQL enablement, and relation handling.',
    'Do not use this only to confirm the API base; use get_enfyra_api_context for that cheaper target check.',
    'Run broad discovery tools sequentially; do not call multiple broad discovery tools in parallel.',
  ].join(' '),
  {},
  async () => {
    const metadata = await discoveryFetch('/metadata');
    const routesResult = await discoveryFetch('/enfyra_route?fields=path,mainTable.name,availableMethods.*,publicMethods.*&limit=1000');
    const methodsResult = await discoveryFetch('/enfyra_method?limit=100');

    const tables = normalizeTables(metadata);
    const tableNames = tables.map((table) => table?.name).filter(Boolean).sort();
    const routes = summarizeRoutes(routesResult);
    const routeTables = new Set(routes.map((route) => route.mainTable).filter(Boolean));
    const noRouteTables = tableNames.filter((name) => !routeTables.has(name));
    const relationTable = tables.find((table) => table?.name === 'enfyra_relation');
    const tableDefinition = tables.find((table) => table?.name === 'enfyra_table');
    const gqlDefinition = tables.find((table) => table?.name === 'enfyra_graphql');
    const routeTableList = [...routeTables].sort();
    const noRouteTableList = noRouteTables.sort();
    const sample = (items, max = 40) => ({
      total: items.length,
      returned: Math.min(items.length, max),
      items: items.slice(0, max),
      truncated: items.length > max,
    });

    const payload = {
      targetInstance: targetInstance(),
      apiBase: ENFYRA_API_URL.replace(/\/$/, ''),
      partialErrors: collectPartialErrors({ metadata, routesResult, methodsResult }),
      counts: {
        tables: tableNames.length,
        routes: routes.length,
        methods: methodsResult?.data?.length || 0,
      },
      methods: (methodsResult?.data || []).map((method) => ({ id: method.id || method._id, name: method.name })),
      capabilityAreas: CAPABILITY_AREAS.map((item) => ({
        ...item,
        presentTables: item.tables.filter((table) => tableNames.includes(table)),
        routeBackedTables: item.tables.filter((table) => routeTables.has(table)),
        noRouteTables: item.tables.filter((table) => tableNames.includes(table) && !routeTables.has(table)),
      })),
      rest: {
        routePattern: 'Dynamic REST routes expose GET/POST at /<route-path> and PATCH/DELETE at /<route-path>/:id; there is no GET /<route-path>/:id.',
        publicAccess: 'publicMethods controls anonymous REST access per route/method; otherwise Bearer JWT + routePermissions apply.',
        routeTables: sample(routeTableList),
        noRouteTables: sample(noRouteTableList),
        canonicalCrudTools: 'query_table/create_record/update_record/delete_record use dynamic REST routes and only work for route-backed tables.',
        customRouteWorkflow: 'For a new endpoint use create_route without mainTableId, then create_handler/create_pre_hook/create_post_hook. Do not create a table just to get a path.',
        routeSamples: sample(routes, 25),
        detailHint: 'Use get_all_routes({ search, limit }) or inspect_route({ path }) for route details. Use inspect_table({ tableName }) for table detail.',
      },
      schemaManagement: {
        createTable: 'POST /enfyra_table supports isSingleRecord at create time and supports columns and relations arrays in the same cascade call. MCP create_table exposes isSingleRecord, columns, and relations directly. It does not accept alias at create time; table name drives the default route/schema behavior.',
        updateTable: 'PATCH /enfyra_table/:id is the canonical path for table property changes and column/relation schema changes.',
        columns: 'enfyra_column has no REST route; use create_table/create_column/update_column/delete_column.',
        relations: routeTables.has('enfyra_relation')
          ? 'enfyra_relation has a REST route for reads/metadata, but canonical schema migration is create_relation/delete_relation or enfyra_table PATCH with the full relations array. Relation onDelete accepts CASCADE, SET NULL, or RESTRICT.'
          : 'Use create_relation/delete_relation or enfyra_table PATCH with the full relations array. Relation onDelete accepts CASCADE, SET NULL, or RESTRICT.',
        relationCascadeFkContract: 'Do not ask for or send physical FK/junction column names in relation create/update payloads. Enfyra derives fk/junction columns from relation propertyName/table metadata and hides FK columns from app schema/forms. Use targetTable, type, propertyName, inversePropertyName or mappedBy, isNullable, onDelete.',
        tableDefinitionRelations: (tableDefinition?.relations || []).map((rel) => rel.propertyName),
        relationDefinitionRelations: (relationTable?.relations || []).map((rel) => rel.propertyName),
      },
      adminTesting: {
        runAdminTest: 'run_admin_test wraps POST /admin/test/run for flow_step, websocket_event, and websocket_connection scripts.',
        testFlowStep: 'test_flow_step also wraps POST /admin/test/run with kind=flow_step.',
        triggerFlow: 'trigger_flow wraps POST /admin/flow/trigger/:id and enqueues a flow execution.',
      },
      graphql: {
        endpoint: `${ENFYRA_API_URL.replace(/\/$/, '')}/graphql`,
        schemaEndpoint: `${ENFYRA_API_URL.replace(/\/$/, '')}/graphql-schema`,
        enablement: 'A table appears in GraphQL when enfyra_graphql has an enabled row for that table. REST route availableMethods does not enable GraphQL.',
        auth: 'GraphQL currently requires Authorization: Bearer <accessToken>; REST publicMethods does not make GraphQL anonymous.',
        management: routeTables.has('enfyra_graphql')
          ? 'Use update_table graphqlEnabled or create/update records on enfyra_graphql, then reload_graphql if needed.'
          : 'Use update_table graphqlEnabled, then reload_graphql if needed.',
        gqlDefinitionColumns: (gqlDefinition?.columns || []).map((column) => column.name),
      },
      tableSamples: sample(tableNames, 40),
    };

    return jsonContent(payload);
  },
);

server.tool(
  'discover_runtime_context',
  [
    'Discover live runtime context that affects how an LLM should use Enfyra.',
    'Reports inferred primary key/backend family, route/cache/admin surfaces, active metadata-backed runtime areas, and what is not exposed by the backend API. Run broad discovery tools sequentially; do not call multiple broad discovery tools in parallel.',
  ].join(' '),
  {},
  async () => {
    const metadata = await discoveryFetch('/metadata');
    const routesResult = await discoveryFetch('/enfyra_route?fields=path,mainTable.name,availableMethods.*,publicMethods.*,isEnabled&limit=1000');
    const methodsResult = await discoveryFetch('/enfyra_method?limit=100');
    const gqlResult = await discoveryFetch('/enfyra_graphql?limit=1000');
    const flowsResult = await discoveryFetch('/enfyra_flow?limit=1000');
    const websocketResult = await discoveryFetch('/enfyra_websocket?limit=1000');
    const storageResult = await discoveryFetch('/enfyra_storage_config?limit=1000');
    const settingsResult = await discoveryFetch('/enfyra_setting?limit=1000');
    const meResult = await discoveryFetch('/me', { fallbackData: null });

    const tables = normalizeTables(metadata);
    const routes = summarizeRoutes(routesResult);
    const routeTables = new Set(routes.map((route) => route.mainTable).filter(Boolean));
    const adminRoutes = routes.filter((route) => route.path?.startsWith('/admin'));
    const publicRoutes = routes.filter((route) => route.publicMethods?.length);
    const sample = (items, max = 25) => ({
      total: items.length,
      returned: Math.min(items.length, max),
      items: items.slice(0, max),
      truncated: items.length > max,
    });

    const payload = {
      targetInstance: targetInstance(),
      apiBase: ENFYRA_API_URL.replace(/\/$/, ''),
      partialErrors: collectPartialErrors({
        metadata,
        routesResult,
        methodsResult,
        gqlResult,
        flowsResult,
        websocketResult,
        storageResult,
        settingsResult,
        meResult,
      }),
      authenticatedUser: Array.isArray(meResult?.data) ? meResult.data[0] || null : meResult?.data || null,
      database: getMetadataDatabaseContext(metadata, tables),
      counts: {
        tables: tables.length,
        routes: routes.length,
        routeBackedTables: routeTables.size,
        noRouteTables: tables.filter((table) => !routeTables.has(table.name)).length,
        methods: methodsResult?.data?.length || 0,
        graphqlDefinitions: gqlResult?.data?.length || 0,
        enabledGraphqlDefinitions: (gqlResult?.data || []).filter((row) => row.isEnabled !== false).length,
        flows: flowsResult?.data?.length || 0,
        enabledFlows: (flowsResult?.data || []).filter((row) => row.isEnabled !== false).length,
        websocketGateways: websocketResult?.data?.length || 0,
        enabledWebsocketGateways: (websocketResult?.data || []).filter((row) => row.isEnabled !== false).length,
        storageConfigs: storageResult?.data?.length || 0,
        settings: settingsResult?.data?.length || 0,
      },
      methods: (methodsResult?.data || []).map((method) => ({ id: method.id || method._id, name: method.name })),
      routeRuntime: {
        routePattern: 'GET/POST /<route-path>; PATCH/DELETE /<route-path>/:id; no dynamic GET /<route-path>/:id.',
        adminRoutes: sample(adminRoutes.map((route) => route.path).sort()),
        publicRoutes: sample(publicRoutes.map((route) => ({
          path: route.path,
          mainTable: route.mainTable,
          publicMethods: route.publicMethods,
        }))),
      },
      cacheAndCluster: {
        metadataMutationReloads: 'Metadata-backed mutations emit cache invalidation; admin reload endpoints exist for metadata/routes/graphql/guards/all.',
        runtimeCacheContract: 'REDIS_RUNTIME_CACHE=true stores runtime definition snapshots in Redis so instances with the same NODE_NAME read the same runtime cache namespace.',
        userCacheContract: '$cache/@CACHE uses managed user cache under NODE_NAME:user_cache:* with REDIS_USER_CACHE_LIMIT_MB default 30 MB; quota eviction only removes user cache keys, not runtime cache, BullMQ, Socket.IO, telemetry, or lock keys.',
        multiInstanceContract: 'Backend is cluster-aware through cache invalidation, Redis runtime cache, Redis user cache, and BullMQ paths, but this MCP can only observe metadata/API state, not every node health.',
        flowWorkerContract: 'Flow jobs require the backend flow worker to be initialized after HTTP listen and websocket gateway init; trigger_flow only confirms enqueue/result from admin endpoint.',
      },
      runtimeGaps: [
        metadata?.dbType || metadata?.data?.dbType
          ? null
          : 'Exact database type is not exposed by current MCP-visible API.',
        'Redis/BullMQ/socket adapter health is not exposed by current MCP-visible API.',
        'MCP can test flow steps and websocket scripts through admin test endpoints, but not prove every production queue/client path without a real end-to-end client.',
      ].filter(Boolean),
    };
    return jsonContent(payload);
  },
);

server.tool(
  'discover_query_capabilities',
  [
    'Discover Enfyra query/filter/deep-fetch capabilities for the live instance.',
    'Prefer passing tableName. Without tableName this returns only generic query rules. Run broad discovery tools sequentially; do not call multiple broad discovery tools in parallel.',
  ].join(' '),
  {
    tableName: z.string().optional().describe('Optional table name to summarize query fields and relation/deep capabilities.'),
  },
  async ({ tableName }) => {
    const metadata = tableName
      ? await discoveryFetch(`/metadata/${encodeURIComponent(tableName)}`)
      : null;
    const routesResult = tableName
      ? await discoveryFetch('/enfyra_route?fields=path,mainTable.name,availableMethods.*,publicMethods.*,isEnabled&limit=1000')
      : { data: [] };
    const tableFromMetadata = tableName && !metadata?.error
      ? metadata?.data?.table || metadata?.data || metadata?.table || metadata
      : null;
    const tables = tableName
      ? (tableFromMetadata ? [tableFromMetadata] : [])
      : [];
    const routes = summarizeRoutes(routesResult);
    const table = tableName ? tables.find((item) => item.name === tableName) : null;
    const primaryKey = table ? getPrimaryColumn(table)?.name || 'id' : 'id';
    const tableRoutes = tableName
      ? routes.filter((route) => route.mainTable === tableName)
      : [];

    const payload = {
      targetInstance: targetInstance(),
      partialErrors: collectPartialErrors({ metadata, routesResult }),
      operators: {
        filter: FILTER_OPERATORS,
        fieldPermissionConditions: FIELD_PERMISSION_CONDITION_OPERATORS,
        fieldPermissionConditionUnsupported: ['_contains', '_starts_with', '_ends_with', '_between'],
      },
      queryParams: {
        fields: 'Comma-separated scalar/relation fields. Relations use relation propertyName, not physical FK column names.',
        filter: 'JSON object using operators above. Relation filters use nested relation propertyName objects.',
        sort: 'Local field or -field. For direct one-to-many/many-to-many parent ordering, use _count(relation), _max(relation.field), or _min(relation.field); raw dotted to-many sort is invalid.',
        page: '1-based page.',
        limit: 'Page size.',
        meta: 'Request metadata/counts where supported.',
        deep: 'Nested relation fetch object keyed by relation propertyName.',
      },
      countPattern: 'For counts, query only fields=id with limit=1 and request meta. Use meta=totalCount without a filter, or meta=filterCount when a filter is supplied. MCP count_records wraps this pattern.',
      deep: {
        shape: '{ [relationName]: { fields?, filter?, sort?, limit?, page?, deep? } }',
        rules: [
          'Unknown relation keys are invalid.',
          'Unknown deep entry keys are invalid.',
          'limit on many-to-one/one-to-one relations is invalid.',
          'Dotted sort through one-to-many/many-to-many is invalid.',
          'Deep sort orders rows inside the related collection only; use root aggregate sort helpers when parent rows must be ordered by child values.',
          'Nested deep is recursively validated.',
          'Field permissions may rewrite filters/sorts and sanitize post-query results.',
        ],
      },
      backendNotes: {
        primaryKey: tableName
          ? 'Use this table metadata primary column when available.'
          : 'SQL commonly uses id; Mongo uses _id. Use table metadata primary column when available.',
        relationNames: 'API relation operations use relation propertyName, not physical FK column names.',
        relationCascadeFkContract: 'When creating relations through create_table/create_relation/enfyra_table PATCH, never provide fkCol/fkColumn/foreignKeyColumn/sourceColumn/targetColumn/junction*Column. These are physical implementation details derived by Enfyra and hidden from app schema/forms.',
        graphql: 'GraphQL query args also accept filter/sort/page/limit, but GraphQL requires Bearer auth and table enablement via enfyra_graphql.',
      },
      table: tableName
        ? {
            exists: !!table,
            metadata: summarizeTable(table),
            routes: tableRoutes,
            examples: table
              ? {
                  list: `GET /${tableRoutes[0]?.path?.replace(/^\//, '') || table.name}?limit=10`,
                  oneByPkFilter: { [primaryKey]: { _eq: '<id>' } },
                  relationDeep: (table.relations || [])[0]
                    ? { [(table.relations || [])[0].propertyName]: { fields: ['id'], limit: 5 } }
                    : null,
                  relationFilter: (table.relations || [])[0]
                    ? { [(table.relations || [])[0].propertyName]: { [primaryKey]: { _eq: '<related-id>' } } }
                    : null,
                }
              : null,
          }
        : null,
      discoveryRule: 'When building a query, inspect table metadata first, then use relation propertyName and primary column from that metadata.',
    };

    return jsonContent(payload);
  },
);

server.tool(
  'discover_script_contexts',
  [
    'Discover runtime script contexts and macro availability for handlers, hooks, flows, websocket scripts, GraphQL, packages, and extensions.',
    'Use before writing dynamic JavaScript logic so the model does not mix context variables across surfaces. This tool is static and safe to call alone; avoid running it in parallel with other broad discovery calls.',
  ].join(' '),
  {},
  async () => {
    const payload = {
      targetInstance: targetInstance(),
      transformer: {
        rule: 'Dynamic server scripts are transformed before sandbox execution. Macros expand to $ctx paths; comments are not transformed.',
        preferredSyntax: 'Prefer template macros in generated Enfyra scripts. Use macros such as @BODY/@QUERY/@PARAMS/@USER/@REQ/@RES/@REPOS/@CACHE/@HELPERS/@FETCH/@STORAGE/@UPLOADED_FILE/@SOCKET/@TRIGGER/@DATA/@ERROR/@STATUS/@ENV/@PKGS/@LOGS/@SHARE/@API/@THROW* instead of raw $ctx access whenever a macro exists. Use raw $ctx only for fields without a macro.',
        coreMacros: {
          '@CACHE': '$ctx.$cache',
          '@REPOS': '$ctx.$repos',
          '@HELPERS': '$ctx.$helpers',
          '@STORAGE': '$ctx.$storage',
          '@FETCH': '$ctx.$helpers.$fetch',
          '@LOGS': '$ctx.$logs',
          '@BODY': '$ctx.$body',
          '@ENV': '$ctx.$env',
          '@DATA': '$ctx.$data',
          '@PARAMS': '$ctx.$params',
          '@QUERY': '$ctx.$query',
          '@USER': '$ctx.$user',
          '@REQ': '$ctx.$req',
          '@RES': '$ctx.$res',
          '@SHARE': '$ctx.$share',
          '@API': '$ctx.$api',
          '@UPLOADED_FILE': '$ctx.$uploadedFile',
          '@PKGS': '$ctx.$pkgs',
          '@SOCKET': '$ctx.$socket',
          '@TRIGGER': '$ctx.$trigger',
          '@FLOW': '$ctx.$flow',
          '@FLOW_PAYLOAD': '$ctx.$flow.$payload',
          '@FLOW_LAST': '$ctx.$flow.$last',
          '@FLOW_META': '$ctx.$flow.$meta',
          '@THROW400': "$ctx.$throw['400']",
          '@THROW401': "$ctx.$throw['401']",
          '@THROW403': "$ctx.$throw['403']",
          '@THROW404': "$ctx.$throw['404']",
          '@THROW409': "$ctx.$throw['409']",
          '@THROW422': "$ctx.$throw['422']",
          '@THROW429': "$ctx.$throw['429']",
          '@THROW500': "$ctx.$throw['500']",
          '@THROW503': "$ctx.$throw['503']",
          '@THROW': '$ctx.$throw',
          '@STATUS': '$ctx.$statusCode',
          '@ERROR': '$ctx.$error',
        },
        flowMacros: {
          '@FLOW': '$ctx.$flow',
          '@FLOW_PAYLOAD': '$ctx.$flow.$payload',
          '@FLOW_LAST': '$ctx.$flow.$last',
          '@FLOW_META': '$ctx.$flow.$meta',
          '#table_name': '$ctx.$repos.table_name',
        },
        cache: {
          contract: '@CACHE and $ctx.$cache use managed user cache. Use logical keys only; Enfyra stores Redis-backed user cache under NODE_NAME:user_cache:* and Redis Admin Key Editor uses the same storage path.',
          quota: 'REDIS_USER_CACHE_LIMIT_MB defaults to 30 MB. If exceeded, Enfyra evicts least-recently-used user-cache keys only; system Redis keys are not counted or evicted.',
          keyRule: 'Do not include NODE_NAME, user_cache:, or Redis namespace prefixes in scripts. Prefer TTL-based set(key, value, ttlMs); setNoExpire may still be evicted by the user-cache soft allocation.',
        },
        throws: '@THROW400 through @THROW503 and @THROW map to $ctx.$throw helpers.',
        helpers: {
          core: '$ctx.$helpers includes $bcrypt.hash/compare, autoSlug(text), $fetch, $sleep(ms) capped by the runtime, and $crypto. HTTP and GraphQL contexts also expose $jwt through $ctx.$helpers.',
          fetch: '@FETCH maps to $ctx.$helpers.$fetch for outbound HTTP calls from server scripts. Keep secrets in encrypted fields instead of embedding them in sourceCode.',
          crypto: '$ctx.$helpers.$crypto exposes bounded runtime crypto helpers: randomUUID(), randomBytes(size, encoding), sha256(value, encoding), hmacSha256(value, secret, encoding), and generateSshKeyPair(comment). Use generateSshKeyPair for SSH key material. Do not use legacy $ctx.$helpers.$ssh.',
          files: '$ctx.$storage.$upload and $ctx.$storage.$update accept file: @UPLOADED_FILE for request uploads and stream from the server temp file path. $ctx.$storage.$registerFile creates a enfyra_file record for an object that already exists in storage without uploading bytes. Use buffer only for small generated/transformed files; do not use @UPLOADED_FILE.buffer.',
        },
        env: '$ctx.$env exposes a sanitized process env snapshot with exact sensitive keys removed: DB_URI, DB_REPLICA_URIS, REDIS_URI, SECRET_KEY, and ADMIN_PASSWORD. Store app secrets in unpublished isEncrypted fields instead of reading them from $env.',
      },
      contexts: {
        preHook: {
          runs: 'Before handler.',
          data: ['@BODY', '@QUERY', '@PARAMS', '@USER', '@REQ', '@REPOS', '@CACHE', '@HELPERS', '@FETCH', '@STORAGE', '@THROW*', '@SOCKET global emit helpers/roomSize'],
          queryContract: '@QUERY.filter is initialized as an object. When adding RLS/scope filters in pre-hooks, merge directly with _and; do not add defensive type checks around @QUERY.filter.',
          projectionContract: 'For canonical table reads, preserve client-controlled query shape. Do not override @QUERY.fields, @QUERY.deep, @QUERY.sort, @QUERY.limit, @QUERY.page, @QUERY.meta, @QUERY.aggregate, or debugMode. RLS should only merge security constraints into @QUERY.filter.',
          rlsPattern: 'For relation-scoped reads, mutate @QUERY.filter instead of returning data. Example: const incomingFilter = @QUERY.filter; const scope = { memberships: { member: { id: { _eq: @USER.id } } } }; @QUERY.filter = Object.keys(incomingFilter).length ? { _and: [incomingFilter, scope] } : scope;',
          returnBehavior: 'Returning a non-undefined value skips handler and becomes response data.',
        },
        handler: {
          runs: 'Main route logic, or canonical CRUD if no handler overrides.',
          data: ['@BODY', '@QUERY', '@PARAMS', '@USER', '@REQ', '@RES when response streaming is available', '@UPLOADED_FILE for multipart request file metadata', '@REPOS.main', '@REPOS.<table>', '@CACHE', '@HELPERS', '@FETCH', '@STORAGE', '@PKGS', '@SOCKET global emit helpers/roomSize', '@TRIGGER'],
          queryContract: 'When a handler wraps a canonical table read, pass through client fields/deep/sort/page/limit/meta/aggregate/debugMode unless the route is a clearly custom summary or workflow endpoint.',
          returnBehavior: 'Return value becomes response body unless post-hook changes it.',
        },
        postHook: {
          runs: 'After handler, including error path.',
          data: ['@DATA', '@STATUS', '@ERROR', '@BODY', '@QUERY', '@PARAMS', '@USER', '@REQ', '@CACHE', '@HELPERS', '@FETCH', '@STORAGE', '@SHARE', '@API'],
          returnBehavior: 'Mutate @DATA/$ctx.$data or return a non-undefined replacement response.',
        },
        flowStep: {
          runs: 'Inside flow execution or admin flow step test.',
          data: ['@BODY payload', '@USER if provided', '@FLOW_PAYLOAD', '@FLOW_LAST', '@FLOW', '@FLOW_META', '#table_name', '@CACHE', '@HELPERS', '@FETCH', '@STORAGE', '@SOCKET global emit helpers/roomSize', '@TRIGGER'],
          resultBehavior: 'Step return value is injected into @FLOW.<step.key> and @FLOW_LAST.',
          branching: 'Condition steps use JavaScript truthy/falsy result; child branch is true/false.',
        },
        websocketConnection: {
          runs: 'Socket.IO connection handler.',
          data: ['@BODY connection info', '@DATA connection info', '@REQ websocket request metadata', '@API request metadata', '@USER if authenticated', '@HELPERS', '@FETCH', '@SOCKET reply/join/leave/disconnect/emit helpers/roomSize'],
        },
        websocketEvent: {
          runs: 'Socket.IO event handler.',
          data: ['@BODY event payload', '@DATA event payload', '@REQ websocket request metadata', '@API request metadata', '@USER if authenticated', '@HELPERS', '@FETCH', '@SOCKET reply/join/leave/disconnect/emit helpers/roomSize'],
          resultBehavior: 'Client ack receives queued state first; handler result is emitted asynchronously as ws:result/ws:error with requestId.',
        },
        graphqlResolver: {
          runs: 'Generated GraphQL resolver delegates to dynamic repo/query services.',
          data: ['GraphQL request context', 'Bearer auth user', 'dynamic repositories'],
          caveat: 'REST publicMethods do not make GraphQL anonymous.',
        },
        extensionVueSfc: {
          runs: 'Frontend extension code, not server sandbox.',
          data: ['Vue/Nuxt composables', 'Enfyra composables', 'auto-resolved UI components'],
          caveat: 'No import statements; save as enfyra_extension Vue SFC record.',
        },
      },
      helpers: {
        repos: {
          scopes: '$repos.main is the canonical repository for the route main table and preserves normal route query behavior. $repos.<table> is an explicit internal repository for table-specific logic. Do not generate $repos.secure.<table>; current runtime does not expose table methods there.',
          mutationReturnShape: '$repos.<table>.create({ data }) and $repos.<table>.update({ id, data }) return a collection-shaped result: { data: [...], count? }. data is always an array for create/update, even for one created/updated record. If a script needs the single record object, it must read result.data[0] or result.data?.[0] ?? null.',
          preferredExample: 'const result = await @REPOS.main.create({ data: @BODY }); const record = result.data?.[0] ?? null; return record;',
          wrongSingleRecordAccess: 'Do not use result.data.id, do not return result.data when one object is expected, and do not assume create/update returns the bare row object.',
          countPattern: 'To count records in custom code, do not fetch full rows. Use const result = await @REPOS.main.find({ fields: "id", limit: 1, meta: filter ? "filterCount" : "totalCount", ...(filter ? { filter } : {}) }); then read result.meta.filterCount or result.meta.totalCount.',
        },
        socketInHttpOrFlow: 'HTTP/flow context can emitToUser/emitToRoom/emitToGateway/broadcast and roomSize, but cannot reply/join/leave/disconnect/emitToCurrentRoom/broadcastToRoom because there is no bound socket. emitToRoom requires an explicit gateway path: emitToRoom(path, room, event, data). roomSize(room) counts sockets in that room across registered gateways.',
        packages: 'Server packages installed through install_package are exposed as $ctx.$pkgs.packageName in server scripts.',
        files: 'Upload helpers are on $storage; raw create_record on enfyra_file is not equivalent to multipart upload/storage rollback. For multipart request files, pass file: @UPLOADED_FILE to @STORAGE.$upload/@STORAGE.$update so Enfyra streams from disk-backed temp storage. Use @STORAGE.$registerFile only when the object already exists in storage and the script should create the enfyra_file record without uploading bytes. Use buffer only for small generated files.',
      },
      adminTesting: {
        flowStep: 'Use test_flow_step or run_admin_test(kind=flow_step).',
        websocket: 'Use run_admin_test(kind=websocket_event|websocket_connection).',
      },
    };

    return jsonContent(payload);
  },
);

// ============================================================================
// QUERY TOOLS
// ============================================================================

server.tool(
  'get_enfyra_api_context',
  [
    'Returns the resolved API base URL for this MCP session (env ENFYRA_API_URL).',
    'Use this as the cheap first target sanity check before broad discovery or mutations.',
    'Use when the user asks which HTTP endpoint or full URL applies: combine enfyraApiUrl with paths from server instructions (GET/POST /{table}, PATCH/DELETE /{table}/{id}, no GET /{table}/{id}).',
    'Auth: publicMethods on a route can allow a method without Bearer; otherwise JWT + routePermissions — see server instructions.',
    'If path might differ from table name, use get_all_routes before asserting a URL.',
    'Same mapping as MCP tool → HTTP: query_table=GET /table?..., create_record=POST /table, update_record=PATCH /table/id, delete_record=DELETE /table/id.',
    'GraphQL: see graphqlHttpUrl / graphqlSchemaUrl in response; enable per table via enfyra_graphql/update_table graphqlEnabled and send Bearer auth.',
  ].join(' '),
  {},
  async () => {
    const base = ENFYRA_API_URL.replace(/\/$/, '');
    const gql = buildGraphqlUrls(ENFYRA_API_URL);
    const payload = {
      targetInstance: targetInstance(),
      enfyraApiUrl: base,
      graphqlHttpUrl: gql.graphqlHttpUrl,
      graphqlSchemaUrl: gql.graphqlSchemaUrl,
      examples: {
        listOrCreate: `${base}/<table_name>`,
        updateOrDelete: `${base}/<table_name>/<id>`,
        oneRowById: `${base}/<table_name>?filter={"<primaryKeyFromMetadata>":{"_eq":"<id>"}}&limit=1`,
      },
      auth: {
        publicMethods: 'If the HTTP method is public for that route, no Bearer required; else Bearer JWT and routePermissions apply.',
        graphql: 'GraphQL currently requires Bearer auth; route publicMethods do not make GraphQL anonymous.',
        mcp: 'This server uses admin credentials from env for tools (fetchAPI).',
      },
      pathResolution: 'Confirm route path with get_all_routes or metadata — path may not equal table name.',
      note: 'Full tool→HTTP mapping is in MCP server instructions (shown to the model at connect).',
    };
    return jsonContent(payload);
  },
);

server.tool('query_table', 'Query any route-backed table. Response is minimal unless fields is explicit. Every call must pass either limit or all=true.', {
  tableName: z.string().describe('Table name to query'),
  filter: z.string().optional().describe('Filter object as JSON string. Examples: \'{"status": {"_eq": "active"}}\''),
  sort: z.string().optional().describe('Sort field. Prefix with - for descending (e.g., "createdAt", "-id")'),
  page: z.number().optional().describe('Page number (default: 1)'),
  limit: z.number().int().min(0).optional().describe('Items per page. Required unless all=true. Do not invent arbitrary limits for "all"; use all=true instead. Use count_records for counts.'),
  all: z.boolean().optional().default(false).describe('Return all matching rows by sending REST limit=0. Use this when the user asks for all rows or a complete list.'),
  fields: z.array(z.string()).optional().describe('Fields to select. If omitted, MCP selects only the table primary key to avoid oversized responses.'),
  meta: z.string().optional().describe('Optional REST meta request, e.g. "totalCount", "filterCount", or aggregate modes supported by the route. Use count_records for simple counts.'),
  deep: z.string().optional().describe('Optional deep relation fetch object as JSON string. Keys must be relation propertyName values.'),
  aggregate: z.string().optional().describe('Optional aggregate object as JSON string, keyed by real fields/relations. Results are returned in response.meta.aggregate when supported.'),
}, async ({ tableName, filter, sort, page, limit, all, fields, meta, deep, aggregate }) => {
  if (!all && limit === undefined) {
    throw new Error('query_table requires either limit or all=true. Do not rely on implicit default page sizes.');
  }
  if (all && limit !== undefined) {
    throw new Error('query_table accepts either all=true or limit, not both.');
  }
  validateTableName(tableName);
  validateFilter(filter);
  parseJsonArg(deep, undefined);
  parseJsonArg(aggregate, undefined);

  const queryParams = new URLSearchParams();
  const selectedFields = fields && fields.length > 0 ? fields : [await getPrimaryFieldName(tableName)];
  if (filter) queryParams.set('filter', filter);
  if (sort) queryParams.set('sort', sort);
  if (page) queryParams.set('page', String(page));
  if (meta) queryParams.set('meta', meta);
  if (deep) queryParams.set('deep', deep);
  if (aggregate) queryParams.set('aggregate', aggregate);
  const effectiveLimit = all ? 0 : limit;
  queryParams.set('limit', String(effectiveLimit));
  queryParams.set('fields', selectedFields.join(','));

  const query = queryParams.toString();
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}${query ? `?${query}` : ''}`);
  const payload = {
    statusCode: result?.statusCode,
    success: result?.success,
    tableName,
    fields: selectedFields,
    limit: effectiveLimit,
    all: !!all,
    queryOptions: {
      meta: meta || null,
      deep: deep ? parseJsonArg(deep, null) : null,
      aggregate: aggregate ? parseJsonArg(aggregate, null) : null,
    },
    minimalDefaultApplied: !(fields && fields.length > 0),
    meta: result?.meta,
    data: result?.data || [],
    detailHint: fields && fields.length > 0
      ? undefined
      : 'Only the primary key was returned because fields was omitted. Re-run query_table with explicit fields for details, or use inspect_table to find valid field names.',
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
});

server.tool(
  'count_records',
  [
    'Count records in a route-backed Enfyra table using the lightweight REST meta pattern.',
    'Without filter it requests fields=id&limit=1&meta=totalCount and returns meta.totalCount.',
    'With filter it requests fields=id&limit=1&meta=filterCount and returns meta.filterCount.',
    'Use this instead of fetching rows when the user only needs a count.',
  ].join(' '),
  {
    tableName: z.string().describe('Table name to count. Must have a REST route.'),
    filter: z.string().optional().describe('Optional Query DSL filter as JSON string. Example: \'{"status":{"_eq":"active"}}\''),
  },
  async ({ tableName, filter }) => {
    validateTableName(tableName);
    validateFilter(filter);

    const metaField = filter ? 'filterCount' : 'totalCount';
    const queryParams = new URLSearchParams();
    queryParams.set('fields', 'id');
    queryParams.set('limit', '1');
    queryParams.set('meta', metaField);
    if (filter) queryParams.set('filter', filter);

    const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}?${queryParams.toString()}`);
    const meta = result?.meta || {};
    const hasCount = Object.prototype.hasOwnProperty.call(meta, metaField);
    const count = hasCount ? Number(meta[metaField]) : null;
    const payload = {
      tableName,
      count,
      countField: metaField,
      filterApplied: !!filter,
      meta,
      request: {
        path: `/${tableName}`,
        query: Object.fromEntries(queryParams.entries()),
      },
      warning: hasCount ? undefined : `Response meta did not include ${metaField}.`,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  'find_one_record',
  'Find a single record by ID or filter. By ID uses GET with filter (Enfyra has no GET /table/:id route).',
  {
    tableName: z.string().describe('Table name'),
    id: z.string().optional().describe('Record ID'),
    filter: z.string().optional().describe('Filter as JSON string to find by'),
    fields: z.array(z.string()).optional().describe('Fields to select. If omitted, returns only the primary key.'),
  },
  async ({ tableName, id, filter, fields }) => {
    validateTableName(tableName);
    const primaryKey = await getPrimaryFieldName(tableName);
    const selectedFields = fields && fields.length > 0 ? fields : [primaryKey];
    if (id) {
      // Enfyra route engine does not register GET /<table>/:id (only PATCH/DELETE use /:id). Use list + filter.
      const filterObj = JSON.stringify({ [primaryKey]: { _eq: id } });
      const queryParams = new URLSearchParams({
        filter: filterObj,
        limit: '1',
        fields: selectedFields.join(','),
      });
      const result = await fetchAPI(
        ENFYRA_API_URL,
        `/${tableName}?${queryParams.toString()}`,
      );
      const one = result.data?.[0] ?? null;
      return { content: [{ type: 'text', text: JSON.stringify({
        tableName,
        primaryKey,
        fields: selectedFields,
        data: one,
        detailHint: fields && fields.length > 0 ? undefined : 'Only the primary key was returned. Pass fields for details.',
      }, null, 2) }] };
    }
    if (!filter) throw new Error('Provide id or filter');
    validateFilter(filter);
    const queryParams = new URLSearchParams({
      filter,
      limit: '1',
      fields: selectedFields.join(','),
    });
    const result = await fetchAPI(
      ENFYRA_API_URL,
      `/${tableName}?${queryParams.toString()}`,
    );
    return { content: [{ type: 'text', text: JSON.stringify({
      tableName,
      fields: selectedFields,
      data: result.data?.[0] || null,
      detailHint: fields && fields.length > 0 ? undefined : 'Only the primary key was returned. Pass fields for details.',
    }, null, 2) }] };
  },
);

// ============================================================================
// CRUD TOOLS
// ============================================================================

server.tool('create_record', 'Create a new record in any route-backed table. The tool validates body keys against live metadata and validates sourceCode before saving script-backed records.', {
  tableName: z.string().describe('Table name to insert into'),
  data: z.string().describe('Record data as JSON string'),
  queryParams: z.string().optional().describe('Optional query params as JSON object string, e.g. {"expired_at":"2026-09-20"}. Use for route contracts that intentionally keep workflow fields out of the validated body.'),
}, async ({ tableName, data, queryParams }) => {
  validateTableName(tableName);
  const prepared = await prepareGenericMutation(tableName, data);
  const query = parseQueryParamsArg(queryParams);
  const result = await fetchAPI(ENFYRA_API_URL, appendQuery(`/${tableName}`, query), { method: 'POST', body: JSON.stringify(prepared.payload) });
  return { content: [{ type: 'text', text: JSON.stringify({
    ...summarizeMutationResult(result, 'created', tableName),
    scriptValidation: prepared.scriptValidation,
  }, null, 2) }] };
});

server.tool('update_record', 'Update an existing record by ID using PATCH. The tool validates body keys against live metadata and validates sourceCode before saving script-backed records.', {
  tableName: z.string().describe('Table name'),
  id: z.string().describe('Record ID to update'),
  data: z.string().describe('Fields to update as JSON string'),
  queryParams: z.string().optional().describe('Optional query params as JSON object string for route contracts that intentionally keep workflow fields out of the validated body.'),
}, async ({ tableName, id, data, queryParams }) => {
  validateTableName(tableName);
  const prepared = await prepareGenericMutation(tableName, data);
  const query = parseQueryParamsArg(queryParams);
  const result = await fetchAPI(ENFYRA_API_URL, appendQuery(`/${tableName}/${id}`, query), { method: 'PATCH', body: JSON.stringify(prepared.payload) });
  return { content: [{ type: 'text', text: JSON.stringify({
    ...summarizeMutationResult(result, 'updated', tableName),
    scriptValidation: prepared.scriptValidation,
  }, null, 2) }] };
});

server.tool(
  'get_script_source',
  [
    'Fetch the full editable source for one script-backed metadata record without preview truncation.',
    'Use this before reviewing or patching long handlers, hooks, flow steps, websocket scripts, GraphQL scripts, or bootstrap scripts.',
  ].join(' '),
  {
    tableName: z.enum(SCRIPT_BACKED_TABLES).describe('Script-backed table to read'),
    id: z.string().describe('Record ID to read'),
  },
  async ({ tableName, id }) => {
    const { primaryKey, record, sourceField, sourceCode } = await fetchScriptRecord(tableName, id);
    return { content: [{ type: 'text', text: JSON.stringify({
      tableName,
      id,
      primaryKey,
      sourceField,
      sourceCode,
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
  },
  async ({ tableName, id, oldText, newText, occurrence, expectedSourceSha256, scriptLanguage, apply }) => {
    const { record, sourceField, sourceCode } = await fetchScriptRecord(tableName, id);
    if (sourceField !== 'sourceCode') {
      throw new Error(`patch_script_source only saves sourceCode records. Record uses "${sourceField}"; use update_record intentionally for this legacy field.`);
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
    'Use this for enfyra_flow_step, enfyra_route_handler, enfyra_pre_hook, enfyra_post_hook, enfyra_websocket_event, enfyra_websocket, enfyra_graphql, and enfyra_bootstrap_script.',
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
      'enfyra_graphql',
      'enfyra_bootstrap_script',
    ]).describe('Script-backed table to update'),
    id: z.string().describe('Record ID to update'),
    sourceCode: z.string().describe('Editable script sourceCode. Pass the raw code string; do not JSON-escape it yourself.'),
    scriptLanguage: z.string().optional().default('javascript').describe('Script language, usually javascript or typescript'),
  },
  async ({ tableName, id, sourceCode, scriptLanguage }) => {
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

server.tool('delete_record', 'Delete a record by ID', {
  tableName: z.string().describe('Table name'),
  id: z.string().describe('Record ID to delete'),
  queryParams: z.string().optional().describe('Optional query params as JSON object string for route-specific confirmation contracts.'),
  confirm: z.boolean().optional().default(false).describe('Required true to apply the destructive delete. Omit/false returns a preview only.'),
}, async ({ tableName, id, queryParams, confirm }) => {
  validateTableName(tableName);
  const primaryKey = await getPrimaryFieldName(tableName);
  if (!confirm) {
    const query = new URLSearchParams({
      filter: JSON.stringify({ [primaryKey]: { _eq: id } }),
      limit: '1',
      fields: primaryKey,
    });
    const preview = await fetchAPI(ENFYRA_API_URL, `/${tableName}?${query.toString()}`).catch((error) => ({ error: String(error?.message || error) }));
    return { content: [{ type: 'text', text: JSON.stringify({
      action: 'delete_record_preview',
      tableName,
      id,
      primaryKey,
      preview: preview?.data?.[0] || null,
      previewError: preview?.error,
      destructive: true,
      next: 'Call delete_record again with confirm=true to delete this route-backed record.',
    }, null, 2) }] };
  }
  const query = parseQueryParamsArg(queryParams);
  const result = await fetchAPI(ENFYRA_API_URL, appendQuery(`/${tableName}/${id}`, query), { method: 'DELETE' });
  return { content: [{ type: 'text', text: JSON.stringify({
    action: 'deleted',
    tableName,
    id,
    statusCode: result?.statusCode,
    success: result?.success,
  }, null, 2) }] };
});

server.tool(
  'list_methods',
  'List enfyra_method records with their UI colors. Use this before creating route methods or method-colored UI.',
  {},
  async () => {
    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_method?fields=id,_id,name,buttonColor,textColor,isSystem&sort=name&limit=0');
    const methods = unwrapData(result).map((method) => ({
      id: getId(method),
      name: method.name,
      buttonColor: method.buttonColor,
      textColor: method.textColor,
      isSystem: method.isSystem === true,
    }));
    return { content: [{ type: 'text', text: JSON.stringify({
      tableName: 'enfyra_method',
      methods,
      appUi: '/settings/methods',
    }, null, 2) }] };
  },
);

server.tool(
  'create_method',
  'Create a enfyra_method record with app badge colors. Prefer this over generic create_record for enfyra_method.',
  {
    method: z.string().describe('Uppercase method name, e.g. GET, POST, PUT, CUSTOM_METHOD. Must start with A-Z and contain only A-Z, 0-9, or underscore.'),
    buttonColor: z.string().describe('Badge background color as full hex, e.g. #dbeafe.'),
    textColor: z.string().describe('Badge text color as full hex, e.g. #1d4ed8.'),
    isSystem: z.boolean().optional().default(false).describe('Set true only for built-in/runtime-owned methods. Normal app methods should leave this false.'),
  },
  async ({ method, buttonColor, textColor, isSystem }) => {
    const normalizedMethod = normalizeMethodNameInput(method);
    const existing = await findMethodRecordByName(normalizedMethod);
    if (existing) {
      throw new Error(`Method ${normalizedMethod} already exists with id ${getId(existing)}. Use update_method to change colors.`);
    }
    const body = {
      name: normalizedMethod,
      buttonColor: normalizeHexColorInput(buttonColor, 'buttonColor'),
      textColor: normalizeHexColorInput(textColor, 'textColor'),
      isSystem: isSystem === true,
    };
    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_method', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    _methodMap = null;
    return { content: [{ type: 'text', text: JSON.stringify({
      ...summarizeMutationResult(result, 'created', 'enfyra_method'),
      name: normalizedMethod,
      appUi: '/settings/methods',
    }, null, 2) }] };
  },
);

server.tool(
  'update_method',
  'Update a enfyra_method record color pair, and optionally rename non-system methods. Prefer this over generic update_record for enfyra_method.',
  {
    id: z.string().optional().describe('Method record id. If omitted, method is used to find the record.'),
    method: z.string().optional().describe('Existing method name to find, or new name when id is provided.'),
    buttonColor: z.string().optional().describe('Badge background color as full hex, e.g. #dbeafe.'),
    textColor: z.string().optional().describe('Badge text color as full hex, e.g. #1d4ed8.'),
  },
  async ({ id, method, buttonColor, textColor }) => {
    let targetId = id;
    let existing = null;
    if (!targetId) {
      if (!method) throw new Error('Provide id or method.');
      const normalizedMethod = normalizeMethodNameInput(method);
      existing = await findMethodRecordByName(normalizedMethod);
      if (!existing) throw new Error(`Method ${normalizedMethod} was not found.`);
      targetId = getId(existing);
    }

    const body = {};
    if (buttonColor !== undefined) {
      body.buttonColor = normalizeHexColorInput(buttonColor, 'buttonColor');
    }
    if (textColor !== undefined) {
      body.textColor = normalizeHexColorInput(textColor, 'textColor');
    }
    if (method !== undefined && id) {
      body.name = normalizeMethodNameInput(method);
    }
    if (Object.keys(body).length === 0) {
      throw new Error('Provide buttonColor, textColor, or a new method name.');
    }

    const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_method/${encodeURIComponent(String(targetId))}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    _methodMap = null;
    return { content: [{ type: 'text', text: JSON.stringify({
      ...summarizeMutationResult(result, 'updated', 'enfyra_method'),
      id: targetId,
      appUi: '/settings/methods',
    }, null, 2) }] };
  },
);

server.tool(
  'delete_method',
  'Preview or delete a enfyra_method record. Only delete unused custom methods; system/default methods should be kept.',
  {
    id: z.string().optional().describe('Method record id. If omitted, method is used to find the record.'),
    method: z.string().optional().describe('Method name to find when id is omitted.'),
    confirm: z.boolean().optional().default(false).describe('Required true to apply the destructive delete. Omit/false returns a preview only.'),
  },
  async ({ id, method, confirm }) => {
    let targetId = id;
    let target = null;
    if (!targetId) {
      if (!method) throw new Error('Provide id or method.');
      target = await findMethodRecordByName(normalizeMethodNameInput(method));
      if (!target) throw new Error(`Method ${method} was not found.`);
      targetId = getId(target);
    }
    if (!confirm) {
      if (!target) {
        const primaryKey = await getPrimaryFieldName('enfyra_method');
        const filter = encodeURIComponent(JSON.stringify({ [primaryKey]: { _eq: targetId } }));
        const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_method?filter=${filter}&limit=1&fields=id,_id,name,buttonColor,textColor,isSystem`);
        target = unwrapData(result)[0] || null;
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        action: 'delete_method_preview',
        id: targetId,
        name: target?.name,
        isSystem: target?.isSystem === true,
        destructive: true,
        warning: 'Only delete unused custom methods. Deleting a method can affect route method relations.',
        next: 'Call delete_method again with confirm=true to delete.',
      }, null, 2) }] };
    }
    const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_method/${encodeURIComponent(String(targetId))}`, { method: 'DELETE' });
    _methodMap = null;
    return { content: [{ type: 'text', text: JSON.stringify({
      action: 'deleted',
      tableName: 'enfyra_method',
      id: targetId,
      statusCode: result?.statusCode,
      success: result?.success,
    }, null, 2) }] };
  },
);

server.tool(
  'run_admin_test',
  [
    'Run an Enfyra admin test without saving metadata. Wraps POST /admin/test/run.',
    'Kinds: flow_step, websocket_event, websocket_connection. Use this to validate flow/websocket script behavior before creating records.',
  ].join(' '),
  {
    kind: z.enum(['flow_step', 'websocket_event', 'websocket_connection']).describe('Admin test kind'),
    body: z.string().describe('JSON body for the test. Include type/config for flow_step or script/gatewayPath/eventName/payload for websocket tests. Do not include kind; the tool adds it.'),
  },
  async ({ kind, body }) => {
    const parsed = body ? JSON.parse(body) : {};
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/test/run', {
      method: 'POST',
      body: JSON.stringify({ ...parsed, kind }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'test_flow_step',
  'Test a single flow step without saving it. Wraps POST /admin/test/run with kind=flow_step.',
  {
    type: z.enum(['script', 'condition', 'query', 'create', 'update', 'delete', 'http', 'trigger_flow', 'sleep', 'log']).describe('Flow step type'),
    config: z.string().describe('Step config as JSON string'),
    timeout: z.number().optional().describe('Timeout in ms'),
    key: z.string().optional().describe('Optional step key for mock flow context'),
    mockFlow: z.string().optional().describe('Optional mockFlow JSON object'),
  },
  async ({ type, config, timeout, key, mockFlow }) => {
    const body = {
      type,
      config: JSON.parse(config),
      ...(timeout ? { timeout } : {}),
      ...(key ? { key } : {}),
      ...(mockFlow ? { mockFlow: JSON.parse(mockFlow) } : {}),
    };
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/test/run', {
      method: 'POST',
      body: JSON.stringify({ ...body, kind: 'flow_step' }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'trigger_flow',
  'Trigger a saved flow by id or name. Wraps POST /admin/flow/trigger/:id.',
  {
    flowIdOrName: z.union([z.string(), z.number()]).describe('Flow id or name accepted by FlowService.trigger'),
    payload: z.string().optional().describe('Payload JSON object. Default {}.'),
  },
  async ({ flowIdOrName, payload }) => {
    const result = await fetchAPI(ENFYRA_API_URL, `/admin/flow/trigger/${encodeURIComponent(String(flowIdOrName))}`, {
      method: 'POST',
      body: JSON.stringify({ payload: payload ? JSON.parse(payload) : {} }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ============================================================================
// ROUTE & HANDLER TOOLS
// ============================================================================

let _methodMap = null;
async function getMethodMap() {
  if (_methodMap) return _methodMap;
  const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_method?limit=0');
  _methodMap = {};
  for (const m of result.data) {
    _methodMap[m.name] = m.id || m._id;
  }
  return _methodMap;
}

function resolveMethodIds(methodMap, names) {
  return names.map(m => {
    const id = methodMap[m.toUpperCase()];
    if (!id) throw new Error(`Unknown method "${m}". Valid: ${Object.keys(methodMap).join(', ')}`);
    return { id };
  });
}

async function getMethodIdNameMap() {
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

async function collectRestDefinitionState() {
  await getValidToken();
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
    getMetadataTables(),
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

async function collectFeatureSearchState() {
  const metadata = await discoveryFetch('/metadata');
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

  return {
    metadata,
    tables: normalizeTables(metadata),
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

function enrichRoute(route, state) {
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

server.tool(
  'inspect_table',
  [
    'REST-first inspection for one table. Use before writing code, filters, permissions, validation, or routes for a table.',
    'Returns columns, relations, route-backed REST paths, route handlers/hooks/guards/permissions, field permissions, and column validation rules.',
  ].join(' '),
  {
    tableName: z.string().describe('Table name or alias to inspect'),
  },
  async ({ tableName }) => {
    let state = await collectRestDefinitionState();
    let table = state.tables.find((item) => item?.name === tableName || item?.alias === tableName);
    if (!table) {
      await fetchAPI(ENFYRA_API_URL, '/admin/reload/metadata', { method: 'POST' }).catch(() => {});
      await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 150));
      state = await collectRestDefinitionState();
      table = state.tables.find((item) => item?.name === tableName || item?.alias === tableName);
    }
    if (!table) throw new Error(`Unknown table "${tableName}"`);
    const tableId = getId(table);
    const columnIds = new Set((table.columns || []).map((column) => String(getId(column))));
    const relationIds = new Set((table.relations || []).map((relation) => String(getId(relation))));
    const routes = state.routes.filter((route) => sameId(refId(route.mainTable), tableId));

    const payload = {
      table: summarizeTable(table),
      database: getMetadataDatabaseContext(state.metadata, state.tables),
      rest: {
        routePattern: 'GET/POST /<path>; PATCH/DELETE /<path>/:id; no dynamic GET /<path>/:id.',
        routes: routes.map((route) => enrichRoute(route, state)),
        routeBacked: routes.length > 0,
      },
      validation: {
        validateBody: table.validateBody,
        columnRules: state.columnRules.filter((rule) => columnIds.has(String(refId(rule.column)))),
      },
      permissions: {
        fieldPermissions: state.fieldPermissions.filter((permission) => (
          permission.column && columnIds.has(String(refId(permission.column)))
        ) || (
          permission.relation && relationIds.has(String(refId(permission.relation)))
        )),
      },
      queryGuidance: {
        fields: 'Use column names and relation propertyName values.',
        filter: 'Use query DSL operators on column names or nested relation propertyName objects.',
        deep: 'Deep fetch keys are relation propertyName values.',
        relationMutation: 'For relation schema creation/update use targetTable/type/propertyName/inversePropertyName|mappedBy/isNullable/onDelete only. Do not provide physical FK/junction columns; Enfyra derives and hides them.',
      },
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  'inspect_route',
  [
    'REST-first inspection for a route/path. Use before changing handlers, hooks, permissions, guards, or testing an endpoint.',
    'Returns the backing table, available/public methods, handlers, hooks, route permissions, guards, and exact REST URL pattern.',
  ].join(' '),
  {
    path: z.string().optional().describe('Route path, e.g. /enfyra_user'),
    routeId: z.union([z.string(), z.number()]).optional().describe('enfyra_route id. Use either path or routeId.'),
  },
  async ({ path, routeId }) => {
    if (!path && !routeId) throw new Error('Provide path or routeId');
    const state = await collectRestDefinitionState();
    const route = state.routes.find((item) => (
      routeId ? sameId(getId(item), routeId) : item.path === normalizeRestPath(path)
    ));
    if (!route) throw new Error(`Route not found: ${routeId || path}`);
    const table = state.tables.find((item) => sameId(getId(item), refId(route.mainTable))) || null;

    const payload = {
      apiBase: ENFYRA_API_URL.replace(/\/$/, ''),
      route: enrichRoute(route, state),
      mainTable: summarizeTable(table),
      restPattern: {
        listOrCreate: `${ENFYRA_API_URL.replace(/\/$/, '')}${route.path}`,
        updateOrDelete: `${ENFYRA_API_URL.replace(/\/$/, '')}${route.path}/<id>`,
        oneById: `Use GET ${route.path}?filter=${JSON.stringify({ [getPrimaryColumn(table)?.name || 'id']: { _eq: '<id>' } })}&limit=1`,
      },
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  'inspect_feature',
  [
    'Search live REST/system metadata for a feature name, route path, table, handler, hook, guard, or permission.',
    'Use when the user mentions a capability and you need to find where it lives before editing. Keep the query specific; broad searches return bounded summaries.',
  ].join(' '),
  {
    query: z.string().describe('Feature keyword, table name, route path, handler text, hook name, or guard name'),
    limit: z.number().int().positive().max(25).optional().default(8).describe('Maximum matches returned per section. Default 8 to keep output small.'),
  },
  async ({ query, limit }) => {
    const rawQuery = String(query || '').trim();
    if (rawQuery.length < 2) {
      throw new Error('inspect_feature query must be at least 2 characters. Use a table name, route path, event name, or specific feature keyword.');
    }
    const max = Math.max(1, Math.min(Number(limit || 8), 25));
    const state = await collectFeatureSearchState();
    const q = rawQuery.toLowerCase();
    const matchesText = (value) => JSON.stringify(value ?? '').toLowerCase().includes(q);
    const tableMatches = state.tables.filter((table) => matchesText({
      name: table.name,
      alias: table.alias,
      description: table.description,
      columns: table.columns?.map((column) => ({ name: column.name, description: column.description })),
      relations: table.relations?.map((relation) => ({ propertyName: relation.propertyName, description: relation.description })),
    }));
    const routeMatches = state.routes.filter((route) => matchesText(route));
    const handlerMatches = state.handlers.filter((handler) => matchesText(handler)).map((item) => pickCodeSummary(item, 'sourceCode'));
    const preHookMatches = state.preHooks.filter((hook) => matchesText(hook)).map((item) => pickCodeSummary(item, 'code'));
    const postHookMatches = state.postHooks.filter((hook) => matchesText(hook)).map((item) => pickCodeSummary(item, 'code'));
    const guardMatches = state.guards.filter((guard) => matchesText(guard));
    const permissionMatches = [
      ...state.routePermissions.filter((permission) => matchesText(permission)).map((permission) => ({ type: 'route_permission', ...permission })),
      ...state.fieldPermissions.filter((permission) => matchesText(permission)).map((permission) => ({ type: 'field_permission', ...permission })),
    ];

    const payload = {
      targetInstance: targetInstance(),
      query: rawQuery,
      limit: max,
      partialErrors: state.partialErrors,
      counts: {
        tables: tableMatches.length,
        routes: routeMatches.length,
        handlers: handlerMatches.length,
        preHooks: preHookMatches.length,
        postHooks: postHookMatches.length,
        guards: guardMatches.length,
        permissions: permissionMatches.length,
      },
      tables: tableMatches.slice(0, max).map(summarizeTable),
      routes: routeMatches.slice(0, max).map((route) => enrichRoute(route, state)),
      handlers: handlerMatches.slice(0, max),
      preHooks: preHookMatches.slice(0, max),
      postHooks: postHookMatches.slice(0, max),
      guards: guardMatches.slice(0, max),
      permissions: permissionMatches.slice(0, max),
      detailHint: 'For a specific match, call inspect_table, inspect_route, trace_metadata_usage, or get_script_source instead of broadening this search.',
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  'trace_metadata_usage',
  [
    'Trace where a table, route path, keyword, or script fragment appears across live metadata and script-backed records.',
    'Use this before changing production flows/handlers/hooks to find all callers or writers for a table such as cloud_provisioning_history.',
  ].join(' '),
  {
    query: z.string().describe('Table name, route path, field name, event name, or source-code keyword to trace'),
    includeSourcePreview: z.boolean().optional().default(true).describe('Include short source previews around matches.'),
    limit: z.number().optional().default(25).describe('Maximum matches per section.'),
  },
  async ({ query, includeSourcePreview, limit }) => {
    const q = String(query || '').trim();
    if (!q) throw new Error('query is required.');
    const lower = q.toLowerCase();
    const max = Math.max(1, Math.min(Number(limit || 25), 100));
    const state = await collectRestDefinitionState();
    const contains = (value) => JSON.stringify(value ?? '').toLowerCase().includes(lower);
    const sourceContains = (record) => getRecordSource(record).sourceCode.toLowerCase().includes(lower);

    const scriptTableResults = await Promise.all(SCRIPT_BACKED_TABLES.map(async (tableName) => {
      const fields = scriptTraceFields(tableName);
      let result = await fetchAPI(ENFYRA_API_URL, `/${tableName}?limit=1000&fields=${encodeURIComponent(fields)}`).catch((error) => ({ error }));
      if (result?.error && fields !== '*') {
        result = await fetchAPI(ENFYRA_API_URL, `/${tableName}?limit=1000&fields=*`).catch((error) => ({ error }));
      }
      return { tableName, records: unwrapData(result), error: result?.error?.message || null };
    }));
    const scriptMatches = [];
    const scriptErrors = [];
    for (const { tableName, records, error } of scriptTableResults) {
      if (error) {
        scriptErrors.push({ tableName, error });
        continue;
      }
      for (const record of records) {
        const { field, sourceCode } = getRecordSource(record);
        if (!field || !sourceContains(record)) continue;
        scriptMatches.push({
          ...scriptRecordLabel(tableName, record),
          sourceField: field,
          sourceLength: sourceCode.length,
          sourceSha256: sha256(sourceCode),
          preview: includeSourcePreview ? sourcePreview(sourceCode, q) : undefined,
        });
      }
    }

    const tableMatches = state.tables.filter((table) => contains({
      name: table.name,
      alias: table.alias,
      description: table.description,
      columns: (table.columns || []).map((column) => ({ name: column.name, type: column.type, description: column.description })),
      relations: (table.relations || []).map((relation) => ({ propertyName: relation.propertyName, type: relation.type, description: relation.description })),
    }));
    const routeMatches = state.routes.filter((route) => contains({
      path: route.path,
      mainTable: route.mainTable,
      description: route.description,
    }));
    const fieldPermissionMatches = state.fieldPermissions.filter((permission) => contains(permission));
    const guardMatches = state.guards.filter((guard) => contains(guard));
    const routePermissionMatches = state.routePermissions.filter((permission) => contains(permission));

    return { content: [{ type: 'text', text: JSON.stringify({
      query: q,
      counts: {
        tables: tableMatches.length,
        routes: routeMatches.length,
        scripts: scriptMatches.length,
        fieldPermissions: fieldPermissionMatches.length,
        routePermissions: routePermissionMatches.length,
        guards: guardMatches.length,
      },
      tables: tableMatches.map(summarizeTable).slice(0, max),
      routes: routeMatches.map((route) => enrichRoute(route, state)).slice(0, max),
      scripts: scriptMatches.slice(0, max),
      fieldPermissions: fieldPermissionMatches.slice(0, max),
      routePermissions: routePermissionMatches.slice(0, max),
      guards: guardMatches.slice(0, max),
      scriptReadErrors: scriptErrors,
      next: 'Use inspect_route/inspect_table for structure, get_script_source for full source, and patch_script_source for exact validated edits.',
    }, null, 2) }] };
  },
);

server.tool(
  'test_rest_endpoint',
  [
    'Execute a real REST request against the configured Enfyra API base.',
    'Use this after inspecting a route or changing handlers/hooks/guards. Pass paths like /enfyra_table?limit=1, not external URLs.',
  ].join(' '),
  {
    method: z.string().optional().default('GET').describe('HTTP method name. Must exist in enfyra_method.name for Enfyra route-backed calls.'),
    path: z.string().describe('Enfyra API path, e.g. /enfyra_route?limit=1'),
    query: z.string().optional().describe('Optional query params JSON object, merged onto path query string'),
    body: z.string().optional().describe('Optional JSON request body string'),
    headers: z.string().optional().describe('Optional headers JSON object'),
    useAuth: z.boolean().optional().default(true).describe('Attach MCP admin Bearer token. Set false to test public access.'),
  },
  async ({ method, path, query, body, headers, useAuth }) => {
    const httpMethod = normalizeMethodNameInput(method || 'GET');
    const restPath = normalizeRestPath(path);
    const url = new URL(`${ENFYRA_API_URL.replace(/\/$/, '')}${restPath}`);
    const queryObj = parseJsonArg(query, {});
    for (const [key, value] of Object.entries(queryObj || {})) {
      url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }

    const requestHeaders = {
      'Content-Type': 'application/json',
      ...(parseJsonArg(headers, {}) || {}),
    };
    if (useAuth) {
      requestHeaders.Authorization = `Bearer ${await getValidToken()}`;
    }

    const started = Date.now();
    const response = await fetch(url, {
      method: httpMethod,
      headers: requestHeaders,
      ...(body !== undefined && body !== null && httpMethod !== 'GET' ? { body } : {}),
    });
    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();
    let parsedBody = responseText;
    if (contentType.includes('application/json') && responseText) {
      parsedBody = JSON.parse(responseText);
    }

    const payload = {
      request: {
        method: httpMethod,
        url: url.toString(),
        authenticated: !!useAuth,
      },
      response: {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        contentType,
        durationMs: Date.now() - started,
        body: parsedBody,
      },
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool('get_all_routes', 'List route definitions with minimal fields. Every call must pass either limit or all=true. Call inspect_route for handlers/hooks/permissions detail.', {
  includeDisabled: z.boolean().optional().default(false).describe('Include disabled routes'),
  search: z.string().optional().describe('Optional path or table substring filter. Use this before creating a route to check duplicates.'),
  limit: z.number().int().positive().optional().describe('Maximum routes returned after search. Required unless all=true. Do not invent arbitrary limits for "all"; use all=true instead.'),
  all: z.boolean().optional().default(false).describe('Return all matched routes. Use this when the user asks for all routes or a complete route list.'),
}, async ({ includeDisabled, search, limit, all }) => {
  if (!all && limit === undefined) {
    throw new Error('get_all_routes requires either limit or all=true. Do not rely on implicit default page sizes.');
  }
  if (all && limit !== undefined) {
    throw new Error('get_all_routes accepts either all=true or limit, not both.');
  }
  const filter = includeDisabled ? {} : { isEnabled: { _eq: true } };
  const queryParams = new URLSearchParams({
    filter: JSON.stringify(filter),
    fields: 'id,path,mainTable.name,availableMethods.*,publicMethods.*,isEnabled',
    limit: '1000',
  });
  const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_route?${queryParams.toString()}`);
  const q = search ? search.toLowerCase() : null;
  const allRoutes = summarizeRoutes(result);
  const matchedRoutes = q
    ? allRoutes.filter((route) => JSON.stringify({
        path: route.path,
        mainTable: route.mainTable,
      }).toLowerCase().includes(q))
    : allRoutes;
  const routeLimit = all ? matchedRoutes.length : limit;
  const payload = {
    statusCode: result?.statusCode,
    success: result?.success,
    totalRouteCount: allRoutes.length,
    matchedRouteCount: matchedRoutes.length,
    returnedRouteCount: Math.min(matchedRoutes.length, routeLimit),
    all: !!all,
    search: search || null,
    routes: matchedRoutes.slice(0, routeLimit),
    detailHint: matchedRoutes.length > routeLimit
      ? `Response truncated to ${routeLimit} routes. Re-run with search or a higher limit, then inspect_route({ path }) for details.`
      : 'Use inspect_route({ path }) or inspect_route({ routeId }) for handlers, hooks, permissions, and guards.',
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
});

server.tool(
  'create_route',
  [
    '**Use this when the user wants a new REST API route or path** — not `create_table`. Custom routes must omit `mainTableId`.',
    '`mainTableId` is only a marker for canonical table routes such as `/orders`; do not set it for `/orders/stats`, `/reports/summary`, `/auth/login`, or any custom path.',
    'Do NOT create a new enfyra_table only to expose an endpoint; create a route without `mainTableId`, then have the handler/hook query explicit repos such as `$ctx.$repos.orders`.',
    'availableMethods = which REST verbs the route responds to. publicMethods = which REST verbs are public (no auth). GraphQL is enabled separately through enfyra_graphql/update_table graphqlEnabled.',
    'After creation the tool auto-reloads routes. Then create handlers for specific methods via create_handler on this route id.',
    'Flow: create_route → create_handler (per method) → optionally create_pre_hook / create_post_hook → test via HTTP or admin test APIs (see server instructions).',
  ].join(' '),
  {
    path: z.string().describe('URL path, must start with / (e.g., "/my-endpoint")'),
    mainTableId: z.union([z.string(), z.number()]).optional().describe('Only set for the canonical table route `/<table_name>`. Omit for every custom route.'),
    methods: z.array(z.string())
      .describe('HTTP method names this route supports (availableMethods). Each value must exist in enfyra_method.name. Common: ["GET","POST","PATCH","DELETE"].'),
    publicMethods: z.array(z.string()).optional()
      .describe('Methods accessible WITHOUT auth token. Omit = all methods require auth.'),
    isEnabled: z.boolean().optional().default(true).describe('Enable route immediately'),
    description: z.string().optional().describe('Route description'),
  },
  async ({ path: routePath, mainTableId, methods, publicMethods, isEnabled, description }) => {
    const methodMap = await getMethodMap();
    const normalizedPath = normalizeRestPath(routePath);

    const body = {
      path: normalizedPath,
      isEnabled,
      description,
      availableMethods: resolveMethodIds(methodMap, methods),
    };

    if (mainTableId !== undefined && mainTableId !== null) {
      const { tables } = await getMetadataTables();
      validateMainTableRoutePath(tables, mainTableId, normalizedPath);
      body.mainTable = { id: mainTableId };
    }

    if (publicMethods && publicMethods.length > 0) {
      body.publicMethods = resolveMethodIds(methodMap, publicMethods);
    }

    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_route', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const routeReload = await reloadRoutesResult();

    const created = firstDataRecord(result);
    return { content: [{ type: 'text', text: JSON.stringify({
      action: 'created',
      route: {
        id: getId(created),
        path: created?.path,
        mainTableId: mainTableId ?? null,
        availableMethods: methods,
        publicMethods: publicMethods || [],
      },
      routeReload,
      next: `Use create_handler({ routeId: ${JSON.stringify(getId(created))}, method: "GET", sourceCode }) for custom code. Create extra enfyra_method.name rows first for custom methods such as PUT.`,
    }, null, 2) }] };
  },
);

server.tool(
  'create_handler',
  [
    'Create a handler for a route+method. One handler per (route, method) pair.',
    'Attach to the route the user cares about (`get_all_routes`): typically a path from `create_route`, not a spurious table created only for handlers.',
    'Use sourceCode, not logic/name. Enfyra compiles sourceCode into compiledCode; do not send compiledCode.',
    'Handler code runs inside a sandbox with $ctx. Use macros: @BODY, @QUERY, @PARAMS, @USER, @REPOS, @HELPERS, @THROW400..@THROW503, @SOCKET, @PKGS, @LOGS, @SHARE.',
    'Or use $ctx directly: $ctx.$body, $ctx.$repos.main.find(), $ctx.$helpers.$bcrypt.hash(), etc.',
    'require("pkg") works for installed Server packages. console.log() writes to $share.$logs.',
  ].join(' '),
  {
    routeId: z.union([z.string(), z.number()]).describe('Route definition ID'),
    method: z.string().optional()
      .describe('Single enfyra_method.name to create. Prefer this for one handler.'),
    methods: z.array(z.string()).optional()
      .describe('Batch create multiple handlers. Use only when the same sourceCode applies to every method.'),
    sourceCode: z.string().describe('Handler JavaScript sourceCode. Do not use logic; backend CRUD rejects logic.'),
    scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language for compiler. Default javascript.'),
    timeout: z.number().optional().describe('Timeout in ms (default: system DEFAULT_HANDLER_TIMEOUT, usually 30000)'),
  },
  async ({ routeId, method, methods, sourceCode, scriptLanguage, timeout }) => {
    const methodNames = methods && methods.length > 0 ? methods : method ? [method] : [];
    if (methodNames.length === 0) throw new Error('Provide method or methods');
    const methodMap = await getMethodMap();
    const results = [];
    const scriptValidation = await validateScriptSourceIfPresent(fetchAPI, ENFYRA_API_URL, 'enfyra_route_handler', {
      sourceCode,
      scriptLanguage,
    });

    for (const methodName of methodNames) {
      const methodId = methodMap[methodName.toUpperCase()];
      if (!methodId) throw new Error(`Unknown method: ${methodName}. Valid: ${Object.keys(methodMap).join(', ')}`);

      const body = { route: { id: routeId }, method: { id: methodId }, sourceCode, scriptLanguage };
      if (timeout) body.timeout = timeout;

      const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_route_handler', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const created = firstDataRecord(result);
      results.push({
        id: getId(created),
        routeId,
        method: methodName,
        scriptLanguage,
        timeout: created?.timeout ?? timeout ?? null,
      });
    }

    const routeReload = await reloadRoutesResult();

    return { content: [{ type: 'text', text: JSON.stringify({
      action: 'created',
      handlers: results,
      scriptValidation,
      routeReload,
      detailHint: 'Use inspect_route with the same routeId/path to inspect saved handlers.',
    }, null, 2) }] };
  },
);

server.tool(
  'create_pre_hook',
  [
    'Create a pre-hook that runs BEFORE the handler. Use to validate, transform, or inject data.',
    'Use `routeId` from `create_route` or `get_all_routes` — do not create a new table just to get a route id.',
    'Macros: @BODY, @QUERY, @PARAMS, @USER, @REPOS, @HELPERS, @THROW400..@THROW503.',
    'If the hook returns a value, that value becomes the response (handler is skipped).',
  ].join(' '),
  {
    routeId: z.union([z.string(), z.number()]).describe('Route definition ID'),
    name: z.string().describe('Hook name (unique per route)'),
    code: z.string().describe('Hook JavaScript sourceCode. MCP stores it as sourceCode and lets Enfyra compile compiledCode.'),
    scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language for compiler. Default javascript.'),
    methods: z.array(z.string()).optional()
      .describe('Method names this hook applies to. Default: built-in REST methods GET, POST, PATCH, DELETE.'),
    priority: z.number().optional().default(0).describe('Execution order (lower = first)'),
    isEnabled: z.boolean().optional().default(true).describe('Enable hook immediately'),
  },
  async ({ routeId, name, code, scriptLanguage, methods, priority, isEnabled }) => {
    const methodMap = await getMethodMap();
    const methodNames = methods || ['GET', 'POST', 'PATCH', 'DELETE'];
    const scriptValidation = await validateScriptSourceIfPresent(fetchAPI, ENFYRA_API_URL, 'enfyra_pre_hook', {
      sourceCode: code,
      scriptLanguage,
    });

    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_pre_hook', {
      method: 'POST',
      body: JSON.stringify({
        route: { id: routeId },
        name,
        sourceCode: code,
        scriptLanguage,
        methods: resolveMethodIds(methodMap, methodNames),
        priority,
        isEnabled,
      }),
    });

    const routeReload = await reloadRoutesResult();

    const created = firstDataRecord(result);
    return { content: [{ type: 'text', text: JSON.stringify({
      action: 'created',
      kind: 'pre_hook',
      id: getId(created),
      name,
      routeId,
      scriptValidation,
      routeReload,
    }, null, 2) }] };
  },
);

server.tool(
  'create_post_hook',
  [
    'Create a post-hook that runs AFTER the handler. Use to transform responses or add metadata.',
    'Use `routeId` from `create_route` or `get_all_routes` — do not create a new table just to get a route id.',
    'Macros: @DATA, @STATUS, @ERROR, @BODY, @QUERY, @USER, @SHARE, @API (post-hooks always run; on error path @ERROR is set, @DATA is null).',
    'Mutate @DATA / $ctx.$data in place, or return a value: if the hook returns anything other than undefined, that value replaces $ctx.$data as the response payload.',
  ].join(' '),
  {
    routeId: z.union([z.string(), z.number()]).describe('Route definition ID'),
    name: z.string().describe('Hook name (unique per route)'),
    code: z.string().describe('Hook JavaScript sourceCode. MCP stores it as sourceCode and lets Enfyra compile compiledCode.'),
    scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language for compiler. Default javascript.'),
    methods: z.array(z.string()).optional()
      .describe('Method names this hook applies to. Default: built-in REST methods GET, POST, PATCH, DELETE.'),
    priority: z.number().optional().default(0).describe('Execution order (lower = first)'),
    isEnabled: z.boolean().optional().default(true).describe('Enable hook immediately'),
  },
  async ({ routeId, name, code, scriptLanguage, methods, priority, isEnabled }) => {
    const methodMap = await getMethodMap();
    const methodNames = methods || ['GET', 'POST', 'PATCH', 'DELETE'];
    const scriptValidation = await validateScriptSourceIfPresent(fetchAPI, ENFYRA_API_URL, 'enfyra_post_hook', {
      sourceCode: code,
      scriptLanguage,
    });

    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_post_hook', {
      method: 'POST',
      body: JSON.stringify({
        route: { id: routeId },
        name,
        sourceCode: code,
        scriptLanguage,
        methods: resolveMethodIds(methodMap, methodNames),
        priority,
        isEnabled,
      }),
    });

    const routeReload = await reloadRoutesResult();

    const created = firstDataRecord(result);
    return { content: [{ type: 'text', text: JSON.stringify({
      action: 'created',
      kind: 'post_hook',
      id: getId(created),
      name,
      routeId,
      scriptValidation,
      routeReload,
    }, null, 2) }] };
  },
);

server.tool(
  'create_column_rule',
  [
    'Create a REST body validation rule for a table column.',
    'Use inspect_table first to confirm validateBody, column type, and existing rules. Rule value is JSON; common shape is {"v": ...}.',
  ].join(' '),
  {
    tableName: z.string().describe('Table name or alias'),
    columnName: z.string().describe('Column name'),
    ruleType: z.enum(['min', 'max', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'custom']).describe('Validation rule type'),
    value: z.string().optional().describe('Rule payload JSON, e.g. {"v":10} or {"v":"email"}'),
    message: z.string().optional().describe('Custom validation error message'),
    description: z.string().optional().describe('Admin note'),
    isEnabled: z.boolean().optional().default(true).describe('Enable the rule immediately'),
  },
  async ({ tableName, columnName, ruleType, value, message, description, isEnabled }) => {
    const { tables } = await getMetadataTables();
    const table = resolveTableOrThrow(tables, tableName);
    const column = resolveFieldOrThrow(table, columnName, 'column');
    const body = {
      ruleType,
      value: parseJsonArg(value, null),
      message,
      description,
      isEnabled,
      column: { id: getId(column) },
    };
    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_column_rule', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { content: [{ type: 'text', text: `Column rule created for ${table.name}.${column.name}.\n${JSON.stringify(result, null, 2)}` }] };
  },
);

server.tool(
  'create_field_permission',
  [
    'Create a field permission for one column or relation.',
    'Exactly one of columnName or relationName is required. Scope requires roleId or allowedUserIds. Conditions use the field permission condition DSL, not the full query DSL.',
  ].join(' '),
  {
    tableName: z.string().describe('Table name or alias'),
    columnName: z.string().optional().describe('Column name to protect'),
    relationName: z.string().optional().describe('Relation propertyName to protect'),
    action: z.enum(['read', 'create', 'update']).default('read').describe('Action this permission applies to'),
    effect: z.enum(['allow', 'deny']).default('allow').describe('Allow or deny this field action'),
    roleId: z.union([z.string(), z.number()]).optional().describe('Role id scope'),
    allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Specific user ids scope'),
    condition: z.string().optional().describe('Optional condition JSON using field permission condition DSL'),
    description: z.string().optional().describe('Admin note'),
    isEnabled: z.boolean().optional().default(true).describe('Enable immediately'),
  },
  async ({ tableName, columnName, relationName, action, effect, roleId, allowedUserIds, condition, description, isEnabled }) => {
    if (!!columnName === !!relationName) throw new Error('Provide exactly one of columnName or relationName');
    if (!roleId && (!allowedUserIds || allowedUserIds.length === 0)) {
      throw new Error('Provide roleId or allowedUserIds');
    }
    const { tables } = await getMetadataTables();
    const table = resolveTableOrThrow(tables, tableName);
    const body = {
      isEnabled,
      description,
      action,
      effect,
      condition: parseJsonArg(condition, null),
      ...(roleId ? { role: { id: roleId } } : {}),
      ...(allowedUserIds?.length ? { allowedUsers: allowedUserIds.map((id) => ({ id })) } : {}),
    };
    if (columnName) {
      body.column = { id: getId(resolveFieldOrThrow(table, columnName, 'column')) };
    } else {
      body.relation = { id: getId(resolveFieldOrThrow(table, relationName, 'relation')) };
    }
    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_field_permission', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { content: [{ type: 'text', text: `Field permission created on ${table.name}.${columnName || relationName}.\n${JSON.stringify(result, null, 2)}` }] };
  },
);

server.tool(
  'create_route_permission',
  [
    'Create route access permission for a route and REST methods.',
    'Use this when a non-root role/user should access an authenticated route. publicMethods are for public access; route permissions are for authenticated role/user access.',
  ].join(' '),
  {
    path: z.string().optional().describe('Route path, e.g. /enfyra_user'),
    routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
    methods: z.array(z.string()).describe('REST method names this permission allows. Each value must exist in enfyra_method.name.'),
    roleId: z.union([z.string(), z.number()]).optional().describe('Role id scope'),
    allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Specific user ids scope'),
    description: z.string().optional().describe('Admin note'),
    isEnabled: z.boolean().optional().default(true).describe('Enable immediately'),
  },
  async ({ path, routeId, methods, roleId, allowedUserIds, description, isEnabled }) => {
    if (!path && !routeId) throw new Error('Provide path or routeId');
    if (!roleId && (!allowedUserIds || allowedUserIds.length === 0)) {
      throw new Error('Provide roleId or allowedUserIds');
    }
    const routes = await fetchAll('/enfyra_route?limit=1000');
    const route = routes.find((item) => (
      routeId ? sameId(getId(item), routeId) : item.path === normalizeRestPath(path)
    ));
    if (!route) throw new Error(`Route not found: ${routeId || path}`);
    const methodMap = await getMethodMap();
    const body = {
      isEnabled,
      description,
      route: { id: getId(route) },
      methods: resolveMethodIds(methodMap, methods),
      ...(roleId ? { role: { id: roleId } } : {}),
      ...(allowedUserIds?.length ? { allowedUsers: allowedUserIds.map((id) => ({ id })) } : {}),
    };
    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_route_permission', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const routeReload = await reloadRoutesResult();
    return { content: [{ type: 'text', text: JSON.stringify({
      action: 'created',
      kind: 'route_permission',
      route: route.path,
      routeReload,
      result,
    }, null, 2) }] };
  },
);

server.tool(
  'audit_route_access',
  [
    'Audit route access for one or more routes.',
    'Use this before granting access or debugging 403s. It reports available methods, public methods, skipRoleGuard methods, route permissions, and optional missing methods for one role/user scope.',
  ].join(' '),
  {
    path: z.string().optional().describe('Exact route path, e.g. /orders'),
    routeId: z.union([z.string(), z.number()]).optional().describe('Exact route id'),
    search: z.string().optional().describe('Optional route path search when path/routeId is not provided'),
    roleId: z.union([z.string(), z.number()]).optional().describe('Expected role id to check'),
    roleName: z.string().optional().describe('Expected role name to resolve, e.g. user'),
    allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Expected direct/specific user ids to check'),
    methods: z.array(z.string()).optional().describe('Methods expected to be allowed for this scope'),
    limit: z.number().int().positive().max(100).optional().default(25).describe('Maximum routes returned for search mode'),
  },
  async ({ path, routeId, search, roleId, roleName, allowedUserIds, methods, limit }) => {
    if ([path, routeId, search].filter((value) => value !== undefined && value !== null && value !== '').length > 1) {
      throw new Error('Use only one of path, routeId, or search.');
    }
    if (roleId && roleName) throw new Error('Provide roleId or roleName, not both.');

    const [routes, routePermissions, roles, methodIdNameMap] = await Promise.all([
      fetchAll('/enfyra_route?limit=1000'),
      fetchAll('/enfyra_route_permission?limit=1000'),
      fetchAll('/enfyra_role?limit=1000'),
      getMethodIdNameMap(),
    ]);

    const role = resolveRoleByNameOrId(roles, { roleId, roleName });
    const normalizedPath = path ? normalizeRestPath(path) : null;
    const query = search ? String(search).toLowerCase() : null;
    const matchedRoutes = routes.filter((route) => {
      if (routeId) return sameId(getId(route), routeId);
      if (normalizedPath) return route.path === normalizedPath;
      if (query) return String(route.path || '').toLowerCase().includes(query);
      return true;
    }).slice(0, limit);

    const expectedMethods = normalizeMethodNames(methods || []);
    const payload = {
      guidance: {
        publicAccess: 'publicMethods bypass RoleGuard and do not require enfyra_route_permission.',
        authenticatedAccess: 'For non-public methods, Enfyra admin UI PermissionGate and backend RoleGuard both expect enabled enfyra_route_permission rows with matching route + HTTP method.',
        directUserAccess: 'allowedRoutePermissions on /me represent direct user-scoped route permissions; role.routePermissions represent role-scoped permissions.',
      },
      expectedScope: {
        role: role ? { id: getId(role), name: role.name } : null,
        allowedUserIds: allowedUserIds || [],
        methods: expectedMethods,
      },
      returnedRouteCount: matchedRoutes.length,
      routes: matchedRoutes.map((route) => summarizeRouteAccess(route, routePermissions, methodIdNameMap, {
        roleId: role ? getId(role) : roleId,
        roleRequired: !!(role || roleId || roleName),
        allowedUserIds,
        methods: expectedMethods,
      })),
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  'ensure_route_access',
  [
    'Create or update authenticated route access for one role/user scope.',
    'Use this instead of raw enfyra_route_permission CRUD when fixing 403s. It resolves roleName/route/method ids, validates route.availableMethods, merges existing permission methods by default, and reloads routes.',
  ].join(' '),
  {
    path: z.string().optional().describe('Route path, e.g. /orders'),
    routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
    methods: z.array(z.string()).describe('HTTP method names to allow, e.g. ["GET", "POST"].'),
    roleId: z.union([z.string(), z.number()]).optional().describe('Role id scope'),
    roleName: z.string().optional().describe('Role name scope, e.g. user. Prefer this when an LLM does not know role ids.'),
    allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Specific user ids scope. Omit for role-wide access.'),
    mode: z.enum(['merge', 'replace']).optional().default('merge').describe('merge adds methods to an existing permission; replace overwrites methods on the matched permission.'),
    description: z.string().optional().describe('Admin note'),
    isEnabled: z.boolean().optional().default(true).describe('Enable the permission'),
  },
  async ({ path, routeId, methods, roleId, roleName, allowedUserIds, mode, description, isEnabled }) => {
    if (!path && !routeId) throw new Error('Provide path or routeId.');
    if (path && routeId) throw new Error('Provide path or routeId, not both.');
    if (roleId && roleName) throw new Error('Provide roleId or roleName, not both.');
    if (!roleId && !roleName && (!allowedUserIds || allowedUserIds.length === 0)) {
      throw new Error('Provide roleId, roleName, or allowedUserIds.');
    }

    const [routes, routePermissions, roles, methodMap, methodIdNameMap] = await Promise.all([
      fetchAll('/enfyra_route?limit=1000'),
      fetchAll('/enfyra_route_permission?limit=1000'),
      fetchAll('/enfyra_role?limit=1000'),
      getMethodMap(),
      getMethodIdNameMap(),
    ]);
    const route = routes.find((item) => (
      routeId ? sameId(getId(item), routeId) : item.path === normalizeRestPath(path)
    ));
    if (!route) throw new Error(`Route not found: ${routeId || path}`);

    const role = resolveRoleByNameOrId(roles, { roleId, roleName });
    const scope = {
      roleId: role ? getId(role) : roleId,
      allowedUserIds: allowedUserIds || [],
    };
    const requestedMethods = validateMethodsForRoute(route, methods, methodMap, methodIdNameMap);
    const existing = findRoutePermission(routePermissions, getId(route), scope);
    const existingMethods = existing ? summarizeRoutePermission(existing, methodIdNameMap).methods : [];
    const finalMethods = mergeMethodNames(existingMethods, requestedMethods, mode);
    const methodRefs = resolveMethodIds(methodMap, finalMethods);
    const publicMethods = routePublicMethodNames(route, methodIdNameMap);
    const alreadyPublic = requestedMethods.filter((method) => publicMethods.includes(method));

    let result;
    let action;
    if (existing) {
      action = 'updated';
      const patchBody = {
        isEnabled,
        methods: methodRefs,
        ...(description !== undefined ? { description } : {}),
      };
      result = await fetchAPI(ENFYRA_API_URL, `/enfyra_route_permission/${encodeURIComponent(String(getId(existing)))}`, {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      });
    } else {
      action = 'created';
      const createBody = {
        isEnabled,
        description,
        route: { id: getId(route) },
        methods: methodRefs,
        ...(scope.roleId ? { role: { id: scope.roleId } } : {}),
        ...(scope.allowedUserIds.length ? { allowedUsers: scope.allowedUserIds.map((id) => ({ id })) } : {}),
      };
      result = await fetchAPI(ENFYRA_API_URL, '/enfyra_route_permission', {
        method: 'POST',
        body: JSON.stringify(createBody),
      });
    }

    const routeReload = await reloadRoutesResult();
    const saved = firstDataRecord(result);
    const payload = {
      action,
      kind: 'route_access',
      route: {
        id: getId(route),
        path: route.path,
        availableMethods: routeAvailableMethodNames(route, methodIdNameMap),
        publicMethods,
      },
      scope: {
        role: role ? { id: getId(role), name: role.name } : null,
        allowedUserIds: scope.allowedUserIds,
      },
      permission: {
        id: getId(saved) || getId(existing),
        methods: finalMethods,
        alreadyPublic,
        isEnabled,
      },
      result,
      routeReload,
      auditHint: `Call audit_route_access({ path: "${route.path}", ${role ? `roleName: "${role.name}", ` : ''}methods: ${JSON.stringify(requestedMethods)} }) to verify.`,
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  'create_guard',
  [
    'Create a metadata guard with optional rules for REST request gating.',
    'Root guards attach to one route by path/routeId or globally with isGlobal. pre_auth runs before JWT and only has IP/route context; post_auth runs after auth and can use user id.',
    'Rule types: rate_limit_by_ip, rate_limit_by_user, rate_limit_by_route, ip_whitelist, ip_blacklist. Rate limits use {"maxRequests":number,"perSeconds":number}; IP lists use {"ips":["127.0.0.1","10.0.0.0/24"]}.',
    'Do not use rate_limit_by_user or userIds on pre_auth guards. Create risky global/IP whitelist guards disabled first, then inspect and test before enabling.',
  ].join(' '),
  {
    name: z.string().describe('Guard name'),
    position: z.enum(['pre_auth', 'post_auth']).default('pre_auth').describe('Execution position for root guard. pre_auth has only IP/route context; post_auth also has authenticated user id.'),
    routeId: z.union([z.string(), z.number()]).optional().describe('Optional route id'),
    path: z.string().optional().describe('Optional route path'),
    methods: z.array(z.string()).optional().describe('Method names this guard applies to. Empty means all configured behavior for route/global.'),
    combinator: z.enum(['and', 'or']).default('and').describe('How child guards/rules combine'),
    priority: z.number().optional().default(0).describe('Lower runs first'),
    isGlobal: z.boolean().optional().default(false).describe('Apply globally instead of one route'),
    isEnabled: z.boolean().optional().default(false).describe('Enable immediately. Default false to avoid accidental lockout.'),
    description: z.string().optional().describe('Admin note'),
    rules: z.string().optional().describe('Optional rules JSON array: [{type, config, priority?, isEnabled?, description?, userIds?}]. Supported types: rate_limit_by_ip, rate_limit_by_user, rate_limit_by_route, ip_whitelist, ip_blacklist.'),
  },
  async ({ name, position, routeId, path, methods, combinator, priority, isGlobal, isEnabled, description, rules }) => {
    let route = null;
    if (!isGlobal && (routeId || path)) {
      const routes = await fetchAll('/enfyra_route?limit=1000');
      route = routes.find((item) => (
        routeId ? sameId(getId(item), routeId) : item.path === normalizeRestPath(path)
      ));
      if (!route) throw new Error(`Route not found: ${routeId || path}`);
    }
    const methodMap = await getMethodMap();
    const guardBody = {
      name,
      position,
      combinator,
      priority,
      isGlobal,
      isEnabled,
      description,
      ...(route ? { route: { id: getId(route) } } : {}),
      ...(methods?.length ? { methods: resolveMethodIds(methodMap, methods) } : {}),
    };
    const guard = await fetchAPI(ENFYRA_API_URL, '/enfyra_guard', {
      method: 'POST',
      body: JSON.stringify(guardBody),
    });
    const ruleInputs = parseJsonArg(rules, []);
    const createdRules = [];
    for (const rule of ruleInputs) {
      const ruleBody = {
        type: rule.type,
        config: rule.config,
        priority: rule.priority ?? 0,
        isEnabled: rule.isEnabled ?? true,
        description: rule.description,
        guard: { id: resultRecordId(guard) },
        ...(Array.isArray(rule.userIds) && rule.userIds.length ? { users: rule.userIds.map((id) => ({ id })) } : {}),
      };
      createdRules.push(await fetchAPI(ENFYRA_API_URL, '/enfyra_guard_rule', {
        method: 'POST',
        body: JSON.stringify(ruleBody),
      }));
    }
    await fetchAPI(ENFYRA_API_URL, '/admin/reload/guards', { method: 'POST' }).catch(() => {});
    return { content: [{ type: 'text', text: `Guard created. Guard cache reloaded.\n${JSON.stringify({ guard, rules: createdRules }, null, 2)}` }] };
  },
);

// Register table tools
registerTableTools(server, ENFYRA_API_URL);
registerPlatformOperationTools(server, ENFYRA_API_URL);

// ============================================================================
// CACHE & SYSTEM TOOLS
// ============================================================================

server.tool('reload_all', 'Reload all caches (metadata, routes, GraphQL)', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload', { method: 'POST' });
  return { content: [{ type: 'text', text: `System reloaded:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('reload_metadata', 'Reload metadata cache only', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/metadata', { method: 'POST' });
  return { content: [{ type: 'text', text: `Metadata reloaded:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('reload_routes', 'Reload routes cache only', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' });
  return { content: [{ type: 'text', text: `Routes reloaded:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('reload_graphql', 'Reload GraphQL schema', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/graphql', { method: 'POST' });
  return { content: [{ type: 'text', text: `GraphQL reloaded:\n${JSON.stringify(result, null, 2)}` }] };
});

// ============================================================================
// LOGS TOOLS
// ============================================================================

server.tool('get_log_files', 'List available log files and stats', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/logs');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('get_log_content', 'Get content of a specific log file', {
  filename: z.string().describe('Log file name'),
  page: z.number().optional().default(1).describe('Page number'),
  pageSize: z.number().optional().default(100).describe('Lines per page'),
  filter: z.string().optional().describe('Text filter'),
  level: z.string().optional().describe('Log level filter (INFO, WARN, ERROR)'),
}, async ({ filename, page, pageSize, filter, level }) => {
  const queryParams = new URLSearchParams();
  if (page) queryParams.set('page', String(page));
  if (pageSize) queryParams.set('pageSize', String(pageSize));
  if (filter) queryParams.set('filter', filter);
  if (level) queryParams.set('level', level);
  const result = await fetchAPI(ENFYRA_API_URL, `/logs/${filename}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('tail_log', 'Get last N lines from a log file', {
  filename: z.string().describe('Log file name'),
  lines: z.number().optional().default(50).describe('Number of lines to retrieve'),
}, async ({ filename, lines }) => {
  const result = await fetchAPI(ENFYRA_API_URL, `/logs/${filename}/tail?lines=${lines}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('search_logs', 'Search for ERROR or WARN logs across recent log files', {
  level: z.enum(['ERROR', 'WARN', 'INFO']).optional().default('ERROR').describe('Log level'),
  keyword: z.string().optional().describe('Keyword to filter logs'),
  limit: z.number().optional().default(50).describe('Max results per level'),
}, async ({ level, keyword, limit }) => {
  const logFilesResult = await fetchAPI(ENFYRA_API_URL, '/logs');
  const logFiles = logFilesResult.files || [];
  const recentFiles = logFiles.filter((file) => {
    const name = file?.name || '';
    return /^app[.-]/.test(name) || /^error[.-]/.test(name);
  });
  const results = [];
  for (const file of recentFiles.slice(0, 3)) {
    try {
      const contentResult = await fetchAPI(ENFYRA_API_URL, `/logs/${file.name}?level=${level}&pageSize=${limit}`);
      const lines = contentResult.lines || contentResult.data || [];
      const filteredLines = keyword ? lines.filter(l => JSON.stringify(l).toLowerCase().includes(keyword.toLowerCase())) : lines;
      if (filteredLines.length > 0) results.push({ file: file.name, level, logs: filteredLines });
    } catch (e) { /* skip */ }
  }
  return { content: [{ type: 'text', text: `Found ${results.length} files:\n${JSON.stringify(results, null, 2)}` }] };
});

// ============================================================================
// AUTH & USER TOOLS
// ============================================================================

server.tool('get_current_user', 'Get current authenticated user info', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/me');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('get_all_roles', 'Get all role definitions', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_role?limit=100');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('login', 'Force authentication to Enfyra and get a new access token', {
  apiToken: z.string().optional().describe('API token for MCP and automation'),
}, async ({ apiToken }) => {
  const token = apiToken || ENFYRA_API_TOKEN;
  if (token) {
    await exchangeApiToken(ENFYRA_API_URL, token);
    const expiry = getTokenExpiry();
    const expiryLabel = expiry === Infinity ? 'no expiration' : new Date(expiry).toISOString();
    return { content: [{ type: 'text', text: `Authenticated with API token.\nToken expires: ${expiryLabel}` }] };
  }
  throw new Error('ENFYRA_API_TOKEN required');
});

// ============================================================================
// PACKAGE TOOLS
// ============================================================================

server.tool(
  'search_npm',
  'Search NPM registry for packages. Returns name, version, description for installation.',
  {
    query: z.string().describe('Package name or search term (e.g., "axios", "node-ssh", "dayjs")'),
    limit: z.number().optional().default(5).describe('Max results (default: 5)'),
  },
  async ({ query, limit }) => {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`NPM search failed: ${response.statusText}`);
    const data = await response.json();

    const packages = data.objects.map((obj) => ({
      name: obj.package.name,
      version: obj.package.version,
      description: obj.package.description || '',
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ packages, total: data.total }, null, 2),
      }],
    };
  },
);

server.tool(
  'install_package',
  [
    'Install an NPM package on Enfyra. Searches NPM registry for exact version, then creates enfyra_package record.',
    'Enfyra handles the actual yarn add internally based on type.',
    'Type "Server" = available in handlers/hooks as $ctx.$pkgs.packageName.',
    'Type "App" = available in extensions via getPackages().',
  ].join(' '),
  {
    name: z.string().describe('Exact NPM package name (e.g., "node-ssh", "axios")'),
    type: z.enum(['Server', 'App']).default('Server').describe('Where to install: Server (handlers/hooks) or App (extensions)'),
    version: z.string().optional().describe('Specific version. If omitted, fetches latest from NPM.'),
  },
  async ({ name, type, version }) => {
    // Step 1: Get package info from NPM if version not specified
    let pkgVersion = version;
    let pkgDescription = '';

    if (!pkgVersion) {
      const npmUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=5`;
      const npmResponse = await fetch(npmUrl);
      if (!npmResponse.ok) throw new Error(`NPM search failed: ${npmResponse.statusText}`);
      const npmData = await npmResponse.json();

      const exactMatch = npmData.objects.find((obj) => obj.package.name === name);
      if (!exactMatch) throw new Error(`Package "${name}" not found on NPM`);

      pkgVersion = exactMatch.package.version;
      pkgDescription = exactMatch.package.description || '';
    }

    // Step 2: Check if already installed (same name AND type)
    const checkFilter = JSON.stringify({ name: { _eq: name }, type: { _eq: type } });
    const existing = await fetchAPI(ENFYRA_API_URL, `/enfyra_package?filter=${encodeURIComponent(checkFilter)}&limit=1`);
    if (existing.data && existing.data.length > 0) {
      return {
        content: [{
          type: 'text',
          text: `Package "${name}" is already installed (version: ${existing.data[0].version}, type: ${existing.data[0].type}).\n${JSON.stringify(existing.data[0], null, 2)}`,
        }],
      };
    }

    // Step 3: Get current user for installedBy
    const me = await fetchAPI(ENFYRA_API_URL, '/me');
    const userId = me.data?.[0]?.id || me.data?.[0]?._id;
    if (!userId) throw new Error('Cannot get current user ID');

    // Step 4: Install via enfyra_package
    const body = {
      name,
      version: pkgVersion,
      description: pkgDescription,
      type,
      installedBy: { id: userId },
    };

    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_package', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      content: [{
        type: 'text',
        text: `Package "${name}@${pkgVersion}" installed successfully (type: ${type}).\n${JSON.stringify(result, null, 2)}`,
      }],
    };
  },
);

// ============================================================================
// MENU & EXTENSION TOOLS
// ============================================================================

server.tool('create_menu', 'Create a menu item in the navigation. Use permission JSON for sensitive menu visibility; successful writes should trigger the app menu reload contract.', {
  label: z.string().describe('Menu label'),
  type: z.enum(['Menu', 'Dropdown Menu']).default('Menu').describe('Menu type: "Menu" for leaf items, "Dropdown Menu" for items with children'),
  icon: z.string().optional().describe('Lucide icon name'),
  path: z.string().optional().describe('App route path for a clickable menu item, e.g. "/reports".'),
  externalUrl: z.string().optional().describe('External URL for a menu item when the backend supports external links.'),
  order: z.number().optional().default(0).describe('Display order'),
  isEnabled: z.boolean().optional().default(true).describe('Enable menu'),
  description: z.string().optional().describe('Menu description'),
  permission: z.string().optional().describe('Optional menu visibility permission JSON object string, e.g. {"or":[{"route":"/reports","methods":["GET"]}]}'),
}, async (data) => {
  const body = { ...data };
  if (body.permission !== undefined) {
    body.permission = parseJsonArg(body.permission);
    if (!body.permission || typeof body.permission !== 'object' || Array.isArray(body.permission)) {
      throw new Error('permission must be a JSON object string.');
    }
  }
  if (body.path && !body.path.startsWith('/')) {
    body.path = '/' + body.path;
  }
  const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_menu', { method: 'POST', body: JSON.stringify(body) });
  const created = firstDataRecord(result);
  return { content: [{ type: 'text', text: `Menu created (ID: ${getId(created)}):\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool(
  'create_extension',
  [
    'Create an extension (Vue SFC page, widget, or global shell extension). Code must be Vue SFC: <template>...</template> + <script setup>...</script> — NO imports, use globals (ref, useToast, useApi, UButton, etc).',
    'For type=page: create menu first (create_menu), get id, then pass menuId. For type=widget: no menu, embed via <Widget>. For type=global: no menu, the Enfyra admin UI mounts it invisibly at shell level for registries/realtime. Server auto-compiles and should emit realtime reload to open Enfyra admin tabs. See extension rules in MCP instructions.',
  ].join(' '),
  {
    name: z.string().describe('Extension name (unique)'),
    type: z.enum(['page', 'widget', 'global']).describe('Extension type: page = full page linked to menu; widget = embed via Widget component; global = shell-level lifecycle component'),
    code: z.string().describe('Vue SFC string — <template> + <script setup>, NO import statements'),
    menuId: z.string().optional().describe('Required for type=page — enfyra_menu id from create_menu. Omit for widget/global'),
    isEnabled: z.boolean().optional().default(true).describe('Enable extension'),
    description: z.string().optional().describe('Extension description'),
    version: z.string().optional().default('1.0.0').describe('Extension version'),
  },
  async (data) => {
    const body = { ...data };
    if (body.type === 'page' && !body.menuId) {
      throw new Error('menuId is required for type=page. Create or find a enfyra_menu record first.');
    }
    if (body.type !== 'page' && body.menuId) {
      throw new Error('menuId is only valid for type=page. Omit menuId for widget/global extensions.');
    }
    if (body.menuId) {
      body.menu = { id: body.menuId };
      delete body.menuId;
    }
    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_extension', { method: 'POST', body: JSON.stringify(body) });
    const created = firstDataRecord(result);
    return { content: [{ type: 'text', text: `Extension created (ID: ${getId(created)}). Open Enfyra admin tabs should update through the realtime reload contract.\n${JSON.stringify(result, null, 2)}` }] };
  },
);

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.error('Starting Enfyra MCP Server...');
  console.error(`API URL: ${ENFYRA_API_URL}`);
  console.error(`Auth: ${ENFYRA_API_TOKEN ? 'API token configured' : 'Not configured'}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Enfyra MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
