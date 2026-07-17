import type { RegisteredToolDefinition, ToolsetRegistrationState } from './types.js';

export const MCP_TOOLSETS = ['guided', 'full'] as const;
export const MCP_PROFILES = ['all', 'extension', 'schema', 'runtime', 'operations'] as const;

export type McpToolset = typeof MCP_TOOLSETS[number];
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
  'search_enfyra_tools',
  'execute_enfyra_tool',
  'select_enfyra_workflow',
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
    'setup_oauth_provider',
    'inspect_table',
    'inspect_route',
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

export function normalizeDynamicToolPacks(value: unknown, toolset: McpToolset, profile: McpProfile) {
  if (toolset === 'full' || profile !== 'all') return false;
  const raw = String(value ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  return true;
}

export function isToolVisibleInToolset(toolName: string, toolset: McpToolset, profile: McpProfile = 'all'): boolean {
  if (toolset === 'full') return true;
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
  if (toolset === 'full') {
    return 'Toolset mode: full. All Enfyra MCP tools are visible, including low-level escape hatches; domain profile filtering is disabled.';
  }
  if (profile !== 'all') {
    return [
      `Toolset mode: guided, domain profile: ${profile}. Only normal ${profile} workflow tools and shared discovery/context tools are visible.`,
      'Use this focused surface when the task belongs to one domain and lower context overhead is important.',
      'Use search_enfyra_tools for hidden long-tail read-only tools; hidden mutations require the full toolset.',
      'Set ENFYRA_MCP_PROFILE=all for the complete guided surface, or ENFYRA_MCP_TOOLSET=full only for expert debugging or compatibility work.',
    ].join(' ');
  }
  if (!dynamic) {
    return [
      'Toolset mode: guided, domain profile: all. The complete curated guided surface is visible.',
      'Use discover_enfyra_workflows for routing and search_enfyra_tools for hidden long-tail read-only tools.',
      'Set ENFYRA_MCP_DYNAMIC_TOOLS=on to start with a compact routing surface on hosts that refresh tools/list_changed.',
      'Low-level escape hatches require ENFYRA_MCP_TOOLSET=full.',
    ].join(' ');
  }
  return [
    'Toolset mode: guided, domain profile: all. Dynamic workflow packs start with a compact routing surface.',
    'Call select_enfyra_workflow with the task surface to expose the exact direct workflow tools for this session.',
    'Use search_enfyra_tools for hidden long-tail read-only tools; hidden mutations require the full toolset.',
    'Set ENFYRA_MCP_DYNAMIC_TOOLS=off or use ENFYRA_MCP_PROFILE=extension, schema, runtime, or operations as a static fallback for hosts that do not refresh tools/list_changed. Low-level escape hatches require ENFYRA_MCP_TOOLSET=full.',
  ].join(' ');
}
