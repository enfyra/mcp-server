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
  AnyRecord,
  CascadeVerifyOptions,
  ColumnPatch,
  fetchTableWithDetails,
  normalizeTablesFromMetadata,
} from './schema-mutation-coordinator.js';
import {
  getId,
  normalizeColumnForTablePatch,
  normalizeColumnOptionsValue,
  normalizeColumnTypeForLiveMetadata,
  parseColumnTypeOptions,
  sanitizeExistingRelationForTablePatch,
} from './schema-relation-contracts.js';

function findMetadataTable(metadata: AnyRecord, tableName: string) {
  return normalizeTablesFromMetadata(metadata).find((table) => table?.name === tableName) || null;
}

export function metadataColumnNames(metadata: AnyRecord, tableName: string) {
  return (findMetadataTable(metadata, tableName)?.columns || [])
    .map((column) => column?.name)
    .filter(Boolean);
}

export function metadataColumnOptions(metadata: AnyRecord, tableName: string, columnName: string) {
  const column = (findMetadataTable(metadata, tableName)?.columns || [])
    .find((item) => item?.name === columnName);
  return parseColumnTypeOptions(column?.options);
}

export function summarizeCreatedTableSchema(table: AnyRecord | null, fallbackName: string) {
  if (!table) return null;
  const columns = (table.columns || [])
    .map((column) => column?.name)
    .filter(Boolean);
  const relations = (table.relations || [])
    .map((relation) => relation?.propertyName)
    .filter(Boolean);
  return {
    tableName: table.name || fallbackName,
    primaryKey: (table.columns || []).find((column) => column?.isPrimary)?.name || null,
    fields: [...columns, ...relations].sort(),
    columns,
    relations,
  };
}

export function getPatchableColumns(columns: AnyRecord[] = []): ColumnPatch[] {
  return (columns || [])
    .filter((column) => getId(column) !== null)
    .map(normalizeColumnForTablePatch);
}

function getMissingIds(beforeIds: unknown[], afterIds: unknown[], excludedIds: unknown[] = []) {
  const afterSet = new Set(afterIds.map(String));
  const excludedSet = new Set(excludedIds.map(String));
  return beforeIds
    .map(String)
    .filter((id) => !excludedSet.has(id) && !afterSet.has(id));
}

export async function verifyColumnCascade(ENFYRA_API_URL, tableId, beforeIds, {
  action,
  columnId,
  columnName,
}: CascadeVerifyOptions) {
  const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
  const afterColumns = getPatchableColumns(tableData.columns);
  const afterIds = afterColumns.map((column) => String(getId(column)));
  const excludedIds = action === 'delete' ? [columnId] : [];
  const missingIds = getMissingIds(beforeIds, afterIds, excludedIds);
  if (missingIds.length > 0) {
    throw new Error(`Schema cascade verification failed: unrelated column ids disappeared: ${missingIds.join(', ')}`);
  }

  if (action === 'create' && !afterColumns.some((column) => column.name === columnName)) {
    throw new Error(`Schema cascade verification failed: column "${columnName}" was not found after create.`);
  }
  if (action === 'delete' && afterIds.includes(String(columnId))) {
    throw new Error(`Schema cascade verification failed: column ${columnId} still exists after delete.`);
  }
  if (action === 'update' && !afterIds.includes(String(columnId))) {
    throw new Error(`Schema cascade verification failed: column ${columnId} was not found after update.`);
  }

  return afterColumns;
}

export async function verifyRelationCascade(ENFYRA_API_URL, tableId, beforeIds, {
  action,
  relationId,
  propertyName,
}: CascadeVerifyOptions) {
  const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
  const afterRelations = (tableData.relations || []).map(sanitizeExistingRelationForTablePatch);
  const afterIds = afterRelations.map((relation) => String(getId(relation))).filter((id) => id !== 'null');
  const excludedIds = action === 'delete' ? [relationId] : [];
  const missingIds = getMissingIds(beforeIds, afterIds, excludedIds);
  if (missingIds.length > 0) {
    throw new Error(`Schema cascade verification failed: unrelated relation ids disappeared: ${missingIds.join(', ')}`);
  }
  if (action === 'create' && !afterRelations.some((relation) => relation.propertyName === propertyName)) {
    throw new Error(`Schema cascade verification failed: relation "${propertyName}" was not found after create.`);
  }
  if (action === 'delete' && afterIds.includes(String(relationId))) {
    throw new Error(`Schema cascade verification failed: relation ${relationId} still exists after delete.`);
  }
  return afterRelations;
}

export function buildColumnDefinition({
  name,
  type,
  supportedTypes,
  isNullable,
  isUnique,
  isPublished,
  isUpdatable,
  isEncrypted,
  isPrimary,
  isGenerated,
  isSystem,
  defaultValue,
  description,
  options,
}: AnyRecord): ColumnPatch {
  const normalizedType = normalizeColumnTypeForLiveMetadata(type, supportedTypes).type;
  const column: ColumnPatch = {
    name,
    type: normalizedType,
    isNullable: isNullable ?? true,
    isPrimary: isPrimary ?? false,
    isGenerated: isGenerated ?? false,
    isSystem: isSystem ?? false,
    isPublished: isPublished ?? true,
    isUpdatable: isUpdatable ?? true,
    isEncrypted: isEncrypted ?? false,
  };
  if (isUnique !== undefined) column.isUnique = isUnique;
  if (defaultValue !== undefined) column.defaultValue = defaultValue;
  if (description !== undefined) column.description = description;
  if (options !== undefined) column.options = normalizeColumnOptionsValue(options);
  return column;
}
