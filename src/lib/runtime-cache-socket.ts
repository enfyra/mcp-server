import { io, type Socket } from 'socket.io-client';
import { getValidToken } from './auth.js';
import { clearRuntimeCacheDomains, recordRuntimeCacheWarm, runtimeCacheDomainsForReloadSteps, runtimeCacheKeysForDomains } from './runtime-cache.js';
import { fetchAPI } from './fetch.js';

type ReloadPayload = {
  status?: 'pending' | 'done';
  steps?: string[];
};

let socket: Socket | null = null;
let warmTimer: ReturnType<typeof setTimeout> | null = null;

function socketOrigin(apiUrl: string) {
  return apiUrl.replace(/\/api\/?$/, '');
}

async function refreshCachedEntries(apiUrl: string, paths: string[]) {
  await Promise.all(paths.map(async (path) => {
    try {
      await fetchAPI(apiUrl, path);
      recordRuntimeCacheWarm(path, true);
    } catch {
      recordRuntimeCacheWarm(path, false);
      // The next focused tool call retries a cache entry that could not warm.
    }
  }));
}

function invalidateAndWarm(apiUrl: string, steps: string[]) {
  const domains = runtimeCacheDomainsForReloadSteps(steps);
  if (!domains.length) return;
  const paths = runtimeCacheKeysForDomains(domains);
  clearRuntimeCacheDomains(domains, 'reload');
  if (!paths.length) return;
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    warmTimer = null;
    void refreshCachedEntries(apiUrl, paths);
  }, 50);
}

export function startRuntimeCacheSocket(apiUrl: string) {
  if (socket) return;
  socket = io(`${socketOrigin(apiUrl)}/enfyra-admin`, {
    path: '/ws/socket.io',
    reconnection: true,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 30_000,
    autoConnect: false,
  });

  socket.on('$system:reload', (payload: ReloadPayload) => {
    if (payload?.status === 'done') invalidateAndWarm(apiUrl, payload.steps || []);
  });

  socket.on('connect_error', () => {
    // Cache invalidation remains correct through successful mutations and 401/403 self-healing.
  });

  void getValidToken(apiUrl)
    .then((token) => {
      socket!.auth = { token };
      socket!.connect();
    })
    .catch(() => {
      // Tools surface the real authentication failure when they need server data.
    });
}
