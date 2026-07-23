import { jsonContent } from './response-format.js';
import type { DestructivePreviewReceipt, ToolResult, UnknownRecord } from './types.js';

export function destructivePreviewContent(
  toolName: string,
  payload: UnknownRecord,
  targetCount: number,
): ToolResult {
  const receipt: DestructivePreviewReceipt = {
    version: 1,
    valid: true,
    toolName,
    action: String(payload.action || 'destructive_preview'),
    targetCount,
  };
  const result = jsonContent({
    ...payload,
    previewReceipt: receipt,
  });
  return {
    ...result,
    _meta: {
      ...(result._meta || {}),
      enfyraDestructivePreview: receipt,
    },
  };
}
