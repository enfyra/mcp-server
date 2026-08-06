import { z } from 'zod';
import { ensureAuthHeader, reorderAuthHeaders } from './auth-header-operations.js';
import { jsonText } from './platform-shared-operations.js';
import { globalRulesAckParam } from './required-knowledge.js';

export function registerAuthHeaderTools(server, ENFYRA_API_URL) {
  server.tool(
    'ensure_auth_header',
    [
      'Business operation: create or update one native Enfyra authentication header mapping.',
      'Use this for client request headers; header names are normalized to lowercase.',
      'The same header key may have multiple verifier mappings, such as Authorization Bearer PAT and Authorization Bearer JWT; use priority to choose which mapping runs first.',
      'The built-in x-enfyra-pat and Authorization Bearer mappings remain system records and cannot be disabled or change verifier type.',
    ].join(' '),
    {
      headerKey: z.string().describe('Request header name, e.g. x-client-token.'),
      credentialType: z.enum(['pat', 'jwt']).optional().describe('Native verifier. Defaults to pat for raw headers and jwt for bearer headers.'),
      scheme: z.enum(['raw', 'bearer']).optional().describe('Whether the header value is raw or Bearer-prefixed.'),
      priority: z.number().int().nonnegative().optional().describe('Lower values are checked first. Defaults to the next available priority for a new mapping.'),
      isEnabled: z.boolean().optional().describe('Whether a non-system mapping is active.'),
      description: z.string().nullable().optional().describe('Optional management description.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText({
      action: 'auth_header_ensured',
      ...(await ensureAuthHeader(ENFYRA_API_URL, input)),
    }),
  );

  server.tool(
    'reorder_auth_headers',
    [
      'Business operation: reorder native Enfyra authentication header mappings.',
      'Use the server /admin/auth-header/reorder route so priorities are persisted and the native auth cache is invalidated.',
      'Pass the mappings that changed; system records may be reordered but remain enabled and keep their verifier type.',
    ].join(' '),
    {
      updates: z.array(z.object({
        id: z.union([z.string(), z.number()]).describe('Authentication header mapping id.'),
        priority: z.number().int().nonnegative().describe('Lower values are checked first.'),
      })).min(1).describe('Authentication header priority updates.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText(await reorderAuthHeaders(ENFYRA_API_URL, input)),
  );
}
