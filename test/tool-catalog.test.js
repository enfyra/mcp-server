import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreToolSearch } from '../dist/lib/tool-catalog.js';

test('tool catalog ranks multi-word intent by matching terms instead of one literal phrase', () => {
  const countTool = {
    name: 'count_records',
    description: 'Count records in a route-backed Enfyra table using the lightweight REST meta pattern.',
  };
  const deleteTool = {
    name: 'delete_tables',
    description: 'Delete one or more table definitions.',
  };

  assert.ok(scoreToolSearch(countTool, 'count table records read only record count') > 0);
  assert.ok(
    scoreToolSearch(countTool, 'count table records read only record count')
      > scoreToolSearch(deleteTool, 'count table records read only record count'),
  );
  assert.ok(scoreToolSearch(deleteTool, 'delete_tables') > 0);
  assert.equal(scoreToolSearch(deleteTool, 'oauth provider setup'), 0);
});
