/**
 * HTTP client module for Enfyra MCP Server
 * Handles API requests with auth, timeout, and error handling
 */

import { getValidToken, hasApiToken, resetTokens } from './auth.js';
import { clearRuntimeCache, clearRuntimeCacheDomains, getRuntimeCache, isRuntimeCacheableGet, runtimeCacheDomainsForMutationPath, setRuntimeCache } from './runtime-cache.js';

// Timeout configuration
const FETCH_TIMEOUT = 30000; // 30 seconds

type FetchApiOptions = RequestInit & {
  headers?: Record<string, string>;
};

/**
 * Make HTTP request to Enfyra API
 * @param {string} apiUrl - Base API URL
 * @param {string} path - Request path
 * @param {object} options - Fetch options
 * @returns {Promise<any>} Response data
 */
export async function fetchAPI(apiUrl: string, path: string, options: FetchApiOptions = {}) {
  const url = `${apiUrl}${path}`;
  const method = String(options.method || 'GET').toUpperCase();
  const cacheable = isRuntimeCacheableGet(path, method);
  if (cacheable) {
    const cached = getRuntimeCache(path);
    if (cached !== undefined) return cached;
  }

  async function requestWithCurrentToken() {
    const token = await getValidToken(apiUrl);
    const headersList: [string, string][] = [
      ['Content-Type', 'application/json'],
      ['Authorization', `Bearer ${token}`],
    ];

    if (options.headers) {
      const optHeaders = options.headers;
      for (const key of Object.keys(optHeaders)) {
        const existingIdx = headersList.findIndex(h => h[0] === key);
        if (existingIdx >= 0) {
          headersList[existingIdx] = [key, optHeaders[key]];
        } else {
          headersList.push([key, optHeaders[key]]);
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, {
        ...options,
        headers: headersList,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return res;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${FETCH_TIMEOUT}ms`);
      }
      throw error;
    }
  }

  let res = await requestWithCurrentToken();
  if ((res.status === 401 || res.status === 403) && hasApiToken()) {
    clearRuntimeCache('auth');
    resetTokens();
    res = await requestWithCurrentToken();
  }

  if (!res.ok) {
    const error = await res.text().catch(() => res.statusText);
    throw new Error(`API error (${res.status}): ${error}`);
  }

  const result = await res.json();
  if (cacheable) setRuntimeCache(path, result);
  if (method !== 'GET') {
    clearRuntimeCacheDomains(runtimeCacheDomainsForMutationPath(path), 'mutation');
  }
  return result;
}

/**
 * Validate filter JSON and check for injection patterns
 * @param {string} filterStr - Filter JSON string
 * @returns {object|null} Parsed filter object
 */
export function validateFilter(filterStr: any) {
  if (!filterStr) return null;
  try {
    const parsed = typeof filterStr === 'string' ? JSON.parse(filterStr) : filterStr;
    // Check depth limit (max 10 levels)
    function checkDepth(obj: any, depth = 0) {
      if (depth > 10) {
        throw new Error('Filter depth exceeds maximum of 10 levels');
      }
      if (obj && typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
          checkDepth(obj[key], depth + 1);
        }
      }
    }
    checkDepth(parsed);
    return parsed;
  } catch (e: any) {
    if (e.message.includes('depth')) throw e;
    throw new Error(`Invalid filter JSON: ${e.message}`);
  }
}

/**
 * Validate table name (alphanumeric, underscores only)
 * @param {string} tableName - Table name to validate
 * @returns {string} Validated table name
 */
export function validateTableName(tableName: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}. Must start with letter/underscore and contain only alphanumeric characters and underscores.`);
  }
  return tableName;
}
