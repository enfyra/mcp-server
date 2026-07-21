/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
// Import modules
import { exchangeApiToken, refreshAccessToken, getValidToken, resetTokens, getTokenExpiry, initAuth } from './auth.js';
import { fetchAPI, validateFilter, validateTableName } from './fetch.js';
import {
  fetchMetadataContext,
  fetchMetadataTables,
  fetchTableCatalog,
  fetchTableMetadata,
  fetchTableMetadataByRef,
} from './metadata-client.js';
import { buildMcpServerInstructions, buildGraphqlUrls } from './mcp-instructions.js';
import { getExamples, listExampleCategories } from './mcp-examples.js';
import { WORKFLOW_SURFACES, discoverWorkflowRoutes } from './tool-routing.js';
import { getSupportedColumnTypesFromMetadata, registerTableTools } from './table-tools.js';
import { registerPlatformOperationTools, validateExtensionCode } from './platform-operation-tools.js';
import { registerRuntimeZoneTools } from './runtime-zone-tools.js';
import { registerOAuthProviderTools } from './oauth-tools.js';
import { registerDynamicRepositoryBuilder } from './dynamic-repository-builder.js';
import { buildDynamicScriptContextTypeContract } from './dynamic-script-context-contract.js';
import { assertCreateHandlerRouteBoundary } from './dynamic-endpoint-contract.js';
import { assertGenericRecordMutationAllowed, parseRecordBatchData, parseRecordData, prepareRecordBatchMutation, prepareRecordMutation, validatePortableScriptSource, validateScriptSourceIfPresent } from './mutation-guards.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAckIf,
  assertGlobalRulesAck,
  acknowledgeRequiredKnowledge,
  buildRequiredKnowledgePayload,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';
import { validateMainTableRoutePath } from './route-guards.js';
import { assertRecordFieldsReadable, buildDeletePostcondition, buildQuerySchemaReceipt } from './record-contracts.js';
import { installColumnarToolFormatter, jsonContent } from './response-format.js';
import { startMcpUsageTelemetry } from './mcp-usage-telemetry.js';
import { startRuntimeCacheSocket } from './runtime-cache-socket.js';
import { executeSequentialBatch } from './sequential-batch.js';
import { compactSourceFields, readSourceArtifactResource, writeSourceArtifact } from './source-artifacts.js';
import { installToolsetFilter, normalizeDynamicToolPacks, normalizeMcpProfile, normalizeMcpToolset, summarizeToolsetForInstructions } from './toolset-filter.js';
import { installToolAnnotations } from './tool-contracts.js';
import { installToolOutputContracts } from './tool-output-contracts.js';
import { registerToolCatalogTools } from './tool-catalog.js';
import { registerWorkflowToolPack } from './workflow-tool-packs.js';
import type { ToolAvailability } from './types.js';
import {
  findRoutePermission,
  mergeMethodNames,
  normalizeMethodNames,
  resolveRoleByNameOrId,
  routeAvailableMethodNames,
  routePublicMethodNames,
  summarizeRouteAccess,
  summarizeRoutePermission,
  validateMethodsForRoute,
} from './route-permission-tools.js';
import {
  AnyRecord,
  RouteCreateBody,
  RouteHandlerBody,
  SCRIPT_BACKED_TABLES,
  collectFeatureSearchState,
  collectRestDefinitionState,
  enrichRoute,
  fetchAll,
  firstDataRecord,
  getId,
  getMetadataDatabaseContext,
  getMetadataTables,
  getMethodIdNameMap,
  getMethodMap,
  getPrimaryColumn,
  getRecordSource,
  methodNames,
  normalizeMethodNameInput,
  normalizeRestPath,
  parseJsonArg,
  pickCodeSummary,
  refId,
  reloadRoutesResult,
  resolveMethodIds,
  sameId,
  scriptRecordLabel,
  scriptTraceFields,
  sha256,
  sourcePreview,
  summarizeRoutes,
  summarizeTable,
  targetInstance,
  unwrapData,
} from './enfyra-tool-logic.js';

export function registerRouteAccessTools(server, ENFYRA_API_URL) {
  server.tool(
      'audit_route_access',
      [
        'Audit route access for one or more routes.',
        'Use this before granting access or debugging 403s. It reports available methods, public methods, skipRoleGuard methods, route permissions, and optional missing methods for one role/user scope.',
      ].join(' '),
      {
        path: z.string().optional().describe('Exact route path, e.g. /orders'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Exact route id'),
        search: z.string().optional().describe('Optional route path search when path/routeId is not provided'),
        roleId: z.union([z.string(), z.number()]).optional().describe('Expected role id to check'),
        roleName: z.string().optional().describe('Expected role name to resolve, e.g. user'),
        allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Expected direct/specific user ids to check'),
        methods: z.array(z.string()).optional().describe('Methods expected to be allowed for this scope'),
        limit: z.number().int().positive().max(100).optional().default(25).describe('Maximum routes returned for search mode'),
      },
      async ({ path, routeId, search, roleId, roleName, allowedUserIds, methods, limit }) => {
        if ([path, routeId, search].filter((value) => value !== undefined && value !== null && value !== '').length > 1) {
          throw new Error('Use only one of path, routeId, or search.');
        }
        if (roleId && roleName) throw new Error('Provide roleId or roleName, not both.');
    
        const [routes, routePermissions, roles, methodIdNameMap] = await Promise.all([
          fetchAll('/enfyra_route?limit=1000'),
          fetchAll('/enfyra_route_permission?limit=1000'),
          fetchAll('/enfyra_role?limit=1000'),
          getMethodIdNameMap(),
        ]);
    
        const role = resolveRoleByNameOrId(roles, { roleId, roleName });
        const normalizedPath = path ? normalizeRestPath(path) : null;
        const query = search ? String(search).toLowerCase() : null;
        const matchedRoutes = routes.filter((route) => {
          if (routeId) return sameId(getId(route), routeId);
          if (normalizedPath) return route.path === normalizedPath;
          if (query) return String(route.path || '').toLowerCase().includes(query);
          return true;
        }).slice(0, limit);
    
        const expectedMethods = normalizeMethodNames(methods || []);
        const payload = {
          guidance: {
            publicAccess: 'publicMethods bypass RoleGuard and do not require enfyra_route_permission.',
            authenticatedAccess: 'For non-public methods, Enfyra admin UI PermissionGate and backend RoleGuard both expect enabled enfyra_route_permission rows with matching route + HTTP method.',
            directUserAccess: 'allowedRoutePermissions on /me represent direct user-scoped route permissions; role.routePermissions represent role-scoped permissions.',
          },
          expectedScope: {
            role: role ? { id: getId(role), name: role.name } : null,
            allowedUserIds: allowedUserIds || [],
            methods: expectedMethods,
          },
          returnedRouteCount: matchedRoutes.length,
          routes: matchedRoutes.map((route) => summarizeRouteAccess(route, routePermissions, methodIdNameMap, {
            roleId: role ? getId(role) : roleId,
            roleRequired: !!(role || roleId || roleName),
            allowedUserIds,
            methods: expectedMethods,
          })),
        };
    
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      },
    );

  server.tool(
      'ensure_route_access',
      [
        'Create or update authenticated route access for one role/user scope.',
        'Use this instead of raw enfyra_route_permission CRUD when fixing 403s. It resolves roleName/route/method ids, validates route.availableMethods, merges existing permission methods by default, and reloads routes.',
      ].join(' '),
      {
        path: z.string().optional().describe('Route path, e.g. /orders'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
        methods: z.array(z.string()).describe('HTTP method names to allow, e.g. ["GET", "POST"].'),
        roleId: z.union([z.string(), z.number()]).optional().describe('Role id scope'),
        roleName: z.string().optional().describe('Role name scope, e.g. user. Prefer this when an LLM does not know role ids.'),
        allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Specific user ids scope. Omit for role-wide access.'),
        mode: z.enum(['merge', 'replace']).optional().default('merge').describe('merge adds methods to an existing permission; replace overwrites methods on the matched permission.'),
        description: z.string().optional().describe('Admin note'),
        isEnabled: z.boolean().optional().default(true).describe('Enable the permission'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ path, routeId, methods, roleId, roleName, allowedUserIds, mode, description, isEnabled, globalRulesAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        if (!path && !routeId) throw new Error('Provide path or routeId.');
        if (path && routeId) throw new Error('Provide path or routeId, not both.');
        if (roleId && roleName) throw new Error('Provide roleId or roleName, not both.');
        if (!roleId && !roleName && (!allowedUserIds || allowedUserIds.length === 0)) {
          throw new Error('Provide roleId, roleName, or allowedUserIds.');
        }
    
        const [routes, routePermissions, roles, methodMap, methodIdNameMap] = await Promise.all([
          fetchAll('/enfyra_route?limit=1000'),
          fetchAll('/enfyra_route_permission?limit=1000'),
          fetchAll('/enfyra_role?limit=1000'),
          getMethodMap(),
          getMethodIdNameMap(),
        ]);
        const route = routes.find((item) => (
          routeId ? sameId(getId(item), routeId) : item.path === normalizeRestPath(path)
        ));
        if (!route) throw new Error(`Route not found: ${routeId || path}`);
    
        const role = resolveRoleByNameOrId(roles, { roleId, roleName });
        const scope = {
          roleId: role ? getId(role) : roleId,
          allowedUserIds: allowedUserIds || [],
        };
        const requestedMethods = validateMethodsForRoute(route, methods, methodMap, methodIdNameMap);
        const existing = findRoutePermission(routePermissions, getId(route), scope);
        const existingMethods = existing ? summarizeRoutePermission(existing, methodIdNameMap).methods : [];
        const finalMethods = mergeMethodNames(existingMethods, requestedMethods, mode);
        const methodRefs = resolveMethodIds(methodMap, finalMethods);
        const publicMethods = routePublicMethodNames(route, methodIdNameMap);
        const alreadyPublic = requestedMethods.filter((method) => publicMethods.includes(method));
    
        let result;
        let action;
        if (existing) {
          action = 'updated';
          const patchBody = {
            isEnabled,
            methods: methodRefs,
            ...(description !== undefined ? { description } : {}),
          };
          result = await fetchAPI(ENFYRA_API_URL, `/enfyra_route_permission/${encodeURIComponent(String(getId(existing)))}`, {
            method: 'PATCH',
            body: JSON.stringify(patchBody),
          });
        } else {
          action = 'created';
          const createBody = {
            isEnabled,
            description,
            route: { id: getId(route) },
            methods: methodRefs,
            ...(scope.roleId ? { role: { id: scope.roleId } } : {}),
            ...(scope.allowedUserIds.length ? { allowedUsers: scope.allowedUserIds.map((id) => ({ id })) } : {}),
          };
          result = await fetchAPI(ENFYRA_API_URL, '/enfyra_route_permission', {
            method: 'POST',
            body: JSON.stringify(createBody),
          });
        }
    
        const routeReload = await reloadRoutesResult();
        const saved = firstDataRecord(result);
        const payload = {
          action,
          kind: 'route_access',
          route: {
            id: getId(route),
            path: route.path,
            availableMethods: routeAvailableMethodNames(route, methodIdNameMap),
            publicMethods,
          },
          scope: {
            role: role ? { id: getId(role), name: role.name } : null,
            allowedUserIds: scope.allowedUserIds,
          },
          permission: {
            id: getId(saved) || getId(existing),
            methods: finalMethods,
            alreadyPublic,
            isEnabled,
          },
          result,
          routeReload,
          auditHint: `Call audit_route_access({ path: "${route.path}", ${role ? `roleName: "${role.name}", ` : ''}methods: ${JSON.stringify(requestedMethods)} }) to verify.`,
        };
    
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      },
    );
}
