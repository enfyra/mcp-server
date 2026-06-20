const RESPONSE_FORMAT = 'json+columnar-v1';
const COLUMNAR_FORMAT = 'columnar-v1';

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function valueForColumn(record, column) {
  return Object.prototype.hasOwnProperty.call(record, column) ? record[column] : null;
}

function collectColumns(records) {
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

function toColumnar(value, seen = new WeakSet()) {
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

export function formatJsonPayload(payload) {
  const formatted = toColumnar(payload);
  if (!isPlainObject(formatted)) {
    return {
      responseFormat: RESPONSE_FORMAT,
      value: formatted,
    };
  }
  if (formatted.responseFormat === RESPONSE_FORMAT) return formatted;
  return {
    responseFormat: RESPONSE_FORMAT,
    ...formatted,
  };
}

export function jsonContent(payload, { pretty = false } = {}) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(formatJsonPayload(payload), null, pretty ? 2 : 0),
    }],
  };
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function formatContentItem(item) {
  if (!item || item.type !== 'text') return item;
  const parsed = tryParseJson(item.text);
  if (!parsed) return item;
  return {
    ...item,
    text: JSON.stringify(formatJsonPayload(parsed)),
  };
}

export function formatToolResult(result) {
  if (!result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map(formatContentItem),
  };
}

export function installColumnarToolFormatter(server) {
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
