/**
 * Table & Column tools for Enfyra MCP Server
 */
import { z } from 'zod';
import { fetchAPI } from './fetch.js';
import { jsonContent } from './response-format.js';

let schemaQueue = Promise.resolve();

function withSchemaQueue(operation) {
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

export function normalizeTablesFromMetadata(metadata) {
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
 * Dynamic enfyra_table relation fields can be paginated/truncated, so schema
 * cascade tools must use /metadata as the complete source of columns/relations.
 */
export async function fetchTableWithDetails(ENFYRA_API_URL, tableId) {
  const filter = encodeURIComponent(JSON.stringify({ id: { _eq: tableId } }));
  const [tableResult, metadata] = await Promise.all([
    fetchAPI(ENFYRA_API_URL, `/enfyra_table?filter=${filter}&limit=1&fields=*`),
    fetchAPI(ENFYRA_API_URL, '/metadata'),
  ]);
  const tableData = tableResult?.data?.[0] || tableResult?.[0] || null;
  const metadataTable =
    resolveTableFromMetadata(metadata, tableId) ||
    resolveTableFromMetadataByName(metadata, tableData?.name);
  if (!metadataTable) {
    throw new Error(`Full metadata for table ${tableId} was not found; refusing schema cascade patch.`);
  }
  if (!Array.isArray(metadataTable.columns)) {
    throw new Error(`Full metadata for table ${tableId} did not include columns; refusing schema cascade patch.`);
  }
  return {
    ...(tableData || metadataTable),
    columns: metadataTable.columns,
    relations: Array.isArray(metadataTable.relations) ? metadataTable.relations : [],
  };
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

function normalizeConstraintGroups(name, groups) {
  return groups.map((group, index) => {
    const value = Array.isArray(group) ? group : group?.value;
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error(`${name}[${index}] must be a non-empty string array or { "value": [...] }.`);
    }
    return value;
  });
}

export function normalizeRelationForTablePatch(relation) {
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
  const normalized = { ...rest };
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

function assertNoForbiddenRelationKeys(args) {
  for (const key of FORBIDDEN_RELATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`create_relation must not include physical column field "${key}". Use sourceTableId/targetTableId and relation propertyName only; Enfyra derives FK and junction columns.`);
    }
  }
}

export function sanitizeExistingRelationForTablePatch(relation) {
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

export function resolveRelationTargetsFromMetadata(metadata, relations) {
  return relations.map((relation) => {
    const targetTable = relation.targetTable;
    if (typeof targetTable !== 'string' || !targetTable.trim()) return relation;
    const resolvedTable = resolveTableFromMetadataByName(metadata, targetTable);
    if (!resolvedTable) return relation;
    return { ...relation, targetTable: getId(resolvedTable) };
  });
}

function getId(record) {
  return record?.id ?? record?._id ?? null;
}

function normalizeColumnForTablePatch(column) {
  const { table, ...rest } = column;
  return rest;
}

function getPatchableColumns(columns) {
  return (columns || [])
    .filter((column) => getId(column) !== null)
    .map(normalizeColumnForTablePatch);
}

function getMissingIds(beforeIds, afterIds, excludedIds = []) {
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
}) {
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
}) {
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
}) {
  const column = {
    name,
    type,
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
  if (options !== undefined) column.options = JSON.parse(options);
  return column;
}

/**
 * Register table tools with MCP server
 */
export function registerTableTools(server, ENFYRA_API_URL) {
  const apiBase = ENFYRA_API_URL.replace(/\/$/, '');

  async function appendColumnToTable(args) {
    return withSchemaQueue(async () => {
    const tableData = await fetchTableWithDetails(ENFYRA_API_URL, args.tableId);
    if (!tableData) {
      return { content: [{ type: 'text', text: `Error: Table with ID ${args.tableId} not found.` }] };
    }

    const existingColumns = getPatchableColumns(tableData.columns);
    const beforeIds = existingColumns.map((column) => String(getId(column)));
    const newCol = buildColumnDefinition(args);
    const result = await patchTableAutoConfirm(ENFYRA_API_URL, args.tableId, { columns: [...existingColumns, newCol] });
    await verifyColumnCascade(ENFYRA_API_URL, args.tableId, beforeIds, {
      action: 'create',
      columnName: args.name,
    });

    return {
      content: [{ type: 'text', text: `Column "${args.name}" added to table ${args.tableId}.\n\n${JSON.stringify(result, null, 2)}` }],
    };
    });
  }

  async function appendRelationToTable(args) {
    return withSchemaQueue(async () => {
    assertNoForbiddenRelationKeys(args);
    const { sourceTableId, targetTableId, type, propertyName, inversePropertyName, mappedBy, isNullable, onDelete, description } = args;
    const metadata = await fetchAPI(ENFYRA_API_URL, '/metadata');
    const resolvedSourceTableId = resolveTableIdentifierFromMetadata(metadata, sourceTableId, 'sourceTableId');
    const resolvedTargetTableId = resolveTableIdentifierFromMetadata(metadata, targetTableId, 'targetTableId');
    const tableData = await fetchTableWithDetails(ENFYRA_API_URL, resolvedSourceTableId);
    if (!tableData) {
      return { content: [{ type: 'text', text: `Error: Table ${sourceTableId} not found.` }] };
    }
    const existingRelations = (tableData.relations || []).map(sanitizeExistingRelationForTablePatch);
    const beforeIds = existingRelations.map((relation) => String(getId(relation))).filter((id) => id !== 'null');
    const newRelation = { targetTable: resolvedTargetTableId, type, propertyName };
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
    return {
      content: [{ type: 'text', text: `Relation created: ${propertyName} (${type}) from table ${resolvedSourceTableId} → ${resolvedTargetTableId}.\n\nFull result:\n${JSON.stringify(result, null, 2)}` }],
    };
    });
  }

  async function removeColumnFromTable({ tableId, columnId, confirm }) {
    return withSchemaQueue(async () => {
    const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
    if (!tableData) {
      return { content: [{ type: 'text', text: `Error: Table with ID ${tableId} not found.` }] };
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
          next: 'Call delete_column again with confirm=true to drop the physical column and metadata.',
        }, null, 2) }],
      };
    }

    const columns = existingColumns
      .filter(col => String(getId(col)) !== String(columnId))

    const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { columns });
    await verifyColumnCascade(ENFYRA_API_URL, tableId, beforeIds, {
      action: 'delete',
      columnId,
    });

    return {
      content: [{ type: 'text', text: `Column ${columnId} deleted from table ${tableId}.\n\n${JSON.stringify(result, null, 2)}` }],
    };
    });
  }

  async function removeRelationFromTable({ tableId, relationId, confirm }) {
    return withSchemaQueue(async () => {
    const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
    if (!tableData) {
      return { content: [{ type: 'text', text: `Error: Table with ID ${tableId} not found.` }] };
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
          next: 'Call delete_relation again with confirm=true to drop relation metadata and any derived FK/junction structures.',
        }, null, 2) }],
      };
    }

    const relations = existingRelations
      .filter(rel => String(getId(rel)) !== String(relationId))

    const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { relations });
    await verifyRelationCascade(ENFYRA_API_URL, tableId, beforeIds, {
      action: 'delete',
      relationId,
    });

    return {
      content: [{ type: 'text', text: `Relation ${relationId} deleted from table ${tableId}.\n\n${JSON.stringify(result, null, 2)}` }],
    };
    });
  }

  const columnCreateSchema = {
    tableId: z.string().describe('Table definition ID (from get_all_tables or create_table).'),
    name: z.string().describe('Column name (e.g., "title", "webhook_secret"). Lowercase with underscores.'),
    type: z.string().describe('Column type: varchar, int, text, boolean, datetime, json, decimal, timestamp, uuid, bigint, float, longtext, richtext, simple-json, code, enum, array-select, date.'),
    isNullable: z.boolean().optional().default(true).describe('Set to false if column cannot be null.'),
    isUnique: z.boolean().optional().default(false).describe('Set to true for unique constraint.'),
    isPublished: z.boolean().optional().describe('Set column visibility baseline. Use false for secrets and internal fields.'),
    isUpdatable: z.boolean().optional().describe('Set false for immutable fields that cannot be updated after creation. Independent from isEncrypted.'),
    isEncrypted: z.boolean().optional().describe('Set true to encrypt this column at the Enfyra database-query layer. This does not change isUpdatable. Encrypted fields cannot be filtered or sorted.'),
    isPrimary: z.boolean().optional().describe('Set true only for primary key columns; normally only create_table auto id uses this.'),
    isGenerated: z.boolean().optional().describe('Set true only for generated columns such as auto id.'),
    isSystem: z.boolean().optional().describe('Set true only for system-managed columns. Avoid for normal app fields.'),
    defaultValue: z.string().optional().describe('Default value as JSON string or backend-supported literal.'),
    description: z.string().optional().describe('Column description.'),
    options: z.string().optional().describe('Column options as JSON string (e.g., enum values).'),
  };

  const relationCreateSchema = {
    sourceTableId: z.string().describe('Source table id, exact table name, or alias. For many-to-one, this is the table that owns the relation property.'),
    targetTableId: z.string().describe('Target table id, exact table name, or alias. MCP resolves names/aliases to ids before mutation.'),
    type: z.enum(['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many']).describe('Relation type.'),
    propertyName: z.string().describe('Property name on source table (e.g., "customer", "items").'),
    inversePropertyName: z.string().optional().describe('Property name on target table for bidirectional relation (e.g., "orders"). Omit unless the reverse field is truly needed.'),
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
  };

  const columnDeleteSchema = {
    tableId: z.string().describe('Table definition ID.'),
    columnId: z.string().describe('Column definition ID to delete.'),
    confirm: z.boolean().optional().default(false).describe('Required true to apply the destructive delete. Omit/false returns a preview only.'),
  };

  const relationDeleteSchema = {
    tableId: z.string().describe('Table definition ID (source table of the relation).'),
    relationId: z.string().describe('Relation definition ID to delete.'),
    confirm: z.boolean().optional().default(false).describe('Required true to apply the destructive delete. Omit/false returns a preview only.'),
  };

  // ─── READ ───

  server.tool(
    'get_all_tables',
    'List table definitions from metadata. Every call must pass either limit or all=true. Use search to narrow by table name or alias.',
    {
      limit: z.number().int().positive().optional().describe('Maximum tables returned after search. Required unless all=true.'),
      all: z.boolean().optional().describe('Return all matched tables. Use this when a complete table list is required.'),
      search: z.string().optional().describe('Optional table name, alias, or description substring filter.'),
    },
    async ({ limit, all, search }) => {
      if (!all && limit === undefined) {
        throw new Error('get_all_tables requires either limit or all=true. Do not invent arbitrary limits for complete table lists; use all=true.');
      }
      const metadata = await fetchAPI(ENFYRA_API_URL, '/metadata');
      const needle = search?.trim().toLowerCase();
      const tables = normalizeTablesFromMetadata(metadata)
        .map((table) => ({
          id: getId(table),
          name: table.name ?? null,
          alias: table.alias ?? null,
          description: table.description ?? null,
          isSingleRecord: table.isSingleRecord ?? null,
          columnCount: Array.isArray(table.columns) ? table.columns.length : null,
          relationCount: Array.isArray(table.relations) ? table.relations.length : null,
          routeBacked: Boolean(table.route || table.routeId || table.path),
        }))
        .filter((table) => {
          if (!needle) return true;
          return [table.name, table.alias, table.description]
            .some((value) => String(value || '').toLowerCase().includes(needle));
        });
      const returnedTables = all ? tables : tables.slice(0, limit);
      return jsonContent({
        action: 'get_all_tables',
        totalTableCount: normalizeTablesFromMetadata(metadata).length,
        matchedTableCount: tables.length,
        returnedTableCount: returnedTables.length,
        all: Boolean(all),
        search: search || null,
        tables: returnedTables,
        detailHint: 'Use inspect_table with a table id/name for columns, relations, indexes, routes, permissions, and GraphQL state.',
      });
    }
  );

  // ─── CREATE TABLE ───

  server.tool(
    'create_table',
    [
      'Create a new table definition with an auto-included `id` primary key column.',
      '**Not** for adding a custom API path or handler only — for that use **`create_route`** without `mainTableId`. Use **`create_table`** when the user needs new stored data (new entity).',
      'PREFERRED: pass `columns` and `relations` params as JSON arrays to create a table WITH columns and relations in one call (cascade). Only use create_column/create_relation separately when adding to an existing table later.',
      'Indexes and uniques are first-class table metadata. Use `indexes` for query performance and `uniques` for data integrity. Each entry is a logical field group such as [["member","isRead","conversation"]] or [{"value":["message","member"]}]. Relation property names are allowed; Enfyra resolves them to physical FK columns.',
      'Relations are supported in this same create_table call when the target table already exists. Each relation uses { targetTable, type, propertyName, inversePropertyName?, mappedBy?, isNullable?, onDelete? }; targetTable may be a table id, {id}, or an exact table name that MCP resolves to an id before mutation.',
      'Do NOT provide physical FK/junction columns. Never include fkCol, fkColumn, foreignKeyColumn, sourceColumn, targetColumn, junctionSourceColumn, or junctionTargetColumn. Enfyra derives and hides those physical columns from relation propertyName/table metadata.',
      'Schema operations (create/update/delete table, add column) must run one at a time — migration locks DB; parallel calls will fail.',
      'Enfyra auto-creates a default REST route at path `/<table_name>` (same segment as `name`, not alias).',
      'REST surface for that route (matches server route engine): 4 HTTP operations — GET `/<table>` (list/filter), POST `/<table>` (create), PATCH `/<table>/:id` (update), DELETE `/<table>/:id` (delete).',
      'There is NO `GET /<table>/:id`. To fetch one row by id, use find_one_record or inspect metadata first and call GET `/<table>?filter={"<primaryKeyFromMetadata>":{"_eq":"<id>"}}&limit=1`.',
      'Set `isSingleRecord: true` directly in create_table for settings/config tables that should keep only one record.',
      `Full URLs: ${apiBase}/<table_name> (example table post: ${apiBase}/post).`,
      'GraphQL is enabled separately per table through `enfyra_graphql` or `update_table` with `graphqlEnabled`; it is not controlled by route availableMethods.',
      'Do not set alias during create_table. The create tool accepts name, description, isSingleRecord, columns, and relations only; use update_table later only if alias really needs to change.',
    ].join(' '),
    {
      name: z.string().describe('Table name (e.g., "enfyra_user", "my_custom_table"). Must be unique, lowercase with underscores.'),
      description: z.string().optional().describe('Description of what this table stores.'),
      isSingleRecord: z.boolean().optional().describe('Set to true for single-record tables such as settings/config. This is passed directly to enfyra_table create.'),
      columns: z.string().optional().describe('JSON array of column definitions to create with the table (cascade). Each column: { name, type, isNullable?, isUnique?, isPublished?, isUpdatable?, isEncrypted?, defaultValue?, description?, options? }. Set isEncrypted=true for values encrypted at rest; set isUpdatable=false separately only when the field should be immutable. The `id` column is always auto-included. Example: [{"name":"title","type":"varchar"},{"name":"api_key","type":"varchar","isEncrypted":true,"isPublished":false}]'),
      relations: z.string().optional().describe('JSON array of relation definitions to create with the table in the same cascade call. Each relation: { targetTable, type, propertyName, inversePropertyName?, mappedBy?, isNullable?, onDelete?, description? }. targetTable can be an id, {"id": <id>}, or an exact table name that MCP resolves to an id before mutation. Do not include physical FK/junction columns such as fkCol, foreignKeyColumn, sourceColumn, targetColumn, junctionSourceColumn, or junctionTargetColumn; Enfyra derives them and hides FK columns from app schema. Example: [{"targetTable":2,"type":"many-to-one","propertyName":"author","inversePropertyName":"posts","isNullable":false,"onDelete":"CASCADE"}]'),
      indexes: z.string().optional().describe('JSON array of logical index field groups. Each group can be ["fieldA","fieldB"] or {"value":["fieldA","fieldB"]}. Relation property names are allowed. Example: [["member","isRead","conversation"],["conversation","member","isRead"]]'),
      uniques: z.string().optional().describe('JSON array of logical unique field groups. Each group can be ["fieldA","fieldB"] or {"value":["fieldA","fieldB"]}. Example: [["message","member"]]'),
    },
    async ({ name, description, isSingleRecord, columns: columnsJson, relations: relationsJson, indexes: indexesJson, uniques: uniquesJson }) => withSchemaQueue(async () => {
      const idColumn = { name: 'id', type: 'int', isPrimary: true, isGenerated: true, isNullable: false };
      const userColumns = parseJsonArrayParam('columns', columnsJson);
      const parsedRelations = parseJsonArrayParam('relations', relationsJson).map(normalizeRelationForTablePatch);
      const metadata = parsedRelations.length ? await fetchAPI(ENFYRA_API_URL, '/metadata') : null;
      const userRelations = metadata
        ? resolveRelationTargetsFromMetadata(metadata, parsedRelations)
        : parsedRelations;
      const indexes = normalizeConstraintGroups('indexes', parseJsonArrayParam('indexes', indexesJson));
      const uniques = normalizeConstraintGroups('uniques', parseJsonArrayParam('uniques', uniquesJson));
      const body = { name, description, columns: [idColumn, ...userColumns], relations: userRelations };
      if (isSingleRecord !== undefined) body.isSingleRecord = isSingleRecord;
      if (indexesJson !== undefined) body.indexes = indexes;
      if (uniquesJson !== undefined) body.uniques = uniques;
      const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_table', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const createdTable = Array.isArray(result?.data) ? result.data[0] : result;
      const createdTableId = createdTable?.id ?? createdTable?._id;
      const base = ENFYRA_API_URL.replace(/\/$/, '');
      const routePath = `/${name}`;
      const restHint = [
        `Auto route path: ${routePath} → full base for REST: ${base}${routePath}`,
        `REST: GET+POST on ${routePath}; PATCH+DELETE on ${routePath}/:id only. No GET ${routePath}/:id.`,
      ].join('\n');
      const colHint = userColumns.length
        ? `Table created with ${userColumns.length} column(s) + auto id.`
        : `Table created. Use create_column to add columns (tableId: ${createdTableId}).`;
      const relHint = userRelations.length
        ? `Relation(s) created in same call: ${userRelations.length}.`
        : `No relations were included in this create_table call.`;
      const constraintHint = [
        indexes.length ? `Index group(s): ${indexes.length}.` : null,
        uniques.length ? `Unique group(s): ${uniques.length}.` : null,
      ].filter(Boolean).join(' ');
      return {
        content: [{ type: 'text', text: `${colHint}\n${relHint}${constraintHint ? `\n${constraintHint}` : ''}\n${restHint}\n\nFull result:\n${JSON.stringify(result, null, 2)}` }],
      };
    })
  );

  // ─── UPDATE TABLE ───

  server.tool(
    'update_table',
    [
      'Update table properties: name (rename), alias, description, isSingleRecord, graphqlEnabled, indexes, and uniques.',
      'Does NOT modify columns or relations — use create_column, update_column, delete_column, create_relation for those.',
      'When passing `indexes` or `uniques`, pass the complete desired array of logical field groups; omitted fields are preserved. Relation property names are allowed and are resolved by Enfyra. Example indexes: [["member","isRead","conversation"],["conversation","member","isRead"]].',
      'Run schema changes sequentially — migration locks DB per operation.',
    ].join(' '),
    {
      tableId: z.string().describe('Table definition ID.'),
      name: z.string().optional().describe('New table name (rename). Lowercase with underscores.'),
      alias: z.string().optional().describe('New table alias.'),
      description: z.string().optional().describe('New description.'),
      isSingleRecord: z.boolean().optional().describe('Set to true for single-record table (e.g., settings/config).'),
      graphqlEnabled: z.boolean().optional().describe('Enable or disable GraphQL for this table by syncing enfyra_graphql.isEnabled. GraphQL table data still requires Bearer auth; anonymous root or schema probes may return 200.'),
      indexes: z.string().optional().describe('Complete JSON array of logical index field groups to store on enfyra_table.indexes. Each group can be ["fieldA","fieldB"] or {"value":["fieldA","fieldB"]}. Omit to preserve current indexes; pass [] to clear.'),
      uniques: z.string().optional().describe('Complete JSON array of logical unique field groups to store on enfyra_table.uniques. Each group can be ["fieldA","fieldB"] or {"value":["fieldA","fieldB"]}. Omit to preserve current uniques; pass [] to clear.'),
    },
    async ({ tableId, name, alias, description, isSingleRecord, graphqlEnabled, indexes: indexesJson, uniques: uniquesJson }) => withSchemaQueue(async () => {
      const body = {};
      if (name !== undefined) body.name = name;
      if (alias !== undefined) body.alias = alias;
      if (description !== undefined) body.description = description;
      if (isSingleRecord !== undefined) body.isSingleRecord = isSingleRecord;
      if (graphqlEnabled !== undefined) body.graphqlEnabled = graphqlEnabled;
      if (indexesJson !== undefined) body.indexes = normalizeConstraintGroups('indexes', parseJsonArrayParam('indexes', indexesJson));
      if (uniquesJson !== undefined) body.uniques = normalizeConstraintGroups('uniques', parseJsonArrayParam('uniques', uniquesJson));

      const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, body);
      return {
        content: [{ type: 'text', text: `Table ${tableId} updated.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    })
  );

  // ─── DELETE TABLE ───

  server.tool(
    'delete_table',
    [
      'Delete a table and ALL associated data. This is DESTRUCTIVE and IRREVERSIBLE.',
      'Deletes: table metadata, all columns, all relations (source + target), all routes, junction tables, FK columns from other tables, and the PHYSICAL DATABASE TABLE with ALL DATA.',
      'Always confirm with the user before calling this tool.',
    ].join(' '),
    {
      tableId: z.string().describe('Table definition ID to delete.'),
      confirm: z.boolean().optional().default(false).describe('Required true to apply the destructive delete. Omit/false returns a preview only.'),
    },
    async ({ tableId, confirm }) => withSchemaQueue(async () => {
      const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
      if (!confirm) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            action: 'delete_table_preview',
            tableId,
            tableName: tableData.name,
            columnCount: (tableData.columns || []).length,
            relationCount: (tableData.relations || []).length,
            destructive: true,
            next: 'Call delete_table again with confirm=true to delete metadata, routes, derived FK/junction structures, the physical table, and all table data.',
          }, null, 2) }],
        };
      }
      const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_table/${tableId}`, {
        method: 'DELETE',
      });
      return {
        content: [{ type: 'text', text: `Table ${tableId} deleted.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    })
  );

  // ─── CREATE COLUMN ───

  server.tool(
    'create_column',
    [
      'Add a column to an existing table via PATCH /enfyra_table/{tableId}.',
      'Columns are managed through cascade with enfyra_table — there is NO direct /enfyra_column endpoint.',
      'This tool reads full table metadata, keeps only persisted column rows with id/_id, appends the new one, PATCHes the table, and verifies unrelated columns survived.',
      'Generated metadata projections such as createdAt, updatedAt, or relation-derived FK display fields without id are not valid cascade rows and are skipped.',
      'Run schema changes sequentially — migration locks DB per operation.',
    ].join(' '),
    {
      ...columnCreateSchema,
    },
    appendColumnToTable
  );

  // ─── UPDATE COLUMN ───

  server.tool(
    'update_column',
    [
      'Update an existing column on a table via PATCH /enfyra_table/{tableId}.',
      'Reads full table metadata, keeps only persisted rows with id/_id, modifies the target column, PATCHes the table, and verifies unrelated columns survived.',
      'Generated metadata projections such as createdAt, updatedAt, or relation-derived FK display fields without id are skipped.',
      'Run schema changes sequentially — migration locks DB per operation.',
    ].join(' '),
    {
      tableId: z.string().describe('Table definition ID.'),
      columnId: z.string().describe('Column definition ID to update.'),
      name: z.string().optional().describe('New column name.'),
      type: z.string().optional().describe('New column type.'),
      isNullable: z.boolean().optional().describe('Set nullable.'),
      isPublished: z.boolean().optional().describe('Set column visibility baseline. false = unpublished (omitted from response unless allowed by field permission rules).'),
      isUpdatable: z.boolean().optional().describe('Set false for immutable fields that should be stripped from update payloads.'),
      defaultValue: z.string().optional().describe('New default value as JSON string.'),
      description: z.string().optional().describe('New description.'),
      options: z.string().optional().describe('New options as JSON string.'),
    },
    async ({ tableId, columnId, name, type, isNullable, isPublished, isUpdatable, defaultValue, description, options }) => withSchemaQueue(async () => {
      const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
      if (!tableData) {
        return { content: [{ type: 'text', text: `Error: Table with ID ${tableId} not found.` }] };
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
          if (options !== undefined) rest.options = JSON.parse(options);
        }
        return rest;
      });

      const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { columns });
      await verifyColumnCascade(ENFYRA_API_URL, tableId, beforeIds, {
        action: 'update',
        columnId,
      });

      return {
        content: [{ type: 'text', text: `Column ${columnId} updated on table ${tableId}.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    })
  );

  // ─── DELETE COLUMN ───

  server.tool(
    'delete_column',
    [
      'Delete a column from a table via PATCH /enfyra_table/{tableId}.',
      'Reads full table metadata, keeps only persisted rows with id/_id, removes the target, PATCHes the table, and verifies unrelated columns survived.',
      'The physical column is dropped from the database. System columns (id, createdAt, updatedAt) cannot be deleted.',
      'Run schema changes sequentially — migration locks DB per operation.',
    ].join(' '),
    {
      ...columnDeleteSchema,
    },
    removeColumnFromTable
  );

  // ─── CREATE RELATION ───

  server.tool(
    'create_relation',
    [
      'Create a relation between two tables (many-to-one, one-to-many, one-to-one, many-to-many).',
      'sourceTableId and targetTableId may be table ids, exact table names, or aliases; MCP resolves them from metadata before mutation.',
      'For many-to-one: a physical FK column is created on the source table. For one-to-many: the FK is on the target (inverse relation). This physical FK is derived by Enfyra and hidden from app schema/forms.',
      'Never ask the user for physical FK column names and never send fkCol/fkColumn/foreignKeyColumn/sourceColumn/targetColumn/junction*Column. The public API uses relation propertyName only.',
      'Run sequentially — DB migration locks per operation.',
    ].join(' '),
    {
      ...relationCreateSchema,
    },
    appendRelationToTable
  );

  // ─── DELETE RELATION ───

  server.tool(
    'delete_relation',
    [
      'Delete a relation from a table via PATCH /enfyra_table/{tableId}.',
      'Fetches all relations, removes the target, and PATCHes the table.',
      'Drops FK columns and junction tables (for many-to-many).',
    ].join(' '),
    {
      ...relationDeleteSchema,
    },
    removeRelationFromTable
  );

}
