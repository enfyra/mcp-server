import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validatePortableScriptSource } from '../dist/lib/mutation-guards.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('package proxies reject literal then, catch, and finally member access', () => {
  assert.throws(
    () => validatePortableScriptSource('$ctx.$pkgs.foo.bar.then(handle)'),
    /Package proxies reserve \.then/u,
  );
  assert.throws(
    () => validatePortableScriptSource('@PKGS.foo.bar.then(handle)'),
    /Package proxies reserve \.then/u,
  );
  assert.throws(
    () => validatePortableScriptSource("$ctx.$pkgs['foo'].bar.catch(handle)"),
    /Package proxies reserve \.catch/u,
  );
  assert.throws(
    () => validatePortableScriptSource('$ctx.$pkgs.foo.finally(cleanup)'),
    /Package proxies reserve \.finally/u,
  );
});

test('a call result keeps its resolving then method', () => {
  assert.doesNotThrow(() =>
    validatePortableScriptSource('$ctx.$pkgs.undici.fetch(url).then(handle)'),
  );
  assert.doesNotThrow(() =>
    validatePortableScriptSource('$ctx.$pkgs.foo.bar().then(handle).catch(failed)'),
  );
});

test('package proxies accept awaiting and $property for reserved members', () => {
  assert.doesNotThrow(() =>
    validatePortableScriptSource('const res = await $ctx.$pkgs.undici.fetch(url);'),
  );
  assert.doesNotThrow(() =>
    validatePortableScriptSource('const value = await $ctx.$pkgs.foo.bar();'),
  );
  assert.doesNotThrow(() =>
    validatePortableScriptSource("const member = $ctx.$pkgs.foo.bar.$property('then');"),
  );
});

test('an unawaited package constructor cannot be property-read', () => {
  assert.throws(
    () => validatePortableScriptSource('const client = new $ctx.$pkgs.pg.Client(config); return client.database;'),
    /A package constructor returns a handle/u,
  );
  assert.throws(
    () => validatePortableScriptSource('let parser = new @PKGS.parser.XMLParser(options); return parser.options;'),
    /A package constructor returns a handle/u,
  );
});

test('an awaited constructor or a passed handle stays valid', () => {
  assert.doesNotThrow(() =>
    validatePortableScriptSource('const client = await new $ctx.$pkgs.pg.Client(config); return client.database;'),
  );
  assert.doesNotThrow(() =>
    validatePortableScriptSource('const client = new $ctx.$pkgs.pg.Client(config); await $ctx.$pkgs.pg.consume(client);'),
  );
});

test('the failure registry records every known failure class and its validator', () => {
  const registry = readFileSync(
    path.join(repoRoot, 'docs', 'dynamic-script-failure-registry.md'),
    'utf8',
  );
  assert.match(registry, /## Rules/u);
  assert.match(registry, /## Entries/u);
  assert.match(registry, /\| ID \| Symptom \| Root cause \| Layer \| Fix \| Regression \| Validator \|/u);
  for (const validator of [
    'validateLogsContract',
    'validateSocketContract',
    'validateTriggerContract',
    'validateAwaitedRepositoryCalls',
    'validatePackageContract',
    'validateConditionStepSource',
  ]) {
    assert.ok(registry.includes(validator), `registry must name ${validator}`);
  }
  assert.match(registry, /## Static coverage boundaries/u);
});
