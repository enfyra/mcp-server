import test from 'node:test';
import assert from 'node:assert/strict';
import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { clearRuntimeCache } from '../dist/lib/runtime-cache.js';
import { GLOBAL_RULES_ACK_KEY, EXTENSION_KNOWLEDGE_ACK_KEY } from '../dist/lib/required-knowledge.js';
import { deleteExtension, deleteMenu, reorderMenus } from '../dist/lib/platform-resource-operations.js';
import { updateExtensionCode } from '../dist/lib/platform-extension-source.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupFetch(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'jwt-test', expTime: Date.now() + 60_000 });
    }
    return handler(url, init);
  };
  return () => {
    clearRuntimeCache();
    resetTokens();
    globalThis.fetch = originalFetch;
  };
}

test('reorderMenus preserves the current parent when only order is provided', async () => {
  let requestBody;
  const restore = setupFetch(async (_url, init = {}) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse({ success: true, data: { updated: 1, ids: [7] } });
  });

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const result = await reorderMenus('https://example.test/api', {
      updates: [{ id: 7, order: 3 }],
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    assert.deepEqual(requestBody, { updates: [{ id: 7, order: 3 }] });
    assert.deepEqual(result.updates, [{ id: 7, order: 3 }]);
  } finally {
    restore();
  }
});

test('reorderMenus sends an explicit null parent for a root move', async () => {
  let requestBody;
  const restore = setupFetch(async (_url, init = {}) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse({ success: true, data: { updated: 1, ids: [7] } });
  });

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    await reorderMenus('https://example.test/api', {
      updates: [{ id: 7, order: 0, parent: null }],
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    assert.deepEqual(requestBody, { updates: [{ id: 7, order: 0, parent: null }] });
  } finally {
    restore();
  }
});

test('updateExtensionCode skips source validation for isEnabled-only changes', async () => {
  const requests = [];
  const restore = setupFetch(async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes('/enfyra_extension?')) {
      return jsonResponse({ data: [{ id: 16, name: 'Bell', type: 'global', isEnabled: false, version: '1.0.0', code: '<template></template>' }] });
    }
    return jsonResponse({ data: [{ id: 16, name: 'Bell', type: 'global', isEnabled: true, version: '1.0.0' }] });
  });

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const result = await updateExtensionCode('https://example.test/api', {
      id: 16,
      isEnabled: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      extensionKnowledgeAckKey: EXTENSION_KNOWLEDGE_ACK_KEY,
    });

    assert.equal(result.action, 'extension_state_updated');
    assert.deepEqual(result.validation, { skipped: true, reason: 'Only isEnabled changed.' });
    assert.equal(result.verification.skipped, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].method, 'PATCH');
    assert.deepEqual(requests[1].body, { isEnabled: true });
  } finally {
    restore();
  }
});

test('deleteExtension previews exact dependencies and verifies physical absence after confirmation', async () => {
  const requests = [];
  let extension = {
    id: 16,
    name: 'TemporaryWidget',
    type: 'widget',
    isEnabled: true,
    isSystem: false,
    menu: { id: 42, label: 'Temporary', path: '/temporary' },
  };
  const restore = setupFetch(async (url, init = {}) => {
    const urlText = String(url);
    requests.push({ url: urlText, method: init.method });
    if (urlText.includes('/enfyra_extension?')) return jsonResponse({ data: extension ? [extension] : [] });
    if (urlText.endsWith('/enfyra_extension/16') && init.method === 'DELETE') {
      extension = null;
      return jsonResponse({ success: true, statusCode: 200 });
    }
    throw new Error(`Unexpected request: ${urlText}`);
  });

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const preview = await deleteExtension('https://example.test/api', { id: 16, confirm: false });
    assert.equal(preview.action, 'delete_extension_preview');
    assert.equal(preview.extension.menu.id, 42);
    await assert.rejects(
      () => deleteExtension('https://example.test/api', { id: 16, confirm: true }),
      /expectedExtensionId is required/,
    );
    const result = await deleteExtension('https://example.test/api', {
      id: 16,
      expectedExtensionId: 16,
      confirm: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    assert.equal(result.action, 'extension_deleted');
    assert.equal(result.postcondition.confirmedAbsent, true);
    assert.equal(requests.filter((request) => request.method === 'DELETE').length, 1);
  } finally {
    restore();
  }
});

test('deleteMenu previews children and permissions, then verifies dependency cleanup', async () => {
  const requests = [];
  let menu = {
    id: 24,
    label: 'Temporary menu',
    path: '/temporary-menu',
    type: 'Menu',
    isEnabled: true,
    isSystem: false,
    parent: null,
  };
  let deleted = false;
  const restore = setupFetch(async (url, init = {}) => {
    const urlText = String(url);
    requests.push({ url: urlText, method: init.method });
    if (urlText.includes('/enfyra_menu?')) {
      const filter = decodeURIComponent(new URL(urlText).searchParams.get('filter') || '');
      if (filter.includes('parent')) return jsonResponse({ data: [] });
      return jsonResponse({ data: deleted ? [] : [menu] });
    }
    if (urlText.includes('/enfyra_menu_permission?')) return jsonResponse({ data: deleted ? [] : [{ id: 91, isEnabled: true, role: { id: 5, name: 'AI' } }] });
    if (urlText.includes('/enfyra_extension?')) return jsonResponse({ data: deleted ? [] : [{ id: 16, name: 'TemporaryWidget', type: 'widget', isEnabled: true, isSystem: false, menu: { id: 24 } }] });
    if (urlText.endsWith('/enfyra_menu/24') && init.method === 'DELETE') {
      deleted = true;
      menu = null;
      return jsonResponse({ success: true, statusCode: 200 });
    }
    throw new Error(`Unexpected request: ${urlText}`);
  });

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const preview = await deleteMenu('https://example.test/api', { menuId: 24, confirm: false });
    assert.equal(preview.action, 'delete_menu_preview');
    assert.equal(preview.dependencies.permissions[0].role, 'AI');
    await assert.rejects(
      () => deleteMenu('https://example.test/api', { menuId: 24, confirm: true }),
      /expectedMenuId is required/,
    );
    const result = await deleteMenu('https://example.test/api', {
      menuId: 24,
      expectedMenuId: 24,
      confirm: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    assert.equal(result.action, 'menu_deleted');
    assert.equal(result.postcondition.confirmedAbsent, true);
    assert.equal(requests.filter((request) => request.method === 'DELETE').length, 1);
  } finally {
    restore();
  }
});
