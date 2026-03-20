/**
 * Authentication module for Enfyra MCP Server
 * Handles login, token refresh, and token validation
 */

// Token state
let accessToken = null;
let refreshToken = null;
let tokenExpiry = null; // expTime từ server (milliseconds)
let isRefreshing = false;

// Config
let API_URL = 'http://localhost:3000/api';
let EMAIL = '';
let PASSWORD = '';

// Refresh buffer: refresh token 1 minute before expiry
const TOKEN_REFRESH_BUFFER = 60000;

/**
 * Initialize auth module with config
 */
export function initAuth(apiUrl, email, password) {
  API_URL = apiUrl;
  EMAIL = email;
  PASSWORD = password;
}

/**
 * Check if token needs refresh (expires within 1 minute)
 */
export function needsRefresh() {
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

/**
 * Login and get access + refresh tokens
 */
export async function login(url, email, password) {
  const apiUrl = url || API_URL;
  const authEmail = email || EMAIL;
  const authPassword = password || PASSWORD;

  if (!authEmail || !authPassword) {
    throw new Error('Email and password required');
  }

  console.error('[Auth] Logging in...');
  const response = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: authEmail, password: authPassword }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${await response.text()}`);
  }

  const data = await response.json();
  accessToken = data.accessToken || data.access_token;
  refreshToken = data.refreshToken || data.refresh_token;
  tokenExpiry = data.expTime;

  console.error(`[Auth] Logged in as ${authEmail}, token expires at ${new Date(tokenExpiry).toISOString()}`);
  return accessToken;
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(url, email, password) {
  const apiUrl = url || API_URL;
  const authEmail = email || EMAIL;
  const authPassword = password || PASSWORD;

  if (isRefreshing) {
    await new Promise(resolve => setTimeout(resolve, 500));
    return accessToken;
  }

  if (!refreshToken) {
    console.error('[Auth] No refresh token, performing fresh login');
    return await login(apiUrl, authEmail, authPassword);
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
      console.error('[Auth] Refresh failed, logging in fresh');
      refreshToken = null;
      return await login(apiUrl, authEmail, authPassword);
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
export async function getValidToken(url, email, password) {
  const apiUrl = url || API_URL;
  const authEmail = email || EMAIL;
  const authPassword = password || PASSWORD;

  if (!accessToken || needsRefresh()) {
    if (refreshToken) {
      return await refreshAccessToken(apiUrl, authEmail, authPassword);
    }
    return await login(apiUrl, authEmail, authPassword);
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
