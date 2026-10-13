import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT_BACKED_TABLES } from '../dist/lib/tool-runtime-config.js';
import { WORKSPACE_TABLES, workspaceArtifactSchema } from '../dist/lib/workspace-state.js';
import { registerScriptTools } from '../dist/lib/script-tools.js';
import { validateScriptSourceIfPresent, rejectUnsafeScriptPayload } from '../dist/lib/mutation-guards.js';
import { ZONE_TABLES } from '../dist/lib/runtime-zone-registry.js';
import { runtimeCacheDomainForPath, runtimeCacheDomainsForReloadSteps } from '../dist/lib/runtime-cache.js';
import { buildDynamicScriptContextTypeContract } from '../dist/lib/dynamic-script-context-contract.js';
import { buildRequiredKnowledgePayload } from '../dist/lib/required-knowledge.js';

const tableName = 'enfyra_helper';
test('named helpers support inspected hash-guarded script source and project workspaces', () => {
  assert.ok(SCRIPT_BACKED_TABLES.includes(tableName));
  assert.ok(WORKSPACE_TABLES.includes(tableName));
  assert.equal(workspaceArtifactSchema.safeParse({ tableName, id: '1' }).success, true);
  const schemas = new Map();
  registerScriptTools({ tool(name, _description, schema) { schemas.set(name, schema); } }, 'https://test.example/api');
  for (const name of ['get_script_source', 'patch_script_source', 'update_script_source']) {
    assert.equal(schemas.get(name).tableName.safeParse(tableName).success, true);
    assert.equal(schemas.get(name).tableName.safeParse('enfyra_bootstrap_script').success, false);
  }
});
test('helper source is validated before save and client compiled/code aliases are rejected', async () => {
  const calls = [];
  const result = await validateScriptSourceIfPresent(async (...args) => { calls.push(args); return { valid: true }; }, 'https://test.example/api', tableName, { sourceCode: 'return @PARAMS;', scriptLanguage: 'typescript' });
  assert.equal(result.validated, true);
  assert.equal(calls[0][1], '/admin/script/validate');
  assert.equal(JSON.parse(calls[0][2].body).sourceCode, 'return @PARAMS;');
  assert.throws(() => rejectUnsafeScriptPayload(tableName, { code: 'return 1;' }), /sourceCode/);
  assert.throws(() => rejectUnsafeScriptPayload(tableName, { compiledCode: 'return 1;' }), /compiledCode/);
  await assert.rejects(validateScriptSourceIfPresent(async () => { throw new Error('unavailable'); }, 'https://test.example/api', tableName, { sourceCode: 'return 1;' }), /before save/);
});
test('helper discovery and cache invalidation share the helper runtime domain', () => {
  const helper = ZONE_TABLES.api_runtime.find(item => item.tableName === tableName);
  assert.ok(helper);
  assert.deepEqual(helper.sourceFields, ['sourceCode']);
  assert.ok(helper.labelFields.includes('name'));
  assert.equal(runtimeCacheDomainForPath('/enfyra_helper?limit=10'), 'helper');
  assert.deepEqual(runtimeCacheDomainsForReloadSteps(['helper']), ['helper']);
});
test('script context documents explicit helper params and inherited authority without a new sandbox claim', () => {
  const contract = buildDynamicScriptContextTypeContract();
  assert.match(JSON.stringify(contract.services['@HELPERS']), /run.*name.*params/);
  assert.match(JSON.stringify(contract.sharedHelpers), /@PARAMS/);
  assert.match(JSON.stringify(contract.sharedHelpers), /null.*user|user.*null/i);
  assert.match(JSON.stringify(contract.sharedHelpers), /transaction/i);
  assert.match(JSON.stringify(contract.sharedHelpers), /shared.*realm|realm.*shared/i);
  assert.match(JSON.stringify(buildRequiredKnowledgePayload('dynamic-code')), /enfyra_helper/);
});
