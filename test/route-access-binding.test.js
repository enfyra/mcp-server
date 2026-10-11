import test from 'node:test';
import assert from 'node:assert/strict';
import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { clearRuntimeCache } from '../dist/lib/runtime-cache.js';
import { registerRouteAccessTools } from '../dist/lib/route-access-tools.js';
import { runApiEndpointWorkflow } from '../dist/lib/platform-endpoint-workflow.js';
import { acknowledgeRequiredKnowledge } from '../dist/lib/required-knowledge.js';

const apiUrl = 'https://route-access-binding.test/api';
const sourceCode = 'return { ok: true };';

function fixture({ permissions = [], dropBindings = false, configs, disabledRoute = false } = {}) {
  const originalFetch = globalThis.fetch;
  const methods = [{ id: 1, name: 'GET' }, { id: 4, name: 'POST' }];
  const methodConfigs = configs ?? [
    { id: 871, route: { id: 404 }, method: methods[0], available: true, isPublic: false, skipRoleGuard: false },
    { id: 872, route: { id: 404 }, method: methods[1], available: true, isPublic: false, skipRoleGuard: false },
  ];
  const rows = structuredClone(permissions);
  const writes = [];
  const hydrateConfig = (config) => ({
    ...config,
    routePermissions: rows.filter((row) => row.isEnabled !== false && row.routeMethodConfigs?.some((ref) => String(ref.id) === String(config.id))),
  });
  const hydratePermission = (row) => ({
    ...row,
    routeMethodConfigs: (row.routeMethodConfigs ?? []).map((ref) => methodConfigs.find((config) => config.id === ref.id) ?? ref),
  });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace('/api', '');
    const method = options.method ?? 'GET';
    let data;
    if (method === 'GET') {
      if (path === '/enfyra_method') data = methods;
      else if (path === '/enfyra_role') data = [{ id: 3, name: 'Member' }];
      else if (path === '/enfyra_route') data = [{
        id: 404, path: '/usage/model-discounts/policy', isEnabled: !disabledRoute,
        availableMethods: methods, publicMethods: [], methodConfigs: methodConfigs.map(hydrateConfig),
      }];
      else if (path.startsWith('/enfyra_route_permission')) {
        data = path.endsWith('/344') ? rows.filter((row) => row.id === 344).map(hydratePermission) : rows.map(hydratePermission);
      } else if (path === '/enfyra_route_method_config') {
        const filter = JSON.parse(url.searchParams.get('filter') || '{}');
        data = methodConfigs.filter((config) => !filter.method || config.method.id === filter.method.id._eq).map(hydrateConfig);
      } else if (path === '/enfyra_route_handler') data = [{ id: 937, sourceCode, scriptLanguage: 'javascript' }];
      else throw new Error(`Unexpected GET ${path}`);
    } else if (path === '/admin/reload/routes') data = { ok: true };
    else if (path === '/admin/script/validate') data = { valid: true };
    else if (path.startsWith('/enfyra_route_permission')) {
      const body = JSON.parse(options.body);
      writes.push({ path, method, body });
      if (dropBindings) delete body.routeMethodConfigs;
      const row = method === 'POST' ? { id: 344, ...body } : Object.assign(rows.find((item) => item.id === 344), body);
      if (method === 'POST') rows.push(row);
      data = [hydratePermission(row)];
    } else throw new Error(`Unexpected ${method} ${path}`);
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
  };
  initAuth(apiUrl, 'fixture-pat');
  resetTokens();
  clearRuntimeCache();
  acknowledgeRequiredKnowledge('full');
  const tools = new Map();
  registerRouteAccessTools({ tool: (name, _description, _schema, handler) => tools.set(name, handler) }, apiUrl);
  return {
    rows, writes, methodConfigs,
    async ensure(overrides = {}) {
      const result = await tools.get('ensure_route_access')({
        path: '/usage/model-discounts/policy', methods: ['POST'], roleName: 'Member', mode: 'merge', isEnabled: true, ...overrides,
      });
      return JSON.parse(result.content[0].text);
    },
    async audit() {
      const result = await tools.get('audit_route_access')({ path: '/usage/model-discounts/policy', roleName: 'Member', methods: ['POST'], limit: 25 });
      return JSON.parse(result.content[0].text);
    },
    workflow(overrides = {}) {
      return runApiEndpointWorkflow(apiUrl, {
        path: '/usage/model-discounts/policy', method: 'POST', sourceCode,
        roleName: 'Member', anonymousAccess: 'private', applyAll: true, ...overrides,
      });
    },
    close() { globalThis.fetch = originalFetch; clearRuntimeCache(); resetTokens(); },
  };
}

function permission(overrides = {}) {
  return { id: 344, route: { id: 404 }, role: { id: 3, name: 'Member' }, allowedUsers: [], isEnabled: true, methods: [{ id: 4, name: 'POST' }], routeMethodConfigs: [], ...overrides };
}

for (const [name, permissions] of [['create', []], ['repair legacy permission', [permission()]]]) {
  test(`ensure_route_access ${name} binds the exact POST config`, async () => {
    const f = fixture({ permissions });
    try {
      await f.ensure();
      assert.deepEqual(f.writes[0].body.routeMethodConfigs, [{ id: 872 }]);
      assert.equal(f.rows[0].role.id, 3);
      assert.deepEqual(f.rows[0].allowedUsers ?? [], []);
      assert.equal(f.methodConfigs[1].isPublic, false);
      assert.equal(f.methodConfigs[1].skipRoleGuard, false);
    } finally { f.close(); }
  });
}

test('merge preserves an existing canonical GET grant even when legacy methods omit it', async () => {
  const f = fixture({ permissions: [permission({ methods: [], routeMethodConfigs: [{ id: 871 }] })] });
  try {
    await f.ensure();
    assert.deepEqual(f.rows[0].routeMethodConfigs, [{ id: 871 }, { id: 872 }]);
  } finally { f.close(); }
});

test('replace removes only the matched scope GET binding', async () => {
  const other = permission({ id: 345, role: { id: 9 }, routeMethodConfigs: [{ id: 871 }] });
  const f = fixture({ permissions: [permission({ routeMethodConfigs: [{ id: 871 }, { id: 872 }] }), other] });
  try {
    await f.ensure({ mode: 'replace' });
    assert.deepEqual(f.rows[0].routeMethodConfigs, [{ id: 872 }]);
    assert.deepEqual(f.rows[1], other);
  } finally { f.close(); }
});

test('direct-user scope is bound without granting Member role access', async () => {
  const f = fixture();
  try {
    await f.ensure({ roleName: undefined, allowedUserIds: ['user-a'] });
    assert.equal(f.rows[0].role, undefined);
    assert.deepEqual(f.rows[0].allowedUsers, [{ id: 'user-a' }]);
    assert.deepEqual(f.rows[0].routeMethodConfigs, [{ id: 872 }]);
  } finally { f.close(); }
});

test('disabled POST config is rejected despite stale legacy availableMethods', async () => {
  const f = fixture({ configs: [{ id: 872, route: { id: 404 }, method: { id: 4, name: 'POST' }, available: false }] });
  try {
    await assert.rejects(f.ensure(), /available|configuration/i);
    assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('ensure rejects a success receipt when the backend drops method bindings', async () => {
  const f = fixture({ dropBindings: true });
  try { await assert.rejects(f.ensure(), /binding|verification/i); }
  finally { f.close(); }
});

test('audit does not report legacy route+methods as an effective grant', async () => {
  const f = fixture({ permissions: [permission()] });
  try {
    const result = await f.audit();
    assert.deepEqual(result.routes[0].expected.missingMethods, ['POST']);
  } finally { f.close(); }
});

for (const [name, permissions] of [['create', []], ['repair', [permission()]], ['reenable', [permission({ isEnabled: false, routeMethodConfigs: [{ id: 872 }] })]]]) {
  test(`endpoint workflow ${name} verifies method-config permission before completion`, async () => {
    const f = fixture({ permissions });
    try {
      const result = await f.workflow();
      assert.equal(result.complete, true);
      assert.deepEqual(f.rows[0].routeMethodConfigs, [{ id: 872 }]);
      assert.equal(f.rows[0].isEnabled, true);
      assert.ok(f.writes.length > 0);
    } finally { f.close(); }
  });
}

test('endpoint workflow cannot complete when method binding is not saved', async () => {
  const f = fixture({ dropBindings: true });
  try { await assert.rejects(f.workflow(), /binding|verification/i); }
  finally { f.close(); }
});
