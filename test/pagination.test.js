import test from 'node:test';
import assert from 'node:assert/strict';

import { paginateResults } from '../dist/lib/pagination.js';

test('paginateResults returns opaque stable cursors and rejects cursor reuse for another query', () => {
  const values = Array.from({ length: 7 }, (_, index) => ({ id: index + 1 }));
  const first = paginateResults(values, { limit: 3, fingerprint: { zone: 'api_runtime', query: 'route' } });
  assert.deepEqual(first.items.map((item) => item.id), [1, 2, 3]);
  assert.equal(first.page.returned, 3);
  assert.equal(first.page.total, 7);
  assert.ok(first.page.nextCursor);

  const second = paginateResults(values, {
    limit: 3,
    cursor: first.page.nextCursor,
    fingerprint: { zone: 'api_runtime', query: 'route' },
  });
  assert.deepEqual(second.items.map((item) => item.id), [4, 5, 6]);

  assert.throws(() => paginateResults(values, {
    limit: 3,
    cursor: first.page.nextCursor,
    fingerprint: { zone: 'flow_runtime', query: 'route' },
  }), /does not match/i);
});
