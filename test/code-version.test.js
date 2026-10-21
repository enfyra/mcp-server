import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCodeVersions, nextCodeVersion, prepareCodeUpdate } from '../dist/lib/code-version.js';
import { fetchAPI } from '../dist/lib/fetch.js';
import { initAuth } from '../dist/lib/auth.js';

test('code versions increment patch and match numeric and suffix ordering', () => {
  assert.equal(nextCodeVersion('3.0.1'), '3.0.2');
  assert.equal(nextCodeVersion('v1.0.0-patch-2'), '1.0.1');
  assert.equal(compareCodeVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareCodeVersions('1.0.0-patch-2', '1.0.0'), 1);
});

test('shared preflight generates or validates versions and never reads OAuth secrets', async () => {
  const reads = [];
  const read = async path => { reads.push(path); return path === '/metadata' ? { dbType: 'postgres' } : { data: [{ version: '3.0.1' }] }; };
  assert.deepEqual(await prepareCodeUpdate('/enfyra_oauth_config/7', { isEnabled: true }, read), { isEnabled: true, version: '3.0.2' });
  const path = new URL(reads[1], 'https://version.test');
  assert.equal(path.pathname, '/enfyra_oauth_config');
  assert.equal(path.searchParams.get('fields'), 'version');
  assert.deepEqual(JSON.parse(path.searchParams.get('filter')), { id: { _eq: '7' } });
  assert.equal((await prepareCodeUpdate('/enfyra_helper/7', { version: '4.0.0' }, read)).version, '4.0.0');
  await assert.rejects(prepareCodeUpdate('/enfyra_helper/7', { version: '3.0.1' }, read), /greater/);
  await assert.rejects(prepareCodeUpdate('/enfyra_helper/7', { version: 'oops' }, read), /valid/);
  await assert.rejects(prepareCodeUpdate('/enfyra_helper/7', {}, async path => path === '/metadata' ? { dbType: 'postgres' } : { data: [] }), /current version/);
  assert.deepEqual(await prepareCodeUpdate('/tasks/7', { title: 'task' }, () => { throw new Error('not called'); }), { title: 'task' });
});

test('Mongo version reads filter by the metadata primary key and reject unknown metadata', async () => {
  const reads = [];
  const read = async path => { reads.push(path); return path === '/metadata' ? { dbType: 'mongodb' } : { data: [{ version: '1.0.0' }] }; };
  await prepareCodeUpdate('/enfyra_helper/507f1f77bcf86cd799439011', {}, read);
  assert.deepEqual(JSON.parse(new URL(reads[1], 'https://version.test').searchParams.get('filter')), { _id: { _eq: '507f1f77bcf86cd799439011' } });
  await assert.rejects(prepareCodeUpdate('/enfyra_helper/7', {}, async () => ({})), /primary key/);
});

test('fetchAPI versions canonical patches once and never retries a rejected version', async () => {
  initAuth('https://version.test/api', 'test-token');
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    const path = new URL(url);
    if (path.pathname.endsWith('/metadata')) return Response.json({ dbType: 'postgres' });
    if (init.method !== 'PATCH') {
      assert.equal(path.pathname, '/api/enfyra_extension');
      assert.deepEqual(JSON.parse(path.searchParams.get('filter')), { id: { _eq: '9' } });
    }
    return new Response(JSON.stringify({ data: [{ version: init.method === 'PATCH' ? '1.0.1' : '1.0.0' }] }), { status: 200 });
  };
  try {
    await fetchAPI('https://version.test/api', '/enfyra_extension/9', { method: 'PATCH', body: JSON.stringify({ isEnabled: false }) });
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
    assert.equal(JSON.parse(calls.find(call => call.method === 'PATCH').body).version, '1.0.1');
    assert.equal(calls.some(call => new URL(call.url).searchParams.get('fields') === 'version'), true);
    await assert.rejects(fetchAPI('https://version.test/api', '/enfyra_extension/9', { method: 'PATCH', body: JSON.stringify({ version: '1.0.0' }) }), /greater/);
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
  } finally { global.fetch = original; }
});
