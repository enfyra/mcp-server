/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { z } from 'zod';
// Import modules
import { exchangeApiToken, getTokenExpiry, initAuth } from './auth.js';
import {
  DEFAULT_ME_PERMISSION_FIELDS,
  ENFYRA_API_TOKEN,
  firstDataRecord,
  summarizePermissionProfile,
} from './enfyra-tool-logic.js';
import { fetchAPI } from './fetch.js';
import { jsonContent } from './response-format.js';

export function registerIdentityTools(server, ENFYRA_API_URL) {
  // ============================================================================
  // AUTH & USER TOOLS
  // ============================================================================
  
  server.tool('get_current_user', 'Get the current authenticated user and every assigned role.', {}, async () => {
    const fields = DEFAULT_ME_PERMISSION_FIELDS.join(',');
    const result = await fetchAPI(ENFYRA_API_URL, `/me?fields=${encodeURIComponent(fields)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.tool(
    'get_permission_profile',
    [
      'Inspect the current token permission profile using the same route-permission model as Enfyra admin UI usePermissions().',
      'Use this before debugging 403s or before relying on admin helper tools with a non-root API token.',
      'Reports which MCP tool groups need route permissions such as /admin/script/validate, /admin/test/run, /admin/flow/trigger/:id, and reload endpoints.',
    ].join(' '),
    {},
    async () => {
      const fields = DEFAULT_ME_PERMISSION_FIELDS.join(',');
      const result = await fetchAPI(ENFYRA_API_URL, `/me?fields=${encodeURIComponent(fields)}`);
      const user = firstDataRecord(result);
      return jsonContent(summarizePermissionProfile(user));
    },
  );

  server.tool('get_all_roles', 'Get all role definitions', {}, async () => {
    const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_role?limit=100');
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('login', 'Force authentication to Enfyra and get a new access token', {
    apiToken: z.string().optional().describe('API token for MCP and automation'),
  }, async ({ apiToken }) => {
    const token = apiToken || ENFYRA_API_TOKEN;
    if (token) {
      initAuth(ENFYRA_API_URL, token);
      await exchangeApiToken(ENFYRA_API_URL, token);
      const expiry = getTokenExpiry();
      const expiryLabel = expiry === Infinity ? 'no expiration' : new Date(expiry).toISOString();
      return { content: [{ type: 'text', text: `Authenticated with API token.\nToken expires: ${expiryLabel}` }] };
    }
    throw new Error('ENFYRA_API_TOKEN required');
  });
}
