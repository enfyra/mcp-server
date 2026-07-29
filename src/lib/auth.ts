import { clearRuntimeCache } from './runtime-cache.js';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let tokenExpiry: number | null = null;
let isRefreshing = false;
let exchangePromise: { revision: number; promise: Promise<string> } | null = null;
let authRevision = 0;

let API_URL = 'http://localhost:3000/api';
let API_TOKEN = '';

const TOKEN_REFRESH_BUFFER = 20_000;

type TokenExchangeResponse = {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  expTime?: number | string;
  exp_time?: number | string;
  expiresAt?: number | string;
  expires_at?: number | string;
};

function normalizeExpiry(expTime: number | string | null | undefined): number {
  if (expTime == null) return Infinity;
  if (typeof expTime === 'number') return expTime < 1_000_000_000_000 ? expTime * 1000 : expTime;
  if (typeof expTime === 'string' && expTime.trim()) {
    const numeric = Number(expTime);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(expTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Infinity;
}

export function initAuth(apiUrl: string, apiToken: string = ''): void {
  API_URL = apiUrl;
  API_TOKEN = apiToken;
  authRevision += 1;
  resetTokens();
  clearRuntimeCache();
}

export function needsRefresh(): boolean {
  if (tokenExpiry === Infinity) return false;
  if (!tokenExpiry) return true;
  return Date.now() + TOKEN_REFRESH_BUFFER >= tokenExpiry;
}

export function hasApiToken(): boolean {
  return !!API_TOKEN;
}

export function getTokenExpiry(): number | null {
  return tokenExpiry;
}

export async function exchangeApiToken(url?: string, apiToken?: string): Promise<string> {
  const apiUrl = url || API_URL;
  const token = apiToken || API_TOKEN;

  if (!token) {
    throw new Error('API token required');
  }

  const revision = authRevision;
  if (exchangePromise?.revision === revision) return exchangePromise.promise;

  const promise = (async (): Promise<string> => {
    console.error('[Auth] Exchanging API token...');
    const response = await fetch(`${apiUrl}/auth/token/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiToken: token }),
    });

    if (!response.ok) {
      throw new Error(`API token exchange failed: ${await response.text()}`);
    }

    const data: TokenExchangeResponse = await response.json();
    if (revision !== authRevision) {
      throw new Error('Authentication credentials changed during token exchange');
    }
    accessToken = data.accessToken || data.access_token || null;
    refreshToken = null;
    tokenExpiry = normalizeExpiry(data.expTime ?? data.exp_time ?? data.expiresAt ?? data.expires_at);

    const expiryLabel = tokenExpiry === Infinity
      ? 'no expiration'
      : new Date(tokenExpiry).toISOString();
    console.error(`[Auth] API token exchanged, access token expires at ${expiryLabel}`);
    return accessToken!;
  })();
  exchangePromise = { revision, promise };

  try {
    return await promise;
  } finally {
    if (exchangePromise?.revision === revision) exchangePromise = null;
  }
}

export async function refreshAccessToken(url?: string): Promise<string> {
  const apiUrl = url || API_URL;

  if (isRefreshing) {
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    return accessToken!;
  }

  if (API_TOKEN) {
    return await exchangeApiToken(apiUrl, API_TOKEN);
  }

  if (!refreshToken) {
    throw new Error('ENFYRA_API_TOKEN required');
  }

  isRefreshing = true;
  try {
    console.error('[Auth] Refreshing token...');
    const response = await fetch(`${apiUrl}/auth/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      refreshToken = null;
      return await exchangeApiToken(apiUrl, API_TOKEN);
    }

    const data: TokenExchangeResponse = await response.json();
    accessToken = data.accessToken || data.access_token || null;
    refreshToken = data.refreshToken || data.refresh_token || null;
    tokenExpiry = normalizeExpiry(data.expTime ?? data.exp_time ?? data.expiresAt ?? data.expires_at);

    console.error(`[Auth] Token refreshed, expires at ${new Date(tokenExpiry!).toISOString()}`);
    return accessToken!;
  } finally {
    isRefreshing = false;
  }
}

export async function getValidToken(url?: string): Promise<string> {
  const apiUrl = url || API_URL;

  if (!accessToken || needsRefresh()) {
    if (API_TOKEN) {
      return await exchangeApiToken(apiUrl, API_TOKEN);
    }
    if (refreshToken) {
      return await refreshAccessToken(apiUrl);
    }
    throw new Error('ENFYRA_API_TOKEN required');
  }
  return accessToken;
}

export function resetTokens(): void {
  accessToken = null;
  refreshToken = null;
  tokenExpiry = null;
  isRefreshing = false;
}
