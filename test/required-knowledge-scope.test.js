/**
 * Integration test: verify scope-based required-knowledge correctness
 */

import { buildRequiredKnowledgePayload, KNOWLEDGE_SCOPES } from '../dist/lib/required-knowledge.js';
import assert from 'node:assert';
import test from 'node:test';

const FULL_KEYS = ['version', 'scope', 'purpose', 'globalRulesAckKey', 'dynamicCodeAckKey', 'extensionAckKey', 'usage', 'globalRules', 'dynamicServerCode', 'extensions'];

test('full scope returns all three knowledge domains', () => {
  const payload = buildRequiredKnowledgePayload('full');
  assert.equal(payload.scope, 'full');
  assert.ok(Array.isArray(payload.globalRules));
  assert.ok(Array.isArray(payload.dynamicServerCode));
  assert.ok(Array.isArray(payload.extensions));
  assert.ok(payload.globalRules.length > 0);
  assert.ok(payload.dynamicServerCode.length > 0);
  assert.ok(payload.extensions.length > 0);
});

test('full scope without explicit param (backward compat)', () => {
  const payload = buildRequiredKnowledgePayload();
  assert.equal(payload.scope, 'full');
  assert.ok(Array.isArray(payload.dynamicServerCode));
  assert.ok(Array.isArray(payload.extensions));
});

test('schema scope only returns globalRules', () => {
  const payload = buildRequiredKnowledgePayload('schema');
  assert.equal(payload.scope, 'schema');
  assert.ok(Array.isArray(payload.globalRules));
  assert.equal(payload.dynamicServerCode, undefined);
  assert.equal(payload.extensions, undefined);
  assert.ok(payload.globalRules.length > 0);
});

test('dynamic-code scope returns globalRules + dynamicServerCode, no extensions', () => {
  const payload = buildRequiredKnowledgePayload('dynamic-code');
  assert.equal(payload.scope, 'dynamic-code');
  assert.ok(Array.isArray(payload.globalRules));
  assert.ok(Array.isArray(payload.dynamicServerCode));
  assert.equal(payload.extensions, undefined);
  assert.ok(payload.globalRules.length > 0);
  assert.ok(payload.dynamicServerCode.length > 0);
});

test('extension scope returns globalRules + extensions, no dynamic code', () => {
  const payload = buildRequiredKnowledgePayload('extension');
  assert.equal(payload.scope, 'extension');
  assert.ok(Array.isArray(payload.globalRules));
  assert.equal(payload.dynamicServerCode, undefined);
  assert.ok(Array.isArray(payload.extensions));
  assert.ok(payload.globalRules.length > 0);
  assert.ok(payload.extensions.length > 0);
});

test('flow scope returns globalRules + dynamicServerCode, no extensions', () => {
  const payload = buildRequiredKnowledgePayload('flow');
  assert.equal(payload.scope, 'flow');
  assert.ok(Array.isArray(payload.globalRules));
  assert.ok(Array.isArray(payload.dynamicServerCode));
  assert.equal(payload.extensions, undefined);
});

test('scope values are validated and default to full for unknown scopes', () => {
  assert.equal(buildRequiredKnowledgePayload('unknown').scope, 'full');
  assert.equal(buildRequiredKnowledgePayload('').scope, 'full');
  assert.equal(buildRequiredKnowledgePayload('SCHEMA').scope, 'schema');
  assert.equal(buildRequiredKnowledgePayload('  dynamic-code  ').scope, 'dynamic-code');
});

test('all scope values in KNOWLEDGE_SCOPES are valid', () => {
  for (const scope of KNOWLEDGE_SCOPES) {
    const payload = buildRequiredKnowledgePayload(scope);
    assert.equal(payload.scope, scope);
  }
});

test('ack keys are always present regardless of scope', () => {
  for (const scope of KNOWLEDGE_SCOPES) {
    const payload = buildRequiredKnowledgePayload(scope);
    assert.ok(typeof payload.globalRulesAckKey === 'string' && payload.globalRulesAckKey.length > 0, `globalRulesAckKey missing in ${scope}`);
    assert.ok(typeof payload.dynamicCodeAckKey === 'string' && payload.dynamicCodeAckKey.length > 0, `dynamicCodeAckKey missing in ${scope}`);
    assert.ok(typeof payload.extensionAckKey === 'string' && payload.extensionAckKey.length > 0, `extensionAckKey missing in ${scope}`);
  }
});

test('usage instructions match included domains', () => {
  // schema: only global rules usage
  const schema = buildRequiredKnowledgePayload('schema');
  assert.ok(schema.usage.every(u => !u.includes('dynamicCodeAckKey') && !u.includes('extensionAckKey')));

  // dynamic-code: includes dynamic code usage
  const dynCode = buildRequiredKnowledgePayload('dynamic-code');
  assert.ok(dynCode.usage.some(u => u.includes('dynamicCodeAckKey')));
  assert.ok(dynCode.usage.every(u => !u.includes('extensionAckKey')));

  // extension: includes extension usage
  const ext = buildRequiredKnowledgePayload('extension');
  assert.ok(ext.usage.some(u => u.includes('extensionAckKey')));
  assert.ok(ext.usage.every(u => !u.includes('dynamicCodeAckKey')));

  // full: both
  const full = buildRequiredKnowledgePayload('full');
  assert.ok(full.usage.some(u => u.includes('dynamicCodeAckKey')));
  assert.ok(full.usage.some(u => u.includes('extensionAckKey')));
});

test('globalRules sections contain expected ids', () => {
  const payload = buildRequiredKnowledgePayload('schema');
  const ids = payload.globalRules.map(r => r.id);
  assert.ok(ids.includes('examples-are-reasoning-anchors'));
  assert.ok(ids.includes('discover-before-changing'));
  assert.ok(ids.includes('runtime-zone-locators'));
  assert.ok(ids.includes('mutations-are-intentional'));
  assert.ok(ids.includes('schema-constraints'));
  assert.ok(ids.includes('security-first'));
  assert.ok(ids.includes('shell-signals'));
});

test('dynamicServerCode sections contain expected ids', () => {
  const payload = buildRequiredKnowledgePayload('dynamic-code');
  const ids = payload.dynamicServerCode.map(r => r.id);
  assert.ok(ids.includes('secure-vs-trusted-repositories'));
  assert.ok(ids.includes('authorization-is-separate'));
  assert.ok(ids.includes('hidden-field-query-surfaces'));
  assert.ok(ids.includes('dynamic-script-shape'));
});

test('dynamic code knowledge requires awaiting helper bridge calls', () => {
  const payload = buildRequiredKnowledgePayload('dynamic-code');
  const section = payload.dynamicServerCode.find(rule => rule.id === 'dynamic-script-shape');
  assert.match(section.rules.join('\n'), /Every @HELPERS method call crosses the async executor bridge and must be awaited/);
});

test('extensions sections contain expected ids', () => {
  const payload = buildRequiredKnowledgePayload('extension');
  const ids = payload.extensions.map(r => r.id);
  assert.ok(ids.includes('theme-contract-first'));
  assert.ok(ids.includes('extension-shell-boundary'));
  assert.ok(ids.includes('extension-runtime-contract'));
});

test('empty scope treated as full', () => {
  const payload = buildRequiredKnowledgePayload('');
  assert.equal(payload.scope, 'full');
  assert.ok(Array.isArray(payload.dynamicServerCode));
  assert.ok(Array.isArray(payload.extensions));
});

test('no scope param treated as full', () => {
  const payload = buildRequiredKnowledgePayload(undefined);
  assert.equal(payload.scope, 'full');
  assert.ok(Array.isArray(payload.dynamicServerCode));
  assert.ok(Array.isArray(payload.extensions));
});
