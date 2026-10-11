import type { IdLike, RefRecord, MethodIdNameMap, RouteRecord, RoutePermissionRecord, RouteAccessExpected } from '../types/route-permission.types.js';

export function normalizeMethodName(method: unknown) {
  return String(method || '').trim().toUpperCase();
}

export function normalizeMethodNames(methods: unknown[] = []) {
  return [...new Set((methods || []).map(normalizeMethodName).filter(Boolean))];
}

export function getRecordId(record: unknown): IdLike {
  if (!record || typeof record !== 'object') return null;
  const item = record as RefRecord;
  return item.id ?? item._id ?? null;
}

export function getReferenceId(value: unknown): IdLike {
  if (typeof value === 'object' && value !== null) return getRecordId(value);
  if (['string', 'number', 'boolean'].includes(typeof value)) return value as IdLike;
  return null;
}

export function sameRecordId(a: unknown, b: unknown) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

export function resolveRoleByNameOrId(roles: RefRecord[], { roleId, roleName }: RouteAccessExpected = {}) {
  if (roleId && roleName) {
    throw new Error('Provide roleId or roleName, not both.');
  }
  if (!roleId && !roleName) return null;
  const normalizedRoleName = roleName ? String(roleName).trim().toLowerCase() : null;
  const role = roles.find((item) => (
    roleId
      ? sameRecordId(getRecordId(item), roleId)
      : String(item?.name || '').trim().toLowerCase() === normalizedRoleName
  ));
  if (!role) throw new Error(`Role not found: ${roleId || roleName}`);
  return role;
}

export function methodNamesFromRecords(methods: unknown[] = [], methodIdNameMap: MethodIdNameMap = {}) {
  return normalizeMethodNames((methods || []).map((method) => (
    (typeof method === 'object' && method !== null ? (method as RefRecord).name : null)
      || methodIdNameMap[String(getRecordId(method))]
      || method
  )));
}

export function routeAvailableMethodNames(route: RouteRecord | null | undefined, methodIdNameMap: MethodIdNameMap = {}) {
  return normalizeMethodNames((route?.methodConfigs || []).filter((config) => config.available === true).flatMap((config) => methodNamesFromRecords([config.method], methodIdNameMap)));
}

export function routePublicMethodNames(route: RouteRecord | null | undefined, methodIdNameMap: MethodIdNameMap = {}) {
  return normalizeMethodNames((route?.methodConfigs || []).filter((config) => config.available === true && config.isPublic === true).flatMap((config) => methodNamesFromRecords([config.method], methodIdNameMap)));
}

export function permissionMethodNames(permission: RoutePermissionRecord | null | undefined, methodIdNameMap: MethodIdNameMap = {}) {
  return normalizeMethodNames((permission?.routeMethodConfigs || []).filter((config) => config.available === true).flatMap((config) => methodNamesFromRecords([config.method], methodIdNameMap)));
}

export function validateMethodsForRoute(route: RouteRecord | null | undefined, methods: unknown[] = [], methodMap: MethodIdNameMap = {}, methodIdNameMap: MethodIdNameMap = {}) {
  const normalizedMethods = normalizeMethodNames(methods);
  const knownMethods = new Set(Object.keys(methodMap || {}).map(normalizeMethodName));
  const unknown = normalizedMethods.filter((method) => !knownMethods.has(method));
  if (unknown.length) {
    throw new Error(`Unknown enfyra_method.name values: ${unknown.join(', ')}`);
  }

  const availableMethods = routeAvailableMethodNames(route, methodIdNameMap);
  const unavailable = normalizedMethods.filter((method) => !availableMethods.includes(method));
  if (unavailable.length) {
    throw new Error(`Route ${route?.path} does not list methods as available: ${unavailable.join(', ')}. Available: ${availableMethods.join(', ')}`);
  }

  return normalizedMethods;
}

export function sortedIdStrings(values: unknown[] = []) {
  return [...new Set((values || []).map(getReferenceId).filter((id) => id != null).map(String))].sort();
}

export function sameIdSet(a: unknown[] = [], b: unknown[] = []) {
  const left = sortedIdStrings(a);
  const right = sortedIdStrings(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function routePermissionMatchesScope(permission: RoutePermissionRecord, { roleId, allowedUserIds }: RouteAccessExpected = {}) {
  const expectedUsers = sortedIdStrings(allowedUserIds);
  const permissionUsers = sortedIdStrings(permission?.allowedUsers || []);
  const permissionRoleId = getReferenceId(permission?.role);

  if (roleId && !sameRecordId(permissionRoleId, roleId)) return false;
  if (!roleId && permissionRoleId !== null && permissionRoleId !== undefined) return false;
  return sameIdSet(permissionUsers, expectedUsers);
}

export function findRoutePermission(routePermissions: RoutePermissionRecord[] = [], routeId: IdLike, scope: RouteAccessExpected) {
  return (routePermissions || []).find((permission) => (
    sameRecordId(getReferenceId(permission?.route), routeId)
    && routePermissionMatchesScope(permission, scope)
  )) || null;
}

export function mergeMethodNames(existingMethods: unknown[] = [], requestedMethods: unknown[] = [], mode = 'merge') {
  const requested = normalizeMethodNames(requestedMethods);
  if (mode === 'replace') return requested;
  return normalizeMethodNames([...normalizeMethodNames(existingMethods), ...requested]);
}

export function summarizeRoutePermission(permission: RoutePermissionRecord, methodIdNameMap: MethodIdNameMap = {}) {
  const role = permission?.role && typeof permission.role === 'object' ? permission.role as RefRecord : null;
  return {
    id: getRecordId(permission),
    isEnabled: permission?.isEnabled !== false,
    description: permission?.description || null,
    route: typeof permission?.route === 'object' && permission.route !== null ? (permission.route as RefRecord).path || permission.route : permission?.route || null,
    role: permission?.role ? {
      id: getReferenceId(permission.role),
      name: role?.name || null,
    } : null,
    allowedUsers: (permission?.allowedUsers || []).map((user) => ({
      id: getReferenceId(user),
      email: typeof user === 'object' && user !== null ? (user as RefRecord).email || null : null,
    })),
    methods: permissionMethodNames(permission, methodIdNameMap),
  };
}

export function summarizeRouteAccess(route: RouteRecord, routePermissions: RoutePermissionRecord[] = [], methodIdNameMap: MethodIdNameMap = {}, expected: RouteAccessExpected = {}) {
  const routeId = getRecordId(route);
  const permissions = (routePermissions || [])
    .filter((permission) => sameRecordId(getReferenceId(permission?.route), routeId))
    .map((permission) => summarizeRoutePermission(permission, methodIdNameMap));

  const expectedMethods = normalizeMethodNames(expected.methods || []);
  const expectedRoleId = expected.roleId ? String(expected.roleId) : null;
  const expectedAllowedUsers = sortedIdStrings(expected.allowedUserIds || []);
  const hasExpectedScope = !!(expectedRoleId || expected.roleRequired || expected.allowedUserIds !== undefined);
  const matchingPermissions = permissions.filter((permission) => {
    if (!hasExpectedScope) return true;
    if (expectedRoleId && String(permission.role?.id) !== expectedRoleId) return false;
    if (!expectedRoleId && expected.roleRequired && permission.role) return false;
    if (!sameIdSet(permission.allowedUsers.map((user) => user.id), expectedAllowedUsers)) return false;
    return true;
  });
  const grantedMethods = normalizeMethodNames(matchingPermissions.flatMap((permission) => (
    permission.isEnabled ? permission.methods : []
  )));

  return {
    id: routeId,
    path: route?.path,
    isEnabled: route?.isEnabled !== false,
    availableMethods: routeAvailableMethodNames(route, methodIdNameMap),
    publicMethods: routePublicMethodNames(route, methodIdNameMap),
    skipRoleGuardMethods: normalizeMethodNames((route?.methodConfigs || []).filter((config) => config.available === true && config.skipRoleGuard === true).flatMap((config) => methodNamesFromRecords([config.method], methodIdNameMap))),
    permissions,
    expected: expectedMethods.length ? {
      methods: expectedMethods,
      grantedMethods,
      missingMethods: expectedMethods.filter((method) => !grantedMethods.includes(method)),
    } : null,
  };
}
