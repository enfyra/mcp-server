/**
 * HTTP client module for Enfyra MCP Server
 * Handles API requests with auth, timeout, and error handling
 */

import { getValidToken } from './auth.js';

// Timeout configuration
const FETCH_TIMEOUT = 30000; // 30 seconds

/**
 * Make HTTP request to Enfyra API
 * @param {string} apiUrl - Base API URL
 * @param {string} path - Request path
 * @param {object} options - Fetch options
 * @returns {Promise<any>} Response data
 */
export async function fetchAPI(apiUrl, path, options = {}) {
  const url = `${apiUrl}${path}`;
  const token = await getValidToken();

  const headersList = [
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

    if (!res.ok) {
      const error = await res.text().catch(() => res.statusText);
      throw new Error(`API error (${res.status}): ${error}`);
    }

    return res.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${FETCH_TIMEOUT}ms`);
    }
    throw error;
  }
}

/**
 * Validate filter JSON and check for injection patterns
 * @param {string} filterStr - Filter JSON string
 * @returns {object|null} Parsed filter object
 */
export function validateFilter(filterStr) {
  if (!filterStr) return null;
  try {
    const parsed = JSON.parse(filterStr);
    // Check depth limit (max 10 levels)
    function checkDepth(obj, depth = 0) {
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
  } catch (e) {
    if (e.message.includes('depth')) throw e;
    throw new Error(`Invalid filter JSON: ${e.message}`);
  }
}

/**
 * Validate table name (alphanumeric, underscores only)
 * @param {string} tableName - Table name to validate
 * @returns {string} Validated table name
 */
export function validateTableName(tableName) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}. Must start with letter/underscore and contain only alphanumeric characters and underscores.`);
  }
  return tableName;
}
