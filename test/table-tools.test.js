import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { fetchAPI } from '../dist/lib/fetch.js';
import {
  buildColumnDefinition,
  assertIndexesDoNotReferenceUniqueFields,
  fetchTableWithDetails,
  normalizeRelationForTablePatch,
  registerTableTools,
  resolveTableIdentifierFromMetadata,
  resolveRelationTargetsFromMetadata,
  resolveTableFromMetadata,
  resolveTableFromMetadataByName,
  sanitizeExistingRelationForTablePatch,
} from '../dist/lib/table-tools.js';
import { prepareRecordMutation } from '../dist/lib/mutation-guards.js';
import { validateMainTableRoutePath } from '../dist/lib/route-guards.js';
import { GLOBAL_RULES_ACK_KEY } from '../dist/lib/required-knowledge.js';
import { WORKFLOW_SURFACES, discoverWorkflowRoutes, listWorkflowSurfaces } from '../dist/lib/tool-routing.js';
import {
  findRoutePermission,
  mergeMethodNames,
  resolveRoleByNameOrId,
  routePermissionMatchesScope,
  summarizeRouteAccess,
  validateMethodsForRoute,
} from '../dist/lib/route-permission-tools.js';

test('platform operation module imports cleanly', async () => {
  const module = await import('../dist/lib/platform-operation-tools.js');
  assert.equal(typeof module.registerPlatformOperationTools, 'function');
});

test('extension local validation rejects manual component resolution mistakes', async () => {
  const { validateExtensionCodeLocally } = await import('../dist/lib/platform-operation-tools.js');

  assert.deepEqual(
    validateExtensionCodeLocally('<template><UButton>Save</UButton></template>'),
    { componentCasing: 'passed' },
  );
  assert.throws(
    () => validateExtensionCodeLocally([
      '<template><div /></template>',
      '<script setup>',
      "const UButton = resolveComponent('UButton')",
      '</script>',
    ].join('\n')),
    /do not call resolveComponent/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<template><ubutton>Save</ubutton></template>'),
    /use <UButton> instead of <ubutton>/,
  );
});

test('workflow routing gives progressive tool plans and negative boundaries', () => {
  assert.ok(WORKFLOW_SURFACES.includes('extension'));
  assert.ok(WORKFLOW_SURFACES.includes('api-endpoint'));
  assert.ok(listWorkflowSurfaces().length >= 10);

  const extension = discoverWorkflowRoutes({
    intent: 'support ticket menu chip should notify without fetching the ticket list',
    surface: 'extension',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(extension.key, 'extension');
  assert.ok(extension.firstTools.includes('get_extension_theme_contract'));
  assert.ok(extension.requiredAck.includes('extensionAckKey when saving extension code'));
  assert.ok(extension.writeTools.includes('extension_workflow'));
  assert.ok(extension.writeTools.includes('update_extension_code'));
  assert.ok(extension.writeTools.includes('reorder_menus'));
  assert.ok(extension.writeTools.includes('ensure_global_extension'));
  assert.ok(extension.verifyTools.includes('validate_extension_code'));
  assert.match(JSON.stringify(extension.avoidTools), /destination domain lists/);
  assert.match(JSON.stringify(extension.avoidTools), /destination-page fetch on click/);

  const endpoint = discoverWorkflowRoutes({
    intent: 'create authenticated REST endpoint with a handler and route permission',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(endpoint.key, 'api-endpoint');
  assert.ok(endpoint.writeTools.includes('api_endpoint_workflow'));
  assert.match(JSON.stringify(endpoint.avoidTools), /create_route/);

  const flow = discoverWorkflowRoutes({
    intent: 'add a provisioning flow step that queries then updates a record',
    surface: 'flow',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(flow.key, 'flow');
  assert.ok(flow.firstTools.includes('choose_flow_step_tool'));
  assert.match(JSON.stringify(flow.avoidTools), /ensure_script_flow_step/);

  const cache = discoverWorkflowRoutes({
    intent: 'metadata looks stale after a table change',
    surface: 'cache',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(cache.key, 'cache');
  assert.match(JSON.stringify(cache.avoidTools), /Manual reloads should be evidence-driven/);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

test('fetchTableWithDetails reads full columns from metadata instead of enfyra_table nested fields', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const metadataColumns = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    name: `field_${index + 1}`,
    type: 'varchar',
  }));

  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).includes('/enfyra_table?')) {
      return jsonResponse({
        data: [{
          id: 79,
          name: 'cloud_projects',
          columns: metadataColumns.slice(0, 10),
          relations: [],
        }],
      });
    }
    if (String(url).endsWith('/metadata')) {
      return jsonResponse({
        data: {
          tables: [{
            id: 79,
            name: 'cloud_projects',
            columns: metadataColumns,
            relations: [{ id: 5, propertyName: 'owner' }],
          }],
        },
      });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    const table = await fetchTableWithDetails('https://example.test/api', 79);

    assert.equal(table.columns.length, 12);
    assert.equal(table.relations.length, 1);
    assert.equal(table.columns[11].name, 'field_12');
    assert.equal(calls.some((url) => url.includes('columns.*')), false);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('resolveTableFromMetadata supports array and keyed metadata shapes', () => {
  assert.equal(resolveTableFromMetadata({ data: { tables: [{ id: 1, name: 'a' }] } }, '1')?.name, 'a');
  assert.equal(resolveTableFromMetadata({ tables: { b: { id: 2, name: 'b' } } }, 2)?.name, 'b');
});

test('fetchTableWithDetails falls back to metadata table name when metadata id is malformed', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).includes('/enfyra_table?')) {
      return jsonResponse({
        data: [{
          id: 1,
          name: 'enfyra_column',
          columns: [],
          relations: [],
        }],
      });
    }
    if (String(url).endsWith('/metadata')) {
      return jsonResponse({
        data: {
          tables: [{
            id: true,
            name: 'enfyra_column',
            columns: [{ id: 3, name: 'type', type: 'enum' }],
            relations: [],
          }],
        },
      });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    const table = await fetchTableWithDetails('https://example.test/api', 1);

    assert.equal(table.name, 'enfyra_column');
    assert.equal(table.columns[0].name, 'type');
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('resolveTableFromMetadataByName supports table name and alias', () => {
  const metadata = { data: { tables: [{ id: true, name: 'enfyra_column' }, { id: 2, alias: 'Posts' }] } };
  assert.equal(resolveTableFromMetadataByName(metadata, 'enfyra_column')?.id, true);
  assert.equal(resolveTableFromMetadataByName(metadata, 'Posts')?.id, 2);
});

test('resolveTableIdentifierFromMetadata supports ids, names, and aliases', () => {
  const metadata = { data: { tables: [{ id: 4, name: 'enfyra_user' }, { id: 9, name: 'post', alias: 'Posts' }] } };

  assert.equal(resolveTableIdentifierFromMetadata(metadata, 4), 4);
  assert.equal(resolveTableIdentifierFromMetadata(metadata, 'post'), 9);
  assert.equal(resolveTableIdentifierFromMetadata(metadata, 'Posts'), 9);
  assert.throws(
    () => resolveTableIdentifierFromMetadata(metadata, 'missing_table', 'targetTableId'),
    /targetTableId "missing_table" was not found/
  );
});

test('schema constraint validation rejects indexes that include unique fields', () => {
  assert.throws(
    () =>
      assertIndexesDoNotReferenceUniqueFields(
        [['is_active', 'version']],
        [['version'], ['docker_image']],
      ),
    /indexes must not include fields that are already unique/,
  );

  assert.doesNotThrow(() =>
    assertIndexesDoNotReferenceUniqueFields(
      [['is_active', 'sort_order']],
      [['version'], ['docker_image']],
    ),
  );
});

test('resolveRelationTargetsFromMetadata converts table names to ids before schema mutation', () => {
  const metadata = { data: { tables: [{ id: 4, name: 'enfyra_user' }, { id: 9, name: 'post' }] } };
  assert.deepEqual(
    resolveRelationTargetsFromMetadata(metadata, [
      { propertyName: 'owner', type: 'many-to-one', targetTable: 'enfyra_user' },
      { propertyName: 'post', type: 'many-to-one', targetTable: { id: 9 } },
      { propertyName: 'external', type: 'many-to-one', targetTable: '64f011111111111111111111' },
    ]),
    [
      { propertyName: 'owner', type: 'many-to-one', targetTable: 4 },
      { propertyName: 'post', type: 'many-to-one', targetTable: { id: 9 } },
      { propertyName: 'external', type: 'many-to-one', targetTable: '64f011111111111111111111' },
    ]
  );
});

test('encrypted column definitions preserve explicit updatable contract', () => {
  assert.deepEqual(
    buildColumnDefinition({
      name: 'api_key',
      type: 'varchar',
      isEncrypted: true,
      isUpdatable: true,
      isPublished: false,
    }),
    {
      name: 'api_key',
      type: 'varchar',
      isNullable: true,
      isPrimary: false,
      isGenerated: false,
      isSystem: false,
      isPublished: false,
      isUpdatable: true,
      isEncrypted: true,
    }
  );

  assert.deepEqual(
    buildColumnDefinition({
      name: 'secret_key',
      type: 'varchar',
      isEncrypted: true,
      isUpdatable: false,
    }),
    {
      name: 'secret_key',
      type: 'varchar',
      isNullable: true,
      isPrimary: false,
      isGenerated: false,
      isSystem: false,
      isPublished: true,
      isEncrypted: true,
      isUpdatable: false,
    }
  );
});

test('new column definitions include system-table validation defaults', () => {
  assert.deepEqual(
    buildColumnDefinition({
      name: 'tenant_cpu_shares',
      type: 'int',
    }),
    {
      name: 'tenant_cpu_shares',
      type: 'int',
      isNullable: true,
      isPrimary: false,
      isGenerated: false,
      isSystem: false,
      isPublished: true,
      isUpdatable: true,
      isEncrypted: false,
    }
  );
});

test('fetchAPI exchanges ENFYRA_API_TOKEN before authenticated requests', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || [] });
    if (String(url).endsWith('/auth/token/exchange')) {
      assert.equal(JSON.parse(init.body).apiToken, 'efy_pat_test');
      return jsonResponse({ accessToken: 'jwt-access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).endsWith('/me')) {
      const authHeader = Array.isArray(init.headers)
        ? init.headers.find(([key]) => key === 'Authorization')?.[1]
        : init.headers?.Authorization;
      assert.equal(authHeader, 'Bearer jwt-access-token');
      assert.notEqual(authHeader, 'Bearer efy_pat_test');
      return jsonResponse({ data: [{ id: 1 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const result = await fetchAPI('https://example.test/api', '/me');

    assert.deepEqual(result, { data: [{ id: 1 }] });
    assert.equal(calls[0].url, 'https://example.test/api/auth/token/exchange');
    assert.equal(calls[1].url, 'https://example.test/api/me');
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('fetchAPI retries once after stale exchanged token is rejected', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let exchangeCount = 0;

  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || [] });
    if (String(url).endsWith('/auth/token/exchange')) {
      exchangeCount += 1;
      return jsonResponse({ accessToken: `jwt-${exchangeCount}`, expTime: Date.now() + 60_000 });
    }
    if (String(url).endsWith('/me')) {
      const authHeader = Array.isArray(init.headers)
        ? init.headers.find(([key]) => key === 'Authorization')?.[1]
        : init.headers?.Authorization;
      if (authHeader === 'Bearer jwt-1') {
        return jsonResponse({ message: 'expired' }, 401);
      }
      assert.equal(authHeader, 'Bearer jwt-2');
      return jsonResponse({ data: [{ id: 1 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const result = await fetchAPI('https://example.test/api', '/me');

    assert.deepEqual(result, { data: [{ id: 1 }] });
    assert.equal(exchangeCount, 2);
    assert.equal(calls.filter((call) => call.url.endsWith('/me')).length, 2);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('fetchAPI refreshes short-lived exchanged tokens before expiry', async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const calls = [];
  let now = Date.parse('2026-06-22T12:00:00.000Z');
  let exchangeCount = 0;

  Date.now = () => now;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || [] });
    if (String(url).endsWith('/auth/token/exchange')) {
      exchangeCount += 1;
      return jsonResponse({ accessToken: `jwt-${exchangeCount}`, expTime: now + 60_000 });
    }
    if (String(url).endsWith('/me')) {
      const authHeader = Array.isArray(init.headers)
        ? init.headers.find(([key]) => key === 'Authorization')?.[1]
        : init.headers?.Authorization;
      return jsonResponse({ authHeader });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');

    assert.deepEqual(await fetchAPI('https://example.test/api', '/me'), { authHeader: 'Bearer jwt-1' });
    now = Date.parse('2026-06-22T12:00:39.000Z');
    assert.deepEqual(await fetchAPI('https://example.test/api', '/me'), { authHeader: 'Bearer jwt-1' });
    now = Date.parse('2026-06-22T12:00:41.000Z');
    assert.deepEqual(await fetchAPI('https://example.test/api', '/me'), { authHeader: 'Bearer jwt-2' });

    assert.equal(exchangeCount, 2);
    assert.equal(calls.filter((call) => call.url.endsWith('/auth/token/exchange')).length, 2);
  } finally {
    resetTokens();
    Date.now = originalNow;
    global.fetch = originalFetch;
  }
});

test('get_all_tables applies search and explicit all contract', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();

  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).endsWith('/metadata')) {
      return jsonResponse({
        data: {
          tables: [
            { id: 1, name: 'enfyra_user', alias: 'Users', description: 'System users', columns: [], relations: [] },
            { id: 2, name: 'mcp_project', description: 'Test project', columns: [{ id: 1 }], relations: [] },
            { id: 3, name: 'mcp_issue', description: 'Test issue', columns: [], relations: [{ id: 9 }] },
          ],
        },
      });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    await assert.rejects(
      () => server.get('get_all_tables').handler({}),
      /requires either limit or all=true/
    );

    const result = await server.get('get_all_tables').handler({ search: 'mcp_', all: true });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.matchedTableCount, 2);
    assert.equal(payload.returnedTableCount, 2);
    assert.match(result.content[0].text, /mcp_project/);
    assert.doesNotMatch(result.content[0].text, /enfyra_user/);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_relation resolves table names before schema patch', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  let patchedBody = null;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (urlText.endsWith('/metadata')) {
      return jsonResponse({
        data: {
          tables: [
            {
              id: 9,
              name: 'mcp_issue',
              columns: [{ id: 1, name: 'title', type: 'varchar' }],
              relations: patchedBody?.relations || [],
            },
            {
              id: 4,
              name: 'enfyra_user',
              alias: 'Users',
              columns: [{ id: 2, name: 'email', type: 'varchar' }],
              relations: [],
            },
          ],
        },
      });
    }
    if (urlText.includes('/enfyra_table?')) {
      return jsonResponse({
        data: [{
          id: 9,
          name: 'mcp_issue',
          columns: [{ id: 1, name: 'title', type: 'varchar' }],
          relations: patchedBody?.relations || [],
        }],
      });
    }
    if (urlText.endsWith('/enfyra_table/9') && init.method === 'PATCH') {
      patchedBody = JSON.parse(init.body);
      patchedBody.relations = patchedBody.relations.map((relation, index) => ({ id: index + 20, ...relation }));
      return jsonResponse({ data: [{ id: 9, name: 'mcp_issue', relations: patchedBody.relations }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    await server.get('create_relation').handler({
      sourceTableId: 'mcp_issue',
      targetTableId: 'enfyra_user',
      type: 'many-to-one',
      propertyName: 'owner',
      onDelete: 'SET NULL',
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    assert.equal(patchedBody.relations[0].targetTable, 4);
    assert.equal(patchedBody.relations[0].propertyName, 'owner');
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('route permission helpers resolve role names and validate available methods', () => {
  const roles = [{ id: 2, name: 'user' }, { id: 1, name: 'Admin' }];
  const route = {
    id: 10,
    path: '/cloud_projects',
    availableMethods: [{ id: 1 }, { id: 2 }],
  };
  const methodMap = { GET: 1, POST: 2, PATCH: 3 };
  const methodIdNameMap = { 1: 'GET', 2: 'POST', 3: 'PATCH' };

  assert.deepEqual(resolveRoleByNameOrId(roles, { roleName: 'USER' }), roles[0]);
  assert.deepEqual(validateMethodsForRoute(route, ['get', 'POST'], methodMap, methodIdNameMap), ['GET', 'POST']);
  assert.throws(
    () => validateMethodsForRoute(route, ['PATCH'], methodMap, methodIdNameMap),
    /does not list methods as available/
  );
});

test('route permission helpers match scopes and merge methods predictably', () => {
  const permission = {
    id: 18,
    route: { id: 10, path: '/cloud_projects' },
    role: { id: 2, name: 'user' },
    allowedUsers: [],
    methods: [{ id: 1 }, { id: 2 }],
    isEnabled: true,
  };
  const methodIdNameMap = { 1: 'GET', 2: 'POST', 3: 'PATCH' };

  assert.equal(routePermissionMatchesScope(permission, { roleId: 2, allowedUserIds: [] }), true);
  assert.equal(routePermissionMatchesScope(permission, { roleId: 2, allowedUserIds: [5] }), false);
  assert.equal(findRoutePermission([permission], 10, { roleId: 2, allowedUserIds: [] })?.id, 18);
  assert.deepEqual(mergeMethodNames(['GET'], ['get', 'POST'], 'merge'), ['GET', 'POST']);
  assert.deepEqual(mergeMethodNames(['GET'], ['POST'], 'replace'), ['POST']);

  const access = summarizeRouteAccess(
    { id: 10, path: '/cloud_projects', availableMethods: [{ id: 1 }, { id: 2 }] },
    [permission],
    methodIdNameMap,
    { roleId: 2, methods: ['GET', 'PATCH'] }
  );
  assert.deepEqual(access.expected.missingMethods, ['PATCH']);

  const narrowedPermission = {
    ...permission,
    id: 19,
    allowedUsers: [{ id: 5 }],
  };
  const roleWideAccess = summarizeRouteAccess(
    { id: 10, path: '/cloud_projects', availableMethods: [{ id: 1 }] },
    [narrowedPermission],
    methodIdNameMap,
    { roleId: 2, allowedUserIds: [], methods: ['GET'] }
  );
  assert.deepEqual(roleWideAccess.expected.missingMethods, ['GET']);
});

test('prepareRecordMutation rejects fields that are not in table metadata', async () => {
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'cloud_projects',
        columns: [{ name: 'name' }],
        relations: [{ propertyName: 'owner' }],
      }],
      tableName: 'cloud_projects',
      data: JSON.stringify({ name: 'Project', expiredAt: '2026-01-01' }),
    }),
    /expiredAt/
  );
});

test('prepareRecordMutation validates sourceCode and rejects compiledCode/code alias', async () => {
  const calls = [];
  const fetchMock = async (apiUrl, path, options) => {
    calls.push({ apiUrl, path, body: JSON.parse(options.body) });
    return { success: true, valid: true };
  };

  const prepared = await prepareRecordMutation({
    fetchAPI: fetchMock,
    apiUrl: 'https://example.test/api',
    tables: [{
      name: 'enfyra_route_handler',
      columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }],
      relations: [{ propertyName: 'route' }, { propertyName: 'method' }],
    }],
    tableName: 'enfyra_route_handler',
    data: JSON.stringify({ sourceCode: 'return true;', scriptLanguage: 'javascript' }),
  });

  assert.equal(prepared.scriptValidation.validated, true);
  assert.equal(calls[0].path, '/admin/script/validate');
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: fetchMock,
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'enfyra_route_handler',
        columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }, { name: 'compiledCode' }],
        relations: [],
      }],
      tableName: 'enfyra_route_handler',
      data: JSON.stringify({ sourceCode: 'return true;', compiledCode: 'stale' }),
    }),
    /compiledCode/
  );
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: fetchMock,
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'enfyra_pre_hook',
        columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }, { name: 'code' }],
        relations: [],
      }],
      tableName: 'enfyra_pre_hook',
      data: JSON.stringify({ code: 'return true;' }),
    }),
    /sourceCode/
  );
});

test('prepareRecordMutation fails closed when script validation endpoint is unavailable', async () => {
  const fetchMock = async () => {
    throw new Error('API error (404): {"message":"not found"}');
  };

  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: fetchMock,
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'enfyra_route_handler',
        columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }],
        relations: [],
      }],
      tableName: 'enfyra_route_handler',
      data: JSON.stringify({ sourceCode: 'return true;', scriptLanguage: 'javascript' }),
    }),
    /Script validation failed before save/
  );
});

test('mcp server exposes update_script_source for raw source updates', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /server\.tool\(\s*['"]update_script_source['"]/);
  assert.match(entry, /JSON\.stringify\(\{ sourceCode, scriptLanguage \}\)/);
  assert.match(entry, /updated_script_source/);
});

test('mcp server exposes script source inspection and patch tools', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /server\.tool\(\s*['"]get_script_source['"]/);
  assert.match(entry, /server\.tool\(\s*['"]patch_script_source['"]/);
  assert.match(entry, /expectedSourceSha256/);
  assert.match(entry, /patch_script_source_preview/);
});

test('mcp server exposes metadata usage tracing for production script edits', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /server\.tool\(\s*['"]trace_metadata_usage['"]/);
  assert.match(entry, /scriptReadErrors/);
  assert.match(entry, /get_script_source/);
  assert.match(entry, /route\.path/);
  assert.match(entry, /flow\.name/);
  assert.match(entry, /gateway\.path/);
});

test('code-writing tools require required-knowledge acknowledgement without blocking discovery or validation', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const platformTools = readFileSync(new URL('../src/lib/platform-operation-tools.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');

  assert.match(entry, /server\.tool\(\s*['"]get_enfyra_required_knowledge['"]/);
  assert.match(entry, /server\.tool\(\s*['"]discover_enfyra_workflows['"]/);
  assert.match(entry, /discoverWorkflowRoutes/);
  assert.match(entry, /detail: z\.enum\(\['summary', 'plan', 'full'\]/);
  assert.match(entry, /avoidTools negative-routing boundaries/);
  assert.match(requiredKnowledge, /GLOBAL_RULES_ACK_KEY/);
  assert.match(requiredKnowledge, /globalRulesAckKey/);
  assert.match(requiredKnowledge, /Call get_enfyra_required_knowledge/);
  assert.match(requiredKnowledge, /DYNAMIC_CODE_KNOWLEDGE_ACK_KEY/);
  assert.match(requiredKnowledge, /EXTENSION_KNOWLEDGE_ACK_KEY/);
  assert.match(requiredKnowledge, /secure-vs-trusted-repositories/);
  assert.match(requiredKnowledge, /theme-contract-first/);
  assert.match(instructions, /get_enfyra_required_knowledge/);
  assert.match(instructions, /discover_enfyra_workflows/);
  assert.match(instructions, /globalRulesAckKey/);

  assert.match(entry, /create_record[\s\S]*globalRulesAckKey/);
  assert.match(entry, /create_record[\s\S]*knowledgeAckKey/);
  assert.match(entry, /update_record[\s\S]*extensionKnowledgeAckKey/);
  assert.match(entry, /delete_record[\s\S]*globalRulesAckKey/);
  assert.match(entry, /SCRIPT_BACKED_TABLE_SET\.has\(tableName\)/);
  assert.match(entry, /patch_script_source[\s\S]*apply[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /update_script_source[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /create_handler[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /create_pre_hook[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /create_post_hook[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);

  assert.match(platformTools, /set_table_graphql[\s\S]*globalRulesAckKey/);
  assert.match(platformTools, /api_endpoint_workflow[\s\S]*knowledgeAckKey/);
  assert.match(platformTools, /api_endpoint_workflow[\s\S]*globalRulesAckKey/);
  assert.match(platformTools, /apply \|\| opts\.applyAll[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /applyAll[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(platformTools, /create_api_endpoint[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(platformTools, /ensure_websocket_gateway[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAckIf/);
  assert.match(platformTools, /ensure_websocket_event[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(platformTools, /ensure_script_flow_step[\s\S]*knowledgeAckKey/);
  assert.match(platformTools, /ensure_condition_flow_step[\s\S]*knowledgeAckKey/);
  assert.match(platformTools, /ensure_page_extension[\s\S]*globalRulesAckKey[\s\S]*extensionKnowledgeAckKey/);
  assert.match(platformTools, /ensure_global_extension[\s\S]*globalRulesAckKey[\s\S]*extensionKnowledgeAckKey/);
  assert.match(platformTools, /ensure_widget_extension[\s\S]*globalRulesAckKey[\s\S]*extensionKnowledgeAckKey/);

  assert.match(platformTools, /validate_dynamic_script[\s\S]*sourceCode: z\.string/);
  assert.doesNotMatch(platformTools, /validate_dynamic_script[\s\S]{0,500}knowledgeAckKey/);
  assert.match(platformTools, /validate_extension_code[\s\S]*code: z\.string/);
  assert.doesNotMatch(platformTools, /validate_extension_code[\s\S]{0,500}extensionKnowledgeAckKey/);
});

test('mcp server exposes route platform operation tools', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const tableTools = readFileSync(new URL('../src/lib/table-tools.ts', import.meta.url), 'utf8');
  const platformTools = readFileSync(new URL('../src/lib/platform-operation-tools.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');
  const routing = readFileSync(new URL('../src/lib/tool-routing.ts', import.meta.url), 'utf8');
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');

  assert.match(entry, /registerPlatformOperationTools\(server, ENFYRA_API_URL\)/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]add_column['"]/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]remove_column['"]/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]add_relation['"]/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]remove_relation['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]add_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]replace_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]remove_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]enable_route['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]disable_route['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]delete_route['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]set_route_public_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]public_route_methods['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]set_public_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]private_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]api_endpoint_workflow['"]/);
  assert.match(platformTools, /nextSteps/);
  assert.match(platformTools, /applyAll/);
  assert.match(platformTools, /delete_route\(\{ routeId:/);
  assert.doesNotMatch(platformTools, /delete_record\(\{ tableName: "enfyra_route_handler"/);
  assert.match(platformTools, /server\.tool\(\s*['"]create_api_endpoint['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]validate_dynamic_script['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]validate_extension_code['"]/);
  assert.match(entry, /server\.tool\(\s*['"]get_permission_profile['"]/);
  assert.match(entry, /MCP_PERMISSION_REQUIREMENTS/);
  assert.match(entry, /\/admin\/script\/validate/);
  assert.match(entry, /\/admin\/test\/run/);
  assert.match(entry, /\/admin\/flow\/trigger\/:id/);
  assert.match(entry, /\/admin\/menu\/reorder/);
  assert.match(entry, /tools: \['reorder_menus'\]/);
  assert.match(platformTools, /server\.tool\(\s*['"]set_table_graphql['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_column_rule['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_field_permission['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_guard['"]/);
  assert.match(platformTools, /ensure_column_rule[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /ensure_field_permission[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /ensure_guard[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_column_rule['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_field_permission['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_route_permission['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_guard['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_websocket_gateway['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_websocket_event['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_flow['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_manual_flow['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_scheduled_flow['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]choose_flow_step_tool['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_script_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_condition_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_query_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_create_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_update_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_delete_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_http_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_sleep_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_trigger_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_log_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_menu['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]reorder_menus['"]/);
  assert.match(platformTools, /\/admin\/menu\/reorder/);
  assert.match(platformTools, /Duplicate menu id in reorder payload/);
  assert.match(platformTools, /emits enfyra_menu cache invalidation/);
  assert.match(platformTools, /server\.tool\(\s*['"]extension_workflow['"]/);
  assert.match(platformTools, /runExtensionWorkflow/);
  assert.match(platformTools, /extension_workflow_planned/);
  assert.match(platformTools, /extension_workflow_advanced/);
  assert.match(platformTools, /assertExtensionKnowledgeAck/);
  assert.match(platformTools, /get_extension_theme_contract before generating or reviewing extension UI/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_page_extension['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_global_extension['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_widget_extension['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_menu_extension_page['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_menu['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_extension['"]/);
  assert.match(platformTools, /sourceCode/);
  assert.match(platformTools, /stepOrder/);
  assert.match(platformTools, /triggerType/);
  assert.doesNotMatch(platformTools, /connectionHandlerScript/);
  assert.doesNotMatch(platformTools, /handlerScript/);
  assert.doesNotMatch(platformTools, /\/admin\/reload\/flows/);
  assert.doesNotMatch(platformTools, /\/admin\/reload\/websockets/);
  assert.match(platformTools, /validateScriptSourceIfPresent/);
  assert.match(platformTools, /get_extension_theme_contract/);
  assert.match(platformTools, /eApp theme class tokens/);
  assert.match(platformTools, /Do not inject global CSS/);
  assert.match(platformTools, /theme guards/);
  assert.match(platformTools, /runtime-configurable/);
  assert.match(platformTools, /app color picker/);
  assert.match(platformTools, /must affect extension identity UI/);
  assert.match(platformTools, /neutral surface, runtime-primary identity, or status/);
  assert.match(platformTools, /decisionCases/);
  assert.match(platformTools, /Normal accent, decorative icon/);
  assert.match(platformTools, /True semantic state/);
  assert.match(platformTools, /Use the matching state\/status color/);
  assert.match(platformTools, /Do not force semantic state UI to primary/);
  assert.match(platformTools, /Large ordinary surface/);
  assert.match(platformTools, /patternExamples/);
  assert.match(platformTools, /Ordinary KPI, metric, or summary card/);
  assert.match(platformTools, /Selected\/current entity/);
  assert.match(platformTools, /Progress, active tab indicator/);
  assert.match(platformTools, /List rows, table-like records/);
  assert.match(platformTools, /For Nuxt UI components, choose color="primary" by semantic intent/);
  assert.match(platformTools, /eapp-primary-surface/);
  assert.match(platformTools, /eapp-primary-soft/);
  assert.match(platformTools, /eapp-primary-subtle/);
  assert.match(platformTools, /eapp-surface-card/);
  assert.match(platformTools, /eapp-text-tertiary/);
  assert.match(platformTools, /eapp-status-success-soft/);
  assert.match(platformTools, /eapp-status-warning-soft/);
  assert.match(platformTools, /Do not read --badge-\* variables directly/);
  assert.match(platformTools, /normal app cards with a very subtle active-primary tint/);
  assert.match(platformTools, /must not be applied broadly to every KPI\/list wrapper/);
  assert.match(platformTools, /Nuxt UI secondary is still a valid semantic color/);
  assert.match(platformTools, /eapp-identity-\*/);
  assert.match(platformTools, /bg-primary\/10/);
  assert.match(platformTools, /Do not color large panels, alert-like success blocks, KPI cards, list containers, or reconciliation\/attention blocks green\/yellow\/red/);
  assert.match(platformTools, /PageHeader gradient must be "none"/);
  assert.match(platformTools, /Do not pass ui\.content: "eapp-surface-card" or "surface-card"/);
  assert.match(platformTools, /md:grid-cols-2 xl:grid-cols-3/);
  assert.match(examples, /eapp-surface-card p-4/);
  assert.match(examples, /eapp-primary-surface/);
  assert.match(examples, /eapp-primary-soft/);
  assert.match(examples, /eapp-primary-solid/);
  assert.match(examples, /gradient: 'none'/);
  assert.match(examples, /color: 'neutral'/);
  assert.match(examples, /Call get_extension_theme_contract before writing or reviewing page\/widget\/global extension UI/);
  assert.match(examples, /authority for theme, color, layout, modal, drawer, and shell registry details/);
  assert.doesNotMatch(examples, /gradient: 'cyan'/);
  assert.doesNotMatch(examples, /<p class=\\["']text-sm text-muted/);
  assert.doesNotMatch(examples, /grid gap-4 md:grid-cols-3/);
  assert.doesNotMatch(examples, /bg-\[var\(--eapp-surface-muted\)\]/);
  assert.doesNotMatch(examples, /hover:eapp-surface-muted/);
  assert.match(instructions, /Prefer the most specific business operation tool over raw metadata CRUD/);
  assert.match(instructions, /validate_dynamic_script/);
  assert.match(instructions, /get_permission_profile/);
  assert.match(instructions, /non-root API tokens/);
  assert.match(instructions, /\/admin\/script\/validate/);
  assert.match(instructions, /discover_enfyra_workflows/);
  assert.match(routing, /ensure_websocket_event/);
  assert.match(routing, /extension_workflow/);
  assert.match(routing, /reorder_menus/);
  assert.match(routing, /PATCH enfyra_menu for order or parent changes/);
  assert.match(routing, /api_endpoint_workflow/);
  assert.match(routing, /create_api_endpoint/);
  assert.match(routing, /public_route_methods/);
  assert.match(routing, /add_route_methods/);
  assert.match(routing, /enable_route/);
  assert.match(instructions, /enfyra_route\.isEnabled/);
  assert.match(instructions, /GraphQL table data requires Bearer auth/);
  assert.match(routing, /ensure_page_extension/);
  assert.match(instructions, /get_extension_theme_contract/);
});

test('test_flow_step uses unified admin test runner', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /'test_flow_step'/);
  assert.match(entry, /'\/admin\/test\/run'/);
  assert.match(entry, /kind:\s*'flow_step'/);
  assert.doesNotMatch(entry, /fetchAPI\(ENFYRA_API_URL,\s*'\/admin\/flow\/test-step'/);
});

test('mcp log search matches dashed and dotted app log filenames', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /\^app\[\.-\]/);
  assert.match(entry, /\^error\[\.-\]/);
});

test('server instructions stay compact and route details to tools', () => {
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');
  const routing = readFileSync(new URL('../src/lib/tool-routing.ts', import.meta.url), 'utf8');

  assert.ok(Buffer.byteLength(instructions, 'utf8') < 12000);
  assert.match(instructions, /detail: "plan"/);
  assert.match(instructions, /avoidTools/);
  assert.match(instructions, /Load examples only when needed/);
  assert.match(instructions, /get_enfyra_api_context/);
  assert.match(instructions, /Run broad discovery tools sequentially, not in parallel/);
  assert.match(instructions, /fetch only the relevant live context or example category/);
  assert.match(routing, /progressive disclosure/);
  assert.match(routing, /query_table on destination domain lists/);
  assert.match(routing, /notification summary\/realtime shell signal plus destination-page fetch on click/);
  assert.match(routing, /api_endpoint_workflow/);
  assert.match(routing, /choose_flow_step_tool/);
  assert.doesNotMatch(instructions, /#### Injected Vue API functions/);
  assert.doesNotMatch(instructions, /Tables confirmed to have REST routes/);
});

test('discovery tools report target instance and avoid unbounded broad searches', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');

  assert.match(entry, /function targetInstance\(\)/);
  assert.match(entry, /source: 'ENFYRA_API_URL environment variable used by this MCP server process'/);
  assert.match(entry, /targetInstance: targetInstance\(\)/);
  assert.match(entry, /Use this as the cheap first target sanity check/);
  assert.match(entry, /Do not use this only to confirm the API base/);
  assert.match(entry, /installColumnarToolFormatter\(server\)/);
  assert.match(entry, /routeSamples: sample\(routes, 25\)/);
  assert.match(entry, /tableSamples: sample\(tableNames, 40\)/);
  assert.match(entry, /adminRoutes: sample\(adminRoutes/);
  assert.match(entry, /publicRoutes: sample\(publicRoutes/);
  assert.match(entry, /relationFkColumnNames/);
  assert.match(entry, /hiddenRelationColumnCount/);
  assert.match(entry, /discoveryFetch\(`\/metadata\/\$\{encodeURIComponent\(tableName\)\}`\)/);
  assert.doesNotMatch(entry, /\n\s+tableNames,\n\s+routes,\n/);
  assert.match(entry, /DISCOVERY_FETCH_TIMEOUT_MS = 12000/);
  assert.match(entry, /partialErrors: collectPartialErrors/);
  assert.match(entry, /async function collectFeatureSearchState\(\)/);
  assert.match(entry, /const state = await collectFeatureSearchState\(\)/);
  assert.doesNotMatch(entry, /const state = await collectRestDefinitionState\(\);\n\s+const q = rawQuery\.toLowerCase\(\)/);
  assert.match(entry, /Run broad discovery tools sequentially; do not call multiple broad discovery tools in parallel/);
  assert.match(entry, /limit: z\.number\(\)\.int\(\)\.positive\(\)\.max\(25\)\.optional\(\)\.default\(8\)/);
  assert.match(entry, /inspect_feature query must be at least 2 characters/);
  assert.match(entry, /For a specific match, call inspect_table, inspect_route, trace_metadata_usage, or get_script_source/);
});

test('query_table supports deep meta and aggregate query options', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /meta: z\.string\(\)\.optional\(\)/);
  assert.match(entry, /deep: z\.string\(\)\.optional\(\)/);
  assert.match(entry, /aggregate: z\.string\(\)\.optional\(\)/);
  assert.match(entry, /queryParams\.set\('deep', deep\)/);
  assert.match(entry, /queryParams\.set\('aggregate', aggregate\)/);
});

test('list query tools require explicit limit or all intent', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(entry, /query_table requires either limit or all=true/);
  assert.match(entry, /get_all_routes requires either limit or all=true/);
  assert.match(entry, /query_table accepts either all=true or limit, not both/);
  assert.match(entry, /get_all_routes accepts either all=true or limit, not both/);
  assert.match(entry, /all: z\.boolean\(\)\.optional\(\)\.default\(false\)\.describe\('Return all matching rows by sending REST limit=0/);
  assert.match(instructions, /pass `limit` for bounded reads or `all: true` for a complete list/);
  assert.match(examples, /pass all: true instead of choosing an arbitrary page size such as 30 or 50/);
  assert.match(readme, /Every list\/query call must pass either `limit`/);
});

test('websocket script context documents roomSize helper', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');

  assert.match(entry, /roomSize\(room\) counts sockets in that room across registered gateways/);
  assert.match(entry, /@SOCKET reply\/join\/leave\/disconnect\/emit helpers\/roomSize/);
  assert.match(instructions, /`@SOCKET\.roomSize\(room\)` is available/);
  assert.match(instructions, /HTTP\/flow contexts only have global emit helpers plus `roomSize`/);
});

test('script context discovery documents runtime macro and helper surface', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');

  for (const macro of [
    '@BODY',
    '@QUERY',
    '@PARAMS',
    '@USER',
    '@REQ',
    '@RES',
    '@REPOS',
    '@CACHE',
    '@HELPERS',
    '@FETCH',
    '@STORAGE',
    '@UPLOADED_FILE',
    '@SOCKET',
    '@TRIGGER',
    '@DATA',
    '@ERROR',
    '@STATUS',
    '@ENV',
    '@PKGS',
    '@LOGS',
    '@SHARE',
    '@API',
    '@THROW',
    '@THROW400',
    '@THROW503',
  ]) {
    assert.match(entry, new RegExp(`'${macro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  assert.match(entry, /@FETCH maps to \$ctx\.\$helpers\.\$fetch/);
  assert.match(entry, /\$ctx\.\$helpers includes \$bcrypt\.hash\/compare, autoSlug\(text\), \$fetch, \$sleep\(ms\)/);
  assert.match(entry, /@REQ websocket request metadata/);
  assert.match(entry, /@RES when response streaming is available/);
  assert.match(instructions, /@REQ`, `@RES`/);
  assert.match(instructions, /@FETCH/);
  assert.match(instructions, /@UPLOADED_FILE/);
  assert.match(instructions, /Call `discover_script_contexts` for exact per-surface availability/);
});

test('SSR app examples include Nuxt Next and Angular connection patterns', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');

  assert.match(examples, /Nuxt routeRules for REST and Socket\.IO/);
  assert.match(examples, /Next rewrites for REST and Socket\.IO/);
  assert.match(examples, /Next client provider for authenticated realtime/);
  assert.match(examples, /Create the Socket\.IO client once in a top-level client provider/);
  assert.match(examples, /Proxy \/socket\.io through Next rewrites to the Enfyra app bridge \/ws\/socket\.io/);
  assert.match(examples, /Angular dev proxy for REST and Socket\.IO/);
  assert.match(examples, /"pathRewrite": \{/);
  assert.match(examples, /provideHttpClient\(withInterceptors\(\[enfyraCredentialsInterceptor\]\)\)/);
  assert.match(examples, /req\.clone\(\{ withCredentials: true \}\)/);
  assert.match(examples, /Angular HttpClient auth service and route guard/);
  assert.match(examples, /Angular singleton Socket\.IO realtime service/);
  assert.match(examples, /Do not create a new socket per routed component/);
});

test('OAuth setup examples guide provider console callback configuration', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');

  assert.match(examples, /'oauth-setup'/);
  assert.match(examples, /Google OAuth setup workflow/);
  assert.match(examples, /Ask for the app\/admin URL/);
  assert.match(examples, /Authorized redirect URIs/);
  assert.match(examples, /\/api\/auth\/google\/callback/);
  assert.match(examples, /enfyra_oauth_config/);
  assert.match(examples, /Do not ask the user to choose or type the callback URL manually/);
  assert.match(instructions, /category: "oauth-setup"/);
});

test('route creation tools report real route reload status instead of a hardcoded success flag', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /async function reloadRoutesResult\(\)/);
  assert.match(entry, /routeReload/);
  assert.doesNotMatch(entry, /routesReloaded:\s*true/);
});

test('column rule examples use the current value contract', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  assert.match(examples, /value: JSON\.stringify\(\{ v: "email" \}\)/);
  assert.doesNotMatch(examples, /ruleConfig: JSON\.stringify/);
});

test('query examples distinguish relation fields from deep relation query options', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  assert.match(examples, /Use fields with dotted relation paths when you only need scalar fields from related records/);
  assert.match(examples, /Use deep when relation loading needs query options such as filter, sort, limit, page, or nested deep/);
  assert.match(examples, /Do not use deep just to filter by a relation id/);
});

test('query guidance documents fields exclusion mode', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(examples, /fields=-compiledCode/);
  assert.match(examples, /fields=id,-compiledCode returns all readable fields except compiledCode/);
  assert.match(examples, /Dotted exclusions and deep relation fields use the same exclude-mode rule/);
  assert.match(instructions, /Field exclusion mode exists: `fields=-compiledCode`/);
  assert.match(readme, /`fields=-compiledCode` returns all readable fields except `compiledCode`/);
  assert.match(readme, /`fields=-owner\.avatar`/);
});

test('operator guidance avoids speculative warnings and physical FK generated code', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(instructions, /Do not turn expected implementation details into speculative warnings/);
  assert.match(instructions, /`compiledCode` is generated and may differ textually/);
  assert.match(instructions, /not physical FK fields like `userId`, `conversationId`, `senderId`, or `memberId`/);
  assert.match(examples, /conversationId is accepted only as the room\/business identifier; persistence uses relation properties conversation and sender/);
  assert.match(examples, /Do not ask the client for senderId\. The sender relation is derived from @USER\.id/);
  assert.match(readme, /`compiledCode` is generated from `sourceCode` and may differ textually/);
  assert.match(readme, /use relation property names such as `conversation`, `sender`, and `member`/);
});

test('RLS guidance preserves caller projection and pagination', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(instructions, /do not override `@QUERY\.fields`/);
  assert.match(instructions, /Merge only security filters into `@QUERY\.filter`/);
  assert.match(examples, /keep projection and pagination client-owned/);
  assert.match(entry, /preserve client-controlled query shape/);
  assert.match(entry, /pass through client fields\/deep\/sort\/page\/limit\/meta\/aggregate\/debugMode/);
});

test('normalizeRelationForTablePatch rejects physical FK column inputs', () => {
  assert.throws(
    () => normalizeRelationForTablePatch({
      targetTable: 1,
      type: 'many-to-one',
      propertyName: 'owner',
      foreignKeyColumn: 'owner_id',
    }),
    /foreignKeyColumn/
  );
});

test('sanitizeExistingRelationForTablePatch strips physical fields from metadata relations', () => {
  const relation = sanitizeExistingRelationForTablePatch({
    id: 159,
    targetTable: { id: 76, name: 'cloud_servers' },
    type: 'many-to-one',
    propertyName: 'host',
    mappedBy: null,
    isNullable: true,
    onDelete: 'SET NULL',
    foreignKeyColumn: 'hostId',
    referencedColumn: 'id',
    constraintName: 'fk_cloud_projects_hostId',
    junctionTableName: null,
    junctionSourceColumn: null,
    junctionTargetColumn: null,
  });

  assert.deepEqual(relation, {
    id: 159,
    targetTable: 76,
    type: 'many-to-one',
    propertyName: 'host',
    isNullable: true,
    onDelete: 'SET NULL',
  });
});

test('prepareRecordMutation rejects direct enfyra_relation physical FK inputs', async () => {
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'enfyra_relation',
        columns: [
          { name: 'propertyName' },
          { name: 'type' },
          { name: 'foreignKeyColumn' },
        ],
        relations: [{ propertyName: 'targetTable' }],
      }],
      tableName: 'enfyra_relation',
      data: JSON.stringify({
        propertyName: 'owner',
        type: 'many-to-one',
        targetTable: { id: 1 },
        foreignKeyColumn: 'owner_id',
      }),
    }),
    /physical FK/
  );
});

test('validateMainTableRoutePath only allows mainTableId for canonical table routes', () => {
  const tables = [{ id: 12, name: 'orders' }];

  assert.equal(validateMainTableRoutePath(tables, '12', '/orders')?.name, 'orders');
  assert.throws(
    () => validateMainTableRoutePath(tables, '12', '/orders/stats'),
    /Omit mainTableId/
  );
  assert.throws(
    () => validateMainTableRoutePath(tables, '99', '/orders'),
    /Unknown table/
  );
});
