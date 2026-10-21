import type { CodeVersionRead } from '../types/code-version.types.js';

export const VERSIONED_CODE_TABLES = [
  'enfyra_route_handler', 'enfyra_pre_hook', 'enfyra_post_hook', 'enfyra_helper',
  'enfyra_websocket', 'enfyra_websocket_event', 'enfyra_oauth_config',
  'enfyra_flow_step', 'enfyra_extension',
] as const;

export function normalizeCodeVersion(value: unknown): string {
  return String(value || '').trim().replace(/^v/i, '');
}

export function validCodeVersion(value: unknown): boolean {
  return /^\d+\.\d+\.\d+(\.\d+)*(-[0-9A-Za-z.]+)*$/.test(normalizeCodeVersion(value));
}

export function compareCodeVersions(left: unknown, right: unknown): number {
  const [a = '', ...aSuffix] = normalizeCodeVersion(left).split('-');
  const [b = '', ...bSuffix] = normalizeCodeVersion(right).split('-');
  const aCore = a.split('.').map(Number);
  const bCore = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aCore.length, bCore.length); i++) {
    const delta = (aCore[i] ?? 0) - (bCore[i] ?? 0);
    if (delta) return delta < 0 ? -1 : 1;
  }
  if (!aSuffix.length && !bSuffix.length) return 0;
  if (!aSuffix.length) return -1;
  if (!bSuffix.length) return 1;
  for (let i = 0; i < Math.max(aSuffix.length, bSuffix.length); i++) {
    const x = aSuffix[i];
    const y = bSuffix[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = Number.parseInt(x, 10);
    const yn = Number.parseInt(y, 10);
    if (!Number.isNaN(xn) && !Number.isNaN(yn)) {
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else {
      const delta = x.localeCompare(y);
      if (delta) return delta < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function nextCodeVersion(current: unknown): string {
  if (!validCodeVersion(current)) throw new Error('Cannot read a valid current version. Refresh the record before saving.');
  const core = normalizeCodeVersion(current).split('-')[0].split('.');
  const patch = Number(core[2]);
  if (!Number.isSafeInteger(patch) || !Number.isSafeInteger(patch + 1)) throw new Error('Choose a custom valid version.');
  return `${core[0]}.${core[1]}.${patch + 1}`;
}

export async function readCodeRecord<T = Record<string, unknown>>(tableName: string, recordId: string, fields: string, read: CodeVersionRead): Promise<{ data?: T[] }> {
  const metadata = await read('/metadata');
  const dbType = metadata.dbType;
  if (!['postgres', 'postgresql', 'mysql', 'mariadb', 'sqlite', 'mongodb'].includes(String(dbType))) throw new Error('Cannot resolve the database primary key.');
  const primaryKey = dbType === 'mongodb' ? '_id' : 'id';
  const query = new URLSearchParams({ fields, limit: '1', filter: JSON.stringify({ [primaryKey]: { _eq: recordId } }) });
  return await read(`/${tableName}?${query}`) as { data?: T[] };
}

export async function prepareCodeUpdate(path: string, body: Record<string, unknown>, read: CodeVersionRead): Promise<Record<string, unknown>> {
  const match = /^\/([^/?]+)\/([^/?]+)(?:\?.*)?$/.exec(path);
  if (!match || !VERSIONED_CODE_TABLES.some(table => table === match[1])) return body;
  const response = await readCodeRecord(match[1], decodeURIComponent(match[2]), 'version', read);
  const current = normalizeCodeVersion(response.data?.[0]?.version);
  const suggestion = nextCodeVersion(current);
  const supplied = body.version !== undefined && body.version !== null && body.version !== '';
  const version = supplied ? normalizeCodeVersion(body.version) : suggestion;
  if (!validCodeVersion(version)) throw new Error('version must be valid, for example 1.0.1.');
  if (compareCodeVersions(version, current) <= 0) throw new Error(`version must be greater than ${current}.`);
  return { ...body, version };
}
