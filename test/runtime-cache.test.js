import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearRuntimeCache,
  clearRuntimeCacheDomains,
  getRuntimeCache,
  getRuntimeCacheTelemetry,
  setRuntimeCache,
} from '../dist/lib/runtime-cache.js';

test('runtime cache reports hit rate and timestamped reload recovery without recording paths', () => {
  clearRuntimeCache();
  const before = getRuntimeCacheTelemetry();
  const path = '/metadata?table=orders';

  setRuntimeCache(path, { data: [{ name: 'orders' }] });
  assert.deepEqual(getRuntimeCache(path), { data: [{ name: 'orders' }] });
  assert.equal(getRuntimeCache('/metadata?table=missing'), undefined);
  clearRuntimeCacheDomains(['metadata'], 'reload');

  const after = getRuntimeCacheTelemetry();
  assert.equal(after.hits - before.hits, 1);
  assert.equal(after.misses - before.misses, 1);
  assert.equal(after.invalidations.reload - before.invalidations.reload, 1);
  const event = after.events.at(-1);
  assert.equal(event?.kind, 'reload_invalidation');
  assert.deepEqual(event?.domains, ['metadata']);
  assert.equal(JSON.stringify(event).includes(path), false);
  assert.match(event?.timestamp || '', /^\d{4}-\d{2}-\d{2}T/);
});
