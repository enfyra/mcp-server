import test from 'node:test';
import assert from 'node:assert/strict';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { resolveRouteContext } from '../dist/lib/compound-tools.js';

const apiUrl = 'http://mcp-compound-tools.test/api';

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installFetchMock() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 600_000 });
    }
    if (url.includes('/enfyra_menu?')) {
      return jsonResponse({
        data: [{
          id: 5,
          label: 'Support',
          path: '/support',
          icon: 'lucide:circle-help',
          type: 'Menu',
          isPublic: false,
          isEnabled: true,
          order: 2,
          parent: { id: 1 },
        }],
      });
    }
    if (url.includes('/enfyra_route?')) {
      return jsonResponse({
        data: [{
          id: 9,
          path: '/support',
          isEnabled: true,
          description: 'Support API',
          availableMethods: [{ name: 'GET' }],
          publicMethods: [],
          mainTable: { id: 12, name: 'support_ticket' },
        }],
      });
    }
    if (url.includes('/enfyra_route_handler?')) {
      return jsonResponse({ data: [{ id: 11, method: { name: 'GET' }, scriptLanguage: 'javascript', timeout: 5000, isEnabled: true }] });
    }
    if (url.includes('/enfyra_pre_hook?')) {
      return jsonResponse({ data: [{ id: 13, name: 'tenant-scope', methods: [{ name: 'GET' }], priority: 1, isEnabled: true }] });
    }
    if (url.includes('/enfyra_post_hook?')) {
      return jsonResponse({ data: [] });
    }
    if (url.includes('/enfyra_route_permission?')) {
      return jsonResponse({ data: [{ id: 15, role: { name: 'user' }, allowedUsers: [], methods: [{ name: 'GET' }], isEnabled: true, description: 'Support access' }] });
    }
    if (url.includes('/enfyra_guard?')) {
      return jsonResponse({ data: [{ id: 17, name: 'support-limit', type: 'route', position: 'pre_auth', isEnabled: true, isGlobal: false, priority: 0, combinator: 'and' }] });
    }
    if (url.includes('/enfyra_extension?')) {
      return jsonResponse({ data: [] });
    }
    return jsonResponse({ message: `Unhandled URL: ${url}` }, false, 404);
  };
  return () => {
    globalThis.fetch = original;
    resetTokens();
  };
}

test('resolveRouteContext returns a compact cross-surface route diagnosis', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    const result = await resolveRouteContext(apiUrl, '/support');

    assert.deepEqual(result.menu, {
      id: 5,
      label: 'Support',
      path: '/support',
      icon: 'lucide:circle-help',
      type: 'Menu',
      isPublic: false,
      isEnabled: true,
      order: 2,
      parentId: 1,
    });
    assert.deepEqual(result.route, {
      id: 9,
      path: '/support',
      isEnabled: true,
      description: 'Support API',
      availableMethods: ['GET'],
      publicMethods: [],
      mainTable: { id: 12, name: 'support_ticket' },
    });
    assert.deepEqual(result.handlers, [{ id: 11, scriptLanguage: 'javascript', timeout: 5000, isEnabled: true, method: 'GET' }]);
    assert.deepEqual(result.hooks.pre, [{ id: 13, name: 'tenant-scope', priority: 1, isEnabled: true, methods: ['GET'] }]);
    assert.deepEqual(result.permissions, [{ id: 15, description: 'Support access', isEnabled: true, role: 'user', allowedUserIds: [], methods: ['GET'] }]);
    assert.deepEqual(result.summary.blockedReasons, []);
    assert.equal(result.summary.isReachable, true);
    assert.deepEqual(result.errors, []);
  } finally {
    restore();
  }
});

test('resolveRouteContext reports an inaccessible private route without permissions', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/enfyra_route_permission?')) return jsonResponse({ data: [] });
      return originalFetch(input, init);
    };

    const result = await resolveRouteContext(apiUrl, '/support');
    assert.deepEqual(result.summary.blockedReasons, ['no_permission_and_not_public']);
    assert.equal(result.summary.isReachable, false);
  } finally {
    restore();
  }
});
