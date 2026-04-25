/**
 * Enfyra MCP — stdio server (loaded by index.mjs).
 */

import { config } from 'dotenv';
config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Configuration
const ENFYRA_API_URL = process.env.ENFYRA_API_URL || 'http://localhost:3000/api';
const ENFYRA_EMAIL = process.env.ENFYRA_EMAIL || '';
const ENFYRA_PASSWORD = process.env.ENFYRA_PASSWORD || '';

// Import modules
import { login, refreshAccessToken, getValidToken, resetTokens, getTokenExpiry, initAuth } from './lib/auth.js';
import { fetchAPI, validateFilter, validateTableName } from './lib/fetch.js';
import { buildMcpServerInstructions, buildGraphqlUrls } from './lib/mcp-instructions.js';
import { registerTableTools } from './lib/table-tools.js';

// Initialize auth module
initAuth(ENFYRA_API_URL, ENFYRA_EMAIL, ENFYRA_PASSWORD);

const CAPABILITY_AREAS = [
  {
    area: 'Schema and metadata',
    tables: ['table_definition', 'column_definition', 'relation_definition', 'schema_migration_definition'],
    workflow: 'Use table tools for table/column/relation schema changes. column_definition and session_definition are internal/no-route; do not CRUD them directly.',
  },
  {
    area: 'Dynamic REST API',
    tables: ['route_definition', 'route_handler_definition', 'pre_hook_definition', 'post_hook_definition', 'route_permission_definition', 'method_definition'],
    workflow: 'Create paths with create_route on an existing main table, then add handlers/hooks. REST methods are GET/POST/PATCH/DELETE.',
  },
  {
    area: 'Auth, roles, sessions, OAuth',
    tables: ['user_definition', 'role_definition', 'session_definition', 'oauth_config_definition', 'oauth_account_definition'],
    workflow: 'Email/password login is /auth/login. OAuth is browser redirect based. session_definition is internal/no-route.',
  },
  {
    area: 'Guards and permissions',
    tables: ['guard_definition', 'guard_rule_definition', 'field_permission_definition', 'column_rule_definition'],
    workflow: 'Use route guard metadata for request gating, field permissions for record field access, and column rules for body validation.',
  },
  {
    area: 'GraphQL',
    tables: ['gql_definition'],
    workflow: 'Enable per table through gql_definition or update_table graphqlEnabled. GraphQL requires Bearer auth.',
  },
  {
    area: 'Files and storage',
    tables: ['file_definition', 'file_permission_definition', 'folder_definition', 'storage_config_definition'],
    workflow: 'Use file endpoints/helpers for uploads and asset streaming; metadata tables describe files, permissions, folders, and storage backends.',
  },
  {
    area: 'WebSocket',
    tables: ['websocket_definition', 'websocket_event_definition'],
    workflow: 'Socket.IO gateways/events are metadata-backed. Use admin test runner for handler scripts before relying on a real client.',
  },
  {
    area: 'Flows',
    tables: ['flow_definition', 'flow_step_definition', 'flow_execution_definition'],
    workflow: 'Create flows and steps via CRUD, test steps with test_flow_step/run_admin_test, trigger with trigger_flow.',
  },
  {
    area: 'Extensions, menus, packages',
    tables: ['extension_definition', 'menu_definition', 'package_definition', 'bootstrap_script_definition'],
    workflow: 'Extensions are Vue SFC records. Use install_package for package_definition rather than raw CRUD.',
  },
  {
    area: 'Settings and platform config',
    tables: ['setting_definition', 'cors_origin_definition'],
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
    exactDatabaseType: 'not exposed by current public/admin API; infer from metadata or add a backend context endpoint for exact mysql/postgres/mongodb/sqlite',
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
  return {
    id: table.id ?? table._id,
    name: table.name,
    alias: table.alias,
    primaryKey: getPrimaryColumn(table)?.name || null,
    validateBody: table.validateBody,
    graphqlEnabled: table.graphqlEnabled,
    columns: (table.columns || []).map((column) => ({
      id: column.id ?? column._id,
      name: column.name,
      type: column.type,
      isPrimary: !!column.isPrimary,
      isNullable: column.isNullable,
      isPublished: column.isPublished,
    })),
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
    availableMethods: (route.availableMethods || []).map((method) => method.method).filter(Boolean),
    publishedMethods: (route.publishedMethods || []).map((method) => method.method).filter(Boolean),
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

function parseJsonArg(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  return JSON.parse(value);
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

async function fetchAll(path) {
  return unwrapData(await fetchAPI(ENFYRA_API_URL, path));
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

// ============================================================================
// METADATA TOOLS
// ============================================================================

server.tool('get_all_metadata', 'Get all metadata (tables, columns, relations, routes, hooks, etc.) from Enfyra', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/metadata');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('get_table_metadata', 'Get metadata for a specific table by name', {
  tableName: z.string().describe('Table name (e.g., "user_definition", "route_definition")'),
}, async ({ tableName }) => {
  const result = await fetchAPI(ENFYRA_API_URL, `/metadata/${tableName}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool(
  'discover_enfyra_system',
  [
    'Call this first when you need to understand the live Enfyra instance.',
    'Returns a concise capability map from live metadata/routes/method rows, including schema management, REST route behavior, GraphQL enablement, and relation handling.',
  ].join(' '),
  {},
  async () => {
    const metadata = await fetchAPI(ENFYRA_API_URL, '/metadata');
    const [routesResult, methodsResult] = await Promise.all([
      fetchAPI(ENFYRA_API_URL, '/route_definition?fields=path,mainTable.name,availableMethods.*,publishedMethods.*&limit=1000'),
      fetchAPI(ENFYRA_API_URL, '/method_definition?limit=100'),
    ]);

    const tables = normalizeTables(metadata);
    const tableNames = tables.map((table) => table?.name).filter(Boolean).sort();
    const routes = summarizeRoutes(routesResult);
    const routeTables = new Set(routes.map((route) => route.mainTable).filter(Boolean));
    const noRouteTables = tableNames.filter((name) => !routeTables.has(name));
    const relationTable = tables.find((table) => table?.name === 'relation_definition');
    const tableDefinition = tables.find((table) => table?.name === 'table_definition');
    const gqlDefinition = tables.find((table) => table?.name === 'gql_definition');
    const routeTableList = [...routeTables].sort();

    const payload = {
      apiBase: ENFYRA_API_URL.replace(/\/$/, ''),
      counts: {
        tables: tableNames.length,
        routes: routes.length,
        methods: methodsResult?.data?.length || 0,
      },
      methods: (methodsResult?.data || []).map((method) => ({ id: method.id || method._id, method: method.method })),
      capabilityAreas: CAPABILITY_AREAS.map((item) => ({
        ...item,
        presentTables: item.tables.filter((table) => tableNames.includes(table)),
        routeBackedTables: item.tables.filter((table) => routeTables.has(table)),
        noRouteTables: item.tables.filter((table) => tableNames.includes(table) && !routeTables.has(table)),
      })),
      rest: {
        routePattern: 'Dynamic REST routes expose GET/POST at /<route-path> and PATCH/DELETE at /<route-path>/:id; there is no GET /<route-path>/:id.',
        publicAccess: 'publishedMethods controls anonymous REST access per route/method; otherwise Bearer JWT + routePermissions apply.',
        routeTables: routeTableList,
        noRouteTables,
        canonicalCrudTools: 'query_table/create_record/update_record/delete_record use dynamic REST routes and only work for route-backed tables.',
        customRouteWorkflow: 'For a new endpoint use create_route against an existing table, then create_handler/create_pre_hook/create_post_hook. Do not create a table just to get a path.',
      },
      schemaManagement: {
        createTable: 'POST /table_definition supports isSingleRecord at create time and supports columns and relations arrays in the same cascade call. MCP create_table exposes isSingleRecord, columns, and relations directly. It does not accept alias at create time; table name drives the default route/schema behavior.',
        updateTable: 'PATCH /table_definition/:id is the canonical path for table property changes and column/relation schema changes.',
        columns: 'column_definition has no REST route; use create_table/create_column/update_column/delete_column.',
        relations: routeTables.has('relation_definition')
          ? 'relation_definition has a REST route for reads/metadata, but canonical schema migration is create_relation/delete_relation or table_definition PATCH with the full relations array. Relation onDelete accepts CASCADE, SET NULL, or RESTRICT.'
          : 'Use create_relation/delete_relation or table_definition PATCH with the full relations array. Relation onDelete accepts CASCADE, SET NULL, or RESTRICT.',
        relationCascadeFkContract: 'Do not ask for or send physical FK/junction column names in relation create/update payloads. Enfyra derives fk/junction columns from relation propertyName/table metadata and hides FK columns from app schema/forms. Use targetTable, type, propertyName, inversePropertyName or mappedBy, isNullable, onDelete.',
        tableDefinitionRelations: (tableDefinition?.relations || []).map((rel) => rel.propertyName),
        relationDefinitionRelations: (relationTable?.relations || []).map((rel) => rel.propertyName),
      },
      adminTesting: {
        runAdminTest: 'run_admin_test wraps POST /admin/test/run for flow_step, websocket_event, and websocket_connection scripts.',
        testFlowStep: 'test_flow_step wraps POST /admin/flow/test-step.',
        triggerFlow: 'trigger_flow wraps POST /admin/flow/trigger/:id and enqueues a flow execution.',
      },
      graphql: {
        endpoint: `${ENFYRA_API_URL.replace(/\/$/, '')}/graphql`,
        schemaEndpoint: `${ENFYRA_API_URL.replace(/\/$/, '')}/graphql-schema`,
        enablement: 'A table appears in GraphQL when gql_definition has an enabled row for that table. REST route availableMethods does not enable GraphQL.',
        auth: 'GraphQL currently requires Authorization: Bearer <accessToken>; REST publishedMethods does not make GraphQL anonymous.',
        management: routeTables.has('gql_definition')
          ? 'Use update_table graphqlEnabled or create/update records on gql_definition, then reload_graphql if needed.'
          : 'Use update_table graphqlEnabled, then reload_graphql if needed.',
        gqlDefinitionColumns: (gqlDefinition?.columns || []).map((column) => column.name),
      },
      tableNames,
      routes,
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  'discover_runtime_context',
  [
    'Discover live runtime context that affects how an LLM should use Enfyra.',
    'Reports inferred primary key/backend family, route/cache/admin surfaces, active metadata-backed runtime areas, and what is not exposed by the backend API.',
  ].join(' '),
  {},
  async () => {
    const metadata = await fetchAPI(ENFYRA_API_URL, '/metadata');
    const [
      routesResult,
      methodsResult,
      gqlResult,
      flowsResult,
      websocketResult,
      storageResult,
      settingsResult,
      meResult,
    ] = await Promise.all([
      fetchAPI(ENFYRA_API_URL, '/route_definition?fields=path,mainTable.name,availableMethods.*,publishedMethods.*,isEnabled&limit=1000'),
      fetchAPI(ENFYRA_API_URL, '/method_definition?limit=100'),
      fetchAPI(ENFYRA_API_URL, '/gql_definition?limit=1000').catch((error) => ({ error: String(error.message || error), data: [] })),
      fetchAPI(ENFYRA_API_URL, '/flow_definition?limit=1000').catch((error) => ({ error: String(error.message || error), data: [] })),
      fetchAPI(ENFYRA_API_URL, '/websocket_definition?limit=1000').catch((error) => ({ error: String(error.message || error), data: [] })),
      fetchAPI(ENFYRA_API_URL, '/storage_config_definition?limit=1000').catch((error) => ({ error: String(error.message || error), data: [] })),
      fetchAPI(ENFYRA_API_URL, '/setting_definition?limit=1000').catch((error) => ({ error: String(error.message || error), data: [] })),
      fetchAPI(ENFYRA_API_URL, '/me').catch((error) => ({ error: String(error.message || error), data: [] })),
    ]);

    const tables = normalizeTables(metadata);
    const routes = summarizeRoutes(routesResult);
    const routeTables = new Set(routes.map((route) => route.mainTable).filter(Boolean));
    const adminRoutes = routes.filter((route) => route.path?.startsWith('/admin'));
    const publicRoutes = routes.filter((route) => route.publishedMethods?.length);

    const payload = {
      apiBase: ENFYRA_API_URL.replace(/\/$/, ''),
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
      methods: (methodsResult?.data || []).map((method) => ({ id: method.id || method._id, method: method.method })),
      routeRuntime: {
        routePattern: 'GET/POST /<route-path>; PATCH/DELETE /<route-path>/:id; no dynamic GET /<route-path>/:id.',
        adminRoutes: adminRoutes.map((route) => route.path).sort(),
        publicRoutes: publicRoutes.map((route) => ({
          path: route.path,
          mainTable: route.mainTable,
          publishedMethods: route.publishedMethods,
        })),
      },
      cacheAndCluster: {
        metadataMutationReloads: 'Metadata-backed mutations emit cache invalidation; admin reload endpoints exist for metadata/routes/graphql/guards/all.',
        multiInstanceContract: 'Backend is cluster-aware through cache invalidation and Redis/BullMQ paths, but this MCP can only observe metadata/API state, not every node health.',
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
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  'discover_query_capabilities',
  [
    'Discover Enfyra query/filter/deep-fetch capabilities for the live instance.',
    'Optionally pass tableName to include columns, relations, primary key, route paths, and examples for that table.',
  ].join(' '),
  {
    tableName: z.string().optional().describe('Optional table name to summarize query fields and relation/deep capabilities.'),
  },
  async ({ tableName }) => {
    const metadata = await fetchAPI(ENFYRA_API_URL, '/metadata');
    const routesResult = await fetchAPI(ENFYRA_API_URL, '/route_definition?fields=path,mainTable.name,availableMethods.*,publishedMethods.*,isEnabled&limit=1000');
    const tables = normalizeTables(metadata);
    const routes = summarizeRoutes(routesResult);
    const table = tableName ? tables.find((item) => item.name === tableName) : null;
    const primaryKey = table ? getPrimaryColumn(table)?.name || 'id' : inferPrimaryKeyContext(tables).dominantPrimaryKey || 'id';
    const tableRoutes = tableName
      ? routes.filter((route) => route.mainTable === tableName)
      : [];

    const payload = {
      operators: {
        filter: FILTER_OPERATORS,
        fieldPermissionConditions: FIELD_PERMISSION_CONDITION_OPERATORS,
        fieldPermissionConditionUnsupported: ['_contains', '_starts_with', '_ends_with', '_between'],
      },
      queryParams: {
        fields: 'Comma-separated scalar/relation fields. Relations use relation propertyName, not physical FK column names.',
        filter: 'JSON object using operators above. Relation filters use nested relation propertyName objects.',
        sort: 'Field name or -field. Dotted relation sort is constrained by relation type and deep validation.',
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
          'Nested deep is recursively validated.',
          'Field permissions may rewrite filters/sorts and sanitize post-query results.',
        ],
      },
      backendNotes: {
        primaryKey: 'SQL commonly uses id; Mongo uses _id. Use table metadata primary column when available.',
        relationNames: 'API relation operations use relation propertyName, not physical FK column names.',
        relationCascadeFkContract: 'When creating relations through create_table/create_relation/table_definition PATCH, never provide fkCol/fkColumn/foreignKeyColumn/sourceColumn/targetColumn/junction*Column. These are physical implementation details derived by Enfyra and hidden from app schema/forms.',
        graphql: 'GraphQL query args also accept filter/sort/page/limit, but GraphQL requires Bearer auth and table enablement via gql_definition.',
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

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  'discover_script_contexts',
  [
    'Discover runtime script contexts and macro availability for handlers, hooks, flows, websocket scripts, GraphQL, packages, and extensions.',
    'Use before writing dynamic JavaScript logic so the model does not mix context variables across surfaces.',
  ].join(' '),
  {},
  async () => {
    const payload = {
      transformer: {
        rule: 'Dynamic server scripts are transformed before sandbox execution. Macros expand to $ctx paths; comments are not transformed.',
        preferredSyntax: 'Prefer template macros in generated Enfyra scripts. Use @BODY/@QUERY/@PARAMS/@USER/@REPOS/@HELPERS/@SOCKET/@TRIGGER/@DATA/@ERROR/@THROW* instead of raw $ctx access whenever a macro exists. Use raw $ctx only for fields without a macro.',
        coreMacros: {
          '@BODY': '$ctx.$body',
          '@QUERY': '$ctx.$query',
          '@PARAMS': '$ctx.$params',
          '@USER': '$ctx.$user',
          '@REPOS': '$ctx.$repos',
          '@HELPERS': '$ctx.$helpers',
          '@SOCKET': '$ctx.$socket',
          '@DATA': '$ctx.$data',
          '@STATUS': '$ctx.$statusCode',
          '@ERROR': '$ctx.$error',
          '@PKGS': '$ctx.$pkgs',
          '@LOGS': '$ctx.$logs',
          '@SHARE': '$ctx.$share',
          '@TRIGGER(name,payload)': '$ctx.$trigger(name,payload)',
        },
        flowMacros: {
          '@FLOW': '$ctx.$flow',
          '@FLOW_PAYLOAD': '$ctx.$flow.$payload',
          '@FLOW_LAST': '$ctx.$flow.$last',
          '@FLOW_META': '$ctx.$flow.$meta',
          '#table_name': '$ctx.$repos.table_name',
        },
        throws: '@THROW400 through @THROW503 and @THROW map to $ctx.$throw helpers.',
      },
      contexts: {
        preHook: {
          runs: 'Before handler.',
          data: ['@BODY', '@QUERY', '@PARAMS', '@USER', '@REPOS', '@HELPERS', '@THROW*', '@SOCKET emit helpers'],
          returnBehavior: 'Returning a non-undefined value skips handler and becomes response data.',
        },
        handler: {
          runs: 'Main route logic, or canonical CRUD if no handler overrides.',
          data: ['@BODY', '@QUERY', '@PARAMS', '@USER', '@REPOS.main', '@REPOS.secure', '@HELPERS', '@PKGS', '@SOCKET emit helpers', '@TRIGGER'],
          returnBehavior: 'Return value becomes response body unless post-hook changes it.',
        },
        postHook: {
          runs: 'After handler, including error path.',
          data: ['@DATA', '@STATUS', '@ERROR', '@BODY', '@QUERY', '@USER', '@SHARE', '@API'],
          returnBehavior: 'Mutate @DATA/$ctx.$data or return a non-undefined replacement response.',
        },
        flowStep: {
          runs: 'Inside flow execution or admin flow step test.',
          data: ['@FLOW_PAYLOAD', '@FLOW_LAST', '@FLOW', '@FLOW_META', '#table_name', '@HELPERS', '@SOCKET', '@TRIGGER'],
          resultBehavior: 'Step return value is injected into @FLOW.<step.key> and @FLOW_LAST.',
          branching: 'Condition steps use JavaScript truthy/falsy result; child branch is true/false.',
        },
        websocketConnection: {
          runs: 'Socket.IO connection handler.',
          data: ['@BODY connection info', '@USER if authenticated', '@SOCKET reply/join/leave/disconnect/emit helpers'],
        },
        websocketEvent: {
          runs: 'Socket.IO event handler.',
          data: ['@BODY event payload', '@USER if authenticated', '@SOCKET reply/join/leave/disconnect/emit helpers'],
          resultBehavior: 'Client ack receives queued state first; handler result is emitted asynchronously as ws:result/ws:error with requestId.',
        },
        graphqlResolver: {
          runs: 'Generated GraphQL resolver delegates to dynamic repo/query services.',
          data: ['GraphQL request context', 'Bearer auth user', 'dynamic repositories'],
          caveat: 'REST publishedMethods do not make GraphQL anonymous.',
        },
        extensionVueSfc: {
          runs: 'Frontend extension code, not server sandbox.',
          data: ['Vue/Nuxt composables', 'Enfyra composables', 'auto-resolved UI components'],
          caveat: 'No import statements; save as extension_definition Vue SFC record.',
        },
      },
      helpers: {
        repos: {
          scopes: '$repos.main enforces route main table behavior; $repos.secure.<table> enforces field permissions; $repos.<table> is trusted/internal.',
          mutationReturnShape: '$repos.<table>.create({ data }) and $repos.<table>.update({ id, data }) return a collection-shaped result: { data: [...], count? }. data is always an array for create/update, even for one created/updated record. If a script needs the single record object, it must read result.data[0] or result.data?.[0] ?? null.',
          preferredExample: 'const result = await @REPOS.main.create({ data: @BODY }); const record = result.data?.[0] ?? null; return record;',
          wrongSingleRecordAccess: 'Do not use result.data.id, do not return result.data when one object is expected, and do not assume create/update returns the bare row object.',
          countPattern: 'To count records in custom code, do not fetch full rows. Use const result = await @REPOS.main.find({ fields: "id", limit: 1, meta: filter ? "filterCount" : "totalCount", ...(filter ? { filter } : {}) }); then read result.meta.filterCount or result.meta.totalCount.',
        },
        socketInHttpOrFlow: 'HTTP/flow context can emitToUser/emitToRoom/emitToGateway/broadcast, but cannot reply/join/leave/disconnect because there is no bound socket.',
        packages: 'Server packages installed through install_package are exposed as $ctx.$pkgs.packageName in server scripts.',
        files: 'Upload helpers are on $helpers; raw create_record on file_definition is not equivalent to multipart upload/storage rollback.',
      },
      adminTesting: {
        flowStep: 'Use test_flow_step or run_admin_test(kind=flow_step).',
        websocket: 'Use run_admin_test(kind=websocket_event|websocket_connection).',
      },
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

// ============================================================================
// QUERY TOOLS
// ============================================================================

server.tool(
  'get_enfyra_api_context',
  [
    'Returns the resolved API base URL for this MCP session (env ENFYRA_API_URL).',
    'Use when the user asks which HTTP endpoint or full URL applies: combine enfyraApiUrl with paths from server instructions (GET/POST /{table}, PATCH/DELETE /{table}/{id}, no GET /{table}/{id}).',
    'Auth: publishedMethods on a route can allow a method without Bearer; otherwise JWT + routePermissions — see server instructions.',
    'If path might differ from table name, use get_all_routes before asserting a URL.',
    'Same mapping as MCP tool → HTTP: query_table=GET /table?..., create_record=POST /table, update_record=PATCH /table/id, delete_record=DELETE /table/id.',
    'GraphQL: see graphqlHttpUrl / graphqlSchemaUrl in response; enable per table via gql_definition/update_table graphqlEnabled and send Bearer auth.',
  ].join(' '),
  {},
  async () => {
    const base = ENFYRA_API_URL.replace(/\/$/, '');
    const gql = buildGraphqlUrls(ENFYRA_API_URL);
    const payload = {
      enfyraApiUrl: base,
      graphqlHttpUrl: gql.graphqlHttpUrl,
      graphqlSchemaUrl: gql.graphqlSchemaUrl,
      examples: {
        listOrCreate: `${base}/<table_name>`,
        updateOrDelete: `${base}/<table_name>/<id>`,
        oneRowById: `${base}/<table_name>?filter={"id":{"_eq":"<id>"}}&limit=1`,
      },
      auth: {
        publishedMethods: 'If the HTTP method is published for that route, no Bearer required; else Bearer JWT and routePermissions apply.',
        graphql: 'GraphQL currently requires Bearer auth; route publishedMethods do not make GraphQL anonymous.',
        mcp: 'This server uses admin credentials from env for tools (fetchAPI).',
      },
      pathResolution: 'Confirm route path with get_all_routes or metadata — path may not equal table name.',
      note: 'Full tool→HTTP mapping is in MCP server instructions (shown to the model at connect).',
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool('query_table', 'Query any table in Enfyra with filters, sorting, and pagination', {
  tableName: z.string().describe('Table name to query'),
  filter: z.string().optional().describe('Filter object as JSON string. Examples: \'{"status": {"_eq": "active"}}\''),
  sort: z.string().optional().describe('Sort field. Prefix with - for descending (e.g., "createdAt", "-id")'),
  page: z.number().optional().describe('Page number (default: 1)'),
  limit: z.number().optional().describe('Items per page (default: 50, max: 500)'),
  fields: z.array(z.string()).optional().describe('Fields to select'),
}, async ({ tableName, filter, sort, page, limit, fields }) => {
  validateTableName(tableName);
  validateFilter(filter);

  const queryParams = new URLSearchParams();
  if (filter) queryParams.set('filter', filter);
  if (sort) queryParams.set('sort', sort);
  if (page) queryParams.set('page', String(page));
  if (limit) queryParams.set('limit', String(limit));
  if (fields) queryParams.set('fields', fields.join(','));

  const query = queryParams.toString();
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}${query ? `?${query}` : ''}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
  },
  async ({ tableName, id, filter }) => {
    validateTableName(tableName);
    if (id) {
      // Enfyra route engine does not register GET /<table>/:id (only PATCH/DELETE use /:id). Use list + filter.
      const filterObj = JSON.stringify({ id: { _eq: id } });
      const result = await fetchAPI(
        ENFYRA_API_URL,
        `/${tableName}?filter=${encodeURIComponent(filterObj)}&limit=1`,
      );
      const one = result.data?.[0] ?? null;
      return { content: [{ type: 'text', text: JSON.stringify(one, null, 2) }] };
    }
    if (!filter) throw new Error('Provide id or filter');
    validateFilter(filter);
    const result = await fetchAPI(
      ENFYRA_API_URL,
      `/${tableName}?filter=${encodeURIComponent(filter)}&limit=1`,
    );
    return { content: [{ type: 'text', text: JSON.stringify(result.data?.[0] || null, null, 2) }] };
  },
);

// ============================================================================
// CRUD TOOLS
// ============================================================================

server.tool('create_record', 'Create a new record in any table', {
  tableName: z.string().describe('Table name to insert into'),
  data: z.string().describe('Record data as JSON string'),
}, async ({ tableName, data }) => {
  validateTableName(tableName);
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}`, { method: 'POST', body: data });
  return { content: [{ type: 'text', text: `Record created:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('update_record', 'Update an existing record by ID using PATCH', {
  tableName: z.string().describe('Table name'),
  id: z.string().describe('Record ID to update'),
  data: z.string().describe('Fields to update as JSON string'),
}, async ({ tableName, id, data }) => {
  validateTableName(tableName);
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}/${id}`, { method: 'PATCH', body: data });
  return { content: [{ type: 'text', text: `Record updated:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('delete_record', 'Delete a record by ID', {
  tableName: z.string().describe('Table name'),
  id: z.string().describe('Record ID to delete'),
}, async ({ tableName, id }) => {
  validateTableName(tableName);
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}/${id}`, { method: 'DELETE' });
  return { content: [{ type: 'text', text: `Record deleted:\n${JSON.stringify(result, null, 2)}` }] };
});

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
  'Test a single flow step without saving it. Wraps POST /admin/flow/test-step.',
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
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/flow/test-step', {
      method: 'POST',
      body: JSON.stringify(body),
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
  const result = await fetchAPI(ENFYRA_API_URL, '/method_definition?limit=0');
  _methodMap = {};
  for (const m of result.data) {
    _methodMap[m.method] = m.id || m._id;
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
          method: item.method || methodIdNameMap[String(getId(item))] || null,
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
    fetchAll('/route_definition?limit=1000'),
    fetchAll('/route_handler_definition?limit=1000'),
    fetchAll('/pre_hook_definition?limit=1000'),
    fetchAll('/post_hook_definition?limit=1000'),
    fetchAll('/route_permission_definition?limit=1000'),
    fetchAll('/guard_definition?limit=1000'),
    fetchAll('/guard_rule_definition?limit=1000'),
    fetchAll('/field_permission_definition?limit=1000'),
    fetchAll('/column_rule_definition?limit=1000'),
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

function enrichRoute(route, state) {
  const routeId = getId(route);
  const routeHandlers = state.handlers
    .filter((item) => sameId(refId(item.route), routeId))
    .map((item) => pickCodeSummary({
      ...item,
      method: item.method ? { ...item.method, method: state.methodIdNameMap[String(getId(item.method))] || item.method.method || null } : item.method,
    }, 'logic'));
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
      ? route.availableMethods.map((method) => ({ ...method, method: method.method || state.methodIdNameMap[String(getId(method))] || null }))
      : route.availableMethods,
    publishedMethods: Array.isArray(route.publishedMethods)
      ? route.publishedMethods.map((method) => ({ ...method, method: method.method || state.methodIdNameMap[String(getId(method))] || null }))
      : route.publishedMethods,
    skipRoleGuardMethods: Array.isArray(route.skipRoleGuardMethods)
      ? route.skipRoleGuardMethods.map((method) => ({ ...method, method: method.method || state.methodIdNameMap[String(getId(method))] || null }))
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
    'Returns the backing table, available/published methods, handlers, hooks, route permissions, guards, and exact REST URL pattern.',
  ].join(' '),
  {
    path: z.string().optional().describe('Route path, e.g. /user_definition'),
    routeId: z.union([z.string(), z.number()]).optional().describe('route_definition id. Use either path or routeId.'),
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
    'Use when the user mentions a capability and you need to find where it lives before editing.',
  ].join(' '),
  {
    query: z.string().describe('Feature keyword, table name, route path, handler text, hook name, or guard name'),
  },
  async ({ query }) => {
    const state = await collectRestDefinitionState();
    const q = query.toLowerCase();
    const matchesText = (value) => JSON.stringify(value ?? '').toLowerCase().includes(q);
    const tableMatches = state.tables.filter((table) => matchesText({
      name: table.name,
      alias: table.alias,
      description: table.description,
      columns: table.columns?.map((column) => ({ name: column.name, description: column.description })),
      relations: table.relations?.map((relation) => ({ propertyName: relation.propertyName, description: relation.description })),
    }));
    const routeMatches = state.routes.filter((route) => matchesText(route));
    const handlerMatches = state.handlers.filter((handler) => matchesText(handler)).map((item) => pickCodeSummary(item, 'logic'));
    const preHookMatches = state.preHooks.filter((hook) => matchesText(hook)).map((item) => pickCodeSummary(item, 'code'));
    const postHookMatches = state.postHooks.filter((hook) => matchesText(hook)).map((item) => pickCodeSummary(item, 'code'));
    const guardMatches = state.guards.filter((guard) => matchesText(guard));
    const permissionMatches = [
      ...state.routePermissions.filter((permission) => matchesText(permission)).map((permission) => ({ type: 'route_permission', ...permission })),
      ...state.fieldPermissions.filter((permission) => matchesText(permission)).map((permission) => ({ type: 'field_permission', ...permission })),
    ];

    const payload = {
      query,
      counts: {
        tables: tableMatches.length,
        routes: routeMatches.length,
        handlers: handlerMatches.length,
        preHooks: preHookMatches.length,
        postHooks: postHookMatches.length,
        guards: guardMatches.length,
        permissions: permissionMatches.length,
      },
      tables: tableMatches.map(summarizeTable).slice(0, 20),
      routes: routeMatches.map((route) => enrichRoute(route, state)).slice(0, 20),
      handlers: handlerMatches.slice(0, 20),
      preHooks: preHookMatches.slice(0, 20),
      postHooks: postHookMatches.slice(0, 20),
      guards: guardMatches.slice(0, 20),
      permissions: permissionMatches.slice(0, 20),
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool(
  'test_rest_endpoint',
  [
    'Execute a real REST request against the configured Enfyra API base.',
    'Use this after inspecting a route or changing handlers/hooks/guards. Pass paths like /table_definition?limit=1, not external URLs.',
  ].join(' '),
  {
    method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']).default('GET').describe('HTTP method'),
    path: z.string().describe('Enfyra API path, e.g. /route_definition?limit=1'),
    query: z.string().optional().describe('Optional query params JSON object, merged onto path query string'),
    body: z.string().optional().describe('Optional JSON request body string'),
    headers: z.string().optional().describe('Optional headers JSON object'),
    useAuth: z.boolean().optional().default(true).describe('Attach MCP admin Bearer token. Set false to test published/public access.'),
  },
  async ({ method, path, query, body, headers, useAuth }) => {
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
      method,
      headers: requestHeaders,
      ...(body !== undefined && body !== null && method !== 'GET' ? { body } : {}),
    });
    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();
    let parsedBody = responseText;
    if (contentType.includes('application/json') && responseText) {
      parsedBody = JSON.parse(responseText);
    }

    const payload = {
      request: {
        method,
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

server.tool('get_all_routes', 'List all route definitions (path, mainTable, handlers, hooks, permissions). Call before create_route to avoid duplicate paths and to pick routeId for hooks/handlers.', {
  includeDisabled: z.boolean().optional().default(false).describe('Include disabled routes'),
}, async ({ includeDisabled }) => {
  const filter = includeDisabled ? {} : { isEnabled: { _eq: true } };
  const result = await fetchAPI(ENFYRA_API_URL, `/route_definition?filter=${encodeURIComponent(JSON.stringify(filter))}&limit=500`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool(
  'create_route',
  [
    '**Use this when the user wants a new REST API route or path** — not `create_table`. A route links a URL path to an existing table (`mainTableId`) and sets HTTP methods.',
    'Do NOT create a new table_definition only to expose an endpoint; pick `mainTableId` from existing metadata unless the user explicitly needs new tables/columns.',
    'availableMethods = which REST verbs the route responds to. publishedMethods = which REST verbs are public (no auth). GraphQL is enabled separately through gql_definition/update_table graphqlEnabled.',
    'After creation the tool auto-reloads routes. Then create handlers for specific methods via create_handler on this route id.',
    'Flow: resolve table id → create_route → create_handler (per method) → optionally create_pre_hook / create_post_hook → test via HTTP or admin test APIs (see server instructions).',
  ].join(' '),
  {
    path: z.string().describe('URL path, must start with / (e.g., "/my-endpoint")'),
    mainTableId: z.union([z.string(), z.number()]).describe('ID of the table_definition this route operates on. The route\'s $repos.main will query this table.'),
    methods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE']))
      .describe('HTTP methods this route supports (availableMethods). Common: ["GET","POST","PATCH","DELETE"]'),
    publishedMethods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE'])).optional()
      .describe('Methods accessible WITHOUT auth token. Omit = all methods require auth.'),
    isEnabled: z.boolean().optional().default(true).describe('Enable route immediately'),
    description: z.string().optional().describe('Route description'),
  },
  async ({ path: routePath, mainTableId, methods, publishedMethods, isEnabled, description }) => {
    const methodMap = await getMethodMap();

    const body = {
      path: routePath.startsWith('/') ? routePath : '/' + routePath,
      mainTable: { id: mainTableId },
      isEnabled,
      description,
      availableMethods: resolveMethodIds(methodMap, methods),
    };

    if (publishedMethods && publishedMethods.length > 0) {
      body.publishedMethods = resolveMethodIds(methodMap, publishedMethods);
    }

    const result = await fetchAPI(ENFYRA_API_URL, '/route_definition', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' }).catch(() => {});

    return { content: [{ type: 'text', text: `Route created (ID: ${result.id}). Routes reloaded.\n${JSON.stringify(result, null, 2)}` }] };
  },
);

server.tool(
  'create_handler',
  [
    'Create a handler for a route+method. One handler per (route, method) pair.',
    'Attach to the route the user cares about (`get_all_routes`): typically a path from `create_route`, not a spurious table created only for handlers.',
    'Handler code runs inside a sandbox with $ctx. Use macros: @BODY, @QUERY, @PARAMS, @USER, @REPOS, @HELPERS, @THROW400..@THROW503, @SOCKET, @PKGS, @LOGS, @SHARE.',
    'Or use $ctx directly: $ctx.$body, $ctx.$repos.main.find(), $ctx.$helpers.$bcrypt.hash(), etc.',
    'require("pkg") works for installed Server packages. console.log() writes to $share.$logs.',
  ].join(' '),
  {
    routeId: z.union([z.string(), z.number()]).describe('Route definition ID'),
    methods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE']))
      .describe('Methods to create handlers for. Creates one handler per method.'),
    logic: z.string().describe('Handler JavaScript code'),
    timeout: z.number().optional().describe('Timeout in ms (default: system DEFAULT_HANDLER_TIMEOUT, usually 30000)'),
  },
  async ({ routeId, methods, logic, timeout }) => {
    const methodMap = await getMethodMap();
    const results = [];

    for (const method of methods) {
      const methodId = methodMap[method.toUpperCase()];
      if (!methodId) throw new Error(`Unknown method: ${method}. Valid: ${Object.keys(methodMap).join(', ')}`);

      const body = { route: { id: routeId }, method: { id: methodId }, logic };
      if (timeout) body.timeout = timeout;

      const result = await fetchAPI(ENFYRA_API_URL, '/route_handler_definition', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      results.push(result);
    }

    await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' }).catch(() => {});

    return { content: [{ type: 'text', text: `Handler(s) created for [${methods.join(', ')}]. Routes reloaded.\n${JSON.stringify(results, null, 2)}` }] };
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
    code: z.string().describe('Hook JavaScript code'),
    methods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE'])).optional()
      .describe('Methods this hook applies to. Default: all REST methods.'),
    priority: z.number().optional().default(0).describe('Execution order (lower = first)'),
    isEnabled: z.boolean().optional().default(true).describe('Enable hook immediately'),
  },
  async ({ routeId, name, code, methods, priority, isEnabled }) => {
    const methodMap = await getMethodMap();
    const methodNames = methods || ['GET', 'POST', 'PATCH', 'DELETE'];

    const result = await fetchAPI(ENFYRA_API_URL, '/pre_hook_definition', {
      method: 'POST',
      body: JSON.stringify({
        route: { id: routeId },
        name,
        code,
        methods: resolveMethodIds(methodMap, methodNames),
        priority,
        isEnabled,
      }),
    });

    await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' }).catch(() => {});

    return { content: [{ type: 'text', text: `Pre-hook "${name}" created (ID: ${result.id}). Routes reloaded.\n${JSON.stringify(result, null, 2)}` }] };
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
    code: z.string().describe('Hook JavaScript code'),
    methods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE'])).optional()
      .describe('Methods this hook applies to. Default: all REST methods.'),
    priority: z.number().optional().default(0).describe('Execution order (lower = first)'),
    isEnabled: z.boolean().optional().default(true).describe('Enable hook immediately'),
  },
  async ({ routeId, name, code, methods, priority, isEnabled }) => {
    const methodMap = await getMethodMap();
    const methodNames = methods || ['GET', 'POST', 'PATCH', 'DELETE'];

    const result = await fetchAPI(ENFYRA_API_URL, '/post_hook_definition', {
      method: 'POST',
      body: JSON.stringify({
        route: { id: routeId },
        name,
        code,
        methods: resolveMethodIds(methodMap, methodNames),
        priority,
        isEnabled,
      }),
    });

    await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' }).catch(() => {});

    return { content: [{ type: 'text', text: `Post-hook "${name}" created (ID: ${result.id}). Routes reloaded.\n${JSON.stringify(result, null, 2)}` }] };
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
    const result = await fetchAPI(ENFYRA_API_URL, '/column_rule_definition', {
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
    const result = await fetchAPI(ENFYRA_API_URL, '/field_permission_definition', {
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
    'Use this when a non-root role/user should access an authenticated route. publishedMethods are for public access; route permissions are for authenticated role/user access.',
  ].join(' '),
  {
    path: z.string().optional().describe('Route path, e.g. /user_definition'),
    routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
    methods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE'])).describe('REST methods this permission allows'),
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
    const routes = await fetchAll('/route_definition?limit=1000');
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
    const result = await fetchAPI(ENFYRA_API_URL, '/route_permission_definition', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' }).catch(() => {});
    return { content: [{ type: 'text', text: `Route permission created for ${route.path}. Routes reloaded.\n${JSON.stringify(result, null, 2)}` }] };
  },
);

server.tool(
  'create_guard',
  [
    'Create a metadata guard with optional rules for REST request gating.',
    'Root guards attach to route or global position. Rule configs: rate limits use {"maxRequests":number,"perSeconds":number}; IP lists use {"ips":["127.0.0.1"]}.',
  ].join(' '),
  {
    name: z.string().describe('Guard name'),
    position: z.enum(['pre_auth', 'post_auth']).default('pre_auth').describe('Execution position for root guard'),
    routeId: z.union([z.string(), z.number()]).optional().describe('Optional route id'),
    path: z.string().optional().describe('Optional route path'),
    methods: z.array(z.enum(['GET', 'POST', 'PATCH', 'DELETE'])).optional().describe('Methods this guard applies to. Empty means all configured behavior for route/global.'),
    combinator: z.enum(['and', 'or']).default('and').describe('How child guards/rules combine'),
    priority: z.number().optional().default(0).describe('Lower runs first'),
    isGlobal: z.boolean().optional().default(false).describe('Apply globally instead of one route'),
    isEnabled: z.boolean().optional().default(false).describe('Enable immediately. Default false to avoid accidental lockout.'),
    description: z.string().optional().describe('Admin note'),
    rules: z.string().optional().describe('Optional rules JSON array: [{type, config, priority?, isEnabled?, description?, userIds?}]'),
  },
  async ({ name, position, routeId, path, methods, combinator, priority, isGlobal, isEnabled, description, rules }) => {
    let route = null;
    if (!isGlobal && (routeId || path)) {
      const routes = await fetchAll('/route_definition?limit=1000');
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
    const guard = await fetchAPI(ENFYRA_API_URL, '/guard_definition', {
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
      createdRules.push(await fetchAPI(ENFYRA_API_URL, '/guard_rule_definition', {
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
  const recentFiles = logFiles.filter(f => f.name.includes('app-') || f.name.includes('error-'));
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
  const result = await fetchAPI(ENFYRA_API_URL, '/role_definition?limit=100');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('login', 'Force login to Enfyra and get new tokens', {
  email: z.string().email().optional().describe('Admin email'),
  password: z.string().optional().describe('Password'),
}, async ({ email, password }) => {
  const loginEmail = email || ENFYRA_EMAIL;
  const loginPassword = password || ENFYRA_PASSWORD;
  if (!loginEmail || !loginPassword) throw new Error('Email and password required');
  await login(ENFYRA_API_URL, loginEmail, loginPassword);
  return { content: [{ type: 'text', text: `Logged in successfully!\nToken expires: ${new Date(getTokenExpiry()).toISOString()}` }] };
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
    'Install an NPM package on Enfyra. Searches NPM registry for exact version, then creates package_definition record.',
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
    const existing = await fetchAPI(ENFYRA_API_URL, `/package_definition?filter=${encodeURIComponent(checkFilter)}&limit=1`);
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

    // Step 4: Install via package_definition
    const body = {
      name,
      version: pkgVersion,
      description: pkgDescription,
      type,
      installedBy: { id: userId },
    };

    const result = await fetchAPI(ENFYRA_API_URL, '/package_definition', {
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

server.tool('create_menu', 'Create a menu item in the navigation', {
  label: z.string().describe('Menu label'),
  type: z.enum(['Menu', 'Dropdown Menu']).default('Menu').describe('Menu type: "Menu" for leaf items, "Dropdown Menu" for items with children'),
  icon: z.string().optional().describe('Lucide icon name'),
  path: z.string().optional().describe('Route path for type=route'),
  externalUrl: z.string().optional().describe('External URL for type=link'),
  order: z.number().optional().default(0).describe('Display order'),
  isEnabled: z.boolean().optional().default(true).describe('Enable menu'),
  description: z.string().optional().describe('Menu description'),
}, async (data) => {
  const body = { ...data };
  if (body.path && !body.path.startsWith('/')) {
    body.path = '/' + body.path;
  }
  const result = await fetchAPI(ENFYRA_API_URL, '/menu_definition', { method: 'POST', body: JSON.stringify(body) });
  return { content: [{ type: 'text', text: `Menu created (ID: ${result.id}):\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool(
  'create_extension',
  [
    'Create an extension (Vue SFC page or widget). Code must be Vue SFC: <template>...</template> + <script setup>...</script> — NO imports, use globals (ref, useToast, useApi, UButton, etc).',
    'For type=page: create menu first (create_menu), get id, then pass menuId. For type=widget no menu needed. Server auto-compiles; tell user to refresh (F5) after create. See extension rules in MCP instructions.',
  ].join(' '),
  {
    name: z.string().describe('Extension name (unique)'),
    type: z.enum(['page', 'widget']).describe('Extension type: page = full page linked to menu; widget = embed via Widget component'),
    code: z.string().describe('Vue SFC string — <template> + <script setup>, NO import statements'),
    menuId: z.string().optional().describe('Required for type=page — menu_definition id from create_menu. Omit for widget'),
    isEnabled: z.boolean().optional().default(true).describe('Enable extension'),
    description: z.string().optional().describe('Extension description'),
    version: z.string().optional().default('1.0.0').describe('Extension version'),
  },
  async (data) => {
    const body = { ...data };
    if (body.menuId) {
      body.menu = { id: body.menuId };
      delete body.menuId;
    }
    const result = await fetchAPI(ENFYRA_API_URL, '/extension_definition', { method: 'POST', body: JSON.stringify(body) });
    return { content: [{ type: 'text', text: `Extension created (ID: ${result.id}). Tell user to refresh (F5) to see it.\n${JSON.stringify(result, null, 2)}` }] };
  },
);

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.error('Starting Enfyra MCP Server...');
  console.error(`API URL: ${ENFYRA_API_URL}`);
  console.error(`Auth: ${ENFYRA_EMAIL ? `Configured (${ENFYRA_EMAIL})` : 'Not configured'}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Enfyra MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
