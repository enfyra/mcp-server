import { createHash } from 'node:crypto';

type PaginationOptions = {
  limit: number;
  cursor?: string;
  fingerprint: unknown;
};

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 16);
}

function encodeCursor(offset: number, queryFingerprint: string) {
  return Buffer.from(JSON.stringify({ v: 1, offset, fingerprint: queryFingerprint }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (decoded?.v !== 1 || !Number.isInteger(decoded?.offset) || decoded.offset < 0 || typeof decoded?.fingerprint !== 'string') {
      throw new Error('invalid cursor payload');
    }
    return decoded as { v: number; offset: number; fingerprint: string };
  } catch {
    throw new Error('Invalid pagination cursor. Restart the search without cursor.');
  }
}

export function paginateResults<T>(items: T[], { limit, cursor, fingerprint: fingerprintInput }: PaginationOptions) {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const queryFingerprint = fingerprint(fingerprintInput);
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded && decoded.fingerprint !== queryFingerprint) {
    throw new Error('Pagination cursor does not match this search. Restart without cursor after changing query, zone, filters, or page size.');
  }
  const offset = decoded?.offset ?? 0;
  const pageItems = items.slice(offset, offset + boundedLimit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    page: {
      offset,
      returned: pageItems.length,
      total: items.length,
      complete: nextOffset >= items.length,
      nextCursor: nextOffset < items.length ? encodeCursor(nextOffset, queryFingerprint) : null,
    },
  };
}
