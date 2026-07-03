import { z } from 'zod';
import { fetchAPI } from './fetch.js';
import { jsonContent } from './response-format.js';
import { writeSourceArtifact } from './source-artifacts.js';
import { inspectExtensionLocation, searchExtensions } from './extension-search-tools.js';

const RUNTIME_ZONES = [
  'admin_ui',
  'api_runtime',
  'flow_runtime',
  'websocket_runtime',
  'graphql_runtime',
  'schema_data',
  'package_runtime',
  'storage_file',
  'auth_security',
] as const;

type RuntimeZone = typeof RUNTIME_ZONES[number];
type RuntimeRecord = Record<string, any>;

type ZoneTable = {
  tableName: string;
  fields: string;
  sourceFields?: string[];
  labelFields?: string[];
  pathFields?: string[];
};

const ZONE_TABLES: Record<Exclude<RuntimeZone, 'admin_ui' | 'schema_data'>, ZoneTable[]> = {
  api_runtime: [
    { tableName: 'enfyra_route', fields: 'id,_id,path,description,isEnabled,mainTable.name,availableMethods.name,publicMethods.name', labelFields: ['path', 'description'], pathFields: ['path'] },
    { tableName: 'enfyra_route_handler', fields: 'id,_id,name,key,sourceCode,scriptLanguage,route.id,route.path,method.name', sourceFields: ['sourceCode'], labelFields: ['name', 'key', 'route.path', 'method.name'], pathFields: ['route.path'] },
    { tableName: 'enfyra_pre_hook', fields: 'id,_id,name,key,sourceCode,scriptLanguage,isGlobal,route.id,route.path,methods.name', sourceFields: ['sourceCode'], labelFields: ['name', 'key', 'route.path'], pathFields: ['route.path'] },
    { tableName: 'enfyra_post_hook', fields: 'id,_id,name,key,sourceCode,scriptLanguage,isGlobal,route.id,route.path,methods.name', sourceFields: ['sourceCode'], labelFields: ['name', 'key', 'route.path'], pathFields: ['route.path'] },
    { tableName: 'enfyra_guard', fields: 'id,_id,name,description,position,isGlobal,isEnabled,route.id,route.path,methods.name', labelFields: ['name', 'description', 'route.path'], pathFields: ['route.path'] },
    { tableName: 'enfyra_guard_rule', fields: 'id,_id,name,field,operator,value,guard.id,guard.name,description,isEnabled', labelFields: ['name', 'field', 'operator', 'value', 'guard.name', 'description'] },
    { tableName: 'enfyra_route_permission', fields: 'id,_id,description,isEnabled,route.id,route.path,role.name,methods.name,allowedUsers.id', labelFields: ['description', 'route.path', 'role.name'], pathFields: ['route.path'] },
  ],
  flow_runtime: [
    { tableName: 'enfyra_flow', fields: 'id,_id,name,description,triggerType,triggerConfig,isEnabled,timeout,maxExecutions', labelFields: ['name', 'description', 'triggerType', 'triggerConfig'] },
    { tableName: 'enfyra_flow_step', fields: 'id,_id,name,key,type,description,sourceCode,condition,config,flow.id,flow.name,nextStep.id,errorStep.id,isEnabled', sourceFields: ['sourceCode', 'condition'], labelFields: ['name', 'key', 'type', 'description', 'flow.name', 'config'] },
  ],
  websocket_runtime: [
    { tableName: 'enfyra_websocket', fields: 'id,_id,path,description,connectionHandlerScript,scriptLanguage,isEnabled', sourceFields: ['connectionHandlerScript'], labelFields: ['path', 'description'], pathFields: ['path'] },
    { tableName: 'enfyra_websocket_event', fields: 'id,_id,eventName,description,handlerScript,scriptLanguage,gateway.id,gateway.path,isEnabled', sourceFields: ['handlerScript'], labelFields: ['eventName', 'description', 'gateway.path'], pathFields: ['gateway.path'] },
  ],
  graphql_runtime: [
    { tableName: 'enfyra_graphql', fields: 'id,_id,name,description,sourceCode,scriptLanguage,table.id,table.name,isEnabled', sourceFields: ['sourceCode'], labelFields: ['name', 'description', 'table.name'] },
  ],
  package_runtime: [
    { tableName: 'enfyra_package', fields: 'id,_id,name,version,type,description,isEnabled,createdAt,updatedAt', labelFields: ['name', 'version', 'type', 'description'] },
  ],
  storage_file: [
    { tableName: 'enfyra_storage_config', fields: 'id,_id,name,provider,bucket,baseUrl,description,isDefault,isEnabled', labelFields: ['name', 'provider', 'bucket', 'baseUrl', 'description'] },
    { tableName: 'enfyra_folder', fields: 'id,_id,name,path,description,parent.id,parent.name,isPublic,createdAt,updatedAt', labelFields: ['name', 'path', 'description'], pathFields: ['path'] },
    { tableName: 'enfyra_file', fields: 'id,_id,fileName,originalName,mimeType,path,url,isPublic,folder.id,folder.name,storage.id,storage.name,createdAt,updatedAt', labelFields: ['fileName', 'originalName', 'mimeType', 'path', 'url', 'folder.name', 'storage.name'], pathFields: ['path', 'url'] },
    { tableName: 'enfyra_file_permission', fields: 'id,_id,file.id,file.fileName,role.name,allowedUsers.id,methods.name,description,isEnabled', labelFields: ['file.fileName', 'role.name', 'description'] },
  ],
  auth_security: [
    { tableName: 'enfyra_role', fields: 'id,_id,name,description,isSystem,createdAt,updatedAt', labelFields: ['name', 'description'] },
    { tableName: 'enfyra_route_permission', fields: 'id,_id,description,isEnabled,route.id,route.path,role.name,methods.name,allowedUsers.id', labelFields: ['description', 'route.path', 'role.name'], pathFields: ['route.path'] },
    { tableName: 'enfyra_field_permission', fields: 'id,_id,description,action,effect,role.name,column.name,relation.propertyName,condition,isEnabled', labelFields: ['description', 'action', 'effect', 'role.name', 'column.name', 'relation.propertyName', 'condition'] },
    { tableName: 'enfyra_guard', fields: 'id,_id,name,description,position,isGlobal,isEnabled,route.id,route.path,methods.name', labelFields: ['name', 'description', 'route.path'], pathFields: ['route.path'] },
    { tableName: 'enfyra_guard_rule', fields: 'id,_id,name,field,operator,value,guard.id,guard.name,description,isEnabled', labelFields: ['name', 'field', 'operator', 'value', 'guard.name', 'description'] },
    { tableName: 'enfyra_oauth_config', fields: 'id,_id,provider,displayName,redirectUri,scopes,isEnabled,description', labelFields: ['provider', 'displayName', 'redirectUri', 'scopes', 'description'] },
  ],
};

export const RUNTIME_ZONE_DESCRIPTIONS: Record<RuntimeZone, string> = {
  admin_ui: 'Admin menu + extension UI records: pages, widgets, global shell extensions, menu chips, account panel entries.',
  api_runtime: 'REST routes, handlers, hooks, guards, guard rules, and route permissions.',
  flow_runtime: 'Flows and flow steps that run background jobs, scheduled tasks, and manual operations.',
  websocket_runtime: 'Socket.IO gateways and event handlers.',
  graphql_runtime: 'GraphQL exposure and custom resolver source.',
  schema_data: 'Tables, columns, relations, column rules, field permissions, and route-backed data shape.',
  package_runtime: 'Installed app/server packages and runtime package availability.',
  storage_file: 'Storage configs, folders, files, public file state, and file permissions.',
  auth_security: 'Roles, route permissions, field permissions, guards, guard rules, and OAuth auth surfaces.',
};

function getId(record: any) {
  return record?.id ?? record?._id ?? null;
}

function unwrapData(result: any): RuntimeRecord[] {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result)) return result;
  return [];
}

function normalizeText(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function valueAt(record: RuntimeRecord, path: string): unknown {
  return path.split('.').reduce((current: any, key) => {
    if (current == null) return undefined;
    if (Array.isArray(current)) return current.map((item) => item?.[key]).filter((item) => item != null);
    return current[key];
  }, record);
}

function flattenValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function filterQuery(filter: any) {
  return encodeURIComponent(JSON.stringify(filter));
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function metadataTables(metadata: any): RuntimeRecord[] {
  return Array.isArray(metadata?.data)
    ? metadata.data
    : Array.isArray(metadata)
      ? metadata
      : Object.values(metadata?.data ?? metadata ?? {});
}

function tableByName(tables: RuntimeRecord[], tableName: string) {
  return tables.find((table) => table?.name === tableName) ?? null;
}

function relatedTableName(relation: any) {
  return relation?.targetTable?.name
    ?? relation?.targetTable
    ?? relation?.relatedTable?.name
    ?? relation?.relatedTable
    ?? relation?.table?.name
    ?? relation?.table
    ?? null;
}

function resolveFieldExposurePath(tables: RuntimeRecord[], rootTableName: string, fieldPath: string) {
  const segments = String(fieldPath || '').split('.').map((item) => item.trim()).filter(Boolean);
  const steps = [];
  let current = tableByName(tables, rootTableName);
  if (!current) {
    return { ok: false, reason: `Root table not found: ${rootTableName}`, steps, targetTable: null, targetField: null };
  }
  if (!segments.length) {
    return { ok: false, reason: 'fieldPath is empty.', steps, targetTable: current, targetField: null };
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    const propertyName = segments[index];
    const relation = asArray(current?.relations).find((item) => item?.propertyName === propertyName);
    if (!relation) {
      return { ok: false, reason: `Relation "${propertyName}" was not found on ${current.name}.`, steps, targetTable: current, targetField: null };
    }
    const nextTableName = relatedTableName(relation);
    steps.push({ type: 'relation', propertyName, fromTable: current.name, targetTable: nextTableName });
    current = nextTableName ? tableByName(tables, String(nextTableName)) : null;
    if (!current) {
      return { ok: false, reason: `Target table for relation "${propertyName}" could not be resolved.`, steps, targetTable: null, targetField: null };
    }
  }
  const fieldName = segments[segments.length - 1];
  const column = asArray(current?.columns).find((item) => item?.name === fieldName);
  if (column) {
    return { ok: true, reason: null, steps, targetTable: current, targetField: { kind: 'column', ...column } };
  }
  const relation = asArray(current?.relations).find((item) => item?.propertyName === fieldName);
  if (relation) {
    return { ok: true, reason: null, steps, targetTable: current, targetField: { kind: 'relation', ...relation } };
  }
  return { ok: false, reason: `Field "${fieldName}" was not found on ${current.name}.`, steps, targetTable: current, targetField: null };
}

function compactRows(value: any) {
  const rows = Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : [];
  return {
    rowCount: rows.length,
    firstRowKeys: rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 12) : [],
    responseShape: value && typeof value === 'object' ? Object.keys(value).slice(0, 12) : [],
  };
}

function sourceMatches(source: string, query: string, snippetChars: number) {
  const normalizedQuery = normalizeText(query);
  if (!source || !normalizedQuery) return null;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines.slice(index, Math.min(index + 3, lines.length)).join(' ');
    if (normalizeText(text).includes(normalizedQuery)) {
      return {
        line: index + 1,
        snippet: text.replace(/\s+/g, ' ').trim().slice(0, snippetChars),
      };
    }
  }
  const normalizedSource = normalizeText(source);
  const offset = normalizedSource.indexOf(normalizedQuery);
  if (offset < 0) return null;
  return {
    line: null,
    snippet: source.slice(Math.max(0, offset - 60), offset + query.length + 120).replace(/\s+/g, ' ').trim().slice(0, snippetChars),
  };
}

async function fetchZoneRecords(apiUrl: string, table: ZoneTable) {
  const result = await fetchAPI(apiUrl, `/${table.tableName}?limit=0&fields=${encodeURIComponent(table.fields)}`).catch((error: any) => ({ error }));
  if (result?.error) return { records: [], error: result.error.message || String(result.error) };
  return { records: unwrapData(result), error: null };
}

function matchGenericRecord(table: ZoneTable, record: RuntimeRecord, query: string, snippetChars: number) {
  const matches = [];
  const normalizedQuery = normalizeText(query);
  for (const field of table.labelFields ?? []) {
    const raw = flattenValue(valueAt(record, field));
    if (!raw || !normalizeText(raw).includes(normalizedQuery)) continue;
    matches.push({
      field,
      score: 70,
      reason: 'metadata match',
      snippet: raw.slice(0, snippetChars),
    });
  }
  for (const field of table.sourceFields ?? []) {
    const source = String(valueAt(record, field) ?? '');
    const hit = sourceMatches(source, query, snippetChars);
    if (!hit) continue;
    matches.push({
      field,
      line: hit.line,
      score: 110,
      reason: 'source match',
      snippet: hit.snippet,
    });
  }
  return matches;
}

function summarizeGenericRecord(zone: RuntimeZone, table: ZoneTable, record: RuntimeRecord, matches: any[], includeSourceArtifact: boolean) {
  const id = getId(record);
  const sourceField = (table.sourceFields ?? []).find((field) => typeof valueAt(record, field) === 'string' && String(valueAt(record, field)).length > 0);
  const source = sourceField ? String(valueAt(record, sourceField)) : '';
  return {
    zone,
    tableName: table.tableName,
    id,
    label: (table.labelFields ?? []).map((field) => flattenValue(valueAt(record, field))).find(Boolean) || String(id),
    routePath: flattenValue(valueAt(record, 'route.path')) || flattenValue(valueAt(record, 'gateway.path')) || null,
    score: matches.reduce((sum, item) => sum + item.score, 0),
    matches: matches.sort((a, b) => b.score - a.score).slice(0, 3),
    source: source
      ? includeSourceArtifact
        ? (() => {
            const artifact = writeSourceArtifact({ tableName: table.tableName, id: id ?? 'record', fieldName: sourceField!, source });
            return { tmpFile: artifact.tmpFile, length: artifact.length, sha256: artifact.sha256 };
          })()
        : { field: sourceField, length: source.length }
      : null,
    nextInspect: {
      tool: 'search_runtime_zone',
      input: { mode: 'inspect', zone, tableName: table.tableName, id },
    },
  };
}

async function searchSchemaZone(apiUrl: string, input: any) {
  const query = String(input.query ?? '').trim();
  const normalizedQuery = normalizeText(query);
  const maxResults = Math.min(Math.max(Number(input.maxResults ?? 8), 1), 25);
  const metadata = await fetchAPI(apiUrl, '/metadata');
  const tables = Array.isArray(metadata?.data)
    ? metadata.data
    : Array.isArray(metadata)
      ? metadata
      : Object.values(metadata?.data ?? metadata ?? {});
  const results = [];
  for (const table of tables as any[]) {
    const tableMatches = [];
    for (const field of ['name', 'alias', 'description']) {
      const raw = flattenValue(table?.[field]);
      if (raw && normalizeText(raw).includes(normalizedQuery)) {
        tableMatches.push({ field, score: 80, reason: 'table metadata match', snippet: raw.slice(0, 180) });
      }
    }
    for (const column of table?.columns ?? []) {
      const raw = flattenValue({ name: column.name, type: column.type, description: column.description });
      if (normalizeText(raw).includes(normalizedQuery)) {
        tableMatches.push({ field: `column.${column.name}`, score: 70, reason: 'column match', snippet: raw.slice(0, 180) });
      }
    }
    for (const relation of table?.relations ?? []) {
      const raw = flattenValue({ propertyName: relation.propertyName, type: relation.type, targetTable: relation.targetTable?.name ?? relation.targetTable, description: relation.description });
      if (normalizeText(raw).includes(normalizedQuery)) {
        tableMatches.push({ field: `relation.${relation.propertyName}`, score: 70, reason: 'relation match', snippet: raw.slice(0, 180) });
      }
    }
    if (!tableMatches.length) continue;
    results.push({
      zone: 'schema_data',
      tableName: table.name,
      id: getId(table),
      alias: table.alias,
      score: tableMatches.reduce((sum, item) => sum + item.score, 0),
      matches: tableMatches.sort((a, b) => b.score - a.score).slice(0, 4),
      nextInspect: { tool: 'search_runtime_zone', input: { mode: 'inspect', zone: 'schema_data', tableName: table.name } },
    });
  }
  results.sort((a, b) => b.score - a.score || String(a.tableName).localeCompare(String(b.tableName)));
  return {
    action: 'runtime_zone_searched',
    zone: 'schema_data',
    zoneDescription: RUNTIME_ZONE_DESCRIPTIONS.schema_data,
    query,
    resultCount: results.length,
    results: results.slice(0, maxResults),
    searched: { tables: tables.length },
  };
}

export async function searchRuntimeZone(apiUrl: string, input: any) {
  if ((input.mode ?? 'search') === 'inspect') return inspectRuntimeZoneLocation(apiUrl, input);
  const zone = input.zone as RuntimeZone;
  if (!RUNTIME_ZONES.includes(zone)) throw new Error(`Unsupported runtime zone: ${zone}`);
  if (zone === 'admin_ui') {
    const adminResult = await searchExtensions(apiUrl, {
      query: input.query,
      path: input.path,
      type: input.extensionType,
      includeDisabled: input.includeDisabled,
      maxResults: input.maxResults,
      snippetChars: input.snippetChars,
      maxMatchesPerExtension: input.maxMatchesPerRecord,
      includeSourceArtifact: input.includeSourceArtifact,
    });
    return {
      ...adminResult,
      action: 'runtime_zone_searched',
      zone,
      zoneDescription: RUNTIME_ZONE_DESCRIPTIONS.admin_ui,
      results: (adminResult.results ?? []).map((item: any) => ({
        ...item,
        zone,
        nextInspect: {
          tool: 'search_runtime_zone',
          input: { mode: 'inspect', zone, id: item.id, name: item.name },
        },
      })),
    };
  }
  if (zone === 'schema_data') return searchSchemaZone(apiUrl, input);

  const query = String(input.query ?? input.path ?? '').trim();
  if (!query) throw new Error('query or path is required for this runtime zone.');
  const path = input.path ? String(input.path).trim() : '';
  const maxResults = Math.min(Math.max(Number(input.maxResults ?? 8), 1), 25);
  const snippetChars = Math.min(Math.max(Number(input.snippetChars ?? 180), 120), 600);
  const includeSourceArtifact = Boolean(input.includeSourceArtifact);
  const tables = ZONE_TABLES[zone as Exclude<RuntimeZone, 'admin_ui' | 'schema_data'>];
  const allResults = [];
  const errors = [];
  for (const table of tables) {
    const { records, error } = await fetchZoneRecords(apiUrl, table);
    if (error) {
      errors.push({ tableName: table.tableName, error });
      continue;
    }
    for (const record of records) {
      if (path) {
        const pathHit = (table.pathFields ?? []).some((field) => flattenValue(valueAt(record, field)) === path);
        if (!pathHit) continue;
      }
      const matches = matchGenericRecord(table, record, query, snippetChars);
      if (!matches.length && path) {
        matches.push({ field: 'path', score: 120, reason: 'exact path match', snippet: path });
      }
      if (!matches.length) continue;
      allResults.push(summarizeGenericRecord(zone, table, record, matches, includeSourceArtifact));
    }
  }
  allResults.sort((a, b) => b.score - a.score || String(a.tableName).localeCompare(String(b.tableName)));
  const results = allResults.slice(0, maxResults);
  return {
    action: 'runtime_zone_searched',
    zone,
    zoneDescription: RUNTIME_ZONE_DESCRIPTIONS[zone],
    query: query || null,
    path: path || null,
    resultCount: allResults.length,
    results,
    readErrors: errors,
    tokenBudget: {
      estimatedOutputChars: JSON.stringify(results).length,
      estimatedOutputTokens: Math.ceil(JSON.stringify(results).length / 4),
      controls: { maxResults, snippetChars, includeSourceArtifact },
    },
    guidance: [
      'Use the returned nextInspect input on search_runtime_zone(mode=inspect) for the best candidate before editing.',
      'Use source artifacts only for the selected candidate when snippets are insufficient.',
      'Use zone-specific write tools after inspection instead of generic CRUD when a business operation tool exists.',
    ],
  };
}

export async function searchAdminExtensions(apiUrl: string, input: any) {
  const mode = input.mode ?? 'search';
  const result: any = await searchRuntimeZone(apiUrl, {
    ...input,
    mode,
    zone: 'admin_ui',
    extensionType: input.type ?? input.extensionType,
  });
  const results = Array.isArray(result?.results)
    ? result.results.map((item: any) => ({
        ...item,
        nextInspect: item?.nextInspect?.input
          ? {
              tool: 'search_admin_extensions',
              input: {
                ...item.nextInspect.input,
                zone: undefined,
                type: item.nextInspect.input.extensionType,
                extensionType: undefined,
              },
            }
          : item?.nextInspect,
      }))
    : result?.results;
  return {
    ...result,
    results,
    action: mode === 'inspect' ? 'admin_extension_inspected' : 'admin_extensions_searched',
    guidance: mode === 'inspect'
      ? [
          'For focused existing-code edits, prefer patch_extension_code with the inspected id/name.',
          'For page/menu wiring, use extension_workflow or ensure_*_extension.',
          'Use <UButton> and other auto-injected components directly in templates; do not use resolveComponent for them.',
        ]
      : [
          'Inspect one candidate before editing.',
          'If the target is an existing page/widget/global extension, use patch_extension_code for a focused edit.',
          'Do not fetch destination business lists solely to draw menu/account-panel chips; use notification signals and fetch on click.',
        ],
  };
}

export async function debugFieldExposure(apiUrl: string, input: any) {
  const tableName = String(input.tableName ?? '').trim();
  const fieldPath = String(input.fieldPath ?? '').trim();
  if (!tableName) throw new Error('tableName is required.');
  if (!fieldPath) throw new Error('fieldPath is required, for example "owner.secret_token" or "api_key".');

  const metadata = await fetchAPI(apiUrl, '/metadata');
  const tables = metadataTables(metadata);
  const resolved = resolveFieldExposurePath(tables, tableName, fieldPath);
  const targetField: any = resolved.targetField;
  const isPublished = targetField?.isPublished;
  const routePath = String(input.routePath ?? `/${tableName}`).trim();
  const fields = input.fields ? String(input.fields) : fieldPath;
  const params = new URLSearchParams();
  params.set('fields', fields);
  params.set('limit', String(Math.min(Math.max(Number(input.limit ?? 1), 1), 10)));
  if (input.deep) params.set('deep', JSON.stringify(input.deep));
  if (input.filter) params.set('filter', JSON.stringify(input.filter));
  const reproPath = `${routePath}?${params.toString()}`;

  let repro: any = null;
  if (input.runRepro) {
    try {
      repro = { ok: true, summary: compactRows(await fetchAPI(apiUrl, reproPath)) };
    } catch (error: any) {
      repro = { ok: false, error: error?.message || String(error) };
    }
  }

  const unpublishedLeak = resolved.ok && isPublished === false;
  return {
    action: 'field_exposure_debugged',
    tableName,
    fieldPath,
    resolved,
    metadataFinding: resolved.ok
      ? {
          targetTable: resolved.targetTable?.name ?? null,
          fieldKind: targetField?.kind ?? null,
          fieldName: targetField?.name ?? targetField?.propertyName ?? null,
          isPublished,
          isEncrypted: targetField?.isEncrypted ?? null,
        }
      : { error: resolved.reason },
    reproRequest: { tool: 'test_rest_endpoint', input: { method: 'GET', path: reproPath } },
    repro,
    verdict: unpublishedLeak
      ? 'If the repro returns this unpublished field through REST fields/deep, this is an Enfyra core field-exposure bug. Do not hide it with frontend code, route-local hooks, or field permissions.'
      : 'No unpublished target field was resolved from metadata. Inspect the table/relation path before treating this as a core exposure bug.',
    nextSteps: unpublishedLeak
      ? [
          'Run the returned test_rest_endpoint repro if runRepro was false.',
          'If the response includes the unpublished field, report tableName, fieldPath, reproRequest.path, metadataFinding, and response shape to Enfyra core/support.',
          'Do not add route-local pre-hooks or frontend hiding as the real fix for a published-field contract breach.',
        ]
      : [
          'Use inspect_table on the root and related tables to verify the path.',
          'If the field is published, use field permissions/guards only for business access rules, not core isPublished enforcement.',
        ],
  };
}

export async function inspectRuntimeZoneLocation(apiUrl: string, input: any) {
  const zone = input.zone as RuntimeZone;
  if (!RUNTIME_ZONES.includes(zone)) throw new Error(`Unsupported runtime zone: ${zone}`);
  if (zone === 'admin_ui') {
    return { ...(await inspectExtensionLocation(apiUrl, input)), zone, zoneDescription: RUNTIME_ZONE_DESCRIPTIONS.admin_ui };
  }
  if (zone === 'schema_data') {
    if (!input.tableName && !input.query) throw new Error('tableName or query is required for schema_data inspection.');
    return {
      action: 'runtime_zone_location_inspected',
      zone,
      zoneDescription: RUNTIME_ZONE_DESCRIPTIONS.schema_data,
      next: input.tableName
        ? { tool: 'inspect_table', input: { tableName: input.tableName } }
        : { tool: 'search_runtime_zone', input: { mode: 'search', zone, query: input.query, maxResults: 5 } },
    };
  }
  const tableName = String(input.tableName ?? '');
  if (!tableName) throw new Error('tableName is required for non-admin runtime zone inspection. Use search_runtime_zone first and pass nextInspect.input.');
  const table = ZONE_TABLES[zone as Exclude<RuntimeZone, 'admin_ui' | 'schema_data'>]?.find((item) => item.tableName === tableName);
  if (!table) throw new Error(`Table ${tableName} does not belong to zone ${zone}.`);
  const id = input.id;
  const filter = id != null
    ? { id: { _eq: id } }
    : input.query
      ? null
      : null;
  if (!filter) throw new Error('id is required for direct inspection. Use search_runtime_zone for query-based discovery.');
  const result = await fetchAPI(apiUrl, `/${table.tableName}?filter=${filterQuery(filter)}&limit=1&fields=${encodeURIComponent(table.fields)}`);
  const record = unwrapData(result)[0];
  if (!record) throw new Error(`Record not found: ${table.tableName} ${id}`);
  const sources = [];
  for (const field of table.sourceFields ?? []) {
    const source = String(valueAt(record, field) ?? '');
    if (!source) continue;
    const artifact = writeSourceArtifact({ tableName: table.tableName, id: getId(record) ?? 'record', fieldName: field, source });
    sources.push(artifact);
  }
  return {
    action: 'runtime_zone_location_inspected',
    zone,
    zoneDescription: RUNTIME_ZONE_DESCRIPTIONS[zone],
    tableName: table.tableName,
    id: getId(record),
    record,
    sources,
    nextSteps: [
      'Use zone-specific edit tools where available.',
      'For source edits, use get_script_source/patch_script_source/update_script_source when the table is script-backed.',
      'Re-run search_runtime_zone or the specific inspector after mutation.',
    ],
  };
}

export function registerRuntimeZoneTools(server: any, ENFYRA_API_URL: string) {
  server.tool(
    'search_admin_extensions',
    [
      'Focused admin UI locator for menu/page/widget/global extensions, account panel rows, notification chips, labels, buttons, tabs, and visible blocks.',
      'This is a weak-agent friendly alias for search_runtime_zone(zone=admin_ui): search first, then inspect one candidate before patching.',
    ].join(' '),
    {
      mode: z.enum(['search', 'inspect']).optional().default('search').describe('search returns ranked admin UI matches. inspect opens one result using id/name/path/query.'),
      query: z.string().optional().describe('Visible text, button label, menu label, component name, class, icon, source term, or UX phrase.'),
      path: z.string().optional().describe('Menu/page path such as /cloud/hosts when known.'),
      id: z.union([z.string(), z.number()]).optional().describe('Extension id for mode=inspect; use nextInspect.input from search results.'),
      name: z.string().optional().describe('Extension name for mode=inspect.'),
      type: z.enum(['page', 'widget', 'global']).optional().describe('Narrows extension type.'),
      includeDisabled: z.boolean().optional().default(true),
      maxResults: z.number().int().min(1).max(25).optional().default(8),
      snippetChars: z.number().int().min(120).max(600).optional().default(180),
      includeSourceArtifact: z.boolean().optional().default(false),
    },
    async (input: any) => jsonContent(await searchAdminExtensions(ENFYRA_API_URL, input)),
  );

  server.tool(
    'debug_field_exposure',
    [
      'Diagnose whether a REST fields/deep projection exposes an isPublished=false field.',
      'Use this for suspected secret/private field leaks. It builds a minimal repro and tells the agent when this is a core bug rather than a hook/frontend fix.',
    ].join(' '),
    {
      tableName: z.string().describe('Root route-backed table name used by the REST request.'),
      fieldPath: z.string().describe('Field path to test, for example "secret_token", "owner.api_key", or "children.owner.email". Relation segments must be propertyName values.'),
      routePath: z.string().optional().describe('REST route path. Defaults to /<tableName>.'),
      fields: z.string().optional().describe('Exact fields query to use. Defaults to fieldPath.'),
      deep: z.record(z.any()).optional().describe('Optional deep object for the repro request.'),
      filter: z.record(z.any()).optional().describe('Optional bounded filter for the repro request.'),
      limit: z.number().int().min(1).max(10).optional().default(1),
      runRepro: z.boolean().optional().default(false).describe('When true, run the GET repro and return only compact response shape.'),
    },
    async (input: any) => jsonContent(await debugFieldExposure(ENFYRA_API_URL, input)),
  );

  server.tool(
    'search_runtime_zone',
    [
      'Single zone-scoped search/inspect tool for DB-backed Enfyra runtime artifacts.',
      'Use this before editing anything that lives in the database rather than repo files.',
      'Choose a zone first so the output stays precise and token-bounded. Use mode=search first, then call this same tool with mode=inspect using nextInspect.input.',
    ].join(' '),
    {
      mode: z.enum(['search', 'inspect']).optional().default('search').describe('search returns ranked matches. inspect opens one result using tableName/id or admin UI name/path/query.'),
      zone: z.enum(RUNTIME_ZONES).describe('DB-backed runtime zone to search. admin_ui=menu/extensions, api_runtime=routes/handlers/hooks/guards, flow_runtime=flows, websocket_runtime=socket gateways/events, graphql_runtime=GraphQL, schema_data=tables/fields/relations, package_runtime=packages, storage_file=storage/files, auth_security=access/auth.'),
      query: z.string().optional().describe('Visible label, path, event name, flow step key, route path, source-code term, field name, package name, or config keyword.'),
      path: z.string().optional().describe('Exact route/gateway/menu/file path where the zone supports path lookup.'),
      tableName: z.string().optional().describe('Required for mode=inspect on non-admin zones; use nextInspect.input from search results.'),
      id: z.union([z.string(), z.number()]).optional().describe('Record id for mode=inspect; use nextInspect.input from search results.'),
      name: z.string().optional().describe('Admin UI extension name for mode=inspect when zone=admin_ui.'),
      extensionType: z.enum(['page', 'widget', 'global']).optional().describe('Only for admin_ui zone. Narrows extension type.'),
      includeDisabled: z.boolean().optional().default(true).describe('Only for admin_ui zone. Include disabled extensions.'),
      maxResults: z.number().int().min(1).max(25).optional().default(8).describe('Maximum ranked results.'),
      snippetChars: z.number().int().min(120).max(600).optional().default(180).describe('Approximate snippet characters per match.'),
      maxMatchesPerRecord: z.number().int().min(1).max(8).optional().default(2).describe('Only for admin_ui zone. Maximum source matches per extension.'),
      includeSourceArtifact: z.boolean().optional().default(false).describe('Write matched source to /tmp and return compact source artifact metadata. Prefer false unless snippets are insufficient.'),
    },
    async (input: any) => jsonContent(await searchRuntimeZone(ENFYRA_API_URL, input)),
  );
}
