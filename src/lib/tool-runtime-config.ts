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
import type { AnyRecord, MethodPatchBody, RouteCreateBody, RouteHandlerBody } from './enfyra-tool-types.js';
export type { AnyRecord, MethodPatchBody, RouteCreateBody, RouteHandlerBody } from './enfyra-tool-types.js';

export // Configuration
const ENFYRA_API_URL = process.env.ENFYRA_API_URL || 'http://localhost:3000/api';

export const ENFYRA_API_TOKEN = process.env.ENFYRA_API_TOKEN || '';

export const DISCOVERY_FETCH_TIMEOUT_MS = 12000;

export function asNonEmptyStringTuple(values: string[], label: string): [string, ...string[]] {
  if (!values.length) {
    throw new Error(`${label} must include at least one value.`);
  }
  return values as [string, ...string[]];
}

export function bulkObjectArrayParam(z, label: string) {
  return z.array(z.record(z.any())).describe(`${label} as a native JSON array of objects. Pass one object in the array for a single mutation.`);
}

export function jsonObjectParam(z, label: string) {
  return z.record(z.any()).describe(`${label} as a native JSON object. Do not JSON.stringify this value.`);
}

export function parseJsonObjectInput(value: unknown, label: string): Record<string, any> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, any>;
}

export function normalizeSortParam(sort?: string) {
  if (!sort) return sort;
  return sort
    .split(',')
    .map((item) => item.trim().replace(/^(['"])(.*)\1$/u, '$2'))
    .filter(Boolean)
    .join(',');
}

function normalizeFieldSelection(fields?: string[]) {
  return (fields || [])
    .flatMap((field) => String(field).split(','))
    .map((field) => field.trim())
    .filter(Boolean);
}

export function assertExtensionReadFields(tableName: string, fields?: string[]) {
  if (tableName !== 'enfyra_extension') return;
  const requestedFields = normalizeFieldSelection(fields);
  const requestsSourceCode = requestedFields.some((field) => field === 'sourceCode' || field.endsWith('.sourceCode'));
  if (!requestsSourceCode) return;
  throw new Error([
    'enfyra_extension stores editable Vue SFC extension source in `code`, not `sourceCode`.',
    '`sourceCode` belongs to dynamic server script records such as handlers, hooks, flow steps, websocket handlers, OAuth provider provisioning, and bootstrap scripts.',
    'For admin UI lookup, use search_admin_extensions(mode="search") then search_admin_extensions(mode="inspect").',
    'For focused extension edits, use patch_extension_code or update_extension_code.',
    'If you intentionally read raw extension records, request fields such as ["id","name","type","version","code"].',
  ].join(' '));
}

export const MCP_TOOLSET = normalizeMcpToolset(process.env.ENFYRA_MCP_TOOLSET);

export const MCP_PROFILE = normalizeMcpProfile(process.env.ENFYRA_MCP_PROFILE);

export const MCP_DYNAMIC_TOOLS = normalizeDynamicToolPacks(process.env.ENFYRA_MCP_DYNAMIC_TOOLS, MCP_TOOLSET, MCP_PROFILE);

export const CAPABILITY_AREAS = [
  {
    area: 'Schema and metadata',
    tables: ['enfyra_table', 'enfyra_column', 'enfyra_relation', 'enfyra_schema_migration'],
    workflow: 'Use table tools for table/column/relation schema changes. enfyra_column and enfyra_session are internal/no-route; do not CRUD them directly.',
  },
  {
    area: 'Dynamic REST API',
    tables: ['enfyra_route', 'enfyra_route_handler', 'enfyra_pre_hook', 'enfyra_post_hook', 'enfyra_route_permission', 'enfyra_method'],
    workflow: 'Create custom paths with create_route without mainTableId, then add handlers/hooks. mainTableId is only for canonical table routes like /table_name. Query enfyra_method before assigning route methods.',
  },
  {
    area: 'Auth, roles, sessions, OAuth',
    tables: ['enfyra_user', 'enfyra_role', 'enfyra_api_token', 'enfyra_session', 'enfyra_oauth_config', 'enfyra_oauth_account'],
    workflow: 'MCP auth exchanges ENFYRA_API_TOKEN through /auth/token/exchange. Configure an API token from Enfyra admin UI /me.',
  },
  {
    area: 'Guards and permissions',
    tables: ['enfyra_guard', 'enfyra_guard_rule', 'enfyra_field_permission', 'enfyra_column_rule'],
    workflow: 'Use route guard metadata for request gating, field permissions for record field access, and column rules for body validation.',
  },
  {
    area: 'GraphQL',
    tables: ['enfyra_graphql'],
    workflow: 'Enable per table through enfyra_graphql or update_tables graphqlEnabled. GraphQL table data requires Bearer auth; anonymous root or schema probes may return 200 without exposing table data.',
  },
  {
    area: 'Files and storage',
    tables: ['enfyra_file', 'enfyra_file_permission', 'enfyra_folder', 'enfyra_storage_config'],
    workflow: 'Use file endpoints/helpers for uploads and asset streaming; metadata tables describe files, permissions, folders, and storage backends.',
  },
  {
    area: 'WebSocket',
    tables: ['enfyra_websocket', 'enfyra_websocket_event'],
    workflow: 'Socket.IO gateways/events are metadata-backed. Use admin test runner for handler scripts before relying on a real client.',
  },
  {
    area: 'Flows',
    tables: ['enfyra_flow', 'enfyra_flow_step', 'enfyra_flow_execution'],
    workflow: 'Create flows as small operation-sized steps via CRUD, test steps with test_flow_step/run_admin_test, trigger with trigger_flow. Split oversized scripts instead of adding more work to one step.',
  },
  {
    area: 'Extensions, menus, packages',
    tables: ['enfyra_extension', 'enfyra_menu', 'enfyra_package', 'enfyra_bootstrap_script'],
    workflow: 'Extensions are Vue SFC records. Use install_package for enfyra_package rather than raw CRUD.',
  },
  {
    area: 'Settings and platform config',
    tables: ['enfyra_setting', 'enfyra_cors_origin'],
    workflow: 'Settings and CORS origins are metadata-backed platform configuration.',
  },
];

export const FILTER_OPERATORS = [
  '_eq',
  '_neq',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_in',
  '_not_in',
  '_nin',
  '_contains',
  '_starts_with',
  '_ends_with',
  '_between',
  '_is_null',
  '_is_not_null',
  '_and',
  '_or',
  '_not',
];

export const DEFAULT_ME_PERMISSION_FIELDS = [
  'id',
  'email',
  'isRootAdmin',
  'role.id',
  'role.name',
  'role.routePermissions.id',
  'role.routePermissions.isEnabled',
  'role.routePermissions.methods.id',
  'role.routePermissions.methods.name',
  'role.routePermissions.route.id',
  'role.routePermissions.route.path',
  'role.routePermissions.allowedUsers.id',
  'allowedRoutePermissions.id',
  'allowedRoutePermissions.isEnabled',
  'allowedRoutePermissions.methods.id',
  'allowedRoutePermissions.methods.name',
  'allowedRoutePermissions.route.id',
  'allowedRoutePermissions.route.path',
  'allowedRoutePermissions.allowedUsers.id',
];

export const MCP_PERMISSION_REQUIREMENTS = [
  {
    area: 'script validation',
    tools: ['validate_dynamic_script', 'create_handler', 'create_pre_hook', 'create_post_hook', 'patch_script_source', 'update_script_source', 'ensure_script_flow_step', 'ensure_condition_flow_step', 'ensure_websocket_event'],
    route: '/admin/script/validate',
    methods: ['POST'],
  },
  {
    area: 'flow and websocket test runner',
    tools: ['run_admin_test', 'test_flow_step'],
    route: '/admin/test/run',
    methods: ['POST'],
  },
  {
    area: 'manual flow trigger',
    tools: ['trigger_flow'],
    route: '/admin/flow/trigger/:id',
    methods: ['POST'],
  },
  {
    area: 'route cache reload',
    tools: ['reload_routes', 'enable_route', 'disable_route', 'delete_route', 'public_route_methods', 'private_route_methods', 'add_route_methods', 'replace_route_methods', 'remove_route_methods', 'ensure_route_access'],
    route: '/admin/reload/routes',
    methods: ['POST'],
  },
  {
    area: 'menu reorder',
    tools: ['reorder_menus'],
    route: '/admin/menu/reorder',
    methods: ['POST'],
  },
  {
    area: 'metadata cache reload',
    tools: ['reload_metadata'],
    route: '/admin/reload/metadata',
    methods: ['POST'],
  },
  {
    area: 'GraphQL cache reload',
    tools: ['reload_graphql', 'set_table_graphql'],
    route: '/admin/reload/graphql',
    methods: ['POST'],
  },
  {
    area: 'full cache reload',
    tools: ['reload_all'],
    route: '/admin/reload',
    methods: ['POST'],
  },
];

export const FIELD_PERMISSION_CONDITION_OPERATORS = [
  '_eq',
  '_neq',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_in',
  '_not_in',
  '_nin',
  '_is_null',
  '_is_not_null',
  '_and',
  '_or',
  '_not',
];

export const SCRIPT_BACKED_TABLES = [
  'enfyra_route_handler',
  'enfyra_pre_hook',
  'enfyra_post_hook',
  'enfyra_flow_step',
  'enfyra_websocket_event',
  'enfyra_websocket',
  'enfyra_oauth_config',
  'enfyra_bootstrap_script',
] as const;

export const SCRIPT_BACKED_TABLE_SET = new Set(SCRIPT_BACKED_TABLES);

export const SCRIPT_SOURCE_FIELDS = [
  'sourceCode',
  'handlerScript',
  'connectionHandlerScript',
  'code',
];
