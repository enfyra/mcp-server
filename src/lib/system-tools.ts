/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { z } from 'zod';
// Import modules
import { fetchAPI } from './fetch.js';
import {
  assertGlobalRulesAck,
  globalRulesAckParam
} from './required-knowledge.js';
import { flushMcpErrorReportsNow } from './mcp-usage-telemetry.js';
import { jsonContent } from './response-format.js';
export function registerSystemTools(server, ENFYRA_API_URL, telemetryToolset = 'guided:all') {
  // ============================================================================
  // CACHE & SYSTEM TOOLS
  // ============================================================================
  
  server.tool('reload_all', 'Reload all caches (metadata, routes, GraphQL)', {
    globalRulesAckKey: globalRulesAckParam(z),
  }, async ({ globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload', { method: 'POST' });
    return jsonContent({ action: 'reloaded_all', result });
  });

  server.tool('reload_metadata', 'Reload metadata cache only', {
    globalRulesAckKey: globalRulesAckParam(z),
  }, async ({ globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/metadata', { method: 'POST' });
    return jsonContent({ action: 'reloaded_metadata', result });
  });

  server.tool('reload_routes', 'Reload routes cache only', {
    globalRulesAckKey: globalRulesAckParam(z),
  }, async ({ globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' });
    return jsonContent({ action: 'reloaded_routes', result });
  });

  server.tool('reload_graphql', 'Reload GraphQL schema', {
    globalRulesAckKey: globalRulesAckParam(z),
  }, async ({ globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/graphql', { method: 'POST' });
    return jsonContent({ action: 'reloaded_graphql', result });
  });

  server.tool(
    'report_mcp_errors',
    'Immediately send pending MCP tool errors to Enfyra telemetry. This bypasses the periodic upload schedule and sends only when pending errors exist.',
    {},
    async () => {
      const result = await flushMcpErrorReportsNow(ENFYRA_API_URL, telemetryToolset);
      return jsonContent({ action: 'reported_mcp_errors', ...result });
    },
  );
}
