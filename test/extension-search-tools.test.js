import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { inspectExtensionLocation, searchExtensions } from '../dist/lib/extension-search-tools.js';

const apiUrl = 'http://mcp-extension-search.test/api';

const records = {
  extensions: [
    {
      id: 1,
      type: 'page',
      name: 'CloudHosts',
      extensionId: 'cloud-hosts',
      version: '1.0.0',
      isEnabled: true,
      description: 'Host operations page',
      updatedAt: '2026-07-03T00:00:00Z',
      menu: { id: 101, label: 'Hosts', path: '/cloud/hosts', icon: 'lucide:server', sidebar: { id: 1 } },
      code: [
        '<template>',
        '  <section>',
        '    <h2>Host settings</h2>',
        '    <UButton>Load more packages</UButton>',
        '  </section>',
        '</template>',
        '<script setup>',
        'const activeTab = ref("active")',
        '</script>',
      ].join('\n'),
    },
    {
      id: 2,
      type: 'global',
      name: 'CloudAdminNotificationBell',
      extensionId: 'cloud-admin-notification-bell',
      version: '1.0.0',
      isEnabled: true,
      description: 'Notification center and shell chips',
      updatedAt: '2026-07-03T00:00:00Z',
      code: '<script setup>const { setMenuNotification } = useMenuNotificationRegistry(); setMenuNotification("/cloud/support", { dot: true })</script>',
    },
    {
      id: 3,
      type: 'widget',
      name: 'CloudHostsOverviewWidget',
      extensionId: 'cloud-hosts-overview-widget',
      version: '1.0.0',
      isEnabled: true,
      description: 'Host overview widget',
      updatedAt: '2026-07-03T00:00:00Z',
      code: '<template><article>Your Routes</article></template>',
    },
    {
      id: 4,
      type: 'page',
      name: 'Dashboard',
      extensionId: 'dashboard-page',
      version: '1.0.0',
      isEnabled: true,
      description: 'Dashboard page',
      updatedAt: '2026-07-03T00:00:00Z',
      menu: { id: 104, label: 'Dashboard', path: '/dashboard', icon: 'lucide:layout-dashboard', sidebar: { id: 1 } },
      code: '<template><DynamicWidgetComponent :id="3" /></template>',
    },
  ],
  menus: [
    { id: 101, label: 'Hosts', path: '/cloud/hosts', icon: 'lucide:server', type: 'Menu', order: 1, isEnabled: true, sidebar: { id: 1 }, extension: { id: 1, name: 'CloudHosts', type: 'page' } },
    { id: 104, label: 'Dashboard', path: '/dashboard', icon: 'lucide:layout-dashboard', type: 'Menu', order: 2, isEnabled: true, sidebar: { id: 1 }, extension: { id: 4, name: 'Dashboard', type: 'page' } },
  ],
};

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
    if (url.includes('/enfyra_extension?')) {
      const parsed = new URL(url);
      const filter = parsed.searchParams.get('filter');
      let data = [...records.extensions];
      if (filter) {
        const parsedFilter = JSON.parse(filter);
        const type = parsedFilter?.type?._eq;
        if (type) data = data.filter((item) => item.type === type);
      }
      return jsonResponse({ data });
    }
    if (url.includes('/enfyra_menu?')) {
      return jsonResponse({ data: records.menus });
    }
    return jsonResponse({ message: `Unhandled URL: ${url}` }, false, 404);
  };
  return () => {
    globalThis.fetch = original;
    resetTokens();
  };
}

test('searchExtensions returns exact page path without widget/global noise', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    const result = await searchExtensions(apiUrl, { path: '/cloud/hosts', maxResults: 4 });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].name, 'CloudHosts');
    assert.equal(result.results[0].surface, 'page:/cloud/hosts');
    assert.equal(result.results[0].matches[0].reason, 'exact page path match');
    assert.ok(result.tokenBudget.estimatedOutputTokens < 300);
  } finally {
    restore();
  }
});

test('searchExtensions finds global shell registry code with compact snippets', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    const result = await searchExtensions(apiUrl, {
      query: 'useMenuNotificationRegistry',
      type: 'global',
      maxResults: 3,
      snippetChars: 160,
    });
    assert.equal(result.results[0].name, 'CloudAdminNotificationBell');
    assert.equal(result.results[0].surface, 'global:shell');
    assert.equal(result.results[0].matches[0].section, 'script');
    assert.ok(result.results[0].matches[0].snippet.includes('useMenuNotificationRegistry'));
    assert.ok(!result.results[0].source.tmpFile);
  } finally {
    restore();
  }
});

test('inspectExtensionLocation returns source artifact and widget consumers', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    const result = await inspectExtensionLocation(apiUrl, { id: 3 });
    assert.equal(result.extension.name, 'CloudHostsOverviewWidget');
    assert.equal(result.surface, 'widget:3');
    assert.equal(result.consumers.length, 1);
    assert.equal(result.consumers[0].name, 'Dashboard');
    assert.ok(result.source.tmpFile);
    assert.equal(readFileSync(result.source.tmpFile, 'utf8'), records.extensions[2].code);
  } finally {
    restore();
  }
});
