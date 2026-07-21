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
  FORBIDDEN_RELATION_KEYS,
  assertBulkLimit,
  bulkObjectArrayParam,
  computeBatchCleanupOrder,
  getId,
  getSupportedColumnTypesFromMetadata,
  metadataColumnNames,
  metadataColumnOptions,
  normalizeCreateTableDefinitions,
  normalizeRelationType,
  parseBulkItemsParam,
  preflightCreateTableDefinitions,
  withSchemaQueue,
} from './table-tool-logic.js';
import { createSchemaToolOperations } from './schema-tool-operations.js';

export function registerSchemaTableTools(server, ENFYRA_API_URL, options: { toolset?: string } = {}) {
  const toolset = options.toolset || 'guided';
  const apiBase = ENFYRA_API_URL.replace(/\/$/, '');
  const {
    appendRelationToTable,
    applyDeferredConstraints,
    createOneTable,
    deleteOneTable,
    updateOneTable,
  } = createSchemaToolOperations(ENFYRA_API_URL, toolset);
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
  	      const parsedItems = normalizeCreateTableDefinitions(parseBulkItemsParam('items', items ?? tables));
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
  	        created: toolset === 'full' ? created : created.map(({ result, supportedColumnTypes, schema, ...item }) => ({
  	          ...item,
  	          schema: {
  	            intended: schema?.intended,
  	            liveMetadataAvailable: schema?.liveMetadataAvailable,
  	            liveMetadataError: schema?.liveMetadataError,
  	          },
  	        })),
  	        createdRelations: toolset === 'full' ? createdRelations : createdRelations.map(({ result, responseFormat, ...item }) => item),
  	        appliedDeferredConstraints: toolset === 'full' ? appliedDeferredConstraints : appliedDeferredConstraints.map(({ result, ...item }) => item),
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
}
