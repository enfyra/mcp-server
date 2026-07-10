import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /registerRuntimeZoneTools/);
  assert.doesNotMatch(entry, /registerExtensionSearchTools/);
});
