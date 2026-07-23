import test from 'node:test';
import assert from 'node:assert/strict';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { registerRecordTools } from '../dist/lib/record-tools.js';
import { GLOBAL_RULES_ACK_KEY } from '../dist/lib/required-knowledge.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createToolHarness() {
  const tools = new Map();
  return {
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
    get(name) {
      const tool = tools.get(name);
      assert.ok(tool, `Expected tool ${name} to be registered`);
      return tool;
    },
  };
}

function metadataResponse() {
  return jsonResponse({ data: {
    id: 61,
    name: 'temporary_notes',
    columns: [{ id: 1, name: 'id', isPrimary: true }],
    relations: [],
  } });
}

test('delete_records preview fails closed when an exact target read fails', async () => {
  const originalFetch = globalThis.fetch;
  const server = createToolHarness();

  globalThis.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    if (urlText.endsWith('/metadata/temporary_notes')) return metadataResponse();
    if (urlText.includes('/temporary_notes?')) {
      return jsonResponse({ message: 'preview unavailable' }, 503);
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  resetTokens();
  initAuth('https://example.test/api', 'api-token');
  registerRecordTools(server, 'https://example.test/api');

  try {
    await assert.rejects(
      () => server.get('delete_records').handler({
        tableName: 'temporary_notes',
        items: [{ id: 1 }],
        confirm: false,
      }),
      /API error \(503\)/,
    );
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('delete_records returns a partial checkpoint and verifies remaining ids', async () => {
  const originalFetch = globalThis.fetch;
  const server = createToolHarness();

  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    if (urlText.endsWith('/metadata/temporary_notes')) return metadataResponse();
    if (urlText.endsWith('/temporary_notes/1') && options.method === 'DELETE') {
      return jsonResponse({ success: true, statusCode: 200 });
    }
    if (urlText.endsWith('/temporary_notes/2') && options.method === 'DELETE') {
      return jsonResponse({ message: 'conflict' }, 409);
    }
    if (urlText.includes('/temporary_notes?')) {
      return jsonResponse({ data: [{ id: 2 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  resetTokens();
  initAuth('https://example.test/api', 'api-token');
  registerRecordTools(server, 'https://example.test/api');

  try {
    const result = await server.get('delete_records').handler({
      tableName: 'temporary_notes',
      items: [{ id: 1 }, { id: 2 }],
      confirm: true,
      skipNotFound: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(result.isError, true);
    assert.equal(payload.action, 'delete_records_partial_failure');
    assert.equal(payload.completed.length, 1);
    assert.equal(payload.failure.index, 1);
    assert.equal(payload.requiresNewPreview, true);
    assert.equal(payload.postcondition.confirmedAbsent, false);
    assert.deepEqual(payload.postcondition.remainingIds, [2]);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});
