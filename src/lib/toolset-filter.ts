export const MCP_TOOLSETS = ['guided', 'full'] as const;

export type McpToolset = typeof MCP_TOOLSETS[number];

const GUIDED_TOOL_NAMES = new Set([
  'get_enfyra_required_knowledge',
  'get_enfyra_examples',
  'discover_enfyra_workflows',
  'discover_enfyra_system',
  'discover_runtime_context',
  'discover_query_capabilities',
  'discover_script_contexts',
  'build_dynamic_repository_usage',
  'get_enfyra_api_context',
  'get_permission_profile',

  'search_admin_extensions',
  'search_runtime_zone',
  'debug_field_exposure',
  'inspect_table',
  'inspect_route',
  'inspect_feature',
  'trace_metadata_usage',
  'get_table_metadata',
  'get_all_tables',
  'get_all_routes',
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

  'get_script_source',
  'patch_script_source',
  'update_script_source',
  'validate_dynamic_script',
  'validate_extension_code',

  'get_extension_theme_contract',
  'get_theme_class_reference',
  'build_extension_ui',
  'build_extension_api_usage',
  'extension_workflow',
  'update_extension_code',
  'patch_extension_code',
  'ensure_menu',
  'reorder_menus',
  'ensure_page_extension',
  'ensure_global_extension',
  'ensure_widget_extension',

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
  'enable_route',
  'disable_route',
  'delete_route',
  'public_route_methods',
  'private_route_methods',

  'set_table_graphql',
  'test_graphql',
  'ensure_column_rule',
  'ensure_field_permission',
  'ensure_route_rate_limit',
  'ensure_guard',

  'ensure_websocket_gateway',
  'ensure_websocket_event',

  'flow_workflow',
  'plan_flow_steps',

  'search_logs',
  'tail_log',
  'search_npm',
  'install_package',
  'list_methods',
  'create_method',
  'update_method',
  'delete_method',
]);

export function normalizeMcpToolset(value: unknown): McpToolset {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'full') return 'full';
  return 'guided';
}

export function isToolVisibleInToolset(toolName: string, toolset: McpToolset): boolean {
  if (toolset === 'full') return true;
  return GUIDED_TOOL_NAMES.has(toolName);
}

export function installToolsetFilter(server: any, toolset: McpToolset) {
  const registerTool = server.tool.bind(server);
  const hiddenTools: string[] = [];

  server.tool = (name: string, description: any, schema: any, handler: any) => {
    if (!isToolVisibleInToolset(name, toolset)) {
      hiddenTools.push(name);
      return undefined;
    }
    return registerTool(name, description, schema, handler);
  };

  return {
    toolset,
    hiddenTools,
  };
}

export function summarizeToolsetForInstructions(toolset: McpToolset) {
  if (toolset === 'full') {
    return 'Toolset mode: full. All Enfyra MCP tools are visible, including low-level escape hatches.';
  }
  return [
    'Toolset mode: guided. The visible tool surface is curated for weak and medium LLMs.',
    'Prefer discover_enfyra_workflows, search_runtime_zone, inspect_* tools, and operation-level ensure/workflow tools.',
    'Low-level escape hatches are hidden by default; set ENFYRA_MCP_TOOLSET=full only for expert debugging or compatibility work.',
  ].join(' ');
}
