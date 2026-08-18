/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { z } from 'zod';
// Import modules
import { destructivePreviewContent } from './destructive-preview.js';
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
  summarizeTable,
  summarizeMutationResult,
  validateExtensionCodeForGenericMutation,
} from './enfyra-tool-logic.js';
import { fetchAPI, validateFilter, validateTableName } from './fetch.js';
import { fetchTableCatalog, fetchTableMetadata } from './metadata-client.js';
import { assertGenericRecordMutationAllowed, parseRecordBatchData, resolveCanonicalTableName } from './mutation-guards.js';
import { validateQueryContract } from './query-contract.js';
import { assertRecordFieldsReadable, buildDeletePostcondition } from './record-contracts.js';
import {
  assertGlobalRulesAck,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam
} from './required-knowledge.js';
import { jsonContent } from './response-format.js';
import { inspectRestProjection } from './rest-projection.js';
import { executeSequentialBatch } from './sequential-batch.js';
import { compactSourceFields } from './source-artifacts.js';

const QUERY_TABLE_ALL_CAP = 1000;

export function registerRecordTools(server, ENFYRA_API_URL) {
  server.tool('query_table', 'Query any route-backed table with a recursive live metadata preflight. Explicit dotted fields and deep relation fields are validated against every target table before the REST read, and the result includes schemaReceipt. Response is minimal unless fields is explicit. Every call must pass either limit or all=true. all=true is capped hard at ' + String(QUERY_TABLE_ALL_CAP) + ' rows and never returns an unbounded result; for more rows, narrow with a filter/range (for example a recent time window) and paginate with limit+page. OAuth clientId/clientSecret are write-only and cannot be read; ask the user and use setup_oauth_provider. Use count_records or meta=filterCount/totalCount for counts. Grouped analytics are a separate dynamic repository aggregate({ filter, dimensions, measures, sort, page, limit }) call, not a query_table option. For enfyra_extension, editable extension source is `code`, not `sourceCode`; prefer search_admin_extensions and patch_extension_code/update_extension_code for admin UI.', {
    tableName: z.string().describe('Table name to query'),
    filter: jsonObjectParam(z, 'Filter object').optional().describe('Filter object to narrow the result set. Prefer a range filter (for example a record time window) over all=true so queries stay bounded. Example: {"status": {"_eq": "active"}}.'),
    sort: z.string().optional().describe('Sort field. Prefix with - for descending (e.g., "createdAt", "-id")'),
    page: z.number().optional().describe('Page number (default: 1). Paginate with limit+page to page through more than one cap-sized batch instead of requesting an unbounded all.'),
    limit: z.number().int().min(0).optional().describe('Items per page. Required unless all=true. Do not invent arbitrary limits for "all"; use all=true instead. Use count_records for counts.'),
    all: z.boolean().optional().default(false).describe('Return matching rows capped at ' + String(QUERY_TABLE_ALL_CAP) + ' rows (never no-limit). Prefer a filter/range; if the result is capped, paginate with limit+page to read further.'),
    fields: z.array(z.string()).optional().describe('Fields to select. If omitted, MCP selects only the table primary key to avoid oversized responses.'),
    meta: z.string().optional().describe('Optional REST meta request, e.g. "totalCount", "filterCount", or aggregate modes supported by the route. Use count_records for simple counts.'),
    deep: jsonObjectParam(z, 'Deep relation fetch object').optional().describe('Optional deep relation fetch object. Keys must be relation propertyName values.'),
  }, async ({ tableName, filter, sort, page, limit, all, fields, meta, deep }) => {
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
    validateFilter(filter);
    const parsedDeep = parseJsonArg(deep, undefined);
  
    const queryParams = new URLSearchParams();
    const table = await getTableSummary(tableName);
    const primaryKey = await getPrimaryFieldName(tableName, table);
    const requestedFields = fields && fields.length > 0 ? fields : [primaryKey];
    const deepFieldSelection = applyDeepFieldSelections(requestedFields, deep);
    const selectedFields = deepFieldSelection.fields;
    const schemaReceipt = await validateQueryContract({
      rootTable: { ...table, primaryKey },
      fields: selectedFields,
      deep: parsedDeep,
      loadTable: async (targetTableName) => summarizeTable(await fetchTableMetadata(ENFYRA_API_URL, targetTableName)),
    });
    if (filterParam) queryParams.set('filter', filterParam);
    const normalizedSort = normalizeSortParam(sort);
    if (normalizedSort) queryParams.set('sort', normalizedSort);
    if (page) queryParams.set('page', String(page));
    if (meta) queryParams.set('meta', meta);
    if (deepParam) queryParams.set('deep', deepParam);
    const effectiveLimit = all ? QUERY_TABLE_ALL_CAP : limit;
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
      cappedByAll: all,
      queryOptions: {
        meta: meta || null,
        deep: parsedDeep ?? null,
      },
      minimalDefaultApplied: !(fields && fields.length > 0),
      schemaReceipt,
      meta: result?.meta,
      data: compactSourceFields(result?.data || [], { tableName }),
      paginationHint: all
        ? 'all=true was capped at ' + String(QUERY_TABLE_ALL_CAP) + ' rows. To read further, narrow with a filter/range and paginate with limit+page; to count without fetching rows, use count_records.'
        : undefined,
      detailHint: fields && fields.length > 0
        ? undefined
        : 'Only the primary key was returned because fields was omitted. Re-run query_table with explicit fields for details, or use inspect_table to find valid field names.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  });

  server.tool(
    'inspect_rest_projection',
    [
      'Inspect a route-backed REST projection without returning record values.',
      'Recursively validate explicit fields and deep selections before the request, then compare authenticated and anonymous response shape when requested.',
      'Use this for missing fields, access-dependent projections, unpublished omissions, or suspected public exposure.',
    ].join(' '),
    {
      tableName: z.string().describe('Metadata table whose field and relation contract should be validated.'),
      fields: z.array(z.string()).min(1).describe('Explicit include fields or dotted relation paths. Wildcards and exclusions are rejected.'),
      routePath: z.string().optional().describe('Optional API route path when it differs from /<tableName>. Full URLs and query strings are rejected.'),
      filter: jsonObjectParam(z, 'Filter object').optional().describe('Optional Query DSL filter object.'),
      sort: z.string().optional().describe('Optional REST sort expression.'),
      deep: jsonObjectParam(z, 'Deep relation fetch object').optional().describe('Optional deep relation fetch object. Fields inside deep are validated recursively.'),
      limit: z.number().int().min(1).max(10).optional().default(1).describe('Small sample size used only to inspect response shape.'),
      access: z.enum(['authenticated', 'anonymous', 'compare']).optional().default('compare').describe('Run authenticated, anonymous, or both projections.'),
    },
    async (input) => jsonContent(await inspectRestProjection(ENFYRA_API_URL, input)),
  );

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
    const prepared = await prepareGenericBatchMutation(tableName, parsedRecords, 'create');
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
      const prepared = await prepareGenericMutation(tableName, JSON.stringify(item.data), 'update');
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

  server.tool('delete_records', 'Delete one or more route-backed records in one MCP call. Pass items as a native JSON array; for one delete, pass one item. The tool previews every target when confirm=false, rejects duplicate ids, and deletes sequentially when confirm=true. Confirmed deletes automatically re-read the requested primary keys and return postcondition.confirmedAbsent plus remainingIds. A partial failure returns completed, failure, and remainingIndexes; inspect the target and obtain a new preview before retrying. By default, confirm=true skips records that were already removed by cascade or a previous cleanup step.', {
    tableName: z.string().describe('Table name'),
    items: bulkObjectArrayParam(z, 'Delete items').describe('Native JSON array of delete items: [{ "id": "...", "queryParams": { ... }? }].'),
    maxItems: z.number().int().min(1).max(100).optional().default(100).describe('Safety cap for one MCP batch. Default/max is 100.'),
    confirm: z.boolean().optional().default(false).describe('Required true to apply destructive deletes. Omit/false returns previews only.'),
    skipNotFound: z.boolean().optional().default(true).describe('When confirm=true, continue if a target is already gone, for example because a previous delete cascaded child records. Default true.'),
    globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
  }, async ({ tableName, items, maxItems, confirm, skipNotFound, globalRulesAckKey }) => {
    validateTableName(tableName);
    const deleteCatalog = await fetchTableCatalog(ENFYRA_API_URL);
    const canonicalDeleteTable = resolveCanonicalTableName(deleteCatalog, tableName);
    assertGenericRecordMutationAllowed('delete', canonicalDeleteTable);
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
        const preview = await fetchAPI(ENFYRA_API_URL, `/${tableName}?${query.toString()}`);
        previews.push({
          index,
          id: item.id,
          preview: preview?.data?.[0] || null,
        });
      }
      return destructivePreviewContent('delete_records', {
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
      }, parsedItems.length);
    }

    assertGlobalRulesAck(globalRulesAckKey);
    const batch = await executeSequentialBatch(parsedItems, async (item, index) => {
      const query = parseQueryParamsArg(JSON.stringify(item.queryParams || {}));
      try {
        const result = await fetchAPI(ENFYRA_API_URL, appendQuery(`/${tableName}/${encodeURIComponent(String(item.id))}`, query), { method: 'DELETE' });
        return {
          index,
          id: item.id,
          status: 'deleted',
          statusCode: result?.statusCode,
          success: result?.success,
        };
      } catch (error) {
        if (skipNotFound && isNotFoundDeleteError(error)) {
          return {
            index,
            id: item.id,
            status: 'skipped_not_found',
            skipped: true,
            reason: 'not_found',
          };
        }
        throw error;
      }
    });
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
      const completed = batch.completed;
      const deleted = completed.filter((item) => item.status === 'deleted');
      const skippedNotFound = completed.filter((item) => item.status === 'skipped_not_found');
      const unverified = postcondition.confirmedAbsent !== true;
      const payload = {
        action: batch.status === 'partial_failure'
          ? 'delete_records_partial_failure'
          : unverified
            ? 'delete_records_unverified'
            : 'deleted_records',
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
        ...(batch.status === 'partial_failure' ? {
          status: 'partial_failure',
          completed,
          failure: batch.failure,
          remainingIndexes: batch.remainingIndexes,
          requiresNewPreview: true,
        } : {}),
      };
      const result = jsonContent(payload);
      return batch.status === 'partial_failure' || unverified ? { ...result, isError: true } : result;
    });
}
