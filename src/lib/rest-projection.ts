import { getApiTokenHeaders } from './auth.js';
import { fetchTableMetadata } from './metadata-client.js';
import { validateQueryContract } from './query-contract.js';
import type { QueryContractPathReceipt } from './query-contract-types.js';
import type {
  InspectRestProjectionInput,
  ProjectionPathPresence,
  RestProjectionDependencies,
  RestProjectionHttpResponse,
} from './rest-projection-types.js';
import { applyDeepFieldSelections } from './tool-record-operations.js';
import type { UnknownRecord } from './types.js';

function normalizeRoutePath(routePath: string) {
  if (/^https?:\/\//iu.test(routePath)) throw new Error('routePath must be an Enfyra API path, not a full URL.');
  const path = routePath.startsWith('/') ? routePath : `/${routePath}`;
  if (path.includes('?')) throw new Error('routePath must not include a query string. Use filter, sort, deep, and limit inputs.');
  return path;
}

function primaryKey(table: UnknownRecord) {
  if (table.primaryKey) return String(table.primaryKey);
  const columns = Array.isArray(table.columns) ? table.columns : [];
  const primary = columns.find((column) => column && typeof column === 'object' && (column as UnknownRecord).isPrimary === true) as UnknownRecord | undefined;
  return primary?.name ? String(primary.name) : null;
}

function rowsFromBody(body: unknown): UnknownRecord[] {
  if (Array.isArray(body)) return body.filter((item): item is UnknownRecord => Boolean(item && typeof item === 'object'));
  if (!body || typeof body !== 'object') return [];
  const data = (body as UnknownRecord).data;
  return Array.isArray(data) ? data.filter((item): item is UnknownRecord => Boolean(item && typeof item === 'object')) : [];
}

function expandNodes(values: unknown[]) {
  return values.flatMap((value) => Array.isArray(value) ? value : [value]).filter((value) => value != null);
}

function pathPresence(rows: UnknownRecord[], path: string): ProjectionPathPresence {
  if (!rows.length) return 'no_rows';
  if (!path || path.includes('*')) return 'not_evaluated';
  let nodes: unknown[] = rows;
  const segments = path.split('.').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const values: unknown[] = [];
    let propertySeen = false;
    for (const node of expandNodes(nodes)) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      if (!Object.prototype.hasOwnProperty.call(node, segment)) continue;
      propertySeen = true;
      values.push((node as UnknownRecord)[segment]);
    }
    if (!propertySeen) return 'missing';
    if (index === segments.length - 1) return 'present';
    nodes = expandNodes(values);
    if (!nodes.length) return 'indeterminate';
  }
  return 'present';
}

function summarizeResponse(response: RestProjectionHttpResponse, paths: QueryContractPathReceipt[]) {
  const rows = rowsFromBody(response.body);
  const body = response.body && typeof response.body === 'object' && !Array.isArray(response.body)
    ? response.body as UnknownRecord
    : null;
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    rowCount: rows.length,
    responseKeys: body ? Object.keys(body).slice(0, 20) : [],
    firstRowKeys: rows[0] ? Object.keys(rows[0]).slice(0, 30) : [],
    pathPresence: paths.map((item) => ({
      path: item.path,
      presence: pathPresence(rows, item.path),
      isPublished: item.isPublished,
    })),
  };
}

async function defaultRequest(apiUrl: string, url: string, authenticated: boolean): Promise<RestProjectionHttpResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authenticated) Object.assign(headers, getApiTokenHeaders());
  const response = await fetch(url, { method: 'GET', headers });
  const text = await response.text();
  let body: unknown = text;
  if ((response.headers.get('content-type') || '').includes('application/json') && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { ok: response.ok, status: response.status, statusText: response.statusText, body };
}

function isContractError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /^(Unknown query_table field|Unknown deep|Relation |deep for |'limit'|'page')/u.test(message);
}

function presenceMap(summary: any) {
  return new Map((summary?.pathPresence || []).map((item: any) => [item.path, item.presence]));
}

export async function inspectRestProjection(
  apiUrl: string,
  input: InspectRestProjectionInput,
  dependencies: RestProjectionDependencies = {},
) {
  const fields = input.fields.flatMap((field) => String(field).split(',')).map((field) => field.trim()).filter(Boolean);
  if (!fields.length) throw new Error('inspect_rest_projection requires explicit fields.');
  if (fields.some((field) => field.startsWith('-') || field.includes('*'))) {
    throw new Error('inspect_rest_projection requires explicit include fields without wildcard or exclude selectors.');
  }
  const access = input.access ?? 'compare';
  const limit = Math.min(Math.max(Number(input.limit ?? 1), 1), 10);
  const loadTable = dependencies.loadTable ?? ((tableName: string) => fetchTableMetadata(apiUrl, tableName));
  const request = dependencies.request ?? ((url: string, authenticated: boolean) => defaultRequest(apiUrl, url, authenticated));
  const rootMetadata = await loadTable(input.tableName);
  const rootTable = { ...rootMetadata, primaryKey: primaryKey(rootMetadata) };
  const selection = applyDeepFieldSelections(fields, input.deep);
  let schemaReceipt;
  try {
    schemaReceipt = await validateQueryContract({
      rootTable,
      fields: selection.fields,
      deep: input.deep,
      loadTable,
    });
  } catch (error) {
    if (!isContractError(error)) throw error;
    return {
      action: 'rest_projection_inspected',
      tableName: input.tableName,
      access,
      verdict: 'schema_contract_mismatch',
      contractError: error instanceof Error ? error.message : String(error),
      requestExecuted: false,
    };
  }

  const routePath = normalizeRoutePath(input.routePath ?? `/${input.tableName}`);
  const params = new URLSearchParams();
  params.set('fields', selection.fields.join(','));
  params.set('limit', String(limit));
  if (input.filter) params.set('filter', JSON.stringify(input.filter));
  if (input.sort) params.set('sort', input.sort);
  if (input.deep) params.set('deep', JSON.stringify(input.deep));
  const url = `${apiUrl.replace(/\/$/u, '')}${routePath}?${params.toString()}`;
  const paths = schemaReceipt.pathMetadata;
  const shouldAuthenticate = access === 'authenticated' || access === 'compare';
  const shouldRunAnonymous = access === 'anonymous' || access === 'compare';
  const [authenticatedResponse, anonymousResponse] = await Promise.all([
    shouldAuthenticate ? request(url, true) : null,
    shouldRunAnonymous ? request(url, false) : null,
  ]);
  const authenticated = authenticatedResponse ? summarizeResponse(authenticatedResponse, paths) : null;
  const anonymous = anonymousResponse ? summarizeResponse(anonymousResponse, paths) : null;
  const authenticatedPresence = presenceMap(authenticated);
  const anonymousPresence = presenceMap(anonymous);
  const differences = access === 'compare'
    ? paths.flatMap((path) => {
        const authenticatedValue = authenticatedPresence.get(path.path);
        const anonymousValue = anonymousPresence.get(path.path);
        if (authenticatedValue === anonymousValue) return [];
        return [{
          path: path.path,
          authenticated: authenticatedValue,
          anonymous: anonymousValue,
          isPublished: path.isPublished,
        }];
      })
    : [];

  let verdict = 'projection_inspected';
  if (access === 'compare') {
    const publicLeak = paths.some((path) => path.isPublished === false && anonymousPresence.get(path.path) === 'present');
    const publishedDifference = differences.some((item) => item.isPublished !== false);
    if (publicLeak) verdict = 'unexpected_public_exposure';
    else if (!authenticated?.ok) verdict = 'authenticated_request_failed';
    else if (anonymous?.status === 401 || anonymous?.status === 403) verdict = 'private_route';
    else if (!anonymous?.ok) verdict = 'anonymous_request_failed';
    else if (authenticated.rowCount === 0 && anonymous.rowCount === 0) verdict = 'projection_indeterminate_no_rows';
    else if (publishedDifference) verdict = 'access_projection_difference';
    else if (differences.length) verdict = 'expected_unpublished_omission';
    else verdict = 'projections_match';
  } else if (access === 'anonymous') {
    if (anonymous?.status === 401 || anonymous?.status === 403) verdict = 'private_route';
    else if (paths.some((path) => path.isPublished === false && anonymousPresence.get(path.path) === 'present')) verdict = 'unexpected_public_exposure';
  } else if (!authenticated?.ok) {
    verdict = 'authenticated_request_failed';
  }

  return {
    action: 'rest_projection_inspected',
    tableName: input.tableName,
    access,
    verdict,
    requestExecuted: true,
    request: {
      method: 'GET',
      path: routePath,
      fields: selection.fields,
      autoAddedDeepFields: selection.autoAdded,
      limit,
      filterApplied: Boolean(input.filter),
      deepApplied: Boolean(input.deep),
    },
    schemaReceipt,
    authenticated,
    anonymous,
    differences,
  };
}
