import test from 'node:test';
import assert from 'node:assert/strict';
import { registeredToolNamesFromSource } from '../test-support/source-tree.js';
import {
  installToolsetFilter,
  isToolVisibleInToolset,
  normalizeDynamicToolPacks,
  normalizeMcpProfile,
  normalizeMcpToolset,
  summarizeToolsetForInstructions,
} from '../dist/lib/toolset-filter.js';
import { WORKFLOW_SURFACES, WORKFLOW_SURFACES_BY_PROFILE, discoverWorkflowRoutes, workflowToolNames } from '../dist/lib/tool-routing.js';

function registeredToolNames() {
  return registeredToolNamesFromSource();
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

test('normalizes MCP domain profile to all by default', () => {
  assert.equal(normalizeMcpProfile(undefined), 'all');
  assert.equal(normalizeMcpProfile(''), 'all');
  assert.equal(normalizeMcpProfile('unknown'), 'all');
  assert.equal(normalizeMcpProfile('EXTENSION'), 'extension');
  assert.equal(normalizeMcpProfile('schema'), 'schema');
  assert.equal(normalizeMcpProfile('runtime'), 'runtime');
  assert.equal(normalizeMcpProfile('operations'), 'operations');
});

test('dynamic tool packs default on only for guided/all and keep profile fallback', () => {
  assert.equal(normalizeDynamicToolPacks(undefined, 'guided', 'all'), true);
  assert.equal(normalizeDynamicToolPacks('off', 'guided', 'all'), false);
  assert.equal(normalizeDynamicToolPacks('on', 'guided', 'all'), true);
  assert.equal(normalizeDynamicToolPacks(undefined, 'guided', 'extension'), false);
  assert.equal(normalizeDynamicToolPacks('on', 'guided', 'extension'), false);
  assert.equal(normalizeDynamicToolPacks('on', 'full', 'all'), false);
});

test('guided domain profiles expose a bounded task surface', () => {
  const registered = registeredToolNames();
  for (const profile of ['extension', 'schema', 'runtime', 'operations']) {
    const visible = [...registered].filter((name) => isToolVisibleInToolset(name, 'guided', profile));
    assert.ok(visible.length >= 20, `${profile} exposes too few tools: ${visible.length}`);
    assert.ok(visible.length <= 45, `${profile} exposes too many tools: ${visible.length}`);
    assert.ok(visible.includes('get_enfyra_api_context'));
    assert.ok(visible.includes('get_enfyra_required_knowledge'));
    assert.ok(visible.includes('discover_enfyra_workflows'));
  }
});

test('extension and schema profiles isolate normal domain tools', () => {
  assert.equal(isToolVisibleInToolset('extension_workflow', 'guided', 'extension'), true);
  assert.equal(isToolVisibleInToolset('patch_extension_code', 'guided', 'extension'), true);
  assert.equal(isToolVisibleInToolset('create_tables', 'guided', 'extension'), false);
  assert.equal(isToolVisibleInToolset('create_handler', 'guided', 'extension'), false);

  assert.equal(isToolVisibleInToolset('create_tables', 'guided', 'schema'), true);
  assert.equal(isToolVisibleInToolset('query_table', 'guided', 'schema'), true);
  assert.equal(isToolVisibleInToolset('extension_workflow', 'guided', 'schema'), false);
  assert.equal(isToolVisibleInToolset('search_logs', 'guided', 'schema'), false);
});

test('guided toolset exposes front-door tools and hides escape hatches', () => {
  assert.equal(isToolVisibleInToolset('discover_enfyra_workflows', 'guided'), true);
  assert.equal(isToolVisibleInToolset('search_admin_extensions', 'guided'), true);
  assert.equal(isToolVisibleInToolset('search_runtime_zone', 'guided'), true);
  assert.equal(isToolVisibleInToolset('debug_field_exposure', 'guided'), true);
  assert.equal(isToolVisibleInToolset('api_endpoint_workflow', 'guided'), true);
  assert.equal(isToolVisibleInToolset('patch_extension_code', 'guided'), true);
  assert.equal(isToolVisibleInToolset('verify_extension_runtime', 'guided'), true);
  assert.equal(isToolVisibleInToolset('build_extension_ui', 'guided'), true);
  assert.equal(isToolVisibleInToolset('build_extension_api_usage', 'guided'), false);
  assert.equal(isToolVisibleInToolset('validate_extension_code', 'guided'), false);
  assert.equal(isToolVisibleInToolset('get_theme_class_reference', 'guided'), false);
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
  assert.equal(isToolVisibleInToolset('any_future_tool', 'full', 'extension'), true);
});

test('installToolsetFilter registers disabled tools and activates one bounded pack', () => {
  const registered = [];
  const server = {
    tool(name, description, schema, handler) {
      const registration = { name, enabled: true };
      registered.push({ name, description, schema, handler, registration });
      return registration;
    },
    sendToolListChanged() {},
  };
  const state = installToolsetFilter(server, 'guided', 'all', { dynamic: true });
  assert.equal(server.tool('discover_enfyra_workflows', '', {}, () => null).enabled, true);
  assert.equal(server.tool('create_route', '', {}, () => null).enabled, false);
  assert.deepEqual(registered.map((item) => item.name), ['discover_enfyra_workflows', 'create_route']);
  assert.deepEqual(state.hiddenTools, ['create_route']);
  assert.equal(state.profile, 'all');
  assert.equal(state.getTool('create_route').visible, false);
  assert.equal(state.getTool('discover_enfyra_workflows').visible, true);
  const activated = state.setActiveTools(['create_route']);
  assert.equal(activated.visibleToolNames.includes('create_route'), false);
  assert.equal(activated.visibleToolNames.includes('discover_enfyra_workflows'), true);
});

test('guided profiles expose the hybrid catalog front doors', () => {
  for (const profile of ['all', 'extension', 'schema', 'runtime', 'operations']) {
    assert.equal(isToolVisibleInToolset('search_enfyra_tools', 'guided', profile), true);
    assert.equal(isToolVisibleInToolset('execute_enfyra_tool', 'guided', profile), true);
  }
});

test('toolset instruction summary names guided/full behavior', () => {
  assert.match(summarizeToolsetForInstructions('guided', 'all'), /guided/);
  assert.match(summarizeToolsetForInstructions('guided', 'all'), /ENFYRA_MCP_TOOLSET=full/);
  assert.match(summarizeToolsetForInstructions('guided', 'extension'), /extension/);
  assert.match(summarizeToolsetForInstructions('guided', 'extension'), /ENFYRA_MCP_PROFILE=all/);
  assert.doesNotMatch(summarizeToolsetForInstructions('guided', 'extension'), /T[0-3]|tier/i);
  assert.doesNotMatch(summarizeToolsetForInstructions('guided', 'all'), /T[0-3]|tier/i);
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

test('dynamic workflow discovery returns an executable selection before domain tools', () => {
  const result = discoverWorkflowRoutes({
    intent: 'create a temporary widget extension',
    detail: 'plan',
    limit: 1,
  }, 'all', true);
  assert.deepEqual(result.nextSelection, {
    tool: 'select_enfyra_workflow',
    input: { surface: 'extension', mode: 'replace' },
  });
  assert.match(result.guidance[0], /Call select_enfyra_workflow.*before.*primaryPath/i);
  assert.match(result.guidance[0], /do not use search_enfyra_tools/i);
  assert.match(JSON.stringify(result.workflows[0].primaryPath), /already return valid saved-state verification/i);
});

test('OAuth provider setup intents route to the dedicated OAuth workflow', () => {
  for (const intent of [
    'setup Google OAuth for a third-party web app',
    'add social login to an external app, with callback cookies and refresh',
    'tích hợp đăng nhập Google cho third app dùng Enfyra',
    'cấu hình OAuth provider cho app bên ngoài',
  ]) {
    const result = discoverWorkflowRoutes({ intent, risk: 'write', detail: 'plan', limit: 1 }, 'all', true);
    assert.equal(result.workflows[0].key, 'oauth', intent);
    assert.deepEqual(result.nextSelection, {
      tool: 'select_enfyra_workflow',
      input: { surface: 'oauth', mode: 'replace' },
    });
    assert.match(JSON.stringify(result.workflows[0].primaryPath), /setup_oauth_provider/);
    const primaryPath = result.workflows[0].primaryPath;
    assert.equal(primaryPath[1].tool, 'get_enfyra_examples');
    assert.match(primaryPath[1].purpose, /category=connect/i);
    assert.match(primaryPath[1].purpose, /before asking for provider credentials/i);
    assert.equal(primaryPath[2].tool, 'get_enfyra_required_knowledge');
    assert.match(primaryPath[2].purpose, /scope=schema/i);
    assert.equal(primaryPath[3].tool, 'setup_oauth_provider');
    assert.match(primaryPath[3].purpose, /appConnectionVerified=true/);
    assert.match(primaryPath[3].purpose, /never inspect or reuse stored credential values/i);
    assert.match(primaryPath[3].stopWhen, /client credentials are missing/i);
    assert.match(primaryPath[3].stopWhen, /stop and ask only/i);
    assert.match(primaryPath[3].stopWhen, /ask only for clientId and clientSecret/i);
    assert.match(primaryPath[3].stopWhen, /do not present callbackUri/i);
    assert.match(primaryPath[4].purpose, /only after the user confirms/i);
    assert.match(JSON.stringify(result.workflows[0].avoidTools), /provider state reads before credentials/i);
  }
});

test('every workflow pack includes its direct primary and verification tools', () => {
  for (const surface of WORKFLOW_SURFACES) {
    const workflow = discoverWorkflowRoutes({ surface, detail: 'plan', limit: 1 }).workflows[0];
    const pack = new Set(workflowToolNames(surface));
    for (const step of [...workflow.primaryPath, ...workflow.verifyPath]) {
      for (const toolName of splitWorkflowToolNames(step.tool)) {
        assert.ok(pack.has(toolName), `${surface} pack misses ${toolName}`);
      }
    }
  }
});

test('extension workflow pack supports safe lifecycle cleanup', () => {
  const pack = new Set(workflowToolNames('extension'));
  assert.ok(pack.has('delete_records'));
});

test('domain-profile workflow routes only direct callers to visible profile tools', () => {
  for (const [profile, surfaces] of Object.entries(WORKFLOW_SURFACES_BY_PROFILE)) {
    for (const surface of surfaces) {
      const result = discoverWorkflowRoutes({ surface, detail: 'plan', limit: 1 }, profile);
      assert.equal(result.workflows.length, 1);
      for (const step of result.workflows[0].primaryPath) {
        if (step.tool === 'full toolset reload tools') continue;
        for (const toolName of splitWorkflowToolNames(step.tool)) {
          assert.equal(
            isToolVisibleInToolset(toolName, 'guided', profile),
            true,
            `${profile}/${surface} directs callers to hidden tool ${toolName}`,
          );
        }
      }
    }
  }
});

test('domain-profile workflow router rejects surfaces owned by another profile', () => {
  const result = discoverWorkflowRoutes({ surface: 'schema', detail: 'plan' }, 'extension');
  assert.equal(result.workflows.length, 0);
  assert.deepEqual(result.surfaces, ['extension']);
  assert.match(result.guidance[0], /ENFYRA_MCP_PROFILE=all/);
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
