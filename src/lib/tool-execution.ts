import { z } from 'zod';
import { recordMcpToolUsage } from './mcp-usage-telemetry.js';
import { formatToolResult } from './response-format.js';
import { afterMcpToolExecution, beforeMcpToolExecution } from './session-safety.js';
import { validateStructuredToolOutput } from './tool-output-contracts.js';
import type { RegisteredToolDefinition, ToolCatalogOptions } from './types.js';

export async function executeToolDefinition(tool: RegisteredToolDefinition, input: Record<string, unknown>, extra?: unknown, resolveAvailability?: ToolCatalogOptions['resolveAvailability']) {
  const startedAt = Date.now();
  try {
    const parsed = z.object(tool.inputSchema as z.ZodRawShape).parse(input);
    beforeMcpToolExecution(tool.name, parsed);
    const availability = resolveAvailability ? (await resolveAvailability([tool.name]))[tool.name] : undefined;
    if (availability?.status === 'denied') throw new Error(`${tool.name} is unavailable for the current PAT: ${availability.reason}`);
    const result = await tool.handler(parsed, extra);
    const formatted = formatToolResult(result, { toolName: tool.name });
    if (formatted?.isError !== true) {
      const validated = validateStructuredToolOutput(tool.name, formatted?.structuredContent);
      if (validated.success === false) throw new Error(`${tool.name} returned invalid structured output: ${validated.error.message}`);
    }
    afterMcpToolExecution(tool.name, parsed, formatted);
    recordMcpToolUsage(tool.name, startedAt, [parsed], formatted);
    return formatted;
  } catch (error) {
    recordMcpToolUsage(tool.name, startedAt, [input], undefined, error);
    throw error;
  }
}
