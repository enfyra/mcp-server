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
  assertBulkLimit,
  bulkObjectArrayParam,
  parseBulkItemsParam,
  withSchemaQueue,
} from './table-tool-logic.js';
import { createSchemaToolOperations } from './schema-tool-operations.js';

export function registerSchemaColumnTools(server, ENFYRA_API_URL, options: { toolset?: string } = {}) {
  const toolset = options.toolset || 'guided';
  const apiBase = ENFYRA_API_URL.replace(/\/$/, '');
  const {
    appendColumnToTable,
    removeColumnFromTable,
    updateOneColumn,
  } = createSchemaToolOperations(ENFYRA_API_URL, toolset);
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
      'Update one or more columns. Always pass items as a native JSON array; for one column, pass one item. Items run sequentially through the schema queue. Guided mode blocks isUpdatable/isPublished false→true broadening. Do not set isUpdatable=true merely to seed E2E data or let a custom action change a server-owned field; use an exact trusted internal write after authorization and preserve the canonical metadata contract.',
      {
        items: bulkObjectArrayParam(z, 'Column update items').describe('Native JSON array of column update items: [{ tableId, columnId, name?, type?, isNullable?, isPublished?, isUpdatable?, defaultValue?, description?, options?, allowContractBroadening? }]. Guided mode blocks false→true isUpdatable/isPublished changes. Expert full mode requires allowContractBroadening=true; never use broadening only for custom-action writes or test fixtures.'),
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
}
