import { fetchAPI } from './fetch.js';
import { fetchRecords } from './platform-data-operations.js';
import { firstDataRecord, getId, refId, sameId } from './platform-route-operations.js';
import { methodNamesFromRecords, normalizeMethodNames, routePermissionMatchesScope, sameIdSet } from './route-permission-tools.js';
import type { IdLike, MethodIdNameMap, RouteAccessExpected, RouteMethodConfigRecord } from '../types/route-permission.types.js';

export const routePermissionFields = 'id,_id,isEnabled,route.id,role.id,role.name,allowedUsers.id,methods.id,methods.name,routeMethodConfigs.id,routeMethodConfigs.route.id,routeMethodConfigs.method.id,routeMethodConfigs.method.name,routeMethodConfigs.available';

export async function resolveRoutePermissionBindings(apiUrl: string, routeId: IdLike, methods: string[], methodIdNameMap: MethodIdNameMap) {
  const configs: RouteMethodConfigRecord[] = await fetchRecords(apiUrl, 'enfyra_route_method_config', {
    route: { id: { _eq: routeId } },
  }, 'id,_id,route.id,method.id,method.name,available,isPublic,skipRoleGuard,routePermissions.id', 1001);
  if (configs.length > 1000) throw new Error('Route method configuration limit exceeded.');
  return normalizeMethodNames(methods).map((method) => {
    const matches = configs.filter((config) => sameId(refId(config.route), routeId)
      && config.available === true
      && methodNamesFromRecords([config.method], methodIdNameMap).includes(method));
    if (matches.length !== 1 || getId(matches[0]) == null) {
      throw new Error(`Expected one available route method configuration for ${method}; found ${matches.length}.`);
    }
    return matches[0];
  });
}

export async function saveRoutePermission(apiUrl: string, {
  routeId, permissionId, methods, methodRefs, methodIdNameMap, scope, isEnabled, description,
}: {
  routeId: IdLike;
  permissionId?: IdLike;
  methods: string[];
  methodRefs: Array<{ id: string | number }>;
  methodIdNameMap: MethodIdNameMap;
  scope: RouteAccessExpected;
  isEnabled: boolean;
  description?: string;
}) {
  const configs = await resolveRoutePermissionBindings(apiUrl, routeId, methods, methodIdNameMap);
  const body = {
    isEnabled,
    methods: methodRefs,
    routeMethodConfigs: configs.map((config) => ({ id: getId(config) })),
    ...(description !== undefined ? { description } : {}),
    ...(permissionId == null ? {
      route: { id: routeId },
      ...(scope.roleId ? { role: { id: scope.roleId } } : {}),
      ...(scope.allowedUserIds?.length ? { allowedUsers: scope.allowedUserIds.map((id) => ({ id })) } : {}),
    } : {}),
  };
  const result = await fetchAPI(apiUrl, permissionId == null ? '/enfyra_route_permission' : `/enfyra_route_permission/${encodeURIComponent(String(permissionId))}`, {
    method: permissionId == null ? 'POST' : 'PATCH',
    body: JSON.stringify(body),
  });
  const savedId = permissionId ?? getId(firstDataRecord(result));
  if (savedId == null) throw new Error('Route permission binding verification failed: saved id is missing.');
  const records = await fetchRecords(apiUrl, 'enfyra_route_permission', { id: { _eq: savedId } }, routePermissionFields, 2);
  const saved = records.find((record) => sameId(getId(record), savedId));
  if (!saved || saved.isEnabled !== isEnabled || !sameId(refId(saved.route), routeId)
    || !routePermissionMatchesScope(saved, scope)
    || !sameIdSet(saved.routeMethodConfigs, configs)) {
    throw new Error('Route permission binding verification failed: saved scope, state or method bindings differ. Inspect the permission before retrying.');
  }
  const verifiedConfigs = await resolveRoutePermissionBindings(apiUrl, routeId, methods, methodIdNameMap);
  if (isEnabled && verifiedConfigs.some((config) => !(config.routePermissions || []).some((permission) => sameId(refId(permission), savedId)))) {
    throw new Error('Route permission binding verification failed: method configuration does not expose the saved permission. Inspect the permission before retrying.');
  }
  return { result, saved, routeMethodConfigs: configs.map((config) => ({ id: getId(config) })), verified: true };
}
