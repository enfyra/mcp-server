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
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

const RECONNECT_DELAY_MS = 2_000;
const RECONNECT_DELAY_MAX_MS = 30_000;

function socketOrigin(apiUrl: string) {
  return apiUrl.replace(/\/api\/?$/, '');
}

export function runtimeCacheSocketConnection(apiUrl: string, token: string) {
  return {
    url: `${socketOrigin(apiUrl)}/ws/enfyra-admin`,
    options: {
      path: '/ws/socket.io',
      reconnection: false,
      autoConnect: false,
      auth: { token },
      extraHeaders: { Authorization: `Bearer ${token}` },
    },
  };
}

export function applyRuntimeCacheSocketToken(socket: Pick<Socket, 'auth' | 'io'>, token: string) {
  socket.auth = { token };
  const headers = socket.io.opts.extraHeaders || {};
  delete headers.authorization;
  socket.io.opts.extraHeaders = {
    ...headers,
    Authorization: `Bearer ${token}`,
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
  void connectRuntimeCacheSocket(apiUrl);
}

function reconnectDelay() {
  const delay = Math.min(
    RECONNECT_DELAY_MS * 2 ** reconnectAttempt,
    RECONNECT_DELAY_MAX_MS,
  );
  reconnectAttempt += 1;
  return delay;
}

function scheduleRuntimeCacheSocketReconnect(apiUrl: string) {
  if (reconnectTimer || socketStarting) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectRuntimeCacheSocket(apiUrl);
  }, reconnectDelay());
}

function bindRuntimeCacheSocketEvents(nextSocket: Socket, apiUrl: string) {
  nextSocket.on('$system:reload', (payload: ReloadPayload) => {
    if (payload?.status === 'done') invalidateAndWarm(apiUrl, payload.steps || []);
  });

  nextSocket.on('connect', () => {
    reconnectAttempt = 0;
  });

  nextSocket.on('disconnect', () => {
    scheduleRuntimeCacheSocketReconnect(apiUrl);
  });

  nextSocket.on('connect_error', () => {
    scheduleRuntimeCacheSocketReconnect(apiUrl);
  });
}

async function connectRuntimeCacheSocket(apiUrl: string) {
  if (socketStarting) return;
  socketStarting = true;

  try {
    const token = await getValidToken(apiUrl);
    if (socket) {
      applyRuntimeCacheSocketToken(socket, token);
      socket.connect();
    } else {
      const connection = runtimeCacheSocketConnection(apiUrl, token);
      const nextSocket = io(connection.url, connection.options);
      socket = nextSocket;
      bindRuntimeCacheSocketEvents(nextSocket, apiUrl);
      nextSocket.connect();
    }
  } catch {
    // Tools surface the real authentication failure when they need server data.
    socketStarting = false;
    scheduleRuntimeCacheSocketReconnect(apiUrl);
    return;
  }

  socketStarting = false;
}
