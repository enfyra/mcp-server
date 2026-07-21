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
  COLUMN_TYPE_ALIAS_HINTS,
  ColumnPatch,
  ConstraintGroup,
  FALLBACK_COLUMN_TYPES,
  FORBIDDEN_RELATION_KEYS,
  RELATION_TYPE_ALIASES,
  RelationPatch,
  VALID_RELATION_TYPES,
  normalizeTablesFromMetadata,
  resolveTableFromMetadataByName,
} from './schema-mutation-coordinator.js';

export function pruneIndexesThatOverlapUniques(indexes: ConstraintGroup[], uniques: ConstraintGroup[]) {
  const uniqueFields = new Set(uniques.flat());
  const kept: ConstraintGroup[] = [];
  const removed: ConstraintGroup[] = [];
  for (const indexGroup of indexes) {
    if (indexGroup.some((field) => uniqueFields.has(field))) {
      removed.push(indexGroup);
    } else {
      kept.push(indexGroup);
    }
  }
  return { indexes: kept, removed };
}

export function normalizeRelationForTablePatch(relation: AnyRecord): RelationPatch {
  for (const key of FORBIDDEN_RELATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(relation, key)) {
      throw new Error(`Relation schema must not include physical column field "${key}". Use propertyName/targetTable only; Enfyra derives FK and junction columns.`);
    }
  }
  const {
    sourceTable,
    targetTable,
    targetTableId,
    mappedBy,
    fkCol,
    fkColumn,
    foreignKeyColumn,
    sourceColumn,
    targetColumn,
    junctionSourceColumn,
    junctionTargetColumn,
    ...rest
  } = relation;
  const normalized: RelationPatch = { ...rest };
  if (rest.type !== undefined) {
    normalized.type = normalizeRelationType(rest.type);
  }
  if (normalized.type === 'one-to-many' && mappedBy !== undefined && mappedBy !== null && mappedBy !== '') {
    delete normalized.inversePropertyName;
  }
  const resolvedTargetTable =
    targetTableId ??
    (targetTable && typeof targetTable === 'object'
      ? targetTable.id ?? targetTable._id ?? targetTable
      : targetTable);
  if (resolvedTargetTable !== undefined && resolvedTargetTable !== null) {
    normalized.targetTable = resolvedTargetTable;
  }
  if (mappedBy !== undefined && mappedBy !== null && mappedBy !== '') {
    normalized.mappedBy = typeof mappedBy === 'object'
      ? mappedBy.propertyName ?? mappedBy.name ?? mappedBy.id ?? mappedBy._id
      : mappedBy;
  }
  return normalized;
}

export function normalizeRelationType(type: unknown) {
  const raw = String(type ?? '').trim();
  const normalized = RELATION_TYPE_ALIASES[raw] ?? raw;
  if (!VALID_RELATION_TYPES.has(normalized)) {
    throw new Error(
      `Invalid relation type "${raw || '<missing>'}". Use one of many-to-one, one-to-many, one-to-one, or many-to-many. Common aliases such as many_to_one are normalized by the tool.`,
    );
  }
  return normalized;
}

export function assertNoForbiddenRelationKeys(args: AnyRecord) {
  for (const key of FORBIDDEN_RELATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`create_relations must not include physical column field "${key}". Use sourceTableId/targetTableId and relation propertyName only; Enfyra derives FK and junction columns.`);
    }
  }
}

export function sanitizeExistingRelationForTablePatch(relation: AnyRecord): RelationPatch {
  const {
    fkCol,
    fkColumn,
    foreignKeyColumn,
    referencedColumn,
    constraintName,
    sourceColumn,
    targetColumn,
    junctionTableName,
    junctionSourceColumn,
    junctionTargetColumn,
    ...rest
  } = relation;
  return normalizeRelationForTablePatch(rest);
}

export function resolveRelationTargetsFromMetadata(metadata, relations: RelationPatch[]) {
  return relations.map((relation) => {
    const targetTable = relation.targetTable;
    if (typeof targetTable !== 'string' || !targetTable.trim()) return relation;
    const resolvedTable = resolveTableFromMetadataByName(metadata, targetTable);
    if (!resolvedTable) return relation;
    return { ...relation, targetTable: getId(resolvedTable) };
  });
}

export function getId(record: any) {
  return record?.id ?? record?._id ?? null;
}

export function normalizeColumnForTablePatch(column: AnyRecord): ColumnPatch {
  const { table, ...rest } = column;
  return rest;
}

export function parseColumnTypeOptions(options: unknown): string[] {
  if (Array.isArray(options)) return options.map(String);
  if (typeof options !== 'string') return [];
  const trimmed = options.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Some Enfyra enum metadata is stored as {"a","b"} rather than JSON.
  }
  const braceMatch = trimmed.match(/^\{(.+)\}$/);
  if (!braceMatch) return [];
  return braceMatch[1]
    .split(',')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

export function normalizeColumnOptionsValue(options: unknown) {
  if (options === undefined) return undefined;
  return typeof options === 'string' ? JSON.parse(options) : options;
}

export function getSupportedColumnTypesFromMetadata(metadata: AnyRecord): string[] {
  const columnTable = normalizeTablesFromMetadata(metadata).find((table) => table?.name === 'enfyra_column');
  const typeColumn = columnTable?.columns?.find((column) => column?.name === 'type');
  const options = parseColumnTypeOptions(typeColumn?.options);
  return options.length ? options : FALLBACK_COLUMN_TYPES;
}

function chooseFirstSupported(supported: Set<string>, candidates: string[]) {
  return candidates.find((candidate) => supported.has(candidate));
}

export function normalizeColumnTypeForLiveMetadata(type: unknown, supportedTypes: string[] = FALLBACK_COLUMN_TYPES) {
  const raw = String(type ?? '').trim();
  if (!raw) {
    throw new Error(`Column type is required. Valid live types: ${supportedTypes.join(', ')}.`);
  }
  const supported = new Set(supportedTypes);
  if (supported.has(raw)) return { type: raw, changed: false, originalType: raw };

  const normalized = raw.toLowerCase();
  const alias =
    normalized === 'string' || normalized === 'char' || normalized === 'character varying'
      ? chooseFirstSupported(supported, ['varchar', 'text'])
      : normalized === 'integer'
        ? chooseFirstSupported(supported, ['int', 'bigint', 'float'])
        : normalized === 'bool'
          ? chooseFirstSupported(supported, ['boolean'])
          : ['decimal', 'numeric', 'number', 'double', 'money', 'currency'].includes(normalized)
            ? chooseFirstSupported(supported, ['decimal', 'float'])
            : ['longtext', 'mediumtext', 'large-text'].includes(normalized)
              ? chooseFirstSupported(supported, ['text', 'richtext', 'varchar'])
              : ['json', 'jsonb', 'object', 'array'].includes(normalized)
                ? chooseFirstSupported(supported, ['simple-json', 'text'])
                : ['date-time', 'timestamptz'].includes(normalized)
                  ? chooseFirstSupported(supported, ['datetime', 'timestamp'])
                  : null;

  if (!alias) {
    throw new Error(
      `Unsupported column type "${raw}" for this live Enfyra instance. Valid live types: ${supportedTypes.join(', ')}. ` +
      `Guidance: ${COLUMN_TYPE_ALIAS_HINTS.join(' ')}`,
    );
  }

  return { type: alias, changed: true, originalType: raw };
}

export function normalizeColumnsForLiveMetadata(columns: AnyRecord[], supportedTypes: string[]) {
  const normalizations: Array<{ column: string; from: string; to: string }> = [];
  const normalizedColumns = columns.map((column) => {
    const normalized = normalizeColumnTypeForLiveMetadata(column.type, supportedTypes);
    if (!normalized.changed) return column;
    normalizations.push({ column: String(column.name ?? '<unnamed>'), from: normalized.originalType, to: normalized.type });
    return { ...column, type: normalized.type };
  });
  return { columns: normalizedColumns, normalizations };
}
