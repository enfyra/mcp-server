/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { z } from 'zod';
// Import modules
import { initAuth } from './auth.js';
import {
  DEFAULT_ME_PERMISSION_FIELDS,
  ENFYRA_API_TOKEN,
  firstDataRecord,
  getId,
  summarizePermissionProfile,
} from './enfyra-tool-logic.js';
import { fetchAPI } from './fetch.js';
import { assertGlobalRulesAck, globalRulesAckParam } from './required-knowledge.js';
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

  server.tool('ensure_user_role', 'Add one role to a user without removing existing roles or creating duplicates. Use this for multi-role membership; route, field, asset, and menu authority is the union of assigned roles.', {
    userId: z.string().min(1).describe('Existing user id.'),
    roleId: z.union([z.string(), z.number()]).optional().describe('Existing role id.'),
    roleName: z.string().min(1).optional().describe('Existing role name.'),
    globalRulesAckKey: globalRulesAckParam(z),
  }, async ({ userId, roleId, roleName, globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    if ((roleId == null) === (!roleName)) throw new Error('Provide exactly one of roleId or roleName.');
    const userQuery = new URLSearchParams({ filter: JSON.stringify({ id: { _eq: userId } }), fields: 'id,email,roles', deep: JSON.stringify({ roles: { fields: ['id', 'name'] } }), limit: '1' });
    const user = firstDataRecord(await fetchAPI(ENFYRA_API_URL, `/enfyra_user?${userQuery}`));
    if (!user) throw new Error(`User not found: ${userId}`);
    const roleFilter = roleId == null ? { name: { _eq: roleName } } : { id: { _eq: roleId } };
    const roleQuery = new URLSearchParams({ filter: JSON.stringify(roleFilter), fields: 'id,name', limit: '1' });
    const role = firstDataRecord(await fetchAPI(ENFYRA_API_URL, `/enfyra_role?${roleQuery}`));
    if (!role) throw new Error(roleName ? `Role not found: ${roleName}` : `Role not found: ${roleId}`);
    const resolvedRoleId = getId(role);
    const currentRoleIds = [...new Set((Array.isArray(user.roles) ? user.roles : []).map(getId).filter((id) => id != null))];
    const alreadyAssigned = currentRoleIds.some((id) => String(id) === String(resolvedRoleId));
    if (!alreadyAssigned) await fetchAPI(ENFYRA_API_URL, `/enfyra_user/${encodeURIComponent(String(getId(user)))}`, { method: 'PATCH', body: JSON.stringify({ roles: [...currentRoleIds, resolvedRoleId] }) });
    const verified = firstDataRecord(await fetchAPI(ENFYRA_API_URL, `/enfyra_user?${userQuery}`));
    return jsonContent({ action: alreadyAssigned ? 'unchanged' : 'user_role_ensured', user: { id: getId(verified), email: verified?.email ?? null }, addedRole: { id: resolvedRoleId, name: role.name ?? null }, roles: Array.isArray(verified?.roles) ? verified.roles.map((item) => ({ id: getId(item), name: item?.name ?? null })) : [] });
  });

  server.tool('login', 'Configure and verify the Enfyra API token used by this MCP process', {
    apiToken: z.string().optional().describe('API token for MCP and automation'),
  }, async ({ apiToken }) => {
    const token = apiToken || ENFYRA_API_TOKEN;
    if (token) {
      initAuth(ENFYRA_API_URL, token);
      await fetchAPI(ENFYRA_API_URL, '/me?fields=id');
      return { content: [{ type: 'text', text: 'Authenticated with API token.' }] };
    }
    throw new Error('ENFYRA_API_TOKEN required');
  });
}
