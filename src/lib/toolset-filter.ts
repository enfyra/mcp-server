import type { RegisteredToolDefinition, ToolsetRegistrationState } from './types.js';

export const MCP_PROFILES = ['all', 'extension', 'schema', 'runtime', 'operations'] as const;

export type McpToolset = 'guided';
export type McpProfile = typeof MCP_PROFILES[number];

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
  'search_enfyra_tools',
  'execute_enfyra_tool',
] as const;

const CORE_TOOL_SET = new Set<string>(CORE_TOOL_NAMES);

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

export function normalizeDynamicToolPacks(value: unknown, profile: McpProfile) {
  if (profile !== 'all') return false;
  const raw = String(value ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return true;
}

export function isToolVisibleInToolset(toolName: string, toolset: McpToolset, profile: McpProfile = 'all'): boolean {
  if (profile === 'all') return GUIDED_TOOL_NAMES.has(toolName);
  return PROFILE_TOOL_SETS[profile].has(toolName);
}

export function installToolsetFilter(
  server: any,
  toolset: McpToolset,
  profile: McpProfile = 'all',
  { dynamic = false }: { dynamic?: boolean } = {},
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
    const eligible = isToolVisibleInToolset(name, toolset, profile);
    const visible = eligible && (!dynamic || CORE_TOOL_SET.has(name));
    const registration = registerTool(...args);
    if (registration && !visible) registration.enabled = false;
    registrations.set(name, { name, description, inputSchema, annotations, handler, visible, registration });
    refreshHiddenTools();
    return registration;
  };

  const state: ToolsetRegistrationState = {
    toolset,
    profile,
    dynamic,
    hiddenTools,
    getTool: (name: string) => registrations.get(name),
    listTools: () => [...registrations.values()],
    listVisibleToolNames: () => [...registrations.values()]
      .filter((tool) => tool.visible)
      .map((tool) => tool.name),
    setActiveTools: (toolNames: Iterable<string>) => {
      const requested = new Set(toolNames);
      for (const coreTool of CORE_TOOL_NAMES) requested.add(coreTool);
      let changed = false;
      for (const tool of registrations.values()) {
        const visible = isToolVisibleInToolset(tool.name, toolset, profile)
          && (!dynamic || requested.has(tool.name));
        if (tool.visible === visible) continue;
        tool.visible = visible;
        if (tool.registration) tool.registration.enabled = visible;
        changed = true;
      }
      refreshHiddenTools();
      if (changed) server.sendToolListChanged?.();
      const visibleToolNames = state.listVisibleToolNames();
      return { changed, visibleToolNames, hiddenToolCount: hiddenTools.length };
    },
  };
  return state;
}

export function summarizeToolsetForInstructions(toolset: McpToolset, profile: McpProfile = 'all', dynamic = false) {
  if (profile !== 'all') {
    return [
      `Toolset mode: guided, domain profile: ${profile}. Only normal ${profile} workflow tools and shared discovery/context tools are visible.`,
      'Use this focused surface when the task belongs to one domain and lower context overhead is important.',
      'Use search_enfyra_tools for hidden long-tail read-only tools. Normal guided mutations remain direct; low-level escape hatches stay hidden.',
      'Set ENFYRA_MCP_PROFILE=all for the complete guided surface.',
    ].join(' ');
  }
  if (!dynamic) {
    return [
      'Toolset mode: guided, domain profile: all, static compatibility mode. The complete curated guided surface is visible.',
      'Use discover_enfyra_workflows for routing and search_enfyra_tools for hidden long-tail read-only tools.',
      'Restart without the static compatibility override to return to the compact routing surface.',
      'Low-level escape hatches stay hidden from the MCP surface.',
    ].join(' ');
  }
  return [
    'Toolset mode: guided, domain profile: all. The compact catalog starts with a bounded routing surface.',
    'Use search_enfyra_tools to load an exact hidden guided-tool schema, then execute_enfyra_tool to run it.',
    'The catalog gateway applies the selected tool\'s target, acknowledgement, and destructive-preview safety gates; low-level escape hatches stay hidden.',
    'A static compatibility override or a focused domain profile remains available when a complete direct manifest is required.',
  ].join(' ');
}
