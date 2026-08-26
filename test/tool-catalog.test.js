import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { registerToolCatalogTools, scoreToolSearch } from '../dist/lib/tool-catalog.js';
import { getToolContract } from '../dist/lib/tool-contracts.js';
import { afterMcpToolExecution, resetMcpSafetySession } from '../dist/lib/session-safety.js';

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

test('catalog gateway executes a hidden guided mutation through its exact schema and safety gate', async (t) => {
  t.after(resetMcpSafetySession);
  const handlers = new Map();
  const calls = [];
  const tool = {
    name: 'create_tables',
    description: 'Create Enfyra table definitions.',
    inputSchema: {
      tables: z.array(z.string()).min(1),
    },
    annotations: getToolContract('create_tables').annotations,
    handler: async (input) => {
      calls.push(input);
      return {
        content: [{ type: 'text', text: 'created' }],
        structuredContent: { action: 'tables_created' },
      };
    },
    visible: false,
  };
  const state = {
    toolset: 'guided',
    profile: 'all',
    dynamic: true,
    listTools: () => [tool],
    getTool: (name) => name === tool.name ? tool : undefined,
  };
  const server = {
    tool(name, _description, _schema, handler) {
      handlers.set(name, handler);
    },
  };
  registerToolCatalogTools(server, state);
  afterMcpToolExecution('get_enfyra_api_context', {}, { content: [] });

  const result = await handlers.get('execute_enfyra_tool')({
    name: 'create_tables',
    arguments: { tables: ['tasks'] },
  });

  assert.deepEqual(calls, [{ tables: ['tasks'] }]);
  assert.equal(result.structuredContent.action, 'enfyra_catalog_tool_executed');
  assert.equal(result.structuredContent.tool, 'create_tables');
});
