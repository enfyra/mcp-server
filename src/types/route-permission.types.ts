export type IdLike = string | number | boolean | null | undefined;

export type RefRecord = {
  id?: IdLike;
  _id?: IdLike;
  name?: unknown;
  email?: unknown;
  path?: unknown;
  [key: string]: unknown;
};

export type MethodIdNameMap = Record<string, string>;

export type RouteMethodConfigRecord = RefRecord & {
  route?: unknown;
  method?: unknown;
  available?: boolean;
  isPublic?: boolean;
  skipRoleGuard?: boolean;
  routePermissions?: unknown[];
};

export type RouteRecord = RefRecord & {
  availableMethods?: unknown[];
  publicMethods?: unknown[];
  skipRoleGuardMethods?: unknown[];
  methodConfigs?: RouteMethodConfigRecord[];
  isEnabled?: unknown;
};

export type RoutePermissionRecord = RefRecord & {
  isEnabled?: unknown;
  description?: unknown;
  route?: unknown;
  role?: RefRecord | IdLike;
  allowedUsers?: unknown[];
  methods?: unknown[];
  routeMethodConfigs?: RouteMethodConfigRecord[];
};

export type RouteAccessExpected = {
  methods?: unknown[];
  roleId?: IdLike;
  roleName?: string;
  roleRequired?: boolean;
  allowedUserIds?: unknown[];
};
