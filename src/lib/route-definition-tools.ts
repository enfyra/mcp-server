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

export function registerRouteDefinitionTools(server, ENFYRA_API_URL) {
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
}
