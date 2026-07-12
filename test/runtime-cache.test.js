import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearRuntimeCache,
  clearRuntimeCacheDomains,
  getRuntimeCache,
  getRuntimeCacheTelemetry,
  setRuntimeCache,
} from '../dist/lib/runtime-cache.js';
import {
  applyRuntimeCacheSocketToken,
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

test('runtime cache socket uses the authenticated Nuxt bridge namespace', () => {
  const connection = runtimeCacheSocketConnection(
    'http://localhost:3000/api',
    'access-token',
  );

  assert.equal(connection.url, 'http://localhost:3000/ws/enfyra-admin');
  assert.equal(connection.options.path, '/ws/socket.io');
  assert.equal(connection.options.reconnection, false);
  assert.deepEqual(connection.options.auth, { token: 'access-token' });
  assert.deepEqual(connection.options.extraHeaders, {
    Authorization: 'Bearer access-token',
  });
});

test('runtime cache socket replaces both handshake credentials before a manual reconnect', () => {
  const socket = {
    auth: { token: 'expired-token' },
    io: { opts: { extraHeaders: { Authorization: 'Bearer expired-token' } } },
  };

  applyRuntimeCacheSocketToken(socket, 'fresh-token');

  assert.deepEqual(socket.auth, { token: 'fresh-token' });
  assert.deepEqual(socket.io.opts.extraHeaders, {
    Authorization: 'Bearer fresh-token',
  });
});
