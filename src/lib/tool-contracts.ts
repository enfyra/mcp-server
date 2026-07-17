import type { McpToolAnnotations, McpToolContract } from './types.js';

const DESTRUCTIVE_TOOLS = new Set([
  'delete_records',
  'delete_tables',
  'delete_columns',
  'delete_relations',
  'delete_method',
  'delete_route',
]);

const MUTATION_TOOL_PATTERN = /^(?:create|update|delete|ensure|patch|install|enable|disable|reorder|reload|trigger|set|add|remove)_/;
const MUTATION_TOOLS = new Set([
  'api_endpoint_workflow',
  'extension_workflow',
  'flow_workflow',
  'public_route_methods',
  'private_route_methods',
  'replace_route_methods',
  'run_admin_test',
  'test_flow_step',
  'test_graphql',
  'test_rest_endpoint',
  'setup_oauth_provider',
  'login',
]);

const LOCAL_TOOL_PATTERN = /^(?:build|validate|review|plan)_/;
const LOCAL_TOOLS = new Set([
  'get_enfyra_required_knowledge',
  'get_enfyra_examples',
  'discover_enfyra_workflows',
  'search_enfyra_tools',
  'execute_enfyra_tool',
  'select_enfyra_workflow',
  'get_extension_theme_contract',
  'get_theme_class_reference',
]);
const REMOTE_TOOL_OVERRIDES = new Set([
  'validate_dynamic_script',
  'validate_extension_code',
]);

const IDEMPOTENT_MUTATION_PATTERN = /^(?:ensure|enable|disable|reload|set)_/;
const IDEMPOTENT_MUTATIONS = new Set([
  'public_route_methods',
  'private_route_methods',
  'replace_route_methods',
  'add_route_methods',
  'remove_route_methods',
  'reorder_menus',
  'setup_oauth_provider',
]);

export function isMutationTool(toolName: string) {
  return MUTATION_TOOL_PATTERN.test(toolName) || MUTATION_TOOLS.has(toolName);
}

export function isDestructiveTool(toolName: string) {
  return DESTRUCTIVE_TOOLS.has(toolName);
}

function isLocalTool(toolName: string) {
  if (REMOTE_TOOL_OVERRIDES.has(toolName)) return false;
  return LOCAL_TOOL_PATTERN.test(toolName) || LOCAL_TOOLS.has(toolName);
}

function titleForTool(toolName: string) {
  return toolName
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function getToolContract(toolName: string): McpToolContract {
  const mutation = isMutationTool(toolName);
  const destructive = isDestructiveTool(toolName);
  const annotations: McpToolAnnotations = {
    title: titleForTool(toolName),
    readOnlyHint: !mutation,
    destructiveHint: destructive,
    idempotentHint: !mutation || IDEMPOTENT_MUTATION_PATTERN.test(toolName) || IDEMPOTENT_MUTATIONS.has(toolName),
    openWorldHint: !isLocalTool(toolName),
  };
  return {
    name: toolName,
    annotations,
    catalogExecutable: annotations.readOnlyHint && !annotations.destructiveHint,
  };
}

export function isCatalogExecutable(toolName: string) {
  return getToolContract(toolName).catalogExecutable;
}

export function installToolAnnotations(server: any) {
  const registerTool = server.tool.bind(server);
  server.tool = (...args: any[]) => {
    const name = String(args[0]);
    const handler = args.at(-1);
    if (typeof handler !== 'function') return registerTool(...args);
    const annotations = getToolContract(name).annotations;
    if (args.length >= 5) {
      const existing = args.at(-2);
      return registerTool(...args.slice(0, -2), { ...annotations, ...(existing || {}) }, handler);
    }
    return registerTool(...args.slice(0, -1), annotations, handler);
  };
}
