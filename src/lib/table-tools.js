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
      'Use create_column to add more columns after creation (columns are managed via cascade PATCH on table_definition, NOT via /column_definition).',
      'Schema operations (create/update/delete table, add column) must run one at a time — migration locks DB; parallel calls will fail.',
      'Enfyra auto-creates a REST route at path `/<table_name>` (same segment as `name`, not alias).',
      'REST surface for that route (matches server route engine): 4 HTTP operations — GET `/<table>` (list/filter), POST `/<table>` (create), PATCH `/<table>/:id` (update), DELETE `/<table>/:id` (delete).',
      'There is NO `GET /<table>/:id`. To fetch one row by id, use GET `/<table>?filter={"id":{"_eq":"<id>"}}&limit=1` or tool query_table / find_one_record.',
      `Full URLs: ${apiBase}/<table_name> (example table post: ${apiBase}/post).`,
      'GraphQL (GQL_QUERY / GQL_MUTATION) may also be enabled on the route; that is separate from REST paths above.',
    ].join(' '),
    {
      name: z.string().describe('Table name (e.g., "user_definition", "my_custom_table"). Must be unique, lowercase with underscores.'),
      alias: z.string().optional().describe('Table alias for API. If not provided, the table name will be used.'),
      description: z.string().optional().describe('Description of what this table stores.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable table. Set to false to disable.'),
    },
    async ({ name, alias, description, isEnabled }) => {
      const idColumn = { name: 'id', type: 'int', isPrimary: true, isGenerated: true, isNullable: false };
      const result = await fetchAPI(ENFYRA_API_URL, '/table_definition', {
        method: 'POST',
        body: JSON.stringify({ name, alias, description, isEnabled, columns: [idColumn] }),
      });
      const base = ENFYRA_API_URL.replace(/\/$/, '');
      const routePath = `/${name}`;
      const restHint = [
        `Auto route path: ${routePath} → full base for REST: ${base}${routePath}`,
        `REST: GET+POST on ${routePath}; PATCH+DELETE on ${routePath}/:id only. No GET ${routePath}/:id.`,
      ].join('\n');
      return {
        content: [{ type: 'text', text: `Table created successfully with ID: ${result.id}. Next step: use create_column to add columns (tableId: ${result.id}).\n${restHint}\n\nFull result:\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );

  // ─── UPDATE TABLE ───

  server.tool(
    'update_table',
    [
      'Update table properties: name (rename), alias, description, isSingleRecord, uniques, indexes.',
      'Does NOT modify columns or relations — use create_column, update_column, delete_column, create_relation for those.',
      'Run schema changes sequentially — migration locks DB per operation.',
    ].join(' '),
    {
      tableId: z.string().describe('Table definition ID.'),
      name: z.string().optional().describe('New table name (rename). Lowercase with underscores.'),
      alias: z.string().optional().describe('New table alias.'),
      description: z.string().optional().describe('New description.'),
      isSingleRecord: z.boolean().optional().describe('Set to true for single-record table (e.g., settings/config).'),
    },
    async ({ tableId, name, alias, description, isSingleRecord }) => {
      const body = {};
      if (name !== undefined) body.name = name;
      if (alias !== undefined) body.alias = alias;
      if (description !== undefined) body.description = description;
      if (isSingleRecord !== undefined) body.isSingleRecord = isSingleRecord;

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

      const existingColumns = (tableData.columns || []).map(col => ({ id: col.id }));
      const newCol = { name, type, isNullable: isNullable ?? true };
      if (isUnique) newCol.isUnique = true;
      if (defaultValue !== undefined) newCol.defaultValue = defaultValue;
      if (description) newCol.description = description;
      if (options) newCol.options = JSON.parse(options);

      const result = await fetchAPI(ENFYRA_API_URL, `/table_definition/${tableId}`, {
        method: 'PATCH',
        body: JSON.stringify({ columns: [...existingColumns, newCol] }),
      });

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
      isHidden: z.boolean().optional().describe('Hide column from API responses.'),
      defaultValue: z.string().optional().describe('New default value as JSON string.'),
      description: z.string().optional().describe('New description.'),
      options: z.string().optional().describe('New options as JSON string.'),
    },
    async ({ tableId, columnId, name, type, isNullable, isHidden, defaultValue, description, options }) => {
      const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
      if (!tableData) {
        return { content: [{ type: 'text', text: `Error: Table with ID ${tableId} not found.` }] };
      }

      const columns = (tableData.columns || []).map(col => {
        if (String(col.id) === String(columnId)) {
          const updated = { id: col.id };
          if (name !== undefined) updated.name = name;
          if (type !== undefined) updated.type = type;
          if (isNullable !== undefined) updated.isNullable = isNullable;
          if (isHidden !== undefined) updated.isHidden = isHidden;
          if (defaultValue !== undefined) updated.defaultValue = defaultValue;
          if (description !== undefined) updated.description = description;
          if (options !== undefined) updated.options = JSON.parse(options);
          return updated;
        }
        return { id: col.id };
      });

      const result = await fetchAPI(ENFYRA_API_URL, `/table_definition/${tableId}`, {
        method: 'PATCH',
        body: JSON.stringify({ columns }),
      });

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
        .map(col => ({ id: col.id }));

      const result = await fetchAPI(ENFYRA_API_URL, `/table_definition/${tableId}`, {
        method: 'PATCH',
        body: JSON.stringify({ columns }),
      });

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
      onDelete: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).optional().default('SET NULL').describe('On delete behavior.'),
    },
    async ({ sourceTableId, targetTableId, type, propertyName, inversePropertyName, isNullable, onDelete }) => {
      const relation = { type, propertyName, inversePropertyName: inversePropertyName || null, isNullable, onDelete };
      const result = await fetchAPI(ENFYRA_API_URL, `/table_definition/${sourceTableId}`, {
        method: 'PATCH',
        body: JSON.stringify({ relations: [{ targetTableId, ...relation }] }),
      });
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
        .map(rel => ({ id: rel.id }));

      const result = await fetchAPI(ENFYRA_API_URL, `/table_definition/${tableId}`, {
        method: 'PATCH',
        body: JSON.stringify({ relations }),
      });

      return {
        content: [{ type: 'text', text: `Relation ${relationId} deleted from table ${tableId}.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );
}
