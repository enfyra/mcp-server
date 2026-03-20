/**
 * Table & Column tools for Enfyra MCP Server
 */
import { z } from 'zod';
import { fetchAPI, validateTableName } from './fetch.js';

/**
 * Register table tools with MCP server
 */
export function registerTableTools(server, ENFYRA_API_URL) {
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
    'Create a new table definition. After creating a table, use create_column to add columns.',
    {
      name: z.string().describe('Table name (e.g., "user_definition", "my_custom_table"). Must be unique, lowercase with underscores.'),
      alias: z.string().optional().describe('Table alias for API. If not provided, the table name will be used.'),
      description: z.string().optional().describe('Description of what this table stores.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable table. Set to false to disable.'),
    },
    async ({ name, alias, description, isEnabled }) => {
      const result = await fetchAPI(ENFYRA_API_URL, '/table_definition', {
        method: 'POST',
        body: JSON.stringify({ name, alias, description, isEnabled }),
      });
      return {
        content: [{ type: 'text', text: `Table created successfully with ID: ${result.id}. Next step: use create_column to add columns (tableId: ${result.id}).\n\nFull result:\n${JSON.stringify(result, null, 2)}` }],
      };
    }
  );

  server.tool(
    'create_column',
    'Create a column for an existing table. Columns cascade through table_definition.',
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
