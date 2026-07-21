import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readEntrySource,
  readExamplesSource,
  readPlatformSource,
  readRoutingSource,
  readRuntimeZoneSource,
  readSchemaSource,
  readSourceFiles,
  readSourceTree,
} from '../test-support/source-tree.js';
import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { fetchAPI } from '../dist/lib/fetch.js';
import {
  buildColumnDefinition,
  assertColumnContractBroadening,
  assertIndexesDoNotReferenceUniqueFields,
  buildPrimaryColumnForDbType,
  computeBatchCleanupOrder,
  fetchTableWithDetails,
  getSupportedColumnTypesFromMetadata,
  normalizeColumnsForLiveMetadata,
  normalizeColumnTypeForLiveMetadata,
  normalizeRelationForTablePatch,
  normalizeRelationType,
  registerTableTools,
  resolveTableIdentifierFromMetadata,
  resolveRelationTargetsFromMetadata,
  resolveTableFromMetadata,
  resolveTableFromMetadataByName,
  sanitizeExistingRelationForTablePatch,
} from '../dist/lib/table-tools.js';
import { prepareRecordBatchMutation, prepareRecordMutation, validatePortableScriptSource } from '../dist/lib/mutation-guards.js';
import { validateMainTableRoutePath } from '../dist/lib/route-guards.js';
import {
  DYNAMIC_CODE_KNOWLEDGE_ACK_KEY,
  GLOBAL_RULES_ACK_KEY,
  buildRequiredKnowledgePayload,
} from '../dist/lib/required-knowledge.js';
import { WORKFLOW_SURFACES, discoverWorkflowRoutes, listWorkflowSurfaces } from '../dist/lib/tool-routing.js';
import {
  findRoutePermission,
  mergeMethodNames,
  resolveRoleByNameOrId,
  routePermissionMatchesScope,
  summarizeRouteAccess,
  validateMethodsForRoute,
} from '../dist/lib/route-permission-tools.js';

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

test('get_all_tables applies search and explicit all contract', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();

  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).endsWith('/metadata')) {
      return jsonResponse({ dbType: 'postgres', enfyraVersion: '2.2.11' });
    }
    if (String(url).includes('/enfyra_table?')) {
      return jsonResponse({
        data: [
          { id: 1, name: 'enfyra_user', alias: 'Users', description: 'System users' },
          { id: 10, name: 'enfyra_column' },
          { id: 11, name: 'enfyra_relation' },
          { id: 12, name: 'enfyra_table' },
          { id: 2, name: 'mcp_project', description: 'Test project' },
          { id: 3, name: 'mcp_issue', description: 'Test issue' },
        ],
      });
    }
    if (String(url).endsWith('/metadata/enfyra_column')) return jsonResponse({ data: {
      id: 10,
      name: 'enfyra_column',
      columns: [{ name: 'type', type: 'enum', options: '{"int","varchar","text","boolean","simple-json","float"}' }],
      relations: [],
    } });
    if (String(url).endsWith('/metadata/enfyra_relation')) return jsonResponse({ data: {
      id: 11,
      name: 'enfyra_relation',
      columns: [
        { name: 'type', type: 'enum', options: '{"many-to-one","one-to-many","one-to-one","many-to-many"}' },
        { name: 'onDelete', type: 'enum', options: '{"CASCADE","SET NULL","RESTRICT"}' },
      ],
      relations: [],
    } });
    if (String(url).endsWith('/metadata/enfyra_table')) return jsonResponse({ data: {
      id: 12,
      name: 'enfyra_table',
      columns: [{ name: 'name', type: 'varchar' }],
      relations: [],
    } });
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

    const result = await server.get('get_all_tables').handler({ search: 'mcp_' });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.matchedTableCount, 2);
    assert.equal(payload.returnedTableCount, 2);
    assert.equal(payload.implicitSearchLimit, true);
    assert.match(result.content[0].text, /mcp_project/);
    assert.doesNotMatch(result.content[0].text, /enfyra_user/);

    const designResult = await server.get('get_schema_design_context').handler({});
    const designPayload = JSON.parse(designResult.content[0].text);
    assert.deepEqual(designPayload.liveColumnTypes, ['int', 'varchar', 'text', 'boolean', 'simple-json', 'float']);
    assert.match(designPayload.primaryKeyContext.createTableDefault, /SQL id\/int primary key/);
    assert.match(JSON.stringify(designPayload.recommendedSequence), /Create independent lookup\/base tables first/);
    assert.match(JSON.stringify(designPayload.relationDefinitionInput.forbiddenPhysicalFields), /foreignKeyColumn/);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_relations resolves table names before schema patch', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  let patchedBody = null;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (urlText.includes('/enfyra_table?')) {
      return jsonResponse({
        data: [
          { id: 9, name: 'mcp_issue' },
          { id: 4, name: 'enfyra_user', alias: 'Users' },
        ],
      });
    }
    if (urlText.endsWith('/metadata/mcp_issue')) {
      return jsonResponse({ data: {
          id: 9,
          name: 'mcp_issue',
          columns: [{ id: 1, name: 'title', type: 'varchar' }],
          relations: patchedBody?.relations || [],
      } });
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
    await server.get('create_relations').handler({
      items: [{
        sourceTableId: 'mcp_issue',
        targetTable: 'enfyra_user',
        type: 'many-to-one',
        propertyName: 'owner',
        onDelete: 'SET NULL',
      }],
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    assert.equal(patchedBody.relations[0].targetTable, 4);
    assert.equal(patchedBody.relations[0].propertyName, 'owner');
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_tables accepts tables alias and defers relation constraints until FK columns exist', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  const createdTables = new Map();
  let nextRelationId = 30;
  let constraintPatch = null;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (urlText.endsWith('/metadata')) {
      return jsonResponse({ dbType: 'postgres', enfyraVersion: '2.2.11' });
    }
    if (urlText.endsWith('/metadata/enfyra_column')) {
      return jsonResponse({ data: {
        id: 1,
        name: 'enfyra_column',
        columns: [{ name: 'type', options: JSON.stringify(['int', 'varchar', 'date']) }],
        relations: [],
      } });
    }
    if (urlText.includes('/metadata/event_registration')) {
      return jsonResponse({ data: createdTables.get(99) });
    }
    if (urlText.endsWith('/enfyra_table') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.uniques, []);
      assert.deepEqual(body.indexes, [['status']]);
      assert.equal(body.columns.some((column) => column.name === 'createdAt'), false);
      const table = {
        id: 99,
        name: body.name,
        indexes: [...body.indexes, ['scheduledDate']],
        uniques: body.uniques,
        columns: body.columns.map((column, index) => ({ id: index + 1, ...column })),
        relations: [],
      };
      createdTables.set(99, table);
      return jsonResponse({ data: [table] });
    }
    if (urlText.includes('/enfyra_table?')) {
      return jsonResponse({ data: [
        { id: 1, name: 'enfyra_column' },
        { id: 4, name: 'enfyra_user' },
        { id: 10, name: 'community_event' },
        ...[...createdTables.values()].map((table) => ({ id: table.id, name: table.name })),
      ] });
    }
    if (urlText.endsWith('/enfyra_table/99') && init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      const table = createdTables.get(99);
      if (body.relations) {
        table.relations = body.relations.map((relation) => ({
          id: relation.id || nextRelationId++,
          ...relation,
          foreignKeyColumn: relation.foreignKeyColumn || `${relation.propertyName}Id`,
        }));
        createdTables.set(99, table);
        return jsonResponse({ data: [table] });
      }
      if (body.indexes || body.uniques) {
        constraintPatch = body;
        table.indexes = body.indexes;
        table.uniques = body.uniques;
        createdTables.set(99, table);
        return jsonResponse({ data: [table] });
      }
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    const result = await server.get('create_tables').handler({
      tables: [{
        name: 'event_registration',
        columns: [
          { name: 'status', type: 'varchar', isNullable: false },
          { name: 'scheduledDate', type: 'date', isNullable: false },
          { name: 'createdAt', type: 'datetime' },
        ],
        relations: [
          { targetTable: 'community_event', type: 'many-to-one', propertyName: 'event', isNullable: false },
          { targetTable: 'enfyra_user', type: 'many-to-one', propertyName: 'attendee', isNullable: false },
        ],
        indexes: [['status']],
        uniques: [['event', 'scheduledDate']],
      }],
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.deferredConstraintCount, 1);
    assert.deepEqual(payload.created[0].skippedAutoColumns, [{
      name: 'createdAt',
      reason: 'Enfyra manages id/createdAt/updatedAt automatically during table creation.',
    }]);
    assert.deepEqual(constraintPatch.uniques, [['eventId', 'scheduledDate']]);
    assert.deepEqual(constraintPatch.indexes, [['status']]);
    assert.deepEqual(payload.appliedDeferredConstraints[0].prunedExistingIndexes, [['scheduledDate']]);
    assert.deepEqual(payload.cleanupHints.recordCreateOrder, ['event_registration']);
    assert.match(payload.cleanupHints.recordCreateRule, /parent\/target rows/);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_tables cleanup order puts child/source tables before parent/target tables', () => {
  const order = computeBatchCleanupOrder([
    { name: 'zz_accounts' },
    { name: 'zz_products' },
    { name: 'zz_plans', relations: [{ targetTable: 'zz_products', propertyName: 'product' }] },
    {
      name: 'zz_subscriptions',
      relations: [
        { targetTable: 'zz_accounts', propertyName: 'account' },
        { targetTable: 'zz_plans', propertyName: 'plan' },
      ],
    },
    { name: 'zz_invoices', relations: [{ targetTable: 'zz_subscriptions', propertyName: 'subscription' }] },
    { name: 'zz_usage_events', relations: [{ targetTable: 'zz_subscriptions', propertyName: 'subscription' }] },
  ]);

  assert.ok(order.indexOf('zz_invoices') < order.indexOf('zz_subscriptions'));
  assert.ok(order.indexOf('zz_usage_events') < order.indexOf('zz_subscriptions'));
  assert.ok(order.indexOf('zz_subscriptions') < order.indexOf('zz_accounts'));
  assert.ok(order.indexOf('zz_subscriptions') < order.indexOf('zz_plans'));
  assert.ok(order.indexOf('zz_plans') < order.indexOf('zz_products'));
  assert.deepEqual([...order].reverse()[0], 'zz_products');
});

test('create_tables rejects constraints referencing undeclared fields before partial create', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  let postCount = 0;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (urlText.endsWith('/enfyra_table') && init.method === 'POST') {
      postCount += 1;
      return jsonResponse({ data: [{ id: 100 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    await assert.rejects(
      () => server.get('create_tables').handler({
        items: [
          {
            name: 'event_registration',
            columns: [{ name: 'status', type: 'varchar' }],
            uniques: [['attendee', 'event']],
          },
        ],
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /undeclared field\(s\): attendee, event/,
    );
    assert.equal(postCount, 0);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_tables explains FK-shaped constraint fields and column relation collisions', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  let postCount = 0;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (urlText.endsWith('/enfyra_table') && init.method === 'POST') {
      postCount += 1;
      return jsonResponse({ data: [{ id: 100 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    await assert.rejects(
      () => server.get('create_tables').handler({
        items: [
          {
            name: 'event_hall',
            columns: [{ name: 'name', type: 'varchar' }],
            relations: [{ targetTable: 'event_venue', type: 'many-to-one', propertyName: 'venue' }],
            indexes: [['venueId']],
          },
        ],
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /venueId -> use relation propertyName "venue"/,
    );
    await assert.rejects(
      () => server.get('create_tables').handler({
        items: [
          {
            name: 'crew_assignment',
            columns: [{ name: 'start_date', type: 'date' }],
            relations: [{ targetTable: 'crew', type: 'many-to-one', propertyName: 'crew' }],
            uniques: [['crew', 'startDate']],
          },
        ],
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /startDate -> did you mean "start_date"/,
    );
    await assert.rejects(
      () => server.get('create_tables').handler({
        items: [
          {
            name: 'event_hall',
            columns: [{ name: 'venue', type: 'int' }],
            relations: [{ targetTable: 'event_venue', type: 'many-to-one', propertyName: 'venue' }],
          },
        ],
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /remove the scalar column\(s\) and keep the relation propertyName\(s\) venue/,
    );
    assert.equal(postCount, 0);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_tables rejects unique/index overlap before partial create', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  let postCount = 0;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (urlText.endsWith('/enfyra_table') && init.method === 'POST') {
      postCount += 1;
      return jsonResponse({ data: [{ id: 100 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    await assert.rejects(
      () => server.get('create_tables').handler({
        items: [
          {
            name: 'ok_table',
            columns: [{ name: 'status', type: 'varchar' }],
          },
          {
            name: 'reserve_table',
            columns: [
              { name: 'claim', type: 'varchar' },
              { name: 'reserveType', type: 'varchar' },
            ],
            uniques: [['claim', 'reserveType']],
            indexes: [['reserveType']],
          },
        ],
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /indexes must not include fields that appear in uniques/,
    );
    assert.equal(postCount, 0);
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

test('prepareRecordMutation directs array payloads to create_records', async () => {
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'app_team',
        columns: [{ name: 'name' }],
        relations: [],
      }],
      tableName: 'app_team',
      data: JSON.stringify([{ name: 'Platform' }]),
    }),
    /use create_records/
  );
});

test('prepareRecordBatchMutation preflights every record and reports the failing index', async () => {
  await assert.rejects(
    () => prepareRecordBatchMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'app_team',
        columns: [{ name: 'name' }],
        relations: [],
      }],
      tableName: 'app_team',
      records: JSON.stringify([
        { name: 'Platform' },
        { name: 'Product', is_active: true },
      ]),
    }),
    /index 1[\s\S]*is_active[\s\S]*name/
  );

  const prepared = await prepareRecordBatchMutation({
    fetchAPI: async () => ({ success: true, valid: true }),
    apiUrl: 'https://example.test/api',
    tables: [{
      name: 'app_team',
      columns: [{ name: 'name' }],
      relations: [{ propertyName: 'owner' }],
    }],
    tableName: 'app_team',
    records: [{ name: 'Platform', owner: 1 }],
  });
  assert.equal(prepared.records.length, 1);
  assert.equal(prepared.records[0].payload.owner, 1);
});

test('prepareRecordMutation explains relation property names when FK-shaped fields are sent', async () => {
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'app_primary_record',
        columns: [{ name: 'title' }],
        relations: [{ propertyName: 'lookup' }, { propertyName: 'owner' }],
      }],
      tableName: 'app_primary_record',
      data: JSON.stringify({ title: 'Intro', lookupId: 9, owner_id: 4 }),
    }),
    /lookupId -> use relation property "lookup".*owner_id -> use relation property "owner"/,
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
