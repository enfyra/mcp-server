import test from 'node:test';
import assert from 'node:assert/strict';

import { formatJsonPayload, formatToolResult } from '../dist/lib/response-format.js';

test('formatJsonPayload encodes arrays of objects as columnar rows', () => {
  const formatted = formatJsonPayload({
    data: Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      name: `Item ${index + 1}`,
      status: index % 2 === 0 ? 'active' : 'draft',
      owner: 'codex',
    })),
  });

  assert.equal(formatted.responseFormat, 'json+columnar-v1');
  assert.equal(formatted.compressionStats, undefined);
  assert.deepEqual(formatted.data.columns, ['id', 'name', 'status', 'owner']);
  assert.equal(formatted.data.rowCount, 12);
  assert.deepEqual(formatted.data.rows[0], [1, 'Item 1', 'active', 'codex']);
});

test('formatJsonPayload keeps raw object shape when columnar is larger', () => {
  const formatted = formatJsonPayload({
    data: [{ id: 1, name: 'Alpha' }],
  });

  assert.equal(formatted.responseFormat, 'json+columnar-v1');
  assert.equal(formatted.compressionStats, undefined);
  assert.deepEqual(formatted.data, [{ id: 1, name: 'Alpha' }]);
});

test('formatToolResult rewrites JSON text content without changing plain text', () => {
  const result = formatToolResult({
    content: [
      { type: 'text', text: '{"data":[{"id":1,"name":"Alpha"}]}' },
      { type: 'text', text: 'Saved successfully.' },
    ],
  });

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.responseFormat, 'json+columnar-v1');
  assert.equal(parsed.compressionStats, undefined);
  assert.deepEqual(parsed.data, [{ id: 1, name: 'Alpha' }]);
  assert.equal(result.content[1].text, 'Saved successfully.');
});

test('formatToolResult keeps compression telemetry in MCP metadata instead of model-visible JSON', () => {
  const result = formatToolResult({
    content: [{
      type: 'text',
      text: JSON.stringify({
        data: Array.from({ length: 12 }, (_, index) => ({ id: index, status: 'active', owner: 'codex' })),
      }),
    }],
  });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.compressionStats, undefined);
  assert.equal(result._meta.enfyraCompression.applied, true);
  assert.equal(typeof result._meta.enfyraCompression.savedTokens, 'number');
});
