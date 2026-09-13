import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { installToolsetFilter } from '../dist/lib/toolset-filter.js';
import { registerToolCatalogTools } from '../dist/lib/tool-catalog.js';
import { installToolAnnotations } from '../dist/lib/tool-contracts.js';
import { installToolOutputContracts } from '../dist/lib/tool-output-contracts.js';
import { installColumnarToolFormatter, jsonContent } from '../dist/lib/response-format.js';
import { resetMcpSafetySession } from '../dist/lib/session-safety.js';
import { acknowledgeRequiredKnowledge, assertGlobalRulesAck, resetRequiredKnowledgeSession } from '../dist/lib/required-knowledge.js';

async function fixture(t, options = {}) {
  resetMcpSafetySession();
  resetRequiredKnowledgeSession();
  const server = new McpServer({ name: 'gateway-test', version: '1.0.0' });
  installToolOutputContracts(server);
  installColumnarToolFormatter(server);
  const state = installToolsetFilter(server, 'guided', 'all');
  installToolAnnotations(server);
  const writes = [];
  server.tool('get_enfyra_api_context', 'Confirm target.', {}, async () => options.contextError
    ? { isError: true, content: [{ type: 'text', text: 'target unavailable' }] }
    : jsonContent({ targetInstance: { apiBase: 'http://localhost:3000/api', source: 'test' }, enfyraApiUrl: 'http://localhost:3000/api', graphqlHttpUrl: 'http://localhost:3000/api/graphql', graphqlSchemaUrl: 'http://localhost:3000/api/graphql-schema', auth: {} }));
  server.tool('get_enfyra_required_knowledge', 'Read schema rules.', { scope: z.literal('schema') }, async ({ scope }) => {
    acknowledgeRequiredKnowledge(scope);
    return jsonContent({ rules: ['schema contract'] });
  });
  server.tool('create_tables', 'Create table definitions.', { tables: z.array(z.string()).min(1) }, async (input) => {
    assertGlobalRulesAck();
    writes.push(input);
    return jsonContent({ action: 'tables_created' });
  });
  server.tool('delete_records', 'Delete records.', { id: z.string(), confirm: z.boolean().default(false) }, async (input) => {
    if (input.confirm) writes.push(input);
    return {
      ...jsonContent({ action: input.confirm ? 'records_deleted' : 'records_delete_preview', tableName: 'tickets', confirm: input.confirm, postcondition: { verificationMethod: input.confirm ? 'fixture' : 'not_run_preview', requestedIds: [input.id], remainingIds: input.confirm ? [] : [input.id], confirmedAbsent: input.confirm } }),
      _meta: input.confirm ? {} : { enfyraDestructivePreview: { version: 1, valid: true, toolName: 'delete_records', action: 'records_delete_preview', targetCount: 1 } },
    };
  });
  server.tool('get_current_user', 'Read current user.', {}, async () => options.readError
    ? { isError: true, content: [{ type: 'text', text: 'read failed' }] }
    : jsonContent({ id: 'user-test', note: 'untrusted fixture' }));
  server.tool('get_permission_profile', 'Inspect permissions.', {}, async () => jsonContent({ permissions: [] }));
  const unionSchema = { selector: z.union(Array.from({ length: 12 }, (_, index) => z.object({ descriptivePropertyName: z.string(), variant: z.literal(index) }))) };
  server.tool('inspect_table', 'Inspect table.', unionSchema, async () => jsonContent({ table: null }));
  server.tool('create_route', 'Low-level route write.', {}, async () => { throw new Error('must not run'); });
  registerToolCatalogTools(server, state, options);
  const client = new Client({ name: 'gateway-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); resetMcpSafetySession(); resetRequiredKnowledgeSession(); });
  const call = (args) => client.callTool({ name: 'enfyra', arguments: args });
  const execute = (name, args = {}) => call({ action: 'execute', name, arguments: args });
  return { client, call, execute, writes, unionSchema };
}

test('one gateway discovers exact schemas without expanding the manifest', async (t) => {
  const { client, call } = await fixture(t);
  const before = await client.listTools();
  assert.deepEqual(before.tools.map(({ name }) => name), ['enfyra']);
  assert.deepEqual(before.tools[0].annotations, { title: 'Enfyra', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  const overview = await call({ action: 'discover' });
  assert.ok((overview.structuredContent.capabilities.length ?? overview.structuredContent.capabilities.rowCount) > 0);
  const result = await call({ action: 'discover', query: 'create_tables', limit: 1 });
  const operation = result.structuredContent.tools[0];
  assert.equal(operation.name, 'create_tables');
  assert.deepEqual(operation.inputSchema.required, ['tables']);
  assert.deepEqual(operation.invocation, { tool: 'enfyra', arguments: { action: 'execute', name: 'create_tables' } });
  assert.deepEqual((await client.listTools()).tools, before.tools);
  assert.equal((await client.callTool({ name: 'get_current_user', arguments: {} })).isError, true);
  const hidden = await call({ action: 'discover', query: 'create_route' });
  const hiddenTools = hidden.structuredContent.tools;
  const names = Array.isArray(hiddenTools) ? hiddenTools.map(({ name }) => name) : hiddenTools.rows.map((row) => row[hiddenTools.columns.indexOf('name')]);
  assert.ok(!names.includes('create_route'));
});

test('gateway preserves target, knowledge, input validation and destructive preview gates', async (t) => {
  const { execute, writes } = await fixture(t);
  assert.equal((await execute('create_tables', { tables: ['tickets'] })).isError, true);
  assert.equal((await execute('get_enfyra_api_context')).isError, undefined);
  assert.equal((await execute('create_tables', { tables: ['tickets'] })).isError, true);
  await execute('get_enfyra_required_knowledge', { scope: 'schema' });
  assert.equal((await execute('create_tables', { tables: 'tickets' })).isError, true);
  assert.equal(writes.length, 0);
  assert.equal((await execute('create_tables', { tables: ['tickets'] })).structuredContent.result.action, 'tables_created');
  assert.equal((await execute('delete_records', { id: 'a', confirm: true })).isError, true);
  await execute('delete_records', { id: 'a', confirm: false });
  assert.equal((await execute('delete_records', { id: 'b', confirm: true })).isError, true);
  assert.equal((await execute('delete_records', { id: 'a', confirm: true })).isError, undefined);
  assert.equal((await execute('delete_records', { id: 'a', confirm: true })).isError, true);
  assert.equal(writes.length, 2);
});

test('gateway blocks denied operations, unknown names and gateway recursion', async (t) => {
  const { execute, writes } = await fixture(t, { resolveAvailability: async (names) => Object.fromEntries(names.map((name) => [name, { status: 'denied', reason: 'fixture denied' }])) });
  for (const name of ['create_route', 'not_a_tool', 'enfyra', 'execute_enfyra_tool', 'search_enfyra_tools', 'select_enfyra_workflow', 'get_current_user']) {
    assert.equal((await execute(name)).isError, true, name);
  }
  assert.equal(writes.length, 0);
});

test('gateway preserves inner errors and does not confirm a failed target check', async (t) => {
  const { execute, writes } = await fixture(t, { contextError: true, readError: true });
  assert.equal((await execute('get_current_user')).isError, true);
  assert.equal((await execute('get_enfyra_api_context')).isError, true);
  assert.equal((await execute('create_tables', { tables: ['tickets'] })).isError, true);
  assert.equal(writes.length, 0);
});

test('gateway keeps remote results untrusted and validates action-specific arguments', async (t) => {
  const { call, execute } = await fixture(t);
  const result = await execute('get_current_user');
  assert.equal(result.structuredContent.result.dataBoundary.trust, 'untrusted');
  for (const args of [{ action: 'execute' }, { action: 'discover', name: 'create_tables' }, { action: 'execute', name: 'get_current_user', query: 'user' }]) {
    assert.equal((await call(args)).isError, true);
  }
});

test('discovered JSON schemas remain canonical through nested arrays and unions', async (t) => {
  const { call, unionSchema } = await fixture(t);
  const result = await call({ action: 'discover', query: 'inspect_table', limit: 1 });
  assert.deepEqual(result.structuredContent.tools[0].inputSchema, zodToJsonSchema(z.object(unionSchema), { target: 'jsonSchema7', $refStrategy: 'none' }));
});
