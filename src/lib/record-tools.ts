/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
// Import modules
import { exchangeApiToken, refreshAccessToken, getValidToken, resetTokens, getTokenExpiry, initAuth } from './auth.js';
import { fetchAPI, validateFilter, validateTableName } from './fetch.js';
import {
  fetchMetadataContext,
  fetchMetadataTables,
  fetchTableCatalog,
  fetchTableMetadata,
  fetchTableMetadataByRef,
} from './metadata-client.js';
import { buildMcpServerInstructions, buildGraphqlUrls } from './mcp-instructions.js';
import { getExamples, listExampleCategories } from './mcp-examples.js';
import { WORKFLOW_SURFACES, discoverWorkflowRoutes } from './tool-routing.js';
import { getSupportedColumnTypesFromMetadata, registerTableTools } from './table-tools.js';
import { registerPlatformOperationTools, validateExtensionCode } from './platform-operation-tools.js';
import { registerRuntimeZoneTools } from './runtime-zone-tools.js';
import { registerOAuthProviderTools } from './oauth-tools.js';
import { registerDynamicRepositoryBuilder } from './dynamic-repository-builder.js';
import { buildDynamicScriptContextTypeContract } from './dynamic-script-context-contract.js';
import { assertCreateHandlerRouteBoundary } from './dynamic-endpoint-contract.js';
import { assertGenericRecordMutationAllowed, parseRecordBatchData, parseRecordData, prepareRecordBatchMutation, prepareRecordMutation, validatePortableScriptSource, validateScriptSourceIfPresent } from './mutation-guards.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAckIf,
  assertGlobalRulesAck,
  acknowledgeRequiredKnowledge,
  buildRequiredKnowledgePayload,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';
import { validateMainTableRoutePath } from './route-guards.js';
import { assertRecordFieldsReadable, buildDeletePostcondition, buildQuerySchemaReceipt } from './record-contracts.js';
import { installColumnarToolFormatter, jsonContent } from './response-format.js';
import { startMcpUsageTelemetry } from './mcp-usage-telemetry.js';
import { startRuntimeCacheSocket } from './runtime-cache-socket.js';
import { executeSequentialBatch } from './sequential-batch.js';
import { compactSourceFields, readSourceArtifactResource, writeSourceArtifact } from './source-artifacts.js';
import { installToolsetFilter, normalizeDynamicToolPacks, normalizeMcpProfile, normalizeMcpToolset, summarizeToolsetForInstructions } from './toolset-filter.js';
import { installToolAnnotations } from './tool-contracts.js';
import { installToolOutputContracts } from './tool-output-contracts.js';
import { registerToolCatalogTools } from './tool-catalog.js';
import { registerWorkflowToolPack } from './workflow-tool-packs.js';
import type { ToolAvailability } from './types.js';
import {
  findRoutePermission,
  mergeMethodNames,
  normalizeMethodNames,
  resolveRoleByNameOrId,
  routeAvailableMethodNames,
  routePublicMethodNames,
  summarizeRouteAccess,
  summarizeRoutePermission,
  validateMethodsForRoute,
} from './route-permission-tools.js';
import {
  appendQuery,
  applyDeepFieldSelections,
  assertExtensionReadFields,
  assertKnowledgeForGenericBatchMutation,
  assertKnowledgeForGenericMutation,
  assertMaxBulkItems,
  assertNoDuplicateBulkIds,
  bulkObjectArrayParam,
  getPrimaryFieldName,
  getTableSummary,
  isNotFoundDeleteError,
  jsonObjectParam,
  normalizeSortParam,
  parseBulkItemsArg,
  parseJsonArg,
  parseQueryParamsArg,
  prepareGenericBatchMutation,
  prepareGenericMutation,
  stringifyJsonArg,
  summarizeMutationResult,
  validateExtensionCodeForGenericMutation,
} from './enfyra-tool-logic.js';

export function registerRecordTools(server, ENFYRA_API_URL) {
  server.tool('query_table', 'Query any route-backed table with a live metadata preflight. Explicit fields are validated before the REST read and the result includes schemaReceipt, so a separate metadata call is optional unless the schema itself must be inspected. Response is minimal unless fields is explicit. Every call must pass either limit or all=true. OAuth clientId/clientSecret are write-only and cannot be read; ask the user and use setup_oauth_provider. Use count_records or meta=filterCount/totalCount for counts; call discover_query_capabilities before using aggregate objects instead of guessing _sum/_count operators. For enfyra_extension, editable extension source is `code`, not `sourceCode`; prefer search_admin_extensions and patch_extension_code/update_extension_code for admin UI.', {
    tableName: z.string().describe('Table name to query'),
    filter: jsonObjectParam(z, 'Filter object').optional().describe('Filter object. Example: {"status": {"_eq": "active"}}.'),
    sort: z.string().optional().describe('Sort field. Prefix with - for descending (e.g., "createdAt", "-id")'),
    page: z.number().optional().describe('Page number (default: 1)'),
    limit: z.number().int().min(0).optional().describe('Items per page. Required unless all=true. Do not invent arbitrary limits for "all"; use all=true instead. Use count_records for counts.'),
    all: z.boolean().optional().default(false).describe('Return all matching rows by sending REST limit=0. Use this when the user asks for all rows or a complete list.'),
    fields: z.array(z.string()).optional().describe('Fields to select. If omitted, MCP selects only the table primary key to avoid oversized responses.'),
    meta: z.string().optional().describe('Optional REST meta request, e.g. "totalCount", "filterCount", or aggregate modes supported by the route. Use count_records for simple counts.'),
    deep: jsonObjectParam(z, 'Deep relation fetch object').optional().describe('Optional deep relation fetch object. Keys must be relation propertyName values.'),
    aggregate: jsonObjectParam(z, 'Aggregate object').optional().describe('Optional aggregate object keyed by real fields/relations, only after discover_query_capabilities confirms the supported operator shape for this table/route. Results are returned in response.meta.aggregate when supported. Do not guess _sum/_count; use count_records or meta=filterCount/totalCount for counts. Do not request aggregates over hidden fields/private relations in user-facing APIs.'),
  }, async ({ tableName, filter, sort, page, limit, all, fields, meta, deep, aggregate }) => {
    if (!all && limit === undefined) {
      throw new Error('query_table requires either limit or all=true. Do not rely on implicit default page sizes.');
    }
    if (all && limit !== undefined) {
      throw new Error('query_table accepts either all=true or limit, not both.');
    }
    validateTableName(tableName);
    assertExtensionReadFields(tableName, fields);
    assertRecordFieldsReadable(tableName, fields);
    const filterParam = stringifyJsonArg(filter);
    const deepParam = stringifyJsonArg(deep);
    const aggregateParam = stringifyJsonArg(aggregate);
    validateFilter(filter);
    parseJsonArg(deep, undefined);
    parseJsonArg(aggregate, undefined);
  
    const queryParams = new URLSearchParams();
    const table = await getTableSummary(tableName);
    const primaryKey = await getPrimaryFieldName(tableName, table);
    const requestedFields = fields && fields.length > 0 ? fields : [primaryKey];
    const deepFieldSelection = applyDeepFieldSelections(requestedFields, deep);
    const selectedFields = deepFieldSelection.fields;
    const schemaReceipt = buildQuerySchemaReceipt({ ...table, primaryKey }, selectedFields);
    if (filterParam) queryParams.set('filter', filterParam);
    const normalizedSort = normalizeSortParam(sort);
    if (normalizedSort) queryParams.set('sort', normalizedSort);
    if (page) queryParams.set('page', String(page));
    if (meta) queryParams.set('meta', meta);
    if (deepParam) queryParams.set('deep', deepParam);
    if (aggregateParam) queryParams.set('aggregate', aggregateParam);
    const effectiveLimit = all ? 0 : limit;
    queryParams.set('limit', String(effectiveLimit));
    queryParams.set('fields', selectedFields.join(','));
  
    const query = queryParams.toString();
    const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}${query ? `?${query}` : ''}`);
    const payload = {
      statusCode: result?.statusCode,
      success: result?.success,
      tableName,
      requestedFields,
      fields: selectedFields,
      autoAddedDeepFields: deepFieldSelection.autoAdded,
      limit: effectiveLimit,
      all: !!all,
      queryOptions: {
        meta: meta || null,
        deep: deep ? parseJsonArg(deep, null) : null,
        aggregate: aggregate ? parseJsonArg(aggregate, null) : null,
      },
      minimalDefaultApplied: !(fields && fields.length > 0),
      schemaReceipt,
      meta: result?.meta,
      data: compactSourceFields(result?.data || [], { tableName }),
      detailHint: fields && fields.length > 0
        ? undefined
        : 'Only the primary key was returned because fields was omitted. Re-run query_table with explicit fields for details, or use inspect_table to find valid field names.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  });

  server.tool(
    'count_records',
    [
      'Count records in a route-backed Enfyra table using the lightweight REST meta pattern.',
      'Without filter it requests fields=id&limit=1&meta=totalCount and returns meta.totalCount.',
      'With filter it requests fields=id&limit=1&meta=filterCount and returns meta.filterCount.',
      'Use this instead of fetching rows when the user only needs a count.',
    ].join(' '),
  	  {
  	    tableName: z.string().describe('Table name to count. Must have a REST route.'),
  	    filter: jsonObjectParam(z, 'Filter object').optional().describe('Optional Query DSL filter object. Example: {"status":{"_eq":"active"}}.'),
  	  },
  	  async ({ tableName, filter }) => {
  	    validateTableName(tableName);
  	    validateFilter(filter);
  	    const filterParam = stringifyJsonArg(filter);
  	
  	    const metaField = filterParam ? 'filterCount' : 'totalCount';
      const queryParams = new URLSearchParams();
      queryParams.set('fields', 'id');
      queryParams.set('limit', '1');
      queryParams.set('meta', metaField);
  	    if (filterParam) queryParams.set('filter', filterParam);
  
      const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}?${queryParams.toString()}`);
      const meta = result?.meta || {};
      const hasCount = Object.prototype.hasOwnProperty.call(meta, metaField);
      const count = hasCount ? Number(meta[metaField]) : null;
      const payload = {
        tableName,
        count,
        countField: metaField,
  	      filterApplied: !!filterParam,
        meta,
        request: {
          path: `/${tableName}`,
          query: Object.fromEntries(queryParams.entries()),
        },
        warning: hasCount ? undefined : `Response meta did not include ${metaField}.`,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.tool(
    'find_one_record',
    'Find a single record by ID or filter. By ID uses GET with filter (Enfyra has no GET /table/:id route). OAuth clientId/clientSecret are write-only and cannot be read; ask the user and use setup_oauth_provider. For enfyra_extension, editable extension source is `code`, not `sourceCode`; prefer search_admin_extensions and patch_extension_code/update_extension_code for admin UI.',
    {
  	    tableName: z.string().describe('Table name'),
  	    id: z.string().optional().describe('Record ID'),
  	    filter: jsonObjectParam(z, 'Filter object').optional().describe('Filter object to find by.'),
      fields: z.array(z.string()).optional().describe('Fields to select. If omitted, returns only the primary key.'),
    },
    async ({ tableName, id, filter, fields }) => {
      validateTableName(tableName);
      assertExtensionReadFields(tableName, fields);
      assertRecordFieldsReadable(tableName, fields);
      const primaryKey = await getPrimaryFieldName(tableName);
      const selectedFields = fields && fields.length > 0 ? fields : [primaryKey];
      if (id) {
        // Enfyra route engine does not register GET /<table>/:id (only PATCH/DELETE use /:id). Use list + filter.
        const filterObj = JSON.stringify({ [primaryKey]: { _eq: id } });
        const queryParams = new URLSearchParams({
          filter: filterObj,
          limit: '1',
          fields: selectedFields.join(','),
        });
        const result = await fetchAPI(
          ENFYRA_API_URL,
          `/${tableName}?${queryParams.toString()}`,
        );
        const one = result.data?.[0] ?? null;
        return { content: [{ type: 'text', text: JSON.stringify({
          tableName,
          primaryKey,
          fields: selectedFields,
          data: compactSourceFields(one, { tableName }),
          detailHint: fields && fields.length > 0 ? undefined : 'Only the primary key was returned. Pass fields for details.',
        }, null, 2) }] };
      }
  	    if (!filter) throw new Error('Provide id or filter');
  	    validateFilter(filter);
  	    const filterParam = stringifyJsonArg(filter);
  	    const queryParams = new URLSearchParams({
  	      filter: filterParam || '',
        limit: '1',
        fields: selectedFields.join(','),
      });
      const result = await fetchAPI(
        ENFYRA_API_URL,
        `/${tableName}?${queryParams.toString()}`,
      );
      return { content: [{ type: 'text', text: JSON.stringify({
        tableName,
        fields: selectedFields,
        data: compactSourceFields(result.data?.[0] || null, { tableName }),
        detailHint: fields && fields.length > 0 ? undefined : 'Only the primary key was returned. Pass fields for details.',
      }, null, 2) }] };
    },
  );

  // ============================================================================
  // CRUD TOOLS
  // ============================================================================
  
  server.tool('create_records', 'Create one or more route-backed records. Always pass records as a native JSON array; for one record, pass a one-item array. MCP preflights every item before the first POST, then writes sequentially; this is not a backend bulk endpoint or transaction. On a failed item, it returns the completed checkpoint and remaining indexes—retry only the remaining records after resolving the error.', {
    tableName: z.string().describe('Table name to insert into'),
    records: bulkObjectArrayParam(z, 'Records').describe('Records as a native JSON array. Each item must be a JSON object using metadata-backed column names and relation propertyName values.'),
    queryParams: z.string().optional().describe('Optional query params as JSON object string applied to every POST, for route contracts that intentionally keep workflow fields out of the validated body.'),
    maxRecords: z.number().int().min(1).max(100).optional().default(20).describe('Safety cap for one MCP batch. Default is 20; explicitly raise it up to 100 only when partial-write recovery is acceptable.'),
    globalRulesAckKey: globalRulesAckParam(z),
    knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required only when any item contains sourceCode. Use dynamicCodeAckKey from get_enfyra_required_knowledge.'),
    extensionKnowledgeAckKey: extensionKnowledgeAckParam(z).optional().describe('Required only when tableName is enfyra_extension and any item contains code. Use extensionAckKey from get_enfyra_required_knowledge.'),
  }, async ({ tableName, records, queryParams, maxRecords, globalRulesAckKey, knowledgeAckKey, extensionKnowledgeAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    validateTableName(tableName);
    assertGenericRecordMutationAllowed('create', tableName);
    const parsedRecords = parseRecordBatchData(records);
    if (parsedRecords.length > maxRecords) {
      throw new Error(`create_records received ${parsedRecords.length} records, above maxRecords=${maxRecords}. Split the batch deliberately.`);
    }
    assertKnowledgeForGenericBatchMutation(tableName, parsedRecords, { knowledgeAckKey, extensionKnowledgeAckKey });
    const prepared = await prepareGenericBatchMutation(tableName, parsedRecords);
    const extensionValidations = [];
    for (const item of prepared.records) {
      extensionValidations.push(await validateExtensionCodeForGenericMutation(tableName, item.payload, item.payload?.name || item.index));
    }
    const query = parseQueryParamsArg(queryParams);
    const batch = await executeSequentialBatch(prepared.records, async (item) => {
      const result = await fetchAPI(ENFYRA_API_URL, appendQuery(`/${tableName}`, query), { method: 'POST', body: JSON.stringify(item.payload) });
      return {
        index: item.index,
        ...summarizeMutationResult(result, 'created', tableName),
      };
    });
    if (batch.status === 'partial_failure') {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({
          action: 'create_records_partial_failure',
          tableName,
          requested: parsedRecords.length,
          createdCount: batch.completed.length,
          sequential: true,
          transactional: false,
          completed: batch.completed,
          failed: batch.failure,
          remainingIndexes: batch.remainingIndexes,
          retryHint: 'Resolve the failed item, then retry only the failed item and remaining indexes. Do not retry completed records unless the table has an idempotent unique key.',
        }, null, 2) }],
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify({
      action: 'created_records',
      tableName,
      requested: parsedRecords.length,
      createdCount: batch.completed.length,
      sequential: true,
      transactional: false,
      preflight: {
        liveMetadataFieldsValidated: true,
        scriptValidatedBeforeAnyPost: prepared.records.some((item) => item.scriptValidation?.validated === true),
        extensionValidatedBeforeAnyPost: extensionValidations.some(Boolean),
      },
      created: batch.completed,
      detailHint: `Use query_table({ tableName: "${tableName}", fields: [...], limit: ${Math.min(batch.completed.length, 20)} }) to inspect created records when needed.`,
    }, null, 2) }] };
  });

  server.tool('update_records', 'Update one or more records in one MCP call. Pass items as a native JSON array; for one update, pass one item. MCP preflights every item, rejects duplicate ids, then PATCHes sequentially. On a failed item, it returns the completed checkpoint and remaining indexes so callers do not replay prior updates.', {
    tableName: z.string().describe('Table name'),
    items: bulkObjectArrayParam(z, 'Update items').describe('Native JSON array of update items: [{ "id": "...", "data": { ... }, "queryParams": { ... }? }]. data must use metadata-backed column names and relation propertyName values.'),
    maxItems: z.number().int().min(1).max(100).optional().default(20).describe('Safety cap for one MCP batch. Default is 20; explicitly raise it up to 100 only when partial-write recovery is acceptable.'),
    globalRulesAckKey: globalRulesAckParam(z),
    knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required only when any item.data contains sourceCode. Use dynamicCodeAckKey from get_enfyra_required_knowledge.'),
    extensionKnowledgeAckKey: extensionKnowledgeAckParam(z).optional().describe('Required only when tableName is enfyra_extension and any item.data contains code. Use extensionAckKey from get_enfyra_required_knowledge.'),
  }, async ({ tableName, items, maxItems, globalRulesAckKey, knowledgeAckKey, extensionKnowledgeAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    validateTableName(tableName);
    assertGenericRecordMutationAllowed('update', tableName);
    const parsedItems = parseBulkItemsArg('items', items);
    assertMaxBulkItems('update_records', parsedItems, maxItems);
    assertNoDuplicateBulkIds('update_records', parsedItems);
  
    const preparedItems = [];
    const extensionValidations = [];
    for (const [index, item] of parsedItems.entries()) {
      if (!item.id) throw new Error(`items[${index}].id is required.`);
      if (!item.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
        throw new Error(`items[${index}].data must be a JSON object.`);
      }
      assertKnowledgeForGenericMutation(tableName, JSON.stringify(item.data), { knowledgeAckKey, extensionKnowledgeAckKey });
      const prepared = await prepareGenericMutation(tableName, JSON.stringify(item.data));
      preparedItems.push({ index, id: item.id, queryParams: item.queryParams, prepared });
      extensionValidations.push(await validateExtensionCodeForGenericMutation(tableName, prepared.payload, item.id));
    }
  
    const batch = await executeSequentialBatch(preparedItems, async (item) => {
      const query = parseQueryParamsArg(JSON.stringify(item.queryParams || {}));
      const result = await fetchAPI(ENFYRA_API_URL, appendQuery(`/${tableName}/${encodeURIComponent(String(item.id))}`, query), { method: 'PATCH', body: JSON.stringify(item.prepared.payload) });
      return {
        index: item.index,
        id: item.id,
        ...summarizeMutationResult(result, 'updated', tableName),
      };
    });
    if (batch.status === 'partial_failure') {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({
          action: 'update_records_partial_failure',
          tableName,
          requested: parsedItems.length,
          updatedCount: batch.completed.length,
          sequential: true,
          completed: batch.completed,
          failed: batch.failure,
          remainingIndexes: batch.remainingIndexes,
          retryHint: 'Resolve the failed item, then retry only the failed item and remaining indexes. Do not replay completed updates unless the new value is deliberately idempotent.',
        }, null, 2) }],
      };
    }
  
    return { content: [{ type: 'text', text: JSON.stringify({
      action: 'updated_records',
      tableName,
      requested: parsedItems.length,
      updatedCount: batch.completed.length,
      sequential: true,
      duplicateIdsRejected: true,
      preflight: {
        liveMetadataFieldsValidated: true,
        scriptValidatedBeforeAnyPatch: preparedItems.some((item) => item.prepared.scriptValidation?.validated === true),
        extensionValidatedBeforeAnyPatch: extensionValidations.some(Boolean),
      },
      updated: batch.completed,
    }, null, 2) }] };
  });

  server.tool('delete_records', 'Delete one or more route-backed records in one MCP call. Pass items as a native JSON array; for one delete, pass one item. The tool previews every target when confirm=false, rejects duplicate ids, and deletes sequentially when confirm=true. Confirmed deletes automatically re-read the requested primary keys and return postcondition.confirmedAbsent plus remainingIds, so a separate absence query is optional. By default, confirm=true skips records that were already removed by cascade or a previous cleanup step.', {
    tableName: z.string().describe('Table name'),
    items: bulkObjectArrayParam(z, 'Delete items').describe('Native JSON array of delete items: [{ "id": "...", "queryParams": { ... }? }].'),
    maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one MCP batch. Default/max is 100.'),
    confirm: z.boolean().optional().default(false).describe('Required true to apply destructive deletes. Omit/false returns previews only.'),
    skipNotFound: z.boolean().optional().default(true).describe('When confirm=true, continue if a target is already gone, for example because a previous delete cascaded child records. Default true.'),
    globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
  }, async ({ tableName, items, maxItems, confirm, skipNotFound, globalRulesAckKey }) => {
    validateTableName(tableName);
    assertGenericRecordMutationAllowed('delete', tableName);
    const parsedItems = parseBulkItemsArg('items', items);
    assertMaxBulkItems('delete_records', parsedItems, maxItems);
    assertNoDuplicateBulkIds('delete_records', parsedItems);
    for (const [index, item] of parsedItems.entries()) {
      if (!item.id) throw new Error(`items[${index}].id is required.`);
    }
  
    const primaryKey = await getPrimaryFieldName(tableName);
    if (!confirm) {
      const previews = [];
      for (const [index, item] of parsedItems.entries()) {
        const query = new URLSearchParams({
          filter: JSON.stringify({ [primaryKey]: { _eq: item.id } }),
          limit: '1',
          fields: primaryKey,
        });
        const preview = await fetchAPI(ENFYRA_API_URL, `/${tableName}?${query.toString()}`).catch((error) => ({ error: String(error?.message || error) }));
        previews.push({
          index,
          id: item.id,
          preview: preview?.data?.[0] || null,
          previewError: preview?.error,
        });
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        action: 'delete_records_preview',
        tableName,
        primaryKey,
        requested: parsedItems.length,
        duplicateIdsRejected: true,
        destructive: true,
        previews,
        postcondition: {
          verificationMethod: 'not_run_preview',
          requestedIds: parsedItems.map((item) => item.id),
          remainingIds: previews.filter((item) => item.preview).map((item) => item.id),
          confirmedAbsent: false,
        },
        next: 'Call delete_records again with the same items and confirm=true to delete these route-backed records sequentially.',
      }, null, 2) }] };
    }
  
  	  assertGlobalRulesAck(globalRulesAckKey);
  	  const deleted = [];
  	  const skippedNotFound = [];
  	  for (const [index, item] of parsedItems.entries()) {
  	    const query = parseQueryParamsArg(JSON.stringify(item.queryParams || {}));
  	    try {
  	      const result = await fetchAPI(ENFYRA_API_URL, appendQuery(`/${tableName}/${encodeURIComponent(String(item.id))}`, query), { method: 'DELETE' });
  	      deleted.push({
  	        index,
  	        id: item.id,
  	        statusCode: result?.statusCode,
  	        success: result?.success,
  	      });
  	    } catch (error) {
  	      if (skipNotFound && isNotFoundDeleteError(error)) {
  	        skippedNotFound.push({
  	          index,
  	          id: item.id,
  	          skipped: true,
  	          reason: 'not_found',
  	        });
  	        continue;
  	      }
  	      throw error;
  	    }
  	  }
  	  const requestedIds = parsedItems.map((item) => item.id);
  	  let postcondition;
  	  try {
  	    const verificationQuery = new URLSearchParams({
  	      filter: JSON.stringify({ [primaryKey]: { _in: requestedIds } }),
  	      limit: String(parsedItems.length),
  	      fields: primaryKey,
  	    });
  	    const verification = await fetchAPI(ENFYRA_API_URL, `/${tableName}?${verificationQuery.toString()}`);
  	    postcondition = buildDeletePostcondition(requestedIds, verification?.data ?? [], primaryKey);
  	  } catch (error) {
  	    postcondition = {
  	      verificationMethod: 'route_read_by_primary_keys',
  	      requestedIds,
  	      remainingIds: [],
  	      confirmedAbsent: false,
  	      verificationError: String((error as any)?.message || error),
  	    };
  	  }
  	  return { content: [{ type: 'text', text: JSON.stringify({
  	    action: 'deleted_records',
  	    tableName,
  	    requested: parsedItems.length,
  	    deletedCount: deleted.length,
  	    skippedNotFoundCount: skippedNotFound.length,
  	    sequential: true,
  	    duplicateIdsRejected: true,
  	    skipNotFound,
  	    deleted,
  	    skippedNotFound,
  	    postcondition,
  	  }, null, 2) }] };
  	});
}
