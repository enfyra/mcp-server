import { io, type Socket } from 'socket.io-client';
import { getValidToken } from './auth.js';
import { clearRuntimeCacheDomains, recordRuntimeCacheWarm, runtimeCacheDomainsForReloadSteps, runtimeCacheKeysForDomains } from './runtime-cache.js';
import { fetchAPI } from './fetch.js';

type ReloadPayload = {
  status?: 'pending' | 'done';
  steps?: string[];
};

let socket: Socket | null = null;
let socketStarting = false;
let warmTimer: ReturnType<typeof setTimeout> | null = null;

function socketOrigin(apiUrl: string) {
  return apiUrl.replace(/\/api\/?$/, '');
}

export function runtimeCacheSocketConnection(apiUrl: string, token: string) {
  return {
    url: `${socketOrigin(apiUrl)}/ws/enfyra-admin`,
    options: {
      path: '/ws/socket.io',
      reconnection: true,
      reconnectionDelay: 2_000,
      reconnectionDelayMax: 30_000,
      autoConnect: false,
      auth: { token },
      extraHeaders: { Authorization: `Bearer ${token}` },
    },
  };
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
  if (socket || socketStarting) return;
  socketStarting = true;

  void getValidToken(apiUrl)
    .then((token) => {
      const connection = runtimeCacheSocketConnection(apiUrl, token);
      const nextSocket = io(connection.url, connection.options);
      socket = nextSocket;
      socketStarting = false;

      nextSocket.on('$system:reload', (payload: ReloadPayload) => {
        if (payload?.status === 'done') invalidateAndWarm(apiUrl, payload.steps || []);
      });

      nextSocket.on('connect_error', () => {
        // Cache invalidation remains correct through successful mutations and 401/403 self-healing.
      });

      nextSocket.connect();
    })
    .catch(() => {
      socketStarting = false;
      // Tools surface the real authentication failure when they need server data.
    });
}
