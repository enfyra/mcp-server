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

test('trusted list builder never lets callers override the exact field projection', () => {
  const result = buildDynamicRepositoryUsage({
    access: 'trusted_explicit',
    operation: 'list',
    tableName: 'audit_log',
    fields: ['id', 'eventType'],
  });

  assert.match(result.code, /fields: \["id", "eventType"\]/);
  assert.doesNotMatch(result.code, /@QUERY\.fields/);
});

test('secure list builder normalizes JSON-encoded REST field projections before repository access', () => {
  const result = buildDynamicRepositoryUsage({
    access: 'secure_explicit',
    operation: 'list',
    tableName: 'project',
    fields: ['id', 'name'],
  });

  assert.match(result.code, /const requestedFields = \(\(\) =>/);
  assert.match(result.code, /JSON\.parse\(rawFields\)/);
  assert.match(result.code, /fields: requestedFields\?\.length \? requestedFields : \["id", "name"\]/);
});

test('trusted list builder does not forward caller-controlled output expansion', () => {
  const result = buildDynamicRepositoryUsage({
    access: 'trusted_explicit',
    operation: 'list',
    tableName: 'audit_log',
    fields: ['id', 'eventType'],
  });

  assert.doesNotMatch(result.code, /@QUERY\.(deep|meta|aggregate|debugMode)/);
});

test('dynamic repository builder rejects invalid macro table names', () => {
  assert.throws(
    () => buildDynamicRepositoryUsage({ access: 'secure_explicit', operation: 'list', tableName: 'bad-name' }),
    /valid Enfyra identifier/,
  );
});

test('dynamic repository builder keeps TypeORM-style @BODY mutations and returns safe adaptation recipes', () => {
  const created = buildDynamicRepositoryUsage({
    access: 'secure_explicit',
    operation: 'create',
    tableName: 'orders',
    fields: ['id', 'owner'],
  });
  const updated = buildDynamicRepositoryUsage({
    access: 'secure_explicit',
    operation: 'update',
    tableName: 'orders',
    fields: ['id'],
  });

  assert.match(created.code, /data: @BODY/);
  assert.match(updated.code, /data: @BODY/);
  assert.equal(created.typeOrmPartialBody, true);
  assert.match(created.adaptationRecipes.serverOwnedField, /\.\.\.@BODY/);
  assert.match(created.adaptationRecipes.serverOwnedField, /@USER\.id/);
  assert.match(updated.adaptationRecipes.scopedMutation, /owner\/tenant/);
  assert.match(updated.adaptationRecipes.nonUpdatableServerAction, /Do not change canonical metadata isUpdatable/);
  assert.match(updated.adaptationRecipes.nonUpdatableServerAction, /trusted explicit repository/);
});
