import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDynamicRepositoryUsage } from '../dist/lib/dynamic-repository-builder.js';

test('dynamic repository builder defaults explicit user-facing access to secure repositories', () => {
  const result = buildDynamicRepositoryUsage({
    access: 'secure_explicit',
    operation: 'find_one',
    tableName: 'project',
    fields: ['id', 'name'],
    idField: 'id',
    idSource: 'params',
  });

  assert.match(result.code, /await #secure\.project\.find/);
  assert.match(result.code, /fields: \["id", "name"\]/);
  assert.match(result.code, /result\.data\?\.\[0\]/);
  assert.equal(result.fieldPermissionsEnforced, true);
});

test('dynamic repository builder labels trusted explicit access as a permission bypass', () => {
  const result = buildDynamicRepositoryUsage({
    access: 'trusted_explicit',
    operation: 'create',
    tableName: 'audit_log',
    fields: ['id'],
  });

  assert.match(result.code, /await #audit_log\.create/);
  assert.equal(result.fieldPermissionsEnforced, false);
  assert.match(result.securityBoundary, /bypasses field permissions/i);
});

test('dynamic repository builder rejects invalid macro table names', () => {
  assert.throws(
    () => buildDynamicRepositoryUsage({ access: 'secure_explicit', operation: 'list', tableName: 'bad-name' }),
    /valid Enfyra identifier/,
  );
});
