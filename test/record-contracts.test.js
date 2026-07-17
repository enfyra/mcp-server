import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeletePostcondition,
  buildQuerySchemaReceipt,
} from '../dist/lib/record-contracts.js';

const table = {
  name: 'tasks',
  primaryKey: 'id',
  columns: [
    { name: 'id', isPrimary: true, isPublished: true },
    { name: 'title', isPublished: true },
    { name: 'secret', isPublished: false },
  ],
  relations: [
    { propertyName: 'owner', isPublished: true },
  ],
};

test('buildQuerySchemaReceipt validates explicit top-level fields and relation paths', () => {
  const receipt = buildQuerySchemaReceipt(table, ['id', 'title', 'owner.name', '-secret']);
  assert.deepEqual(receipt, {
    tableName: 'tasks',
    primaryKey: 'id',
    metadataChecked: true,
    requestedFieldsValidated: true,
    requestedTopLevelFields: ['id', 'title', 'owner', 'secret'],
  });
});

test('buildQuerySchemaReceipt rejects unknown explicit fields before the REST read', () => {
  assert.throws(
    () => buildQuerySchemaReceipt(table, ['id', 'inventedField']),
    /Unknown query_table field.*inventedField.*Valid top-level fields.*owner/,
  );
});

test('buildQuerySchemaReceipt allows wildcard field selectors', () => {
  assert.equal(buildQuerySchemaReceipt(table, ['*']).requestedFieldsValidated, true);
});

test('buildDeletePostcondition proves exact requested ids are absent', () => {
  assert.deepEqual(buildDeletePostcondition(['1', 2], []), {
    verificationMethod: 'route_read_by_primary_keys',
    requestedIds: ['1', 2],
    remainingIds: [],
    confirmedAbsent: true,
  });
});

test('buildDeletePostcondition reports records that remain after delete', () => {
  assert.deepEqual(buildDeletePostcondition(['1', 2], [{ id: 2 }], 'id'), {
    verificationMethod: 'route_read_by_primary_keys',
    requestedIds: ['1', 2],
    remainingIds: [2],
    confirmedAbsent: false,
  });
});
