import test from 'node:test';
import assert from 'node:assert/strict';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { registerMethodTools } from '../dist/lib/method-tools.js';
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

test('delete_method refuses missing ids and verifies custom method absence', async () => {
  const originalFetch = globalThis.fetch;
  const server = createToolHarness();
  let customExists = true;

  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    if (urlText.endsWith('/metadata/enfyra_method')) {
      return jsonResponse({ data: {
        id: 4,
        name: 'enfyra_method',
        columns: [{ id: 1, name: 'id', isPrimary: true }],
        relations: [],
      } });
    }
    if (urlText.includes('/enfyra_method?filter=')) {
      if (urlText.includes('%22999%22') || urlText.includes('%3A999')) return jsonResponse({ data: [] });
      return jsonResponse({
        data: customExists
          ? [{ id: 'custom-1', name: 'CUSTOM', isSystem: false }]
          : [],
      });
    }
    if (urlText.endsWith('/enfyra_method/custom-1') && options.method === 'DELETE') {
      customExists = false;
      return jsonResponse({ success: true, statusCode: 200 });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  resetTokens();
  initAuth('https://example.test/api', 'api-token');
  registerMethodTools(server, 'https://example.test/api');

  try {
    await assert.rejects(
      () => server.get('delete_method').handler({ id: '999', confirm: false }),
      /was not found/,
    );

    const preview = await server.get('delete_method').handler({ id: 'custom-1', confirm: false });
    assert.equal(preview._meta.enfyraDestructivePreview.valid, true);

    await assert.rejects(
      () => server.get('delete_method').handler({
        id: 'custom-1',
        confirm: true,
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /expectedId is required/,
    );
    assert.equal(customExists, true);

    const result = await server.get('delete_method').handler({
      id: 'custom-1',
      expectedId: 'custom-1',
      confirm: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.postcondition.confirmedAbsent, true);
    assert.deepEqual(payload.postcondition.remainingMethods, []);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('delete_method rejects system methods before sending DELETE', async () => {
  const originalFetch = globalThis.fetch;
  const server = createToolHarness();
  let deleteCount = 0;

  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    if (urlText.endsWith('/metadata/enfyra_method')) {
      return jsonResponse({ data: {
        id: 4,
        name: 'enfyra_method',
        columns: [{ id: 1, name: 'id', isPrimary: true }],
        relations: [],
      } });
    }
    if (urlText.includes('/enfyra_method?filter=')) {
      return jsonResponse({ data: [{ id: 'get-id', name: 'GET', isSystem: true }] });
    }
    if (options.method === 'DELETE') {
      deleteCount += 1;
      return jsonResponse({ success: true });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  resetTokens();
  initAuth('https://example.test/api', 'api-token');
  registerMethodTools(server, 'https://example.test/api');

  try {
    await assert.rejects(
      () => server.get('delete_method').handler({
        id: 'get-id',
        expectedId: 'get-id',
        confirm: true,
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /system-owned/,
    );
    assert.equal(deleteCount, 0);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});
