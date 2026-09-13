import test from 'node:test';
import assert from 'node:assert/strict';
import { registeredToolNamesFromSource } from '../test-support/source-tree.js';
import {
  installToolsetFilter,
  isToolInProfile,
  normalizeMcpProfile,
  summarizeToolsetForInstructions,
} from '../dist/lib/toolset-filter.js';
import { isMutationTool } from '../dist/lib/tool-contracts.js';
import {
  WORKFLOW_SURFACES,
  WORKFLOW_SURFACES_BY_PROFILE,
  discoverWorkflowRoutes,
  workflowSurfaceForTool,
  workflowToolNames,
} from '../dist/lib/tool-routing.js';

function registeredToolNames() {
  return registeredToolNamesFromSource();
}

function splitWorkflowToolNames(value) {
  if (value === 'visible reload workflow') return [];
  return value
    .split(/\s+or\s+|\s*\/\s*/g)
    .map((tool) => tool.trim().replace(/\(.*/, ''))
    .filter(Boolean);
}

test('normalizes MCP domain profile to all by default', () => {
  assert.equal(normalizeMcpProfile(undefined), 'all');
  assert.equal(normalizeMcpProfile(''), 'all');
  assert.equal(normalizeMcpProfile('unknown'), 'all');
  assert.equal(normalizeMcpProfile('EXTENSION'), 'extension');
  assert.equal(normalizeMcpProfile('schema'), 'schema');
  assert.equal(normalizeMcpProfile('runtime'), 'runtime');
  assert.equal(normalizeMcpProfile('operations'), 'operations');
});

test('guided domain profiles expose a bounded task surface', () => {
  const registered = registeredToolNames();
  for (const profile of ['extension', 'schema', 'runtime', 'operations']) {
    const visible = [...registered].filter((name) => isToolInProfile(name, profile));
    assert.ok(visible.length >= 20, `${profile} exposes too few tools: ${visible.length}`);
    assert.ok(visible.length <= 52, `${profile} exposes too many tools: ${visible.length}`);
    assert.ok(visible.includes('get_enfyra_api_context'));
    assert.ok(visible.includes('get_enfyra_required_knowledge'));
    assert.ok(visible.includes('discover_enfyra_workflows'));
  }
});

test('extension and schema profiles isolate normal domain tools', () => {
  assert.equal(isToolInProfile('extension_workflow', 'extension'), true);
  assert.equal(isToolInProfile('patch_extension_code', 'extension'), true);
  assert.equal(isToolInProfile('delete_extension', 'extension'), true);
  assert.equal(isToolInProfile('delete_menu', 'extension'), true);
  assert.equal(isToolInProfile('create_tables', 'extension'), false);
  assert.equal(isToolInProfile('create_handler', 'extension'), false);

  assert.equal(isToolInProfile('create_tables', 'schema'), true);
  assert.equal(isToolInProfile('query_table', 'schema'), true);
  assert.equal(isToolInProfile('extension_workflow', 'schema'), false);
  assert.equal(isToolInProfile('search_logs', 'schema'), false);
});

test('guided toolset exposes front-door tools and hides escape hatches', () => {
  assert.equal(isToolInProfile('discover_enfyra_workflows'), true);
  assert.equal(isToolInProfile('select_enfyra_workflow'), false);
  assert.equal(isToolInProfile('confirm_schema_mutation'), true);
  assert.equal(isToolInProfile('confirm_schema_mutation', 'schema'), true);
  assert.equal(isToolInProfile('search_admin_extensions'), true);
  assert.equal(isToolInProfile('assess_permission_exposure', 'extension'), true);
  assert.equal(isToolInProfile('search_runtime_zone'), true);
  assert.equal(isToolInProfile('inspect_rest_projection'), true);
  assert.equal(isToolInProfile('debug_field_exposure'), false);
  assert.equal(isToolInProfile('api_endpoint_workflow'), true);
  assert.equal(isToolInProfile('apply_endpoint'), false);
  assert.equal(isToolInProfile('apply_schema'), false);
  assert.equal(isToolInProfile('resolve_route_context', 'runtime'), true);
  assert.equal(isToolInProfile('resolve_route_context', 'operations'), true);
  assert.equal(isToolInProfile('patch_extension_code'), true);
  assert.equal(isToolInProfile('verify_extension_runtime'), true);
  assert.equal(isToolInProfile('build_extension_ui'), true);
  assert.equal(isToolInProfile('build_extension_api_usage'), false);
  assert.equal(isToolInProfile('validate_extension_code'), false);
  assert.equal(isToolInProfile('get_theme_class_reference'), false);
  assert.equal(isToolInProfile('build_extension_drawer'), false);
  assert.equal(isToolInProfile('build_extension_modal'), false);
  assert.equal(isToolInProfile('build_extension_page_shell'), false);
  assert.equal(isToolInProfile('build_extension_permission_gate'), false);
  assert.equal(isToolInProfile('build_extension_empty_state'), false);
  assert.equal(isToolInProfile('build_extension_resource_list'), false);
  assert.equal(isToolInProfile('build_extension_form_editor'), false);
  assert.equal(isToolInProfile('build_extension_widget'), false);
  assert.equal(isToolInProfile('build_extension_menu_notification'), false);
  assert.equal(isToolInProfile('build_extension_account_panel_item'), false);
  assert.equal(isToolInProfile('build_extension_tabs'), false);
  assert.equal(isToolInProfile('build_extension_upload_modal'), false);
  assert.equal(isToolInProfile('review_extension_ui_contract'), false);
  assert.equal(isToolInProfile('create_pre_hook'), true);
  assert.equal(isToolInProfile('ensure_route_rate_limit'), true);
  assert.equal(isToolInProfile('flow_workflow'), true);
  assert.equal(isToolInProfile('ensure_flow'), true);
  assert.equal(isToolInProfile('ensure_flow_trigger'), true);
  assert.equal(isToolInProfile('remove_flow_trigger'), true);
  assert.equal(isToolInProfile('delete_flow'), true);
  assert.equal(isToolInProfile('delete_flow_step'), true);
  assert.equal(isToolInProfile('plan_flow_steps'), true);
  assert.equal(isToolInProfile('test_graphql'), true);
  assert.equal(isToolInProfile('build_dynamic_repository_usage'), true);
  assert.equal(isToolInProfile('create_handler'), true);
  assert.equal(isToolInProfile('create_post_hook'), true);
  assert.equal(isToolInProfile('delete_route_handler'), true);
  assert.equal(isToolInProfile('delete_route_hook'), true);
  assert.equal(isToolInProfile('delete_route_permission'), true);
  assert.equal(isToolInProfile('ensure_auth_header'), true);
  assert.equal(isToolInProfile('reorder_auth_headers'), true);
  assert.equal(isToolInProfile('ensure_auth_header', 'operations'), true);
  assert.equal(isToolInProfile('list_methods'), true);
  assert.equal(isToolInProfile('ensure_script_flow_step'), false);
  assert.equal(isToolInProfile('ensure_manual_flow'), false);
  assert.equal(isToolInProfile('ensure_scheduled_flow'), false);
  assert.equal(isToolInProfile('create_route'), false);
  assert.equal(isToolInProfile('reload_all'), false);
  assert.equal(isToolInProfile('get_log_content'), false);
});

test('registration exposes only the gateway while keeping internal operations callable by the catalog', () => {
  const server = { tool: (name) => ({ name, enabled: true }) };
  const state = installToolsetFilter(server, 'guided', 'all');
  assert.equal(server.tool('enfyra', '', {}, () => null).enabled, true);
  assert.equal(server.tool('get_enfyra_api_context', '', {}, () => null).enabled, false);
  assert.equal(server.tool('create_route', '', {}, () => null).enabled, false);
  assert.deepEqual(state.listVisibleToolNames(), ['enfyra']);
  assert.equal(typeof state.getTool('get_enfyra_api_context').handler, 'function');
  assert.deepEqual(state.hiddenTools, ['get_enfyra_api_context', 'create_route']);
});

test('toolset instruction summary describes the fixed guided surface', () => {
  assert.match(summarizeToolsetForInstructions('guided', 'all'), /guided/);
  assert.match(summarizeToolsetForInstructions('guided', 'all'), /stay hidden/);
  assert.match(summarizeToolsetForInstructions('guided', 'extension'), /extension/);
  assert.match(summarizeToolsetForInstructions('guided', 'extension'), /ENFYRA_MCP_PROFILE=all/);
  assert.doesNotMatch(summarizeToolsetForInstructions('guided', 'extension'), /T[0-3]|tier/i);
  assert.doesNotMatch(summarizeToolsetForInstructions('guided', 'all'), /T[0-3]|tier/i);
});

test('guided workflow primary paths never direct callers to hidden tools', () => {
  for (const surface of WORKFLOW_SURFACES) {
    const result = discoverWorkflowRoutes({ surface, detail: 'plan', limit: 1 });
    const primaryPath = result.workflows[0].primaryPath;
    for (const step of primaryPath) {
      if (step.tool === 'visible reload workflow') continue;
      const toolNames = step.tool.split(/\s+or\s+|\s*\/\s*/g).map((tool) => tool.trim());
      for (const toolName of toolNames) {
        assert.equal(
          isToolInProfile(toolName),
          true,
          `${surface} primary path directs guided callers to hidden tool ${toolName}`,
        );
      }
    }
  }
});

test('dynamic workflow discovery routes hidden domain tools through the schema-validating catalog gateway', () => {
  const result = discoverWorkflowRoutes({
    intent: 'create a temporary widget extension',
    detail: 'plan',
    limit: 1,
  }, 'all');
  assert.equal(result.nextSelection, undefined);
  assert.match(result.guidance[0], /enfyra action=discover.*exact name.*action=execute/i);
  assert.match(result.guidance[0], /tools\/list stays unchanged/i);
  assert.match(JSON.stringify(result.workflows[0].primaryPath), /already return valid saved-state verification/i);
});

test('OAuth provider setup intents route to the dedicated OAuth workflow', () => {
  for (const intent of [
    'setup Google OAuth for a third-party web app',
    'add social login to an external app, with callback cookies and refresh',
    'tích hợp đăng nhập Google cho third app dùng Enfyra',
    'cấu hình OAuth provider cho app bên ngoài',
  ]) {
    const result = discoverWorkflowRoutes({ intent, risk: 'write', detail: 'plan', limit: 1 }, 'all');
    assert.equal(result.workflows[0].key, 'oauth', intent);
    assert.equal(result.nextSelection, undefined);
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

test('every guided mutation belongs to at least one dynamic workflow pack', () => {
  const packedTools = new Set(WORKFLOW_SURFACES.flatMap(workflowToolNames));
  const orphanMutations = [...registeredToolNames()]
    .filter((toolName) => isToolInProfile(toolName))
    .filter(isMutationTool)
    .filter((toolName) => toolName !== 'execute_enfyra_tool')
    .filter((toolName) => !packedTools.has(toolName));

  assert.deepEqual(orphanMutations, []);
  assert.equal(workflowSurfaceForTool('delete_route'), 'api-endpoint');
  assert.equal(workflowSurfaceForTool('delete_route_hook'), 'api-endpoint');
  assert.equal(workflowSurfaceForTool('delete_method'), 'api-endpoint');
  assert.equal(workflowSurfaceForTool('confirm_schema_mutation'), 'schema');
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
        if (step.tool === 'visible reload workflow') continue;
        for (const toolName of splitWorkflowToolNames(step.tool)) {
          assert.equal(
            isToolInProfile(toolName, profile),
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
