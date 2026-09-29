/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

// Import modules
import { fetchAPI } from './fetch.js';
import {
  fetchMetadataTables
} from './metadata-client.js';
import {
  getId,
  refId,
  sameId,
  unwrapData,
} from './tool-metadata-operations.js';
import {
  collectPartialErrors,
  discoveryFetch,
  fetchAll,
  getMetadataTables,
  pickCodeSummary,
} from './tool-record-operations.js';
import {
  AnyRecord,
  ENFYRA_API_URL,
} from './tool-runtime-config.js';

// ROUTE & HANDLER TOOLS
// ============================================================================

let _methodMap = null;

export function invalidateMethodMap() {
  _methodMap = null;
}

export async function getMethodMap() {
  if (_methodMap) return _methodMap;
  const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_method?limit=0');
  _methodMap = {};
  for (const m of result.data) {
    _methodMap[m.name] = m.id || m._id;
  }
  return _methodMap;
}

export function resolveMethodIds(methodMap, names) {
  return names.map(m => {
    const id = methodMap[m.toUpperCase()];
    if (!id) throw new Error(`Unknown method "${m}". Valid: ${Object.keys(methodMap).join(', ')}`);
    return { id };
  });
}

export async function getMethodIdNameMap() {
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

export async function collectRestDefinitionState(tableRef?: unknown) {
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
    fetchAll('/enfyra_route?limit=1000&fields=*,mainTable.*,methodConfigs.id,methodConfigs.method.id,methodConfigs.method.name,methodConfigs.available,methodConfigs.isPublic,methodConfigs.skipRoleGuard,methodConfigs.timeout,methodConfigs.requestBodyType,methodConfigs.description'),
    fetchAll('/enfyra_route_handler?limit=1000'),
    fetchAll('/enfyra_pre_hook?limit=1000'),
    fetchAll('/enfyra_post_hook?limit=1000'),
    fetchAll('/enfyra_route_permission?limit=1000'),
    fetchAll('/enfyra_guard?limit=1000&fields=id,_id,name,type,position,isEnabled,isGlobal,priority,combinator,route.id,route.path,methods.id,methods.name,excludeRoutes.id,excludeRoutes.path'),
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

export async function collectFeatureSearchState() {
  const metadata = await discoveryFetch('/metadata');
  const tableCatalogResult = await discoveryFetch('/enfyra_table?fields=id,name,alias,description,isSingleRecord&limit=0&sort=name');
  const routesResult = await discoveryFetch('/enfyra_route?limit=500');
  const handlersResult = await discoveryFetch('/enfyra_route_handler?limit=500');
  const preHooksResult = await discoveryFetch('/enfyra_pre_hook?limit=500');
  const postHooksResult = await discoveryFetch('/enfyra_post_hook?limit=500');
  const routePermissionsResult = await discoveryFetch('/enfyra_route_permission?limit=500');
  const guardsResult = await discoveryFetch('/enfyra_guard?limit=500&fields=id,_id,name,type,position,isEnabled,isGlobal,priority,combinator,route.id,route.path,methods.id,methods.name,excludeRoutes.id,excludeRoutes.path');
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

export function enrichRoute(route, state) {
  const routeId = getId(route);
  const methodConfigs = Array.isArray(route.methodConfigs)
    ? route.methodConfigs.map((config) => ({
        ...config,
        method: config.method ? {
          ...config.method,
          name: config.method.name || state.methodIdNameMap[String(getId(config.method))] || null,
        } : config.method,
      }))
    : [];
  const configuredMethods = (field: 'available' | 'isPublic' | 'skipRoleGuard') => methodConfigs
    .filter((config) => config.available === true && (field === 'available' || config[field] === true))
    .map((config) => config.method);
  const routeHandlers = state.handlers
    .filter((item) => sameId(refId(item.route), routeId))
    .map((item) => pickCodeSummary({
      ...item,
      timeout: methodConfigs.find((config) => sameId(refId(config.method), refId(item.method)))?.timeout ?? null,
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
    state.guards.filter((item) => {
      if (sameId(refId(item.route), routeId)) return true;
      if (!item.isGlobal) return false;
      const excluded = Array.isArray(item.excludeRoutes) ? item.excludeRoutes : [];
      return !excluded.some((excludedRoute) => sameId(refId(excludedRoute), routeId));
    }),
    state.methodIdNameMap,
  ).map((guard) => ({
    ...guard,
    rules: state.guardRules.filter((rule) => sameId(refId(rule.guard), getId(guard))),
  }));

  return {
    ...route,
    methodConfigs,
    availableMethods: configuredMethods('available'),
    publicMethods: configuredMethods('isPublic'),
    skipRoleGuardMethods: configuredMethods('skipRoleGuard'),
    handlers: routeHandlers,
    preHooks: routePreHooks,
    postHooks: routePostHooks,
    routePermissions,
    guards: routeGuards,
  };
}
