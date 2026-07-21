export * from './table-tool-logic.js';
import { registerSchemaColumnTools } from './schema-column-tools.js';
import { registerSchemaRelationTools } from './schema-relation-tools.js';
import { registerSchemaTableTools } from './schema-table-tools.js';

export function registerTableTools(server, ENFYRA_API_URL, options: { toolset?: string } = {}) {
  registerSchemaTableTools(server, ENFYRA_API_URL, options);
  registerSchemaColumnTools(server, ENFYRA_API_URL, options);
  registerSchemaRelationTools(server, ENFYRA_API_URL, options);
}
