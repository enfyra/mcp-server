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
  CAPABILITY_AREAS,
  FIELD_PERMISSION_CONDITION_OPERATORS,
  FILTER_OPERATORS,
  MCP_DYNAMIC_TOOLS,
  MCP_PROFILE,
  asNonEmptyStringTuple,
  collectPartialErrors,
  discoveryFetch,
  getMetadataDatabaseContext,
  getPrimaryColumn,
  summarizeRoutes,
  summarizeTable,
  targetInstance,
  unwrapData,
} from './enfyra-tool-logic.js';

export function registerDiscoveryTools(server, ENFYRA_API_URL) {
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
      'Use this before generating schemas, queries, handlers/hooks, third-app connections, OAuth, Socket.IO, flows, files, or extensions so implementation details follow proven patterns.',
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
      'The runtimeTypes section is the authoritative script-visible ESV contract. Use it instead of generating defensive type or callable guards around documented context values and bridge methods.',
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
        runtimeTypes: buildDynamicScriptContextTypeContract(),
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
}
