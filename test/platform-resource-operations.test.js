import test from 'node:test';
import assert from 'node:assert/strict';
import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { clearRuntimeCache } from '../dist/lib/runtime-cache.js';
import { GLOBAL_RULES_ACK_KEY } from '../dist/lib/required-knowledge.js';
import { reorderMenus } from '../dist/lib/platform-resource-operations.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('reorderMenus preserves the current parent when only order is provided', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'jwt-test', expTime: Date.now() + 60_000 });
    }
    requestBody = JSON.parse(init.body);
    return jsonResponse({ success: true, data: { updated: 1, ids: [7] } });
  };

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const result = await reorderMenus('https://example.test/api', {
      updates: [{ id: 7, order: 3 }],
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    assert.deepEqual(requestBody, {
      updates: [{ id: 7, order: 3 }],
    });
    assert.deepEqual(result.updates, [{ id: 7, order: 3 }]);
  } finally {
    clearRuntimeCache();
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('reorderMenus sends an explicit null parent for a root move', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'jwt-test', expTime: Date.now() + 60_000 });
    }
    requestBody = JSON.parse(init.body);
    return jsonResponse({ success: true, data: { updated: 1, ids: [7] } });
  };

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    await reorderMenus('https://example.test/api', {
      updates: [{ id: 7, order: 0, parent: null }],
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    assert.deepEqual(requestBody, {
      updates: [{ id: 7, order: 0, parent: null }],
    });
  } finally {
    clearRuntimeCache();
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});
