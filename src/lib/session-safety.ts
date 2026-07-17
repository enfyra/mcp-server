type ToolInput = Record<string, unknown>;

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
]);
const PREVIEW_IGNORED_KEYS = new Set([
  'confirm',
  'expectedPath',
  'globalRulesAckKey',
  'maxItems',
  'skipNotFound',
]);
const ID_KEYS = new Set(['id', '_id', 'columnId', 'flowId', 'relationId', 'routeId', 'tableId']);

let targetConfirmed = false;
const destructivePreviews = new Set<string>();

function isRecord(value: unknown): value is ToolInput {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFingerprintValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeFingerprintValue(entry));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((entryKey) => !PREVIEW_IGNORED_KEYS.has(entryKey))
        .sort()
        .map((entryKey) => [entryKey, normalizeFingerprintValue(value[entryKey], entryKey)]),
    );
  }
  if (key && ID_KEYS.has(key) && value !== undefined && value !== null) return String(value);
  return value;
}

function destructivePreviewKey(toolName: string, input: ToolInput) {
  return `${toolName}:${JSON.stringify(normalizeFingerprintValue(input))}`;
}

function isMutationTool(toolName: string) {
  return MUTATION_TOOL_PATTERN.test(toolName) || MUTATION_TOOLS.has(toolName);
}

export function resetMcpSafetySession() {
  targetConfirmed = false;
  destructivePreviews.clear();
}

export function getMcpSafetySessionState() {
  return {
    targetConfirmed,
    destructivePreviewCount: destructivePreviews.size,
  };
}

export function beforeMcpToolExecution(toolName: string, input: ToolInput = {}) {
  if (isMutationTool(toolName) && !targetConfirmed) {
    throw new Error(`Target is not confirmed for this MCP process session. Call get_enfyra_api_context before ${toolName}, verify the API base, then retry.`);
  }
  if (DESTRUCTIVE_TOOLS.has(toolName) && input.confirm === true) {
    const key = destructivePreviewKey(toolName, input);
    if (!destructivePreviews.has(key)) {
      throw new Error(`Missing matching destructive preview for ${toolName}. Call the same tool first with confirm=false, inspect the preview, then retry with confirm=true in this MCP process session.`);
    }
  }
}

export function afterMcpToolExecution(toolName: string, input: ToolInput = {}) {
  if (toolName === 'get_enfyra_api_context') {
    targetConfirmed = true;
    return;
  }
  if (!DESTRUCTIVE_TOOLS.has(toolName)) return;
  const key = destructivePreviewKey(toolName, input);
  if (input.confirm === true) {
    destructivePreviews.delete(key);
    return;
  }
  destructivePreviews.add(key);
}
