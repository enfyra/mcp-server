import type { ToolResult, UnknownRecord } from "./types.js";
import { recordMcpToolUsage } from './mcp-usage-telemetry.js';
import { afterMcpToolExecution, beforeMcpToolExecution } from './session-safety.js';

const RESPONSE_FORMAT = 'json+columnar-v1';
const COLUMNAR_FORMAT = 'columnar-v1';
const COMPRESSION_STATS_FIELD = 'compressionStats';

function isPlainObject(value: unknown): value is UnknownRecord {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function valueForColumn(record: UnknownRecord, column: string) {
  return Object.prototype.hasOwnProperty.call(record, column) ? record[column] : null;
}

function collectColumns(records: UnknownRecord[]) {
  const columns = [];
  const seen = new Set();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

function toColumnar(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isPlainObject)) {
      const columns = collectColumns(value);
      return {
        format: COLUMNAR_FORMAT,
        columns,
        rows: value.map((record) => columns.map((column) => toColumnar(valueForColumn(record, column), seen))),
        rowCount: value.length,
      };
    }
    return value.map((item) => toColumnar(item, seen));
  }

  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = toColumnar(entry, seen);
  }
  seen.delete(value);
  return output;
}

function safeJsonStringify(value: unknown) {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    if (seen.has(entry)) return '[Circular]';
    seen.add(entry);
    return entry;
  });
}

function estimateTokens(jsonText: string) {
  if (!jsonText) return 0;
  return Math.ceil(jsonText.length / 4);
}

function buildCompressionStats(originalPayload: unknown, candidatePayload: unknown, selectedPayload: unknown, applied: boolean) {
  const originalTokens = estimateTokens(safeJsonStringify(originalPayload));
  const candidateTokens = estimateTokens(safeJsonStringify(candidatePayload));
  const responseTokens = estimateTokens(safeJsonStringify(selectedPayload));
  const candidateSavedTokens = originalTokens - candidateTokens;
  const candidateSavedPercent = originalTokens > 0
    ? Number(((candidateSavedTokens / originalTokens) * 100).toFixed(2))
    : 0;
  const savedTokens = originalTokens - responseTokens;
  const savedPercent = originalTokens > 0
    ? Number(((savedTokens / originalTokens) * 100).toFixed(2))
    : 0;
  return {
    originalTokens,
    compactTokens: responseTokens,
    savedTokens,
    savedPercent,
    applied,
    candidateCompactTokens: candidateTokens,
    candidateSavedTokens,
    candidateSavedPercent,
  };
}

function wrapPayload(payload: unknown): UnknownRecord {
  if (!isPlainObject(payload)) {
    return {
      responseFormat: RESPONSE_FORMAT,
      value: payload,
    };
  }
  return {
    responseFormat: RESPONSE_FORMAT,
    ...payload,
  };
}

function formatJsonPayloadDetailed(payload: unknown) {
  if (isPlainObject(payload) && payload.responseFormat === RESPONSE_FORMAT) {
    const compressionStats = isPlainObject(payload[COMPRESSION_STATS_FIELD])
      ? payload[COMPRESSION_STATS_FIELD]
      : undefined;
    if (compressionStats) {
      const output = { ...payload };
      delete output[COMPRESSION_STATS_FIELD];
      return { payload: output, compressionStats };
    }
    return { payload, compressionStats: undefined };
  }

  const originalPayload = wrapPayload(payload);
  const columnarPayload = wrapPayload(toColumnar(payload));
  const originalTokens = estimateTokens(safeJsonStringify(originalPayload));
  const candidateTokens = estimateTokens(safeJsonStringify(columnarPayload));
  const shouldApplyColumnar = candidateTokens < originalTokens;
  const selectedPayload: UnknownRecord = shouldApplyColumnar ? columnarPayload : originalPayload;
  return {
    payload: selectedPayload,
    compressionStats: shouldApplyColumnar
      ? buildCompressionStats(originalPayload, columnarPayload, selectedPayload, true)
      : undefined,
  };
}

export function formatJsonPayload(payload: unknown): UnknownRecord {
  return formatJsonPayloadDetailed(payload).payload;
}

export function jsonContent(payload: unknown, { pretty = false }: { pretty?: boolean } = {}): ToolResult {
  const formatted = formatJsonPayloadDetailed(payload);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(formatted.payload, null, pretty ? 2 : 0),
    }],
    ...(formatted.compressionStats ? { _meta: { enfyraCompression: formatted.compressionStats } } : {}),
  };
}

function tryParseJson(text: unknown) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function formatContentItem(item: any) {
  if (!item || item.type !== 'text') return { item, compressionStats: undefined };
  const parsed = tryParseJson(item.text);
  if (!parsed) return { item, compressionStats: undefined };
  const formatted = formatJsonPayloadDetailed(parsed);
  return {
    item: {
      ...item,
      text: JSON.stringify(formatted.payload),
    },
    compressionStats: formatted.compressionStats,
  };
}

export function formatToolResult(result: any) {
  if (!result || !Array.isArray(result.content)) return result;
  const formattedItems = result.content.map(formatContentItem);
  const compressionStats = result?._meta?.enfyraCompression
    || formattedItems.find((entry) => entry.compressionStats)?.compressionStats;
  return {
    ...result,
    content: formattedItems.map((entry) => entry.item),
    ...(compressionStats ? { _meta: { ...(result._meta || {}), enfyraCompression: compressionStats } } : {}),
  };
}

export function installColumnarToolFormatter(server: any) {
  const registerTool = server.tool.bind(server);
  server.tool = (name, description, schema, handler) => {
    if (typeof handler !== 'function') {
      return registerTool(name, description, schema, handler);
    }
    return registerTool(name, description, schema, async (...args) => {
      const startedAt = Date.now();
      try {
        beforeMcpToolExecution(name, args[0]);
        const result = await handler(...args);
        afterMcpToolExecution(name, args[0]);
        const formatted = formatToolResult(result);
        recordMcpToolUsage(name, startedAt, args, formatted);
        return formatted;
      } catch (error) {
        recordMcpToolUsage(name, startedAt, args, undefined, error);
        throw error;
      }
    });
  };
}
