/**
 * Table & Column tools for Enfyra MCP Server
 */
import { fetchAPI } from './fetch.js';
import {
  fetchTableCatalog,
  fetchTableMetadata,
  resolveTableCatalogEntry
} from './metadata-client.js';
import {
  getId,
} from './schema-relation-contracts.js';
import type { AnyRecord, ColumnPatch } from './schema-tool-types.js';
export type { AnyRecord, CascadeVerifyOptions, ColumnPatch, ConstraintGroup, RelationConstraintUpdate, RelationPatch } from './schema-tool-types.js';

export function bulkObjectArrayParam(z, label: string) {
  return z.array(z.record(z.any())).describe(`${label} as a native JSON array of objects. Pass one object in the array for a single mutation.`);
}

let schemaQueue: Promise<unknown> = Promise.resolve();

export function getColumnContractBroadening(existingColumn: AnyRecord, requested: AnyRecord) {
  const broadened: string[] = [];
  if (existingColumn?.isUpdatable === false && requested?.isUpdatable === true) broadened.push('isUpdatable false→true');
  return broadened;
}

export const assertColumnContractBroadening = getColumnContractBroadening;

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

const REVISION_RETRY_LIMIT = 3;
const REVISION_RETRY_DELAY_MS = 300;

function isRevisionMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('revision mismatch') || message.includes('revision stale');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PATCH enfyra_table with auto-confirm for schema changes.
 * First PATCH returns preview + requiredConfirmHash; this helper
 * automatically resends with ?schemaConfirmHash= to apply.
 * Retries on revision mismatch (async metadata writes between preview and confirm).
 */
export async function patchTableAutoConfirm(ENFYRA_API_URL, tableId, body) {
  for (let attempt = 0; attempt <= REVISION_RETRY_LIMIT; attempt++) {
    const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_table/${tableId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const preview = Array.isArray(result?.data) ? result.data[0] : result?.data;
    if (preview?._preview && preview?.requiredConfirmHash) {
      try {
        return await fetchAPI(ENFYRA_API_URL, `/enfyra_table/${tableId}?schemaConfirmHash=${preview.requiredConfirmHash}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } catch (confirmError: unknown) {
        if (isRevisionMismatch(confirmError) && attempt < REVISION_RETRY_LIMIT) {
          await sleep(REVISION_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw confirmError;
      }
    }
    return result;
  }
  throw new Error(`patchTableAutoConfirm: exhausted ${REVISION_RETRY_LIMIT} retries for table ${tableId}`);
}
