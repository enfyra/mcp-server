import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT_BACKED_TABLES } from '../dist/lib/tool-runtime-config.js';
import { WORKSPACE_TABLES, workspaceArtifactSchema } from '../dist/lib/workspace-state.js';
import { registerScriptTools } from '../dist/lib/script-tools.js';
import { runtimeCacheDomainForPath, runtimeCacheDomainsForReloadSteps } from '../dist/lib/runtime-cache.js';

const tableName = 'enfyra_bootstrap_script';

test('script and workspace operations reject custom startup script records', () => {
  assert.equal(SCRIPT_BACKED_TABLES.includes(tableName), false);
  assert.equal(WORKSPACE_TABLES.includes(tableName), false);
  assert.equal(workspaceArtifactSchema.safeParse({ tableName, id: '1' }).success, false);
  const schemas = new Map();
  registerScriptTools({ tool(name, _description, schema) { schemas.set(name, schema); } }, 'https://test.example/api');
  for (const name of ['get_script_source', 'patch_script_source', 'update_script_source']) {
    assert.equal(schemas.get(name).tableName.safeParse(tableName).success, false);
    assert.equal(schemas.get(name).tableName.safeParse('enfyra_route_handler').success, true);
  }
});

test('custom startup scripts have no runtime cache or reload domain', () => {
  assert.equal(runtimeCacheDomainForPath(`/${tableName}`), null);
  assert.deepEqual(runtimeCacheDomainsForReloadSteps(['bootstrap']), []);
  assert.deepEqual(runtimeCacheDomainsForReloadSteps(['flow']), ['flow']);
});
