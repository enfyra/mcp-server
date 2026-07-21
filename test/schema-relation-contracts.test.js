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

test('relation normalization accepts common aliases and removes invalid one-to-many inverse payloads', () => {
  assert.equal(normalizeRelationType('many_to_one'), 'many-to-one');
  assert.equal(normalizeRelationType('oneToMany'), 'one-to-many');
  assert.throws(() => normalizeRelationType('belongs_to'), /Invalid relation type/);

  assert.deepEqual(
    normalizeRelationForTablePatch({
      targetTable: 'app_tasks',
      type: 'one_to_many',
      propertyName: 'tasks',
      mappedBy: 'project',
      inversePropertyName: 'project',
    }),
    {
      targetTable: 'app_tasks',
      type: 'one-to-many',
      propertyName: 'tasks',
      mappedBy: 'project',
    },
  );
});

test('delete_records defaults to cascade-tolerant not-found cleanup', () => {
  const entry = readEntrySource();
  assert.match(entry, /skipNotFound: z\.boolean\(\)\.optional\(\)\.default\(true\)/);
  assert.match(entry, /skippedNotFoundCount/);
  assert.match(entry, /isNotFoundDeleteError/);
});

test('query_table normalizes quoted sort fields from weak clients', () => {
  const entry = readEntrySource();
  assert.match(entry, /function normalizeSortParam/);
  assert.match(entry, /\.replace\(\/\^\(\['"\]\)\(\.\*\)\\1\$\/u, '\$2'\)/);
  assert.match(entry, /queryParams\.set\('sort', normalizedSort\)/);
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
