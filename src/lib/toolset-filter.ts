import type { McpProfile, McpToolset, RegisteredToolDefinition, ToolsetRegistrationState } from './types.js';
export type { McpProfile, McpToolset } from './types.js';

export const MCP_PROFILES = ['all', 'extension', 'schema', 'runtime', 'operations'] as const;

export const CORE_TOOL_NAMES = [
  'get_enfyra_required_knowledge',
  'get_enfyra_examples',
  'discover_enfyra_workflows',
  'discover_enfyra_system',
  'discover_runtime_context',
  'discover_query_capabilities',
  'discover_script_contexts',
  'get_enfyra_api_context',
  'get_current_user',
  'get_permission_profile',
  'report_mcp_errors',
] as const;

const PROFILE_TOOL_NAMES: Record<Exclude<McpProfile, 'all'>, readonly string[]> = {
  extension: [
    ...CORE_TOOL_NAMES,
    'search_admin_extensions',
    'search_runtime_zone',
    'inspect_table',
    'get_table_metadata',
    'query_table',
    'count_records',
    'find_one_record',
    'delete_records',
    'verify_extension_runtime',
    'get_extension_theme_contract',
    'build_extension_ui',
    'assess_permission_exposure',
    'extension_workflow',
    'delete_extension',
    'delete_menu',
    'update_extension_code',
    'patch_extension_code',
    'ensure_menu',
    'ensure_menu_access',
    'reorder_menus',
    'ensure_page_extension',
    'ensure_global_extension',
    'ensure_widget_extension',
  ],
  schema: [
    ...CORE_TOOL_NAMES,
    'build_dynamic_repository_usage',
    'search_runtime_zone',
    'inspect_rest_projection',
    'inspect_table',
    'inspect_route',
    'audit_route_access',
    'get_table_metadata',
    'get_all_tables',
    'get_schema_design_context',
    'query_table',
    'count_records',
    'find_one_record',
    'create_records',
    'update_records',
    'delete_records',
    'create_tables',
    'update_tables',
    'delete_tables',
    'confirm_schema_mutation',
    'create_columns',
    'update_columns',
    'delete_columns',
    'create_relations',
    'create_inverse_relation',
    'update_relation_constraints',
    'delete_relations',
    'ensure_column_rule',
    'ensure_field_permission',
    'remove_field_permission',
    'ensure_route_rate_limit',
    'ensure_guard',
    'create_pre_hook',
    'test_rest_endpoint',
    'test_graphql',
  ],
  runtime: [
    ...CORE_TOOL_NAMES,
    'assess_permission_exposure',
    'build_dynamic_repository_usage',
    'search_runtime_zone',
    'inspect_table',
    'inspect_route',
    'patch_script_source',
    'update_script_source',
    'validate_dynamic_script',
    'api_endpoint_workflow',
    'resolve_route_context',
    'create_handler',
    'create_pre_hook',
    'create_post_hook',
    'test_rest_endpoint',
    'run_admin_test',
    'test_flow_step',
    'trigger_flow',
    'audit_route_access',
    'ensure_route_access',
    'delete_route',
    'delete_route_handler',
    'delete_route_hook',
    'delete_route_permission',
    'set_table_graphql',
    'test_graphql',
    'ensure_route_rate_limit',
    'ensure_guard',
    'ensure_column_rule',
    'ensure_field_permission',
    'remove_field_permission',
    'ensure_websocket_gateway',
    'ensure_websocket_event',
    'flow_workflow',
    'ensure_flow',
    'ensure_flow_trigger',
    'remove_flow_trigger',
    'delete_flow',
    'delete_flow_step',
    'plan_flow_steps',
  ],
  operations: [
    ...CORE_TOOL_NAMES,
    'search_runtime_zone',
    'inspect_redis_key',
    'setup_oauth_provider',
    'inspect_table',
    'inspect_route',
    'resolve_route_context',
    'query_table',
    'count_records',
    'find_one_record',
    'create_records',
    'update_records',
    'delete_records',
    'ensure_route_access',
    'run_admin_test',
    'test_rest_endpoint',
    'search_system_errors',
    'search_user_logs',
    'search_npm',
    'install_package',
    'enable_package',
    'disable_package',
    'uninstall_package',
    'list_methods',
    'create_method',
    'update_method',
    'delete_method',
    'public_route_methods',
    'private_route_methods',
    'enable_route',
    'disable_route',
    'ensure_auth_header',
    'reorder_auth_headers',
    'ensure_user_role',
  ],
};

const GUIDED_TOOL_NAMES = new Set(Object.values(PROFILE_TOOL_NAMES).flat());
const PROFILE_TOOL_SETS = Object.fromEntries(
  Object.entries(PROFILE_TOOL_NAMES).map(([profile, names]) => [profile, new Set(names)]),
) as Record<Exclude<McpProfile, 'all'>, Set<string>>;

export function normalizeMcpProfile(value: unknown): McpProfile {
  const raw = String(value || '').trim().toLowerCase();
  return MCP_PROFILES.includes(raw as McpProfile) ? raw as McpProfile : 'all';
}

export function isToolInProfile(toolName: string, profile: McpProfile = 'all'): boolean {
  if (profile === 'all') return GUIDED_TOOL_NAMES.has(toolName);
  return PROFILE_TOOL_SETS[profile].has(toolName);
}

export function installToolsetFilter(
  server: any,
  toolset: McpToolset,
  profile: McpProfile = 'all',
): ToolsetRegistrationState {
  const registerTool = server.tool.bind(server);
  const hiddenTools: string[] = [];
  const registrations = new Map<string, RegisteredToolDefinition>();

  const refreshHiddenTools = () => {
    hiddenTools.splice(0, hiddenTools.length, ...[...registrations.values()]
      .filter((tool) => !tool.visible)
      .map((tool) => tool.name));
  };

  server.tool = (...args: any[]) => {
    const name = String(args[0]);
    const description = typeof args[1] === 'string' ? args[1] : '';
    const inputSchema = (typeof args[1] === 'string' ? args[2] : args[1]) || {};
    const handler = args.at(-1);
    const annotations = args.length >= 5 ? args.at(-2) : undefined;
    const visible = name === 'enfyra';
    const registration = registerTool(...args);
    if (registration && !visible) registration.enabled = false;
    registrations.set(name, { name, description, inputSchema, annotations, handler, visible, registration });
    refreshHiddenTools();
    return registration;
  };

  const state: ToolsetRegistrationState = {
    toolset,
    profile,
    hiddenTools,
    getTool: (name: string) => registrations.get(name),
    listTools: () => [...registrations.values()],
    listVisibleToolNames: () => [...registrations.values()]
      .filter((tool) => tool.visible)
      .map((tool) => tool.name),
  };
  return state;
}

export function summarizeToolsetForInstructions(toolset: McpToolset, profile: McpProfile = 'all') {
  return [
    `Toolset mode: ${toolset}, discovery profile: ${profile}. Only enfyra is exposed, throughout the session.`,
    'Use enfyra action=discover with an intent or exact operation name, then action=execute with name and arguments matching its returned schema.',
    'All operation names in guidance are internal: invoke them through enfyra. Low-level escape hatches stay hidden.',
    ...(profile === 'all' ? [] : ['Set ENFYRA_MCP_PROFILE=all to discover workflows across every domain.']),
  ].join(' ');
}
