import test from 'node:test';
import assert from 'node:assert/strict';

import { rejectUnsafeScriptPayload, validateConditionStepSource } from '../dist/lib/mutation-guards.js';

test('a flow step payload cannot carry a config object', () => {
  assert.throws(
    () => rejectUnsafeScriptPayload('enfyra_flow_step', { type: 'script', config: { code: 'return 1;' } }),
    /no config column/u,
  );
  assert.doesNotThrow(() => rejectUnsafeScriptPayload('enfyra_flow_step', { type: 'script', sourceCode: 'return 1;' }));
});

test('a condition source must exist and return a boolean', () => {
  assert.throws(() => validateConditionStepSource(''), /require sourceCode that returns true or false/u);
  assert.throws(() => validateConditionStepSource('   '), /require sourceCode that returns true or false/u);
  assert.throws(() => validateConditionStepSource(undefined), /require sourceCode that returns true or false/u);
  assert.throws(() => validateConditionStepSource('const ok = true;'), /must return a boolean/u);
});

test('a bare return is rejected', () => {
  assert.throws(() => validateConditionStepSource('if (!@FLOW_PAYLOAD) return; return true;'), /not a bare `return`/u);
});

test('an obvious non-boolean return is rejected', () => {
  for (const source of [
    'return { ok: true };',
    'return [1, 2];',
    'return null;',
    'return undefined;',
    "return 'yes';",
    'return "yes";',
    'return `yes`;',
    'return 1;',
    'return -1;',
  ]) {
    assert.throws(
      () => validateConditionStepSource(source),
      /must return a boolean/u,
      `expected rejection for: ${source}`,
    );
  }
});

test('boolean expressions and Boolean() wrappers stay valid', () => {
  for (const source of [
    'return true;',
    'return false;',
    'return Boolean(@FLOW_PAYLOAD.enabled);',
    'return rows.data.length > 0;',
    'const rows = await #table.find({ limit: 1 }); return rows.data.length > 0;',
    'return @FLOW_LAST?.status === "paid";',
    'return 0 > 1;',
    'const parse = (value) => { return { total: Number(value) }; }; return parse(@FLOW_PAYLOAD.total).total > 0;',
  ]) {
    assert.doesNotThrow(() => validateConditionStepSource(source), `expected acceptance for: ${source}`);
  }
});
