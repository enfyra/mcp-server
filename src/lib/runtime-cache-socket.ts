import { io, type Socket } from 'socket.io-client';
import { getApiToken } from './auth.js';
import { fetchAPI } from './fetch.js';
import { clearRuntimeCache, clearRuntimeCacheDomains, recordRuntimeCacheWarm, runtimeCacheDomainsForReloadSteps, runtimeCacheKeysForDomains, setRuntimeCacheEnabled } from './runtime-cache.js';

type ReloadPayload = {
  status?: 'pending' | 'done';
  steps?: string[];
};

let socket: Socket | null = null;
let socketStarting = false;
let socketStopped = false;
let warmTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

const RECONNECT_DELAY_MS = 2_000;
const RECONNECT_DELAY_MAX_MS = 30_000;

function cancelRuntimeCacheWarm() {
  if (!warmTimer) return;
  clearTimeout(warmTimer);
  warmTimer = null;
}

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
      auth: {},
      extraHeaders: { 'x-enfyra-pat': token },
    },
  };
}

export function applyRuntimeCacheSocketToken(socket: Pick<Socket, 'auth' | 'io'>, token: string) {
  socket.auth = {};
  const headers = socket.io.opts.extraHeaders || {};
  delete headers.authorization;
  delete headers.Authorization;
  socket.io.opts.extraHeaders = {
    ...headers,
    'x-enfyra-pat': token,
  };
}

export function isRuntimeCacheSocketAuthError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    message?: unknown;
    data?: { code?: unknown; data?: { code?: unknown } };
  };
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  const code = candidate.data?.code ?? candidate.data?.data?.code;
  return code === 'AUTH_INVALID' ||
    code === 'AUTH_REQUIRED' ||
    message.includes('Invalid authentication token') ||
    message.includes('Authentication token required') ||
    message.includes('ENFYRA_AUTH_REQUIRED') ||
    message.includes('ENFYRA_SOCKET_AUTH_ERROR');
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
  if (steps.length === 0 || steps.some((step) => runtimeCacheDomainsForReloadSteps([step]).length === 0)) {
    cancelRuntimeCacheWarm();
    clearRuntimeCache('reload');
    return;
  }
  const domains = runtimeCacheDomainsForReloadSteps(steps);
  const paths = runtimeCacheKeysForDomains(domains);
  clearRuntimeCacheDomains(domains, 'reload');
  if (!paths.length) return;
  cancelRuntimeCacheWarm();
  warmTimer = setTimeout(() => {
    warmTimer = null;
    void refreshCachedEntries(apiUrl, paths);
  }, 50);
}

export function startRuntimeCacheSocket(apiUrl: string) {
  if (socket || socketStarting || socketStopped) return;
  setRuntimeCacheEnabled(false);
  clearRuntimeCache('reload');
  void connectRuntimeCacheSocket(apiUrl);
}

function stopReconnecting() {
  socketStopped = true;
  setRuntimeCacheEnabled(false);
  clearRuntimeCache('auth');
  cancelRuntimeCacheWarm();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  console.error('[RuntimeCacheSocket] API token rejected — socket reconnect stopped.');
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
  if (reconnectTimer || socketStarting || socketStopped) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectRuntimeCacheSocket(apiUrl);
  }, reconnectDelay());
}

function bindRuntimeCacheSocketEvents(nextSocket: Socket, apiUrl: string) {
  nextSocket.on('$system:reload', (payload: ReloadPayload) => {
    if (payload?.status === 'done') invalidateAndWarm(apiUrl, Array.isArray(payload.steps) ? payload.steps : []);
  });

  nextSocket.on('connect', () => {
    clearRuntimeCache('reload');
    setRuntimeCacheEnabled(true);
    reconnectAttempt = 0;
  });

  nextSocket.on('disconnect', () => {
    setRuntimeCacheEnabled(false);
    clearRuntimeCache('reload');
    cancelRuntimeCacheWarm();
    scheduleRuntimeCacheSocketReconnect(apiUrl);
  });

  nextSocket.on('connect_error', (err: Error) => {
    if (isRuntimeCacheSocketAuthError(err)) {
      stopReconnecting();
    } else {
      setRuntimeCacheEnabled(false);
      clearRuntimeCache('reload');
      cancelRuntimeCacheWarm();
      scheduleRuntimeCacheSocketReconnect(apiUrl);
    }
  });
}

async function connectRuntimeCacheSocket(apiUrl: string) {
  if (socketStarting) return;
  socketStarting = true;

  try {
    const token = getApiToken();
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
    socketStarting = false;
    scheduleRuntimeCacheSocketReconnect(apiUrl);
    return;
  }

  socketStarting = false;
}
