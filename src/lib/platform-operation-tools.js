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

async function updateRouteMethods(apiUrl, { path, routeId, methods, mode, isEnabled }) {
  const [{ route }, { methodMap, methodIdNameMap }] = await Promise.all([
    resolveRoute(apiUrl, { path, routeId }),
    getMethodContext(apiUrl),
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

  const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const routeReload = await reloadRoutes(apiUrl);
  return {
    action: 'route_methods_updated',
    route: { id: getId(route), path: route.path },
    before: { availableMethods: existingAvailable, publicMethods: existingPublic },
    after: { availableMethods: finalAvailable, publicMethods: finalPublic },
    result,
    routeReload,
  };
}

async function updateRoutePublicMethods(apiUrl, { path, routeId, methods, mode }) {
  const [{ route }, { methodMap, methodIdNameMap }] = await Promise.all([
    resolveRoute(apiUrl, { path, routeId }),
    getMethodContext(apiUrl),
  ]);
  const availableMethods = methodNamesFromRecords(route.availableMethods, methodIdNameMap);
  const existingPublic = methodNamesFromRecords(route.publicMethods, methodIdNameMap);
  const requestedMethods = uniqueMethodNames(methods);
  const unavailable = requestedMethods.filter((method) => !availableMethods.includes(method));
  if (unavailable.length > 0) {
    throw new Error(`Cannot make unavailable route method(s) public: ${unavailable.join(', ')}. First call add_route_methods to add them to availableMethods.`);
  }
  const finalPublic = mergeMethods(existingPublic, requestedMethods, mode);
  const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, {
    method: 'PATCH',
    body: JSON.stringify({ publicMethods: resolveMethodRefs(methodMap, finalPublic) }),
  });
  const routeReload = await reloadRoutes(apiUrl);
  return {
    action: 'route_public_methods_updated',
    route: { id: getId(route), path: route.path },
    availableMethods,
    publicMethodsBefore: existingPublic,
    publicMethodsAfter: finalPublic,
    publicAccess: finalPublic.length > 0 ? 'Methods listed in publicMethods bypass auth/RoleGuard.' : 'No public methods remain on this route.',
    result,
    routeReload,
  };
}

async function setRouteEnabled(apiUrl, { path, routeId, isEnabled }) {
  const { route } = await resolveRoute(apiUrl, { path, routeId });
  const before = route?.isEnabled !== false;
  if (before === isEnabled) {
    return {
      action: isEnabled ? 'route_already_enabled' : 'route_already_disabled',
      route: { id: getId(route), path: route.path },
      before: { isEnabled: before },
      after: { isEnabled },
      runtimeBehavior: isEnabled ? 'Enabled routes are registered at runtime.' : 'Disabled routes are not registered at runtime and return 404.',
      routeReload: { attempted: false, succeeded: true, reason: 'No route lifecycle change was needed.' },
    };
  }

  const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, {
    method: 'PATCH',
    body: JSON.stringify({ isEnabled }),
  });
  const routeReload = await reloadRoutes(apiUrl);
  return {
    action: isEnabled ? 'route_enabled' : 'route_disabled',
    route: { id: getId(route), path: route.path },
    before: { isEnabled: before },
    after: { isEnabled },
    runtimeBehavior: isEnabled ? 'The route should now be registered at runtime.' : 'The route should now return 404 because disabled routes are not registered at runtime.',
    result,
    routeReload,
  };
}

async function fetchRouteDependencies(apiUrl, routeId) {
  const routeFilter = filterQuery({ route: { id: { _eq: routeId } } });
  const routeIdFilter = filterQuery({ routeId: { _eq: routeId } });
  const [handlers, permissions, preHooks, postHooks, guards] = await Promise.all([
    fetchAll(apiUrl, `/enfyra_route_handler?filter=${routeIdFilter}&fields=id,_id,routeId,method.name&limit=0`),
    fetchAll(apiUrl, `/enfyra_route_permission?filter=${routeFilter}&fields=id,_id,route.id,role.name,isEnabled&limit=0`),
    fetchAll(apiUrl, `/enfyra_pre_hook?filter=${routeFilter}&fields=id,_id,route.id,name,isEnabled&limit=0`),
    fetchAll(apiUrl, `/enfyra_post_hook?filter=${routeFilter}&fields=id,_id,route.id,name,isEnabled&limit=0`),
    fetchAll(apiUrl, `/enfyra_guard?filter=${routeFilter}&fields=id,_id,route.id,name,isEnabled&limit=0`),
  ]);
  return { handlers, permissions, preHooks, postHooks, guards };
}

function summarizeRouteDependencies(dependencies) {
  return {
    handlers: dependencies.handlers.map((item) => ({ id: getId(item), method: item?.method?.name || null })),
    permissions: dependencies.permissions.map((item) => ({ id: getId(item), role: item?.role?.name || null, isEnabled: item?.isEnabled !== false })),
    preHooks: dependencies.preHooks.map((item) => ({ id: getId(item), name: item?.name || null, isEnabled: item?.isEnabled !== false })),
    postHooks: dependencies.postHooks.map((item) => ({ id: getId(item), name: item?.name || null, isEnabled: item?.isEnabled !== false })),
    guards: dependencies.guards.map((item) => ({ id: getId(item), name: item?.name || null, isEnabled: item?.isEnabled !== false })),
  };
}

async function deleteRows(apiUrl, tableName, rows) {
  const deleted = [];
  for (const row of rows) {
    const id = getId(row);
    if (id === null || id === undefined) continue;
    await fetchAPI(apiUrl, `/${tableName}/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
    deleted.push(id);
  }
  return deleted;
}

async function deleteRoute(apiUrl, { path, routeId, expectedPath, confirm }) {
  const { route } = await resolveRoute(apiUrl, { path, routeId });
  if (expectedPath && route.path !== normalizeRestPath(expectedPath)) {
    throw new Error(`Route path mismatch: resolved ${route.path}, expected ${normalizeRestPath(expectedPath)}.`);
  }

  const dependencies = await fetchRouteDependencies(apiUrl, getId(route));
  const dependencySummary = summarizeRouteDependencies(dependencies);
  const preview = {
    route: { id: getId(route), path: route.path, isEnabled: route?.isEnabled !== false },
    dependencies: dependencySummary,
  };

  if (!confirm) {
    return {
      action: 'delete_route_preview',
      ...preview,
      next: 'Call delete_route again with confirm=true and expectedPath set to this route path to delete the route and related handlers/hooks/permissions/guards.',
    };
  }

  await deleteRows(apiUrl, 'enfyra_route_handler', dependencies.handlers);
  await deleteRows(apiUrl, 'enfyra_pre_hook', dependencies.preHooks);
  await deleteRows(apiUrl, 'enfyra_post_hook', dependencies.postHooks);
  await deleteRows(apiUrl, 'enfyra_guard', dependencies.guards);
  await deleteRows(apiUrl, 'enfyra_route_permission', dependencies.permissions);
  const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, { method: 'DELETE' });
  const routeReload = await reloadRoutes(apiUrl);

  return {
    action: 'route_deleted',
    ...preview,
    deleted: {
      handlers: dependencies.handlers.map(getId).filter((id) => id !== null && id !== undefined),
      permissions: dependencies.permissions.map(getId).filter((id) => id !== null && id !== undefined),
      preHooks: dependencies.preHooks.map(getId).filter((id) => id !== null && id !== undefined),
      postHooks: dependencies.postHooks.map(getId).filter((id) => id !== null && id !== undefined),
      guards: dependencies.guards.map(getId).filter((id) => id !== null && id !== undefined),
      route: getId(route),
    },
    result,
    routeReload,
  };
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

function naturalPartialReload(reason) {
  return { attempted: false, succeeded: true, reason };
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
    stepOrder: step.order ?? 0,
    config: step.config ?? {},
    timeout: step.timeout,
    isEnabled: step.isEnabled ?? true,
    flow: { id: flowId },
  };
  if (step.sourceCode !== undefined) body.sourceCode = step.sourceCode;
  if (step.scriptLanguage !== undefined) body.scriptLanguage = step.scriptLanguage;
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

async function ensureMenu(apiUrl, {
  label,
  path,
  icon,
  type = 'Menu',
  order = 0,
  permission,
  description,
  isEnabled = true,
}) {
  const normalizedPath = path ? normalizeRestPath(path) : undefined;
  const existing = normalizedPath
    ? await findRecord(apiUrl, 'enfyra_menu', { path: { _eq: normalizedPath } }, 'id,_id,path,label')
    : await findRecord(apiUrl, 'enfyra_menu', { label: { _eq: label } }, 'id,_id,path,label');
  const operation = await createOrPatch(apiUrl, 'enfyra_menu', existing, {
    label,
    ...(normalizedPath ? { path: normalizedPath } : {}),
    icon,
    type,
    order,
    permission: parseJsonObjectArg('permission', permission, undefined),
    description,
    isEnabled,
  });
  return {
    id: operation.id || getId(existing),
    path: normalizedPath || existing?.path || null,
    label,
    action: operation.action,
    operation,
  };
}

async function ensureExtension(apiUrl, {
  name,
  type,
  code,
  menuId,
  description,
  isEnabled = true,
  version = '1.0.0',
}) {
  if (type === 'page' && !menuId) {
    throw new Error('menuId is required for page extensions. Use ensure_menu first, then ensure_page_extension.');
  }
  if (type !== 'page' && menuId) {
    throw new Error('menuId is only valid for page extensions.');
  }
  const validation = await validateExtensionCode(apiUrl, code, name);
  const existing = await findRecord(apiUrl, 'enfyra_extension', { name: { _eq: name } }, 'id,_id,name,menu.id,type');
  const operation = await createOrPatch(apiUrl, 'enfyra_extension', existing, {
    name,
    type,
    code,
    ...(menuId ? { menu: { id: menuId } } : {}),
    description,
    isEnabled,
    version,
  });
  return {
    id: operation.id || getId(existing),
    name,
    type,
    action: operation.action,
    operation,
    validation,
  };
}

async function ensureFlow(apiUrl, {
  name,
  triggerType = 'manual',
  triggerConfig,
  timeout,
  maxExecutions = 100,
  isEnabled = true,
  description,
}) {
  const existing = await findRecord(apiUrl, 'enfyra_flow', { name: { _eq: name } }, 'id,_id,name');
  const operation = await createOrPatch(apiUrl, 'enfyra_flow', existing, {
    name,
    triggerType,
    triggerConfig: parseJsonObjectArg('triggerConfig', triggerConfig, {}),
    timeout,
    maxExecutions,
    isEnabled,
    description,
  });
  const reload = naturalPartialReload('Flow metadata writes trigger the server partial reload contract; there is no dedicated flow reload endpoint.');
  return { action: 'flow_ensured', flow: { id: operation.id, name }, operation, reload };
}

async function ensureFlowStep(apiUrl, {
  flowName,
  flowId,
  key,
  type,
  order,
  config,
  sourceCode,
  scriptLanguage,
  timeout,
  isEnabled,
}) {
  if (!flowName && !flowId) throw new Error('Provide flowName or flowId.');
  if (flowName && flowId) throw new Error('Provide flowName or flowId, not both.');
  const flow = flowId
    ? await findRecord(apiUrl, 'enfyra_flow', { id: { _eq: flowId } }, 'id,_id,name')
    : await findRecord(apiUrl, 'enfyra_flow', { name: { _eq: flowName } }, 'id,_id,name');
  if (!flow) throw new Error(`Flow not found: ${flowId || flowName}`);
  const parsedConfig = parseJsonObjectArg('config', config, {});
  const validation = sourceCode && ['script', 'condition'].includes(type)
    ? await validateDynamicScript(apiUrl, sourceCode, scriptLanguage)
    : { validated: false, reason: 'no script validation required' };
  const existing = await findRecord(apiUrl, 'enfyra_flow_step', {
    flow: { id: { _eq: getId(flow) } },
    key: { _eq: key },
  }, 'id,_id,key,flow.id');
  const operation = await createOrPatch(apiUrl, 'enfyra_flow_step', existing, normalizeFlowStepBody({
    key,
    type,
    order,
    config: parsedConfig,
    sourceCode,
    scriptLanguage,
    timeout,
    isEnabled,
  }, getId(flow)));
  const reload = naturalPartialReload('Flow step writes trigger the server partial reload contract; there is no dedicated flow reload endpoint.');
  return { action: 'flow_step_ensured', flow: { id: getId(flow), name: flow.name }, step: { id: operation.id, key, type }, validation, operation, reload };
}

const FLOW_STEP_TOOL_GUIDANCE = [
  {
    tool: 'ensure_query_flow_step',
    type: 'query',
    when: 'Read/list records from one table without custom branching or transformation.',
    config: { table: 'table_name', filter: {}, fields: 'id,name', limit: 20, sort: '-createdAt' },
  },
  {
    tool: 'ensure_create_flow_step',
    type: 'create',
    when: 'Create one record in one table from static config or previous flow values.',
    config: { table: 'table_name', data: { field: 'value' } },
  },
  {
    tool: 'ensure_update_flow_step',
    type: 'update',
    when: 'Update one known record by id.',
    config: { table: 'table_name', id: '@FLOW_PAYLOAD.id', data: { field: 'value' } },
  },
  {
    tool: 'ensure_delete_flow_step',
    type: 'delete',
    when: 'Delete one known record by id.',
    config: { table: 'table_name', id: '@FLOW_PAYLOAD.id' },
  },
  {
    tool: 'ensure_http_flow_step',
    type: 'http',
    when: 'Call an external HTTP API.',
    config: { url: 'https://example.com/api', method: 'POST', headers: {}, body: {}, timeout: 10000 },
  },
  {
    tool: 'ensure_condition_flow_step',
    type: 'condition',
    when: 'Branch into true/false child steps based on JavaScript truthiness.',
    sourceCode: 'return Boolean(@FLOW_PAYLOAD.enabled)',
  },
  {
    tool: 'ensure_sleep_flow_step',
    type: 'sleep',
    when: 'Wait for a short bounded delay.',
    config: { ms: 1000 },
  },
  {
    tool: 'ensure_trigger_flow_step',
    type: 'trigger_flow',
    when: 'Trigger another flow as a child/orchestration step.',
    config: { flowName: 'child-flow', payload: {} },
  },
  {
    tool: 'ensure_log_flow_step',
    type: 'log',
    when: 'Record a small execution note for diagnostics.',
    config: { message: 'Reached step_name' },
  },
  {
    tool: 'ensure_script_flow_step',
    type: 'script',
    when: 'Use only when logic needs loops, multiple tables, crypto, package calls, non-trivial transforms, or runtime checks not covered by the atomic step tools.',
    sourceCode: 'return { ok: true }',
  },
];

function chooseFlowStepTool(intent) {
  const text = String(intent || '').toLowerCase();
  const hasAny = (patterns) => patterns.some((pattern) => pattern.test(text));
  if (hasAny([/\bif\b/, /\belse\b/, /\bbranch\b/, /\bcondition\b/, /\bwhen\b/, /\bcheck\b/, /nếu/, /điều kiện/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'condition');
  if (hasAny([/\bhttp\b/, /\bapi\b/, /\bwebhook\b/, /\bfetch\b/, /\brequest\b/, /\bpost\b/, /\bget\b/, /\bcall\b/, /gọi api/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'http');
  if (hasAny([/\bsleep\b/, /\bwait\b/, /\bdelay\b/, /\bpause\b/, /chờ/, /đợi/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'sleep');
  if (hasAny([/\btrigger\b/, /\bchild flow\b/, /\banother flow\b/, /\bsubflow\b/, /flow khác/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'trigger_flow');
  if (hasAny([/\bdelete\b/, /\bremove\b/, /\bdestroy\b/, /xóa/, /xoá/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'delete');
  if (hasAny([/\bupdate\b/, /\bpatch\b/, /\bset\b/, /\bmark\b/, /\bchange\b/, /cập nhật/, /đánh dấu/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'update');
  if (hasAny([/\bcreate\b/, /\binsert\b/, /\badd\b/, /\bstore\b/, /\bsave\b/, /tạo/, /thêm/, /lưu/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'create');
  if (hasAny([/\blog\b/, /\bdebug\b/, /\btrace\b/, /ghi log/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'log');
  if (hasAny([/\bquery\b/, /\bfind\b/, /\blist\b/, /\bread\b/, /\bload\b/, /\bcount\b/, /\bsearch\b/, /đọc/, /tìm/, /liệt kê/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'query');
  return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'script');
}

function normalizeEndpointAccess(anonymousAccess, makePublic) {
  if (makePublic !== undefined) return makePublic ? 'public' : 'private';
  return anonymousAccess || 'private';
}

function sourceMatches(existingHandler, sourceCode, scriptLanguage, timeout) {
  if (!existingHandler) return false;
  if (String(existingHandler.sourceCode ?? '') !== String(sourceCode ?? '')) return false;
  if (scriptLanguage && String(existingHandler.scriptLanguage || 'javascript') !== String(scriptLanguage)) return false;
  if (timeout !== undefined && Number(existingHandler.timeout) !== Number(timeout)) return false;
  return true;
}

function step(status, id, title, detail = {}) {
  return { id, title, status, ...detail };
}

async function resolveApiEndpointWorkflowState(apiUrl, opts) {
  const normalizedPath = normalizeRestPath(opts.path);
  const methodName = normalizeMethodName(opts.method);
  const access = normalizeEndpointAccess(opts.anonymousAccess, opts.public);
  const { methodMap, methodIdNameMap } = await getMethodContext(apiUrl);
  const methodId = methodMap[methodName];
  if (!methodId) throw new Error(`Unknown method "${methodName}". Valid methods: ${Object.keys(methodMap).sort().join(', ')}`);

  const [routes, scriptValidation] = await Promise.all([
    fetchAll(apiUrl, '/enfyra_route?limit=1000&fields=id,_id,path,isEnabled,description,availableMethods.*,publicMethods.*,mainTable.name'),
    validateScriptSourceIfPresent(fetchAPI, apiUrl, 'enfyra_route_handler', {
      sourceCode: opts.sourceCode,
      scriptLanguage: opts.scriptLanguage || 'javascript',
    }),
  ]);

  const route = routes.find((item) => item.path === normalizedPath) || null;
  const routeId = getId(route);
  const availableMethods = methodNamesFromRecords(route?.availableMethods || [], methodIdNameMap);
  const publicMethods = methodNamesFromRecords(route?.publicMethods || [], methodIdNameMap);
  const methodAvailable = availableMethods.includes(methodName);
  const routeNeedsUpdate = !!route && (
    route.isEnabled === false
    || !methodAvailable
    || (access === 'public' && !publicMethods.includes(methodName))
    || (access === 'private' && publicMethods.includes(methodName))
    || (opts.description !== undefined && route.description !== opts.description)
  );
  const handler = route ? await findHandler(apiUrl, routeId, methodId) : null;
  const handlerMatches = sourceMatches(handler, opts.sourceCode, opts.scriptLanguage || 'javascript', opts.timeout);
  const handlerNeedsOverwrite = !!handler && !handlerMatches;

  let permission = null;
  let role = null;
  let permissionMethods = [];
  let permissionMissingMethods = [];
  if (opts.roleName || opts.roleId || opts.allowedUserIds?.length) {
    if (access === 'public') {
      permissionMissingMethods = [];
    } else if (!route) {
      permissionMissingMethods = [methodName];
    } else {
      const permissions = await fetchRecords(apiUrl, 'enfyra_route_permission', {
        route: { id: { _eq: routeId } },
      }, 'id,_id,route.id,role.id,role.name,allowedUsers.id,methods.*', 1000);
      role = await resolveRole(apiUrl, { roleId: opts.roleId, roleName: opts.roleName });
      const allowedUserIds = (opts.allowedUserIds || []).map(String).sort();
      permission = permissions.find((candidate) => {
        const candidateRoleId = refId(candidate.role);
        const candidateUserIds = (candidate.allowedUsers || []).map((item) => String(refId(item))).sort();
        if (role && String(candidateRoleId) !== String(role.id)) return false;
        if (!role && candidateRoleId !== null && candidateRoleId !== undefined) return false;
        return allowedUserIds.length === candidateUserIds.length
          && allowedUserIds.every((value, index) => value === candidateUserIds[index]);
      }) || null;
      permissionMethods = methodNamesFromRecords(permission?.methods || [], methodIdNameMap);
      permissionMissingMethods = permissionMethods.includes(methodName) ? [] : [methodName];
    }
  }

  const smokeTestRequested = opts.smokeTestQuery !== undefined || opts.smokeTestBody !== undefined;
  const steps = [
    route
      ? step(routeNeedsUpdate ? 'pending' : 'completed', 'sync_route', 'Ensure route method and public access', {
        routeId,
        availableMethods,
        publicMethods,
        desiredAccess: access,
      })
      : step('pending', 'create_route', 'Create custom route', {
        desiredAccess: access,
      }),
    handler
      ? step(handlerNeedsOverwrite ? (opts.overwrite ? 'pending' : 'blocked') : 'completed', 'save_handler', 'Create or update route handler', {
        handlerId: getId(handler),
        reason: handlerNeedsOverwrite && !opts.overwrite ? 'Existing handler differs. Re-run with overwrite=true to update it.' : undefined,
      })
      : step(route && methodAvailable ? 'pending' : 'waiting', 'save_handler', 'Create route handler', {
        reason: !route ? 'Route must exist first.' : methodAvailable ? undefined : 'Route method must be available first.',
      }),
  ];

  if (opts.roleName || opts.roleId || opts.allowedUserIds?.length) {
    steps.push(
      access === 'public'
        ? step('skipped', 'ensure_route_access', 'Ensure authenticated route access', {
          reason: 'Method is public, so route permission is not required for anonymous access.',
        })
        : step(permissionMissingMethods.length ? (route ? 'pending' : 'waiting') : 'completed', 'ensure_route_access', 'Ensure authenticated route access', {
          permissionId: getId(permission),
          role,
          allowedUserIds: opts.allowedUserIds || [],
          methods: permissionMethods,
          missingMethods: permissionMissingMethods,
        }),
    );
  }

  if (smokeTestRequested) {
    const blockers = steps.filter((item) => ['pending', 'waiting', 'blocked'].includes(item.status));
    steps.push(step(blockers.length ? 'waiting' : 'pending', 'smoke_test', 'Smoke-test the endpoint', {
      reason: blockers.length ? 'Endpoint must be ready before smoke test.' : undefined,
    }));
  }

  const firstRunnable = steps.find((item) => item.status === 'pending') || null;
  const blocked = steps.find((item) => item.status === 'blocked') || null;

  return {
    endpoint: {
      path: normalizedPath,
      method: methodName,
      anonymousAccess: access,
      routeId,
      handlerId: getId(handler),
    },
    methodId,
    methodMap,
    methodIdNameMap,
    route,
    handler,
    role,
    scriptValidation,
    steps,
    firstRunnable,
    blocked,
    nextSteps: blocked
      ? [{ tool: 'api_endpoint_workflow', input: { path: normalizedPath, method: methodName, overwrite: true }, reason: blocked.reason }]
      : firstRunnable
        ? [{ tool: 'api_endpoint_workflow', input: { path: normalizedPath, method: methodName, apply: true }, stepId: firstRunnable.id }]
        : [],
  };
}

async function applyApiEndpointWorkflowStep(apiUrl, state, opts, stepId) {
  const selectedStep = stepId
    ? state.steps.find((item) => item.id === stepId)
    : state.firstRunnable;
  if (!selectedStep) return { action: 'noop', reason: 'No runnable step remains.' };
  if (selectedStep.status !== 'pending') {
    throw new Error(`Step "${selectedStep.id}" is ${selectedStep.status}, not pending.`);
  }

  const endpoint = state.endpoint;
  if (selectedStep.id === 'create_route') {
    const result = await fetchAPI(apiUrl, '/enfyra_route', {
      method: 'POST',
      body: JSON.stringify({
        path: endpoint.path,
        description: opts.description,
        isEnabled: true,
        availableMethods: [{ id: state.methodId }],
        publicMethods: endpoint.anonymousAccess === 'public' ? [{ id: state.methodId }] : [],
      }),
    });
    return { action: 'route_created', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'sync_route') {
    const availableMethods = methodNamesFromRecords(state.route.availableMethods, state.methodIdNameMap);
    const publicMethods = methodNamesFromRecords(state.route.publicMethods, state.methodIdNameMap);
    const finalAvailable = uniqueMethodNames([...availableMethods, endpoint.method]);
    const finalPublic = endpoint.anonymousAccess === 'public'
      ? uniqueMethodNames([...publicMethods, endpoint.method])
      : publicMethods.filter((method) => method !== endpoint.method);
    const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(endpoint.routeId))}`, {
      method: 'PATCH',
      body: JSON.stringify({
        isEnabled: true,
        availableMethods: resolveMethodRefs(state.methodMap, finalAvailable),
        publicMethods: resolveMethodRefs(state.methodMap, finalPublic),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
      }),
    });
    return { action: 'route_synced', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'save_handler') {
    if (!endpoint.routeId) throw new Error('Route must exist before saving handler.');
    const body = {
      sourceCode: opts.sourceCode,
      scriptLanguage: opts.scriptLanguage || 'javascript',
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    };
    if (state.handler) {
      const result = await fetchAPI(apiUrl, `/enfyra_route_handler/${encodeURIComponent(String(getId(state.handler)))}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return { action: 'handler_updated', result, routeReload: await reloadRoutes(apiUrl) };
    }
    const result = await fetchAPI(apiUrl, '/enfyra_route_handler', {
      method: 'POST',
      body: JSON.stringify({
        route: { id: endpoint.routeId },
        method: { id: state.methodId },
        ...body,
      }),
    });
    return { action: 'handler_created', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'ensure_route_access') {
    assertOneScope(opts);
    const role = state.role || await resolveRole(apiUrl, { roleId: opts.roleId, roleName: opts.roleName });
    const existing = state.steps.find((item) => item.id === 'ensure_route_access')?.permissionId
      ? await findRecord(apiUrl, 'enfyra_route_permission', { id: { _eq: state.steps.find((item) => item.id === 'ensure_route_access').permissionId } }, 'id,_id,methods.*')
      : null;
    const existingMethods = methodNamesFromRecords(existing?.methods || [], state.methodIdNameMap);
    const finalMethods = uniqueMethodNames([...existingMethods, endpoint.method]);
    const body = {
      isEnabled: true,
      description: opts.routePermissionDescription,
      methods: resolveMethodRefs(state.methodMap, finalMethods),
      ...(role ? { role: { id: role.id } } : {}),
      ...(opts.allowedUserIds?.length ? { allowedUsers: opts.allowedUserIds.map((id) => ({ id })) } : {}),
    };
    const result = existing
      ? await fetchAPI(apiUrl, `/enfyra_route_permission/${encodeURIComponent(String(getId(existing)))}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      : await fetchAPI(apiUrl, '/enfyra_route_permission', {
        method: 'POST',
        body: JSON.stringify({
          route: { id: endpoint.routeId },
          ...body,
        }),
      });
    return { action: existing ? 'route_access_updated' : 'route_access_created', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'smoke_test') {
    const query = parseJsonObjectArg('smokeTestQuery', opts.smokeTestQuery, {});
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) queryParams.set(key, String(value));
    }
    const body = opts.smokeTestBody === undefined ? undefined : parseJsonObjectArg('smokeTestBody', opts.smokeTestBody, {});
    const smokePath = `${endpoint.path}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    const result = await fetchAPI(apiUrl, smokePath, {
      method: endpoint.method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { action: 'smoke_test_passed', result };
  }

  throw new Error(`Unsupported workflow step: ${selectedStep.id}`);
}

async function runApiEndpointWorkflow(apiUrl, opts) {
  let state = await resolveApiEndpointWorkflowState(apiUrl, opts);
  const operations = [];
  let completedEphemeralStepId = null;
  if (opts.apply || opts.applyAll) {
    const maxSteps = opts.applyAll ? 10 : 1;
    for (let i = 0; i < maxSteps; i += 1) {
      if (state.blocked || !state.firstRunnable) break;
      const operation = await applyApiEndpointWorkflowStep(apiUrl, state, opts, opts.stepId);
      operations.push(operation);
      if (state.firstRunnable.id === 'smoke_test') {
        completedEphemeralStepId = 'smoke_test';
        break;
      }
      if (!opts.applyAll) break;
      state = await resolveApiEndpointWorkflowState(apiUrl, opts);
    }
  }
  const latestState = operations.length ? await resolveApiEndpointWorkflowState(apiUrl, opts) : state;
  const latestSteps = completedEphemeralStepId
    ? latestState.steps.map((item) => (
      item.id === completedEphemeralStepId
        ? { ...item, status: 'completed', result: 'passed' }
        : item
    ))
    : latestState.steps;
  const nextSteps = completedEphemeralStepId
    ? latestState.nextSteps.filter((item) => item.stepId !== completedEphemeralStepId)
    : latestState.nextSteps;
  return {
    action: operations.length ? 'api_endpoint_workflow_advanced' : 'api_endpoint_workflow_planned',
    endpoint: latestState.endpoint,
    scriptValidation: latestState.scriptValidation,
    steps: latestSteps,
    operations,
    complete: latestSteps.every((item) => ['completed', 'skipped'].includes(item.status)),
    nextSteps,
    cleanupHints: latestState.endpoint.routeId
      ? [
        `Use delete_route({ routeId: ${JSON.stringify(latestState.endpoint.routeId)}, confirm: false }) to preview route-owned handlers, hooks, guards, and permissions before cleanup.`,
        `Then call delete_route({ routeId: ${JSON.stringify(latestState.endpoint.routeId)}, expectedPath: ${JSON.stringify(latestState.endpoint.path)}, confirm: true }) when the route contract is no longer needed.`,
      ]
      : [],
  };
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
    'add_route_methods',
    'Business operation: add HTTP methods to an existing route.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      methods: z.array(z.string()).min(1).describe('HTTP method names to add.'),
      isEnabled: z.boolean().optional().describe('Optionally enable/disable the route in the same safe patch.'),
    },
    async ({ path, routeId, methods, isEnabled }) => jsonText(await updateRouteMethods(ENFYRA_API_URL, {
      path,
      routeId,
      methods,
      mode: 'merge',
      isEnabled,
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
    },
    async ({ path, routeId, methods, isEnabled }) => jsonText(await updateRouteMethods(ENFYRA_API_URL, {
      path,
      routeId,
      methods,
      mode: 'replace',
      isEnabled,
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
    },
    async ({ path, routeId, methods, isEnabled }) => jsonText(await updateRouteMethods(ENFYRA_API_URL, {
      path,
      routeId,
      methods,
      mode: 'remove',
      isEnabled,
    })),
  );

  server.tool(
    'enable_route',
    'Business operation: enable an existing route. Enabled routes are registered at runtime; disabled routes return 404.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
    },
    async ({ path, routeId }) => jsonText(await setRouteEnabled(ENFYRA_API_URL, {
      path,
      routeId,
      isEnabled: true,
    })),
  );

  server.tool(
    'disable_route',
    'Business operation: disable an existing route without deleting metadata. Disabled routes are not registered at runtime and return 404.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
    },
    async ({ path, routeId }) => jsonText(await setRouteEnabled(ENFYRA_API_URL, {
      path,
      routeId,
      isEnabled: false,
    })),
  );

  server.tool(
    'delete_route',
    'Business operation: preview-first delete for a route and its route-owned handlers, hooks, guards, and permissions. Use only when a route contract is retired.',
    {
      path: z.string().optional().describe('Route path, e.g. /old-endpoint. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      expectedPath: z.string().optional().describe('Optional safety check. When confirm=true, pass the path returned by the preview.'),
      confirm: z.boolean().optional().default(false).describe('false returns a dependency preview only; true deletes the route and related route-owned records.'),
    },
    async (input) => jsonText(await deleteRoute(ENFYRA_API_URL, input)),
  );

  server.tool(
    'public_route_methods',
    'Business operation: make existing route methods public/anonymous.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      methods: z.array(z.string()).min(1).describe('HTTP method names to make public. They must already be available on the route.'),
    },
    async ({ path, routeId, methods }) => jsonText(await updateRoutePublicMethods(ENFYRA_API_URL, {
      path,
      routeId,
      methods,
      mode: 'merge',
    })),
  );

  server.tool(
    'private_route_methods',
    'Business operation: make specific public route methods private again.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      methods: z.array(z.string()).min(1).describe('HTTP method names to remove from publicMethods.'),
    },
    async ({ path, routeId, methods }) => jsonText(await updateRoutePublicMethods(ENFYRA_API_URL, {
      path,
      routeId,
      methods,
      mode: 'remove',
    })),
  );

  server.tool(
    'api_endpoint_workflow',
    [
      'Step-by-step workflow for creating or updating a custom REST endpoint.',
      'Use this when an LLM is building or changing endpoint behavior and should follow live nextSteps instead of guessing raw metadata mutations.',
      'With apply=false it validates sourceCode, reads live route/handler/access state, and returns pending steps.',
      'With apply=true it applies only the next pending step, then returns a fresh plan. With applyAll=true it advances all currently safe pending steps.',
    ].join(' '),
    {
      path: z.string().describe('Custom route path, e.g. /sum. Must not be a full URL.'),
      method: z.string().describe('HTTP method for the handler, e.g. GET or POST.'),
      sourceCode: z.string().describe('Handler sourceCode. Use macros such as @QUERY, @BODY, @THROW400, @REPOS, @USER. Do not send compiledCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      anonymousAccess: z.enum(['public', 'private']).optional().default('private').describe('public adds the method to publicMethods; private removes this method from publicMethods.'),
      public: z.boolean().optional().describe('Compatibility alias for anonymousAccess. true means public, false means private.'),
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
    },
    async (input) => jsonText(await runApiEndpointWorkflow(ENFYRA_API_URL, input)),
  );

  server.tool(
    'create_api_endpoint',
    [
      'Business operation: create or update a custom REST endpoint with a handler in one safe operation.',
      'Use this when the user asks for a new route/endpoint/API path that computes or orchestrates behavior, such as GET /sum or POST /webhook.',
      'It creates the route without mainTableId, ensures the method is available, validates sourceCode, creates or overwrites the route handler, optionally makes the method public, reloads routes, and can smoke-test the endpoint.',
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
    'Business operation: create or update an Enfyra Socket.IO gateway. Connection handler sourceCode is validated before save.',
    {
      path: z.string().describe('Gateway namespace/path, e.g. /chat.'),
      sourceCode: z.string().optional().describe('Optional connection handler dynamic script sourceCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language for connection handler.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable gateway.'),
      description: z.string().optional().describe('Admin note.'),
    },
    async ({ path, sourceCode, scriptLanguage, isEnabled, description }) => {
      const normalizedPath = normalizeRestPath(path);
      const validation = sourceCode === undefined
        ? { validated: false, reason: 'no sourceCode' }
        : await validateDynamicScript(ENFYRA_API_URL, sourceCode, scriptLanguage);
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { path: { _eq: normalizedPath } }, 'id,_id,path');
      const body = {
        path: normalizedPath,
        isEnabled,
        description,
        ...(sourceCode !== undefined ? { sourceCode, scriptLanguage } : {}),
      };
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_websocket', existing, body);
      const reload = naturalPartialReload('Websocket metadata writes trigger the server partial reload contract; there is no dedicated websocket reload endpoint.');
      return jsonText({ action: 'websocket_gateway_ensured', gateway: { id: operation.id, path: normalizedPath }, validation, operation, reload });
    },
  );

  server.tool(
    'ensure_websocket_event',
    'Business operation: create or update one websocket event handler. It resolves gateway path/id and validates sourceCode before save.',
    {
      gatewayPath: z.string().optional().describe('Gateway path, e.g. /chat. Use gatewayPath or gatewayId.'),
      gatewayId: z.union([z.string(), z.number()]).optional().describe('Gateway id. Use gatewayPath or gatewayId.'),
      eventName: z.string().describe('Socket event name.'),
      sourceCode: z.string().describe('Event handler dynamic script sourceCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable event.'),
      description: z.string().optional().describe('Admin note.'),
    },
    async ({ gatewayPath, gatewayId, eventName, sourceCode, scriptLanguage, isEnabled, description }) => {
      if (!gatewayPath && !gatewayId) throw new Error('Provide gatewayPath or gatewayId.');
      if (gatewayPath && gatewayId) throw new Error('Provide gatewayPath or gatewayId, not both.');
      const gateway = gatewayId
        ? await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { id: { _eq: gatewayId } }, 'id,_id,path')
        : await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { path: { _eq: normalizeRestPath(gatewayPath) } }, 'id,_id,path');
      if (!gateway) throw new Error(`Websocket gateway not found: ${gatewayId || gatewayPath}`);
      const validation = await validateDynamicScript(ENFYRA_API_URL, sourceCode, scriptLanguage);
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_websocket_event', {
        gateway: { id: { _eq: getId(gateway) } },
        eventName: { _eq: eventName },
      }, 'id,_id,eventName,gateway.id');
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_websocket_event', existing, {
        gateway: { id: getId(gateway) },
        eventName,
        sourceCode,
        scriptLanguage,
        isEnabled,
        description,
      });
      const reload = naturalPartialReload('Websocket event writes trigger the server partial reload contract; there is no dedicated websocket reload endpoint.');
      return jsonText({ action: 'websocket_event_ensured', gateway: { id: getId(gateway), path: gateway.path }, eventName, validation, operation, reload });
    },
  );

  server.tool(
    'ensure_manual_flow',
    'Business operation: create or update a manually triggered Enfyra flow. Use this when the flow is run by API, admin action, another flow, or hook.',
    {
      name: z.string().describe('Flow name. Existing flow with this name is updated.'),
      timeout: z.number().int().positive().optional().describe('Flow timeout in ms.'),
      maxExecutions: z.number().int().positive().optional().default(100).describe('Execution history cap.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable flow.'),
      description: z.string().optional().describe('Admin note.'),
    },
    async ({ name, timeout, maxExecutions, isEnabled, description }) => jsonText(await ensureFlow(ENFYRA_API_URL, {
      name,
      triggerType: 'manual',
      timeout,
      maxExecutions,
      isEnabled,
      description,
    })),
  );

  server.tool(
    'ensure_scheduled_flow',
    'Business operation: create or update a scheduled Enfyra flow. Use this only for cron/time-based flows.',
    {
      name: z.string().describe('Flow name. Existing flow with this name is updated.'),
      triggerConfig: z.string().describe('Schedule config JSON object.'),
      timeout: z.number().int().positive().optional().describe('Flow timeout in ms.'),
      maxExecutions: z.number().int().positive().optional().default(100).describe('Execution history cap.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable flow.'),
      description: z.string().optional().describe('Admin note.'),
    },
    async ({ name, triggerConfig, timeout, maxExecutions, isEnabled, description }) => jsonText(await ensureFlow(ENFYRA_API_URL, {
      name,
      triggerType: 'schedule',
      triggerConfig,
      timeout,
      maxExecutions,
      isEnabled,
      description,
    })),
  );

  server.tool(
    'choose_flow_step_tool',
    'Dry-run helper: choose the most specific Enfyra flow step tool for one intended step before mutating flow metadata.',
    {
      intent: z.string().describe('Plain-language description of what this one flow step should do.'),
    },
    async ({ intent }) => {
      const recommendation = chooseFlowStepTool(intent);
      return jsonText({
        action: 'flow_step_tool_recommended',
        intent,
        recommendation,
        availableStepTools: FLOW_STEP_TOOL_GUIDANCE,
        nextSteps: [
          `Call ${recommendation.tool} with a stable key and order.`,
          'Use ensure_script_flow_step only when the atomic tools cannot express the behavior.',
          'After saving script or condition steps, use test_flow_step before relying on the flow.',
        ],
      });
    },
  );

  server.tool(
    'ensure_script_flow_step',
    'Business operation: create or update one script flow step. Use this for JavaScript/TypeScript flow logic instead of choosing type=script manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      sourceCode: z.string().describe('Script sourceCode.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      config: z.string().optional().describe('Step config JSON object.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'script',
    })),
  );

  server.tool(
    'ensure_condition_flow_step',
    'Business operation: create or update one condition flow step. Use this for dynamic conditional branching instead of choosing type=condition manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      sourceCode: z.string().describe('Condition sourceCode.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      config: z.string().optional().describe('Step config JSON object.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'condition',
    })),
  );

  server.tool(
    'ensure_query_flow_step',
    'Business operation: create or update one query flow step. Use this for repository/query-style flow steps instead of choosing type=query manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'query',
    })),
  );

  server.tool(
    'ensure_http_flow_step',
    'Business operation: create or update one HTTP flow step. Use this for outbound HTTP calls instead of choosing type=http manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'http',
    })),
  );

  server.tool(
    'ensure_create_flow_step',
    'Business operation: create or update one create-record flow step. Use this for a single table insert instead of writing script code.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object: { "table": "...", "data": { ... } }.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'create',
    })),
  );

  server.tool(
    'ensure_update_flow_step',
    'Business operation: create or update one update-record flow step. Use this for a single table update by id instead of writing script code.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object: { "table": "...", "id": "...", "data": { ... } }.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'update',
    })),
  );

  server.tool(
    'ensure_delete_flow_step',
    'Business operation: create or update one delete-record flow step. Use this for a single table delete by id instead of writing script code.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object: { "table": "...", "id": "..." }.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'delete',
    })),
  );

  server.tool(
    'ensure_sleep_flow_step',
    'Business operation: create or update one sleep/wait flow step. Use this for delays instead of choosing type=sleep manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'sleep',
    })),
  );

  server.tool(
    'ensure_log_flow_step',
    'Business operation: create or update one log flow step. Use this for lightweight execution diagnostics instead of script code.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object: { "message": "..." }.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'log',
    })),
  );

  server.tool(
    'ensure_trigger_flow_step',
    'Business operation: create or update one child-flow trigger step. Use this for flow-to-flow orchestration instead of choosing type=trigger_flow manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'trigger_flow',
    })),
  );

  server.tool(
    'ensure_menu',
    'Business operation: create or update one admin menu item. Use this instead of raw enfyra_menu CRUD.',
    {
      label: z.string().describe('Menu label.'),
      path: z.string().optional().describe('Admin app route path for leaf menu items, e.g. /reports.'),
      icon: z.string().optional().describe('Menu icon name.'),
      type: z.enum(['Menu', 'Dropdown Menu']).optional().default('Menu').describe('Menu type.'),
      order: z.number().optional().default(0).describe('Display order.'),
      permission: z.string().optional().describe('Menu permission JSON object.'),
      description: z.string().optional().describe('Admin note.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable menu.'),
    },
    async (input) => jsonText({
      action: 'menu_ensured',
      menu: await ensureMenu(ENFYRA_API_URL, input),
    }),
  );

  server.tool(
    'ensure_page_extension',
    'Business operation: create or update one page extension attached to an existing menu. Validates extension code before save.',
    {
      name: z.string().describe('Extension unique name.'),
      code: z.string().describe('Vue SFC extension code.'),
      menuId: z.union([z.string(), z.number()]).describe('Existing menu id for this page extension.'),
      description: z.string().optional().describe('Extension description.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
      version: z.string().optional().default('1.0.0').describe('Extension version.'),
    },
    async (input) => jsonText({
      action: 'page_extension_ensured',
      extension: await ensureExtension(ENFYRA_API_URL, { ...input, type: 'page' }),
    }),
  );

  server.tool(
    'ensure_global_extension',
    'Business operation: create or update one global shell extension. Validates extension code before save and rejects menu coupling.',
    {
      name: z.string().describe('Extension unique name.'),
      code: z.string().describe('Vue SFC extension code.'),
      description: z.string().optional().describe('Extension description.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
      version: z.string().optional().default('1.0.0').describe('Extension version.'),
    },
    async (input) => jsonText({
      action: 'global_extension_ensured',
      extension: await ensureExtension(ENFYRA_API_URL, { ...input, type: 'global' }),
    }),
  );

  server.tool(
    'ensure_widget_extension',
    'Business operation: create or update one widget extension. Validates extension code before save and rejects menu coupling.',
    {
      name: z.string().describe('Extension unique name.'),
      code: z.string().describe('Vue SFC extension code.'),
      description: z.string().optional().describe('Extension description.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
      version: z.string().optional().default('1.0.0').describe('Extension version.'),
    },
    async (input) => jsonText({
      action: 'widget_extension_ensured',
      extension: await ensureExtension(ENFYRA_API_URL, { ...input, type: 'widget' }),
    }),
  );

}
