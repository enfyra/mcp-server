import test from 'node:test';
import assert from 'node:assert/strict';
import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { clearRuntimeCache } from '../dist/lib/runtime-cache.js';
import { GLOBAL_RULES_ACK_KEY } from '../dist/lib/required-knowledge.js';
import {
  ensureAuthHeader,
  reorderAuthHeaders,
} from '../dist/lib/auth-header-operations.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authExchange(url, init = {}) {
  if (String(url).endsWith('/auth/token/exchange')) {
    return jsonResponse({ accessToken: 'jwt-test', expTime: Date.now() + 60_000 });
  }
  return null;
}

test('ensureAuthHeader normalizes a coding-tool API key header and verifies the saved mapping', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const saved = {
    id: 12,
    headerKey: 'x-api-key',
    credentialType: 'pat',
    scheme: 'raw',
    priority: 2,
    isEnabled: true,
    isSystem: false,
    description: 'Coding tool API key',
  };

  globalThis.fetch = async (url, init = {}) => {
    const exchange = authExchange(url, init);
    if (exchange) return exchange;
    requests.push({ url: String(url), method: String(init.method || 'GET'), body: init.body });
    if (String(url).includes('/enfyra_auth_header?')) return jsonResponse({ data: [saved] });
    if (String(url).endsWith('/enfyra_auth_header/12')) return jsonResponse({ data: [saved] });
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const result = await ensureAuthHeader('https://example.test/api', {
      headerKey: 'X-API-Key',
      credentialType: 'pat',
      scheme: 'raw',
      priority: 2,
      description: 'Coding tool API key',
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    assert.equal(result.action, 'updated');
    assert.equal(result.header.headerKey, 'x-api-key');
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[1].method, 'PATCH');
    assert.deepEqual(JSON.parse(requests[1].body), {
      headerKey: 'x-api-key',
      credentialType: 'pat',
      scheme: 'raw',
      priority: 2,
      isEnabled: true,
      description: 'Coding tool API key',
    });
  } finally {
    clearRuntimeCache();
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('reorderAuthHeaders uses the native reorder endpoint and verifies priorities', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let verified = false;
  const initial = [
    { id: 10, headerKey: 'x-enfyra-pat', credentialType: 'pat', scheme: 'raw', priority: 0, isEnabled: true, isSystem: true },
    { id: 12, headerKey: 'x-api-key', credentialType: 'pat', scheme: 'raw', priority: 2, isEnabled: true, isSystem: false },
  ];
  const after = initial.map((item) => ({ ...item, priority: item.id === 12 ? 1 : 0 }));

  globalThis.fetch = async (url, init = {}) => {
    const exchange = authExchange(url, init);
    if (exchange) return exchange;
    const request = { url: String(url), method: String(init.method || 'GET'), body: init.body };
    requests.push(request);
    if (String(url).includes('/enfyra_auth_header?')) {
      return jsonResponse({ data: verified ? after : initial });
    }
    if (String(url).endsWith('/admin/auth-header/reorder')) {
      assert.deepEqual(JSON.parse(init.body), {
        updates: [{ id: 12, priority: 1 }, { id: 10, priority: 0 }],
      });
      verified = true;
      return jsonResponse({ success: true, data: { updated: 2, ids: [12, 10] } });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const result = await reorderAuthHeaders('https://example.test/api', {
      updates: [{ id: 12, priority: 1 }, { id: 10, priority: 0 }],
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    assert.equal(result.action, 'auth_headers_reordered');
    assert.equal(result.verified, true);
    assert.equal(requests.some((request) => request.url.endsWith('/admin/auth-header/reorder')), true);
  } finally {
    clearRuntimeCache();
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});
