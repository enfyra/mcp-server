import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCodeHistoryTools } from '../dist/lib/code-history-tools.js';
import { getToolContract } from '../dist/lib/tool-contracts.js';
import { initAuth } from '../dist/lib/auth.js';
import { acknowledgeRequiredKnowledge } from '../dist/lib/required-knowledge.js';

function tools() {
  const registered = new Map();
  registerCodeHistoryTools({ tool(name, _description, _schema, handler) { registered.set(name, handler); } }, 'https://history.test/api');
  return registered;
}

test('history queries are exact, bounded, and omit pre-images', async () => {
  initAuth('', 'test-token');
  const original = global.fetch;
  let path;
  global.fetch = async url => { path = new URL(url); return Response.json({ data: [], meta: { filterCount: 0 } }); };
  try {
    await tools().get('get_code_history')({ tableName: 'enfyra_helper', recordId: '7', page: 2, limit: 20 });
    assert.deepEqual(JSON.parse(path.searchParams.get('filter')), { tableName: { _eq: 'enfyra_helper' }, recordId: { _eq: '7' } });
    assert.equal(path.searchParams.get('page'), '2');
    assert.equal(path.searchParams.get('fields').includes('previous'), false);
    assert.equal(getToolContract('restore_code_revision').annotations.readOnlyHint, false);
    assert.equal(getToolContract('restore_code_revision').catalogExecutable, true);
  } finally { global.fetch = original; }
});

test('restore generates a new version, forwards API denial, and never recreates delete history', async () => {
  initAuth('', 'test-token');
  acknowledgeRequiredKnowledge('global');
  const original = global.fetch;
  let deleted = false;
  let denied = false;
  const writes = [];
  global.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/metadata')) return Response.json({ dbType: 'postgres' });
    if (path.includes('enfyra_audit')) return Response.json({ data: [{ tableName: 'enfyra_helper', recordId: '7', action: deleted ? 'delete' : 'update' }] });
    if (options.method === 'POST') {
      writes.push(JSON.parse(options.body));
      return denied ? new Response('Forbidden', { status: 403 }) : Response.json({ success: true });
    }
    return Response.json({ data: [{ version: writes.length && !denied ? '3.0.2' : '3.0.1' }] });
  };
  try {
    const restore = tools().get('restore_code_revision');
    const result = await restore({ auditId: '2' });
    assert.equal(JSON.parse(result.content[0].text).version, '3.0.2');
    assert.deepEqual(writes[0], { auditId: '2', version: '3.0.2' });
    deleted = true;
    await assert.rejects(restore({ auditId: '3' }), /cannot be restored/);
    assert.equal(writes.length, 1);
    deleted = false;
    denied = true;
    await assert.rejects(restore({ auditId: '2' }), /403/);
    assert.equal(writes.length, 2);
  } finally { global.fetch = original; }
});
