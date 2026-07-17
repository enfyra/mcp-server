import { isDestructiveTool, isMutationTool } from './tool-contracts.js';

type ToolInput = Record<string, unknown>;
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
  if (isDestructiveTool(toolName) && input.confirm === true) {
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
  if (!isDestructiveTool(toolName)) return;
  const key = destructivePreviewKey(toolName, input);
  if (input.confirm === true) {
    destructivePreviews.delete(key);
    return;
  }
  destructivePreviews.add(key);
}
