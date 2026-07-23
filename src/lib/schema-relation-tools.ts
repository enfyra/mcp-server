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
} from './table-tool-logic.js';
import { createSchemaToolOperations } from './schema-tool-operations.js';
import { destructivePreviewContent } from './destructive-preview.js';
import { executeSequentialBatch } from './sequential-batch.js';

export function registerSchemaRelationTools(server, ENFYRA_API_URL, options: { toolset?: string } = {}) {
  const toolset = options.toolset || 'guided';
  const apiBase = ENFYRA_API_URL.replace(/\/$/, '');
  const {
    appendRelationToTable,
    removeRelationFromTable,
  } = createSchemaToolOperations(ENFYRA_API_URL, toolset);
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
      'Delete one or more relations. Always pass items as a native JSON array; for one relation, pass one item. confirm=false previews every target; confirm=true deletes sequentially and verifies schema absence. Partial failures return a checkpoint and require a new preview before retry.',
      {
        items: bulkObjectArrayParam(z, 'Relation delete items').describe('Native JSON array of delete items: [{ tableId, relationId }].'),
        maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one schema batch. Default/max is 100.'),
        confirm: z.boolean().optional().default(false).describe('Required true to apply destructive deletes. Omit/false returns previews only.'),
        globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
      },
      async ({ items, maxItems, confirm, globalRulesAckKey }) => {
        const parsedItems = parseBulkItemsParam('items', items);
        assertBulkLimit('delete_relations', parsedItems, maxItems);
        for (const [index, item] of parsedItems.entries()) {
          if (!item.tableId) throw new Error(`items[${index}].tableId is required.`);
          if (!item.relationId) throw new Error(`items[${index}].relationId is required.`);
        }
        if (confirm) assertGlobalRulesAck(globalRulesAckKey);
        if (!confirm) {
          const results: AnyRecord[] = [];
          for (const [index, item] of parsedItems.entries()) {
            const result = await removeRelationFromTable({ ...item, confirm: false, globalRulesAckKey });
            results.push({ index, ...JSON.parse(result.content[0].text) });
          }
          const payload = {
            action: 'delete_relations_preview',
            requested: parsedItems.length,
            sequential: true,
            destructive: true,
            results,
            postcondition: {
              verificationMethod: 'not_run_preview',
              confirmedAbsent: false,
              remainingRelationIds: results.map((item) => item.relationId),
            },
            next: 'Call delete_relations again with the same items and confirm=true to delete sequentially.',
          };
          return destructivePreviewContent('delete_relations', payload, parsedItems.length);
        }

        const batch = await executeSequentialBatch(parsedItems, async (item, index) => {
          const result = await removeRelationFromTable({ ...item, confirm: true, globalRulesAckKey });
          return { index, ...JSON.parse(result.content[0].text) };
        });
        const results = batch.completed;
        const payload = {
          action: batch.status === 'completed' ? 'relations_deleted' : 'delete_relations_partial_failure',
          requested: parsedItems.length,
          sequential: true,
          destructive: true,
          results,
          postcondition: {
            verificationMethod: 'table_schema_relation_ids',
            confirmedAbsent: batch.status === 'completed'
              && results.every((item) => item.postcondition?.confirmedAbsent === true),
            remainingRelationIds: results.flatMap((item) => item.postcondition?.remainingRelationIds || []),
          },
          ...(batch.status === 'partial_failure' ? {
            status: 'partial_failure',
            failure: batch.failure,
            remainingIndexes: batch.remainingIndexes,
            requiresNewPreview: true,
          } : {}),
        };
        const result = jsonContent(payload);
        return batch.status === 'partial_failure' ? { ...result, isError: true } : result;
      }
    );
}
