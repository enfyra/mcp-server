export function normalizeMethodName(method) {
  return String(method || '').trim().toUpperCase();
}

export function normalizeMethodNames(methods) {
  return [...new Set((methods || []).map(normalizeMethodName).filter(Boolean))];
}

export function getRecordId(record) {
  return record?.id ?? record?._id ?? null;
}

export function getReferenceId(value) {
  return typeof value === 'object' && value !== null ? getRecordId(value) : value;
}

export function sameRecordId(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

export function resolveRoleByNameOrId(roles, { roleId, roleName } = {}) {
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

export function methodNamesFromRecords(methods, methodIdNameMap = {}) {
  return normalizeMethodNames((methods || []).map((method) => (
    method?.name || method?.method || methodIdNameMap[String(getRecordId(method))] || method
  )));
}

export function routeAvailableMethodNames(route, methodIdNameMap = {}) {
  return methodNamesFromRecords(route?.availableMethods || [], methodIdNameMap);
}

export function routePublicMethodNames(route, methodIdNameMap = {}) {
  return methodNamesFromRecords(route?.publicMethods || [], methodIdNameMap);
}

export function permissionMethodNames(permission, methodIdNameMap = {}) {
  return methodNamesFromRecords(permission?.methods || [], methodIdNameMap);
}

export function validateMethodsForRoute(route, methods, methodMap, methodIdNameMap = {}) {
  const normalizedMethods = normalizeMethodNames(methods);
  const knownMethods = new Set(Object.keys(methodMap || {}).map(normalizeMethodName));
  const unknown = normalizedMethods.filter((method) => !knownMethods.has(method));
  if (unknown.length) {
    throw new Error(`Unknown method_definition.name values: ${unknown.join(', ')}`);
  }

  const availableMethods = routeAvailableMethodNames(route, methodIdNameMap);
  if (availableMethods.length) {
    const unavailable = normalizedMethods.filter((method) => !availableMethods.includes(method));
    if (unavailable.length) {
      throw new Error(`Route ${route?.path} does not list methods as available: ${unavailable.join(', ')}. Available: ${availableMethods.join(', ')}`);
    }
  }

  return normalizedMethods;
}

export function sortedIdStrings(values) {
  return [...new Set((values || []).map((value) => String(getReferenceId(value))).filter(Boolean))].sort();
}

export function sameIdSet(a, b) {
  const left = sortedIdStrings(a);
  const right = sortedIdStrings(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function routePermissionMatchesScope(permission, { roleId, allowedUserIds } = {}) {
  const expectedUsers = sortedIdStrings(allowedUserIds);
  const permissionUsers = sortedIdStrings(permission?.allowedUsers || []);
  const permissionRoleId = getReferenceId(permission?.role);

  if (roleId && !sameRecordId(permissionRoleId, roleId)) return false;
  if (!roleId && permissionRoleId !== null && permissionRoleId !== undefined) return false;
  return sameIdSet(permissionUsers, expectedUsers);
}

export function findRoutePermission(routePermissions, routeId, scope) {
  return (routePermissions || []).find((permission) => (
    sameRecordId(getReferenceId(permission?.route), routeId)
    && routePermissionMatchesScope(permission, scope)
  )) || null;
}

export function mergeMethodNames(existingMethods, requestedMethods, mode = 'merge') {
  const requested = normalizeMethodNames(requestedMethods);
  if (mode === 'replace') return requested;
  return normalizeMethodNames([...normalizeMethodNames(existingMethods), ...requested]);
}

export function summarizeRoutePermission(permission, methodIdNameMap = {}) {
  return {
    id: getRecordId(permission),
    isEnabled: permission?.isEnabled !== false,
    description: permission?.description || null,
    route: permission?.route?.path || permission?.route || null,
    role: permission?.role ? {
      id: getReferenceId(permission.role),
      name: permission.role.name || null,
    } : null,
    allowedUsers: (permission?.allowedUsers || []).map((user) => ({
      id: getReferenceId(user),
      email: user?.email || null,
    })),
    methods: permissionMethodNames(permission, methodIdNameMap),
  };
}

export function summarizeRouteAccess(route, routePermissions, methodIdNameMap = {}, expected = {}) {
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
    skipRoleGuardMethods: methodNamesFromRecords(route?.skipRoleGuardMethods || [], methodIdNameMap),
    permissions,
    expected: expectedMethods.length ? {
      methods: expectedMethods,
      grantedMethods,
      missingMethods: expectedMethods.filter((method) => !grantedMethods.includes(method)),
    } : null,
  };
}
