import test from 'node:test';
import assert from 'node:assert/strict';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { registerPackageTools } from '../dist/lib/package-tools.js';
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

test('package lifecycle tools toggle runtime state and preview uninstall before deletion', async () => {
  const originalFetch = globalThis.fetch;
  const server = createToolHarness();
  let packageRecord = {
    id: 'package-1',
    name: 'readable-stream',
    version: '4.7.0',
    type: 'Server',
    isEnabled: true,
    isSystem: false,
    status: 'installed',
  };

  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    if (urlText.includes('/enfyra_package?filter=')) {
      return jsonResponse({ data: packageRecord ? [packageRecord] : [] });
    }
    if (urlText.endsWith('/enfyra_package/package-1') && options.method === 'PATCH') {
      const body = JSON.parse(String(options.body));
      packageRecord = { ...packageRecord, isEnabled: body.isEnabled };
      return jsonResponse({ data: [packageRecord] });
    }
    if (urlText.endsWith('/enfyra_package/package-1') && options.method === 'DELETE') {
      packageRecord = null;
      return jsonResponse({ success: true, statusCode: 200 });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  resetTokens();
  initAuth('https://example.test/api', 'api-token');
  registerPackageTools(server, 'https://example.test/api');

  try {
    const disabled = await server.get('disable_package').handler({
      id: 'package-1',
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    assert.equal(JSON.parse(disabled.content[0].text).package.isEnabled, false);

    const enabled = await server.get('enable_package').handler({
      id: 'package-1',
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    assert.equal(JSON.parse(enabled.content[0].text).package.isEnabled, true);

    const preview = await server.get('uninstall_package').handler({
      id: 'package-1',
      confirm: false,
    });
    assert.equal(preview._meta.enfyraDestructivePreview.valid, true);

    await assert.rejects(
      () => server.get('uninstall_package').handler({
        id: 'package-1',
        confirm: true,
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /expectedId is required/,
    );
    assert.ok(packageRecord);

    const removed = await server.get('uninstall_package').handler({
      id: 'package-1',
      expectedId: 'package-1',
      confirm: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    const payload = JSON.parse(removed.content[0].text);
    assert.equal(payload.postcondition.confirmedAbsent, true);
    assert.deepEqual(payload.postcondition.remainingPackages, []);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('uninstall_package rejects a system package before deletion', async () => {
  const originalFetch = globalThis.fetch;
  const server = createToolHarness();
  let deleteCount = 0;

  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    if (urlText.includes('/enfyra_package?filter=')) {
      return jsonResponse({ data: [{
        id: 'system-package',
        name: 'undici',
        type: 'Server',
        isEnabled: true,
        isSystem: true,
      }] });
    }
    if (options.method === 'DELETE') {
      deleteCount += 1;
      return jsonResponse({ success: true });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  resetTokens();
  initAuth('https://example.test/api', 'api-token');
  registerPackageTools(server, 'https://example.test/api');

  try {
    await assert.rejects(
      () => server.get('uninstall_package').handler({
        id: 'system-package',
        confirm: false,
      }),
      /system-owned/,
    );
    assert.equal(deleteCount, 0);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});
