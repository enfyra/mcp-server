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
  RelationPatch,
  assertColumnContractBroadening,
  assertColumnNameCanBeCreated,
  assertIndexesDoNotReferenceUniqueFields,
  assertNoColumnRelationNameCollision,
  assertNoForbiddenRelationKeys,
  buildColumnDefinition,
  buildPrimaryColumnForDbType,
  fetchTableWithDetails,
  getId,
  getPatchableColumns,
  getSupportedColumnTypesFromMetadata,
  mergeConstraintGroups,
  normalizeColumnForTablePatch,
  normalizeColumnOptionsValue,
  normalizeColumnTypeForLiveMetadata,
  normalizeColumnsForLiveMetadata,
  normalizeConstraintGroupsValue,
  normalizeRelationForTablePatch,
  parseJsonArrayParam,
  patchTableAutoConfirm,
  pruneIndexesThatOverlapUniques,
  resolveRelationConstraintGroups,
  resolveTableIdentifierFromMetadata,
  sanitizeExistingRelationForTablePatch,
  splitRelationConstraintGroups,
  stripAutoManagedColumns,
  summarizeCreatedTableSchema,
  verifyColumnCascade,
  verifyRelationCascade,
  withSchemaQueue,
} from './table-tool-logic.js';

export function createSchemaToolOperations(ENFYRA_API_URL, toolset) {
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
      const afterColumns = await verifyColumnCascade(ENFYRA_API_URL, tableId, beforeIds, {
        action: 'delete',
        columnId,
      });
  
      return jsonContent({
        action: 'column_deleted',
        tableId,
        columnId,
        result,
        postcondition: {
          verificationMethod: 'table_schema_column_ids',
          confirmedAbsent: !afterColumns.some((column) => String(getId(column)) === String(columnId)),
          remainingColumnIds: afterColumns
            .filter((column) => String(getId(column)) === String(columnId))
            .map(getId),
        },
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
      const afterRelations = await verifyRelationCascade(ENFYRA_API_URL, tableId, beforeIds, {
        action: 'delete',
        relationId,
      });
  
      return jsonContent({
        action: 'relation_deleted',
        tableId,
        relationId,
        result,
        postcondition: {
          verificationMethod: 'table_schema_relation_ids',
          confirmedAbsent: !afterRelations.some((relation) => String(getId(relation)) === String(relationId)),
          remainingRelationIds: afterRelations
            .filter((relation) => String(getId(relation)) === String(relationId))
            .map(getId),
        },
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
  	    const schemaNormalizations = [
  	      ...(args._requestedTableName ? [{ field: 'name', from: args._requestedTableName, to: args.name, reason: 'Enfyra table names are lowercase.' }] : []),
  	      ...normalizations,
  	    ];
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
        schemaNormalization: schemaNormalizations,
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

  async function deleteOneTable({ tableId, tableName, expectedTableId, confirm }) {
      const resolvedTableId = tableId ?? resolveTableIdentifierFromMetadata(await fetchTableCatalog(ENFYRA_API_URL), tableName, 'delete_tables item tableName');
      if (confirm && tableName && !tableId && !expectedTableId) {
        throw new Error(`expectedTableId is required when confirming tableName "${tableName}". Pass the tableId returned by the preview.`);
      }
      if (confirm && expectedTableId && String(expectedTableId) !== String(resolvedTableId)) {
        throw new Error(`Table id mismatch: resolved ${resolvedTableId}, expected ${expectedTableId}.`);
      }
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
      let postcondition;
      try {
        const catalog = await fetchTableCatalog(ENFYRA_API_URL);
        const remainingTables = catalog
          .filter((table) => (
            String(getId(table)) === String(resolvedTableId)
            || table.name === tableData.name
          ))
          .map((table) => ({ id: getId(table), name: table.name }));
        postcondition = {
          verificationMethod: 'table_catalog_by_id_and_name',
          confirmedAbsent: remainingTables.length === 0,
          remainingTables,
        };
      } catch (error) {
        postcondition = {
          verificationMethod: 'table_catalog_by_id_and_name',
          confirmedAbsent: false,
          remainingTables: [],
          verificationError: String((error as any)?.message || error),
        };
      }
      return {
        action: 'table_deleted',
        tableId: resolvedTableId,
        tableName: tableData.name,
        result,
        postcondition,
      };
    }

  async function updateOneColumn({ tableId, columnId, name, type, isNullable, isPublished, isUpdatable, defaultValue, description, options, allowContractBroadening }) {
      const tableData = await fetchTableWithDetails(ENFYRA_API_URL, tableId);
      if (!tableData) {
        throw new Error(`Table with ID ${tableId} not found.`);
      }
  
      const existingColumns = getPatchableColumns(tableData.columns);
      const beforeIds = existingColumns.map((column) => String(getId(column)));
      if (!beforeIds.includes(String(columnId))) {
        throw new Error(`Column ${columnId} was not found on table ${tableId}; refusing schema cascade patch.`);
      }
      const existingColumn = existingColumns.find((column) => String(getId(column)) === String(columnId));
      const contractBroadening = assertColumnContractBroadening(existingColumn || {}, {
        isPublished,
        isUpdatable,
        allowContractBroadening,
      }, toolset);
  
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
        contractBroadening,
        result,
      };
    }
  return {
    appendColumnToTable,
    appendRelationToTable,
    applyDeferredConstraints,
    arrayValue,
    createOneTable,
    deleteOneTable,
    removeColumnFromTable,
    removeRelationFromTable,
    updateOneColumn,
    updateOneTable,
  };
}
