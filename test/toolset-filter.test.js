import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installToolsetFilter,
  isToolVisibleInToolset,
  normalizeMcpToolset,
  summarizeToolsetForInstructions,
} from '../dist/lib/toolset-filter.js';

test('normalizes MCP toolset mode to guided by default', () => {
  assert.equal(normalizeMcpToolset(undefined), 'guided');
  assert.equal(normalizeMcpToolset(''), 'guided');
  assert.equal(normalizeMcpToolset('unknown'), 'guided');
  assert.equal(normalizeMcpToolset('FULL'), 'full');
});

test('guided toolset exposes front-door tools and hides escape hatches', () => {
  assert.equal(isToolVisibleInToolset('discover_enfyra_workflows', 'guided'), true);
  assert.equal(isToolVisibleInToolset('search_admin_extensions', 'guided'), true);
  assert.equal(isToolVisibleInToolset('search_runtime_zone', 'guided'), true);
  assert.equal(isToolVisibleInToolset('debug_field_exposure', 'guided'), true);
  assert.equal(isToolVisibleInToolset('api_endpoint_workflow', 'guided'), true);
  assert.equal(isToolVisibleInToolset('patch_extension_code', 'guided'), true);
  assert.equal(isToolVisibleInToolset('create_pre_hook', 'guided'), true);
  assert.equal(isToolVisibleInToolset('flow_workflow', 'guided'), true);
  assert.equal(isToolVisibleInToolset('plan_flow_steps', 'guided'), true);
  assert.equal(isToolVisibleInToolset('ensure_script_flow_step', 'guided'), false);
  assert.equal(isToolVisibleInToolset('ensure_manual_flow', 'guided'), false);
  assert.equal(isToolVisibleInToolset('create_route', 'guided'), false);
  assert.equal(isToolVisibleInToolset('create_handler', 'guided'), false);
  assert.equal(isToolVisibleInToolset('reload_all', 'guided'), false);
  assert.equal(isToolVisibleInToolset('get_log_content', 'guided'), false);
});

test('full toolset exposes all tools', () => {
  assert.equal(isToolVisibleInToolset('create_route', 'full'), true);
  assert.equal(isToolVisibleInToolset('any_future_tool', 'full'), true);
});

test('installToolsetFilter skips hidden registrations without blocking visible tools', () => {
  const registered = [];
  const server = {
    tool(name, description, schema, handler) {
      registered.push({ name, description, schema, handler });
      return { name };
    },
  };
  const state = installToolsetFilter(server, 'guided');
  assert.deepEqual(server.tool('discover_enfyra_workflows', '', {}, () => null), { name: 'discover_enfyra_workflows' });
  assert.equal(server.tool('create_route', '', {}, () => null), undefined);
  assert.deepEqual(registered.map((item) => item.name), ['discover_enfyra_workflows']);
  assert.deepEqual(state.hiddenTools, ['create_route']);
});

test('toolset instruction summary names guided/full behavior', () => {
  assert.match(summarizeToolsetForInstructions('guided'), /guided/);
  assert.match(summarizeToolsetForInstructions('guided'), /ENFYRA_MCP_TOOLSET=full/);
  assert.match(summarizeToolsetForInstructions('full'), /full/);
});
