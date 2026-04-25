/**
 * Table & Column tools for Enfyra MCP Server
 */
import { z } from 'zod';
import { fetchAPI } from './fetch.js';

/**
 * Helper: fetch table with columns and relations
 */
async function fetchTableWithDetails(ENFYRA_API_URL, tableId) {
  const filter = encodeURIComponent(JSON.stringify({ id: { _eq: tableId } }));
  const result = await fetchAPI(ENFYRA_API_URL, `/table_definition?filter=${filter}&limit=1&fields=*,columns.*,relations.*`);
  return result?.data?.[0] || result?.[0] || null;
}

/**
 * PATCH table_definition with auto-confirm for schema changes.
 * First PATCH returns preview + requiredConfirmHash; this helper
 * automatically resends with ?schemaConfirmHash= to apply.
 */
async function patchTableAutoConfirm(ENFYRA_API_URL, tableId, body) {
  const result = await fetchAPI(ENFYRA_API_URL, `/table_definition/${tableId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const preview = Array.isArray(result?.data) ? result.data[0] : result?.data;
  if (preview?._preview && preview?.requiredConfirmHash) {
    return fetchAPI(ENFYRA_API_URL, `/table_definition/${tableId}?schemaConfirmHash=${preview.requiredConfirmHash}`, {
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

function normalizeRelationForTablePatch(relation) {
  const { sourceTable, targetTable, targetTableId, mappedBy, ...rest } = relation;
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

/**
 * Register table tools with MCP server
 */
export function registerTableTools(server, ENFYRA_API_URL) {
  const apiBase = ENFYRA_API_URL.replace(/\/$/, '');

  // ─── READ ───

  server.tool(
    'get_all_tables',
    'Get all table definitions in the system',
    {},
    async () => {
      const result = await fetchAPI(ENFYRA_API_URL, '/table_definition?limit=500');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── CREATE TABLE ───

  server.tool(
    'create_table',
    [
      'Create a new table definition with an auto-included `id` primary key column.',
      '**Not** for adding a custom API path or handler only — for that use **`create_route`** with an existing `mainTableId`. Use **`create_table`** when the user needs new stored data (new entity).',
      'PREFERRED: pass `columns` and `relations` params as JSON arrays to create a table WITH columns and relations in one call (cascade). Only use create_column/create_relation separately when adding to an existing table later.',
      'Relations are supported in this same create_table call when the target table already exists. Each relation uses { targetTable, type, propertyName, inversePropertyName?, mappedBy?, isNullable?, onDelete? }; targetTable may be a table id or {id}.',
      'Schema operations (create/update/delete table, add column) must run one at a time — migration locks DB; parallel calls will fail.',
      'Enfyra auto-creates a default REST route at path `/<table_name>` (same segment as `name`, not alias).',
      'REST surface for that route (matches server route engine): 4 HTTP operations — GET `/<table>` (list/filter), POST `/<table>` (create), PATCH `/<table>/:id` (update), DELETE `/<table>/:id` (delete).',
      'There is NO `GET /<table>/:id`. To fetch one row by id, use GET `/<table>?filter={"id":{"_eq":"<id>"}}&limit=1` or tool query_table / find_one_record.',
      `Full URLs: ${apiBase}/<table_name> (example table post: ${apiBase}/post).`,
      'GraphQL is enabled separately per table through `gql_definition` or `update_table` with `graphqlEnabled`; it is not controlled by route availableMethods.',
    ].join(' '),
    {
      name: z.string().describe('Table name (e.g., "user_definition", "my_custom_table"). Must be unique, lowercase with underscores.'),
      alias: z.string().optional().describe('Table alias for API. If not provided, the table name will be used.'),
      description: z.string().optional().describe('Description of what this table stores.'),
      columns: z.string().optional().describe('JSON array of column definitions to create with the table (cascade). Each column: { name, type, isNullable?, isUnique?, defaultValue?, description?, options? }. The `id` column is always auto-included. Example: [{"name":"title","type":"varchar"},{"name":"status","type":"enum","options":["draft","published"]}]'),
      relations: z.string().optional().describe('JSON array of relation definitions to create with the table in the same cascade call. Each relation: { targetTable, type, propertyName, inversePropertyName?, mappedBy?, isNullable?, onDelete?, description? }. targetTable can be an id or {"id": <id>}. Example: [{"targetTable":2,"type":"many-to-one","propertyName":"author","inversePropertyName":"posts","isNullable":false,"onDelete":"CASCADE"}]'),
    },
    async ({ name, alias, description, columns: columnsJson, relations: relationsJson }) => {
      const idColumn = { name: 'id', type: 'int', isPrimary: true, isGenerated: true, isNullable: false };
      const userColumns = parseJsonArrayParam('columns', columnsJson);
      const userRelations = parseJsonArrayParam('relations', relationsJson).map(normalizeRelationForTablePatch);
      const result = await fetchAPI(ENFYRA_API_URL, '/table_definition', {
        method: 'POST',
        body: JSON.stringify({ name, alias, description, columns: [idColumn, ...userColumns], relations: userRelations }),
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
      return {
        content: [{ type: 'text', text: `${colHint}\n${relHint}\n${restHint}\n\nFull result:\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );

  // ─── UPDATE TABLE ───

  server.tool(
    'update_table',
    [
      'Update table properties: name (rename), alias, description, isSingleRecord, graphqlEnabled.',
      'Does NOT modify columns or relations — use create_column, update_column, delete_column, create_relation for those.',
      'Run schema changes sequentially — migration locks DB per operation.',
    ].join(' '),
    {
      tableId: z.string().describe('Table definition ID.'),
      name: z.string().optional().describe('New table name (rename). Lowercase with underscores.'),
      alias: z.string().optional().describe('New table alias.'),
      description: z.string().optional().describe('New description.'),
      isSingleRecord: z.boolean().optional().describe('Set to true for single-record table (e.g., settings/config).'),
      graphqlEnabled: z.boolean().optional().describe('Enable or disable GraphQL for this table by syncing gql_definition.isEnabled. GraphQL still requires Bearer auth.'),
    },
    async ({ tableId, name, alias, description, isSingleRecord, graphqlEnabled }) => {
      const body = {};
      if (name !== undefined) body.name = name;
      if (alias !== undefined) body.alias = alias;
      if (description !== undefined) body.description = description;
      if (isSingleRecord !== undefined) body.isSingleRecord = isSingleRecord;
      if (graphqlEnabled !== undefined) body.graphqlEnabled = graphqlEnabled;

      const result = await fetchAPI(ENFYRA_API_URL, `/table_definition/${tableId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return {
        content: [{ type: 'text', text: `Table ${tableId} updated.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    }
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
    },
    async ({ tableId }) => {
      const result = await fetchAPI(ENFYRA_API_URL, `/table_definition/${tableId}`, {
        method: 'DELETE',
      });
      return {
        content: [{ type: 'text', text: `Table ${tableId} deleted.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );

  // ─── CREATE COLUMN ───

  server.tool(
    'create_column',
    [
      'Add a column to an existing table via PATCH /table_definition/{tableId}.',
      'Columns are managed through cascade with table_definition — there is NO direct /column_definition endpoint.',
      'This tool fetches existing columns, appends the new one, and PATCHes the table.',
      'Run schema changes sequentially — migration locks DB per operation.',
    ].join(' '),
    {
      tableId: z.string().describe('Table definition ID (from get_all_tables or create_table).'),
      name: z.string().describe('Column name (e.g., "title", "user_id"). Lowercase with underscores.'),
      type: z.string().describe('Column type: varchar, int, text, boolean, datetime, json, decimal, timestamp, uuid, bigint, float, longtext, richtext, simple-json, code, enum, array-select, date.'),
      isNullable: z.boolean().optional().default(true).describe('Set to false if column cannot be null.'),
      isUnique: z.boolean().optional().default(false).describe('Set to true for unique constraint.'),
      defaultValue: z.string().optional().describe('Default value as JSON string.'),
      description: z.string().optional().describe('Column description.'),
      options: z.string().optional().describe('Column options as JSON string (e.g., enum values).'),
    },
    async ({ tableId, name, type, isNullable, isUnique, defaultValue, description, options }) => {
      const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
      if (!tableData) {
        return { content: [{ type: 'text', text: `Error: Table with ID ${tableId} not found.` }] };
      }

      const existingColumns = (tableData.columns || []).map(({ table, ...col }) => col);
      const newCol = { name, type, isNullable: isNullable ?? true };
      if (isUnique) newCol.isUnique = true;
      if (defaultValue !== undefined) newCol.defaultValue = defaultValue;
      if (description) newCol.description = description;
      if (options) newCol.options = JSON.parse(options);

      const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { columns: [...existingColumns, newCol] });

      return {
        content: [{ type: 'text', text: `Column "${name}" added to table ${tableId}.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );

  // ─── UPDATE COLUMN ───

  server.tool(
    'update_column',
    [
      'Update an existing column on a table via PATCH /table_definition/{tableId}.',
      'Fetches all columns, modifies the target column, and PATCHes the table.',
      'Run schema changes sequentially — migration locks DB per operation.',
    ].join(' '),
    {
      tableId: z.string().describe('Table definition ID.'),
      columnId: z.string().describe('Column definition ID to update.'),
      name: z.string().optional().describe('New column name.'),
      type: z.string().optional().describe('New column type.'),
      isNullable: z.boolean().optional().describe('Set nullable.'),
      isPublished: z.boolean().optional().describe('Set column visibility baseline. false = unpublished (omitted from response unless allowed by field permission rules).'),
      defaultValue: z.string().optional().describe('New default value as JSON string.'),
      description: z.string().optional().describe('New description.'),
      options: z.string().optional().describe('New options as JSON string.'),
    },
    async ({ tableId, columnId, name, type, isNullable, isPublished, defaultValue, description, options }) => {
      const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
      if (!tableData) {
        return { content: [{ type: 'text', text: `Error: Table with ID ${tableId} not found.` }] };
      }

      const columns = (tableData.columns || []).map(col => {
        const { table, ...rest } = col;
        if (String(col.id) === String(columnId)) {
          if (name !== undefined) rest.name = name;
          if (type !== undefined) rest.type = type;
          if (isNullable !== undefined) rest.isNullable = isNullable;
          if (isPublished !== undefined) rest.isPublished = isPublished;
          if (defaultValue !== undefined) rest.defaultValue = defaultValue;
          if (description !== undefined) rest.description = description;
          if (options !== undefined) rest.options = JSON.parse(options);
        }
        return rest;
      });

      const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { columns });

      return {
        content: [{ type: 'text', text: `Column ${columnId} updated on table ${tableId}.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );

  // ─── DELETE COLUMN ───

  server.tool(
    'delete_column',
    [
      'Delete a column from a table via PATCH /table_definition/{tableId}.',
      'Fetches all columns, removes the target, and PATCHes the table.',
      'The physical column is dropped from the database. System columns (id, createdAt, updatedAt) cannot be deleted.',
      'Run schema changes sequentially — migration locks DB per operation.',
    ].join(' '),
    {
      tableId: z.string().describe('Table definition ID.'),
      columnId: z.string().describe('Column definition ID to delete.'),
    },
    async ({ tableId, columnId }) => {
      const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
      if (!tableData) {
        return { content: [{ type: 'text', text: `Error: Table with ID ${tableId} not found.` }] };
      }

      const columns = (tableData.columns || [])
        .filter(col => String(col.id) !== String(columnId))
        .map(({ table, ...col }) => col);

      const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { columns });

      return {
        content: [{ type: 'text', text: `Column ${columnId} deleted from table ${tableId}.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );

  // ─── CREATE RELATION ───

  server.tool(
    'create_relation',
    [
      'Create a relation between two tables (many-to-one, one-to-many, one-to-one, many-to-many).',
      'For many-to-one: a FK column is created on the source table. For one-to-many: the FK is on the target (inverse relation).',
      'Run sequentially — DB migration locks per operation.',
    ].join(' '),
    {
      sourceTableId: z.string().describe('Source table ID (the table that owns the FK for many-to-one).'),
      targetTableId: z.string().describe('Target table ID.'),
      type: z.enum(['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many']).describe('Relation type.'),
      propertyName: z.string().describe('Property name on source table (e.g., "customer", "items").'),
      inversePropertyName: z.string().optional().describe('Property name on target table for bidirectional relation (e.g., "orders").'),
      isNullable: z.boolean().optional().default(true).describe('Whether the relation is nullable.'),
      onDelete: z.enum(['CASCADE', 'SET NULL', 'RESTRICT']).optional().default('SET NULL').describe('On delete behavior.'),
    },
    async ({ sourceTableId, targetTableId, type, propertyName, inversePropertyName, isNullable, onDelete }) => {
      const tableData = await fetchTableWithDetails(ENFYRA_API_URL, sourceTableId);
      if (!tableData) {
        return { content: [{ type: 'text', text: `Error: Table with ID ${sourceTableId} not found.` }] };
      }
      const existingRelations = (tableData.relations || []).map(normalizeRelationForTablePatch);
      const newRelation = { targetTable: targetTableId, type, propertyName, inversePropertyName: inversePropertyName || null, isNullable, onDelete };
      const result = await patchTableAutoConfirm(ENFYRA_API_URL, sourceTableId, { relations: [...existingRelations, newRelation] });
      return {
        content: [{ type: 'text', text: `Relation created: ${propertyName} (${type}) from table ${sourceTableId} → ${targetTableId}.\n\nFull result:\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );

  // ─── DELETE RELATION ───

  server.tool(
    'delete_relation',
    [
      'Delete a relation from a table via PATCH /table_definition/{tableId}.',
      'Fetches all relations, removes the target, and PATCHes the table.',
      'Drops FK columns and junction tables (for many-to-many).',
    ].join(' '),
    {
      tableId: z.string().describe('Table definition ID (source table of the relation).'),
      relationId: z.string().describe('Relation definition ID to delete.'),
    },
    async ({ tableId, relationId }) => {
      const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
      if (!tableData) {
        return { content: [{ type: 'text', text: `Error: Table with ID ${tableId} not found.` }] };
      }

      const relations = (tableData.relations || [])
        .filter(rel => String(rel.id) !== String(relationId))
        .map(normalizeRelationForTablePatch);

      const result = await patchTableAutoConfirm(ENFYRA_API_URL, tableId, { relations });

      return {
        content: [{ type: 'text', text: `Relation ${relationId} deleted from table ${tableId}.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );
}
