/**
 * Table & Column tools for Enfyra MCP Server
 */
import { z } from 'zod';
import { fetchAPI } from './fetch.js';

/**
 * Register table tools with MCP server
 */
export function registerTableTools(server, ENFYRA_API_URL) {
  const apiBase = ENFYRA_API_URL.replace(/\/$/, '');
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

  server.tool(
    'create_table',
    [
      'Create a new table definition with an auto-included `id` primary key column.',
      'Use create_column to add more columns after creation.',
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

  server.tool(
    'create_column',
    'Create a column for an existing table. Columns cascade through table_definition. Run schema changes sequentially — migration locks DB per operation.',
    {
      tableId: z.string().describe('Table definition ID (from get_all_tables or create_table).'),
      name: z.string().describe('Column name (e.g., "title", "user_id"). Lowercase with underscores.'),
      type: z.string().describe('Column type: varchar, int, text, boolean, datetime, json, decimal, etc.'),
      length: z.number().optional().describe('Length for varchar types (e.g., 255).'),
      isRequired: z.boolean().optional().default(false).describe('Set to true if column cannot be null.'),
      isUnique: z.boolean().optional().default(false).describe('Set to true for unique constraint.'),
      defaultValue: z.string().optional().describe('Default value as JSON string.'),
      description: z.string().optional().describe('Column description.'),
    },
    async ({ tableId, name, type, length, isRequired, isUnique, defaultValue, description }) => {
      const result = await fetchAPI(ENFYRA_API_URL, '/column_definition', {
        method: 'POST',
        body: JSON.stringify({ tableId, name, type, length, isRequired, isUnique, defaultValue, description }),
      });
      return {
        content: [{ type: 'text', text: `Column created with ID: ${result.id}.\n\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );
}
