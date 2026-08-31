import test from 'node:test';
import assert from 'node:assert/strict';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { deleteRoute, deleteRouteChild } from '../dist/lib/platform-route-operations.js';
import { GLOBAL_RULES_ACK_KEY } from '../dist/lib/required-knowledge.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function routeFetchFixture({ isSystem = false, failSecondHandler = false } = {}) {
  const deletes = [];
  const fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    if (urlText.includes('/enfyra_route?limit=1000')) {
      return jsonResponse({
        data: [{
          id: 7,
          path: '/temporary',
          isEnabled: true,
          isSystem,
          availableMethods: [],
          publicMethods: [],
        }],
      });
    }
    if (urlText.includes('/enfyra_route_handler?')) {
      return jsonResponse({ data: [{ id: 11, method: { name: 'GET' } }, { id: 12, method: { name: 'POST' } }] });
    }
    if (
      urlText.includes('/enfyra_route_permission?')
      || urlText.includes('/enfyra_pre_hook?')
      || urlText.includes('/enfyra_post_hook?')
      || urlText.includes('/enfyra_guard?')
    ) {
      return jsonResponse({ data: [] });
    }
    if (options.method === 'DELETE') {
      deletes.push(urlText);
      if (failSecondHandler && urlText.endsWith('/enfyra_route_handler/12')) {
        return jsonResponse({ message: 'conflict' }, 409);
      }
      return jsonResponse({ success: true, statusCode: 200 });
    }
    if (urlText.endsWith('/admin/reload/routes') && options.method === 'POST') {
      return jsonResponse({ success: true });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };
  return { fetch, deletes };
}

test('delete_route requires the preview path again before any destructive request', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = routeFetchFixture();
  globalThis.fetch = fixture.fetch;
  resetTokens();
  initAuth('https://example.test/api', 'api-token');

  try {
    await assert.rejects(
      () => deleteRoute('https://example.test/api', {
        routeId: 7,
        expectedRouteId: 7,
        confirm: true,
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /expectedPath is required/,
    );
    assert.deepEqual(fixture.deletes, []);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('delete_route returns a checkpoint when a dependency delete fails', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = routeFetchFixture({ failSecondHandler: true });
  globalThis.fetch = fixture.fetch;
  resetTokens();
  initAuth('https://example.test/api', 'api-token');

  try {
    const result = await deleteRoute('https://example.test/api', {
      routeId: 7,
      expectedRouteId: 7,
      expectedPath: '/temporary',
      confirm: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    assert.equal(result.status, 'partial_failure');
    assert.deepEqual(result.deleted.handlers, [11]);
    assert.equal(result.failure.index, 1);
    assert.deepEqual(result.failure.target, {
      tableName: 'enfyra_route_handler',
      category: 'handlers',
      id: 12,
    });
    assert.equal(result.remainingTargets.at(-1).category, 'route');
    assert.equal(result.requiresNewPreview, true);
    assert.equal(result.postcondition.confirmedAbsent, false);
    assert.equal(fixture.deletes.some((url) => url.endsWith('/enfyra_route/7')), false);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('delete_route rejects system routes before deleting dependencies', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = routeFetchFixture({ isSystem: true });
  globalThis.fetch = fixture.fetch;
  resetTokens();
  initAuth('https://example.test/api', 'api-token');

  try {
    await assert.rejects(
      () => deleteRoute('https://example.test/api', {
        routeId: 7,
        expectedRouteId: 7,
        expectedPath: '/temporary',
        confirm: true,
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /system-owned/,
    );
    assert.deepEqual(fixture.deletes, []);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('delete_route_child previews, deletes one pre-hook, reloads routes, and verifies absence', async () => {
  const originalFetch = globalThis.fetch;
  const deletes = [];
  let hookDeleted = false;
  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    if (urlText.includes('/enfyra_pre_hook?')) {
      return jsonResponse({ data: hookDeleted ? [] : [{
        id: 21,
        name: 'tenant-filter',
        route: { id: 7 },
        isEnabled: true,
        isGlobal: false,
        isSystem: false,
      }] });
    }
    if (urlText.includes('/enfyra_route?limit=1000')) {
      return jsonResponse({ data: [{
        id: 7,
        path: '/temporary',
        isEnabled: true,
        isSystem: false,
        availableMethods: [],
        publicMethods: [],
      }] });
    }
    if (urlText.endsWith('/enfyra_pre_hook/21') && options.method === 'DELETE') {
      deletes.push(urlText);
      hookDeleted = true;
      return jsonResponse({ success: true, statusCode: 200 });
    }
    if (urlText.endsWith('/admin/reload/routes') && options.method === 'POST') {
      return jsonResponse({ success: true });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };
  resetTokens();
  initAuth('https://example.test/api', 'api-token');

  try {
    const preview = await deleteRouteChild('https://example.test/api', {
      kind: 'pre_hook',
      id: 21,
      confirm: false,
    });
    assert.equal(preview.action, 'delete_route_pre_hook_preview');
    assert.equal(preview.child.name, 'tenant-filter');
    assert.deepEqual(deletes, []);

    const result = await deleteRouteChild('https://example.test/api', {
      kind: 'pre_hook',
      id: 21,
      expectedId: 21,
      confirm: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    assert.equal(result.action, 'route_pre_hook_deleted');
    assert.deepEqual(deletes, ['https://example.test/api/enfyra_pre_hook/21']);
    assert.equal(result.postcondition.confirmedAbsent, true);
    assert.equal(result.routeReload.succeeded, true);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('delete_route_child permits a non-system hook on a system route', async () => {
  const originalFetch = globalThis.fetch;
  const deletes = [];
  let hookDeleted = false;
  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    if (urlText.includes('/enfyra_pre_hook?')) {
      return jsonResponse({ data: hookDeleted ? [] : [{
        id: 22,
        name: 'obsolete-normalization',
        route: { id: 8 },
        isEnabled: true,
        isGlobal: false,
        isSystem: false,
      }] });
    }
    if (urlText.includes('/enfyra_route?limit=1000')) {
      return jsonResponse({ data: [{
        id: 8,
        path: '/enfyra_user',
        isEnabled: true,
        isSystem: true,
        availableMethods: [],
        publicMethods: [],
      }] });
    }
    if (urlText.endsWith('/enfyra_pre_hook/22') && options.method === 'DELETE') {
      deletes.push(urlText);
      hookDeleted = true;
      return jsonResponse({ success: true, statusCode: 200 });
    }
    if (urlText.endsWith('/admin/reload/routes') && options.method === 'POST') {
      return jsonResponse({ success: true });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };
  resetTokens();
  initAuth('https://example.test/api', 'api-token');

  try {
    const result = await deleteRouteChild('https://example.test/api', {
      kind: 'pre_hook',
      id: 22,
      expectedId: 22,
      confirm: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    assert.equal(result.action, 'route_pre_hook_deleted');
    assert.deepEqual(deletes, ['https://example.test/api/enfyra_pre_hook/22']);
    assert.equal(result.postcondition.confirmedAbsent, true);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});
