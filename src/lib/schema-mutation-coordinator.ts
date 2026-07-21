/**
 * Table & Column tools for Enfyra MCP Server
 */
import { z } from 'zod';
import { fetchAPI } from './fetch.js';
import {
  fetchMetadataContext,
  fetchTableCatalog,
  fetchTableMetadata,
  resolveTableCatalogEntry,
} from './metadata-client.js';
import { jsonContent } from './response-format.js';
import { assertGlobalRulesAck, globalRulesAckParam } from './required-knowledge.js';
import { normalizeTableName } from './tool-input-normalization.js';
import {
  getId,
} from './schema-relation-contracts.js';
import type { AnyRecord, CascadeVerifyOptions, ColumnPatch, ConstraintGroup, RelationPatch } from './schema-tool-types.js';
export type { AnyRecord, CascadeVerifyOptions, ColumnPatch, ConstraintGroup, RelationPatch } from './schema-tool-types.js';

export function bulkObjectArrayParam(z, label: string) {
  return z.array(z.record(z.any())).describe(`${label} as a native JSON array of objects. Pass one object in the array for a single mutation.`);
}

let schemaQueue: Promise<unknown> = Promise.resolve();

export function assertColumnContractBroadening(existingColumn: AnyRecord, requested: AnyRecord, toolset = 'guided') {
  const broadened: string[] = [];
  if (existingColumn?.isUpdatable === false && requested?.isUpdatable === true) broadened.push('isUpdatable false→true');
  if (existingColumn?.isPublished === false && requested?.isPublished === true) broadened.push('isPublished false→true');
  if (broadened.length > 0 && (toolset !== 'full' || requested?.allowContractBroadening !== true)) {
    throw new Error(
      `Column contract broadening is blocked in the guided toolset: ${broadened.join(', ')}. Do not broaden canonical metadata merely for a custom action or E2E fixture; use an exact trusted internal write after authorization instead. Expert full-toolset changes additionally require allowContractBroadening=true.`,
    );
  }
  return broadened;
}

export function withSchemaQueue<T>(operation: () => Promise<T> | T): Promise<T> {
  const run = schemaQueue.then(operation, operation);
  schemaQueue = run.catch(() => {});
  return run;
}

export const FORBIDDEN_RELATION_KEYS = [
  'fkCol',
  'fkColumn',
  'foreignKeyColumn',
  'referencedColumn',
  'constraintName',
  'sourceColumn',
  'targetColumn',
  'junctionTableName',
  'junctionSourceColumn',
  'junctionTargetColumn',
];

export const FALLBACK_COLUMN_TYPES = [
  'int',
  'varchar',
  'text',
  'boolean',
  'uuid',
  'ObjectId',
  'bigint',
  'date',
  'datetime',
  'timestamp',
  'enum',
  'simple-json',
  'code',
  'array-select',
  'richtext',
  'float',
];

export const RELATION_TYPE_ALIASES: Record<string, string> = {
  many_to_one: 'many-to-one',
  manyToOne: 'many-to-one',
  manytoone: 'many-to-one',
  one_to_many: 'one-to-many',
  oneToMany: 'one-to-many',
  onetomany: 'one-to-many',
  one_to_one: 'one-to-one',
  oneToOne: 'one-to-one',
  onetoone: 'one-to-one',
  many_to_many: 'many-to-many',
  manyToMany: 'many-to-many',
  manytomany: 'many-to-many',
};

export const VALID_RELATION_TYPES = new Set(['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many']);

export const AUTO_MANAGED_COLUMN_NAMES = new Set(['id', '_id', 'createdAt', 'updatedAt']);

export function buildPrimaryColumnForDbType(dbType: string | null | undefined): ColumnPatch {
  return dbType === 'mongodb'
    ? { name: '_id', type: 'ObjectId', isPrimary: true, isGenerated: true, isNullable: false }
    : { name: 'id', type: 'int', isPrimary: true, isGenerated: true, isNullable: false };
}

export const COLUMN_TYPE_ALIAS_HINTS = [
  'Use varchar for short strings; text or richtext for long prose.',
  'Use float for prices, money, percentages, ratings, and decimal-like numbers unless the live instance explicitly lists decimal.',
  'Use simple-json for structured objects/arrays when the live instance lists it; do not use json/jsonb as column types.',
  'Use relations for links to other records; do not create userId/course_id/categoryIds columns for normalized relationships.',
];

export function normalizeTablesFromMetadata(metadata) {
  if (Array.isArray(metadata)) return metadata;
  if (metadata?.data?.name && Array.isArray(metadata.data.columns)) return [metadata.data];
  if (metadata?.name && Array.isArray(metadata.columns)) return [metadata];
  const tablesSource = metadata?.data?.tables || metadata?.tables || metadata?.data || [];
  return Array.isArray(tablesSource)
    ? tablesSource
    : Object.values(tablesSource || {});
}

export function resolveTableFromMetadata(metadata, tableId) {
  return normalizeTablesFromMetadata(metadata)
    .find((table) => String(getId(table)) === String(tableId)) || null;
}

export function resolveTableFromMetadataByName(metadata, tableName) {
  if (!tableName) return null;
  return normalizeTablesFromMetadata(metadata)
    .find((table) => table?.name === tableName || table?.alias === tableName) || null;
}

export function resolveTableIdentifierFromMetadata(metadata, tableRef, label = 'table') {
  const resolvedTable = normalizeTablesFromMetadata(metadata)
    .find((table) => (
      String(getId(table)) === String(tableRef) ||
      table?.name === tableRef ||
      table?.alias === tableRef
    ));
  if (!resolvedTable) {
    throw new Error(`${label} "${tableRef}" was not found in metadata. Pass an existing table id, name, or alias from get_all_tables/inspect_table.`);
  }
  return getId(resolvedTable);
}

/**
 * Helper: fetch table with full columns and relations.
 * Schema cascade tools resolve the table catalog entry first, then request the
 * complete permission-projected schema from /metadata/:name.
 */
export async function fetchTableWithDetails(ENFYRA_API_URL, tableId): Promise<AnyRecord> {
  const catalog = await fetchTableCatalog(ENFYRA_API_URL);
  const tableData = resolveTableCatalogEntry(catalog, tableId);
  if (!tableData) {
    throw new Error(`Full metadata for table ${tableId} was not found; refusing schema cascade patch.`);
  }
  const metadataTable = await fetchTableMetadata(ENFYRA_API_URL, tableData.name);
  if (!Array.isArray(metadataTable.columns)) {
    throw new Error(`Full metadata for table ${tableId} did not include columns; refusing schema cascade patch.`);
  }
  return {
    ...tableData,
    ...metadataTable,
    columns: metadataTable.columns,
    relations: Array.isArray(metadataTable.relations) ? metadataTable.relations : [],
  } as AnyRecord;
}

/**
 * PATCH enfyra_table with auto-confirm for schema changes.
 * First PATCH returns preview + requiredConfirmHash; this helper
 * automatically resends with ?schemaConfirmHash= to apply.
 */
export async function patchTableAutoConfirm(ENFYRA_API_URL, tableId, body) {
  const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_table/${tableId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const preview = Array.isArray(result?.data) ? result.data[0] : result?.data;
  if (preview?._preview && preview?.requiredConfirmHash) {
    return fetchAPI(ENFYRA_API_URL, `/enfyra_table/${tableId}?schemaConfirmHash=${preview.requiredConfirmHash}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }
  return result;
}
