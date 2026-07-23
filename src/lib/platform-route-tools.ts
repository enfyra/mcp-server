import { z } from 'zod';
import { createHash } from 'node:crypto';
import { fetchAPI } from './fetch.js';
import { fetchTableCatalog, fetchTableMetadata, fetchTableMetadataByRef, resolveTableCatalogEntry } from './metadata-client.js';
import {
  assertCustomEndpointRoute,
  assertDynamicEndpointContract,
  extractExplicitRepositoryTableNames,
  reviewDynamicEndpointContract,
} from './dynamic-endpoint-contract.js';
import { validatePortableScriptSource, validateScriptSourceIfPresent } from './mutation-guards.js';
import { writeSourceArtifact } from './source-artifacts.js';
import { destructivePreviewContent } from './destructive-preview.js';
import {
  normalizeEscapedVueSource,
  normalizeStrictBoolean,
} from './tool-input-normalization.js';
import {
  analyzeExtensionSfc,
  extensionElementAttributeValue,
  extensionElementHasAttribute,
} from './extension-sfc-analyzer.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAck,
  assertGlobalRulesAck,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';
import {
  HandlerBody,
  RouteHandlerBody,
  createOrPatch,
  deleteRoute,
  fetchAll,
  findHandler,
  findRecord,
  firstDataRecord,
  getId,
  getMethodContext,
  jsonText,
  methodNamesFromRecords,
  normalizeMethodName,
  normalizeRestPath,
  reloadBestEffort,
  reloadRoutes,
  resolveMethodRefs,
  reviewCustomEndpointSource,
  runApiEndpointWorkflow,
  setRouteEnabled,
  uniqueMethodNames,
  updateRouteMethods,
  updateRoutePublicMethods,
} from './platform-operation-logic.js';

export function registerPlatformRouteTools(server, ENFYRA_API_URL) {
  server.tool(
      'set_table_graphql',
      'Business operation: enable or disable GraphQL for one table through enfyra_graphql, then reload GraphQL. REST route methods do not control GraphQL.',
      {
        tableName: z.string().describe('Table name, alias, or id.'),
        isEnabled: z.boolean().describe('Desired GraphQL enabled state for the table.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ tableName, isEnabled, globalRulesAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        const catalog = await fetchTableCatalog(ENFYRA_API_URL);
        const table = resolveTableCatalogEntry(catalog, tableName);
        if (!table) throw new Error(`Table not found: ${tableName}`);
        const existing = await findRecord(ENFYRA_API_URL, 'enfyra_graphql', { table: { id: { _eq: getId(table) } } }, 'id,_id,table.id,isEnabled');
        const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_graphql', existing, {
          table: { id: getId(table) },
          isEnabled,
        });
        const graphqlReload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/graphql');
        return jsonText({
          action: 'table_graphql_set',
          table: { id: getId(table), name: table.name },
          graphql: { id: operation.id, isEnabled },
          operation,
          graphqlReload,
        });
      },
    );

  server.tool(
      'add_route_methods',
      'Business operation: add HTTP methods to an existing route.',
      {
        path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
        methods: z.array(z.string()).min(1).describe('HTTP method names to add.'),
        isEnabled: z.boolean().optional().describe('Optionally enable/disable the route in the same safe patch.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ path, routeId, methods, isEnabled, globalRulesAckKey }) => jsonText(await updateRouteMethods(ENFYRA_API_URL, {
        path,
        routeId,
        methods,
        mode: 'merge',
        isEnabled,
        globalRulesAckKey,
      })),
    );

  server.tool(
      'replace_route_methods',
      'Business operation: replace an existing route availableMethods list exactly.',
      {
        path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
        methods: z.array(z.string()).min(1).describe('Exact HTTP method names for availableMethods.'),
        isEnabled: z.boolean().optional().describe('Optionally enable/disable the route in the same safe patch.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ path, routeId, methods, isEnabled, globalRulesAckKey }) => jsonText(await updateRouteMethods(ENFYRA_API_URL, {
        path,
        routeId,
        methods,
        mode: 'replace',
        isEnabled,
        globalRulesAckKey,
      })),
    );

  server.tool(
      'remove_route_methods',
      'Business operation: remove HTTP methods from an existing route.',
      {
        path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
        methods: z.array(z.string()).min(1).describe('HTTP method names to remove.'),
        isEnabled: z.boolean().optional().describe('Optionally enable/disable the route in the same safe patch.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ path, routeId, methods, isEnabled, globalRulesAckKey }) => jsonText(await updateRouteMethods(ENFYRA_API_URL, {
        path,
        routeId,
        methods,
        mode: 'remove',
        isEnabled,
        globalRulesAckKey,
      })),
    );

  server.tool(
      'enable_route',
      'Business operation: enable an existing route. Enabled routes are registered at runtime; disabled routes return 404.',
      {
        path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ path, routeId, globalRulesAckKey }) => jsonText(await setRouteEnabled(ENFYRA_API_URL, {
        path,
        routeId,
        isEnabled: true,
        globalRulesAckKey,
      })),
    );

  server.tool(
      'disable_route',
      'Business operation: disable an existing route without deleting metadata. Disabled routes are not registered at runtime and return 404.',
      {
        path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ path, routeId, globalRulesAckKey }) => jsonText(await setRouteEnabled(ENFYRA_API_URL, {
        path,
        routeId,
        isEnabled: false,
        globalRulesAckKey,
      })),
    );

  server.tool(
      'delete_route',
      'Business operation: preview-first delete for a route and its route-owned handlers, hooks, guards, and permissions. confirm=true requires the preview path again. Partial failures return exact deleted and remaining checkpoints and require a new preview before retry.',
      {
        path: z.string().optional().describe('Route path, e.g. /old-endpoint. Use either path or routeId.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
        expectedRouteId: z.union([z.string(), z.number()]).optional().describe('Required when confirm=true. Pass the exact route id returned by the preview.'),
        expectedPath: z.string().optional().describe('Required when confirm=true. Pass the exact path returned by the preview.'),
        confirm: z.boolean().optional().default(false).describe('false returns a dependency preview only; true deletes the route and related route-owned records.'),
        globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
      },
      async (input) => {
        const result = await deleteRoute(ENFYRA_API_URL, input);
        if (!input.confirm) return destructivePreviewContent('delete_route', result, 1);
        const content = jsonText(result);
        return ('status' in result && result.status === 'partial_failure')
          || ('postcondition' in result && result.postcondition.confirmedAbsent !== true)
          ? { ...content, isError: true }
          : content;
      },
    );

  server.tool(
      'public_route_methods',
      'Business operation: make existing route methods public/anonymous.',
      {
        path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
        methods: z.array(z.string()).min(1).describe('HTTP method names to make public. They must already be available on the route.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ path, routeId, methods, globalRulesAckKey }) => jsonText(await updateRoutePublicMethods(ENFYRA_API_URL, {
        path,
        routeId,
        methods,
        mode: 'merge',
        globalRulesAckKey,
      })),
    );

  server.tool(
      'private_route_methods',
      'Business operation: make specific public route methods private again.',
      {
        path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
        methods: z.array(z.string()).min(1).describe('HTTP method names to remove from publicMethods.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ path, routeId, methods, globalRulesAckKey }) => jsonText(await updateRoutePublicMethods(ENFYRA_API_URL, {
        path,
        routeId,
        methods,
        mode: 'remove',
        globalRulesAckKey,
      })),
    );

  server.tool(
      'api_endpoint_workflow',
      [
        'Step-by-step workflow for creating or updating a custom REST endpoint.',
        'Use this when an LLM is building or changing endpoint behavior and should follow live nextSteps instead of guessing raw metadata mutations.',
        'With apply=false it validates sourceCode, blocks canonical-route collisions, reviews explicit repository metadata/security boundaries, reads live route/handler/access state, and returns pending steps.',
        'With apply=true it applies only the next pending step, then returns a fresh plan. With applyAll=true it advances all currently safe pending steps.',
      ].join(' '),
      {
        path: z.string().describe('Custom route path, e.g. /sum. Must not be a full URL.'),
        method: z.string().describe('HTTP method for the handler, e.g. GET or POST.'),
        sourceCode: z.string().describe('Handler body sourceCode for a custom route, which has no main table. Do not wrap it in export default/module.exports. Use #secure.table_name or @REPOS.secure.table_name for user-facing explicit-table access. Repository calls are async and reads return result.data. Passing @BODY as create/update data is valid TypeORM-style usage; enforce endpoint-specific owner/tenant/business rules in code. Reserve trusted repos for intentional field-permission bypass. Do not send compiledCode.'),
        scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
        anonymousAccess: z.enum(['public', 'private']).optional().default('private').describe('public adds the method to publicMethods; private removes this method from publicMethods.'),
        public: z.preprocess(normalizeStrictBoolean, z.boolean()).optional().describe('Compatibility alias for anonymousAccess. Accepts boolean true/false and exact string "true"/"false"; false means private.'),
        roleId: z.union([z.string(), z.number()]).optional().describe('Optional role id for authenticated route permission.'),
        roleName: z.string().optional().describe('Optional role name for authenticated route permission, e.g. user.'),
        allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Optional user id scope for authenticated route permission.'),
        routePermissionDescription: z.string().optional().describe('Optional admin note for created/updated route permission.'),
        description: z.string().optional().describe('Route description.'),
        timeout: z.number().int().positive().optional().describe('Optional handler timeout in ms.'),
        overwrite: z.boolean().optional().default(false).describe('Required to update an existing handler whose sourceCode/scriptLanguage/timeout differs.'),
        smokeTestQuery: z.string().optional().describe('Optional query JSON object for a smoke test, e.g. {"a":"1","b":"2"}.'),
        smokeTestBody: z.string().optional().describe('Optional body JSON object for a smoke test.'),
        apply: z.boolean().optional().default(false).describe('false returns plan only; true applies exactly the next pending step.'),
        applyAll: z.boolean().optional().default(false).describe('true applies all safe pending steps in order. Prefer apply=true for production changes.'),
        stepId: z.string().optional().describe('Optional pending step id to apply. Omit to apply the next pending step.'),
        globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when apply/applyAll mutates metadata. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
        knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required when apply/applyAll reaches the save_handler step. Use dynamicCodeAckKey from get_enfyra_required_knowledge.'),
      },
      async (input) => jsonText(await runApiEndpointWorkflow(ENFYRA_API_URL, input)),
    );

  server.tool(
      'create_api_endpoint',
      [
        'Business operation: create or update a custom REST endpoint with a handler in one safe operation.',
        'Prefer api_endpoint_workflow when route access, role/user permissions, overwrite decisions, or multi-step planning matter.',
        'Use this one-shot helper only when the endpoint contract is already clear and no authenticated route-permission step is needed in the same operation, such as a simple public webhook or private admin-only utility that will be granted separately.',
        'It creates the route without mainTableId, ensures the method is available, validates sourceCode, creates or overwrites the route handler, optionally makes the method public, reloads routes, and can smoke-test the endpoint.',
        'For sourceCode, call discover_script_contexts first. Use #secure.table_name or @REPOS.secure.table_name for explicit user-facing table access; reserve #table_name/@REPOS.table_name for intentional trusted internal access.',
        'Use table/schema tools separately when the user needs persisted data. This tool is for custom behavior endpoints.',
      ].join(' '),
      {
        path: z.string().describe('Custom route path, e.g. /sum. Must not be a full URL.'),
        method: z.string().describe('HTTP method for the handler, e.g. GET or POST.'),
        sourceCode: z.string().describe('Handler body sourceCode for a custom route, which has no main table. Do not wrap it in export default/module.exports. Use #secure.table_name or @REPOS.secure.table_name for user-facing explicit-table access. Repository calls are async and reads return result.data. Passing @BODY as create/update data is valid TypeORM-style usage; enforce endpoint-specific owner/tenant/business rules in code. Reserve trusted repos for intentional field-permission bypass. Do not send compiledCode.'),
        scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
        public: z.preprocess(normalizeStrictBoolean, z.boolean()).optional().default(false).describe('When true, the method is added to publicMethods for anonymous access. Exact string "true"/"false" is normalized for weak clients.'),
        description: z.string().optional().describe('Route description.'),
        timeout: z.number().int().positive().optional().describe('Optional handler timeout in ms.'),
        overwrite: z.boolean().optional().default(false).describe('If a handler already exists for route+method, false fails; true updates its sourceCode.'),
        smokeTestQuery: z.string().optional().describe('Optional query JSON object for a smoke test after save, e.g. {"a":"1","b":"2"}.'),
        smokeTestBody: z.string().optional().describe('Optional body JSON object for a smoke test after save.'),
        globalRulesAckKey: globalRulesAckParam(z),
        knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
      },
      async ({ path, method, sourceCode, scriptLanguage, public: makePublic, description, timeout, overwrite, smokeTestQuery, smokeTestBody, globalRulesAckKey, knowledgeAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        assertDynamicCodeKnowledgeAck(knowledgeAckKey);
        const normalizedPath = normalizeRestPath(path);
        const methodName = normalizeMethodName(method);
        assertDynamicEndpointContract(reviewDynamicEndpointContract({
          routeKind: 'custom',
          method: methodName,
          sourceCode,
        }));
        const [{ methodMap, methodIdNameMap }, routes, scriptValidation, contractReview] = await Promise.all([
          getMethodContext(ENFYRA_API_URL),
          fetchAll(ENFYRA_API_URL, '/enfyra_route?limit=1000&fields=id,_id,path,isEnabled,availableMethods.*,publicMethods.*,mainTable.name'),
          validateScriptSourceIfPresent(fetchAPI, ENFYRA_API_URL, 'enfyra_route_handler', {
            sourceCode,
            scriptLanguage,
          }),
          reviewCustomEndpointSource(ENFYRA_API_URL, methodName, sourceCode),
        ]);
        const methodId = methodMap[methodName];
        if (!methodId) throw new Error(`Unknown method "${methodName}". Valid methods: ${Object.keys(methodMap).sort().join(', ')}`);
  
        let route = routes.find((item) => item.path === normalizedPath);
        assertCustomEndpointRoute(route);
        let routeAction = 'existing';
        if (!route) {
          const createRouteResult = await fetchAPI(ENFYRA_API_URL, '/enfyra_route', {
            method: 'POST',
            body: JSON.stringify({
              path: normalizedPath,
              description,
              isEnabled: true,
              availableMethods: [{ id: methodId }],
              publicMethods: makePublic ? [{ id: methodId }] : [],
            }),
          });
          route = firstDataRecord(createRouteResult);
          routeAction = 'created';
        } else {
          const availableMethods = methodNamesFromRecords(route.availableMethods, methodIdNameMap);
          const publicMethods = methodNamesFromRecords(route.publicMethods, methodIdNameMap);
          const finalAvailable = uniqueMethodNames([...availableMethods, methodName]);
          const finalPublic = makePublic ? uniqueMethodNames([...publicMethods, methodName]) : publicMethods;
          const patchRouteResult = await fetchAPI(ENFYRA_API_URL, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, {
            method: 'PATCH',
            body: JSON.stringify({
              availableMethods: resolveMethodRefs(methodMap, finalAvailable),
              publicMethods: resolveMethodRefs(methodMap, finalPublic.filter((item) => finalAvailable.includes(item))),
              ...(description !== undefined ? { description } : {}),
            }),
          });
          route = firstDataRecord(patchRouteResult) || route;
          routeAction = 'updated';
        }
  
        const routeId = getId(route);
        const existingHandler = await findHandler(ENFYRA_API_URL, routeId, methodId);
        let handlerResult;
        let handlerAction;
        if (existingHandler) {
          if (!overwrite) {
            throw new Error(`Handler already exists for ${methodName} ${normalizedPath} with id ${getId(existingHandler)}. Re-run with overwrite=true to update it.`);
          }
          handlerAction = 'updated';
          const body: HandlerBody = { sourceCode, scriptLanguage };
          if (timeout !== undefined) body.timeout = timeout;
          handlerResult = await fetchAPI(ENFYRA_API_URL, `/enfyra_route_handler/${encodeURIComponent(String(getId(existingHandler)))}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
        } else {
          handlerAction = 'created';
          const body: RouteHandlerBody = {
            route: { id: routeId },
            method: { id: methodId },
            sourceCode,
            scriptLanguage,
          };
          if (timeout !== undefined) body.timeout = timeout;
          handlerResult = await fetchAPI(ENFYRA_API_URL, '/enfyra_route_handler', {
            method: 'POST',
            body: JSON.stringify(body),
          });
        }
  
        const routeReload = await reloadRoutes(ENFYRA_API_URL);
        let smokeTest = null;
        if (smokeTestQuery !== undefined || smokeTestBody !== undefined) {
          const query = smokeTestQuery ? JSON.parse(smokeTestQuery) : {};
          if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('smokeTestQuery must be a JSON object.');
          const queryParams = new URLSearchParams();
          for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null) queryParams.set(key, String(value));
          }
          const body = smokeTestBody ? JSON.parse(smokeTestBody) : undefined;
          const smokePath = `${normalizedPath}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
          smokeTest = await fetchAPI(ENFYRA_API_URL, smokePath, {
            method: methodName,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
        }
  
        const savedHandler = firstDataRecord(handlerResult);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              action: 'api_endpoint_ready',
              endpoint: {
                path: normalizedPath,
                method: methodName,
                public: makePublic,
                routeId,
                handlerId: getId(savedHandler) || getId(existingHandler),
              },
              routeAction,
              handlerAction,
              scriptValidation,
              contractReview,
              routeReload,
              smokeTest,
              usage: {
                restPath: `${ENFYRA_API_URL.replace(/\/$/, '')}${normalizedPath}`,
                auth: makePublic ? 'anonymous allowed for this method' : 'Bearer auth and route access are required unless another guard bypass applies',
              },
            }, null, 2),
          }],
        };
      },
    );
}
