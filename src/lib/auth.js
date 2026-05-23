/**
 * Authentication module for Enfyra MCP Server
 * Handles API-token exchange and token validation
 */

// Token state
let accessToken = null;
let refreshToken = null;
let tokenExpiry = null; // expTime từ server (milliseconds)
let isRefreshing = false;

// Config
let API_URL = 'http://localhost:3000/api';
let API_TOKEN = '';

// Refresh buffer: refresh token 1 minute before expiry
const TOKEN_REFRESH_BUFFER = 60000;

/**
 * Initialize auth module with config
 */
export function initAuth(apiUrl, apiToken = '') {
  API_URL = apiUrl;
  API_TOKEN = apiToken;
}

/**
 * Check if token needs refresh (expires within 1 minute)
 */
export function needsRefresh() {
  if (tokenExpiry === Infinity) return false;
  if (!tokenExpiry) return true;
  const now = Date.now();
  return now + TOKEN_REFRESH_BUFFER >= tokenExpiry;
}

/**
 * Get current access token (does not refresh)
 */
export function getAccessToken() {
  return accessToken;
}

/**
 * Get token expiry time
 */
export function getTokenExpiry() {
  return tokenExpiry;
}

export async function exchangeApiToken(url, apiToken) {
  const apiUrl = url || API_URL;
  const token = apiToken || API_TOKEN;

  if (!token) {
    throw new Error('API token required');
  }

  console.error('[Auth] Exchanging API token...');
  const response = await fetch(`${apiUrl}/auth/token/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiToken: token }),
  });

  if (!response.ok) {
    throw new Error(`API token exchange failed: ${await response.text()}`);
  }

  const data = await response.json();
  accessToken = data.accessToken || data.access_token;
  refreshToken = null;
  tokenExpiry = data.expTime == null ? Infinity : data.expTime;

  const expiryLabel = tokenExpiry === Infinity
    ? 'no expiration'
    : new Date(tokenExpiry).toISOString();
  console.error(`[Auth] API token exchanged, access token expires at ${expiryLabel}`);
  return accessToken;
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(url) {
  const apiUrl = url || API_URL;

  if (isRefreshing) {
    await new Promise(resolve => setTimeout(resolve, 500));
    return accessToken;
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

    const data = await response.json();
    accessToken = data.accessToken || data.access_token;
    refreshToken = data.refreshToken || data.refresh_token;
    tokenExpiry = data.expTime;

    console.error(`[Auth] Token refreshed, expires at ${new Date(tokenExpiry).toISOString()}`);
    return accessToken;
  } finally {
    isRefreshing = false;
  }
}

/**
 * Get valid access token, refreshing if needed
 */
export async function getValidToken(url) {
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

/**
 * Reset token state (for logout)
 */
export function resetTokens() {
  accessToken = null;
  refreshToken = null;
  tokenExpiry = null;
  isRefreshing = false;
}
