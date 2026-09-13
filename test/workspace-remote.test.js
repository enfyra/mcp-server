import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createWorkspaceRemote } from '../dist/lib/workspace-remote.js';
import { initAuth } from '../dist/lib/auth.js';
import { jsonContent } from '../dist/lib/response-format.js';
import { afterMcpToolExecution, resetMcpSafetySession } from '../dist/lib/session-safety.js';
import { acknowledgeRequiredKnowledge, assertDynamicCodeKnowledgeAck, resetRequiredKnowledgeSession } from '../dist/lib/required-knowledge.js';

test('workspace remote reads project source fields without fetching OAuth credentials and handles native ids', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const apiUrl = 'https://workspace-unit.example/api';
  initAuth(apiUrl, 'unit-fixture');
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const primaryKey = url.pathname.includes('enfyra_extension') ? '_id' : 'id';
    const field = url.pathname.includes('enfyra_extension') ? 'code' : 'sourceCode';
    const body = url.pathname.includes('/metadata/')
      ? { data: { primaryKey, columns: [{ name: primaryKey }, { name: field }, { name: 'scriptLanguage' }, { name: 'clientSecret' }, { name: 'clientId' }] } }
      : { data: [{ [primaryKey]: '17', [field]: 'return 1;', scriptLanguage: 'typescript' }] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const remote = createWorkspaceRemote(apiUrl, { getTool: () => undefined });
  for (const tableName of ['enfyra_oauth_config', 'enfyra_extension']) {
    const result = await remote.read({ tableName, id: '17' });
    assert.equal(result.source, 'return 1;');
    assert.equal(result.language, 'typescript');
  }
  const reads = requests.filter((url) => !url.pathname.includes('/metadata/'));
  assert.equal(reads.length, 2);
  for (const url of reads) assert.doesNotMatch(url.searchParams.get('fields'), /\*|clientSecret|clientId/);
  assert.match(reads[1].searchParams.get('filter'), /_id/);
});

test('workspace source writer uses the canonical schema and target/knowledge gates', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; resetMcpSafetySession(); resetRequiredKnowledgeSession(); });
  resetMcpSafetySession();
  resetRequiredKnowledgeSession();
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'root', isRootAdmin: true }] }), { headers: { 'content-type': 'application/json' } });
  const calls = [];
  const remote = createWorkspaceRemote('https://workspace-unit.example/api', {
    getTool: (name) => ({ name, inputSchema: { tableName: z.string(), id: z.string(), sourceFile: z.string(), expectedSourceSha256: z.string(), scriptLanguage: z.string() }, handler: async (input) => { assertDynamicCodeKnowledgeAck(undefined); calls.push(input); return jsonContent({ action: 'updated_script_source' }); } }),
  });
  const artifact = { tableName: 'enfyra_route_handler', id: '17', language: 'typescript' };
  await assert.rejects(remote.write(artifact, 'return 2;', 'baseline-hash', '/fixture/staged.ts'), /Target is not confirmed/);
  afterMcpToolExecution('get_enfyra_api_context', {}, { content: [] });
  await assert.rejects(remote.write(artifact, 'return 2;', 'baseline-hash', '/fixture/staged.ts'), /knowledge|acknowledge/i);
  acknowledgeRequiredKnowledge('dynamic-code');
  await remote.write(artifact, 'return 2;', 'baseline-hash', '/fixture/staged.ts');
  assert.deepEqual(calls, [{ tableName: 'enfyra_route_handler', id: '17', sourceFile: '/fixture/staged.ts', expectedSourceSha256: 'baseline-hash', scriptLanguage: 'typescript' }]);
});
