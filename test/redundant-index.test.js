import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIndexesDoNotReferenceUniqueFields, resolveRelationConstraintGroups } from '../dist/lib/table-tools.js';
import { createSchemaToolOperations } from '../dist/lib/schema-tool-operations.js';
import { preflightCreateTableDefinitions } from '../dist/lib/schema-table-contracts.js';
import { initAuth, resetTokens } from '../dist/lib/auth.js';

const table = {
  id: 42, name: 'user_discount',
  columns: [{ id: 1, name: 'id', type: 'int', isPrimary: true }],
  relations: [{ id: 2, propertyName: 'user', type: 'many-to-one', foreignKeyColumn: 'userId', targetTableId: 1 }],
  uniques: [['user', 'discount']], indexes: [['user']],
};

test('rejects ordered unique prefixes, but preserves useful suffix/reordered lookups', () => {
  assert.throws(() => assertIndexesDoNotReferenceUniqueFields([['user']], [['user', 'discount']]), /unique/iu);
  assert.doesNotThrow(() => assertIndexesDoNotReferenceUniqueFields([['discount'], ['discount', 'user'], ['user', 'createdAt']], [['user', 'discount']]));
});

test('create preflight rejects a manual relation singleton already managed automatically', () => {
  assert.throws(() => preflightCreateTableDefinitions([{ name: 'link', relations: [{ propertyName: 'user', type: 'many-to-one', targetTable: 1 }], indexes: [['user']] }]), /automatic indexes/iu);
});

test('relation constraints retain logical property names at the public mutation boundary', () => {
  assert.deepEqual(resolveRelationConstraintGroups(table, [['user', 'discount']], 'uniques'), [['user', 'discount']]);
});

for (const mode of ['reject', 'readback']) {
  test(`update_tables ${mode === 'reject' ? 'rejects physical/logical aliases before PATCH' : 'fails when an index removal is not persisted'}`, async () => {
    const originalFetch = global.fetch;
    let patches = 0;
    global.fetch = async (url, options = {}) => {
      if (options.method === 'PATCH') {
        patches++;
        return Response.json({ data: [{ id: 42 }] });
      }
      if (String(url).endsWith('/metadata')) return Response.json({ dbType: 'postgres' });
      if (String(url).includes('/metadata/user_discount')) return Response.json({ data: table });
      if (String(url).includes('/enfyra_table')) return Response.json({ data: [table] });
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      initAuth('http://index-regression.local', 'fixture-pat');
      const operations = createSchemaToolOperations('http://index-regression.local', 'full');
      await assert.rejects(operations.updateOneTable({
        tableId: 42, indexes: mode === 'reject' ? [['userId']] : [],
      }), mode === 'reject' ? /unique/iu : /persist|read.back|verification/iu);
      assert.equal(patches, mode === 'reject' ? 0 : 1);
    } finally {
      global.fetch = originalFetch;
      resetTokens();
    }
  });
}
