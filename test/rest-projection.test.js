import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectRestProjection } from '../dist/lib/rest-projection.js';

const table = {
  name: 'records',
  primaryKey: 'id',
  columns: [
    { name: 'id', isPrimary: true, isPublished: true },
    { name: 'title', isPublished: true },
    { name: 'secret', isPublished: false, isEncrypted: true },
  ],
  relations: [],
};

const loadTable = async () => table;

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Unauthorized', body };
}

test('returns schema mismatch without executing a request for unknown fields', async () => {
  let requests = 0;
  const result = await inspectRestProjection('https://example.test/api', {
    tableName: 'records',
    fields: ['id', 'removedField'],
    access: 'compare',
  }, {
    loadTable,
    request: async () => {
      requests += 1;
      return response(200, { data: [] });
    },
  });

  assert.equal(result.verdict, 'schema_contract_mismatch');
  assert.match(result.contractError, /removedField/);
  assert.equal(requests, 0);
});

test('classifies unpublished omission without returning record values', async () => {
  const result = await inspectRestProjection('https://example.test/api', {
    tableName: 'records',
    fields: ['id', 'title', 'secret'],
    access: 'compare',
  }, {
    loadTable,
    request: async (_url, authenticated) => authenticated
      ? response(200, { data: [{ id: 1, title: 'Private title', secret: 'plaintext-secret' }] })
      : response(200, { data: [{ id: 1, title: 'Public title' }] }),
  });

  assert.equal(result.verdict, 'expected_unpublished_omission');
  assert.deepEqual(result.differences, [
    {
      path: 'secret',
      authenticated: 'present',
      anonymous: 'missing',
      isPublished: false,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /plaintext-secret|Private title|Public title/);
});

test('detects published access differences and unexpected public exposure', async () => {
  const missingPublished = await inspectRestProjection('https://example.test/api', {
    tableName: 'records',
    fields: ['id', 'title'],
    access: 'compare',
  }, {
    loadTable,
    request: async (_url, authenticated) => authenticated
      ? response(200, { data: [{ id: 1, title: 'Visible to admin' }] })
      : response(200, { data: [{ id: 1 }] }),
  });
  assert.equal(missingPublished.verdict, 'access_projection_difference');

  const leaked = await inspectRestProjection('https://example.test/api', {
    tableName: 'records',
    fields: ['id', 'secret'],
    access: 'compare',
  }, {
    loadTable,
    request: async () => response(200, { data: [{ id: 1, secret: 'leaked-secret' }] }),
  });
  assert.equal(leaked.verdict, 'unexpected_public_exposure');
  assert.doesNotMatch(JSON.stringify(leaked), /leaked-secret/);
});

test('distinguishes a private route from a projection mismatch', async () => {
  const result = await inspectRestProjection('https://example.test/api', {
    tableName: 'records',
    fields: ['id', 'title'],
    access: 'compare',
  }, {
    loadTable,
    request: async (_url, authenticated) => authenticated
      ? response(200, { data: [{ id: 1, title: 'Visible' }] })
      : response(401, { message: 'Unauthorized' }),
  });

  assert.equal(result.verdict, 'private_route');
  assert.equal(result.anonymous.status, 401);
});

test('does not claim projections match when both responses contain no rows', async () => {
  const result = await inspectRestProjection('https://example.test/api', {
    tableName: 'records',
    fields: ['id', 'title'],
    access: 'compare',
  }, {
    loadTable,
    request: async () => response(200, { data: [] }),
  });

  assert.equal(result.verdict, 'projection_indeterminate_no_rows');
});
