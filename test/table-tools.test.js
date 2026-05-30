import test from 'node:test';
import assert from 'node:assert/strict';

import { initAuth, resetTokens } from '../src/lib/auth.js';
import { fetchAPI } from '../src/lib/fetch.js';
import {
  buildColumnDefinition,
  fetchTableWithDetails,
  normalizeRelationForTablePatch,
  resolveTableFromMetadata,
} from '../src/lib/table-tools.js';
import { prepareRecordMutation } from '../src/lib/mutation-guards.js';
import { validateMainTableRoutePath } from '../src/lib/route-guards.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('fetchTableWithDetails reads full columns from metadata instead of table_definition nested fields', async () => {
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
    if (String(url).includes('/table_definition?')) {
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
      isEncrypted: true,
      isUpdatable: false,
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
      name: 'route_handler_definition',
      columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }],
      relations: [{ propertyName: 'route' }, { propertyName: 'method' }],
    }],
    tableName: 'route_handler_definition',
    data: JSON.stringify({ sourceCode: 'return true;', scriptLanguage: 'javascript' }),
  });

  assert.equal(prepared.scriptValidation.validated, true);
  assert.equal(calls[0].path, '/admin/script/validate');
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: fetchMock,
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'route_handler_definition',
        columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }, { name: 'compiledCode' }],
        relations: [],
      }],
      tableName: 'route_handler_definition',
      data: JSON.stringify({ sourceCode: 'return true;', compiledCode: 'stale' }),
    }),
    /compiledCode/
  );
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: fetchMock,
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'pre_hook_definition',
        columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }, { name: 'code' }],
        relations: [],
      }],
      tableName: 'pre_hook_definition',
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
        name: 'route_handler_definition',
        columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }],
        relations: [],
      }],
      tableName: 'route_handler_definition',
      data: JSON.stringify({ sourceCode: 'return true;', scriptLanguage: 'javascript' }),
    }),
    /Script validation failed before save/
  );
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

test('prepareRecordMutation rejects direct relation_definition physical FK inputs', async () => {
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'relation_definition',
        columns: [
          { name: 'propertyName' },
          { name: 'type' },
          { name: 'foreignKeyColumn' },
        ],
        relations: [{ propertyName: 'targetTable' }],
      }],
      tableName: 'relation_definition',
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
