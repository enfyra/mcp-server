import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSourceTree } from '../test-support/source-tree.js';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { debugFieldExposure, searchAdminExtensions, searchRuntimeZone } from '../dist/lib/runtime-zone-tools.js';

const apiUrl = 'http://mcp-runtime-zone.test/api';

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
    if (url.includes('/enfyra_route_handler?')) {
      return jsonResponse({
        data: [{
          id: 11,
          name: 'Create project',
          route: { path: '/cloud/projects' },
          method: { name: 'POST' },
          sourceCode: 'const project = await @REPOS.secure.cloud_projects.create({ data: @BODY })\nreturn project.data?.[0] ?? null',
        }],
      });
    }
    if (url.includes('/enfyra_route?')) {
      return jsonResponse({ data: [{ id: 10, path: '/cloud/projects', description: 'Cloud project route' }] });
    }
    if (url.includes('/enfyra_pre_hook?') || url.includes('/enfyra_post_hook?') || url.includes('/enfyra_guard?') || url.includes('/enfyra_guard_rule?') || url.includes('/enfyra_route_permission?')) {
      return jsonResponse({ data: [] });
    }
    return jsonResponse({ message: `Unhandled URL: ${url}` }, false, 404);
  };
  return () => {
    globalThis.fetch = original;
    resetTokens();
  };
}

test('searchRuntimeZone returns a bounded zone catalog when the zone is unknown', async () => {
  const result = await searchRuntimeZone(apiUrl, {});
  assert.equal(result.action, 'runtime_zone_catalog');
  assert.equal(result.zones.length, 9);
  assert.equal(result.zones.some((zone) => zone.name === 'auth_security'), true);
  assert.deepEqual(result.zones.find((zone) => zone.name === 'storage_file').nextSearch.input, {
    mode: 'search',
    zone: 'storage_file',
  });
});

test('searchRuntimeZone returns bounded inventory when query and path are omitted', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    const result = await searchRuntimeZone(apiUrl, {
      zone: 'api_runtime',
      maxResults: 2,
    });
    assert.equal(result.action, 'runtime_zone_inventory');
    assert.equal(result.results.length, 2);
    assert.equal(result.resultCount, 2);
    assert.equal(result.results.every((entry) => entry.nextInspect.input.mode === 'inspect'), true);
  } finally {
    restore();
  }
});

test('searchRuntimeZone searches and inspects one API runtime artifact through one tool contract', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    const searched = await searchRuntimeZone(apiUrl, {
      zone: 'api_runtime',
      query: '@REPOS.secure.cloud_projects',
      maxResults: 4,
    });
    assert.equal(searched.results[0].tableName, 'enfyra_route_handler');
    assert.equal(searched.results[0].routePath, '/cloud/projects');
    assert.equal(searched.results[0].nextInspect.tool, 'search_runtime_zone');
    assert.equal(searched.results[0].nextInspect.input.mode, 'inspect');

    const inspected = await searchRuntimeZone(apiUrl, searched.results[0].nextInspect.input);
    assert.equal(inspected.action, 'runtime_zone_location_inspected');
    assert.equal(inspected.tableName, 'enfyra_route_handler');
    assert.equal(readFileSync(inspected.sources[0].tmpFile, 'utf8').includes('@REPOS.secure.cloud_projects'), true);
  } finally {
    restore();
  }
});

test('searchRuntimeZone admin_ui normalizes extension results to the same inspect contract', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/token/exchange')) {
        return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 600_000 });
      }
      if (url.includes('/enfyra_extension?')) {
        return jsonResponse({ data: [{ id: 9, type: 'page', name: 'HostsPage', isEnabled: true, code: '<template><h1>Host settings</h1></template>' }] });
      }
      if (url.includes('/enfyra_menu?')) {
        return jsonResponse({ data: [{ id: 19, label: 'Hosts', path: '/cloud/hosts', extension: { id: 9 } }] });
      }
      return jsonResponse({ data: [] });
    };
    const searched = await searchRuntimeZone(apiUrl, { zone: 'admin_ui', query: 'Host settings' });
    assert.equal(searched.action, 'runtime_zone_searched');
    assert.equal(searched.results[0].zone, 'admin_ui');
    assert.equal(searched.results[0].nextInspect.tool, 'search_runtime_zone');
    assert.equal(searched.results[0].nextInspect.input.mode, 'inspect');
  } finally {
    restore();
  }
});

test('searchAdminExtensions keeps weak agents on the focused admin UI locator path', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/token/exchange')) {
        return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 600_000 });
      }
      if (url.includes('/enfyra_extension?')) {
        return jsonResponse({ data: [{ id: 9, type: 'page', name: 'HostsPage', isEnabled: true, code: '<template><UButton>Save settings</UButton></template>' }] });
      }
      if (url.includes('/enfyra_menu?')) {
        return jsonResponse({ data: [{ id: 19, label: 'Hosts', path: '/cloud/hosts', extension: { id: 9 } }] });
      }
      return jsonResponse({ data: [] });
    };
    const searched = await searchAdminExtensions(apiUrl, { query: 'Save settings' });
    assert.equal(searched.action, 'admin_extensions_searched');
    assert.equal(searched.results[0].nextInspect.tool, 'search_admin_extensions');
    assert.equal(searched.results[0].nextInspect.input.mode, 'inspect');
  } finally {
    restore();
  }
});

test('searchAdminExtensions uses name in search mode as an exact absence verifier', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/token/exchange')) {
        return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 600_000 });
      }
      if (url.includes('/enfyra_extension?') || url.includes('/enfyra_menu?')) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({ data: [] });
    };
    const searched = await searchAdminExtensions(apiUrl, { mode: 'search', name: 'removed-fixture' });
    assert.equal(searched.action, 'admin_extensions_searched');
    assert.equal(searched.matchMode, 'exact');
    assert.equal(searched.targetFound, false);
    assert.equal(searched.exactMatchCount, 0);
    assert.deepEqual(searched.results, []);
  } finally {
    restore();
  }
});

test('searchRuntimeZone uses live metadata for zone projections and indexes folder slugs', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/token/exchange')) {
        return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 600_000 });
      }
      if (url.endsWith('/metadata/enfyra_folder')) {
        return jsonResponse({ data: { columns: [{ name: 'id' }, { name: 'name' }, { name: 'slug' }, { name: 'description' }], relations: [] } });
      }
      if (url.endsWith('/metadata/enfyra_oauth_config')) {
        return jsonResponse({ data: { columns: [{ name: 'id' }, { name: 'provider' }, { name: 'redirectUri' }, { name: 'sourceCode' }, { name: 'appCallbackUrl' }, { name: 'autoSetCookies' }, { name: 'scriptLanguage' }, { name: 'isEnabled' }, { name: 'description' }], relations: [] } });
      }
      if (url.includes('/metadata/')) return jsonResponse({ data: { columns: [{ name: 'id' }], relations: [] } });
      if (url.includes('/enfyra_folder?')) {
        assert.match(url, /fields=id%2Cname%2Cslug%2Cdescription/);
        return jsonResponse({ data: [{ id: 'folder-1', name: 'Fixture', slug: 'luna-storage-fixture', description: 'safe fixture' }] });
      }
      if (url.includes('/enfyra_oauth_config?')) {
        assert.doesNotMatch(url, /_id/);
        return jsonResponse({ data: [{ id: 1, provider: 'github', description: 'OAuth test' }] });
      }
      return jsonResponse({ data: [] });
    };

    const storage = await searchRuntimeZone(apiUrl, { zone: 'storage_file', query: 'luna-storage-fixture' });
    assert.equal(storage.results[0].tableName, 'enfyra_folder');
    assert.equal(storage.results[0].id, 'folder-1');

    const auth = await searchRuntimeZone(apiUrl, { zone: 'auth_security', query: 'github' });
    assert.equal(auth.results[0].tableName, 'enfyra_oauth_config');
    assert.equal(auth.readErrors.some((entry) => entry.tableName === 'enfyra_oauth_config'), false);
  } finally {
    restore();
  }
});

test('debugFieldExposure resolves unpublished deep field paths and returns escalation guidance', async () => {
  const restore = installFetchMock();
  try {
    initAuth(apiUrl, 'efy_pat_test');
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/token/exchange')) {
        return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 600_000 });
      }
      if (url.includes('/enfyra_table?')) {
        return jsonResponse({
          data: [
            { id: 1, name: 'orders' },
            { id: 2, name: 'users' },
          ],
        });
      }
      if (url.endsWith('/metadata/orders')) return jsonResponse({ data: {
        id: 1,
        name: 'orders',
        columns: [{ name: 'id', isPublished: true }],
        relations: [{ propertyName: 'customer', targetTable: { name: 'users' } }],
      } });
      if (url.endsWith('/metadata/users')) return jsonResponse({ data: {
        id: 2,
        name: 'users',
        columns: [
          { name: 'email', isPublished: true },
          { name: 'api_secret', isPublished: false, isEncrypted: true },
        ],
        relations: [],
      } });
      return jsonResponse({ data: [] });
    };
    const result = await debugFieldExposure(apiUrl, {
      tableName: 'orders',
      fieldPath: 'customer.api_secret',
    });
    assert.equal(result.metadataFinding.targetTable, 'users');
    assert.equal(result.metadataFinding.fieldName, 'api_secret');
    assert.equal(result.metadataFinding.isPublished, false);
    assert.match(result.verdict, /core field-exposure bug/);
    assert.equal(result.reproRequest.input.path, '/orders?fields=customer.api_secret&limit=1');
  } finally {
    restore();
  }
});

test('mcp server exposes runtime zone search as the single DB-backed locator entry point', () => {
  const entry = readSourceTree();
  assert.match(entry, /registerRuntimeZoneTools/);
  assert.doesNotMatch(entry, /registerExtensionSearchTools/);
});
