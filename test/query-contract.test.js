import test from 'node:test';
import assert from 'node:assert/strict';

import { validateQueryContract } from '../dist/lib/query-contract.js';

const tables = new Map([
  ['landing_page_sections', {
    name: 'landing_page_sections',
    primaryKey: 'id',
    columns: [{ name: 'id' }, { name: 'sectionKey' }],
    relations: [{ propertyName: 'items', type: 'one-to-many', targetTable: 'landing_page_items' }],
  }],
  ['landing_page_items', {
    name: 'landing_page_items',
    primaryKey: 'id',
    columns: [{ name: 'id' }, { name: 'icon' }, { name: 'order' }],
    relations: [{ propertyName: 'contentSet', type: 'many-to-one', targetTable: 'landing_content_sets' }],
  }],
  ['landing_content_sets', {
    name: 'landing_content_sets',
    primaryKey: 'id',
    columns: [{ name: 'id' }],
    relations: [{ propertyName: 'contents', type: 'one-to-many', targetTable: 'landing_contents' }],
  }],
  ['landing_contents', {
    name: 'landing_contents',
    primaryKey: 'id',
    columns: [{ name: 'id' }, { name: 'languageCode' }, { name: 'values' }, { name: 'isActive' }],
    relations: [],
  }],
]);

const loadTable = async (tableName) => {
  const table = tables.get(tableName);
  if (!table) throw new Error(`Missing table ${tableName}`);
  return table;
};

test('validates dotted fields and nested deep fields through relation targets', async () => {
  const receipt = await validateQueryContract({
    rootTable: tables.get('landing_page_sections'),
    fields: ['id', 'items.contentSet.contents.values'],
    deep: {
      items: {
        fields: 'id,contentSet',
        deep: {
          contentSet: {
            fields: 'id,contents',
            deep: {
              contents: { fields: 'id,languageCode,values,isActive', limit: 10 },
            },
          },
        },
      },
    },
    loadTable,
  });

  assert.equal(receipt.requestedFieldsValidated, true);
  assert.equal(receipt.deepValidated, true);
  assert.deepEqual(receipt.metadataTablesChecked, [
    'landing_page_sections',
    'landing_page_items',
    'landing_content_sets',
    'landing_contents',
  ]);
  assert.ok(receipt.validatedPaths.includes('items.contentSet.contents.values'));
  assert.deepEqual(
    receipt.pathMetadata.find(item => item.path === 'items.contentSet.contents.values'),
    {
      path: 'items.contentSet.contents.values',
      tableName: 'landing_contents',
      fieldName: 'values',
      kind: 'column',
      isPublished: null,
      isEncrypted: null,
    },
  );
  assert.deepEqual(receipt.resolvedRelations, [
    { path: 'items', sourceTable: 'landing_page_sections', targetTable: 'landing_page_items', type: 'one-to-many' },
    { path: 'items.contentSet', sourceTable: 'landing_page_items', targetTable: 'landing_content_sets', type: 'many-to-one' },
    { path: 'items.contentSet.contents', sourceTable: 'landing_content_sets', targetTable: 'landing_contents', type: 'one-to-many' },
  ]);
});

test('rejects removed dotted fields on the relation target with a path-specific error', async () => {
  await assert.rejects(
    validateQueryContract({
      rootTable: tables.get('landing_page_sections'),
      fields: ['id', 'items.title'],
      loadTable,
    }),
    /Unknown query_table field "items\.title".*landing_page_items.*Valid fields.*contentSet/s,
  );
});

test('rejects unknown fields inside deep relation options before the REST read', async () => {
  await assert.rejects(
    validateQueryContract({
      rootTable: tables.get('landing_page_sections'),
      fields: ['id'],
      deep: { items: { fields: 'id,title', limit: 10 } },
      loadTable,
    }),
    /Unknown query_table field "items\.title".*landing_page_items/s,
  );
});

test('rejects invalid deep option and singular relation pagination contracts', async () => {
  await assert.rejects(
    validateQueryContract({
      rootTable: tables.get('landing_page_sections'),
      fields: ['id'],
      deep: { items: { _fields: 'id' } },
      loadTable,
    }),
    /Unknown deep option key '_fields'.*Allowed: fields, filter, sort, limit, page, deep/,
  );

  await assert.rejects(
    validateQueryContract({
      rootTable: tables.get('landing_page_sections'),
      fields: ['id'],
      deep: { items: { deep: { contentSet: { fields: 'id', limit: 1 } } } },
      loadTable,
    }),
    /'limit' not supported.*items\.contentSet.*many-to-one/,
  );
});

test('preserves a metadata-derived Mongo _id primary key in the receipt', async () => {
  const receipt = await validateQueryContract({
    rootTable: {
      name: 'mongo_documents',
      primaryKey: '_id',
      columns: [{ name: '_id', isPrimary: true }, { name: 'title' }],
      relations: [],
    },
    fields: ['_id', 'title'],
    loadTable: async () => { throw new Error('No relation metadata should be loaded.'); },
  });

  assert.equal(receipt.primaryKey, '_id');
  assert.deepEqual(receipt.validatedPaths, ['_id', 'title']);
});
