export function normalizeSnippetChars(value: unknown) {
  const parsed = Number(value ?? 180);
  if (!Number.isFinite(parsed)) return 180;
  return Math.min(Math.max(Math.trunc(parsed), 120), 600);
}

export function normalizeStrictBoolean(value: unknown) {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
}

export function normalizeTableName(value: unknown) {
  return String(value ?? '').toLowerCase();
}

export function normalizeEscapedVueSource(value: unknown) {
  if (typeof value !== 'string') return value;
  if (/\r|\n/u.test(value)) return value;
  if (!/<(?:script|template|style)\b/iu.test(value)) return value;
  if (!/\\(?:r?\n|["'])/u.test(value)) return value;
  return value
    .replace(/\\r\\n|\\n|\\r/gu, '\n')
    .replace(/\\t/gu, '\t')
    .replace(/\\"/gu, '"')
    .replace(/\\'/gu, "'");
}
