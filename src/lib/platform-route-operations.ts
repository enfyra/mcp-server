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
  AnyRecord,
  MethodIdNameMap,
  MethodMap,
  RouteMethodBody,
} from './platform-shared-operations.js';
import {
  filterQuery,
} from './platform-extension-source.js';

export function unwrapData(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

export function getId(record) {
  return record?.id ?? record?._id ?? null;
}

export function refId(value) {
  return typeof value === 'object' && value !== null ? getId(value) : value;
}

export function sameId(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

export function firstDataRecord(result) {
  return Array.isArray(result?.data) ? result.data[0] : result;
}

export function summarizeWorkflowOperation(operation: AnyRecord) {
  const record = firstDataRecord(operation?.result) || {};
  const selectedRecord = Object.fromEntries(
    ['id', '_id', 'name', 'key', 'path', 'label', 'title', 'state', 'severity', 'type', 'isEnabled', 'version', 'jobId', 'flowId']
      .filter((key) => record?.[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
  return {
    action: operation?.action || null,
    result: {
      statusCode: operation?.result?.statusCode ?? null,
      message: operation?.result?.message ?? null,
      ...(Object.keys(selectedRecord).length ? { record: selectedRecord } : {}),
    },
    ...(operation?.routeReload ? {
      routeReload: {
        attempted: Boolean(operation.routeReload.attempted),
        succeeded: operation.routeReload.succeeded === true,
      },
    } : {}),
  };
}

export function normalizeRestPath(path) {
  if (!path) return '/';
  if (/^https?:\/\//i.test(path)) {
    throw new Error('Only Enfyra API paths are allowed, not full external URLs.');
  }
  return path.startsWith('/') ? path : `/${path}`;
}

export function normalizeMethodName(method): string {
  const value = String(method || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid method "${method}". Method names must start with A-Z and contain only A-Z, 0-9, or underscore.`);
  }
  return value;
}

export function methodNamesFromRecords(records, methodIdNameMap): string[] {
  return (records || [])
    .map((method) => method?.name || methodIdNameMap[String(getId(method))] || null)
    .filter(Boolean)
    .map(normalizeMethodName);
}

export function uniqueMethodNames(names): string[] {
  return Array.from(new Set<string>((names || []).map((name) => normalizeMethodName(name))));
}

export function resolveMethodRefs(methodMap: MethodMap, names): Array<{ id: string | number }> {
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

export async function fetchAll(apiUrl, path) {
  return unwrapData(await fetchAPI(apiUrl, path));
}

export async function getMethodContext(apiUrl) {
  const methods = await fetchAll(apiUrl, '/enfyra_method?limit=0&fields=id,_id,name');
  const methodMap: MethodMap = {};
  const methodIdNameMap: MethodIdNameMap = {};
  for (const method of methods) {
    if (!method?.name) continue;
    const name = normalizeMethodName(method.name);
    const id = getId(method);
    methodMap[name] = id;
    methodIdNameMap[String(id)] = name;
  }
  return { methods, methodMap, methodIdNameMap };
}

export async function reloadRoutes(apiUrl) {
  try {
    const result = await fetchAPI(apiUrl, '/admin/reload/routes', { method: 'POST' });
    return { attempted: true, succeeded: true, result };
  } catch (error) {
    return { attempted: true, succeeded: false, error: error?.message || String(error) };
  }
}

export async function resolveRoute(apiUrl, { path, routeId }) {
  if (!path && !routeId) throw new Error('Provide path or routeId.');
  if (path && routeId) throw new Error('Provide path or routeId, not both.');
  const routes = await fetchAll(apiUrl, '/enfyra_route?limit=1000&fields=id,_id,path,isEnabled,availableMethods.*,publicMethods.*,mainTable.name');
  const normalizedPath = path ? normalizeRestPath(path) : null;
  const route = routes.find((item) => (routeId ? sameId(getId(item), routeId) : item.path === normalizedPath));
  if (!route) throw new Error(`Route not found: ${routeId || normalizedPath}`);
  return { route, routes, path: route.path };
}

export async function updateRouteMethods(apiUrl, { path, routeId, methods, mode, isEnabled, globalRulesAckKey }) {
  assertGlobalRulesAck(globalRulesAckKey);
  const [{ route }, { methodMap, methodIdNameMap }] = await Promise.all([
    resolveRoute(apiUrl, { path, routeId }),
    getMethodContext(apiUrl),
  ]);
  const existingAvailable = methodNamesFromRecords(route.availableMethods, methodIdNameMap);
  const existingPublic = methodNamesFromRecords(route.publicMethods, methodIdNameMap);
  const finalAvailable = mergeMethods(existingAvailable, methods, mode);
  const finalPublic = existingPublic.filter((method) => finalAvailable.includes(method));
  const body: RouteMethodBody = {
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

export async function updateRoutePublicMethods(apiUrl, { path, routeId, methods, mode, globalRulesAckKey }) {
  assertGlobalRulesAck(globalRulesAckKey);
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

export async function setRouteEnabled(apiUrl, { path, routeId, isEnabled, globalRulesAckKey }) {
  assertGlobalRulesAck(globalRulesAckKey);
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

export async function deleteRoute(apiUrl, { path, routeId, expectedPath, confirm, globalRulesAckKey }) {
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
  assertGlobalRulesAck(globalRulesAckKey);

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

export async function findHandler(apiUrl, routeId, methodId) {
  const filter = encodeURIComponent(JSON.stringify({
    route: { id: { _eq: routeId } },
    method: { id: { _eq: methodId } },
  }));
  const result = await fetchAPI(apiUrl, `/enfyra_route_handler?filter=${filter}&limit=1&fields=id,_id,route.id,method.id,method.name,sourceCode,scriptLanguage,timeout`);
  return unwrapData(result)[0] || null;
}
