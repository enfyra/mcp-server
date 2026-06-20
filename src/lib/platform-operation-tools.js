import { z } from 'zod';

import { fetchAPI } from './fetch.js';
import { validateScriptSourceIfPresent } from './mutation-guards.js';

function unwrapData(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

function getId(record) {
  return record?.id ?? record?._id ?? null;
}

function refId(value) {
  return typeof value === 'object' && value !== null ? getId(value) : value;
}

function sameId(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function firstDataRecord(result) {
  return Array.isArray(result?.data) ? result.data[0] : result;
}

function normalizeRestPath(path) {
  if (!path) return '/';
  if (/^https?:\/\//i.test(path)) {
    throw new Error('Only Enfyra API paths are allowed, not full external URLs.');
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeMethodName(method) {
  const value = String(method || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid method "${method}". Method names must start with A-Z and contain only A-Z, 0-9, or underscore.`);
  }
  return value;
}

function methodNamesFromRecords(records, methodIdNameMap) {
  return (records || [])
    .map((method) => method?.name || methodIdNameMap[String(getId(method))] || null)
    .filter(Boolean)
    .map(normalizeMethodName);
}

function uniqueMethodNames(names) {
  return [...new Set((names || []).map(normalizeMethodName))];
}

function resolveMethodRefs(methodMap, names) {
  return uniqueMethodNames(names).map((name) => {
    const id = methodMap[name];
    if (!id) throw new Error(`Unknown method "${name}". Valid methods: ${Object.keys(methodMap).sort().join(', ')}`);
    return { id };
  });
}

function mergeMethods(existing, requested, mode) {
  const existingNames = uniqueMethodNames(existing);
  const requestedNames = uniqueMethodNames(requested);
  if (mode === 'replace') return requestedNames;
  if (mode === 'remove') return existingNames.filter((method) => !requestedNames.includes(method));
  return uniqueMethodNames([...existingNames, ...requestedNames]);
}

async function fetchAll(apiUrl, path) {
  return unwrapData(await fetchAPI(apiUrl, path));
}

async function getMethodContext(apiUrl) {
  const methods = await fetchAll(apiUrl, '/enfyra_method?limit=0&fields=id,_id,name');
  const methodMap = {};
  const methodIdNameMap = {};
  for (const method of methods) {
    if (!method?.name) continue;
    const name = normalizeMethodName(method.name);
    const id = getId(method);
    methodMap[name] = id;
    methodIdNameMap[String(id)] = name;
  }
  return { methods, methodMap, methodIdNameMap };
}

async function reloadRoutes(apiUrl) {
  try {
    const result = await fetchAPI(apiUrl, '/admin/reload/routes', { method: 'POST' });
    return { attempted: true, succeeded: true, result };
  } catch (error) {
    return { attempted: true, succeeded: false, error: error?.message || String(error) };
  }
}

async function resolveRoute(apiUrl, { path, routeId }) {
  if (!path && !routeId) throw new Error('Provide path or routeId.');
  if (path && routeId) throw new Error('Provide path or routeId, not both.');
  const routes = await fetchAll(apiUrl, '/enfyra_route?limit=1000&fields=id,_id,path,isEnabled,availableMethods.*,publicMethods.*,mainTable.name');
  const normalizedPath = path ? normalizeRestPath(path) : null;
  const route = routes.find((item) => (routeId ? sameId(getId(item), routeId) : item.path === normalizedPath));
  if (!route) throw new Error(`Route not found: ${routeId || normalizedPath}`);
  return { route, routes, path: route.path };
}

async function findHandler(apiUrl, routeId, methodId) {
  const filter = encodeURIComponent(JSON.stringify({
    route: { id: { _eq: routeId } },
    method: { id: { _eq: methodId } },
  }));
  const result = await fetchAPI(apiUrl, `/enfyra_route_handler?filter=${filter}&limit=1&fields=id,_id,route.id,method.id,method.name,sourceCode,scriptLanguage,timeout`);
  return unwrapData(result)[0] || null;
}

function jsonText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function parseJsonObjectArg(name, value, fallback = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return parsed;
}

function parseJsonArrayArg(name, value, fallback = []) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array.`);
  }
  return parsed;
}

function filterQuery(filter) {
  return encodeURIComponent(JSON.stringify(filter));
}

async function reloadBestEffort(apiUrl, path) {
  try {
    const result = await fetchAPI(apiUrl, path, { method: 'POST' });
    return { attempted: true, succeeded: true, result };
  } catch (error) {
    return { attempted: true, succeeded: false, error: error?.message || String(error) };
  }
}

async function validateDynamicScript(apiUrl, sourceCode, scriptLanguage = 'javascript') {
  const result = await fetchAPI(apiUrl, '/admin/script/validate', {
    method: 'POST',
    body: JSON.stringify({ sourceCode, scriptLanguage }),
  });
  if (result?.valid === false || result?.success === false) {
    throw new Error(result?.error?.message || 'Dynamic script validation failed.');
  }
  return {
    valid: true,
    scriptLanguage,
    compiledLength: typeof result?.data?.compiledCode === 'string' ? result.data.compiledCode.length : undefined,
  };
}

async function validateExtensionCode(apiUrl, code, name) {
  const result = await fetchAPI(apiUrl, '/enfyra_extension/preview', {
    method: 'POST',
    body: JSON.stringify({ code, name }),
  });
  if (result?.success === false) {
    throw new Error(result?.error?.message || 'Extension validation failed.');
  }
  return {
    valid: true,
    extensionId: result?.extensionId || name || null,
    compiledLength: typeof result?.compiledCode === 'string' ? result.compiledCode.length : undefined,
  };
}

function normalizeMetadataTables(metadata) {
  const tables = metadata?.data?.tables || metadata?.tables || metadata?.data || [];
  return Array.isArray(tables) ? tables : Object.values(tables || {});
}

async function getMetadataTables(apiUrl) {
  return normalizeMetadataTables(await fetchAPI(apiUrl, '/metadata'));
}

function resolveTable(tables, tableName) {
  const table = tables.find((item) => item?.name === tableName || item?.alias === tableName || sameId(getId(item), tableName));
  if (!table) throw new Error(`Table not found: ${tableName}`);
  return table;
}

function resolveColumn(table, columnName) {
  const column = (table.columns || []).find((item) => item?.name === columnName || sameId(getId(item), columnName));
  if (!column) throw new Error(`Column not found: ${table.name}.${columnName}`);
  return column;
}

function resolveRelation(table, relationName) {
  const relation = (table.relations || []).find((item) => item?.propertyName === relationName || item?.name === relationName || sameId(getId(item), relationName));
  if (!relation) throw new Error(`Relation not found: ${table.name}.${relationName}`);
  return relation;
}

async function findRecord(apiUrl, tableName, filter, fields = '*') {
  const result = await fetchAPI(apiUrl, `/${tableName}?filter=${filterQuery(filter)}&limit=1&fields=${encodeURIComponent(fields)}`);
  return unwrapData(result)[0] || null;
}

async function fetchRecords(apiUrl, tableName, filter, fields = '*', limit = 1000) {
  const result = await fetchAPI(apiUrl, `/${tableName}?filter=${filterQuery(filter)}&limit=${limit}&fields=${encodeURIComponent(fields)}`);
  return unwrapData(result);
}

async function createOrPatch(apiUrl, tableName, existing, body) {
  if (existing) {
    const result = await fetchAPI(apiUrl, `/${tableName}/${encodeURIComponent(String(getId(existing)))}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return { action: 'updated', result, id: getId(firstDataRecord(result)) || getId(existing) };
  }
  const result = await fetchAPI(apiUrl, `/${tableName}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { action: 'created', result, id: getId(firstDataRecord(result)) };
}

async function resolveRole(apiUrl, { roleId, roleName }) {
  if (roleId && roleName) throw new Error('Provide roleId or roleName, not both.');
  if (!roleId && !roleName) return null;
  if (roleId) return { id: roleId, name: null };
  const role = await findRecord(apiUrl, 'enfyra_role', { name: { _eq: roleName } }, 'id,_id,name');
  if (!role) throw new Error(`Role not found: ${roleName}`);
  return { id: getId(role), name: role.name };
}

function assertOneScope({ roleId, roleName, allowedUserIds }) {
  if (!roleId && !roleName && (!allowedUserIds || allowedUserIds.length === 0)) {
    throw new Error('Provide roleId, roleName, or allowedUserIds.');
  }
}

function normalizeFlowStepBody(step, flowId) {
  const body = {
    key: step.key,
    type: step.type,
    order: step.order ?? 0,
    config: step.config ?? {},
    timeout: step.timeout,
    isEnabled: step.isEnabled ?? true,
    description: step.description,
    flow: { id: flowId },
  };
  if (step.sourceCode !== undefined) body.sourceCode = step.sourceCode;
  if (step.scriptLanguage !== undefined) body.scriptLanguage = step.scriptLanguage;
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

export function registerPlatformOperationTools(server, ENFYRA_API_URL) {
  server.tool(
    'validate_dynamic_script',
    [
      'Validate Enfyra dynamic script code before saving it to any script-backed metadata record.',
      'Use this before create/update of handlers, hooks, flow steps, websocket scripts, GraphQL scripts, or bootstrap scripts when the user is iterating on code.',
      'This calls the same server compiler contract used by Enfyra, but does not save anything.',
    ].join(' '),
    {
      sourceCode: z.string().describe('Raw dynamic script sourceCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language to validate.'),
    },
    async ({ sourceCode, scriptLanguage }) => jsonText({
      action: 'dynamic_script_validated',
      validation: await validateDynamicScript(ENFYRA_API_URL, sourceCode, scriptLanguage),
    }),
  );

  server.tool(
    'validate_extension_code',
    [
      'Validate Enfyra admin extension code before saving it to enfyra_extension.',
      'Use this for Vue SFC page/widget/global extension code. It calls /enfyra_extension/preview and does not save anything.',
    ].join(' '),
    {
      code: z.string().describe('Vue SFC or compiled extension bundle code.'),
      name: z.string().optional().describe('Optional extension name/id used by the preview compiler.'),
    },
    async ({ code, name }) => jsonText({
      action: 'extension_code_validated',
      validation: await validateExtensionCode(ENFYRA_API_URL, code, name),
    }),
  );

  server.tool(
    'set_table_graphql',
    'Business operation: enable or disable GraphQL for one table through enfyra_graphql, then reload GraphQL. REST route methods do not control GraphQL.',
    {
      tableName: z.string().describe('Table name, alias, or id.'),
      isEnabled: z.boolean().describe('Desired GraphQL enabled state for the table.'),
    },
    async ({ tableName, isEnabled }) => {
      const table = resolveTable(await getMetadataTables(ENFYRA_API_URL), tableName);
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
    'ensure_route_methods',
    [
      'Business operation: set which HTTP methods a route supports.',
      'Use this instead of raw enfyra_route CRUD when adding/removing availableMethods on an existing route.',
      'It resolves method ids, preserves route metadata, patches availableMethods, and reloads routes.',
    ].join(' '),
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      methods: z.array(z.string()).min(1).describe('HTTP method names to merge, replace, or remove.'),
      mode: z.enum(['merge', 'replace', 'remove']).optional().default('merge').describe('merge adds methods; replace sets exactly these methods; remove deletes these methods.'),
      isEnabled: z.boolean().optional().describe('Optionally enable/disable the route in the same safe patch.'),
    },
    async ({ path, routeId, methods, mode, isEnabled }) => {
      const [{ route }, { methodMap, methodIdNameMap }] = await Promise.all([
        resolveRoute(ENFYRA_API_URL, { path, routeId }),
        getMethodContext(ENFYRA_API_URL),
      ]);
      const existingAvailable = methodNamesFromRecords(route.availableMethods, methodIdNameMap);
      const existingPublic = methodNamesFromRecords(route.publicMethods, methodIdNameMap);
      const finalAvailable = mergeMethods(existingAvailable, methods, mode);
      const finalPublic = existingPublic.filter((method) => finalAvailable.includes(method));
      const body = {
        availableMethods: resolveMethodRefs(methodMap, finalAvailable),
        publicMethods: resolveMethodRefs(methodMap, finalPublic),
      };
      if (isEnabled !== undefined) body.isEnabled = isEnabled;

      const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const routeReload = await reloadRoutes(ENFYRA_API_URL);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            action: 'route_methods_updated',
            route: { id: getId(route), path: route.path },
            before: { availableMethods: existingAvailable, publicMethods: existingPublic },
            after: { availableMethods: finalAvailable, publicMethods: finalPublic },
            result,
            routeReload,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'set_route_public_methods',
    [
      'Business operation: publish or unpublish REST methods on a route.',
      'Use this instead of raw enfyra_route CRUD when the user says a route/method should be public, anonymous, private, or not require login.',
      'The tool only touches publicMethods, validates that requested methods are already available on the route, and reloads routes.',
    ].join(' '),
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      methods: z.array(z.string()).min(1).describe('HTTP method names to publish, replace, or remove from publicMethods.'),
      mode: z.enum(['merge', 'replace', 'remove']).optional().default('merge').describe('merge publishes methods; replace sets publicMethods exactly; remove makes these methods non-public.'),
    },
    async ({ path, routeId, methods, mode }) => {
      const [{ route }, { methodMap, methodIdNameMap }] = await Promise.all([
        resolveRoute(ENFYRA_API_URL, { path, routeId }),
        getMethodContext(ENFYRA_API_URL),
      ]);
      const availableMethods = methodNamesFromRecords(route.availableMethods, methodIdNameMap);
      const existingPublic = methodNamesFromRecords(route.publicMethods, methodIdNameMap);
      const requestedMethods = uniqueMethodNames(methods);
      const unavailable = requestedMethods.filter((method) => !availableMethods.includes(method));
      if (unavailable.length > 0) {
        throw new Error(`Cannot make unavailable route method(s) public: ${unavailable.join(', ')}. First call ensure_route_methods to add them to availableMethods.`);
      }
      const finalPublic = mergeMethods(existingPublic, requestedMethods, mode);
      const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, {
        method: 'PATCH',
        body: JSON.stringify({ publicMethods: resolveMethodRefs(methodMap, finalPublic) }),
      });
      const routeReload = await reloadRoutes(ENFYRA_API_URL);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            action: 'route_public_methods_updated',
            route: { id: getId(route), path: route.path },
            availableMethods,
            publicMethodsBefore: existingPublic,
            publicMethodsAfter: finalPublic,
            publicAccess: finalPublic.length > 0 ? 'Methods listed in publicMethods bypass auth/RoleGuard.' : 'No public methods remain on this route.',
            result,
            routeReload,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'create_api_endpoint',
    [
      'Business operation: create or update a custom REST endpoint with a handler in one safe operation.',
      'Use this when the user asks for a new route/endpoint/API path that computes or orchestrates behavior, such as GET /sum or POST /webhook.',
      'It creates the route without mainTableId, ensures the method is available, validates sourceCode, creates or overwrites the route handler, optionally publishes the method, reloads routes, and can smoke-test the endpoint.',
      'Use table/schema tools separately when the user needs persisted data. This tool is for custom behavior endpoints.',
    ].join(' '),
    {
      path: z.string().describe('Custom route path, e.g. /sum. Must not be a full URL.'),
      method: z.string().describe('HTTP method for the handler, e.g. GET or POST.'),
      sourceCode: z.string().describe('Handler sourceCode. Use macros such as @QUERY, @BODY, @THROW400, @REPOS, @USER. Do not send compiledCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      public: z.boolean().optional().default(false).describe('When true, the method is added to publicMethods for anonymous access.'),
      description: z.string().optional().describe('Route description.'),
      timeout: z.number().int().positive().optional().describe('Optional handler timeout in ms.'),
      overwrite: z.boolean().optional().default(false).describe('If a handler already exists for route+method, false fails; true updates its sourceCode.'),
      smokeTestQuery: z.string().optional().describe('Optional query JSON object for a smoke test after save, e.g. {"a":"1","b":"2"}.'),
      smokeTestBody: z.string().optional().describe('Optional body JSON object for a smoke test after save.'),
    },
    async ({ path, method, sourceCode, scriptLanguage, public: makePublic, description, timeout, overwrite, smokeTestQuery, smokeTestBody }) => {
      const normalizedPath = normalizeRestPath(path);
      const methodName = normalizeMethodName(method);
      const { methodMap, methodIdNameMap } = await getMethodContext(ENFYRA_API_URL);
      const methodId = methodMap[methodName];
      if (!methodId) throw new Error(`Unknown method "${methodName}". Valid methods: ${Object.keys(methodMap).sort().join(', ')}`);

      const routes = await fetchAll(ENFYRA_API_URL, '/enfyra_route?limit=1000&fields=id,_id,path,isEnabled,availableMethods.*,publicMethods.*,mainTable.name');
      let route = routes.find((item) => item.path === normalizedPath);
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
      const scriptValidation = await validateScriptSourceIfPresent(fetchAPI, ENFYRA_API_URL, 'enfyra_route_handler', {
        sourceCode,
        scriptLanguage,
      });
      const existingHandler = await findHandler(ENFYRA_API_URL, routeId, methodId);
      let handlerResult;
      let handlerAction;
      if (existingHandler) {
        if (!overwrite) {
          throw new Error(`Handler already exists for ${methodName} ${normalizedPath} with id ${getId(existingHandler)}. Re-run with overwrite=true to update it.`);
        }
        handlerAction = 'updated';
        const body = { sourceCode, scriptLanguage };
        if (timeout !== undefined) body.timeout = timeout;
        handlerResult = await fetchAPI(ENFYRA_API_URL, `/enfyra_route_handler/${encodeURIComponent(String(getId(existingHandler)))}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        handlerAction = 'created';
        const body = {
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

  server.tool(
    'ensure_column_rule',
    'Business operation: create or update a column validation rule. It resolves table/column ids and avoids duplicate rules for the same column+ruleType.',
    {
      tableName: z.string().describe('Table name, alias, or id.'),
      columnName: z.string().describe('Column name or id.'),
      ruleType: z.enum(['min', 'max', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'custom']).describe('Validation rule type.'),
      value: z.string().optional().describe('Rule config JSON object, usually {"v": ...}.'),
      message: z.string().optional().describe('Custom validation error message.'),
      description: z.string().optional().describe('Admin note.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable the rule.'),
    },
    async ({ tableName, columnName, ruleType, value, message, description, isEnabled }) => {
      const table = resolveTable(await getMetadataTables(ENFYRA_API_URL), tableName);
      const column = resolveColumn(table, columnName);
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_column_rule', {
        column: { id: { _eq: getId(column) } },
        ruleType: { _eq: ruleType },
      }, 'id,_id,column.id,ruleType');
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_column_rule', existing, {
        column: { id: getId(column) },
        ruleType,
        value: parseJsonObjectArg('value', value, null),
        message,
        description,
        isEnabled,
      });
      return jsonText({
        action: 'column_rule_ensured',
        table: { id: getId(table), name: table.name },
        column: { id: getId(column), name: column.name },
        ruleType,
        operation,
      });
    },
  );

  server.tool(
    'ensure_field_permission',
    'Business operation: create or update one field permission. It resolves table field ids, enforces exactly one column/relation target, and enforces a role/user scope.',
    {
      tableName: z.string().describe('Table name, alias, or id.'),
      columnName: z.string().optional().describe('Column name/id to protect. Use exactly one of columnName or relationName.'),
      relationName: z.string().optional().describe('Relation propertyName/id to protect. Use exactly one of columnName or relationName.'),
      action: z.enum(['read', 'create', 'update']).optional().default('read').describe('Field action.'),
      effect: z.enum(['allow', 'deny']).optional().default('allow').describe('Permission effect.'),
      roleId: z.union([z.string(), z.number()]).optional().describe('Role id scope.'),
      roleName: z.string().optional().describe('Role name scope.'),
      allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Direct user id scope.'),
      condition: z.string().optional().describe('Condition JSON object using field permission DSL.'),
      description: z.string().optional().describe('Admin note.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable the permission.'),
    },
    async ({ tableName, columnName, relationName, action, effect, roleId, roleName, allowedUserIds, condition, description, isEnabled }) => {
      if (!!columnName === !!relationName) throw new Error('Provide exactly one of columnName or relationName.');
      assertOneScope({ roleId, roleName, allowedUserIds });
      const [tables, role] = await Promise.all([
        getMetadataTables(ENFYRA_API_URL),
        resolveRole(ENFYRA_API_URL, { roleId, roleName }),
      ]);
      const table = resolveTable(tables, tableName);
      const field = columnName ? resolveColumn(table, columnName) : resolveRelation(table, relationName);
      const filter = {
        action: { _eq: action },
        effect: { _eq: effect },
        ...(columnName ? { column: { id: { _eq: getId(field) } } } : { relation: { id: { _eq: getId(field) } } }),
        ...(role ? { role: { id: { _eq: role.id } } } : {}),
      };
      const existing = role
        ? await findRecord(ENFYRA_API_URL, 'enfyra_field_permission', filter, 'id,_id,column.id,relation.id,role.id,action,effect')
        : null;
      const body = {
        action,
        effect,
        isEnabled,
        description,
        condition: parseJsonObjectArg('condition', condition, null),
        ...(columnName ? { column: { id: getId(field) } } : { relation: { id: getId(field) } }),
        ...(role ? { role: { id: role.id } } : {}),
        ...(allowedUserIds?.length ? { allowedUsers: allowedUserIds.map((id) => ({ id })) } : {}),
      };
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_field_permission', existing, body);
      const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/metadata');
      return jsonText({
        action: 'field_permission_ensured',
        table: { id: getId(table), name: table.name },
        field: { id: getId(field), name: columnName ? field.name : field.propertyName, kind: columnName ? 'column' : 'relation' },
        scope: { role, allowedUserIds: allowedUserIds || [] },
        operation,
        reload,
      });
    },
  );

  server.tool(
    'ensure_guard',
    'Business operation: create or update a request guard and optional guard rules. It resolves route/method ids and prevents pre_auth user-based rules.',
    {
      name: z.string().describe('Guard name. Existing guard with this name is updated unless guardId is provided.'),
      guardId: z.union([z.string(), z.number()]).optional().describe('Optional existing guard id.'),
      position: z.enum(['pre_auth', 'post_auth']).optional().default('pre_auth').describe('Guard position.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Optional route id.'),
      path: z.string().optional().describe('Optional route path.'),
      methods: z.array(z.string()).optional().describe('HTTP method names.'),
      combinator: z.enum(['and', 'or']).optional().default('and').describe('Rule combinator.'),
      priority: z.number().optional().default(0).describe('Lower runs earlier.'),
      isGlobal: z.boolean().optional().default(false).describe('Apply globally.'),
      isEnabled: z.boolean().optional().default(false).describe('Enable guard. Defaults false to avoid lockout.'),
      description: z.string().optional().describe('Admin note.'),
      rules: z.string().optional().describe('Rules JSON array: [{type, config, priority, isEnabled, description, userIds}].'),
      rulesMode: z.enum(['append', 'replace', 'none']).optional().default('append').describe('append creates rules, replace disables existing rules first, none leaves rules unchanged.'),
    },
    async ({ name, guardId, position, routeId, path, methods, combinator, priority, isGlobal, isEnabled, description, rules, rulesMode }) => {
      if (path && routeId) throw new Error('Provide path or routeId, not both.');
      const ruleInputs = parseJsonArrayArg('rules', rules, []);
      if (position === 'pre_auth') {
        const invalid = ruleInputs.filter((rule) => rule.type === 'rate_limit_by_user' || (Array.isArray(rule.userIds) && rule.userIds.length));
        if (invalid.length) throw new Error('pre_auth guards cannot use user-based rules or userIds. Use post_auth.');
      }
      let route = null;
      if (!isGlobal && (routeId || path)) {
        route = (await resolveRoute(ENFYRA_API_URL, { path, routeId })).route;
      }
      const { methodMap } = await getMethodContext(ENFYRA_API_URL);
      const existing = guardId
        ? await findRecord(ENFYRA_API_URL, 'enfyra_guard', { id: { _eq: guardId } }, 'id,_id,name')
        : await findRecord(ENFYRA_API_URL, 'enfyra_guard', { name: { _eq: name } }, 'id,_id,name');
      const guardBody = {
        name,
        position,
        combinator,
        priority,
        isGlobal,
        isEnabled,
        description,
        ...(route ? { route: { id: getId(route) } } : {}),
        ...(methods?.length ? { methods: resolveMethodRefs(methodMap, methods) } : {}),
      };
      const guardOperation = await createOrPatch(ENFYRA_API_URL, 'enfyra_guard', existing, guardBody);
      const resolvedGuardId = guardOperation.id || getId(existing);
      const existingRules = rulesMode === 'replace'
        ? await fetchRecords(ENFYRA_API_URL, 'enfyra_guard_rule', { guard: { id: { _eq: resolvedGuardId } } }, 'id,_id,isEnabled')
        : [];
      const disabledRules = [];
      for (const rule of existingRules) {
        disabledRules.push(await fetchAPI(ENFYRA_API_URL, `/enfyra_guard_rule/${encodeURIComponent(String(getId(rule)))}`, {
          method: 'PATCH',
          body: JSON.stringify({ isEnabled: false }),
        }));
      }
      const createdRules = [];
      if (rulesMode !== 'none') {
        for (const rule of ruleInputs) {
          createdRules.push(await fetchAPI(ENFYRA_API_URL, '/enfyra_guard_rule', {
            method: 'POST',
            body: JSON.stringify({
              type: rule.type,
              config: rule.config,
              priority: rule.priority ?? 0,
              isEnabled: rule.isEnabled ?? true,
              description: rule.description,
              guard: { id: resolvedGuardId },
              ...(Array.isArray(rule.userIds) && rule.userIds.length ? { users: rule.userIds.map((id) => ({ id })) } : {}),
            }),
          }));
        }
      }
      const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/guards');
      return jsonText({
        action: 'guard_ensured',
        guard: { id: resolvedGuardId, name, route: route ? route.path : null, isGlobal },
        guardOperation,
        disabledRuleCount: disabledRules.length,
        createdRuleCount: createdRules.length,
        reload,
      });
    },
  );

  server.tool(
    'ensure_websocket_gateway',
    'Business operation: create or update an Enfyra Socket.IO gateway. Connection handler code is validated before save.',
    {
      path: z.string().describe('Gateway namespace/path, e.g. /chat.'),
      connectionHandlerScript: z.string().optional().describe('Optional connection handler dynamic script.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language for connection handler.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable gateway.'),
      description: z.string().optional().describe('Admin note.'),
    },
    async ({ path, connectionHandlerScript, scriptLanguage, isEnabled, description }) => {
      const normalizedPath = normalizeRestPath(path);
      const validation = connectionHandlerScript === undefined
        ? { validated: false, reason: 'no connectionHandlerScript' }
        : await validateDynamicScript(ENFYRA_API_URL, connectionHandlerScript, scriptLanguage);
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { path: { _eq: normalizedPath } }, 'id,_id,path');
      const body = {
        path: normalizedPath,
        isEnabled,
        description,
        ...(connectionHandlerScript !== undefined ? { connectionHandlerScript, scriptLanguage } : {}),
      };
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_websocket', existing, body);
      const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/websockets');
      return jsonText({ action: 'websocket_gateway_ensured', gateway: { id: operation.id, path: normalizedPath }, validation, operation, reload });
    },
  );

  server.tool(
    'ensure_websocket_event',
    'Business operation: create or update one websocket event handler. It resolves gateway path/id and validates handlerScript before save.',
    {
      gatewayPath: z.string().optional().describe('Gateway path, e.g. /chat. Use gatewayPath or gatewayId.'),
      gatewayId: z.union([z.string(), z.number()]).optional().describe('Gateway id. Use gatewayPath or gatewayId.'),
      eventName: z.string().describe('Socket event name.'),
      handlerScript: z.string().describe('Event handler dynamic script.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable event.'),
      description: z.string().optional().describe('Admin note.'),
    },
    async ({ gatewayPath, gatewayId, eventName, handlerScript, scriptLanguage, isEnabled, description }) => {
      if (!gatewayPath && !gatewayId) throw new Error('Provide gatewayPath or gatewayId.');
      if (gatewayPath && gatewayId) throw new Error('Provide gatewayPath or gatewayId, not both.');
      const gateway = gatewayId
        ? await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { id: { _eq: gatewayId } }, 'id,_id,path')
        : await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { path: { _eq: normalizeRestPath(gatewayPath) } }, 'id,_id,path');
      if (!gateway) throw new Error(`Websocket gateway not found: ${gatewayId || gatewayPath}`);
      const validation = await validateDynamicScript(ENFYRA_API_URL, handlerScript, scriptLanguage);
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_websocket_event', {
        gateway: { id: { _eq: getId(gateway) } },
        eventName: { _eq: eventName },
      }, 'id,_id,eventName,gateway.id');
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_websocket_event', existing, {
        gateway: { id: getId(gateway) },
        eventName,
        handlerScript,
        scriptLanguage,
        isEnabled,
        description,
      });
      const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/websockets');
      return jsonText({ action: 'websocket_event_ensured', gateway: { id: getId(gateway), path: gateway.path }, eventName, validation, operation, reload });
    },
  );

  server.tool(
    'ensure_flow',
    'Business operation: create or update an Enfyra flow. maxExecutions defaults to 100 when omitted.',
    {
      name: z.string().describe('Flow name. Existing flow with this name is updated.'),
      trigger: z.string().optional().describe('Flow trigger type/key.'),
      timeout: z.number().int().positive().optional().describe('Flow timeout in ms.'),
      maxExecutions: z.number().int().positive().optional().default(100).describe('Execution history cap.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable flow.'),
      description: z.string().optional().describe('Admin note.'),
    },
    async ({ name, trigger, timeout, maxExecutions, isEnabled, description }) => {
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_flow', { name: { _eq: name } }, 'id,_id,name');
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_flow', existing, {
        name,
        trigger,
        timeout,
        maxExecutions,
        isEnabled,
        description,
      });
      const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/flows');
      return jsonText({ action: 'flow_ensured', flow: { id: operation.id, name }, operation, reload });
    },
  );

  server.tool(
    'ensure_flow_step',
    'Business operation: create or update one flow step by flow+key. Script/condition sourceCode is validated before save.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      type: z.string().describe('Step type, e.g. script, condition, query, http, sleep, trigger_flow.'),
      order: z.number().optional().default(0).describe('Step order.'),
      config: z.string().optional().describe('Step config JSON object.'),
      sourceCode: z.string().optional().describe('Script/condition sourceCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      description: z.string().optional().describe('Admin note.'),
    },
    async ({ flowName, flowId, key, type, order, config, sourceCode, scriptLanguage, timeout, isEnabled, description }) => {
      if (!flowName && !flowId) throw new Error('Provide flowName or flowId.');
      if (flowName && flowId) throw new Error('Provide flowName or flowId, not both.');
      const flow = flowId
        ? await findRecord(ENFYRA_API_URL, 'enfyra_flow', { id: { _eq: flowId } }, 'id,_id,name')
        : await findRecord(ENFYRA_API_URL, 'enfyra_flow', { name: { _eq: flowName } }, 'id,_id,name');
      if (!flow) throw new Error(`Flow not found: ${flowId || flowName}`);
      const parsedConfig = parseJsonObjectArg('config', config, {});
      const validation = sourceCode && ['script', 'condition'].includes(type)
        ? await validateDynamicScript(ENFYRA_API_URL, sourceCode, scriptLanguage)
        : { validated: false, reason: 'no script validation required' };
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_flow_step', {
        flow: { id: { _eq: getId(flow) } },
        key: { _eq: key },
      }, 'id,_id,key,flow.id');
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_flow_step', existing, normalizeFlowStepBody({
        key,
        type,
        order,
        config: parsedConfig,
        sourceCode,
        scriptLanguage,
        timeout,
        isEnabled,
        description,
      }, getId(flow)));
      const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/flows');
      return jsonText({ action: 'flow_step_ensured', flow: { id: getId(flow), name: flow.name }, step: { id: operation.id, key, type }, validation, operation, reload });
    },
  );

  server.tool(
    'ensure_menu_extension_page',
    'Business operation: create or update a page extension and its menu item together. Extension code is validated before save.',
    {
      name: z.string().describe('Extension unique name.'),
      code: z.string().describe('Vue SFC extension code.'),
      menuLabel: z.string().describe('Menu label.'),
      menuPath: z.string().describe('Admin app path, e.g. /reports.'),
      icon: z.string().optional().describe('Menu icon name.'),
      permission: z.string().optional().describe('Menu permission JSON object.'),
      description: z.string().optional().describe('Description for menu/extension.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable menu and extension.'),
      version: z.string().optional().default('1.0.0').describe('Extension version.'),
    },
    async ({ name, code, menuLabel, menuPath, icon, permission, description, isEnabled, version }) => {
      const validation = await validateExtensionCode(ENFYRA_API_URL, code, name);
      const normalizedPath = normalizeRestPath(menuPath);
      const existingMenu = await findRecord(ENFYRA_API_URL, 'enfyra_menu', { path: { _eq: normalizedPath } }, 'id,_id,path,label');
      const menuOperation = await createOrPatch(ENFYRA_API_URL, 'enfyra_menu', existingMenu, {
        label: menuLabel,
        path: normalizedPath,
        icon,
        type: 'Menu',
        permission: parseJsonObjectArg('permission', permission, undefined),
        description,
        isEnabled,
      });
      const existingExtension = await findRecord(ENFYRA_API_URL, 'enfyra_extension', { name: { _eq: name } }, 'id,_id,name,menu.id');
      const extensionOperation = await createOrPatch(ENFYRA_API_URL, 'enfyra_extension', existingExtension, {
        name,
        type: 'page',
        code,
        menu: { id: menuOperation.id || getId(existingMenu) },
        description,
        isEnabled,
        version,
      });
      return jsonText({
        action: 'menu_extension_page_ensured',
        menu: { id: menuOperation.id || getId(existingMenu), path: normalizedPath, action: menuOperation.action },
        extension: { id: extensionOperation.id || getId(existingExtension), name, action: extensionOperation.action },
        validation,
      });
    },
  );
}
