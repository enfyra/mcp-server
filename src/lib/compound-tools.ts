import { z } from 'zod';

import { searchExtensions } from './extension-search-tools.js';
import { fetchAPI } from './fetch.js';
import { startBenchmarkOperation, endBenchmarkOperation, recordBenchmarkToolCall } from './mcp-benchmark-telemetry.js';
import { normalizeRestPath } from './platform-route-operations.js';
import { jsonContent } from './response-format.js';

type AnyRecord = Record<string, any>;

function getId(record: any) {
  return record?.id ?? record?._id ?? null;
}

function refId(value: any) {
  return typeof value === 'object' && value !== null ? getId(value) : value;
}

function unwrapData(result: any) {
  return Array.isArray(result?.data) ? result.data : [];
}

async function fetchAll(apiUrl: string, path: string) {
  return unwrapData(await fetchAPI(apiUrl, path));
}

function summarizeRecord(record: any, fields: string[]) {
  const out: AnyRecord = {};
  for (const field of fields) {
    if (record?.[field] !== undefined) out[field] = record[field];
  }
  return out;
}

function summarizeRecords(records: any[], fields: string[]) {
  return records.map((record) => summarizeRecord(record, fields));
}

function appliesToRoute(record: any, routeId: string) {
  if (String(refId(record?.route)) === String(routeId)) return true;
  if (record?.isGlobal !== true) return false;
  const excluded = Array.isArray(record?.excludeRoutes) ? record.excludeRoutes : [];
  return !excluded.some((excludedRoute) => String(refId(excludedRoute)) === String(routeId));
}

function uniqueRecords(records: any[]) {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = String(getId(record));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function resolveRouteContext(apiUrl: string, path: string) {
  const normalizedPath = normalizeRestPath(path);
  const startedAt = Date.now();
  const results: AnyRecord = {
    path: normalizedPath,
    menu: null,
    route: null,
    handlers: [],
    hooks: { pre: [], post: [] },
    permissions: [],
    guards: [],
    extensions: [],
    errors: [],
  };

  const [menuResult, routeResult] = await Promise.allSettled([
    fetchAll(apiUrl, `/enfyra_menu?limit=10&filter[path]=${encodeURIComponent(normalizedPath)}&fields=id,label,path,icon,type,isPublic,isEnabled,order,parent.id`),
    fetchAll(apiUrl, `/enfyra_route?limit=10&filter[path]=${encodeURIComponent(normalizedPath)}&fields=id,path,isEnabled,description,availableMethods.name,publicMethods.name,skipRoleGuardMethods.name,mainTable.name,mainTable.id`),
  ]);

  if (menuResult.status === 'fulfilled') {
    const menu = menuResult.value.find((item: any) => item.path === normalizedPath);
    if (menu) {
      results.menu = summarizeRecord(menu, ['id', 'label', 'path', 'icon', 'type', 'isPublic', 'isEnabled', 'order']);
      results.menu.parentId = refId(menu.parent);
    }
  } else {
    results.errors.push({ zone: 'menu', error: (menuResult.reason as any)?.message || String(menuResult.reason) });
  }

  let routeId: string | null = null;
  if (routeResult.status === 'fulfilled') {
    const route = routeResult.value[0] || null;
    if (route) {
      routeId = getId(route);
      results.route = {
        id: routeId,
        path: route.path,
        isEnabled: route.isEnabled,
        description: route.description,
        availableMethods: (route.availableMethods || []).map((method: any) => method.name),
        publicMethods: (route.publicMethods || []).map((method: any) => method.name),
        skipRoleGuardMethods: (route.skipRoleGuardMethods || []).map((method: any) => method.name),
        mainTable: route.mainTable ? { id: refId(route.mainTable), name: route.mainTable.name } : null,
      };
    }
  } else {
    results.errors.push({ zone: 'route', error: (routeResult.reason as any)?.message || String(routeResult.reason) });
  }

  if (routeId) {
    const routeFilter = encodeURIComponent(JSON.stringify({ route: { _eq: routeId } }));
    const [handlersResult, hooksResult, permissionsResult, guardsResult] = await Promise.allSettled([
      fetchAll(apiUrl, `/enfyra_route_handler?limit=50&filter=${routeFilter}&fields=id,method.name,scriptLanguage,timeout,isEnabled`),
      Promise.all([
        fetchAll(apiUrl, '/enfyra_pre_hook?limit=1000&fields=id,name,methods.name,priority,isEnabled,isGlobal,route.id'),
        fetchAll(apiUrl, '/enfyra_post_hook?limit=1000&fields=id,name,methods.name,priority,isEnabled,isGlobal,route.id'),
      ]),
      fetchAll(apiUrl, `/enfyra_route_permission?limit=50&filter=${routeFilter}&fields=id,role.name,allowedUsers.id,methods.name,isEnabled,description`),
      fetchAll(apiUrl, '/enfyra_guard?limit=1000&fields=id,name,type,position,isEnabled,isGlobal,priority,combinator,route.id,excludeRoutes.id'),
    ]);

    if (handlersResult.status === 'fulfilled') {
      results.handlers = summarizeRecords(handlersResult.value, ['id', 'scriptLanguage', 'timeout', 'isEnabled']).map((handler: any, index: number) => ({
        ...handler,
        method: (handlersResult.value[index]?.method as any)?.name || null,
      }));
    }
    if (hooksResult.status === 'fulfilled') {
      const preHooks = uniqueRecords(hooksResult.value[0].filter((hook: any) => appliesToRoute(hook, routeId!)));
      const postHooks = uniqueRecords(hooksResult.value[1].filter((hook: any) => appliesToRoute(hook, routeId!)));
      results.hooks.pre = summarizeRecords(preHooks, ['id', 'name', 'priority', 'isEnabled', 'isGlobal']).map((hook: any, index: number) => ({
        ...hook,
        methods: (preHooks[index]?.methods || []).map((method: any) => method.name),
      }));
      results.hooks.post = summarizeRecords(postHooks, ['id', 'name', 'priority', 'isEnabled', 'isGlobal']).map((hook: any, index: number) => ({
        ...hook,
        methods: (postHooks[index]?.methods || []).map((method: any) => method.name),
      }));
    }
    if (permissionsResult.status === 'fulfilled') {
      results.permissions = summarizeRecords(permissionsResult.value, ['id', 'description', 'isEnabled']).map((permission: any, index: number) => ({
        ...permission,
        role: (permissionsResult.value[index]?.role as any)?.name || null,
        allowedUserIds: (permissionsResult.value[index]?.allowedUsers || []).map((user: any) => refId(user)),
        methods: (permissionsResult.value[index]?.methods || []).map((method: any) => method.name),
      }));
    }
    if (guardsResult.status === 'fulfilled') {
      results.guards = summarizeRecords(
        uniqueRecords(guardsResult.value.filter((guard: any) => appliesToRoute(guard, routeId!))),
        ['id', 'name', 'type', 'position', 'isEnabled', 'isGlobal', 'priority', 'combinator'],
      );
    }

    for (const [zone, result] of [['handlers', handlersResult], ['hooks', hooksResult], ['permissions', permissionsResult], ['guards', guardsResult]] as const) {
      if (result.status === 'rejected') {
        results.errors.push({ zone, error: (result.reason as any)?.message || String(result.reason) });
      }
    }
  }

  try {
    const extensionResult = await searchExtensions(apiUrl, { path: normalizedPath, maxResults: 5, includeDisabled: true });
    if (extensionResult?.results) {
      results.extensions = extensionResult.results.map((extension: any) => ({
        id: extension.id,
        name: extension.name,
        type: extension.type,
        menuPath: extension.menuPath,
        isEnabled: extension.isEnabled,
      }));
    }
  } catch (error: any) {
    results.errors.push({ zone: 'extensions', error: error?.message || String(error) });
  }

  results.summary = buildSummary(results);
  results.durationMs = Date.now() - startedAt;
  return results;
}

function buildSummary(results: AnyRecord): AnyRecord {
  const summary: AnyRecord = {
    hasMenu: !!results.menu,
    menuPublic: results.menu?.isPublic ?? null,
    menuEnabled: results.menu?.isEnabled ?? null,
    hasRoute: !!results.route,
    routeEnabled: results.route?.isEnabled ?? null,
    publicMethods: results.route?.publicMethods || [],
    skipRoleGuardMethods: results.route?.skipRoleGuardMethods || [],
    handlerCount: results.handlers.length,
    preHookCount: results.hooks.pre.length,
    postHookCount: results.hooks.post.length,
    permissionCount: results.permissions.length,
    guardCount: results.guards.length,
    extensionCount: results.extensions.length,
    errors: results.errors.map((error: any) => error.zone),
  };
  const blockedReasons: string[] = [];
  if (results.menu && !results.menu.isEnabled) blockedReasons.push('menu_disabled');
  if (results.route && !results.route.isEnabled) blockedReasons.push('route_disabled');
  if (results.route && results.route.availableMethods.length === 0) blockedReasons.push('no_available_methods');
  const availableMethods = new Set(results.route?.availableMethods || []);
  const unconditionalAccessMethods = new Set([
    ...(results.route?.publicMethods || []),
    ...(results.route?.skipRoleGuardMethods || []),
  ].filter((method) => availableMethods.has(method)));
  const permissionMethods = new Set(
    results.permissions
      .filter((permission: any) => permission.isEnabled === true)
      .flatMap((permission: any) => permission.methods || [])
      .filter((method: string) => availableMethods.has(method)),
  );
  const accessMethods = new Set([...unconditionalAccessMethods, ...permissionMethods]);
  const accessEvidenceFailed = results.errors.some((error: any) => error.zone === 'route' || error.zone === 'permissions');
  if (accessMethods.size === 0 && results.route && !accessEvidenceFailed) {
    blockedReasons.push('no_permission_and_not_public');
  }
  if (unconditionalAccessMethods.size === 0 && accessEvidenceFailed) blockedReasons.push('access_indeterminate');
  if (unconditionalAccessMethods.size === 0 && permissionMethods.size > 0 && !accessEvidenceFailed) {
    blockedReasons.push('subject_access_indeterminate');
  }
  summary.accessMethods = [...accessMethods];
  summary.unconditionalAccessMethods = [...unconditionalAccessMethods];
  summary.blockedReasons = blockedReasons;
  if (accessEvidenceFailed && unconditionalAccessMethods.size === 0) summary.isReachable = null;
  else if (permissionMethods.size > 0 && unconditionalAccessMethods.size === 0) summary.isReachable = null;
  else summary.isReachable = Boolean(results.route?.isEnabled && availableMethods.size > 0 && unconditionalAccessMethods.size > 0);
  return summary;
}

export function registerCompoundTools(server: any, apiUrl: string) {
  server.tool(
    'resolve_route_context',
    'Resolve route-path context in one call: menu, route metadata, handlers, hooks, permissions, guards, linked extensions, and reachability. Use it before changing or debugging route access, missing UI, or 403 responses.',
    {
      path: z.string().describe('Enfyra API route path, e.g. /gateway/v1/models or /cloud/support'),
    },
    async (args: { path: string }) => {
      const startedAt = Date.now();
      startBenchmarkOperation(`resolve_route_context:${args.path}`);
      try {
        const result = await resolveRouteContext(apiUrl, args.path);
        recordBenchmarkToolCall('resolve_route_context', startedAt, [args], result);
        endBenchmarkOperation(true);
        return jsonContent(result);
      } catch (error: any) {
        recordBenchmarkToolCall('resolve_route_context', startedAt, [args], null, error);
        endBenchmarkOperation(false, error?.message);
        throw error;
      }
    },
  );
}
