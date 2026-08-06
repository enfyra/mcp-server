import { fetchAPI } from './fetch.js';
import { createOrPatch, findRecord } from './platform-data-operations.js';
import { getId, unwrapData } from './platform-route-operations.js';
import { assertGlobalRulesAck } from './required-knowledge.js';
import type {
  AuthHeaderRecord,
  EnsureAuthHeaderInput,
  ReorderAuthHeadersInput,
} from './auth-header-types.js';

const AUTH_HEADER_FIELDS = 'id,_id,headerKey,credentialType,scheme,priority,isEnabled,isSystem,description';

function normalizeHeaderKey(value: string) {
  const headerKey = String(value || '').trim().toLowerCase();
  if (!headerKey || /\s/.test(headerKey) || headerKey.includes(':')) {
    throw new Error('headerKey must be a valid HTTP header name.');
  }
  return headerKey;
}

function normalizePriority(value: unknown, fieldName: string) {
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`);
  }
  return priority;
}

function normalizeAuthHeaderRecord(record: any): AuthHeaderRecord {
  return {
    id: getId(record),
    headerKey: String(record?.headerKey || '').toLowerCase(),
    credentialType: record?.credentialType,
    scheme: record?.scheme,
    priority: Number(record?.priority ?? 0),
    isEnabled: record?.isEnabled !== false,
    isSystem: record?.isSystem === true,
    description: record?.description ?? null,
  };
}

async function fetchAuthHeaders(apiUrl: string) {
  const result = await fetchAPI(apiUrl, `/enfyra_auth_header?limit=1000&fields=${encodeURIComponent(AUTH_HEADER_FIELDS)}`);
  return unwrapData(result).map(normalizeAuthHeaderRecord);
}

export async function ensureAuthHeader(apiUrl: string, input: EnsureAuthHeaderInput) {
  assertGlobalRulesAck(input.globalRulesAckKey);
  const headerKey = normalizeHeaderKey(input.headerKey);
  const scheme = input.scheme || 'raw';
  const credentialType = input.credentialType || (scheme === 'bearer' ? 'jwt' : 'pat');
  const existing = await findRecord(
    apiUrl,
    'enfyra_auth_header',
    {
      headerKey: { _eq: headerKey },
      credentialType: { _eq: credentialType },
      scheme: { _eq: scheme },
    },
    AUTH_HEADER_FIELDS,
  );

  if (existing?.isSystem) {
    if (existing.credentialType !== credentialType) {
      throw new Error(`Cannot change the credential type of system auth header ${headerKey}.`);
    }
    if (input.isEnabled !== undefined) {
      throw new Error(`Cannot change the enabled state of system auth header ${headerKey}.`);
    }
  }

  let priority = existing?.priority;
  if (input.priority !== undefined) {
    priority = normalizePriority(input.priority, 'priority');
  } else if (!existing) {
    const records = await fetchAuthHeaders(apiUrl);
    priority = records.reduce((max, record) => Math.max(max, record.priority), -1) + 1;
  }

  const body: Record<string, unknown> = existing?.isSystem
    ? {
        priority,
        ...(input.description !== undefined ? { description: input.description } : {}),
      }
    : {
        headerKey,
        credentialType,
        scheme,
        priority,
        isEnabled: input.isEnabled ?? existing?.isEnabled ?? true,
        ...(input.description !== undefined ? { description: input.description } : {}),
      };

  const operation = await createOrPatch(apiUrl, 'enfyra_auth_header', existing, body);
  const saved = await findRecord(
    apiUrl,
    'enfyra_auth_header',
    {
      headerKey: { _eq: headerKey },
      credentialType: { _eq: credentialType },
      scheme: { _eq: scheme },
    },
    AUTH_HEADER_FIELDS,
  );
  if (!saved) throw new Error(`Authentication header was not found after ${operation.action}.`);

  return {
    action: operation.action,
    header: normalizeAuthHeaderRecord(saved),
    verified: true,
  };
}

export async function reorderAuthHeaders(apiUrl: string, input: ReorderAuthHeadersInput) {
  assertGlobalRulesAck(input.globalRulesAckKey);
  if (!Array.isArray(input.updates) || input.updates.length === 0) {
    throw new Error('updates must contain at least one auth header.');
  }

  const seen = new Set<string>();
  const updates = input.updates.map((item, index) => {
    const id = item?.id;
    if (id == null || String(id).trim() === '') throw new Error(`updates[${index}].id is required.`);
    const idKey = String(id);
    if (seen.has(idKey)) throw new Error(`Duplicate auth header id in reorder payload: ${idKey}`);
    seen.add(idKey);
    return { id, priority: normalizePriority(item.priority, `updates[${index}].priority`) };
  });

  const existing = await fetchAuthHeaders(apiUrl);
  const existingIds = new Set(existing.map((record) => String(record.id)));
  for (const update of updates) {
    if (!existingIds.has(String(update.id))) throw new Error(`Authentication header not found: ${String(update.id)}`);
  }

  const result = await fetchAPI(apiUrl, '/admin/auth-header/reorder', {
    method: 'POST',
    body: JSON.stringify({ updates }),
  });
  const saved = await fetchAuthHeaders(apiUrl);
  const savedById = new Map<string, AuthHeaderRecord>(saved.map((record) => [String(record.id), record]));
  for (const update of updates) {
    const record = savedById.get(String(update.id));
    if (!record || record.priority !== update.priority) {
      throw new Error(`Authentication header priority was not persisted: ${String(update.id)}`);
    }
  }

  return {
    action: 'auth_headers_reordered',
    updates,
    headers: saved,
    verified: true,
    result,
  };
}
