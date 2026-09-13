import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptWorkspace } from '../dist/lib/script-workspace.js';

const ref = { tableName: 'enfyra_route_handler', id: '17' };
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'enfyra-workspace-test-')));
  execFileSync('git', ['init', '-q', root]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = new Map([['enfyra_route_handler:17', { source: 'return 1;', sourceField: 'sourceCode', language: 'javascript' }]]);
  const writes = [];
  const dependencies = {
    apiUrl: 'https://workspace.example/api',
    read: async (item) => remote.get(`${item.tableName}:${item.id}`) ?? null,
    validate: async (_item, source) => { if (source.includes('INVALID')) throw new Error('validation rejected'); },
    write: async (item, source, expectedHash) => { writes.push({ item, source, expectedHash }); remote.set(`${item.tableName}:${item.id}`, { source, sourceField: 'sourceCode', language: 'javascript' }); },
  };
  const workspace = createScriptWorkspace(dependencies);
  return { root, remote, writes, dependencies, workspace };
}

test('prepare ignores the entire workspace before writing and reopens across MCP sessions', async (t) => {
  const { root, workspace, dependencies } = await fixture(t);
  const prepared = await workspace.prepare({ projectRoot: root, artifacts: [ref] });
  assert.equal(prepared.gitIgnored, true);
  assert.equal(prepared.workspaceRoot, join(root, 'enfyra'));
  assert.ok(prepared.tempRoot.startsWith(join(root, '.tmp', 'enfyra')));
  const artifact = prepared.artifacts[0];
  assert.equal(await readFile(artifact.localFile, 'utf8'), 'return 1;');
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^\/enfyra\/$/m);
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^\/\.tmp\/enfyra\/$/m);
  execFileSync('git', ['-C', root, 'check-ignore', '-q', artifact.localFile]);
  await writeFile(artifact.localFile, 'return 2;');
  const reopened = await createScriptWorkspace(dependencies).prepare({ projectRoot: root });
  assert.equal(reopened.artifacts[0].status, 'local_changed');
  assert.equal(await readFile(artifact.localFile, 'utf8'), 'return 2;');
});

test('pull updates clean files but preserves conflicts, local edits and remote deletion', async (t) => {
  const { root, workspace, remote } = await fixture(t);
  const prepared = await workspace.prepare({ projectRoot: root, artifacts: [ref] });
  const file = prepared.artifacts[0].localFile;
  remote.get('enfyra_route_handler:17').source = 'return 3;';
  assert.equal((await workspace.inspect({})).artifacts[0].status, 'remote_changed');
  await workspace.pull({});
  assert.equal(await readFile(file, 'utf8'), 'return 3;');
  await writeFile(file, 'return 4;');
  remote.get('enfyra_route_handler:17').source = 'return 5;';
  const conflict = await workspace.pull({});
  assert.equal(conflict.artifacts[0].status, 'conflict');
  assert.equal(await readFile(file, 'utf8'), 'return 4;');
  remote.delete('enfyra_route_handler:17');
  assert.equal((await workspace.pull({})).artifacts[0].status, 'remote_missing');
  assert.equal(await readFile(file, 'utf8'), 'return 4;');
});

test('push previews, validates, rejects changed local/live inputs and verifies saved source', async (t) => {
  const { root, workspace, remote, writes } = await fixture(t);
  const prepared = await workspace.prepare({ projectRoot: root, artifacts: [ref] });
  const file = prepared.artifacts[0].localFile;
  await writeFile(file, 'return 2;');
  const plan = await workspace.push({});
  assert.ok(plan.planId);
  assert.equal(writes.length, 0);
  await writeFile(file, 'return 3;');
  await assert.rejects(workspace.push({ apply: true, planId: plan.planId }), /changed|stale/i);
  const next = await workspace.push({});
  remote.get('enfyra_route_handler:17').source = 'return 4;';
  await assert.rejects(workspace.push({ apply: true, planId: next.planId }), /changed|conflict|stale/i);
  remote.get('enfyra_route_handler:17').source = 'return 1;';
  const reviewed = await workspace.push({});
  const applied = await workspace.push({ apply: true, planId: reviewed.planId });
  assert.equal(applied.complete, true);
  assert.equal(writes.length, 1);
  assert.equal((await workspace.inspect({})).artifacts[0].status, 'synced');
  await assert.rejects(workspace.push({ apply: true, planId: reviewed.planId }), /consumed|plan/i);
});

test('validation failure prevents writes and saved-state mismatch is not success', async (t) => {
  const { root, workspace, dependencies, writes } = await fixture(t);
  const prepared = await workspace.prepare({ projectRoot: root, artifacts: [ref] });
  await writeFile(prepared.artifacts[0].localFile, 'INVALID');
  await assert.rejects(workspace.push({}), /validation rejected/);
  assert.equal(writes.length, 0);
  await writeFile(prepared.artifacts[0].localFile, 'return 9;');
  dependencies.write = async () => {};
  const plan = await workspace.push({});
  const result = await workspace.push({ apply: true, planId: plan.planId });
  assert.equal(result.complete, false);
  assert.equal(result.artifacts[0].status, 'failed');
});

test('workspace refuses target mismatches, symlinks, traversal and ambiguous roots', async (t) => {
  const { root, workspace, dependencies } = await fixture(t);
  await assert.rejects(workspace.prepare({ projectRoot: root, artifacts: [{ ...ref, path: '../outside.js' }] }), /path|outside|relative/i);
  const prepared = await workspace.prepare({ projectRoot: root, artifacts: [ref] });
  await assert.rejects(createScriptWorkspace({ ...dependencies, apiUrl: 'https://other.example/api' }).prepare({ projectRoot: root }), /target/i);
  const outside = join(root, 'outside.js');
  await writeFile(outside, 'do not touch');
  await rm(prepared.artifacts[0].localFile);
  await symlink(outside, prepared.artifacts[0].localFile);
  await assert.rejects(workspace.pull({}), /symlink/i);
  assert.equal(await readFile(outside, 'utf8'), 'do not touch');
  await assert.rejects(createScriptWorkspace({ ...dependencies, roots: async () => [root, tmpdir()] }).prepare({ artifacts: [ref] }), /projectRoot|multiple|ambiguous/i);
});

test('prepare supports an explicitly empty workspace and refuses tracked source paths', async (t) => {
  const { root, workspace } = await fixture(t);
  assert.deepEqual((await workspace.prepare({ projectRoot: root, artifacts: [] })).artifacts, []);
  await writeFile(join(root, 'enfyra', 'tracked.js'), 'existing source');
  execFileSync('git', ['-C', root, 'add', '-f', 'enfyra/tracked.js']);
  await assert.rejects(workspace.prepare({ projectRoot: root }), /tracked by Git/);
  assert.equal(await readFile(join(root, 'enfyra', 'tracked.js'), 'utf8'), 'existing source');
});

test('workspace lock prevents concurrent writers and releases after failure', async (t) => {
  const { root, workspace, dependencies } = await fixture(t);
  await workspace.prepare({ projectRoot: root, artifacts: [ref] });
  const read = dependencies.read;
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  dependencies.read = async (item) => { entered(); await new Promise((resolve) => { release = resolve; }); return read(item); };
  const pending = workspace.inspect({});
  await started;
  const other = createScriptWorkspace({ ...dependencies, read });
  await assert.rejects(other.prepare({ projectRoot: root }), /locked/);
  release();
  await pending;
  dependencies.read = read;
  assert.equal((await other.prepare({ projectRoot: root })).artifacts[0].status, 'synced');
});

test('partial push saves verified baselines and consumes the failed plan', async (t) => {
  const { root, workspace, dependencies, remote } = await fixture(t);
  const second = { tableName: ref.tableName, id: '18' };
  remote.set('enfyra_route_handler:18', { source: 'return 18;', sourceField: 'sourceCode', language: 'javascript' });
  const prepared = await workspace.prepare({ projectRoot: root, artifacts: [ref, second] });
  for (const item of prepared.artifacts) await writeFile(item.localFile, 'return 20;');
  const write = dependencies.write;
  dependencies.write = async (item, ...args) => { if (item.id === '18') throw new Error('second write failed'); return write(item, ...args); };
  const plan = await workspace.push({});
  const result = await workspace.push({ apply: true, planId: plan.planId });
  assert.equal(result.complete, false);
  assert.deepEqual(result.artifacts.map((item) => item.status), ['pushed', 'failed']);
  assert.deepEqual((await workspace.inspect({})).artifacts.map((item) => item.status), ['synced', 'local_changed']);
  await assert.rejects(workspace.push({ apply: true, planId: plan.planId }), /consumed/);
});
