import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDynamicRepositoryUsage } from '../dist/lib/dynamic-repository-builder.js';

test('locked reads run inside an outer transaction without mutation scaffolding', async () => {
  const result = buildDynamicRepositoryUsage({access:'secure_explicit',operation:'find_locked',tableName:'accounts',fields:['id','credit']});
  assert.match(result.code, /@TRANSACTION\.run/);
  assert.match(result.code, /#secure\.accounts\.findLocked\(/);
  assert.doesNotMatch(result.code, /\.update(?:Locked)?\(|@CACHE|@QUERY/);
  assert.equal(result.typeOrmPartialBody,false);
  assert.deepEqual(result.runtimeRequirements.databases,['postgres','mysql']);
  assert.equal(result.runtimeRequirements.requiresOuterTransaction,true);
  assert.match(result.runtimeRequirements.verification,/deployed/i);
  let active=false;
  const code=result.code.replaceAll('@TRANSACTION','$ctx.$transaction').replaceAll('#secure.accounts','$ctx.$repos.secure.accounts').replaceAll('@PARAMS','$ctx.$params').replaceAll('@THROW404','$ctx.$throw404');
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const row=await new AsyncFunction('$ctx',code)({$params:{id:7},$transaction:{run:async work=>{active=true;try{return await work();}finally{active=false;}}},$repos:{secure:{accounts:{findLocked:async options=>{assert.equal(active,true);assert.deepEqual(options,{id:7,fields:['id','credit']});return {data:[{id:7,credit:100}]};}}}},$throw404:message=>{throw new Error(message);}});
  assert.deepEqual(row,{id:7,credit:100});
  assert.equal(active,false);
});

test('locked read builder preserves main/trusted access and rejects Mongo primary-key syntax', () => {
  const main=buildDynamicRepositoryUsage({access:'secure_main',operation:'find_locked'});
  const trusted=buildDynamicRepositoryUsage({access:'trusted_explicit',operation:'find_locked',tableName:'accounts',idSource:'body'});
  assert.match(main.code, /@REPOS\.main\.findLocked/);
  assert.match(trusted.code, /#accounts\.findLocked/);
  assert.match(trusted.code, /id: @BODY\.id/);
  assert.equal(trusted.fieldPermissionsEnforced,false);
  assert.throws(()=>buildDynamicRepositoryUsage({access:'secure_explicit',operation:'find_locked',tableName:'accounts',idField:'_id'}),/PostgreSQL\/MySQL/);
});

test('unsupported operations never generate delete code', () => {
  assert.throws(()=>buildDynamicRepositoryUsage({access:'secure_explicit',operation:'unknown',tableName:'accounts'}),/Unsupported repository operation/);
});

test('builds protected credit updates with computation inside the callback', () => {
  const result = buildDynamicRepositoryUsage({ access: 'secure_explicit', operation: 'update_locked', tableName: 'accounts', counterField: 'credit', fields: ['id', 'credit'] });
  assert.match(result.code, /#secure\.accounts\.updateLocked\(/);
  assert.match(result.code, /data: \(current\) =>/);
  assert.match(result.code, /return \{ credit: current\.credit - amount \}/);
  assert.match(result.code, /fields: \["id", "credit"\]/);
  assert.doesNotMatch(result.code, /\}, \(current\) =>/);
  assert.match(result.code, /current\.credit < amount/);
  assert.match(result.adaptationRecipes.lockedUpdate, /native transactions/);
  assert.throws(() => buildDynamicRepositoryUsage({ access: 'secure_explicit', operation: 'update_locked', tableName: 'accounts' }), /counterField/);
});

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
  assert.match(result.code, /@THROW404\("Record not found"\)/);
  assert.doesNotMatch(result.code, /@THROW404\([^\n]*,\s*\{/);
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

test('dynamic repository builder generates explicit batch mutation contracts', () => {
  const created = buildDynamicRepositoryUsage({
    access: 'secure_explicit',
    operation: 'create_many',
    tableName: 'orders',
    fields: ['id', 'status'],
  });
  const updated = buildDynamicRepositoryUsage({
    access: 'secure_explicit',
    operation: 'update_many',
    tableName: 'orders',
    fields: ['id', 'status'],
  });
  const deleted = buildDynamicRepositoryUsage({
    access: 'secure_explicit',
    operation: 'delete_many',
    tableName: 'orders',
  });

  assert.match(created.code, /@BODY\.records/);
  assert.match(created.code, /createMany/);
  assert.match(updated.code, /@BODY\.ids/);
  assert.match(updated.code, /@BODY\.data/);
  assert.match(updated.code, /updateMany/);
  assert.match(deleted.code, /deleteMany/);
  assert.match(deleted.code, /count: result\.count/);
});
