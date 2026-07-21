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
  RouteCreateBody,
  RouteHandlerBody,
  SCRIPT_BACKED_TABLES,
  collectFeatureSearchState,
  collectRestDefinitionState,
  enrichRoute,
  fetchAll,
  firstDataRecord,
  getId,
  getMetadataDatabaseContext,
  getMetadataTables,
  getMethodIdNameMap,
  getMethodMap,
  getPrimaryColumn,
  getRecordSource,
  methodNames,
  normalizeMethodNameInput,
  normalizeRestPath,
  parseJsonArg,
  pickCodeSummary,
  refId,
  reloadRoutesResult,
  resolveMethodIds,
  sameId,
  scriptRecordLabel,
  scriptTraceFields,
  sha256,
  sourcePreview,
  summarizeRoutes,
  summarizeTable,
  targetInstance,
  unwrapData,
} from './enfyra-tool-logic.js';

export function registerRouteInspectionTools(server, ENFYRA_API_URL) {
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
}
