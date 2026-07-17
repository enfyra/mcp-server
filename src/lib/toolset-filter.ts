export const MCP_TOOLSETS = ['guided', 'full'] as const;
export const MCP_PROFILES = ['all', 'extension', 'schema', 'runtime', 'operations'] as const;

export type McpToolset = typeof MCP_TOOLSETS[number];
export type McpProfile = typeof MCP_PROFILES[number];

const CORE_TOOL_NAMES = [
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
] as const;

const PROFILE_TOOL_NAMES: Record<Exclude<McpProfile, 'all'>, readonly string[]> = {
  extension: [
    ...CORE_TOOL_NAMES,
    'search_admin_extensions',
    'search_runtime_zone',
    'inspect_table',
    'inspect_feature',
    'trace_metadata_usage',
    'get_table_metadata',
    'query_table',
    'count_records',
    'find_one_record',
    'delete_records',
    'verify_extension_runtime',
    'get_extension_theme_contract',
    'build_extension_ui',
    'extension_workflow',
    'update_extension_code',
    'patch_extension_code',
    'ensure_menu',
    'reorder_menus',
    'ensure_page_extension',
    'ensure_global_extension',
    'ensure_widget_extension',
  ],
  schema: [
    ...CORE_TOOL_NAMES,
    'build_dynamic_repository_usage',
    'search_runtime_zone',
    'debug_field_exposure',
    'inspect_table',
    'inspect_route',
    'inspect_feature',
    'trace_metadata_usage',
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
    'create_columns',
    'update_columns',
    'delete_columns',
    'create_relations',
    'delete_relations',
    'ensure_column_rule',
    'ensure_field_permission',
  ],
  runtime: [
    ...CORE_TOOL_NAMES,
    'build_dynamic_repository_usage',
    'search_runtime_zone',
    'inspect_table',
    'inspect_route',
    'get_script_source',
    'patch_script_source',
    'update_script_source',
    'validate_dynamic_script',
    'api_endpoint_workflow',
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
    'set_table_graphql',
    'test_graphql',
    'ensure_route_rate_limit',
    'ensure_guard',
    'ensure_column_rule',
    'ensure_field_permission',
    'ensure_websocket_gateway',
    'ensure_websocket_event',
    'flow_workflow',
    'plan_flow_steps',
  ],
  operations: [
    ...CORE_TOOL_NAMES,
    'search_runtime_zone',
    'inspect_table',
    'inspect_route',
    'inspect_feature',
    'trace_metadata_usage',
    'get_all_routes',
    'query_table',
    'count_records',
    'find_one_record',
    'create_records',
    'update_records',
    'delete_records',
    'ensure_route_access',
    'run_admin_test',
    'test_rest_endpoint',
    'search_logs',
    'tail_log',
    'search_npm',
    'install_package',
    'list_methods',
    'create_method',
    'update_method',
    'delete_method',
    'public_route_methods',
    'private_route_methods',
    'enable_route',
    'disable_route',
  ],
};

const GUIDED_TOOL_NAMES = new Set(Object.values(PROFILE_TOOL_NAMES).flat());
const PROFILE_TOOL_SETS = Object.fromEntries(
  Object.entries(PROFILE_TOOL_NAMES).map(([profile, names]) => [profile, new Set(names)]),
) as Record<Exclude<McpProfile, 'all'>, Set<string>>;

export function normalizeMcpToolset(value: unknown): McpToolset {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'full') return 'full';
  return 'guided';
}

export function normalizeMcpProfile(value: unknown): McpProfile {
  const raw = String(value || '').trim().toLowerCase();
  return MCP_PROFILES.includes(raw as McpProfile) ? raw as McpProfile : 'all';
}

export function isToolVisibleInToolset(toolName: string, toolset: McpToolset, profile: McpProfile = 'all'): boolean {
  if (toolset === 'full') return true;
  if (profile === 'all') return GUIDED_TOOL_NAMES.has(toolName);
  return PROFILE_TOOL_SETS[profile].has(toolName);
}

export function installToolsetFilter(server: any, toolset: McpToolset, profile: McpProfile = 'all') {
  const registerTool = server.tool.bind(server);
  const hiddenTools: string[] = [];

  server.tool = (name: string, description: any, schema: any, handler: any) => {
    if (!isToolVisibleInToolset(name, toolset, profile)) {
      hiddenTools.push(name);
      return undefined;
    }
    return registerTool(name, description, schema, handler);
  };

  return {
    toolset,
    profile,
    hiddenTools,
  };
}

export function summarizeToolsetForInstructions(toolset: McpToolset, profile: McpProfile = 'all') {
  if (toolset === 'full') {
    return 'Toolset mode: full. All Enfyra MCP tools are visible, including low-level escape hatches; domain profile filtering is disabled.';
  }
  if (profile !== 'all') {
    return [
      `Toolset mode: guided, domain profile: ${profile}. Only normal ${profile} workflow tools and shared discovery/context tools are visible.`,
      'This focused surface is the supported configuration for T3-capability agents.',
      'Set ENFYRA_MCP_PROFILE=all for the complete guided surface, or ENFYRA_MCP_TOOLSET=full only for expert debugging or compatibility work.',
    ].join(' ');
  }
  return [
    'Toolset mode: guided, domain profile: all. The visible tool surface is curated for broad model compatibility.',
    'Prefer discover_enfyra_workflows, search_runtime_zone, inspect_* tools, and operation-level ensure/workflow tools.',
    'T3-capability agents should use ENFYRA_MCP_PROFILE=extension, schema, runtime, or operations to reduce context. Low-level escape hatches require ENFYRA_MCP_TOOLSET=full.',
  ].join(' ');
}
