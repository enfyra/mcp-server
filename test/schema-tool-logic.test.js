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
  getSupportedColumnTypes,
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
import { createSchemaToolOperations } from '../dist/lib/schema-tool-operations.js';
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

test('delete_relations detaches an inverse through its owning relation snapshot', async () => {
  const originalFetch = global.fetch;
  const patchBodies = [];
  let detached = false;
  const tables = [
    { id: 1, name: 'announcements' },
    { id: 2, name: 'enfyra_user' },
  ];
  global.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (requestUrl.includes('/enfyra_table?')) return jsonResponse({ data: tables });
    if (requestUrl.endsWith('/metadata/announcements')) {
      return jsonResponse({ data: {
        id: 1,
        name: 'announcements',
        columns: [],
        relations: [{
          id: 700,
          propertyName: 'forceVisibleForUsers',
          type: 'many-to-many',
          targetTable: 2,
          inversePropertyName: 'forcedAnnouncements',
        }],
      } });
    }
    if (requestUrl.endsWith('/metadata/enfyra_user')) {
      return jsonResponse({ data: {
        id: 2,
        name: 'enfyra_user',
        columns: [],
        relations: detached ? [] : [{
          id: 801,
          propertyName: 'forcedAnnouncements',
          type: 'many-to-many',
          targetTable: 1,
          mappedBy: 'forceVisibleForUsers',
        }],
      } });
    }
    if (requestUrl.includes('/enfyra_table/1') && init.method === 'PATCH') {
      patchBodies.push(JSON.parse(init.body));
      if (requestUrl.includes('schemaConfirmHash=')) detached = true;
      return jsonResponse({ data: detached ? { id: 1 } : {
        _preview: true,
        requiredConfirmHash: 'detach-inverse',
      } });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    const operations = createSchemaToolOperations('https://example.test/api');
    const result = await operations.removeRelationFromTable({
      tableId: 2,
      relationId: 801,
      confirm: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.action, 'inverse_relation_detached');
    assert.equal(payload.owningTableId, 1);
    assert.equal(detached, true);
    assert.equal(patchBodies.length, 2);
    assert.equal(
      Object.hasOwn(patchBodies[0].relations[0], 'inversePropertyName'),
      false,
    );
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('fetchTableWithDetails reads full columns from metadata instead of enfyra_table nested fields', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const metadataColumns = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    name: `field_${index + 1}`,
    type: 'varchar',
  }));

  global.fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).includes('/enfyra_table?')) {
      return jsonResponse({
        data: [{
          id: 79,
          name: 'cloud_projects',
        }],
      });
    }
    if (String(url).endsWith('/metadata/cloud_projects')) {
      return jsonResponse({
        data: {
          id: 79,
          name: 'cloud_projects',
          columns: metadataColumns,
          relations: [{ id: 5, propertyName: 'owner' }],
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

  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).includes('/enfyra_table?')) {
      return jsonResponse({
        data: [{
          id: 1,
          name: 'mcp_project',
        }],
      });
    }
    if (String(url).endsWith('/metadata/mcp_project')) {
      return jsonResponse({
        data: {
          id: true,
          name: 'mcp_project',
          columns: [{ id: 3, name: 'type', type: 'enum' }],
          relations: [],
        },
      });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    const table = await fetchTableWithDetails('https://example.test/api', 1);

    assert.equal(table.name, 'mcp_project');
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
    /indexes must not include fields that appear in uniques, including composite unique groups/,
  );
  assert.throws(
    () =>
      assertIndexesDoNotReferenceUniqueFields(
        [['status', 'scheduled_start']],
        [['patient', 'scheduled_start']],
      ),
    /\["status","scheduled_start"\] overlaps unique group\(s\) \["patient","scheduled_start"\] via \["scheduled_start"\]/,
  );

  assert.doesNotThrow(() =>
    assertIndexesDoNotReferenceUniqueFields(
      [['is_active', 'sort_order']],
      [['version'], ['docker_image']],
    ),
  );
});

test('column type guidance uses the Enfyra schema contract and normalizes common SQL aliases', () => {
  const supportedTypes = getSupportedColumnTypes();

  assert.deepEqual(supportedTypes, ['int', 'varchar', 'text', 'boolean', 'uuid', 'ObjectId', 'bigint', 'date', 'datetime', 'timestamp', 'enum', 'simple-json', 'code', 'array-select', 'richtext', 'float']);
  assert.deepEqual(
    normalizeColumnTypeForLiveMetadata('decimal', supportedTypes),
    { type: 'float', changed: true, originalType: 'decimal' },
  );
  assert.deepEqual(
    normalizeColumnTypeForLiveMetadata('longtext', supportedTypes),
    { type: 'text', changed: true, originalType: 'longtext' },
  );
  assert.deepEqual(
    normalizeColumnTypeForLiveMetadata('json', supportedTypes),
    { type: 'simple-json', changed: true, originalType: 'json' },
  );
  assert.deepEqual(
    normalizeColumnsForLiveMetadata([
      { name: 'price', type: 'decimal' },
      { name: 'metadata', type: 'jsonb' },
    ], supportedTypes),
    {
      columns: [
        { name: 'price', type: 'float' },
        { name: 'metadata', type: 'simple-json' },
      ],
      normalizations: [
        { column: 'price', from: 'decimal', to: 'float' },
        { column: 'metadata', from: 'jsonb', to: 'simple-json' },
      ],
    },
  );
  assert.throws(
    () => normalizeColumnTypeForLiveMetadata('geometry', supportedTypes),
    /Valid Enfyra types: int, varchar, text, boolean, uuid, ObjectId, bigint, date, datetime, timestamp, enum, simple-json, code, array-select, richtext, float/,
  );
});

test('MCP column types stay aligned with the ESV snapshot contract', () => {
  const source = readFileSync(new URL('../../server/src/engines/bootstrap/types/snapshot-definition.types.ts', import.meta.url), 'utf8');
  const definition = source.match(/export type SnapshotColumnType =([\s\S]*?);\n\nexport type SnapshotRelationType/u)?.[1] || '';
  const serverTypes = [...definition.matchAll(/'([^']+)'/gu)].map((match) => match[1]);

  assert.deepEqual(getSupportedColumnTypes(), serverTypes);
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

test('column definitions preserve rich-text metadata and placeholders', () => {
  const metadata = {
    richText: {
      toolbar: 'bold italic | link',
      customButtons: [{ name: 'callout', format: 'callout' }],
    },
  };

  assert.deepEqual(
    buildColumnDefinition({
      name: 'body',
      type: 'richtext',
      metadata,
      placeholder: 'Write the article…',
    }),
    {
      name: 'body',
      type: 'richtext',
      isNullable: true,
      isPrimary: false,
      isGenerated: false,
      isSystem: false,
      isPublished: true,
      isUpdatable: true,
      isEncrypted: false,
      metadata,
      placeholder: 'Write the article…',
    },
  );
});

test('primary column definition follows metadata dbType without pkField', () => {
  assert.deepEqual(buildPrimaryColumnForDbType('postgres'), {
    name: 'id',
    type: 'int',
    isPrimary: true,
    isGenerated: true,
    isNullable: false,
  });
  assert.deepEqual(buildPrimaryColumnForDbType('mongodb'), {
    name: '_id',
    type: 'ObjectId',
    isPrimary: true,
    isGenerated: true,
    isNullable: false,
  });
});

test('fetchAPI sends ENFYRA_API_TOKEN directly through the native ESV PAT header', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || [] });
    if (String(url).endsWith('/me')) {
      const patHeader = Array.isArray(init.headers)
        ? init.headers.find(([key]) => key.toLowerCase() === 'x-enfyra-pat')?.[1]
        : init.headers?.['x-enfyra-pat'];
      assert.equal(patHeader, 'efy_pat_test');
      return jsonResponse({ data: [{ id: 1 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const result = await fetchAPI('https://example.test/api', '/me');

    assert.deepEqual(result, { data: [{ id: 1 }] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.test/api/me');
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('fetchAPI caches reloadable control-plane GET responses and clears their domain after a mutation', async () => {
  const { clearRuntimeCache } = await import('../dist/lib/runtime-cache.js');
  const originalFetch = global.fetch;
  let metadataReads = 0;

  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'jwt-cache', expTime: Date.now() + 60_000 });
    }
    if (String(url).includes('/enfyra_flow') && String(init.method || 'GET').toUpperCase() === 'GET') {
      metadataReads += 1;
      return jsonResponse({ data: [{ name: 'cloud_projects' }] });
    }
    if (String(url).endsWith('/enfyra_flow')) return jsonResponse({ success: true });
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');

    await fetchAPI('https://example.test/api', '/enfyra_flow?limit=1');
    await fetchAPI('https://example.test/api', '/enfyra_flow?limit=1');
    assert.equal(metadataReads, 1);

    await fetchAPI('https://example.test/api', '/enfyra_flow', { method: 'POST', body: '{}' });
    await fetchAPI('https://example.test/api', '/enfyra_flow?limit=1');
    assert.equal(metadataReads, 2);
  } finally {
    clearRuntimeCache();
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('fetchAPI does not replay a rejected request with the same PAT', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || [] });
    if (String(url).endsWith('/me')) {
      return jsonResponse({ message: 'invalid token' }, 401);
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    await assert.rejects(
      () => fetchAPI('https://example.test/api', '/me'),
      /API error \(401\):/,
    );
    assert.equal(calls.filter((call) => call.url.endsWith('/me')).length, 1);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('fetchAPI reuses the configured PAT without exchange or refresh requests', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || [] });
    if (String(url).endsWith('/me')) {
      const patHeader = Array.isArray(init.headers)
        ? init.headers.find(([key]) => key.toLowerCase() === 'x-enfyra-pat')?.[1]
        : init.headers?.['x-enfyra-pat'];
      return jsonResponse({ patHeader });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');

    assert.deepEqual(await fetchAPI('https://example.test/api', '/me'), { patHeader: 'efy_pat_test' });
    assert.deepEqual(await fetchAPI('https://example.test/api', '/me'), { patHeader: 'efy_pat_test' });
    assert.equal(calls.length, 2);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});
