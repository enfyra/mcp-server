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

type AnyRecord = Record<string, any>;
type ConstraintGroup = string[];

function bulkObjectArrayParam(z, label: string) {
  return z.array(z.record(z.any())).describe(`${label} as a native JSON array of objects. Pass one object in the array for a single mutation.`);
}

type ColumnPatch = AnyRecord & {
  id?: unknown;
  _id?: unknown;
  name?: string;
  type?: string;
  isNullable?: boolean;
  isPrimary?: boolean;
  isGenerated?: boolean;
  isSystem?: boolean;
  isPublished?: boolean;
  isUpdatable?: boolean;
  isEncrypted?: boolean;
  isUnique?: boolean;
  defaultValue?: unknown;
  description?: string;
  options?: unknown;
};

type RelationPatch = AnyRecord & {
  id?: unknown;
  _id?: unknown;
  targetTable?: unknown;
  type?: string;
  propertyName?: string;
  inversePropertyName?: string | null;
  mappedBy?: unknown;
  isNullable?: boolean;
  onDelete?: string;
  description?: string;
};

type CascadeVerifyOptions = {
  action: 'create' | 'update' | 'delete';
  columnId?: unknown;
  columnName?: string;
  relationId?: unknown;
  propertyName?: string;
};

let schemaQueue: Promise<unknown> = Promise.resolve();

function withSchemaQueue<T>(operation: () => Promise<T> | T): Promise<T> {
  const run = schemaQueue.then(operation, operation);
  schemaQueue = run.catch(() => {});
  return run;
}

const FORBIDDEN_RELATION_KEYS = [
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

const FALLBACK_COLUMN_TYPES = [
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

const RELATION_TYPE_ALIASES: Record<string, string> = {
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

const VALID_RELATION_TYPES = new Set(['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many']);

const AUTO_MANAGED_COLUMN_NAMES = new Set(['id', '_id', 'createdAt', 'updatedAt']);

export function buildPrimaryColumnForDbType(dbType: string | null | undefined): ColumnPatch {
  return dbType === 'mongodb'
    ? { name: '_id', type: 'ObjectId', isPrimary: true, isGenerated: true, isNullable: false }
    : { name: 'id', type: 'int', isPrimary: true, isGenerated: true, isNullable: false };
}

const COLUMN_TYPE_ALIAS_HINTS = [
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
async function patchTableAutoConfirm(ENFYRA_API_URL, tableId, body) {
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

function parseJsonArrayParam(name, value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array.`);
  }
  return parsed;
}

function parseBulkItemsParam(name, value) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${name} must be a native JSON array. Pass one object in the array for a single mutation.`);
  }
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array. Pass one object in the array for a single mutation.`);
  }
  if (parsed.length === 0) {
    throw new Error(`${name} must include at least one item.`);
  }
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${name}[${index}] must be an object.`);
    }
  });
  return parsed;
}

function assertBulkLimit(name, items, maxItems) {
  if (items.length > maxItems) {
    throw new Error(`${name} received ${items.length} items, above maxItems=${maxItems}. Split the batch deliberately.`);
  }
}

function normalizeConstraintGroups(name, groups) {
  return groups.map((group, index) => {
    const value = Array.isArray(group) ? group : group?.value;
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error(`${name}[${index}] must be a non-empty string array or { "value": [...] }.`);
    }
    return value;
  });
}

function parseConstraintGroupsParam(name, value) {
  return normalizeConstraintGroups(name, parseJsonArrayParam(name, value));
}

function normalizeConstraintGroupsValue(name, value): ConstraintGroup[] {
  if (value == null) return [];
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array.`);
  }
  return normalizeConstraintGroups(name, parsed);
}

function stripAutoManagedColumns(columns: AnyRecord[]) {
  const skippedAutoColumns: Array<{ name: string; reason: string }> = [];
  const filtered = columns.filter((column) => {
    const name = String(column?.name ?? '');
    if (!AUTO_MANAGED_COLUMN_NAMES.has(name)) return true;
    skippedAutoColumns.push({
      name,
      reason: 'Enfyra manages id/createdAt/updatedAt automatically during table creation.',
    });
    return false;
  });
  return { columns: filtered, skippedAutoColumns };
}

function assertColumnNameCanBeCreated(name: unknown, context: string) {
  const columnName = String(name ?? '');
  if (AUTO_MANAGED_COLUMN_NAMES.has(columnName)) {
    throw new Error(`${context} "${columnName}" is auto-managed by Enfyra. Do not create id, _id, createdAt, or updatedAt columns manually.`);
  }
}

function assertNoDuplicateFieldNames(fieldNames: string[], context: string) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of fieldNames.filter(Boolean)) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  if (duplicates.size > 0) {
    throw new Error(`${context} has duplicate field name(s): ${[...duplicates].join(', ')}. Column names and relation propertyName values share one namespace.`);
  }
}

function assertNoColumnRelationNameCollision(columnNames: string[], relationNames: string[], context: string) {
  const relationNameSet = new Set(relationNames.filter(Boolean));
  const collisions = columnNames.filter((name) => relationNameSet.has(name));
  if (collisions.length > 0) {
    throw new Error(
      `${context} has column/relation namespace collision(s): ${[...new Set(collisions)].join(', ')}. ` +
      `Column names and relation propertyName values share one namespace; remove the scalar column(s) and keep the relation propertyName(s) ${[...new Set(collisions)].join(', ')}. Do not create physical FK columns.`,
    );
  }
  assertNoDuplicateFieldNames([...columnNames, ...relationNames], context);
}

function formatConstraintFieldHints(fields: string[], relationNames: string[], logicalFieldNames: string[]) {
  const relationNameSet = new Set(relationNames);
  const logicalNameSet = new Set(logicalFieldNames);
  const normalizeName = (value: string) => value.replace(/[_\-\s]/gu, '').toLowerCase();
  return fields
    .map((field) => {
      const normalized = String(field)
        .replace(/_?ids?$/iu, '')
        .replace(/_id$/iu, '')
        .replace(/Id$/u, '')
        .replace(/Ids$/u, '');
      const match = [...relationNameSet].find((name) => name.toLowerCase() === normalized.toLowerCase());
      if (match) return `${field} -> use relation propertyName "${match}" in indexes/uniques, not physical FK "${field}"`;
      const logicalMatch = [...logicalNameSet].find((name) => normalizeName(name) === normalizeName(String(field)));
      return logicalMatch ? `${field} -> did you mean "${logicalMatch}"? Constraint fields must match column/relation names exactly.` : null;
    })
    .filter(Boolean);
}

function preflightCreateTableDefinitions(items: AnyRecord[]) {
  items.forEach((item, index) => {
    const columns = Array.isArray(item.columns) ? item.columns : parseJsonArrayParam(`items[${index}].columns`, item.columns || '[]');
    const relations = Array.isArray(item.relations) ? item.relations : parseJsonArrayParam(`items[${index}].relations`, item.relations || '[]');
    const { columns: userColumns } = stripAutoManagedColumns(columns);
    const columnNames = userColumns.map((column) => String(column?.name ?? '')).filter(Boolean);
    const relationNames = relations.map((relation) => String(relation?.propertyName ?? '')).filter(Boolean);
    assertNoColumnRelationNameCollision(columnNames, relationNames, `create_tables items[${index}] (${item.name || '<unnamed>'})`);

    const logicalFields = new Set([...AUTO_MANAGED_COLUMN_NAMES, ...columnNames, ...relationNames]);
    const indexes = normalizeConstraintGroupsValue(`items[${index}].indexes`, item.indexes ?? []);
    const uniques = normalizeConstraintGroupsValue(`items[${index}].uniques`, item.uniques ?? []);
    assertIndexesDoNotReferenceUniqueFields(indexes, uniques);
    const unknownConstraintFields = [...indexes, ...uniques]
      .flat()
      .filter((field) => !logicalFields.has(field));
    if (unknownConstraintFields.length > 0) {
      const uniqueUnknownFields = [...new Set(unknownConstraintFields)];
      const hints = formatConstraintFieldHints(uniqueUnknownFields, relationNames, [...logicalFields]);
      throw new Error(
        `create_tables items[${index}] (${item.name || '<unnamed>'}) has indexes/uniques referencing undeclared field(s): ${uniqueUnknownFields.join(', ')}. ` +
        'Declare each field as a column or relation propertyName in the same table item. ' +
        (hints.length ? `Hint(s): ${hints.join('; ')}. ` : '') +
        'For relation-based unique pairs added after create, first create the relations, then call update_tables with the unique group.',
      );
    }
  });
}

function relationTargetName(relation: AnyRecord) {
  const target = relation?.targetTable ?? relation?.targetTableId;
  if (target && typeof target === 'object') return target.name ?? target.alias ?? target.id ?? target._id;
  return target;
}

export function computeBatchCleanupOrder(items: AnyRecord[]) {
  const tableNames = items.map((item) => String(item?.name || '')).filter(Boolean);
  const tableSet = new Set(tableNames);
  const edges: Array<[string, string]> = [];
  for (const item of items) {
    const source = String(item?.name || '');
    if (!source) continue;
    const relations = Array.isArray(item.relations) ? item.relations : parseJsonArrayParam(`${source}.relations`, item.relations || '[]');
    for (const relation of relations) {
      const target = String(relationTargetName(relation) || '');
      if (target && tableSet.has(target) && target !== source) edges.push([source, target]);
    }
  }
  const remaining = new Set(tableNames);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const leaves = [...remaining]
      .filter((name) => !edges.some(([source, target]) => target === name && remaining.has(source) && remaining.has(target)))
      .sort();
    const batch = leaves.length ? leaves : [[...remaining].sort()[0]];
    for (const name of batch) {
      remaining.delete(name);
      ordered.push(name);
    }
  }
  return ordered;
}

function splitRelationConstraintGroups(groups: ConstraintGroup[], relationNames: Set<string>) {
  const immediate: ConstraintGroup[] = [];
  const deferred: ConstraintGroup[] = [];
  for (const group of groups) {
    if (group.some((field) => relationNames.has(field))) deferred.push(group);
    else immediate.push(group);
  }
  return { immediate, deferred };
}

function mergeConstraintGroups(existing: ConstraintGroup[], additions: ConstraintGroup[]) {
  const seen = new Set(existing.map((group) => JSON.stringify(group)));
  const merged = [...existing];
  for (const group of additions) {
    const key = JSON.stringify(group);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(group);
    }
  }
  return merged;
}

function resolveRelationConstraintGroups(table: AnyRecord, groups: ConstraintGroup[], groupName: string) {
  const relationByProperty = new Map<string, AnyRecord>((table.relations || [])
    .filter((relation) => relation?.propertyName)
    .map((relation) => [relation.propertyName, relation]));
  return groups.map((group) => group.map((field) => {
    const relation = relationByProperty.get(field);
    if (!relation) return field;
    const physicalColumn = relation.foreignKeyColumn || relation.fkColumn || relation.fkCol;
    if (!physicalColumn) {
      throw new Error(
        `${groupName} uses relation propertyName "${field}", but the created relation did not expose a physical FK column for indexing. ` +
        'This usually means the relation is not a direct many-to-one/one-to-one relation. Keep relation indexes/uniques only on direct owning relations.',
      );
    }
    return physicalColumn;
  }));
}

export function assertIndexesDoNotReferenceUniqueFields(indexes: ConstraintGroup[], uniques: ConstraintGroup[]) {
  const conflicts = indexes
    .map((indexGroup) => ({
      indexGroup,
      uniqueGroups: uniques
        .map((uniqueGroup) => ({
          uniqueGroup,
          overlappingFields: indexGroup.filter((field) => uniqueGroup.includes(field)),
        }))
        .filter((conflict) => conflict.overlappingFields.length > 0),
    }))
    .filter((conflict) => conflict.uniqueGroups.length > 0);
  if (conflicts.length > 0) {
    const groups = conflicts
      .map((conflict) => `${JSON.stringify(conflict.indexGroup)} overlaps unique group(s) ${conflict.uniqueGroups.map((item) => `${JSON.stringify(item.uniqueGroup)} via ${JSON.stringify(item.overlappingFields)}`).join(', ')}`)
      .join('; ');
    throw new Error(
      `Invalid schema constraints: indexes must not include fields that appear in uniques, including composite unique groups. Conflict(s): ${groups}. Unique constraints already create indexed lookups for their fields; remove those fields from indexes and keep them only in uniques.`,
    );
  }
}

function pruneIndexesThatOverlapUniques(indexes: ConstraintGroup[], uniques: ConstraintGroup[]) {
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

function assertNoForbiddenRelationKeys(args: AnyRecord) {
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

function getId(record: any) {
  return record?.id ?? record?._id ?? null;
}

function normalizeColumnForTablePatch(column: AnyRecord): ColumnPatch {
  const { table, ...rest } = column;
  return rest;
}

function parseColumnTypeOptions(options: unknown): string[] {
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

function normalizeColumnOptionsValue(options: unknown) {
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

function findMetadataTable(metadata: AnyRecord, tableName: string) {
  return normalizeTablesFromMetadata(metadata).find((table) => table?.name === tableName) || null;
}

function metadataColumnNames(metadata: AnyRecord, tableName: string) {
  return (findMetadataTable(metadata, tableName)?.columns || [])
    .map((column) => column?.name)
    .filter(Boolean);
}

function metadataColumnOptions(metadata: AnyRecord, tableName: string, columnName: string) {
  const column = (findMetadataTable(metadata, tableName)?.columns || [])
    .find((item) => item?.name === columnName);
  return parseColumnTypeOptions(column?.options);
}

function summarizeCreatedTableSchema(table: AnyRecord | null, fallbackName: string) {
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

function getPatchableColumns(columns: AnyRecord[] = []): ColumnPatch[] {
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

async function verifyColumnCascade(ENFYRA_API_URL, tableId, beforeIds, {
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

async function verifyRelationCascade(ENFYRA_API_URL, tableId, beforeIds, {
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

/**
 * Register table tools with MCP server
 */
export function registerTableTools(server, ENFYRA_API_URL) {
  const apiBase = ENFYRA_API_URL.replace(/\/$/, '');

  async function appendColumnToTable(args) {
    assertGlobalRulesAck(args.globalRulesAckKey);
    return withSchemaQueue(async () => {
    const [tableData, columnMetadata] = await Promise.all([
      fetchTableWithDetails(ENFYRA_API_URL, args.tableId),
      fetchTableMetadata(ENFYRA_API_URL, 'enfyra_column'),
    ]);
    if (!tableData) {
      throw new Error(`Table with ID ${args.tableId} not found.`);
    }
    const supportedTypes = getSupportedColumnTypesFromMetadata(columnMetadata);
    const normalized = normalizeColumnTypeForLiveMetadata(args.type, supportedTypes);
    assertColumnNameCanBeCreated(args.name, 'create_columns');

    const existingColumns = getPatchableColumns(tableData.columns);
    const beforeIds = existingColumns.map((column) => String(getId(column)));
    const newCol = buildColumnDefinition({ ...args, supportedTypes });
    const result = await patchTableAutoConfirm(ENFYRA_API_URL, args.tableId, { columns: [...existingColumns, newCol] });
    await verifyColumnCascade(ENFYRA_API_URL, args.tableId, beforeIds, {
      action: 'create',
      columnName: args.name,
    });

    return jsonContent({
      action: 'column_created',
      tableId: args.tableId,
      columnName: args.name,
      schemaNormalization: normalized.changed ? [{ column: args.name, from: normalized.originalType, to: normalized.type }] : [],
      supportedColumnTypes: supportedTypes,
      result,
    });
    });
  }

  async function appendRelationToTable(args) {
    assertGlobalRulesAck(args.globalRulesAckKey);
    return withSchemaQueue(async () => {
    assertNoForbiddenRelationKeys(args);
	    const { sourceTableId, targetTableId, targetTable } = args;
	    const relationPatch = normalizeRelationForTablePatch(args);
	    const { type, propertyName, inversePropertyName, mappedBy, isNullable, onDelete, description } = relationPatch;
    const targetRef = targetTableId ?? targetTable;
    if (targetRef === undefined || targetRef === null || targetRef === '') {
      throw new Error('create_relations requires targetTableId or targetTable. Pass an existing table id, name, or alias.');
    }
    const catalog = await fetchTableCatalog(ENFYRA_API_URL);
    const resolvedSourceTableId = resolveTableIdentifierFromMetadata(catalog, sourceTableId, 'sourceTableId');
    const resolvedTargetTableId = resolveTableIdentifierFromMetadata(catalog, targetRef, 'targetTableId');
    const tableData = await fetchTableWithDetails(ENFYRA_API_URL, resolvedSourceTableId);
    if (!tableData) {
      throw new Error(`Table ${sourceTableId} not found.`);
    }
    const existingRelations = (tableData.relations || []).map(sanitizeExistingRelationForTablePatch);
    const beforeIds = existingRelations.map((relation) => String(getId(relation))).filter((id) => id !== 'null');
	    const newRelation: RelationPatch = { targetTable: resolvedTargetTableId, type, propertyName };
    if (inversePropertyName !== undefined) newRelation.inversePropertyName = inversePropertyName || null;
    if (mappedBy !== undefined) newRelation.mappedBy = mappedBy;
    if (isNullable !== undefined) newRelation.isNullable = isNullable;
    if (onDelete !== undefined) newRelation.onDelete = onDelete;
    if (description !== undefined) newRelation.description = description;
    const result = await patchTableAutoConfirm(ENFYRA_API_URL, resolvedSourceTableId, { relations: [...existingRelations, newRelation] });
    await verifyRelationCascade(ENFYRA_API_URL, resolvedSourceTableId, beforeIds, {
      action: 'create',
      propertyName,
    });
    return jsonContent({
      action: 'relation_created',
      relation: { propertyName, type, sourceTableId: resolvedSourceTableId, targetTableId: resolvedTargetTableId },
      result,
    });
    });
  }

  async function removeColumnFromTable({ tableId, columnId, confirm, globalRulesAckKey }) {
    return withSchemaQueue(async () => {
    const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
    if (!tableData) {
      throw new Error(`Table with ID ${tableId} not found.`);
    }

    const existingColumns = getPatchableColumns(tableData.columns);
    const beforeIds = existingColumns.map((column) => String(getId(column)));
    if (!beforeIds.includes(String(columnId))) {
      throw new Error(`Column ${columnId} was not found on table ${tableId}; refusing schema cascade patch.`);
    }
    if (!confirm) {
      const target = existingColumns.find((column) => String(getId(column)) === String(columnId));
      return {
        content: [{ type: 'text', text: JSON.stringify({
          action: 'delete_column_preview',
          tableId,
          columnId,
          targetColumn: target,
          preservedColumnIds: beforeIds.filter((id) => id !== String(columnId)),
          destructive: true,
          next: 'Call delete_columns again with the same one-item array and confirm=true to drop the physical column and metadata.',
        }, null, 2) }],
      };
    }
    assertGlobalRulesAck(globalRulesAckKey);

    const columns = existingColumns
      .filter(col => String(getId(col)) !== String(columnId))

    const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { columns });
    await verifyColumnCascade(ENFYRA_API_URL, tableId, beforeIds, {
      action: 'delete',
      columnId,
    });

    return jsonContent({
      action: 'column_deleted',
      tableId,
      columnId,
      result,
    });
    });
  }

  async function removeRelationFromTable({ tableId, relationId, confirm, globalRulesAckKey }) {
    return withSchemaQueue(async () => {
    const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
    if (!tableData) {
      throw new Error(`Table with ID ${tableId} not found.`);
    }

    const existingRelations = (tableData.relations || []).map(sanitizeExistingRelationForTablePatch);
    const beforeIds = existingRelations.map((relation) => String(getId(relation))).filter((id) => id !== 'null');
    if (!beforeIds.includes(String(relationId))) {
      throw new Error(`Relation ${relationId} was not found on table ${tableId}; refusing schema cascade patch.`);
    }
    if (!confirm) {
      const target = existingRelations.find((relation) => String(getId(relation)) === String(relationId));
      return {
        content: [{ type: 'text', text: JSON.stringify({
          action: 'delete_relation_preview',
          tableId,
          relationId,
          targetRelation: target,
          preservedRelationIds: beforeIds.filter((id) => id !== String(relationId)),
          destructive: true,
          next: 'Call delete_relations again with the same one-item array and confirm=true to drop relation metadata and any derived FK/junction structures.',
        }, null, 2) }],
      };
    }
    assertGlobalRulesAck(globalRulesAckKey);

    const relations = existingRelations
      .filter(rel => String(getId(rel)) !== String(relationId))

    const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { relations });
    await verifyRelationCascade(ENFYRA_API_URL, tableId, beforeIds, {
      action: 'delete',
      relationId,
    });

    return jsonContent({
      action: 'relation_deleted',
      tableId,
      relationId,
      result,
    });
    });
  }

  const columnCreateSchema = {
    tableId: z.string().describe('Table definition ID (from get_all_tables or create_tables).'),
    name: z.string().describe('Column name (e.g., "title", "webhook_secret"). Lowercase with underscores. Do not create id, _id, createdAt, or updatedAt; Enfyra manages them automatically.'),
    type: z.string().describe('Column type from the live enfyra_column.type enum. Common valid types are int, varchar, text, boolean, uuid, ObjectId, bigint, date, datetime, timestamp, enum, simple-json, code, array-select, richtext, and float. The tool normalizes common aliases before sending: decimal/numeric/money/number -> float when decimal is not live-supported, longtext -> text, json/jsonb/object/array -> simple-json when live-supported, string -> varchar. Prefer relations instead of *_id columns.'),
    isNullable: z.boolean().optional().default(true).describe('Set to false if column cannot be null.'),
    isUnique: z.boolean().optional().default(false).describe('Set to true for unique constraint.'),
    isPublished: z.boolean().optional().describe('Set column visibility baseline. Use false for secrets and internal fields.'),
    isUpdatable: z.boolean().optional().describe('Set false for immutable fields that cannot be updated after creation. Independent from isEncrypted.'),
    isEncrypted: z.boolean().optional().describe('Set true to encrypt this column at the Enfyra database-query layer. This does not change isUpdatable. Encrypted fields cannot be filtered or sorted.'),
    isPrimary: z.boolean().optional().describe('Set true only for primary key columns; normally only create_tables auto id uses this.'),
    isGenerated: z.boolean().optional().describe('Set true only for generated columns such as auto id.'),
    isSystem: z.boolean().optional().describe('Set true only for system-managed columns. Avoid for normal app fields.'),
    defaultValue: z.string().optional().describe('Default value as JSON string or backend-supported literal.'),
    description: z.string().optional().describe('Column description.'),
    options: z.union([z.array(z.string()), z.string()]).optional().describe('Column options as a native array such as ["draft","published"] or a JSON string for older clients.'),
    globalRulesAckKey: globalRulesAckParam(z),
  };

  const relationCreateSchema = {
    sourceTableId: z.string().describe('Source table id, exact table name, or alias. For many-to-one, this is the table that owns the relation property.'),
    targetTableId: z.string().optional().describe('Target table id, exact table name, or alias. MCP resolves names/aliases to ids before mutation. Optional when targetTable is provided.'),
    targetTable: z.string().optional().describe('Alias for targetTableId when naturally using a target table name/alias such as enfyra_user. Optional when targetTableId is provided.'),
      type: z.string().describe('Relation type. Use many-to-one, one-to-many, one-to-one, or many-to-many. Common aliases such as many_to_one are normalized by the tool.'),
    propertyName: z.string().describe('Property name on source table (e.g., "customer", "items").'),
    inversePropertyName: z.string().optional().describe('Property name on target table for bidirectional relation (e.g., "orders"). Omit unless a concrete response, UI, deep query, aggregate sort/count, or parent-to-child traversal will use the reverse field. Do not add inverses merely because a parent table exists.'),
    mappedBy: z.string().optional().describe('Mapped-by property for inverse relation shapes when required by the backend. Do not use physical FK names.'),
    isNullable: z.boolean().optional().default(true).describe('Whether the relation is nullable.'),
    onDelete: z.enum(['CASCADE', 'SET NULL', 'RESTRICT']).optional().default('SET NULL').describe('On delete behavior.'),
    description: z.string().optional().describe('Relation description.'),
    fkCol: z.never().optional().describe('Forbidden. Use propertyName only; Enfyra derives FK columns.'),
    fkColumn: z.never().optional().describe('Forbidden. Use propertyName only; Enfyra derives FK columns.'),
    foreignKeyColumn: z.never().optional().describe('Forbidden. Use propertyName only; Enfyra derives FK columns.'),
    sourceColumn: z.never().optional().describe('Forbidden. Use propertyName only; Enfyra derives FK columns.'),
    targetColumn: z.never().optional().describe('Forbidden. Use propertyName only; Enfyra derives FK columns.'),
    junctionSourceColumn: z.never().optional().describe('Forbidden. Use relation property names only; Enfyra derives junction columns.'),
    junctionTargetColumn: z.never().optional().describe('Forbidden. Use relation property names only; Enfyra derives junction columns.'),
    globalRulesAckKey: globalRulesAckParam(z),
  };

  const columnDeleteSchema = {
    tableId: z.string().describe('Table definition ID.'),
    columnId: z.string().describe('Column definition ID to delete.'),
    confirm: z.boolean().optional().default(false).describe('Required true to apply the destructive delete. Omit/false returns a preview only.'),
    globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
  };

  const relationDeleteSchema = {
    tableId: z.string().describe('Table definition ID (source table of the relation).'),
    relationId: z.string().describe('Relation definition ID to delete.'),
    confirm: z.boolean().optional().default(false).describe('Required true to apply the destructive delete. Omit/false returns a preview only.'),
    globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
  };

  function arrayValue(name, value) {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value : parseJsonArrayParam(name, value);
  }

	  async function createOneTable(args) {
    const userColumns = arrayValue('columns', args.columns);
	    const [metadataContext, columnMetadata] = await Promise.all([
      fetchMetadataContext(ENFYRA_API_URL),
      fetchTableMetadata(ENFYRA_API_URL, 'enfyra_column'),
    ]);
	    const supportedTypes = getSupportedColumnTypesFromMetadata(columnMetadata);
    const idColumn = buildPrimaryColumnForDbType(metadataContext.dbType);
	    const { columns: userColumnsWithoutAuto, skippedAutoColumns } = stripAutoManagedColumns(userColumns);
	    const { columns: normalizedUserColumns, normalizations } = normalizeColumnsForLiveMetadata(userColumnsWithoutAuto, supportedTypes);
	    const deferredRelations = arrayValue('relations', args.relations).map(normalizeRelationForTablePatch);
	    const relationNames = new Set(deferredRelations.map((relation) => relation.propertyName).filter(Boolean));
	    assertNoColumnRelationNameCollision(
	      normalizedUserColumns.map((column) => String(column.name || '')).filter(Boolean),
	      deferredRelations.map((relation) => String(relation.propertyName || '')).filter(Boolean),
	      `create_tables item "${args.name}"`,
	    );
	    const indexes = normalizeConstraintGroupsValue('indexes', args.indexes ?? []);
	    const uniques = normalizeConstraintGroupsValue('uniques', args.uniques ?? []);
	    assertIndexesDoNotReferenceUniqueFields(indexes, uniques);
	    const splitIndexes = splitRelationConstraintGroups(indexes, relationNames);
	    const splitUniques = splitRelationConstraintGroups(uniques, relationNames);
	    const body: AnyRecord = { name: args.name, description: args.description, columns: [idColumn, ...normalizedUserColumns], relations: [] };
	    if (args.isSingleRecord !== undefined) body.isSingleRecord = args.isSingleRecord;
	    if (args.indexes !== undefined) body.indexes = splitIndexes.immediate;
	    if (args.uniques !== undefined) body.uniques = splitUniques.immediate;
    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_table', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const createdTable = Array.isArray(result?.data) ? result.data[0] : result;
    const createdTableId = createdTable?.id ?? createdTable?._id;
    const liveMetadataAfterCreate = await fetchAPI(ENFYRA_API_URL, `/metadata/${encodeURIComponent(args.name)}`)
      .catch((error: any) => ({ error: error?.message || String(error) }));
    const liveTableAfterCreate = liveMetadataAfterCreate?.error
      ? null
      : liveMetadataAfterCreate?.data?.table || liveMetadataAfterCreate?.data || liveMetadataAfterCreate?.table || liveMetadataAfterCreate;
    const liveSchema = summarizeCreatedTableSchema(liveTableAfterCreate, args.name);
	    const routePath = `/${args.name}`;
	    return {
      action: 'table_created',
      table: { id: createdTableId, name: args.name, routePath },
      summary: {
        columnCount: normalizedUserColumns.length + 1,
        createdColumnCount: normalizedUserColumns.length,
        deferredRelationCount: deferredRelations.length,
	        indexGroupCount: indexes.length,
	        uniqueGroupCount: uniques.length,
	        deferredConstraintCount: splitIndexes.deferred.length + splitUniques.deferred.length,
	      },
      schemaNormalization: normalizations,
      skippedAutoColumns,
      schema: {
        intended: {
          tableName: args.name,
          primaryKey: idColumn.name,
          fields: [idColumn.name, ...normalizedUserColumns.map((column) => column.name), ...deferredRelations.map((relation) => relation.propertyName)].filter(Boolean).sort(),
          columns: [idColumn.name, ...normalizedUserColumns.map((column) => column.name)].filter(Boolean),
          relations: deferredRelations.map((relation) => relation.propertyName).filter(Boolean),
        },
        live: liveSchema,
        liveMetadataAvailable: Boolean(liveSchema),
        liveMetadataError: liveMetadataAfterCreate?.error || undefined,
      },
      supportedColumnTypes: supportedTypes,
      rest: {
        base: apiBase,
        routePath,
        operations: ['GET /<table>', 'POST /<table>', 'PATCH /<table>/:id', 'DELETE /<table>/:id'],
        noGetById: true,
      },
	      deferredRelations,
	      deferredConstraints: {
	        indexes: splitIndexes.deferred,
	        uniques: splitUniques.deferred,
	      },
	      result,
	    };
	  }

	  async function applyDeferredConstraints(tableId, deferredConstraints) {
	    const deferredIndexes = deferredConstraints?.indexes || [];
	    const deferredUniques = deferredConstraints?.uniques || [];
	    if (deferredIndexes.length === 0 && deferredUniques.length === 0) return null;
	    const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
	    const mappedIndexes = resolveRelationConstraintGroups(tableData, deferredIndexes, 'indexes');
	    const mappedUniques = resolveRelationConstraintGroups(tableData, deferredUniques, 'uniques');
	    const existingIndexes = normalizeConstraintGroupsValue('indexes', tableData.indexes || []);
	    const existingUniques = normalizeConstraintGroupsValue('uniques', tableData.uniques || []);
	    const uniques = mergeConstraintGroups(existingUniques, mappedUniques);
	    const prunedExistingIndexes = pruneIndexesThatOverlapUniques(existingIndexes, uniques);
	    const indexes = mergeConstraintGroups(prunedExistingIndexes.indexes, mappedIndexes);
	    assertIndexesDoNotReferenceUniqueFields(indexes, uniques);
	    const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { indexes, uniques });
	    return {
	      action: 'deferred_constraints_applied',
	      tableId,
	      tableName: tableData.name,
	      requested: {
	        indexes: deferredIndexes,
	        uniques: deferredUniques,
	      },
	      applied: {
	        indexes: mappedIndexes,
	        uniques: mappedUniques,
	      },
	      prunedExistingIndexes: prunedExistingIndexes.removed,
	      result,
	    };
	  }

	  async function updateOneTable(args) {
    const body: AnyRecord = {};
    let schemaConstraintNormalization: AnyRecord | undefined;
    if (args.name !== undefined) body.name = args.name;
    if (args.alias !== undefined) body.alias = args.alias;
    if (args.description !== undefined) body.description = args.description;
    if (args.isSingleRecord !== undefined) body.isSingleRecord = args.isSingleRecord;
    if (args.graphqlEnabled !== undefined) body.graphqlEnabled = args.graphqlEnabled;
    if (args.indexes !== undefined) body.indexes = normalizeConstraintGroupsValue('indexes', args.indexes);
    if (args.uniques !== undefined) body.uniques = normalizeConstraintGroupsValue('uniques', args.uniques);

    if (args.indexes !== undefined || args.uniques !== undefined) {
      let indexes = body.indexes;
      let uniques = body.uniques;
      if (indexes === undefined || uniques === undefined) {
        const existing = await fetchTableWithDetails(ENFYRA_API_URL, args.tableId);
        if (indexes === undefined) indexes = normalizeConstraintGroupsValue('indexes', existing.indexes);
        if (uniques === undefined) uniques = normalizeConstraintGroupsValue('uniques', existing.uniques);
      }
      if (args.uniques !== undefined && args.indexes === undefined) {
        const prunedExistingIndexes = pruneIndexesThatOverlapUniques(indexes ?? [], uniques ?? []);
        indexes = prunedExistingIndexes.indexes;
        body.indexes = indexes;
        schemaConstraintNormalization = {
          prunedExistingIndexes: prunedExistingIndexes.removed,
          reason: 'Unique constraints already provide indexed lookups; MCP removed existing non-unique indexes that used fields now covered by uniques.',
        };
      }
      assertIndexesDoNotReferenceUniqueFields(indexes ?? [], uniques ?? []);
    }

    const result = await patchTableAutoConfirm(ENFYRA_API_URL, args.tableId, body);
    return {
      action: 'table_updated',
      tableId: args.tableId,
      schemaConstraintNormalization,
      result,
    };
  }

  async function deleteOneTable({ tableId, tableName, confirm }) {
    const resolvedTableId = tableId ?? resolveTableIdentifierFromMetadata(await fetchTableCatalog(ENFYRA_API_URL), tableName, 'delete_tables item tableName');
    const tableData = await fetchTableWithDetails(ENFYRA_API_URL, resolvedTableId);
    if (!confirm) {
      return {
        action: 'delete_table_preview',
        tableId: resolvedTableId,
        tableName: tableData.name,
        columnCount: (tableData.columns || []).length,
        relationCount: (tableData.relations || []).length,
        destructive: true,
      };
    }
    const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_table/${resolvedTableId}`, {
      method: 'DELETE',
    });
    return {
      action: 'table_deleted',
      tableId: resolvedTableId,
      tableName: tableData.name,
      result,
    };
  }

  async function updateOneColumn({ tableId, columnId, name, type, isNullable, isPublished, isUpdatable, defaultValue, description, options }) {
    const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
    if (!tableData) {
      throw new Error(`Table with ID ${tableId} not found.`);
    }

    const existingColumns = getPatchableColumns(tableData.columns);
    const beforeIds = existingColumns.map((column) => String(getId(column)));
    if (!beforeIds.includes(String(columnId))) {
      throw new Error(`Column ${columnId} was not found on table ${tableId}; refusing schema cascade patch.`);
    }

    const columns = existingColumns.map(col => {
      const rest = normalizeColumnForTablePatch(col);
      if (String(getId(col)) === String(columnId)) {
        if (name !== undefined) rest.name = name;
        if (type !== undefined) rest.type = type;
        if (isNullable !== undefined) rest.isNullable = isNullable;
        if (isPublished !== undefined) rest.isPublished = isPublished;
        if (isUpdatable !== undefined) rest.isUpdatable = isUpdatable;
        if (defaultValue !== undefined) rest.defaultValue = defaultValue;
        if (description !== undefined) rest.description = description;
        if (options !== undefined) rest.options = normalizeColumnOptionsValue(options);
      }
      return rest;
    });

    const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { columns });
    await verifyColumnCascade(ENFYRA_API_URL, tableId, beforeIds, {
      action: 'update',
      columnId,
    });

    return {
      action: 'column_updated',
      tableId,
      columnId,
      result,
    };
  }

  // ─── READ ───

  server.tool(
    'get_all_tables',
    'List table definitions from metadata. Complete lists must pass either limit or all=true. If search is provided without limit, the tool returns a bounded lookup window of 10 matches.',
    {
      limit: z.number().int().positive().optional().describe('Maximum tables returned after search. Required unless all=true or search is provided.'),
      all: z.boolean().optional().describe('Return all matched tables. Use this when a complete table list is required.'),
      search: z.string().optional().describe('Optional table name, alias, or description substring filter.'),
    },
    async ({ limit, all, search }) => {
      if (!all && limit === undefined && !search?.trim()) {
        throw new Error('get_all_tables requires either limit or all=true. Do not invent arbitrary limits for complete table lists; use all=true.');
      }
      if (all && limit !== undefined) {
        throw new Error('get_all_tables accepts either all=true or limit, not both.');
      }
      const catalog = await fetchTableCatalog(ENFYRA_API_URL);
      const needle = search?.trim().toLowerCase();
      const tables = catalog
        .map((table) => ({
          id: getId(table),
          name: table.name ?? null,
          alias: table.alias ?? null,
          description: table.description ?? null,
          isSingleRecord: table.isSingleRecord ?? null,
          columnCount: null,
          relationCount: null,
          routeBacked: null,
        }))
        .filter((table) => {
          if (!needle) return true;
          return [table.name, table.alias, table.description]
            .some((value) => String(value || '').toLowerCase().includes(needle));
        });
      const effectiveLimit = all ? tables.length : (limit ?? 10);
      const returnedTables = all ? tables : tables.slice(0, effectiveLimit);
      return jsonContent({
        action: 'get_all_tables',
        totalTableCount: catalog.length,
        matchedTableCount: tables.length,
        returnedTableCount: returnedTables.length,
	        all: Boolean(all),
	        implicitSearchLimit: Boolean(!all && limit === undefined && search?.trim()),
	        hardCap: all ? null : effectiveLimit,
        search: search || null,
        tables: returnedTables,
        detailHint: 'Use inspect_table with a table id/name for columns, relations, indexes, routes, permissions, and GraphQL state.',
      });
    }
  );

  server.tool(
    'get_schema_design_context',
    [
      'Step-zero schema design guide for Enfyra table creation.',
      'Call this before creating a new app schema or multiple tables.',
      'It returns live column types, supported metadata attributes, relation types, constraint shape, and the exact creation sequence so the model does not guess SQL types or physical FK fields.',
    ].join(' '),
    {},
    async () => {
      const [metadataContext, tableMetadata, columnMetadata, relationMetadata] = await Promise.all([
        fetchMetadataContext(ENFYRA_API_URL),
        fetchTableMetadata(ENFYRA_API_URL, 'enfyra_table'),
        fetchTableMetadata(ENFYRA_API_URL, 'enfyra_column'),
        fetchTableMetadata(ENFYRA_API_URL, 'enfyra_relation'),
      ]);
      const liveColumnTypes = getSupportedColumnTypesFromMetadata(columnMetadata);
      const relationTypes = metadataColumnOptions(relationMetadata, 'enfyra_relation', 'type');
      const onDeleteOptions = metadataColumnOptions(relationMetadata, 'enfyra_relation', 'onDelete');
      const tableAttributes = metadataColumnNames(tableMetadata, 'enfyra_table');
      const columnAttributes = metadataColumnNames(columnMetadata, 'enfyra_column');
      const relationAttributes = metadataColumnNames(relationMetadata, 'enfyra_relation');
      const primaryColumnNames = [metadataContext.dbType === 'mongodb' ? '_id' : 'id'];
      const primaryColumnTypes = [metadataContext.dbType === 'mongodb' ? 'ObjectId' : 'int'];

      return jsonContent({
        action: 'schema_design_context',
        stepZero: 'Read this response before create_tables/create_columns/create_relations. Use these live attributes and types, not SQL dialect guesses.',
        liveColumnTypes,
        primaryKeyContext: {
          observedPrimaryColumnNames: primaryColumnNames,
          observedPrimaryColumnTypes: primaryColumnTypes,
          createTableDefault: metadataContext.dbType === 'mongodb'
            ? 'create_tables auto-includes the Mongo _id/ObjectId primary key.'
            : 'create_tables auto-includes the SQL id/int primary key.',
        },
        createTableInput: {
          directFields: ['name', 'description', 'isSingleRecord'],
          cascadeFields: ['columns', 'relations'],
          constraintFields: ['indexes', 'uniques'],
          notAcceptedAtCreate: ['alias', 'graphqlEnabled'],
          autoManagedColumns: ['id', 'createdAt', 'updatedAt'],
          idColumn: metadataContext.dbType === 'mongodb'
            ? 'create_tables auto-includes _id/ObjectId; do not include your own primary key.'
            : 'create_tables auto-includes id/int; do not include your own primary key.',
          reservedColumnRule: 'Do not declare id, _id, createdAt, or updatedAt in create_tables/create_columns. create_tables strips them before save and reports skippedAutoColumns; create_columns rejects them.',
        },
        columnDefinitionInput: {
          allowedFields: ['name', 'type', 'isNullable', 'isUnique', 'isPublished', 'isUpdatable', 'isEncrypted', 'defaultValue', 'description', 'options'],
          liveTypes: liveColumnTypes,
          typeSelection: [
            'varchar: short text, labels, slugs, status strings.',
            'text/richtext: long prose.',
            'float: prices, amounts, ratings, percentages, decimal-like numbers unless liveTypes contains decimal.',
            'int/bigint: counts, ordering, integer quantities.',
            'boolean: true/false flags.',
            'date/datetime/timestamp: temporal fields.',
            'enum: constrained option strings when options are provided.',
            'simple-json: structured snapshots/arrays only when liveTypes contains simple-json.',
            'code: source-code fields.',
          ],
          forbiddenGuesses: ['json', 'jsonb', 'longtext', 'decimal'].filter((type) => !liveColumnTypes.includes(type)),
          aliasNormalization: 'Schema tools normalize common aliases where possible and return schemaNormalization, but models should choose from liveTypes directly.',
          namespaceRule: 'Column names and relation propertyName values share one table namespace. Do not define a scalar column and a relation with the same name in one table.',
        },
        relationDefinitionInput: {
          allowedFields: ['targetTableId', 'targetTable', 'type', 'propertyName', 'inversePropertyName', 'mappedBy', 'isNullable', 'onDelete', 'description'],
          relationTypes: relationTypes.length ? relationTypes : ['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many'],
          onDeleteOptions: onDeleteOptions.length ? onDeleteOptions : ['CASCADE', 'SET NULL', 'RESTRICT'],
          forbiddenPhysicalFields: FORBIDDEN_RELATION_KEYS,
          rule: 'Use relations for links between records. Do not create scalar FK columns such as userId, owner_id, categoryIds, or courseId unless the user explicitly wants denormalized snapshot data.',
          namespaceRule: 'Relation propertyName must be unique among both relation names and scalar column names on the same table. If a relation is named owner, do not also create ownerId/owner as a scalar field.',
          inverseDesignRule: 'If a parent detail/read must deep-load a child collection (for example application.reviewAssignments or assignment.scorecards), create the owning child many-to-one relation with inversePropertyName immediately. Without the inverse, parent-to-child deep reads will fail with unknown relation.',
        },
        constraints: {
          indexes: 'JSON array of non-unique logical field groups, e.g. [["status","createdAt"]]. Relation propertyName values are allowed.',
          uniques: 'JSON array of unique logical field groups, e.g. [["record","actor"]].',
          uniqueIndexRule: 'Any field that appears in any uniques group, including composite unique groups such as ["event","attendee"], must not appear in indexes because unique constraints already create indexed lookups for their fields.',
          createTablesPreflight: 'create_tables rejects constraints that reference fields not declared as scalar columns, auto-managed columns, or relation propertyName values in that same table item before it creates anything.',
          relationBasedUniques: 'For one-pass schema creation, put the owning relations in the same create_tables item as the relation-based unique group. If relations already exist, add relation-based uniques later with update_tables.',
        },
        recommendedSequence: [
          '1. Name domain entities and decide which existing tables are reused, especially enfyra_user for users/owners/actors.',
          '2. Create independent lookup/base tables first with scalar columns only.',
          '3. Create dependent tables with scalar columns and relations whose target tables already exist.',
          '4. Use create_relations after both tables exist when a relation could not be included during table creation.',
          '5. Add relation-based unique groups in the same create_tables item when the relations are declared there, or via update_tables after relations exist.',
          '6. Before deep parent detail queries, confirm every child collection relation exists as an inversePropertyName on the owning child relation.',
          '7. Insert records using column names and relation propertyName values, never hidden FK columns.',
          '8. Re-inspect each table with inspect_table before writing records or adding query examples.',
        ],
        liveMetadataAttributes: {
          enfyra_table: tableAttributes,
          enfyra_column: columnAttributes,
          enfyra_relation: relationAttributes,
        },
      });
    },
  );

  // ─── TABLE MUTATIONS ───

  server.tool(
    'create_tables',
    [
      'Create one or more table definitions. Always pass items as a native JSON array; for one table, pass one item.',
      'The tool creates tables sequentially, creates columns with each table, then creates all requested relations after every table in the batch exists. This avoids relation target races for weak agents.',
      'Each item supports { name, description?, isSingleRecord?, columns?, relations?, indexes?, uniques? }. columns/relations/indexes/uniques may be arrays inside the item.',
      'Do not include id, _id, createdAt, or updatedAt in columns; Enfyra manages them and create_tables strips them before save.',
      'Every field named in indexes/uniques must be a scalar column, auto-managed column, or relation propertyName in the same table item; otherwise the tool rejects the whole batch before creating tables.',
      'Use get_schema_design_context first for live column types and relation rules. Do not include physical FK fields.',
      'The response includes cleanupHints.recordCreateOrder; use it when seeding records so parent/target rows are created before child/source rows.',
      'The response includes cleanupHints.recordDeleteOrder; use it when deleting seeded test records so child/source rows are removed before parent/target rows.',
    ].join(' '),
    {
      items: bulkObjectArrayParam(z, 'Table definitions').optional().describe('Native JSON array of table definitions. Pass one object in the array for a single table.'),
      tables: bulkObjectArrayParam(z, 'Table definitions').optional().describe('Alias for items when the caller naturally names the batch tables. Pass either items or tables, not both.'),
      maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one schema batch. Default/max is 100; operations still run sequentially.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ items, tables, maxItems, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      if (items !== undefined && tables !== undefined) throw new Error('Pass either items or tables to create_tables, not both.');
	      const parsedItems = parseBulkItemsParam('items', items ?? tables);
	      assertBulkLimit('create_tables', parsedItems, maxItems);
	      preflightCreateTableDefinitions(parsedItems);
	      const recordDeleteOrder = computeBatchCleanupOrder(parsedItems);
		      const created: AnyRecord[] = [];
	      const deferredRelations: AnyRecord[] = [];
	      const deferredConstraints: AnyRecord[] = [];

	      for (const [index, item] of parsedItems.entries()) {
	        const result = await withSchemaQueue(() => createOneTable(item));
	        created.push({ index, ...result, deferredRelations: undefined });
	        for (const relation of result.deferredRelations || []) {
	          deferredRelations.push({ index, sourceTableId: result.table.id || result.table.name, ...relation });
	        }
	        if ((result.deferredConstraints?.indexes || []).length || (result.deferredConstraints?.uniques || []).length) {
	          deferredConstraints.push({
	            index,
	            tableId: result.table.id || result.table.name,
	            ...result.deferredConstraints,
	          });
	        }
	      }

      const createdRelations: AnyRecord[] = [];
      deferredRelations.sort((left, right) => {
        const leftPriority = normalizeRelationType(left.type) === 'one-to-many' ? 1 : 0;
        const rightPriority = normalizeRelationType(right.type) === 'one-to-many' ? 1 : 0;
        return leftPriority - rightPriority;
      });
      for (const relation of deferredRelations) {
        const relationResult = await appendRelationToTable({
          sourceTableId: relation.sourceTableId,
          targetTableId: relation.targetTable,
          type: relation.type,
          propertyName: relation.propertyName,
          inversePropertyName: relation.inversePropertyName,
          mappedBy: relation.mappedBy,
          isNullable: relation.isNullable,
          onDelete: relation.onDelete,
          description: relation.description,
          globalRulesAckKey,
        });
	        createdRelations.push({ index: relation.index, ...JSON.parse(relationResult.content[0].text) });
	      }

	      const appliedDeferredConstraints: AnyRecord[] = [];
	      for (const constraints of deferredConstraints) {
	        const constraintResult = await withSchemaQueue(() => applyDeferredConstraints(constraints.tableId, {
	          indexes: constraints.indexes,
	          uniques: constraints.uniques,
	        }));
	        if (constraintResult) appliedDeferredConstraints.push({ index: constraints.index, ...constraintResult });
	      }

	      return jsonContent({
	        action: 'tables_created',
	        requested: parsedItems.length,
	        createdCount: created.length,
	        deferredRelationCount: deferredRelations.length,
	        createdRelationCount: createdRelations.length,
	        deferredConstraintCount: deferredConstraints.length,
	        appliedDeferredConstraintCount: appliedDeferredConstraints.length,
	        sequential: true,
	        relationPhaseAfterTables: true,
	        constraintPhaseAfterRelations: true,
	        cleanupHints: {
	          recordCreateOrder: [...recordDeleteOrder].reverse(),
	          recordDeleteOrder,
	          tableDeleteOrder: recordDeleteOrder,
	          recordCreateRule: 'When seeding sample data, create records sequentially in recordCreateOrder; parent/target rows must exist before child/source rows reference them.',
	          recordRule: 'If you delete seeded records before deleting test tables, delete record batches sequentially in recordDeleteOrder; do not parallelize parent/child deletes.',
	          tableRule: 'For full test cleanup, prefer delete_tables with tableDeleteOrder after deleting custom routes/flows; table deletion removes the remaining table data.',
	        },
	        created,
	        createdRelations,
	        appliedDeferredConstraints,
	      });
	    }
	  );

  server.tool(
    'update_tables',
    'Update one or more table definitions. Always pass items as a native JSON array; for one table, pass one item. Items run sequentially through the schema queue.',
    {
      items: bulkObjectArrayParam(z, 'Table update items').describe('Native JSON array of table update items: [{ tableId, name?, alias?, description?, isSingleRecord?, graphqlEnabled?, indexes?, uniques? }]. indexes/uniques may be arrays.'),
      maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one schema batch. Default/max is 100.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ items, maxItems, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      const parsedItems = parseBulkItemsParam('items', items);
      assertBulkLimit('update_tables', parsedItems, maxItems);
      const updated: AnyRecord[] = [];
      for (const [index, item] of parsedItems.entries()) {
        if (!item.tableId) throw new Error(`items[${index}].tableId is required.`);
        const result = await withSchemaQueue(() => updateOneTable(item));
        updated.push({ index, ...result });
      }
      return jsonContent({ action: 'tables_updated', requested: parsedItems.length, updatedCount: updated.length, sequential: true, updated });
    }
  );

  server.tool(
    'delete_tables',
    'Delete one or more table definitions. Always pass items as a native JSON array; for one table, pass one item. confirm=false previews every target; confirm=true deletes sequentially.',
    {
      items: bulkObjectArrayParam(z, 'Table delete items').describe('Native JSON array of delete items: [{ tableId }] or [{ tableName }]. Names are resolved through live metadata before preview/delete.'),
      maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one schema batch. Default/max is 100.'),
      confirm: z.boolean().optional().default(false).describe('Required true to apply destructive deletes. Omit/false returns previews only.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
    },
    async ({ items, maxItems, confirm, globalRulesAckKey }) => {
      const parsedItems = parseBulkItemsParam('items', items);
      assertBulkLimit('delete_tables', parsedItems, maxItems);
      if (confirm) assertGlobalRulesAck(globalRulesAckKey);
      const results: AnyRecord[] = [];
      for (const [index, item] of parsedItems.entries()) {
        if (!item.tableId && !item.tableName) throw new Error(`items[${index}] requires tableId or tableName.`);
        const result = await withSchemaQueue(() => deleteOneTable({ tableId: item.tableId, tableName: item.tableName, confirm }));
        results.push({ index, ...result });
      }
      return jsonContent({
        action: confirm ? 'tables_deleted' : 'delete_tables_preview',
        requested: parsedItems.length,
        sequential: true,
        destructive: true,
        results,
        next: confirm ? undefined : 'Call delete_tables again with the same items and confirm=true to delete sequentially.',
      });
    }
  );

  // ─── COLUMN MUTATIONS ───

  server.tool(
    'create_columns',
    'Create one or more columns. Always pass items as a native JSON array; for one column, pass one item. Items run sequentially through the schema queue.',
    {
      items: bulkObjectArrayParam(z, 'Column definitions').optional().describe('Native JSON array of column definitions. Each item uses create_columns fields: { tableId, name, type, isNullable?, isUnique?, isPublished?, isUpdatable?, isEncrypted?, isPrimary?, isGenerated?, isSystem?, defaultValue?, description?, options? }.'),
      columns: bulkObjectArrayParam(z, 'Column definitions').optional().describe('Alias for items when the caller naturally names the batch columns. Pass either items or columns, not both.'),
      maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one schema batch. Default/max is 100.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ items, columns, maxItems, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      if (items !== undefined && columns !== undefined) throw new Error('Pass either items or columns to create_columns, not both.');
      const parsedItems = parseBulkItemsParam('items', items ?? columns);
      assertBulkLimit('create_columns', parsedItems, maxItems);
      const created: AnyRecord[] = [];
      for (const [index, item] of parsedItems.entries()) {
        const result = await appendColumnToTable({ ...item, globalRulesAckKey });
        created.push({ index, ...JSON.parse(result.content[0].text) });
      }
      return jsonContent({ action: 'columns_created', requested: parsedItems.length, createdCount: created.length, sequential: true, created });
    }
  );

  server.tool(
    'update_columns',
    'Update one or more columns. Always pass items as a native JSON array; for one column, pass one item. Items run sequentially through the schema queue.',
    {
      items: bulkObjectArrayParam(z, 'Column update items').describe('Native JSON array of column update items: [{ tableId, columnId, name?, type?, isNullable?, isPublished?, isUpdatable?, defaultValue?, description?, options? }].'),
      maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one schema batch. Default/max is 100.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ items, maxItems, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      const parsedItems = parseBulkItemsParam('items', items);
      assertBulkLimit('update_columns', parsedItems, maxItems);
      const updated: AnyRecord[] = [];
      for (const [index, item] of parsedItems.entries()) {
        if (!item.tableId) throw new Error(`items[${index}].tableId is required.`);
        if (!item.columnId) throw new Error(`items[${index}].columnId is required.`);
        const result = await withSchemaQueue(() => updateOneColumn(item));
        updated.push({ index, ...result });
      }
      return jsonContent({ action: 'columns_updated', requested: parsedItems.length, updatedCount: updated.length, sequential: true, updated });
    }
  );

  server.tool(
    'delete_columns',
    'Delete one or more columns. Always pass items as a native JSON array; for one column, pass one item. confirm=false previews every target; confirm=true deletes sequentially.',
    {
      items: bulkObjectArrayParam(z, 'Column delete items').describe('Native JSON array of delete items: [{ tableId, columnId }].'),
      maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one schema batch. Default/max is 100.'),
      confirm: z.boolean().optional().default(false).describe('Required true to apply destructive deletes. Omit/false returns previews only.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
    },
    async ({ items, maxItems, confirm, globalRulesAckKey }) => {
      const parsedItems = parseBulkItemsParam('items', items);
      assertBulkLimit('delete_columns', parsedItems, maxItems);
      if (confirm) assertGlobalRulesAck(globalRulesAckKey);
      const results: AnyRecord[] = [];
      for (const [index, item] of parsedItems.entries()) {
        if (!item.tableId) throw new Error(`items[${index}].tableId is required.`);
        if (!item.columnId) throw new Error(`items[${index}].columnId is required.`);
        const result = await removeColumnFromTable({ ...item, confirm, globalRulesAckKey });
        results.push({ index, ...JSON.parse(result.content[0].text) });
      }
      return jsonContent({
        action: confirm ? 'columns_deleted' : 'delete_columns_preview',
        requested: parsedItems.length,
        sequential: true,
        destructive: true,
        results,
        next: confirm ? undefined : 'Call delete_columns again with the same items and confirm=true to delete sequentially.',
      });
    }
  );

  // ─── RELATION MUTATIONS ───

  server.tool(
    'create_relations',
    'Create one or more relations. Always pass items as a native JSON array; for one relation, pass one item. Items run sequentially through the schema queue and table names/aliases are resolved internally.',
    {
      items: bulkObjectArrayParam(z, 'Relation definitions').optional().describe('Native JSON array of relation definitions. Each item uses { sourceTableId, targetTableId or targetTable, type, propertyName, inversePropertyName?, mappedBy?, isNullable?, onDelete?, description? }. Do not send physical FK fields.'),
      relations: bulkObjectArrayParam(z, 'Relation definitions').optional().describe('Alias for items when the caller naturally names the batch relations. Pass either items or relations, not both.'),
      maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one schema batch. Default/max is 100.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ items, relations, maxItems, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      if (items !== undefined && relations !== undefined) throw new Error('Pass either items or relations to create_relations, not both.');
      const parsedItems = parseBulkItemsParam('items', items ?? relations);
      assertBulkLimit('create_relations', parsedItems, maxItems);
      const created: AnyRecord[] = [];
      for (const [index, item] of parsedItems.entries()) {
        const result = await appendRelationToTable({ ...item, globalRulesAckKey });
        created.push({ index, ...JSON.parse(result.content[0].text) });
      }
      return jsonContent({ action: 'relations_created', requested: parsedItems.length, createdCount: created.length, sequential: true, created });
    }
  );

  server.tool(
    'delete_relations',
    'Delete one or more relations. Always pass items as a native JSON array; for one relation, pass one item. confirm=false previews every target; confirm=true deletes sequentially.',
    {
      items: bulkObjectArrayParam(z, 'Relation delete items').describe('Native JSON array of delete items: [{ tableId, relationId }].'),
      maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one schema batch. Default/max is 100.'),
      confirm: z.boolean().optional().default(false).describe('Required true to apply destructive deletes. Omit/false returns previews only.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
    },
    async ({ items, maxItems, confirm, globalRulesAckKey }) => {
      const parsedItems = parseBulkItemsParam('items', items);
      assertBulkLimit('delete_relations', parsedItems, maxItems);
      if (confirm) assertGlobalRulesAck(globalRulesAckKey);
      const results: AnyRecord[] = [];
      for (const [index, item] of parsedItems.entries()) {
        if (!item.tableId) throw new Error(`items[${index}].tableId is required.`);
        if (!item.relationId) throw new Error(`items[${index}].relationId is required.`);
        const result = await removeRelationFromTable({ ...item, confirm, globalRulesAckKey });
        results.push({ index, ...JSON.parse(result.content[0].text) });
      }
      return jsonContent({
        action: confirm ? 'relations_deleted' : 'delete_relations_preview',
        requested: parsedItems.length,
        sequential: true,
        destructive: true,
        results,
        next: confirm ? undefined : 'Call delete_relations again with the same items and confirm=true to delete sequentially.',
      });
    }
  );


}
