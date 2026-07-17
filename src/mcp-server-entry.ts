/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { config } from 'dotenv';
config();

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';

// Configuration
const ENFYRA_API_URL = process.env.ENFYRA_API_URL || 'http://localhost:3000/api';
const ENFYRA_API_TOKEN = process.env.ENFYRA_API_TOKEN || '';
const DISCOVERY_FETCH_TIMEOUT_MS = 12000;

type AnyRecord = Record<string, any>;
type MethodPatchBody = {
  buttonColor?: string;
  textColor?: string;
  name?: string;
};
type RouteCreateBody = {
  path: string;
  isEnabled: boolean;
  description: string;
  availableMethods: any;
  mainTable?: { id: any };
  publicMethods?: any;
};
type RouteHandlerBody = {
  route: { id: string | number };
  method: { id: any };
  sourceCode: string;
  scriptLanguage: 'javascript' | 'typescript';
  timeout?: number;
};

function asNonEmptyStringTuple(values: string[], label: string): [string, ...string[]] {
  if (!values.length) {
    throw new Error(`${label} must include at least one value.`);
  }
  return values as [string, ...string[]];
}

function bulkObjectArrayParam(z, label: string) {
  return z.array(z.record(z.any())).describe(`${label} as a native JSON array of objects. Pass one object in the array for a single mutation.`);
}

function jsonObjectParam(z, label: string) {
  return z.record(z.any()).describe(`${label} as a native JSON object. Do not JSON.stringify this value.`);
}

function normalizeSortParam(sort?: string) {
  if (!sort) return sort;
  return sort
    .split(',')
    .map((item) => item.trim().replace(/^(['"])(.*)\1$/u, '$2'))
    .filter(Boolean)
    .join(',');
}

function normalizeFieldSelection(fields?: string[]) {
  return (fields || [])
    .flatMap((field) => String(field).split(','))
    .map((field) => field.trim())
    .filter(Boolean);
}

function assertExtensionReadFields(tableName: string, fields?: string[]) {
  if (tableName !== 'enfyra_extension') return;
  const requestedFields = normalizeFieldSelection(fields);
  const requestsSourceCode = requestedFields.some((field) => field === 'sourceCode' || field.endsWith('.sourceCode'));
  if (!requestsSourceCode) return;
  throw new Error([
    'enfyra_extension stores editable Vue SFC extension source in `code`, not `sourceCode`.',
    '`sourceCode` belongs to dynamic server script records such as handlers, hooks, flow steps, websocket handlers, OAuth provider provisioning, and bootstrap scripts.',
    'For admin UI lookup, use search_admin_extensions(mode="search") then search_admin_extensions(mode="inspect").',
    'For focused extension edits, use patch_extension_code or update_extension_code.',
    'If you intentionally read raw extension records, request fields such as ["id","name","type","version","code"].',
  ].join(' '));
}

// Import modules
import { exchangeApiToken, refreshAccessToken, getValidToken, resetTokens, getTokenExpiry, initAuth } from './lib/auth.js';
import { fetchAPI, validateFilter, validateTableName } from './lib/fetch.js';
import {
  fetchMetadataContext,
  fetchMetadataTables,
  fetchTableCatalog,
  fetchTableMetadata,
  fetchTableMetadataByRef,
} from './lib/metadata-client.js';
import { buildMcpServerInstructions, buildGraphqlUrls } from './lib/mcp-instructions.js';
import { getExamples, listExampleCategories } from './lib/mcp-examples.js';
import { WORKFLOW_SURFACES, discoverWorkflowRoutes } from './lib/tool-routing.js';
import { getSupportedColumnTypesFromMetadata, registerTableTools } from './lib/table-tools.js';
import { registerPlatformOperationTools, validateExtensionCode } from './lib/platform-operation-tools.js';
import { registerRuntimeZoneTools } from './lib/runtime-zone-tools.js';
import { registerDynamicRepositoryBuilder } from './lib/dynamic-repository-builder.js';
import { assertCreateHandlerRouteBoundary } from './lib/dynamic-endpoint-contract.js';
import { assertGenericRecordMutationAllowed, parseRecordBatchData, parseRecordData, prepareRecordBatchMutation, prepareRecordMutation, validatePortableScriptSource, validateScriptSourceIfPresent } from './lib/mutation-guards.js';
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
} from './lib/required-knowledge.js';
import { validateMainTableRoutePath } from './lib/route-guards.js';
import { buildDeletePostcondition, buildQuerySchemaReceipt } from './lib/record-contracts.js';
import { installColumnarToolFormatter, jsonContent } from './lib/response-format.js';
import { startMcpUsageTelemetry } from './lib/mcp-usage-telemetry.js';
import { startRuntimeCacheSocket } from './lib/runtime-cache-socket.js';
import { executeSequentialBatch } from './lib/sequential-batch.js';
import { compactSourceFields, readSourceArtifactResource, writeSourceArtifact } from './lib/source-artifacts.js';
import { installToolsetFilter, normalizeDynamicToolPacks, normalizeMcpProfile, normalizeMcpToolset, summarizeToolsetForInstructions } from './lib/toolset-filter.js';
import { installToolAnnotations } from './lib/tool-contracts.js';
import { installToolOutputContracts } from './lib/tool-output-contracts.js';
import { registerToolCatalogTools } from './lib/tool-catalog.js';
import { registerWorkflowToolPack } from './lib/workflow-tool-packs.js';
import type { ToolAvailability } from './lib/types.js';
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
const MCP_TOOLSET = normalizeMcpToolset(process.env.ENFYRA_MCP_TOOLSET);
const MCP_PROFILE = normalizeMcpProfile(process.env.ENFYRA_MCP_PROFILE);
const MCP_DYNAMIC_TOOLS = normalizeDynamicToolPacks(process.env.ENFYRA_MCP_DYNAMIC_TOOLS, MCP_TOOLSET, MCP_PROFILE);

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
    workflow: 'Enable per table through enfyra_graphql or update_tables graphqlEnabled. GraphQL table data requires Bearer auth; anonymous root or schema probes may return 200 without exposing table data.',
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

const DEFAULT_ME_PERMISSION_FIELDS = [
  'id',
  'email',
  'isRootAdmin',
  'role.id',
  'role.name',
  'role.routePermissions.id',
  'role.routePermissions.isEnabled',
  'role.routePermissions.methods.id',
  'role.routePermissions.methods.name',
  'role.routePermissions.route.id',
  'role.routePermissions.route.path',
  'role.routePermissions.allowedUsers.id',
  'allowedRoutePermissions.id',
  'allowedRoutePermissions.isEnabled',
  'allowedRoutePermissions.methods.id',
  'allowedRoutePermissions.methods.name',
  'allowedRoutePermissions.route.id',
  'allowedRoutePermissions.route.path',
  'allowedRoutePermissions.allowedUsers.id',
];

const MCP_PERMISSION_REQUIREMENTS = [
  {
    area: 'script validation',
    tools: ['validate_dynamic_script', 'create_handler', 'create_pre_hook', 'create_post_hook', 'patch_script_source', 'update_script_source', 'ensure_script_flow_step', 'ensure_condition_flow_step', 'ensure_websocket_event'],
    route: '/admin/script/validate',
    methods: ['POST'],
  },
  {
    area: 'flow and websocket test runner',
    tools: ['run_admin_test', 'test_flow_step'],
    route: '/admin/test/run',
    methods: ['POST'],
  },
  {
    area: 'manual flow trigger',
    tools: ['trigger_flow'],
    route: '/admin/flow/trigger/:id',
    methods: ['POST'],
  },
  {
    area: 'route cache reload',
    tools: ['reload_routes', 'enable_route', 'disable_route', 'delete_route', 'public_route_methods', 'private_route_methods', 'add_route_methods', 'replace_route_methods', 'remove_route_methods', 'ensure_route_access'],
    route: '/admin/reload/routes',
    methods: ['POST'],
  },
  {
    area: 'menu reorder',
    tools: ['reorder_menus'],
    route: '/admin/menu/reorder',
    methods: ['POST'],
  },
  {
    area: 'metadata cache reload',
    tools: ['reload_metadata'],
    route: '/admin/reload/metadata',
    methods: ['POST'],
  },
  {
    area: 'GraphQL cache reload',
    tools: ['reload_graphql', 'set_table_graphql'],
    route: '/admin/reload/graphql',
    methods: ['POST'],
  },
  {
    area: 'full cache reload',
    tools: ['reload_all'],
    route: '/admin/reload',
    methods: ['POST'],
  },
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
  'enfyra_oauth_config',
  'enfyra_bootstrap_script',
] as const;
const SCRIPT_BACKED_TABLE_SET = new Set(SCRIPT_BACKED_TABLES);

const SCRIPT_SOURCE_FIELDS = [
  'sourceCode',
  'handlerScript',
  'connectionHandlerScript',
  'code',
];

function getPrimaryColumn(table) {
  return (table?.columns || []).find((column) => column.isPrimary) || null;
}

function getMetadataDatabaseContext(metadata) {
  const dbType = metadata?.dbType || metadata?.data?.dbType || null;
  return {
    dbType,
    backendFamily: dbType === 'mongodb' ? 'mongodb' : dbType ? 'sql' : 'unknown',
    primaryKeyConvention: dbType === 'mongodb' ? '_id' : dbType ? 'id' : null,
    source: dbType ? 'GET /metadata' : 'unavailable',
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

function normalizePermissionRoute(routePath) {
  const value = String(routePath || '').trim();
  return value.startsWith('/') ? value : `/${value}`;
}

function methodNames(permission) {
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

function summarizePermissionProfile(user) {
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

async function resolveCatalogToolAvailability(toolNames: string[]): Promise<Record<string, ToolAvailability>> {
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

function parseJsonArg(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function stringifyJsonArg(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function applyDeepFieldSelections(fields, deep) {
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
  return summarizeTable(await fetchTableMetadata(ENFYRA_API_URL, tableName));
}

async function getPrimaryFieldName(tableName, table = null) {
  const resolvedTable = table ?? await getTableSummary(tableName);
  if (resolvedTable?.primaryKey) return resolvedTable.primaryKey;
  const metadata = await fetchMetadataContext(ENFYRA_API_URL);
  return metadata.dbType === 'mongodb' ? '_id' : 'id';
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
    .filter(([, result]) => (result as AnyRecord)?.error)
    .map(([name, result]) => ({ name, error: (result as AnyRecord).error }));
}

async function getMetadataTables(tableRef?: unknown) {
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

async function prepareGenericMutation(tableName, data) {
  const { tables } = await getMetadataTables(tableName);
  return prepareRecordMutation({
    fetchAPI,
    apiUrl: ENFYRA_API_URL,
    tables,
    tableName,
    data,
  });
}

async function prepareGenericBatchMutation(tableName, records) {
  const { tables } = await getMetadataTables(tableName);
  return prepareRecordBatchMutation({
    fetchAPI,
    apiUrl: ENFYRA_API_URL,
    tables,
    tableName,
    records,
  });
}

function assertKnowledgeForGenericMutation(tableName, data, { knowledgeAckKey, extensionKnowledgeAckKey }) {
  const payload = parseRecordData(data);
  assertDynamicCodeKnowledgeAckIf(SCRIPT_BACKED_TABLE_SET.has(tableName) && typeof payload.sourceCode === 'string', knowledgeAckKey);
  assertExtensionKnowledgeAckIf(tableName === 'enfyra_extension' && typeof payload.code === 'string', extensionKnowledgeAckKey);
}

function assertKnowledgeForGenericBatchMutation(tableName, records, { knowledgeAckKey, extensionKnowledgeAckKey }) {
  const payloads = parseRecordBatchData(records);
  for (const payload of payloads) {
    assertDynamicCodeKnowledgeAckIf(SCRIPT_BACKED_TABLE_SET.has(tableName) && typeof payload.sourceCode === 'string', knowledgeAckKey);
    assertExtensionKnowledgeAckIf(tableName === 'enfyra_extension' && typeof payload.code === 'string', extensionKnowledgeAckKey);
  }
}

function parseBulkItemsArg(name, value) {
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

function assertMaxBulkItems(name, items, maxItems) {
  if (items.length > maxItems) {
    throw new Error(`${name} received ${items.length} items, above maxItems=${maxItems}. Split the batch deliberately.`);
  }
}

function assertNoDuplicateBulkIds(name, items) {
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

async function validateExtensionCodeForGenericMutation(tableName, payload, fallbackName) {
  if (tableName !== 'enfyra_extension' || typeof payload?.code !== 'string') return null;
  return validateExtensionCode(ENFYRA_API_URL, payload.code, payload.name || fallbackName);
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

function scriptTraceFields(tableName) {
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
    instructions: buildMcpServerInstructions(ENFYRA_API_URL, {
      toolsetSummary: summarizeToolsetForInstructions(MCP_TOOLSET, MCP_PROFILE, MCP_DYNAMIC_TOOLS),
    }),
  },
);
installToolOutputContracts(server);
installColumnarToolFormatter(server);
const toolsetState = installToolsetFilter(server, MCP_TOOLSET, MCP_PROFILE, { dynamic: MCP_DYNAMIC_TOOLS });
installToolAnnotations(server);
startMcpUsageTelemetry(ENFYRA_API_URL, `${MCP_TOOLSET}:${MCP_PROFILE}`);
server.registerResource(
  'enfyra-source-artifact',
  new ResourceTemplate('enfyra-source://artifact/{artifactId}', { list: undefined }),
  {
    title: 'Enfyra source artifact',
    description: 'Process-scoped source or diff artifact created by an Enfyra MCP inspect or preview tool.',
    mimeType: 'text/plain',
  },
  async (uri) => ({ contents: [readSourceArtifactResource(uri.href)] }),
);

// ============================================================================
// METADATA TOOLS
// ============================================================================

server.tool(
  'get_enfyra_required_knowledge',
  [
    'Return required Enfyra knowledge and acknowledgement keys for MCP code-writing tools.',
    'Call this before creating or updating dynamic server code or Enfyra extension code. Read the returned contracts and pass the matching ack key into write tools.',
    'Pass scope to only load rules for the current task domain: "schema" (table/data/route/permission/guard work), "dynamic-code" (handler/hook/websocket/resolver scripts), "extension" (admin UI/menu/shell), or "flow". Omitting scope returns all rules.',
  ].join(' '),
  {
    scope: z.enum(['full', 'schema', 'dynamic-code', 'extension', 'flow']).optional().describe('Limit knowledge to one domain. Use full or omit scope to load all rules.'),
  },
  async ({ scope }) => {
    const payload = buildRequiredKnowledgePayload(scope);
    const sessionAcknowledgement = acknowledgeRequiredKnowledge(scope);
    return jsonContent({ ...payload, sessionAcknowledgement });
  },
);

server.tool('get_all_metadata', 'Get a lightweight table catalog. Use get_table_metadata or inspect_table to fetch one table schema.', {
  includeFull: z.boolean().optional().default(false).describe('Fetch per-table metadata for the selected catalog entries. Default false keeps discovery lightweight.'),
  search: z.string().optional().describe('Optional table-name/alias substring filter.'),
  limit: z.number().optional().describe('Maximum tables returned after search. Default 30.'),
  all: z.boolean().optional().default(false).describe('Return every matched table summary. Use when a complete table list is required.'),
}, async ({ includeFull, search, limit, all }) => {
  if (all && limit !== undefined) {
    throw new Error('get_all_metadata accepts either all=true or limit, not both.');
  }
  const [context, catalog] = await Promise.all([
    fetchMetadataContext(ENFYRA_API_URL),
    fetchTableCatalog(ENFYRA_API_URL),
  ]);
  const q = search?.trim().toLowerCase();
  const matched = catalog.filter((table) => !q || [table.name, table.alias, table.description]
    .some((value) => String(value || '').toLowerCase().includes(q)));
  const outputLimit = all ? matched.length : (limit || 30);
  const selected = matched.slice(0, outputLimit);
  const payload = {
    context,
    tableCount: catalog.length,
    matchedTableCount: matched.length,
    returnedTableCount: selected.length,
    complete: all || outputLimit >= matched.length,
    hardCap: all ? null : outputLimit,
    search: search || null,
    tables: includeFull
      ? await fetchMetadataTables(ENFYRA_API_URL, selected)
      : selected.map((table) => ({
          id: table.id ?? table._id,
          name: table.name,
          alias: table.alias ?? null,
          description: table.description ?? null,
          isSingleRecord: table.isSingleRecord ?? null,
          detailHint: `Use get_table_metadata({ tableName: "${table.name}" }) for columns and relations.`,
        })),
    detailHint: includeFull
      ? 'Full permission-projected metadata was fetched per selected table.'
      : 'Catalog only. Call get_table_metadata({ tableName }) or inspect_table({ tableName }) for schema detail.',
  };
  return jsonContent(payload);
});

server.tool('get_table_metadata', 'Get concise metadata for a specific table by name', {
  tableName: z.string().describe('Table name (e.g., "enfyra_user", "enfyra_route")'),
  includeFull: z.boolean().optional().default(false).describe('Return full raw table metadata. Default false to keep MCP context small.'),
}, async ({ tableName, includeFull }) => {
  const table = await fetchTableMetadata(ENFYRA_API_URL, tableName);
  const payload = includeFull
    ? { data: table, ...await fetchMetadataContext(ENFYRA_API_URL) }
    : {
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
    category: z.enum(asNonEmptyStringTuple(listExampleCategories().map((item) => item.key), 'Example categories')).optional().describe('Example category key. Omit to list categories.'),
  },
  async ({ category }) => {
    const result = getExamples(category);
    return jsonContent(result);
  },
);

server.tool(
  'discover_enfyra_workflows',
  [
    'Progressive-disclosure router for the Enfyra MCP tool surface.',
    'Call this when the task intent is clear but the right Enfyra tool path is not.',
    'Returns matched workflows, first tools, required acknowledgement keys, verification tools, and avoidTools negative-routing boundaries.',
  ].join(' '),
  {
    intent: z.string().optional().describe('Plain-language task goal, e.g. "add a menu chip when support tickets arrive".'),
    surface: z.enum(WORKFLOW_SURFACES).optional().describe('Known surface when the caller can classify the task. Omit to infer from intent.'),
    risk: z.string().optional().default('unknown').describe('Highest expected operation risk. Preferred values: read, write, destructive, debug, unknown. Natural terms such as low, medium, or high are accepted and normalized.'),
    detail: z.enum(['summary', 'plan', 'full']).optional().default('summary').describe('summary lists candidate workflows; plan adds tool sequence and avoidTools; full also includes matching keywords.'),
    limit: z.number().int().positive().max(10).optional().default(5).describe('Maximum workflows to return.'),
  },
  async (input) => jsonContent(discoverWorkflowRoutes(input, MCP_PROFILE, MCP_DYNAMIC_TOOLS)),
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
    const tableCatalogResult = await discoveryFetch('/enfyra_table?fields=id,name,alias,description,isSingleRecord&limit=0&sort=name');
    const routesResult = await discoveryFetch('/enfyra_route?fields=path,mainTable.name,availableMethods.*,publicMethods.*&limit=1000');
    const methodsResult = await discoveryFetch('/enfyra_method?limit=100');
    const columnMetadata = await discoveryFetch('/metadata/enfyra_column', { fallbackData: null });
    const relationMetadata = await discoveryFetch('/metadata/enfyra_relation', { fallbackData: null });
    const tableMetadata = await discoveryFetch('/metadata/enfyra_table', { fallbackData: null });
    const graphqlMetadata = await discoveryFetch('/metadata/enfyra_graphql', { fallbackData: null });

    const tables = unwrapData(tableCatalogResult);
    const tableNames = tables.map((table) => table?.name).filter(Boolean).sort();
    const routes = summarizeRoutes(routesResult);
    const routeTables = new Set(routes.map((route) => route.mainTable).filter(Boolean));
    const noRouteTables = tableNames.filter((name) => !routeTables.has(name));
    const relationTable = relationMetadata?.data || null;
    const tableDefinition = tableMetadata?.data || null;
    const gqlDefinition = graphqlMetadata?.data || null;
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
      partialErrors: collectPartialErrors({ metadata, tableCatalogResult, routesResult, methodsResult, columnMetadata, relationMetadata, tableMetadata, graphqlMetadata }),
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
        canonicalCrudTools: 'query_table reads route-backed tables. create_records/update_records/delete_records are the only generic write tools; pass native arrays even for one item. They preflight arrays and run sequentially.',
        customRouteWorkflow: 'For a new endpoint use create_route without mainTableId, then create_handler/create_pre_hook/create_post_hook. Do not create a table just to get a path.',
        routeSamples: sample(routes, 25),
        detailHint: 'Use get_all_routes({ search, limit }) or inspect_route({ path }) for route details. Use inspect_table({ tableName }) for table detail.',
      },
      schemaManagement: {
        createTable: 'POST /enfyra_table supports isSingleRecord at create time. MCP create_tables accepts a native array, creates tables/columns sequentially, then creates requested relations after all tables in the batch exist. It does not accept alias at create time; table name drives the default route/schema behavior.',
        updateTable: 'PATCH /enfyra_table/:id is the canonical path for table property changes and column/relation schema changes.',
        columns: 'enfyra_column has no REST route; use create_tables/create_columns/update_columns/delete_columns. Use liveColumnTypes below; do not invent SQL dialect names.',
        liveColumnTypes: getSupportedColumnTypesFromMetadata(columnMetadata),
        columnTypeGuidance: 'Use varchar for short strings, text/richtext for long prose, float for price/amount/rating/decimal-like values unless decimal is listed, simple-json for structured objects/arrays only when listed, and relations instead of *_id columns for links.',
        relations: routeTables.has('enfyra_relation')
          ? 'enfyra_relation has a REST route for reads/metadata, but canonical schema migration is create_relations/delete_relations or enfyra_table PATCH with the full relations array. Relation onDelete accepts CASCADE, SET NULL, or RESTRICT.'
          : 'Use create_relations/delete_relations or enfyra_table PATCH with the full relations array. Relation onDelete accepts CASCADE, SET NULL, or RESTRICT.',
        relationCascadeFkContract: 'Do not ask for or send physical FK/junction column names in relation create/update payloads. Enfyra derives fk/junction columns from relation propertyName/table metadata and hides FK columns from app schema/forms. Use targetTable, type, propertyName, inversePropertyName or mappedBy, isNullable, onDelete. Add inversePropertyName only when a concrete response, UI, deep query, aggregate sort/count, or parent-to-child traversal will use the reverse field.',
        tableDefinitionRelations: (tableDefinition?.relations || []).map((rel) => rel.propertyName),
        relationDefinitionRelations: (relationTable?.relations || []).map((rel) => rel.propertyName),
      },
      adminTesting: {
        runAdminTest: 'run_admin_test wraps POST /admin/test/run for flow_step, websocket_event, and websocket_connection scripts.',
        testFlowStep: 'test_flow_step also wraps POST /admin/test/run with kind=flow_step.',
        triggerFlow: 'trigger_flow resolves a saved enabled flow, then wraps POST /admin/flow/trigger/:id. Use test_flow_step for disabled flows.',
      },
      graphql: {
        endpoint: `${ENFYRA_API_URL.replace(/\/$/, '')}/graphql`,
        schemaEndpoint: `${ENFYRA_API_URL.replace(/\/$/, '')}/graphql-schema`,
        enablement: 'A table appears in GraphQL when enfyra_graphql has an enabled row for that table. REST route availableMethods does not enable GraphQL.',
        auth: 'GraphQL table data requires Authorization: Bearer <accessToken>; REST publicMethods do not make GraphQL table data anonymous. Anonymous root/schema probes may still return 200.',
        management: routeTables.has('enfyra_graphql')
          ? 'Use update_tables graphqlEnabled or create_records/update_records on enfyra_graphql, then reload_graphql if needed.'
          : 'Use update_tables graphqlEnabled, then reload_graphql if needed.',
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
    'Reports exact database type, the derived primary-key convention, route/cache/admin surfaces, and active metadata-backed runtime areas. Run broad discovery tools sequentially; do not call multiple broad discovery tools in parallel.',
  ].join(' '),
  {},
  async () => {
    const metadata = await discoveryFetch('/metadata');
    const tableCatalogResult = await discoveryFetch('/enfyra_table?fields=id,name,alias,description,isSingleRecord&limit=0&sort=name');
    const routesResult = await discoveryFetch('/enfyra_route?fields=path,mainTable.name,availableMethods.*,publicMethods.*,isEnabled&limit=1000');
    const methodsResult = await discoveryFetch('/enfyra_method?limit=100');
    const gqlResult = await discoveryFetch('/enfyra_graphql?limit=1000');
    const flowsResult = await discoveryFetch('/enfyra_flow?limit=1000');
    const websocketResult = await discoveryFetch('/enfyra_websocket?limit=1000');
    const storageResult = await discoveryFetch('/enfyra_storage_config?limit=1000');
    const settingsResult = await discoveryFetch('/enfyra_setting?limit=1000');
    const meResult = await discoveryFetch('/me', { fallbackData: null });

    const tables = unwrapData(tableCatalogResult);
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
        tableCatalogResult,
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
      database: getMetadataDatabaseContext(metadata),
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
        metadata?.dbType || metadata?.data?.dbType ? null : 'Exact database type was unavailable from GET /metadata.',
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
    const primaryKey = table ? getPrimaryColumn(table)?.name || null : null;
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
      countPattern: `For counts, query only fields=${primaryKey || '<primary-key>'} with limit=1 and request meta. Use meta=totalCount without a filter, or meta=filterCount when a filter is supplied. MCP count_records resolves the live table primary key and wraps this pattern.`,
      security: 'Filters, sorts, counts, and aggregate values can leak information even when a field is not selected. In generated public/user-facing APIs, do not filter, sort, count, or aggregate unpublished fields or private relations unless the endpoint intentionally exposes that fact.',
      deep: {
        shape: '{ [relationName]: { fields?, filter?, sort?, limit?, page?, deep? } }',
        mcpFieldProjection: 'query_table auto-adds missing top-level deep relation names to fields unless fields are in exclude mode, so the nested relation can appear in the response.',
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
        relationCascadeFkContract: 'When creating relations through create_tables/create_relations/enfyra_table PATCH, never provide fkCol/fkColumn/foreignKeyColumn/sourceColumn/targetColumn/junction*Column. These are physical implementation details derived by Enfyra and hidden from app schema/forms. Add inversePropertyName only for a concrete reverse traversal such as parent deep child lists, response fields, UI sections, or aggregate sort/count.',
        graphql: 'GraphQL query args also accept filter/sort/page/limit. Table data requires Bearer auth and table enablement via enfyra_graphql; anonymous root/schema probes may still return 200.',
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
        logging: '@LOGS is a callable function. Use @LOGS(message, details?) such as @LOGS("Approval requested", { requestId }); do not use @LOGS.info, @LOGS.warn, @LOGS.error, or @LOGS.debug.',
        socket: {
          contract: '@SOCKET has no generic emit() method.',
          boundWebsocketMethods: ['reply(event, data)', 'join(room)', 'leave(room)', 'emitToCurrentRoom(room, event, data)', 'broadcastToRoom(room, event, data)', 'disconnect()'],
          globalMethods: ['emitToGateway(path, event, data)', 'emitToRoom(path, room, event, data)', 'emitToUser(userId, event, data)', 'broadcast(event, data)', 'roomSize(room)'],
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
        throws: '@THROW maps to $ctx.$throw. Numeric helpers are raw HTTP message helpers: @THROW400(message), @THROW404(message), @THROW409(message), @THROW422(message, detailsObject?), @THROW500(message). Numeric helper details must be an object/array, e.g. @THROW404("Project not found", { id }); do not use @THROW404("Project", id) as a semantic shortcut. Use @THROW.http(status, message, details?) for dynamic status codes. Use @THROW.notFound(resource, id?) and @THROW.duplicate(resource, field, value) only when you intentionally want Enfyra-formatted semantic messages.',
        helpers: {
          core: '$ctx.$helpers includes $bcrypt.hash/compare, autoSlug(text), $fetch, $sleep(ms) capped by the runtime, and $crypto. HTTP and GraphQL contexts also expose $jwt through $ctx.$helpers. Every helper method crosses the async executor bridge: await its result before property access, interpolation, concatenation, or persistence.',
          fetch: '@FETCH maps to $ctx.$helpers.$fetch for outbound HTTP calls from server scripts. Keep secrets in encrypted fields instead of embedding them in sourceCode.',
          crypto: '$ctx.$helpers.$crypto exposes bounded runtime crypto helpers: randomUUID(), randomBytes(size, encoding), sha256(value, encoding), hmacSha256(value, secret, encoding), and generateSshKeyPair(comment). Await every call, including helpers whose host implementation is synchronous, for example const id = await @HELPERS.$crypto.randomUUID(). Use generateSshKeyPair for SSH key material. Do not use legacy $ctx.$helpers.$ssh.',
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
          data: ['@BODY', '@QUERY', '@PARAMS', '@USER', '@REQ', '@RES when response streaming is available', '@UPLOADED_FILE for multipart request file metadata', '@REPOS.main secure route main table repo', '#table_name / @REPOS.<table> explicit table repo with trusted projection discipline', '@CACHE', '@HELPERS', '@FETCH', '@STORAGE', '@PKGS', '@SOCKET global emit helpers/roomSize', '@TRIGGER'],
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
        oauthUserProvisioning: {
          runs: 'Before a new OAuth identity creates its enfyra_user row.',
          data: ['@REPOS.main scoped to enfyra_user', '@HELPERS', '@FETCH', '@STORAGE', '@CACHE'],
          resultBehavior: 'Return a plain object of additional user fields. Provider identity fields are merged afterward and take precedence. The script has no authenticated @USER and should not return a user response.',
        },
        graphqlResolver: {
          runs: 'Generated GraphQL resolver delegates to dynamic repo/query services.',
          data: ['GraphQL request context', 'Bearer auth user', 'dynamic repositories'],
          caveat: 'REST publicMethods do not make GraphQL table data anonymous.',
        },
        extensionVueSfc: {
          runs: 'Frontend extension code, not server sandbox.',
          data: ['Vue/Nuxt composables', 'Enfyra composables', 'auto-resolved UI components'],
          caveat: 'No import statements; save as enfyra_extension Vue SFC record.',
        },
      },
      helpers: {
        repos: {
          scopes: '$repos.main is the secure repository for the route main table and preserves normal route query behavior. For explicit user-facing table access, use #secure.table_name or @REPOS.secure.table_name so field permissions remain enforced. Reserve #table_name or @REPOS.table_name for trusted internal operations that intentionally bypass field permissions.',
          security: 'Trusted repos can bypass normal exposure boundaries, including unpublished columns and private relations. If trusted access is necessary, always request explicit fields, enforce route access plus owner/tenant/member checks, and project/sanitize the result before returning it.',
          sensitiveQuerySurface: 'Filters, sort helpers, counts, and aggregate values on unpublished fields or private relations can leak information even when the value is not selected. Do not expose aggregate, _max, _min, _count, or predicate-oracle behavior over hidden fields in generated user-facing endpoints.',
          mutationReturnShape: '$repos.<table>.create({ data }) and $repos.<table>.update({ id, data }) return a collection-shaped result: { data: [...], count? }. data is always an array for create/update, even for one created/updated record. If a script needs the single record object, it must read result.data[0] or result.data?.[0] ?? null.',
          preferredExample: 'const result = await @REPOS.main.create({ data: @BODY }); const record = result.data?.[0] ?? null; return record;',
          wrongSingleRecordAccess: 'Do not use result.data.id, do not return result.data when one object is expected, and do not assume create/update returns the bare row object.',
          countPattern: 'To count records in custom code, do not fetch full rows. Use const result = await @REPOS.main.find({ fields: "id", limit: 1, meta: filter ? "filterCount" : "totalCount", ...(filter ? { filter } : {}) }); then read result.meta.filterCount or result.meta.totalCount.',
          relationProjectionPattern: 'For repository find({ deep }) in scripts, include relation property names in top-level fields or the parent row will not expose row.<relation>. Example: await #orders.find({ fields: ["id", "customer"], deep: { customer: { fields: ["id", "email"] } }, limit: 1 }). query_table auto-adds this for MCP reads; dynamic repos do not.',
          relationFilterPattern: 'Filter relations by relation propertyName, not physical FK names. Use { incident: { id: { _eq: incident.id } } }, not { incidentId: { _eq: incident.id } }.',
        },
        socketInHttpOrFlow: 'HTTP/flow context can emitToUser/emitToRoom/emitToGateway/broadcast and roomSize, but cannot reply/join/leave/disconnect/emitToCurrentRoom/broadcastToRoom because there is no bound socket. emitToRoom requires an explicit gateway path: emitToRoom(path, room, event, data). roomSize(room) counts sockets in that room across registered gateways.',
        packages: 'Server packages installed through install_package are exposed as $ctx.$pkgs.packageName in server scripts.',
        files: 'Upload helpers are on $storage; raw create_records on enfyra_file is not equivalent to multipart upload/storage rollback. For multipart request files, pass file: @UPLOADED_FILE to @STORAGE.$upload/@STORAGE.$update so Enfyra streams from disk-backed temp storage. For progress, clients send x-enfyra-upload-id on authenticated multipart requests and listen for $system:upload:progress; $upload and blob-replacing $update do not accept onProgress. Use @STORAGE.$registerFile only when the object already exists in storage and the script should create the enfyra_file record without uploading bytes. Use buffer only for small generated files.',
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
    'Same mapping as MCP tool → HTTP: query_table=GET /table?..., create_records=sequential POST /table, update_records=sequential PATCH /table/id, delete_records=sequential DELETE /table/id.',
    'GraphQL: see graphqlHttpUrl / graphqlSchemaUrl in response; enable per table via enfyra_graphql/update_tables graphqlEnabled and send Bearer auth for table data queries. Anonymous root/schema probes may still return 200.',
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
        graphql: 'GraphQL table data requires Bearer auth; route publicMethods do not make GraphQL table data anonymous. Anonymous root/schema probes may still return 200.',
        mcp: 'This server uses admin credentials from env for tools (fetchAPI).',
      },
      pathResolution: 'Confirm route path with get_all_routes or metadata — path may not equal table name.',
      note: 'Full tool→HTTP mapping is in MCP server instructions (shown to the model at connect).',
    };
    return jsonContent(payload);
  },
);

server.tool('query_table', 'Query any route-backed table with a live metadata preflight. Explicit fields are validated before the REST read and the result includes schemaReceipt, so a separate metadata call is optional unless the schema itself must be inspected. Response is minimal unless fields is explicit. Every call must pass either limit or all=true. Use count_records or meta=filterCount/totalCount for counts; call discover_query_capabilities before using aggregate objects instead of guessing _sum/_count operators. For enfyra_extension, editable extension source is `code`, not `sourceCode`; prefer search_admin_extensions and patch_extension_code/update_extension_code for admin UI.', {
  tableName: z.string().describe('Table name to query'),
  filter: jsonObjectParam(z, 'Filter object').optional().describe('Filter object. Example: {"status": {"_eq": "active"}}.'),
  sort: z.string().optional().describe('Sort field. Prefix with - for descending (e.g., "createdAt", "-id")'),
  page: z.number().optional().describe('Page number (default: 1)'),
  limit: z.number().int().min(0).optional().describe('Items per page. Required unless all=true. Do not invent arbitrary limits for "all"; use all=true instead. Use count_records for counts.'),
  all: z.boolean().optional().default(false).describe('Return all matching rows by sending REST limit=0. Use this when the user asks for all rows or a complete list.'),
  fields: z.array(z.string()).optional().describe('Fields to select. If omitted, MCP selects only the table primary key to avoid oversized responses.'),
  meta: z.string().optional().describe('Optional REST meta request, e.g. "totalCount", "filterCount", or aggregate modes supported by the route. Use count_records for simple counts.'),
  deep: jsonObjectParam(z, 'Deep relation fetch object').optional().describe('Optional deep relation fetch object. Keys must be relation propertyName values.'),
  aggregate: jsonObjectParam(z, 'Aggregate object').optional().describe('Optional aggregate object keyed by real fields/relations, only after discover_query_capabilities confirms the supported operator shape for this table/route. Results are returned in response.meta.aggregate when supported. Do not guess _sum/_count; use count_records or meta=filterCount/totalCount for counts. Do not request aggregates over hidden fields/private relations in user-facing APIs.'),
}, async ({ tableName, filter, sort, page, limit, all, fields, meta, deep, aggregate }) => {
  if (!all && limit === undefined) {
    throw new Error('query_table requires either limit or all=true. Do not rely on implicit default page sizes.');
  }
  if (all && limit !== undefined) {
    throw new Error('query_table accepts either all=true or limit, not both.');
  }
  validateTableName(tableName);
  assertExtensionReadFields(tableName, fields);
  const filterParam = stringifyJsonArg(filter);
  const deepParam = stringifyJsonArg(deep);
  const aggregateParam = stringifyJsonArg(aggregate);
  validateFilter(filter);
  parseJsonArg(deep, undefined);
  parseJsonArg(aggregate, undefined);

  const queryParams = new URLSearchParams();
  const table = await getTableSummary(tableName);
  const primaryKey = await getPrimaryFieldName(tableName, table);
  const requestedFields = fields && fields.length > 0 ? fields : [primaryKey];
  const deepFieldSelection = applyDeepFieldSelections(requestedFields, deep);
  const selectedFields = deepFieldSelection.fields;
  const schemaReceipt = buildQuerySchemaReceipt({ ...table, primaryKey }, selectedFields);
  if (filterParam) queryParams.set('filter', filterParam);
  const normalizedSort = normalizeSortParam(sort);
  if (normalizedSort) queryParams.set('sort', normalizedSort);
  if (page) queryParams.set('page', String(page));
  if (meta) queryParams.set('meta', meta);
  if (deepParam) queryParams.set('deep', deepParam);
  if (aggregateParam) queryParams.set('aggregate', aggregateParam);
  const effectiveLimit = all ? 0 : limit;
  queryParams.set('limit', String(effectiveLimit));
  queryParams.set('fields', selectedFields.join(','));

  const query = queryParams.toString();
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}${query ? `?${query}` : ''}`);
  const payload = {
    statusCode: result?.statusCode,
    success: result?.success,
    tableName,
    requestedFields,
    fields: selectedFields,
    autoAddedDeepFields: deepFieldSelection.autoAdded,
    limit: effectiveLimit,
    all: !!all,
    queryOptions: {
      meta: meta || null,
      deep: deep ? parseJsonArg(deep, null) : null,
      aggregate: aggregate ? parseJsonArg(aggregate, null) : null,
    },
    minimalDefaultApplied: !(fields && fields.length > 0),
    schemaReceipt,
    meta: result?.meta,
    data: compactSourceFields(result?.data || [], { tableName }),
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
	    filter: jsonObjectParam(z, 'Filter object').optional().describe('Optional Query DSL filter object. Example: {"status":{"_eq":"active"}}.'),
	  },
	  async ({ tableName, filter }) => {
	    validateTableName(tableName);
	    validateFilter(filter);
	    const filterParam = stringifyJsonArg(filter);
	
	    const metaField = filterParam ? 'filterCount' : 'totalCount';
    const queryParams = new URLSearchParams();
    queryParams.set('fields', 'id');
    queryParams.set('limit', '1');
    queryParams.set('meta', metaField);
	    if (filterParam) queryParams.set('filter', filterParam);

    const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}?${queryParams.toString()}`);
    const meta = result?.meta || {};
    const hasCount = Object.prototype.hasOwnProperty.call(meta, metaField);
    const count = hasCount ? Number(meta[metaField]) : null;
    const payload = {
      tableName,
      count,
      countField: metaField,
	      filterApplied: !!filterParam,
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
  'Find a single record by ID or filter. By ID uses GET with filter (Enfyra has no GET /table/:id route). For enfyra_extension, editable extension source is `code`, not `sourceCode`; prefer search_admin_extensions and patch_extension_code/update_extension_code for admin UI.',
  {
	    tableName: z.string().describe('Table name'),
	    id: z.string().optional().describe('Record ID'),
	    filter: jsonObjectParam(z, 'Filter object').optional().describe('Filter object to find by.'),
    fields: z.array(z.string()).optional().describe('Fields to select. If omitted, returns only the primary key.'),
  },
  async ({ tableName, id, filter, fields }) => {
    validateTableName(tableName);
    assertExtensionReadFields(tableName, fields);
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
        data: compactSourceFields(one, { tableName }),
        detailHint: fields && fields.length > 0 ? undefined : 'Only the primary key was returned. Pass fields for details.',
      }, null, 2) }] };
    }
	    if (!filter) throw new Error('Provide id or filter');
	    validateFilter(filter);
	    const filterParam = stringifyJsonArg(filter);
	    const queryParams = new URLSearchParams({
	      filter: filterParam || '',
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
      data: compactSourceFields(result.data?.[0] || null, { tableName }),
      detailHint: fields && fields.length > 0 ? undefined : 'Only the primary key was returned. Pass fields for details.',
    }, null, 2) }] };
  },
);

// ============================================================================
// CRUD TOOLS
// ============================================================================

server.tool('create_records', 'Create one or more route-backed records. Always pass records as a native JSON array; for one record, pass a one-item array. MCP preflights every item before the first POST, then writes sequentially; this is not a backend bulk endpoint or transaction. On a failed item, it returns the completed checkpoint and remaining indexes—retry only the remaining records after resolving the error.', {
  tableName: z.string().describe('Table name to insert into'),
  records: bulkObjectArrayParam(z, 'Records').describe('Records as a native JSON array. Each item must be a JSON object using metadata-backed column names and relation propertyName values.'),
  queryParams: z.string().optional().describe('Optional query params as JSON object string applied to every POST, for route contracts that intentionally keep workflow fields out of the validated body.'),
  maxRecords: z.number().int().min(1).max(100).optional().default(20).describe('Safety cap for one MCP batch. Default is 20; explicitly raise it up to 100 only when partial-write recovery is acceptable.'),
  globalRulesAckKey: globalRulesAckParam(z),
  knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required only when any item contains sourceCode. Use dynamicCodeAckKey from get_enfyra_required_knowledge.'),
  extensionKnowledgeAckKey: extensionKnowledgeAckParam(z).optional().describe('Required only when tableName is enfyra_extension and any item contains code. Use extensionAckKey from get_enfyra_required_knowledge.'),
}, async ({ tableName, records, queryParams, maxRecords, globalRulesAckKey, knowledgeAckKey, extensionKnowledgeAckKey }) => {
  assertGlobalRulesAck(globalRulesAckKey);
  validateTableName(tableName);
  assertGenericRecordMutationAllowed('create', tableName);
  const parsedRecords = parseRecordBatchData(records);
  if (parsedRecords.length > maxRecords) {
    throw new Error(`create_records received ${parsedRecords.length} records, above maxRecords=${maxRecords}. Split the batch deliberately.`);
  }
  assertKnowledgeForGenericBatchMutation(tableName, parsedRecords, { knowledgeAckKey, extensionKnowledgeAckKey });
  const prepared = await prepareGenericBatchMutation(tableName, parsedRecords);
  const extensionValidations = [];
  for (const item of prepared.records) {
    extensionValidations.push(await validateExtensionCodeForGenericMutation(tableName, item.payload, item.payload?.name || item.index));
  }
  const query = parseQueryParamsArg(queryParams);
  const batch = await executeSequentialBatch(prepared.records, async (item) => {
    const result = await fetchAPI(ENFYRA_API_URL, appendQuery(`/${tableName}`, query), { method: 'POST', body: JSON.stringify(item.payload) });
    return {
      index: item.index,
      ...summarizeMutationResult(result, 'created', tableName),
    };
  });
  if (batch.status === 'partial_failure') {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        action: 'create_records_partial_failure',
        tableName,
        requested: parsedRecords.length,
        createdCount: batch.completed.length,
        sequential: true,
        transactional: false,
        completed: batch.completed,
        failed: batch.failure,
        remainingIndexes: batch.remainingIndexes,
        retryHint: 'Resolve the failed item, then retry only the failed item and remaining indexes. Do not retry completed records unless the table has an idempotent unique key.',
      }, null, 2) }],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify({
    action: 'created_records',
    tableName,
    requested: parsedRecords.length,
    createdCount: batch.completed.length,
    sequential: true,
    transactional: false,
    preflight: {
      liveMetadataFieldsValidated: true,
      scriptValidatedBeforeAnyPost: prepared.records.some((item) => item.scriptValidation?.validated === true),
      extensionValidatedBeforeAnyPost: extensionValidations.some(Boolean),
    },
    created: batch.completed,
    detailHint: `Use query_table({ tableName: "${tableName}", fields: [...], limit: ${Math.min(batch.completed.length, 20)} }) to inspect created records when needed.`,
  }, null, 2) }] };
});

server.tool('update_records', 'Update one or more records in one MCP call. Pass items as a native JSON array; for one update, pass one item. MCP preflights every item, rejects duplicate ids, then PATCHes sequentially. On a failed item, it returns the completed checkpoint and remaining indexes so callers do not replay prior updates.', {
  tableName: z.string().describe('Table name'),
  items: bulkObjectArrayParam(z, 'Update items').describe('Native JSON array of update items: [{ "id": "...", "data": { ... }, "queryParams": { ... }? }]. data must use metadata-backed column names and relation propertyName values.'),
  maxItems: z.number().int().min(1).max(100).optional().default(20).describe('Safety cap for one MCP batch. Default is 20; explicitly raise it up to 100 only when partial-write recovery is acceptable.'),
  globalRulesAckKey: globalRulesAckParam(z),
  knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required only when any item.data contains sourceCode. Use dynamicCodeAckKey from get_enfyra_required_knowledge.'),
  extensionKnowledgeAckKey: extensionKnowledgeAckParam(z).optional().describe('Required only when tableName is enfyra_extension and any item.data contains code. Use extensionAckKey from get_enfyra_required_knowledge.'),
}, async ({ tableName, items, maxItems, globalRulesAckKey, knowledgeAckKey, extensionKnowledgeAckKey }) => {
  assertGlobalRulesAck(globalRulesAckKey);
  validateTableName(tableName);
  assertGenericRecordMutationAllowed('update', tableName);
  const parsedItems = parseBulkItemsArg('items', items);
  assertMaxBulkItems('update_records', parsedItems, maxItems);
  assertNoDuplicateBulkIds('update_records', parsedItems);

  const preparedItems = [];
  const extensionValidations = [];
  for (const [index, item] of parsedItems.entries()) {
    if (!item.id) throw new Error(`items[${index}].id is required.`);
    if (!item.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
      throw new Error(`items[${index}].data must be a JSON object.`);
    }
    assertKnowledgeForGenericMutation(tableName, JSON.stringify(item.data), { knowledgeAckKey, extensionKnowledgeAckKey });
    const prepared = await prepareGenericMutation(tableName, JSON.stringify(item.data));
    preparedItems.push({ index, id: item.id, queryParams: item.queryParams, prepared });
    extensionValidations.push(await validateExtensionCodeForGenericMutation(tableName, prepared.payload, item.id));
  }

  const batch = await executeSequentialBatch(preparedItems, async (item) => {
    const query = parseQueryParamsArg(JSON.stringify(item.queryParams || {}));
    const result = await fetchAPI(ENFYRA_API_URL, appendQuery(`/${tableName}/${encodeURIComponent(String(item.id))}`, query), { method: 'PATCH', body: JSON.stringify(item.prepared.payload) });
    return {
      index: item.index,
      id: item.id,
      ...summarizeMutationResult(result, 'updated', tableName),
    };
  });
  if (batch.status === 'partial_failure') {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        action: 'update_records_partial_failure',
        tableName,
        requested: parsedItems.length,
        updatedCount: batch.completed.length,
        sequential: true,
        completed: batch.completed,
        failed: batch.failure,
        remainingIndexes: batch.remainingIndexes,
        retryHint: 'Resolve the failed item, then retry only the failed item and remaining indexes. Do not replay completed updates unless the new value is deliberately idempotent.',
      }, null, 2) }],
    };
  }

  return { content: [{ type: 'text', text: JSON.stringify({
    action: 'updated_records',
    tableName,
    requested: parsedItems.length,
    updatedCount: batch.completed.length,
    sequential: true,
    duplicateIdsRejected: true,
    preflight: {
      liveMetadataFieldsValidated: true,
      scriptValidatedBeforeAnyPatch: preparedItems.some((item) => item.prepared.scriptValidation?.validated === true),
      extensionValidatedBeforeAnyPatch: extensionValidations.some(Boolean),
    },
    updated: batch.completed,
  }, null, 2) }] };
});

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

function isNotFoundDeleteError(error: unknown) {
  const message = String((error as any)?.message || error || '').toLowerCase();
  return message.includes('api error (404)')
    || message.includes('not found')
    || message.includes('not exists')
    || message.includes('does not exist');
}

server.tool('delete_records', 'Delete one or more route-backed records in one MCP call. Pass items as a native JSON array; for one delete, pass one item. The tool previews every target when confirm=false, rejects duplicate ids, and deletes sequentially when confirm=true. Confirmed deletes automatically re-read the requested primary keys and return postcondition.confirmedAbsent plus remainingIds, so a separate absence query is optional. By default, confirm=true skips records that were already removed by cascade or a previous cleanup step.', {
  tableName: z.string().describe('Table name'),
  items: bulkObjectArrayParam(z, 'Delete items').describe('Native JSON array of delete items: [{ "id": "...", "queryParams": { ... }? }].'),
  maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one MCP batch. Default/max is 100.'),
  confirm: z.boolean().optional().default(false).describe('Required true to apply destructive deletes. Omit/false returns previews only.'),
  skipNotFound: z.boolean().optional().default(true).describe('When confirm=true, continue if a target is already gone, for example because a previous delete cascaded child records. Default true.'),
  globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
}, async ({ tableName, items, maxItems, confirm, skipNotFound, globalRulesAckKey }) => {
  validateTableName(tableName);
  assertGenericRecordMutationAllowed('delete', tableName);
  const parsedItems = parseBulkItemsArg('items', items);
  assertMaxBulkItems('delete_records', parsedItems, maxItems);
  assertNoDuplicateBulkIds('delete_records', parsedItems);
  for (const [index, item] of parsedItems.entries()) {
    if (!item.id) throw new Error(`items[${index}].id is required.`);
  }

  const primaryKey = await getPrimaryFieldName(tableName);
  if (!confirm) {
    const previews = [];
    for (const [index, item] of parsedItems.entries()) {
      const query = new URLSearchParams({
        filter: JSON.stringify({ [primaryKey]: { _eq: item.id } }),
        limit: '1',
        fields: primaryKey,
      });
      const preview = await fetchAPI(ENFYRA_API_URL, `/${tableName}?${query.toString()}`).catch((error) => ({ error: String(error?.message || error) }));
      previews.push({
        index,
        id: item.id,
        preview: preview?.data?.[0] || null,
        previewError: preview?.error,
      });
    }
    return { content: [{ type: 'text', text: JSON.stringify({
      action: 'delete_records_preview',
      tableName,
      primaryKey,
      requested: parsedItems.length,
      duplicateIdsRejected: true,
      destructive: true,
      previews,
      postcondition: {
        verificationMethod: 'not_run_preview',
        requestedIds: parsedItems.map((item) => item.id),
        remainingIds: previews.filter((item) => item.preview).map((item) => item.id),
        confirmedAbsent: false,
      },
      next: 'Call delete_records again with the same items and confirm=true to delete these route-backed records sequentially.',
    }, null, 2) }] };
  }

	  assertGlobalRulesAck(globalRulesAckKey);
	  const deleted = [];
	  const skippedNotFound = [];
	  for (const [index, item] of parsedItems.entries()) {
	    const query = parseQueryParamsArg(JSON.stringify(item.queryParams || {}));
	    try {
	      const result = await fetchAPI(ENFYRA_API_URL, appendQuery(`/${tableName}/${encodeURIComponent(String(item.id))}`, query), { method: 'DELETE' });
	      deleted.push({
	        index,
	        id: item.id,
	        statusCode: result?.statusCode,
	        success: result?.success,
	      });
	    } catch (error) {
	      if (skipNotFound && isNotFoundDeleteError(error)) {
	        skippedNotFound.push({
	          index,
	          id: item.id,
	          skipped: true,
	          reason: 'not_found',
	        });
	        continue;
	      }
	      throw error;
	    }
	  }
	  const requestedIds = parsedItems.map((item) => item.id);
	  let postcondition;
	  try {
	    const verificationQuery = new URLSearchParams({
	      filter: JSON.stringify({ [primaryKey]: { _in: requestedIds } }),
	      limit: String(parsedItems.length),
	      fields: primaryKey,
	    });
	    const verification = await fetchAPI(ENFYRA_API_URL, `/${tableName}?${verificationQuery.toString()}`);
	    postcondition = buildDeletePostcondition(requestedIds, verification?.data ?? [], primaryKey);
	  } catch (error) {
	    postcondition = {
	      verificationMethod: 'route_read_by_primary_keys',
	      requestedIds,
	      remainingIds: [],
	      confirmedAbsent: false,
	      verificationError: String((error as any)?.message || error),
	    };
	  }
	  return { content: [{ type: 'text', text: JSON.stringify({
	    action: 'deleted_records',
	    tableName,
	    requested: parsedItems.length,
	    deletedCount: deleted.length,
	    skippedNotFoundCount: skippedNotFound.length,
	    sequential: true,
	    duplicateIdsRejected: true,
	    skipNotFound,
	    deleted,
	    skippedNotFound,
	    postcondition,
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
  'Create a enfyra_method record with app badge colors. Prefer this over generic create_records for enfyra_method.',
  {
    method: z.string().describe('Uppercase method name, e.g. GET, POST, PUT, CUSTOM_METHOD. Must start with A-Z and contain only A-Z, 0-9, or underscore.'),
    buttonColor: z.string().describe('Badge background color as full hex, e.g. #dbeafe.'),
    textColor: z.string().describe('Badge text color as full hex, e.g. #1d4ed8.'),
    isSystem: z.boolean().optional().default(false).describe('Set true only for built-in/runtime-owned methods. Normal app methods should leave this false.'),
    globalRulesAckKey: globalRulesAckParam(z),
  },
  async ({ method, buttonColor, textColor, isSystem, globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
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
  'Update a enfyra_method record color pair, and optionally rename non-system methods. Prefer this over generic update_records for enfyra_method.',
  {
    id: z.string().optional().describe('Method record id. If omitted, method is used to find the record.'),
    method: z.string().optional().describe('Existing method name to find, or new name when id is provided.'),
    buttonColor: z.string().optional().describe('Badge background color as full hex, e.g. #dbeafe.'),
    textColor: z.string().optional().describe('Badge text color as full hex, e.g. #1d4ed8.'),
    globalRulesAckKey: globalRulesAckParam(z),
  },
  async ({ id, method, buttonColor, textColor, globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    let targetId = id;
    let existing = null;
    if (!targetId) {
      if (!method) throw new Error('Provide id or method.');
      const normalizedMethod = normalizeMethodNameInput(method);
      existing = await findMethodRecordByName(normalizedMethod);
      if (!existing) throw new Error(`Method ${normalizedMethod} was not found.`);
      targetId = getId(existing);
    }

    const body: MethodPatchBody = {};
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
    globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
  },
  async ({ id, method, confirm, globalRulesAckKey }) => {
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
    assertGlobalRulesAck(globalRulesAckKey);
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
    'Kinds: script, flow_step, websocket_event, websocket_connection. Use this to validate dynamic script, flow, or websocket behavior before creating records.',
    'kind=script captures logs but not socket emitted calls. Use kind=websocket_event or kind=websocket_connection when emitted capture is required; admin websocket tests still do not prove a real Socket.IO client transport/handshake.',
  ].join(' '),
  {
    kind: z.enum(['script', 'flow_step', 'websocket_event', 'websocket_connection']).describe('Admin test kind'),
    body: z.string().describe('JSON body for the test. Include script and optional context for script; type/config plus payload for flow_step; or script/gatewayPath/eventName/payload for websocket tests. Do not include kind; the tool adds it.'),
  },
  async ({ kind, body }) => {
    const parsed = body ? JSON.parse(body) : {};
    const sourceCode = kind === 'flow_step'
      ? parsed?.config?.sourceCode ?? parsed?.config?.code
      : parsed?.script ?? parsed?.sourceCode;
    if (typeof sourceCode === 'string') validatePortableScriptSource(sourceCode);
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/test/run', {
      method: 'POST',
      body: JSON.stringify({ ...parsed, kind }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'test_flow_step',
  'Test a single flow step without saving it. Wraps POST /admin/test/run with kind=flow_step. Pass runtime @FLOW_PAYLOAD data through payload; the tool forwards it using the ESV test-run contract.',
  {
    type: z.enum(['script', 'condition', 'query', 'create', 'update', 'delete', 'http', 'trigger_flow', 'sleep', 'log']).describe('Flow step type'),
    config: z.string().describe('Step config as JSON string'),
    timeout: z.number().optional().describe('Timeout in ms'),
    key: z.string().optional().describe('Optional step key for mock flow context'),
    payload: z.union([z.record(z.any()), z.string()]).optional().describe('Runtime payload object exposed to the script as @FLOW_PAYLOAD. A JSON object string is accepted for compatibility.'),
    mockFlow: z.string().optional().describe('Optional advanced mockFlow JSON object for $last/$meta or other flow context. Use payload for @FLOW_PAYLOAD.'),
  },
  async ({ type, config, timeout, key, payload, mockFlow }) => {
    const parsedConfig = JSON.parse(config);
    const sourceCode = parsedConfig?.sourceCode ?? parsedConfig?.code;
    if (typeof sourceCode === 'string') validatePortableScriptSource(sourceCode);
    const parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (parsedPayload !== undefined && (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload))) {
      throw new Error('payload must be a JSON object.');
    }
    const body = {
      type,
      config: parsedConfig,
      ...(timeout ? { timeout } : {}),
      ...(key ? { key } : {}),
      ...(parsedPayload !== undefined ? { payload: parsedPayload } : {}),
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
  'Trigger an enabled saved flow by id or name. Disabled flows are not registered for execution; use test_flow_step to verify their step contract without enabling them.',
  {
    flowIdOrName: z.union([z.string(), z.number()]).describe('Flow id or name accepted by FlowService.trigger'),
    payload: z.string().optional().describe('Payload JSON object. Default {}.'),
  },
  async ({ flowIdOrName, payload }) => {
    const rawIdentifier = String(flowIdOrName);
    const filter = typeof flowIdOrName === 'number' || /^\d+$/.test(rawIdentifier)
      ? { id: { _eq: flowIdOrName } }
      : { name: { _eq: rawIdentifier } };
    const lookup = await fetchAPI(ENFYRA_API_URL, `/enfyra_flow?filter=${encodeURIComponent(JSON.stringify(filter))}&limit=1&fields=id,_id,name,isEnabled`);
    const flow = unwrapData(lookup)[0];
    if (!flow) throw new Error(`Flow not found: ${rawIdentifier}`);
    if (flow.isEnabled === false) {
      throw new Error(`Flow "${flow.name || rawIdentifier}" is disabled and is not registered for execution. Use test_flow_step to verify its saved step contract, or explicitly enable the flow before trigger_flow.`);
    }
    const flowId = flow.id ?? flow._id;
    const result = await fetchAPI(ENFYRA_API_URL, `/admin/flow/trigger/${encodeURIComponent(String(flowId))}`, {
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

async function collectRestDefinitionState(tableRef?: unknown) {
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

async function collectFeatureSearchState() {
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
    const state = await collectRestDefinitionState(tableName);
    const table = state.tables.find((item) => item?.name === tableName || item?.alias === tableName);
    if (!table) {
      throw new Error(`Unknown table "${tableName}". Use get_all_tables({ search, limit }) or get_all_metadata({ search, all: true }) to confirm the table name. If a just-created table is missing, verify the create response/reload event before calling manual reload tools.`);
    }
    const tableId = getId(table);
    const columnIds = new Set((table.columns || []).map((column) => String(getId(column))));
    const relationIds = new Set((table.relations || []).map((relation) => String(getId(relation))));
    const routes = state.routes.filter((route) => sameId(refId(route.mainTable), tableId));

    const payload = {
      table: summarizeTable(table),
      database: getMetadataDatabaseContext(state.metadata),
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
        relationMutation: 'For relation schema creation/update use targetTable/type/propertyName/inversePropertyName|mappedBy/isNullable/onDelete only. Do not provide physical FK/junction columns; Enfyra derives and hides them. Omit inversePropertyName unless a concrete response, UI, deep query, aggregate sort/count, or parent-to-child traversal needs it.',
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
    const table = route.mainTable
      ? await fetchTableMetadataByRef(ENFYRA_API_URL, refId(route.mainTable)) as AnyRecord
      : null;

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
    const state = await collectFeatureSearchState();
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
    'Do not use this for admin app page/menu routes such as /cloud/projects/:id unless inspect_route confirms an API route with that exact path.',
  ].join(' '),
  {
    method: z.string().optional().default('GET').describe('HTTP method name. Must exist in enfyra_method.name for Enfyra route-backed calls.'),
    path: z.string().describe('Enfyra API path, e.g. /enfyra_route?limit=1'),
    query: z.string().optional().describe('Optional JSON-encoded query object string, e.g. {"limit":1,"filter":{"status":{"_eq":"ready"}}}; merged onto the path query string.'),
    body: z.string().optional().describe('Optional JSON request body string, e.g. {"title":"Example"}.'),
    headers: z.string().optional().describe('Optional JSON-encoded headers object string.'),
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
      requestHeaders.Authorization = `Bearer ${await getValidToken(ENFYRA_API_URL)}`;
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

server.tool(
  'test_graphql',
  [
    'Execute a real GraphQL operation against the configured Enfyra /graphql endpoint.',
    'Use this after set_table_graphql or when verifying generated query/mutation behavior. GraphQL errors are returned as structured response data even when HTTP status is 200.',
  ].join(' '),
  {
    query: z.string().describe('GraphQL query or mutation document.'),
    variables: z.record(z.any()).optional().describe('GraphQL variables as a native JSON object.'),
    operationName: z.string().optional().describe('Optional operation name when the document contains multiple operations.'),
    useAuth: z.boolean().optional().default(true).describe('Attach the MCP admin Bearer token. Set false to verify anonymous GraphQL behavior.'),
  },
  async ({ query, variables, operationName, useAuth }) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (useAuth) headers.Authorization = `Bearer ${await getValidToken(ENFYRA_API_URL)}`;
    const started = Date.now();
    const response = await fetch(`${ENFYRA_API_URL.replace(/\/$/, '')}/graphql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        ...(variables ? { variables } : {}),
        ...(operationName ? { operationName } : {}),
      }),
    });
    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();
    let responseBody: any = responseText;
    if (contentType.includes('application/json') && responseText) responseBody = JSON.parse(responseText);
    const errors = Array.isArray(responseBody?.errors) ? responseBody.errors : [];
    return jsonContent({
      action: 'graphql_tested',
      request: {
        endpoint: `${ENFYRA_API_URL.replace(/\/$/, '')}/graphql`,
        operationName: operationName || null,
        authenticated: !!useAuth,
        variableNames: Object.keys(variables || {}),
      },
      response: {
        ok: response.ok && errors.length === 0,
        httpOk: response.ok,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - started,
        errorCount: errors.length,
        data: responseBody?.data ?? null,
        errors,
        raw: responseBody && typeof responseBody === 'object' ? undefined : responseBody,
      },
    });
  },
);

server.tool('get_all_routes', 'List route definitions with minimal fields. Complete route lists must pass either limit or all=true. If search is provided without limit, the tool returns a bounded lookup window of 10 matches. Call inspect_route for handlers/hooks/permissions detail.', {
  includeDisabled: z.boolean().optional().default(false).describe('Include disabled routes'),
  search: z.string().optional().describe('Optional path or table substring filter. Use this before creating a route to check duplicates.'),
  limit: z.number().int().positive().optional().describe('Maximum routes returned after search. Required unless all=true or search is provided. Do not invent arbitrary limits for "all"; use all=true instead.'),
  all: z.boolean().optional().default(false).describe('Return all matched routes. Use this when the user asks for all routes or a complete route list.'),
}, async ({ includeDisabled, search, limit, all }) => {
  if (!all && limit === undefined && !search?.trim()) {
    throw new Error('get_all_routes requires either limit or all=true. Do not rely on implicit default page sizes.');
  }
  if (all && limit !== undefined) {
    throw new Error('get_all_routes accepts either all=true or limit, not both.');
  }
  const filter = includeDisabled ? {} : { isEnabled: { _eq: true } };
  const queryParams = new URLSearchParams({
    filter: JSON.stringify(filter),
    fields: 'id,path,mainTable.name,availableMethods.*,publicMethods.*,isEnabled',
    limit: all ? '0' : '1000',
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
  const routeLimit = all ? matchedRoutes.length : (limit ?? 10);
  const payload = {
    statusCode: result?.statusCode,
    success: result?.success,
    totalRouteCount: allRoutes.length,
    matchedRouteCount: matchedRoutes.length,
    returnedRouteCount: Math.min(matchedRoutes.length, routeLimit),
    all: !!all,
    implicitSearchLimit: Boolean(!all && limit === undefined && search?.trim()),
    complete: all || routeLimit >= matchedRoutes.length,
    hardCap: all ? null : routeLimit,
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
    '**Use this when the user wants a new REST API route or path** — not `create_tables`. Custom routes must omit `mainTableId`.',
    '`mainTableId` is only a marker for canonical table routes such as `/orders`; do not set it for `/orders/stats`, `/reports/summary`, `/auth/login`, or any custom path.',
    'Do NOT create a new enfyra_table only to expose an endpoint; create a route without `mainTableId`, then have the handler/hook query user-facing tables through secure explicit repos such as `#secure.orders` or `$ctx.$repos.secure.orders`.',
    'availableMethods = which REST verbs the route responds to. publicMethods = which REST verbs are public (no auth). GraphQL is enabled separately through enfyra_graphql/update_tables graphqlEnabled.',
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
    globalRulesAckKey: globalRulesAckParam(z),
  },
  async ({ path: routePath, mainTableId, methods, publicMethods, isEnabled, description, globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    const methodMap = await getMethodMap();
    const normalizedPath = normalizeRestPath(routePath);

    const body: RouteCreateBody = {
      path: normalizedPath,
      isEnabled,
      description,
      availableMethods: resolveMethodIds(methodMap, methods),
    };

    if (mainTableId !== undefined && mainTableId !== null) {
      const { tables } = await getMetadataTables(mainTableId);
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
    'Attach to a custom route from `create_route` for endpoint-specific or third-party behavior. Do not use this low-level tool to bypass api_endpoint_workflow canonical-collision checks.',
    'Canonical table routes are shared with eApp/admin CRUD. Adding a new canonical handler requires allowCanonicalRoute=true and main-table repository access; otherwise create a separate custom path.',
    'Use sourceCode, not logic/name. Enfyra compiles sourceCode into compiledCode; do not send compiledCode.',
    'Handler code runs inside a sandbox with $ctx. Use macros: @BODY, @QUERY, @PARAMS, @USER, @REPOS, @HELPERS, @THROW400..@THROW503, @SOCKET, @PKGS, @LOGS, @SHARE.',
    'Call discover_script_contexts first. For explicit user-facing table repos use #secure.table_name or @REPOS.secure.table_name; use #table_name/@REPOS.table_name only for intentional trusted internal access.',
    'Or use $ctx directly: $ctx.$body, $ctx.$repos.main.find(), $ctx.$helpers.$bcrypt.hash(), etc.',
    'require("pkg") works for installed Server packages. console.log() writes to $share.$logs.',
  ].join(' '),
  {
    routeId: z.union([z.string(), z.number()]).describe('Route definition ID'),
    method: z.string().optional()
      .describe('Single enfyra_method.name to create. Prefer this for one handler.'),
    methods: z.array(z.string()).optional()
      .describe('Batch create multiple handlers. Use only when the same sourceCode applies to every method.'),
    sourceCode: z.string().describe('Handler JavaScript sourceCode. Do not use logic; backend CRUD rejects logic. Use @REPOS.main for the route main table or #secure.table_name/@REPOS.secure.table_name for explicit user-facing access; trusted repos require intentional bypass and explicit authorization.'),
    scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language for compiler. Default javascript.'),
    timeout: z.number().optional().describe('Timeout in ms (default: system DEFAULT_HANDLER_TIMEOUT, usually 30000)'),
    globalRulesAckKey: globalRulesAckParam(z),
    knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
    allowCanonicalRoute: z.boolean().optional().default(false).describe('Explicit acknowledgement for adding a new handler to a canonical main-table route. Use only when the new method intentionally belongs to the shared eApp/admin CRUD surface; third-party endpoint-specific behavior must use a separate custom route.'),
  },
  async ({ routeId, method, methods, sourceCode, scriptLanguage, timeout, globalRulesAckKey, knowledgeAckKey, allowCanonicalRoute }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    assertDynamicCodeKnowledgeAck(knowledgeAckKey);
    const routeQuery = new URLSearchParams({
      filter: JSON.stringify({ id: { _eq: routeId } }),
      fields: 'id,path,mainTable.id,mainTable.name',
      limit: '1',
    });
    const routeResult = await fetchAPI(ENFYRA_API_URL, `/enfyra_route?${routeQuery.toString()}`);
    const targetRoute = unwrapData(routeResult)[0];
    if (!targetRoute) throw new Error(`Route not found: ${String(routeId)}`);
    assertCreateHandlerRouteBoundary(targetRoute, sourceCode, allowCanonicalRoute);
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

      const body: RouteHandlerBody = { route: { id: routeId }, method: { id: methodId }, sourceCode, scriptLanguage };
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
      canonicalRouteAcknowledged: Boolean(targetRoute?.mainTable && allowCanonicalRoute),
      scriptValidation,
      routeReload,
      detailHint: 'Use inspect_route with the same routeId/path to inspect saved handlers.',
    }, null, 2) }] };
  },
);

server.tool(
  'create_pre_hook',
  [
    'Create a pre-hook that runs BEFORE the handler. Use to validate, transform, inject data, or enforce owner/tenant row filters (RLS).',
    'Use `routeId` from `create_route` or `get_all_routes` — do not create a new table just to get a route id.',
    'Macros: @BODY, @QUERY, @PARAMS, @USER, @REPOS, @HELPERS, @THROW400..@THROW503.',
    'For canonical table reads, merge security filters into @QUERY.filter and preserve @QUERY.fields/deep/sort/limit/page/meta/aggregate.',
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
    globalRulesAckKey: globalRulesAckParam(z),
    knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
  },
  async ({ routeId, name, code, scriptLanguage, methods, priority, isEnabled, globalRulesAckKey, knowledgeAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    assertDynamicCodeKnowledgeAck(knowledgeAckKey);
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
    globalRulesAckKey: globalRulesAckParam(z),
    knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
  },
  async ({ routeId, name, code, scriptLanguage, methods, priority, isEnabled, globalRulesAckKey, knowledgeAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    assertDynamicCodeKnowledgeAck(knowledgeAckKey);
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
    globalRulesAckKey: globalRulesAckParam(z),
  },
  async ({ path, routeId, methods, roleId, roleName, allowedUserIds, mode, description, isEnabled, globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
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

// Register table tools
registerTableTools(server, ENFYRA_API_URL, { toolset: MCP_TOOLSET });
registerPlatformOperationTools(server, ENFYRA_API_URL);
registerRuntimeZoneTools(server, ENFYRA_API_URL);
registerDynamicRepositoryBuilder(server);

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
    globalRulesAckKey: globalRulesAckParam(z),
  },
  async ({ name, type, version, globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
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
      return jsonContent({
        action: 'package_already_installed',
        package: {
          name,
          version: existing.data[0].version,
          type: existing.data[0].type,
        },
        record: existing.data[0],
      });
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

    return jsonContent({
      action: 'package_installed',
      package: { name, version: pkgVersion, type },
      result,
    });
  },
);

registerToolCatalogTools(server, toolsetState, {
  resolveAvailability: resolveCatalogToolAvailability,
});
registerWorkflowToolPack(server, toolsetState);

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.error('Starting Enfyra MCP Server...');
  console.error(`API URL: ${ENFYRA_API_URL}`);
  console.error(`Auth: ${ENFYRA_API_TOKEN ? 'API token configured' : 'Not configured'}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  startRuntimeCacheSocket(ENFYRA_API_URL);

  console.error('Enfyra MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
