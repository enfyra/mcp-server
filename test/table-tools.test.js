import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { initAuth, resetTokens } from '../src/lib/auth.js';
import { fetchAPI } from '../src/lib/fetch.js';
import {
  buildColumnDefinition,
  fetchTableWithDetails,
  normalizeRelationForTablePatch,
  resolveRelationTargetsFromMetadata,
  resolveTableFromMetadata,
  resolveTableFromMetadataByName,
  sanitizeExistingRelationForTablePatch,
} from '../src/lib/table-tools.js';
import { prepareRecordMutation } from '../src/lib/mutation-guards.js';
import { validateMainTableRoutePath } from '../src/lib/route-guards.js';
import {
  findRoutePermission,
  mergeMethodNames,
  resolveRoleByNameOrId,
  routePermissionMatchesScope,
  summarizeRouteAccess,
  validateMethodsForRoute,
} from '../src/lib/route-permission-tools.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
  const entry = readFileSync(new URL('../src/mcp-server-entry.mjs', import.meta.url), 'utf8');
  assert.match(entry, /server\.tool\(\s*['"]update_script_source['"]/);
  assert.match(entry, /JSON\.stringify\(\{ sourceCode, scriptLanguage \}\)/);
  assert.match(entry, /updated_script_source/);
});

test('mcp server exposes script source inspection and patch tools', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.mjs', import.meta.url), 'utf8');
  assert.match(entry, /server\.tool\(\s*['"]get_script_source['"]/);
  assert.match(entry, /server\.tool\(\s*['"]patch_script_source['"]/);
  assert.match(entry, /expectedSourceSha256/);
  assert.match(entry, /patch_script_source_preview/);
});

test('mcp server exposes metadata usage tracing for production script edits', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.mjs', import.meta.url), 'utf8');
  assert.match(entry, /server\.tool\(\s*['"]trace_metadata_usage['"]/);
  assert.match(entry, /scriptReadErrors/);
  assert.match(entry, /get_script_source/);
  assert.match(entry, /route\.path/);
  assert.match(entry, /flow\.name/);
  assert.match(entry, /gateway\.path/);
});

test('test_flow_step uses unified admin test runner', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.mjs', import.meta.url), 'utf8');
  assert.match(entry, /'test_flow_step'/);
  assert.match(entry, /'\/admin\/test\/run'/);
  assert.match(entry, /kind:\s*'flow_step'/);
  assert.doesNotMatch(entry, /fetchAPI\(ENFYRA_API_URL,\s*'\/admin\/flow\/test-step'/);
});

test('mcp log search matches dashed and dotted app log filenames', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.mjs', import.meta.url), 'utf8');
  assert.match(entry, /\^app\[\.-\]/);
  assert.match(entry, /\^error\[\.-\]/);
});

test('query_table supports deep meta and aggregate query options', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.mjs', import.meta.url), 'utf8');
  assert.match(entry, /meta: z\.string\(\)\.optional\(\)/);
  assert.match(entry, /deep: z\.string\(\)\.optional\(\)/);
  assert.match(entry, /aggregate: z\.string\(\)\.optional\(\)/);
  assert.match(entry, /queryParams\.set\('deep', deep\)/);
  assert.match(entry, /queryParams\.set\('aggregate', aggregate\)/);
});

test('route creation tools report real route reload status instead of a hardcoded success flag', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.mjs', import.meta.url), 'utf8');
  assert.match(entry, /async function reloadRoutesResult\(\)/);
  assert.match(entry, /routeReload/);
  assert.doesNotMatch(entry, /routesReloaded:\s*true/);
});

test('column rule examples use the current value contract', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.js', import.meta.url), 'utf8');
  assert.match(examples, /value: JSON\.stringify\(\{ v: "email" \}\)/);
  assert.doesNotMatch(examples, /ruleConfig: JSON\.stringify/);
});

test('query examples distinguish relation fields from deep relation query options', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.js', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.js', import.meta.url), 'utf8');
  assert.match(examples, /Use fields with dotted relation paths when you only need scalar fields from related records/);
  assert.match(examples, /Use deep when relation loading needs query options such as filter, sort, limit, page, or nested deep/);
  assert.match(examples, /Do not use deep just to filter by a relation id/);
  assert.match(instructions, /Use dotted relation fields such as `owner\.email`/);
  assert.match(instructions, /Use `deep` when relation loading needs query options/);
});

test('query guidance documents fields exclusion mode', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.js', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.js', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(examples, /fields=-compiledCode/);
  assert.match(examples, /fields=id,-compiledCode returns all readable fields except compiledCode/);
  assert.match(examples, /Dotted exclusions and deep relation fields use the same exclude-mode rule/);
  assert.match(instructions, /`fields=-compiledCode` returns all readable fields except `compiledCode`/);
  assert.match(instructions, /`fields=id,-compiledCode` still means all except `compiledCode`/);
  assert.match(instructions, /`deep: \{ owner: \{ fields: "-avatar" \} \}`/);
  assert.match(readme, /`fields=-compiledCode` returns all readable fields except `compiledCode`/);
  assert.match(readme, /`fields=-owner\.avatar`/);
});

test('operator guidance avoids speculative warnings and physical FK generated code', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.js', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.js', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(instructions, /Do not turn normal implementation details into speculative warnings/);
  assert.match(instructions, /`compiledCode` is expected to differ textually from `sourceCode`/);
  assert.match(instructions, /Do not hardcode physical FK fields such as `userId`, `conversationId`, `senderId`, or `memberId`/);
  assert.match(examples, /conversationId is accepted only as the room\/business identifier; persistence uses relation properties conversation and sender/);
  assert.match(examples, /Do not ask the client for senderId\. The sender relation is derived from @USER\.id/);
  assert.match(readme, /`compiledCode` is generated from `sourceCode` and may differ textually/);
  assert.match(readme, /use relation property names such as `conversation`, `sender`, and `member`/);
});

test('RLS guidance preserves caller projection and pagination', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.js', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.js', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../src/mcp-server-entry.mjs', import.meta.url), 'utf8');
  assert.match(instructions, /do not override `@QUERY\.fields`/);
  assert.match(instructions, /RLS may only merge security filters into `@QUERY\.filter`/);
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
