import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildMcpServerInstructions } from '../dist/lib/mcp-instructions.js';
import { initAuth, resetTokens } from '../dist/lib/auth.js';
import {
  acknowledgeRequiredKnowledge,
  assertDynamicCodeKnowledgeAck,
  assertExtensionKnowledgeAck,
  assertGlobalRulesAck,
  getRequiredKnowledgeSessionState,
  resetRequiredKnowledgeSession,
} from '../dist/lib/required-knowledge.js';
import {
  buildExtensionRuntimeVerification,
  buildExtensionPatchDiffArtifact,
  buildExtensionUiSnippet,
  reviewExtensionUiContract,
  summarizeWorkflowOperation,
  validateExtensionCodeLocally,
  verifyExtensionRuntime,
} from '../dist/lib/platform-operation-tools.js';
import { normalizeCreateTableDefinitions } from '../dist/lib/table-tools.js';
import { assertGenericRecordMutationAllowed } from '../dist/lib/mutation-guards.js';
import {
  afterMcpToolExecution,
  beforeMcpToolExecution,
  getMcpSafetySessionState,
  resetMcpSafetySession,
} from '../dist/lib/session-safety.js';
import { normalizeEscapedVueSource, normalizeSnippetChars, normalizeStrictBoolean, normalizeTableName } from '../dist/lib/tool-input-normalization.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('required knowledge acknowledgement persists by domain for the MCP process session', () => {
  resetRequiredKnowledgeSession();
  assert.throws(() => assertGlobalRulesAck(), /Call get_enfyra_required_knowledge/);

  acknowledgeRequiredKnowledge('extension');
  assert.doesNotThrow(() => assertGlobalRulesAck());
  assert.doesNotThrow(() => assertExtensionKnowledgeAck());
  assert.throws(() => assertDynamicCodeKnowledgeAck(), /dynamic server code contracts/);
  assert.doesNotThrow(() => assertExtensionKnowledgeAck('stale-key'));
  assert.deepEqual(getRequiredKnowledgeSessionState().acknowledgedDomains, ['globalRules', 'extensions']);

  resetRequiredKnowledgeSession();
});

test('mutations require target confirmation in the same MCP process session', () => {
  resetMcpSafetySession();
  assert.throws(
    () => beforeMcpToolExecution('ensure_widget_extension', { name: 'Blocked' }),
    /get_enfyra_api_context/,
  );
  assert.doesNotThrow(() => beforeMcpToolExecution('search_admin_extensions', { query: 'read-only' }));

  afterMcpToolExecution('get_enfyra_api_context', {});
  assert.doesNotThrow(() => beforeMcpToolExecution('ensure_widget_extension', { name: 'Allowed' }));
  assert.equal(getMcpSafetySessionState().targetConfirmed, true);

  resetMcpSafetySession();
});

test('destructive confirmation requires a matching successful preview', () => {
  resetMcpSafetySession();
  afterMcpToolExecution('get_enfyra_api_context', {});
  const preview = {
    tableName: 'enfyra_extension',
    items: [{ id: 42 }],
    confirm: false,
  };
  const confirmation = {
    tableName: 'enfyra_extension',
    items: [{ id: '42' }],
    confirm: true,
    skipNotFound: true,
    globalRulesAckKey: 'compat-key',
  };

  assert.throws(
    () => beforeMcpToolExecution('delete_records', confirmation),
    /preview/i,
  );
  beforeMcpToolExecution('delete_records', preview);
  afterMcpToolExecution('delete_records', preview);
  assert.doesNotThrow(() => beforeMcpToolExecution('delete_records', confirmation));
  afterMcpToolExecution('delete_records', confirmation);
  assert.throws(
    () => beforeMcpToolExecution('delete_records', confirmation),
    /preview/i,
  );

  resetMcpSafetySession();
});

test('weak-agent snippet sizes are clamped instead of rejected', () => {
  assert.equal(normalizeSnippetChars(undefined), 180);
  assert.equal(normalizeSnippetChars(80), 120);
  assert.equal(normalizeSnippetChars(700), 600);
  assert.equal(normalizeSnippetChars(2000), 600);
});

test('weak-agent scalar normalization is safe and deterministic', () => {
  assert.equal(normalizeStrictBoolean(false), false);
  assert.equal(normalizeStrictBoolean('false'), false);
  assert.equal(normalizeStrictBoolean(' TRUE '), true);
  assert.equal(normalizeStrictBoolean('0'), '0');
  assert.equal(normalizeTableName('McpCert_Incident'), 'mcpcert_incident');
  assert.deepEqual(normalizeCreateTableDefinitions([
    { name: 'McpCert_Incident' },
    { name: 'McpCert_Note', relations: [{ propertyName: 'incident', targetTable: 'McpCert_Incident' }] },
  ]), [
    { name: 'mcpcert_incident', _requestedTableName: 'McpCert_Incident' },
    { name: 'mcpcert_note', relations: [{ propertyName: 'incident', targetTable: 'mcpcert_incident' }], _requestedTableName: 'McpCert_Note' },
  ]);
});

test('transport-only Vue source escaping is normalized without rewriting valid source', () => {
  const escaped = String.raw`<script setup>\nconst label = \'Tickets\'\n</script>\n<template><div class=\"p-2\">{{ label }}</div></template>`;
  assert.equal(normalizeEscapedVueSource(escaped), [
    '<script setup>',
    "const label = 'Tickets'",
    '</script>',
    '<template><div class="p-2">{{ label }}</div></template>',
  ].join('\n'));
  const valid = '<template><div class="p-2">ok</div></template>';
  assert.equal(normalizeEscapedVueSource(valid), valid);
  assert.equal(normalizeEscapedVueSource('const value = "\\n"'), 'const value = "\\n"');
});

test('generic CRUD cannot bypass domain-owned schema and route operations', () => {
  assert.throws(() => assertGenericRecordMutationAllowed('delete', 'enfyra_table'), /delete_tables/);
  assert.throws(() => assertGenericRecordMutationAllowed('create', 'enfyra_route'), /api_endpoint_workflow/);
  assert.doesNotThrow(() => assertGenericRecordMutationAllowed('delete', 'enfyra_extension'));
});

test('full knowledge scope and disabled-flow verification paths are explicit', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /scope: z\.enum\(\['full', 'schema', 'dynamic-code', 'extension', 'flow'\]\)/);
  assert.match(entry, /Flow .* is disabled[\s\S]*test_flow_step/);
  assert.match(entry, /test_flow_step[\s\S]*payload: z\.union[\s\S]*parsedPayload[\s\S]*payload: parsedPayload/);
});

test('script source reads require a located record instead of guessed ids', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /Never guess or probe record ids/);
  assert.match(entry, /Use search_runtime_zone first and pass the returned nextInspect\.input/);
});

test('successful extension writes verify the exact saved source without relying on a follow-up model call', () => {
  const source = readFileSync(new URL('../src/lib/platform-operation-tools.ts', import.meta.url), 'utf8');
  assert.match(source, /async function updateExtensionCode[\s\S]*?const verification = await verifyExtensionRuntime[\s\S]*?verification,/);
  assert.match(source, /async function ensureExtension[\s\S]*?const verification = await verifyExtensionRuntime[\s\S]*?verification,/);
});

test('guided workflow operation summaries exclude raw dynamic source and compiled output', () => {
  const summary = summarizeWorkflowOperation({
    action: 'handler_created',
    result: {
      statusCode: 200,
      data: [{ id: 17, sourceCode: 'secret source', compiledCode: 'large compiled source', path: '/intake' }],
      message: 'Success',
    },
    routeReload: { attempted: true, succeeded: true, result: { large: 'payload' } },
  });
  assert.deepEqual(summary, {
    action: 'handler_created',
    result: { statusCode: 200, message: 'Success', record: { id: 17, path: '/intake' } },
    routeReload: { attempted: true, succeeded: true },
  });
  assert.doesNotMatch(JSON.stringify(summary), /sourceCode|compiledCode|secret source|large compiled/);
});

test('startup instructions remain a compact router because hosts may repeat them per tool', () => {
  const instructions = buildMcpServerInstructions('https://admin.example.com/api', {
    toolsetSummary: 'Toolset mode: guided.',
  });
  assert.ok(Buffer.byteLength(instructions, 'utf8') < 1800);
  assert.match(instructions, /get_enfyra_api_context/);
  assert.match(instructions, /get_enfyra_required_knowledge/);
  assert.match(instructions, /discover_enfyra_workflows/);
  assert.match(instructions, /Third-app OAuth: connect first/);
  assert.match(instructions, /ask only for them and stop/);
  assert.match(instructions, /Show only the callback returned by `setup_oauth_provider`/);
  assert.doesNotMatch(instructions, /### Operating Model/);
});

test('resource-list policy rejects ad hoc inventory markup and accepts the common list contract', () => {
  const adHoc = [
    '<template>',
    '  <section class="space-y-4">',
    '    <UCard v-for="item in items" :key="item.id">{{ item.name }}</UCard>',
    '  </section>',
    '</template>',
  ].join('\n');
  const rejected = reviewExtensionUiContract(adHoc, { pattern: 'resource_list' });
  assert.equal(rejected.valid, false);
  assert.match(JSON.stringify(rejected.issues), /resource-list-frame-required/);
  assert.match(JSON.stringify(rejected.issues), /resource-list-item-required/);
  assert.throws(
    () => validateExtensionCodeLocally(adHoc, { uiPattern: 'resource_list' }),
    /Invalid extension UI contract/,
  );

  const accepted = [
    '<template>',
    '  <section class="eapp-page-constrained-wide space-y-4">',
    '    <div class="eapp-surface-card eapp-radius-panel border eapp-divider">Filters</div>',
    '    <CommonResourceListFrame :loading="pending" :has-items="items.length > 0" :total="items.length" :items-per-page="0" empty-title="No items">',
    '      <CommonResourceListItem v-for="item in items" :key="item.id" :title="item.name" />',
    '    </CommonResourceListFrame>',
    '  </section>',
    '</template>',
  ].join('\n');
  const approved = reviewExtensionUiContract(accepted, { pattern: 'resource_list' });
  assert.equal(approved.valid, true);
  assert.equal(approved.issues.length, 0);

  const paginated = buildExtensionUiSnippet('resource_list', {
    itemsExpression: 'items',
    itemsPerPageExpression: 'pageSize',
    pageExpression: 'currentPage',
  });
  assert.match(paginated.snippet, /v-model:page="currentPage"/);
  assert.match(paginated.snippet, /:items-per-page="pageSize"/);
});

test('extension verification distinguishes compiler and contract checks from browser coverage', () => {
  const code = [
    '<template>',
    '  <section class="eapp-page-constrained-wide">',
    '    <CommonResourceListFrame :loading="pending" :has-items="items.length > 0" :total="items.length" :items-per-page="0" empty-title="No items">',
    '      <CommonResourceListItem v-for="item in items" :key="item.id" :title="item.name" />',
    '    </CommonResourceListFrame>',
    '  </section>',
    '</template>',
  ].join('\n');
  const verification = buildExtensionRuntimeVerification({
    extension: { id: 7, name: 'Orders', type: 'page', isEnabled: true, menu: { id: 3, path: '/orders' } },
    code,
    validation: { valid: true, compiledLength: 1200 },
    uiPattern: 'resource_list',
  });

  assert.equal(verification.valid, true);
  assert.equal(verification.checks.serverCompile.status, 'passed');
  assert.equal(verification.checks.menuWiring.status, 'passed');
  assert.equal(verification.checks.browserRender.status, 'not_run');
  assert.equal(verification.coverage.browserRequiredForFullRuntimeProof, true);
});

test('verifyExtensionRuntime reads the saved extension and compiles that exact source', async () => {
  const originalFetch = globalThis.fetch;
  const apiUrl = 'http://mcp-extension-verifier.test/api';
  const calls = [];
  const code = '<template><section class="eapp-page-constrained-wide"><CommonResourceListFrame :loading="pending" :has-items="items.length > 0" :total="items.length" :items-per-page="0" empty-title="No items"><CommonResourceListItem v-for="item in items" :key="item.id" :title="item.name" /></CommonResourceListFrame></section></template>';
  initAuth(apiUrl, 'pat_test');
  resetTokens();
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'jwt_test', expiresIn: 3600 });
    }
    if (String(url).includes('/enfyra_extension?')) {
      return jsonResponse({ data: [{ id: 7, name: 'Orders', type: 'page', isEnabled: true, menu: { id: 3, path: '/orders' }, code }] });
    }
    if (String(url).endsWith('/enfyra_extension/preview')) {
      const body = JSON.parse(String(options.body));
      assert.equal(body.code, code);
      return jsonResponse({ success: true, extensionId: 'Orders', compiledCode: 'x'.repeat(900) });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    const verification = await verifyExtensionRuntime(apiUrl, { id: 7, uiPattern: 'resource_list' });
    assert.equal(verification.valid, true);
    assert.equal(verification.checks.serverCompile.compiledLength, 900);
    assert.equal(calls.filter((call) => call.url.endsWith('/enfyra_extension/preview')).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetTokens();
  }
});

test('extension patch diff is stored outside the response with bounded preview', () => {
  const artifact = buildExtensionPatchDiffArtifact({
    id: 9,
    name: 'Orders',
    currentSha256: 'before',
    nextSha256: 'after',
    patches: [{ search: 'Old heading', replace: 'New heading', searchMode: 'exact', replaceAll: false }],
  });
  assert.match(artifact.tmpFile, /enfyra-mcp-sources/);
  assert.match(artifact.tmpFile, /\.diff$/);
  assert.match(readFileSync(artifact.tmpFile, 'utf8'), /-Old heading/);
  assert.match(readFileSync(artifact.tmpFile, 'utf8'), /\+New heading/);
  assert.ok(artifact.preview.length <= 600);
});
