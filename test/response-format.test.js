import test from 'node:test';
import assert from 'node:assert/strict';

import { formatJsonPayload, formatToolResult } from '../src/lib/response-format.js';

test('formatJsonPayload encodes arrays of objects as columnar rows', () => {
  const formatted = formatJsonPayload({
    data: [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta', status: 'active' },
    ],
  });

  assert.equal(formatted.responseFormat, 'json+columnar-v1');
  assert.deepEqual(formatted.data.columns, ['id', 'name', 'status']);
  assert.deepEqual(formatted.data.rows, [
    [1, 'Alpha', null],
    [2, 'Beta', 'active'],
  ]);
  assert.equal(formatted.data.rowCount, 2);
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
  assert.deepEqual(parsed.data.columns, ['id', 'name']);
  assert.deepEqual(parsed.data.rows, [[1, 'Alpha']]);
  assert.equal(result.content[1].text, 'Saved successfully.');
});
