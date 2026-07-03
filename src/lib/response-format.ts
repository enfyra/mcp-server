import type { ToolResult, UnknownRecord } from "./types.js";

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

function attachCompressionStats(originalPayload: unknown, candidatePayload: unknown, selectedPayload: UnknownRecord, applied: boolean) {
  if (!applied) return selectedPayload;
  if (
    isPlainObject(selectedPayload)
    && selectedPayload.responseFormat === RESPONSE_FORMAT
    && selectedPayload[COMPRESSION_STATS_FIELD]
  ) {
    return selectedPayload;
  }
  return {
    ...selectedPayload,
    [COMPRESSION_STATS_FIELD]: buildCompressionStats(originalPayload, candidatePayload, selectedPayload, applied),
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

export function formatJsonPayload(payload: unknown): UnknownRecord {
  if (
    isPlainObject(payload)
    && payload.responseFormat === RESPONSE_FORMAT
    && payload[COMPRESSION_STATS_FIELD]
  ) {
    return payload;
  }

  const originalPayload = wrapPayload(payload);
  const columnarPayload = wrapPayload(toColumnar(payload));
  const originalTokens = estimateTokens(safeJsonStringify(originalPayload));
  const candidateTokens = estimateTokens(safeJsonStringify(columnarPayload));
  const shouldApplyColumnar = candidateTokens < originalTokens;
  const selectedPayload: UnknownRecord = shouldApplyColumnar ? columnarPayload : originalPayload;
  return attachCompressionStats(originalPayload, columnarPayload, selectedPayload, shouldApplyColumnar);
}

export function jsonContent(payload: unknown, { pretty = false }: { pretty?: boolean } = {}): ToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(formatJsonPayload(payload), null, pretty ? 2 : 0),
    }],
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
  if (!item || item.type !== 'text') return item;
  const parsed = tryParseJson(item.text);
  if (!parsed) return item;
  return {
    ...item,
    text: JSON.stringify(formatJsonPayload(parsed)),
  };
}

export function formatToolResult(result: any) {
  if (!result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map(formatContentItem),
  };
}

export function installColumnarToolFormatter(server: any) {
  const registerTool = server.tool.bind(server);
  server.tool = (name, description, schema, handler) => {
    if (typeof handler !== 'function') {
      return registerTool(name, description, schema, handler);
    }
    return registerTool(name, description, schema, async (...args) => {
      const result = await handler(...args);
      return formatToolResult(result);
    });
  };
}
