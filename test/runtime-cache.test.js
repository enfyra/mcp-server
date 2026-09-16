import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearRuntimeCache,
  clearRuntimeCacheDomains,
  getRuntimeCache,
  getRuntimeCacheTelemetry,
  runtimeCacheDomainsForMutationPath,
  runtimeCacheDomainsForReloadSteps,
  runtimeCacheGenerationForPath,
  setRuntimeCache,
} from '../dist/lib/runtime-cache.js';
import {
  applyRuntimeCacheSocketToken,
  isRuntimeCacheSocketAuthError,
  runtimeCacheSocketConnection,
} from '../dist/lib/runtime-cache-socket.js';

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

test('an invalidated in-flight request cannot repopulate stale runtime cache data', () => {
  clearRuntimeCache();
  const path = '/metadata?table=orders';
  const generation = runtimeCacheGenerationForPath(path);
  clearRuntimeCacheDomains(['metadata'], 'reload');
  setRuntimeCache(path, { data: [{ name: 'stale' }] }, generation);
  assert.equal(getRuntimeCache(path), undefined);
});

test('runtime cache keeps reload dependencies and storage bounded', () => {
  clearRuntimeCache();
  assert.deepEqual(runtimeCacheDomainsForReloadSteps(['extension']).sort(), ['extension', 'menu']);
  assert.ok(runtimeCacheDomainsForMutationPath('/enfyra_role/17').includes('fieldPermission'));

  for (let index = 0; index <= 500; index += 1) {
    setRuntimeCache(`/metadata?table=table_${index}`, { index });
  }
  assert.equal(getRuntimeCache('/metadata?table=table_0'), undefined);
  assert.deepEqual(getRuntimeCache('/metadata?table=table_500'), { index: 500 });
});

test('runtime cache socket uses the authenticated Nuxt bridge namespace', () => {
  const connection = runtimeCacheSocketConnection(
    'http://localhost:3000/api',
    'access-token',
  );

  assert.equal(connection.url, 'http://localhost:3000/ws/enfyra-admin');
  assert.equal(connection.options.path, '/ws/socket.io');
  assert.equal(connection.options.reconnection, false);
  assert.deepEqual(connection.options.auth, {});
  assert.deepEqual(connection.options.extraHeaders, {
    'x-enfyra-pat': 'access-token',
  });
});

test('runtime cache socket replaces both handshake credentials before a manual reconnect', () => {
  const socket = {
    auth: { token: 'expired-token' },
    io: { opts: { extraHeaders: { 'x-enfyra-pat': 'expired-token' } } },
  };

  applyRuntimeCacheSocketToken(socket, 'fresh-token');

  assert.deepEqual(socket.auth, {});
  assert.deepEqual(socket.io.opts.extraHeaders, {
    'x-enfyra-pat': 'fresh-token',
  });
});

test('runtime cache socket recognizes bridge and backend authentication failures', () => {
  assert.equal(
    isRuntimeCacheSocketAuthError(new Error('Invalid authentication token')),
    true,
  );
  assert.equal(
    isRuntimeCacheSocketAuthError(new Error('ENFYRA_AUTH_REQUIRED')),
    true,
  );
  assert.equal(
    isRuntimeCacheSocketAuthError({
      message: 'connection rejected',
      data: { code: 'AUTH_INVALID' },
    }),
    true,
  );
  assert.equal(
    isRuntimeCacheSocketAuthError({
      message: 'connection rejected',
      data: { data: { code: 'AUTH_REQUIRED' } },
    }),
    true,
  );
  assert.equal(isRuntimeCacheSocketAuthError(new Error('timeout')), false);
});
