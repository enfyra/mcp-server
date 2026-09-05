import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLogQuery, registerLogTools } from '../dist/lib/log-tools.js';

test('trace uses a bounded DB query with exact correlation and separate tables', () => {
  const query = buildLogQuery({ since: '2026-09-05T00:00:00Z', correlationId: 'req_one', code: 'worker_crashed', limit: 10, page: 2 }, true);
  assert.deepEqual(JSON.parse(query.get('filter')), { occurredAt: { _gte: '2026-09-05T00:00:00Z' }, correlationId: { _eq: 'req_one' }, code: { _eq: 'worker_crashed' } });
  assert.equal(query.get('limit'), '10'); assert.equal(query.get('page'), '2');
  assert.ok(query.get('fields').includes('details'));
  assert.ok(!buildLogQuery({}, false).get('fields').includes('stack'));
});

test('only database tracing tools are registered and limits cannot be unbounded', () => {
  const registered = [];
  registerLogTools({ tool: (name, description, schema) => registered.push({ name, schema }) }, 'https://example.invalid');
  assert.deepEqual(registered.map(t => t.name), ['search_system_errors', 'search_user_logs']);
  for (const { schema } of registered) {
    assert.equal(schema.limit.safeParse(101).success, false);
    assert.equal(schema.limit.safeParse(0).success, false);
    assert.equal(schema.page.safeParse(-1).success, false);
  }
});
