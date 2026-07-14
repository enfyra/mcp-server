import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  installToolsetFilter,
  isToolVisibleInToolset,
  normalizeMcpToolset,
  summarizeToolsetForInstructions,
} from '../dist/lib/toolset-filter.js';
import { WORKFLOW_SURFACES, discoverWorkflowRoutes } from '../dist/lib/tool-routing.js';

const TOOL_REGISTRATION_SOURCES = [
  '../src/mcp-server-entry.ts',
  '../src/lib/dynamic-repository-builder.ts',
  '../src/lib/platform-operation-tools.ts',
  '../src/lib/runtime-zone-tools.ts',
  '../src/lib/table-tools.ts',
];

function registeredToolNames() {
  const tools = new Set();
  for (const sourcePath of TOOL_REGISTRATION_SOURCES) {
    const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
    for (const match of source.matchAll(/server\.tool\(\s*['"]([a-z0-9_]+)['"]/g)) tools.add(match[1]);
  }
  return tools;
}

function splitWorkflowToolNames(value) {
  if (value === 'full toolset reload tools') return [];
  return value
    .split(/\s+or\s+|\s*\/\s*/g)
    .map((tool) => tool.trim().replace(/\(.*/, ''))
    .filter(Boolean);
}

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
  assert.equal(isToolVisibleInToolset('build_extension_ui', 'guided'), true);
  assert.equal(isToolVisibleInToolset('build_extension_api_usage', 'guided'), true);
  assert.equal(isToolVisibleInToolset('build_extension_drawer', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_modal', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_page_shell', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_permission_gate', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_empty_state', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_resource_list', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_form_editor', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_widget', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_menu_notification', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_account_panel_item', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_tabs', 'guided'), false);
  assert.equal(isToolVisibleInToolset('build_extension_upload_modal', 'guided'), false);
  assert.equal(isToolVisibleInToolset('review_extension_ui_contract', 'guided'), false);
  assert.equal(isToolVisibleInToolset('create_pre_hook', 'guided'), true);
  assert.equal(isToolVisibleInToolset('ensure_route_rate_limit', 'guided'), true);
  assert.equal(isToolVisibleInToolset('flow_workflow', 'guided'), true);
  assert.equal(isToolVisibleInToolset('plan_flow_steps', 'guided'), true);
  assert.equal(isToolVisibleInToolset('test_graphql', 'guided'), true);
  assert.equal(isToolVisibleInToolset('build_dynamic_repository_usage', 'guided'), true);
  assert.equal(isToolVisibleInToolset('create_handler', 'guided'), true);
  assert.equal(isToolVisibleInToolset('create_post_hook', 'guided'), true);
  assert.equal(isToolVisibleInToolset('list_methods', 'guided'), true);
  assert.equal(isToolVisibleInToolset('ensure_script_flow_step', 'guided'), false);
  assert.equal(isToolVisibleInToolset('ensure_manual_flow', 'guided'), false);
  assert.equal(isToolVisibleInToolset('create_route', 'guided'), false);
  assert.equal(isToolVisibleInToolset('reload_all', 'guided'), false);
  assert.equal(isToolVisibleInToolset('get_log_content', 'guided'), false);
});

test('full toolset exposes all tools', () => {
  assert.equal(isToolVisibleInToolset('create_route', 'full'), true);
  assert.equal(isToolVisibleInToolset('build_extension_drawer', 'full'), true);
  assert.equal(isToolVisibleInToolset('review_extension_ui_contract', 'full'), true);
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

test('guided workflow primary paths never direct callers to hidden tools', () => {
  for (const surface of WORKFLOW_SURFACES) {
    const result = discoverWorkflowRoutes({ surface, detail: 'plan', limit: 1 });
    const primaryPath = result.workflows[0].primaryPath;
    for (const step of primaryPath) {
      if (step.tool === 'full toolset reload tools') continue;
      const toolNames = step.tool.split(/\s+or\s+|\s*\/\s*/g).map((tool) => tool.trim());
      for (const toolName of toolNames) {
        assert.equal(
          isToolVisibleInToolset(toolName, 'guided'),
          true,
          `${surface} primary path directs guided callers to hidden tool ${toolName}`,
        );
      }
    }
  }
});

test('workflow routes only name registered MCP tools', () => {
  const registered = registeredToolNames();
  for (const surface of WORKFLOW_SURFACES) {
    const workflow = discoverWorkflowRoutes({ surface, detail: 'plan', limit: 1 }).workflows[0];
    const namedTools = [
      ...workflow.primaryPath.flatMap((step) => splitWorkflowToolNames(step.tool)),
      ...workflow.advancedTools.flatMap(splitWorkflowToolNames),
      ...workflow.verifyPath.flatMap((step) => splitWorkflowToolNames(step.tool)),
      ...Object.values(workflow.legacyToolSets).flat().flatMap(splitWorkflowToolNames),
    ];
    for (const toolName of namedTools) {
      assert.ok(registered.has(toolName), `${surface} references unregistered tool ${toolName}`);
    }
  }
});
