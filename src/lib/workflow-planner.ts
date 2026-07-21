import {
  ALL_DETAILS,
  TOOL_WORKFLOWS,
  WORKFLOW_SURFACES,
  WORKFLOW_SURFACES_BY_PROFILE,
  type ToolWorkflow,
  type WorkflowDetail,
  type WorkflowPathStep,
  type WorkflowProfile,
  type WorkflowRouteOptions,
  type WorkflowSurface,
} from './workflow-definitions.js';

function compactWorkflow(workflow: ToolWorkflow) {
  return {
    key: workflow.key,
    title: workflow.title,
    useWhen: workflow.useWhen,
    recommendedScope: workflow.recommendedScope,
  };
}

function step(order: number, tool: string, purpose: string, extra: Partial<WorkflowPathStep> = {}): WorkflowPathStep {
  return { order, tool, purpose, ...extra };
}

function primaryPathFor(workflow: ToolWorkflow): WorkflowPathStep[] {
  switch (workflow.key) {
    case 'api-endpoint':
      return [
        step(1, 'get_enfyra_required_knowledge', 'Read mutation/security contracts and collect acknowledgement keys.'),
        step(2, 'discover_script_contexts', 'Load handler/hook macros and repository contracts before writing source.'),
        step(3, 'api_endpoint_workflow', 'For a fully specified non-destructive endpoint, apply all safe steps in one call. Use apply=false only when a route/access decision is unresolved.'),
        step(5, 'test_rest_endpoint', 'Smoke-test the final route contract.'),
      ];
    case 'extension':
      return [
        step(1, 'get_enfyra_required_knowledge', 'Read global and extension contracts; collect acknowledgement keys.'),
        step(2, 'get_extension_theme_contract', 'Load the required eApp/Nuxt UI theme and component contract.'),
        step(3, 'search_admin_extensions', 'Locate the menu/page/widget/global extension by visible text, path, button, icon, tab, or source term.'),
        step(4, 'search_admin_extensions', 'Inspect the selected admin UI artifact with mode=inspect using nextInspect.input.'),
        step(5, 'build_extension_ui', 'After acknowledgement, generate or review high-contract extension UI lazily by kind: drawer, modal, page shell, permission gate, empty state, resource list, FormEditor, Widget, shell registries, tabs, upload modal, api usage, notify, runtime review, theme classes, theme review, or full review.'),
        step(6, 'extension_workflow or patch_extension_code/update_extension_code', 'Use extension_workflow for create/wire flows, patch_extension_code for focused edits, or update_extension_code for full replacements.'),
        step(7, 'verify_extension_runtime', 'Extension save operations already return valid saved-state verification. Call this only when that receipt is inconclusive or the task explicitly requires an independent recheck; run browser QA separately when browserRender is not_run.'),
      ];
    case 'schema':
      return [
        step(1, 'get_enfyra_required_knowledge', 'Read schema invariants and collect globalRulesAckKey.'),
        step(2, 'get_schema_design_context', 'Step zero: read live column types, table/column/relation attributes, constraint shape, and creation order.'),
        step(3, 'get_all_tables or inspect_table', 'Check existing tables before naming new tables or adding to an existing table.', { when: 'Use get_all_tables for new app schemas; inspect_table for a known existing table.' }),
        step(4, 'create_tables / create_columns / create_relations / update_tables', 'Apply schema changes with native array inputs using only live types and relation propertyName values from the design context. Put relation-based unique/index groups in the same create_tables item as the owning relations, or add them later with update_tables after relations exist.'),
        step(5, 'inspect_table', 'Re-read saved metadata before creating records, queries, handlers, or UI against the table.'),
      ];
    case 'record-data':
      return [
        step(1, 'inspect_table', 'Read live columns, relations, primary key, route path, and field visibility.'),
        step(2, 'discover_query_capabilities', 'Load filter/deep/sort/aggregate shape when query shape is non-trivial.'),
        step(3, 'debug_field_exposure', 'Build a compact repro when fields/deep may expose an unpublished field; escalate core exposure instead of adding local fixes.', { when: 'The task is about hidden/private/secret field exposure.' }),
        step(4, 'query_table / find_one_record / count_records', 'Read records with explicit fields and bounded pagination.'),
        step(5, 'create_records / update_records / delete_records', 'For writes, use only metadata-backed column names and relation propertyName values. Always pass a native array, even for one item.', { when: 'Only after required knowledge is read for writes.' }),
        step(6, 'find_one_record or query_table', 'Verify the saved/read shape with explicit fields.'),
      ];
    case 'dynamic-script':
      return [
        step(1, 'get_enfyra_required_knowledge', 'Read dynamic-code contracts and collect acknowledgement keys.'),
        step(2, 'discover_script_contexts', 'Load macros, repository trust paths, per-surface helpers, and the fields+deep projection contract for script repository reads.'),
        step(3, 'build_dynamic_repository_usage', 'Generate secure or intentional trusted repository access when the script reads or writes table data.'),
        step(4, 'search_runtime_zone', 'Locate the script-backed runtime artifact in api_runtime, flow_runtime, or websocket_runtime.'),
        step(5, 'patch_script_source or update_script_source', 'Patch or replace the inspected source artifact with validation and hash checks.'),
        step(6, 'test_rest_endpoint / run_admin_test / test_flow_step', 'Verify through the runtime path that owns the script.'),
      ];
    case 'route-access':
    case 'guards-permissions-rules':
      return [
        step(1, 'get_enfyra_required_knowledge', 'Read access/security contracts.'),
        step(2, 'inspect_route or inspect_table', 'Inspect the exact route/table access surface.'),
        step(3, 'audit_route_access', 'Compare current route permissions against expected roles/users/methods.'),
        step(4, 'ensure_route_access / ensure_route_rate_limit / create_pre_hook / ensure_field_permission / ensure_guard / ensure_column_rule', 'Apply the specific access/rule operation. Use ensure_route_rate_limit for request throttling and create_pre_hook for owner/tenant row filters.'),
        step(5, 'audit_route_access or test_rest_endpoint', 'Verify the access behavior.'),
      ];
    case 'flow':
      return [
        step(1, 'get_enfyra_required_knowledge', 'Read flow/dynamic-code contracts.'),
        step(2, 'discover_script_contexts', 'Load flow-step macros only when a script or condition step is needed.'),
        step(3, 'flow_workflow', 'For a fully specified non-destructive flow, apply the flow and all steps sequentially in one call. Use apply=false only when step selection is unresolved.'),
        step(5, 'test_flow_step or trigger_flow', 'Use test_flow_step for disabled flows. Use trigger_flow only for an enabled flow when intentionally verifying the real queue/runtime path.'),
      ];
    case 'websocket':
      return [
        step(1, 'get_enfyra_required_knowledge', 'Read websocket/dynamic-code contracts.'),
        step(2, 'discover_script_contexts', 'Load socket helpers and room APIs.'),
        step(3, 'search_runtime_zone', 'Locate existing websocket gateway/event with zone=websocket_runtime when editing.'),
        step(4, 'ensure_websocket_gateway / ensure_websocket_event', 'Create or update gateway/event through validation-aware tools.'),
        step(5, 'run_admin_test', 'Verify connection/event handler behavior and captured emits with kind=websocket_event or websocket_connection. This does not prove a real Socket.IO client transport/handshake.'),
      ];
    case 'graphql':
      return [
        step(1, 'discover_enfyra_system', 'Read GraphQL endpoint/auth/table enablement context.'),
        step(2, 'inspect_table', 'Inspect the table before enabling GraphQL.'),
        step(3, 'set_table_graphql', 'Enable or disable generated GraphQL exposure for the table.'),
        step(4, 'test_graphql', 'Execute an authenticated GraphQL operation and inspect data/errors.'),
      ];
    case 'storage-file':
      return [
        step(1, 'search_runtime_zone', 'Search storage configs, folders, files, and file permissions with zone=storage_file.'),
        step(2, 'search_runtime_zone', 'Inspect the selected storage_file result using nextInspect.input.'),
        step(3, 'get_enfyra_examples', 'Load category=files when browser multipart, proxy, progress, or @STORAGE behavior is involved.'),
        step(4, 'create_records / update_records / delete_records', 'Mutate metadata/configuration rows only after reading required knowledge; do not use record CRUD to upload bytes. This MCP does not expose a binary/multipart upload input tool, so stop and report that boundary for execute-now upload requests.'),
        step(5, 'search_runtime_zone or query_table', 'Verify the saved metadata and public/permission state.'),
      ];
    case 'oauth':
      return [
        step(1, 'get_enfyra_api_context', 'Confirm the Enfyra API target used to derive the provider callback URI.'),
        step(2, 'get_enfyra_examples', 'Load category=connect, inspect the actual third-app framework, and implement or verify the proxy, OAuth start action, cookieBridgePrefix, and /me session check before asking for provider credentials.', {
          stopWhen: 'The third app or its framework cannot be located: ask the user which app to connect instead of choosing one by guesswork.',
        }),
        step(3, 'get_enfyra_required_knowledge', 'After the app connection is verified, load scope=schema to acknowledge global rules before the OAuth config write.'),
        step(4, 'setup_oauth_provider', 'After the user supplies clientId and clientSecret, call with appConnectionVerified=true to save the Enfyra config and receive the exact callback handoff. Never inspect or reuse stored credential values. Present callbackUri only from this receipt, then stop for provider-console confirmation; setupComplete remains false.', {
          stopWhen: 'Client credentials are missing from the current user request: stop and ask only for clientId and clientSecret. Do not inspect provider state, do not present callbackUri, and do not ask the user to configure the provider console yet.',
        }),
        step(5, 'test_rest_endpoint', 'Only after the user confirms the callback URI was added, verify runtime availability, then complete a real browser OAuth login through the already connected app and verify /me. Do not declare success from /auth/providers alone.'),
      ];
    case 'identity-access':
      return [
        step(1, 'search_runtime_zone', 'Search users, roles, permissions, guards, and OAuth config with zone=auth_security.'),
        step(2, 'get_enfyra_examples', 'Load oauth-setup or connect only when that identity path is involved.'),
        step(3, 'inspect_table or query_table', 'Inspect the exact user, role, OAuth, or permission contract.'),
        step(4, 'create_records / update_records / delete_records / ensure_route_access', 'Apply the narrow identity metadata or access operation after required knowledge.'),
        step(5, 'query_table / get_permission_profile / test_rest_endpoint', 'Verify the closest identity/access behavior.'),
      ];
    case 'platform-config':
      return [
        step(1, 'inspect_table', 'Inspect enfyra_setting or enfyra_cors_origin before choosing fields or keys.'),
        step(2, 'query_table', 'Read the current focused configuration rows.'),
        step(3, 'create_records / update_records / delete_records', 'Apply one focused metadata-backed configuration change after required knowledge.'),
        step(4, 'query_table', 'Re-read the changed row and verify the saved value.'),
      ];
    case 'package':
      return [
        step(1, 'search_npm', 'Find package candidates from npm.'),
        step(2, 'get_enfyra_required_knowledge', 'Read package/runtime mutation contracts.'),
        step(3, 'install_package', 'Install the selected package through the package operation tool.'),
        step(4, 'search_runtime_zone', 'Verify package runtime state with zone=package_runtime when needed.'),
      ];
    case 'cache':
      return [
        step(1, 'discover_runtime_context', 'Read runtime/cache context and current app target.'),
        step(2, 'inspect_table / inspect_route / search_runtime_zone', 'Confirm the specific stale artifact before reloading.'),
        step(3, 'full toolset reload tools', 'Only when stale evidence persists, switch to full toolset and reload the narrowest proven surface; reload_all is last resort.'),
        step(4, 'inspect_table / inspect_route / discover_enfyra_system', 'Verify the stale state cleared.'),
      ];
    case 'logs-debug':
      return [
        step(1, 'search_logs', 'Search the narrow log pattern/time clue.'),
        step(2, 'tail_log', 'Tail only the relevant log when live reproduction is needed.'),
      ];
    case 'auth-context':
      return [
        step(1, 'get_enfyra_api_context', 'Confirm the connected target cheaply.'),
        step(2, 'get_current_user', 'Read current user/session context.'),
        step(3, 'get_permission_profile', 'Check admin helper route permissions for non-root tokens.'),
      ];
    default:
      return workflow.firstTools.map((tool, index) => step(index + 1, tool, 'Follow this workflow step.'));
  }
}

function splitCompositeToolName(tool: string) {
  if (tool === 'full toolset reload tools') return [];
  return tool
    .split(/\s+or\s+|\s*\/\s*/g)
    .map((item) => item.trim().replace(/\(.*/, ''))
    .filter(Boolean);
}

export function workflowToolNames(surface: WorkflowSurface) {
  const workflow = TOOL_WORKFLOWS.find((item) => item.key === surface);
  if (!workflow) return [];
  return [...new Set([
    ...workflow.firstTools,
    ...workflow.inspectTools,
    ...workflow.knowledgeTools,
    ...workflow.writeTools,
    ...workflow.verifyTools,
    ...primaryPathFor(workflow).flatMap((item) => splitCompositeToolName(item.tool)),
    ...advancedToolsFor(workflow).flatMap(splitCompositeToolName),
    ...verifyPathFor(workflow).flatMap((item) => splitCompositeToolName(item.tool)),
  ])];
}

function advancedToolsFor(workflow: ToolWorkflow) {
  const primaryTools = new Set(primaryPathFor(workflow).flatMap((item) => splitCompositeToolName(item.tool)));
  return [...new Set([
    ...workflow.inspectTools,
    ...workflow.knowledgeTools,
    ...workflow.writeTools,
    ...workflow.verifyTools,
  ])].filter((tool) => !primaryTools.has(tool));
}

function escapeHatchesFor(workflow: ToolWorkflow) {
  const escape = new Set(['create_records', 'update_records', 'delete_records', 'create_route', 'reload_all', 'reload_metadata', 'reload_routes', 'reload_graphql', 'get_all_metadata', 'get_table_metadata']);
  return [...new Set([...workflow.writeTools, ...workflow.verifyTools, ...workflow.inspectTools])]
    .filter((tool) => escape.has(tool));
}

function verifyPathFor(workflow: ToolWorkflow) {
  return workflow.verifyTools.map((tool, index) => step(index + 1, tool, 'Verify the workflow result through the closest runtime/read path.'));
}

function planWorkflow(workflow: ToolWorkflow) {
  return {
    ...compactWorkflow(workflow),
    recommendedScope: workflow.recommendedScope,
    primaryPath: primaryPathFor(workflow),
    advancedTools: advancedToolsFor(workflow),
    escapeHatches: escapeHatchesFor(workflow),
    verifyPath: verifyPathFor(workflow),
    requiredAck: workflow.requiredAck,
    exampleCategories: workflow.exampleCategories,
    avoidTools: workflow.avoidTools,
    legacyToolSets: {
      firstTools: workflow.firstTools,
      inspectTools: workflow.inspectTools,
      knowledgeTools: workflow.knowledgeTools,
      writeTools: workflow.writeTools,
      verifyTools: workflow.verifyTools,
    },
  };
}

function fullWorkflow(workflow: ToolWorkflow) {
  return {
    ...planWorkflow(workflow),
    keywords: workflow.keywords,
  };
}

function normalize(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function scoreWorkflow(workflow: ToolWorkflow, { intent, surface, risk }: { intent: string; surface?: string; risk: string }) {
  let score = 0;
  const text = normalize(intent);
  if (surface && workflow.key === surface) score += 20;
  if (surface && workflow.key.includes(surface)) score += 8;
  if (text) {
    for (const keyword of workflow.keywords || []) {
      if (text.includes(keyword)) score += 4;
    }
    for (const phrase of workflow.useWhen || []) {
      const words = normalize(phrase).split(/\W+/).filter((word) => word.length > 3);
      if (words.some((word) => text.includes(word))) score += 1;
    }
  }
  if (risk === 'debug' && workflow.key === 'logs-debug') score += 6;
  const oauthIntent = /\b(?:oauth|google login|social login|provider callback)\b|đăng nhập google|cấu hình oauth|tích hợp oauth/u.test(text);
  if (oauthIntent && workflow.key === 'oauth') score += 20;
  if (oauthIntent && ['auth-context', 'api-endpoint'].includes(workflow.key)) score -= 8;
  if (risk === 'write' && workflow.writeTools.length) score += 2;
  if (risk === 'destructive' && workflow.avoidTools.some((item) => normalize(item.when).includes('delete'))) score += 2;
  if (workflow.key === 'dynamic-script' && /\b(patch|edit|update|fix|change)\b/.test(text) && /\b(sourcecode|source|compiledcode|script)\b/.test(text)) score += 10;
  if (workflow.key === 'dynamic-script' && /flow step/.test(text) && /\b(sourcecode|source|compiledcode|script)\b/.test(text)) score += 6;
  if (workflow.key === 'flow' && /\b(patch|edit|update|fix|change)\b/.test(text) && /\b(sourcecode|source|compiledcode|script)\b/.test(text)) score -= 4;
  return score;
}

export function listWorkflowSurfaces() {
  return TOOL_WORKFLOWS.map(compactWorkflow);
}

function normalizeDetail(detail: string): WorkflowDetail {
  return (ALL_DETAILS as readonly string[]).includes(detail) ? detail as WorkflowDetail : 'summary';
}

function normalizeRisk(risk: string) {
  const value = normalize(risk) || 'unknown';
  if (['read', 'write', 'destructive', 'debug', 'unknown'].includes(value)) return value;
  if (['low', 'safe', 'readonly', 'read-only'].includes(value)) return 'read';
  if (['medium', 'normal', 'moderate', 'mutation', 'mutating'].includes(value)) return 'write';
  if (['high', 'danger', 'dangerous', 'delete', 'destructive-write'].includes(value)) return 'destructive';
  return 'unknown';
}

export function discoverWorkflowRoutes({
  intent = '',
  surface,
  risk = 'unknown',
  detail = 'summary',
  limit = 5,
}: WorkflowRouteOptions = {}, profile: WorkflowProfile = 'all', dynamicToolPacks = false) {
  const normalizedSurface = surface ? normalize(surface) : undefined;
  const normalizedDetail = normalizeDetail(detail);
  const normalizedRisk = normalizeRisk(risk);
  const availableSurfaces = profile === 'all' ? WORKFLOW_SURFACES : WORKFLOW_SURFACES_BY_PROFILE[profile];
  if (normalizedSurface && !availableSurfaces.includes(normalizedSurface as WorkflowSurface)) {
    return {
      action: 'enfyra_workflows_discovered',
      profile,
      intent: intent || null,
      requestedSurface: surface || null,
      risk: normalizedRisk,
      detail: normalizedDetail,
      matchedWorkflowCount: 0,
      workflows: [],
      surfaces: availableSurfaces,
      guidance: [
        `The ${profile} profile does not expose the ${normalizedSurface} workflow. Reconnect with ENFYRA_MCP_PROFILE=all or the owning domain profile.`,
      ],
    };
  }
  const formatter = normalizedDetail === 'full'
    ? fullWorkflow
    : normalizedDetail === 'plan'
      ? planWorkflow
      : compactWorkflow;
  const availableWorkflows = TOOL_WORKFLOWS.filter((workflow) => availableSurfaces.includes(workflow.key));
  const scored = availableWorkflows
    .map((workflow) => ({ workflow, score: scoreWorkflow(workflow, { intent, surface: normalizedSurface, risk: normalizedRisk }) }))
    .filter((item) => !normalizedSurface || item.workflow.key === normalizedSurface || item.score > 0)
    .sort((a, b) => b.score - a.score || a.workflow.key.localeCompare(b.workflow.key));
  const selected = (scored.length ? scored : availableWorkflows.map((workflow) => ({ workflow, score: 0 })))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 10)));
  return {
    action: 'enfyra_workflows_discovered',
    profile,
    intent: intent || null,
    requestedSurface: surface || null,
    risk: normalizedRisk,
    detail: normalizedDetail,
    matchedWorkflowCount: scored.length,
    workflows: selected.map((item) => ({
      score: item.score,
      ...formatter(item.workflow),
    })),
    nextSelection: dynamicToolPacks && selected[0]
      ? {
          tool: 'select_enfyra_workflow',
          input: { surface: selected[0].workflow.key, mode: 'replace' },
        }
      : undefined,
    surfaces: normalizedDetail === 'summary' ? availableSurfaces : undefined,
    guidance: [
      ...(dynamicToolPacks ? ['Call select_enfyra_workflow with nextSelection.input before using primaryPath domain tools; do not use search_enfyra_tools for tools already named by the selected workflow.'] : []),
      'Use this as progressive disclosure: pick the closest workflow and follow primaryPath in order instead of choosing from the flat MCP tool list.',
      'For writes, call get_enfyra_required_knowledge and pass the returned acknowledgement keys into write tools.',
      'Treat avoidTools as negative routing boundaries; they prevent near-correct tool choices from crossing the wrong platform contract.',
      'Use advancedTools only when the primaryPath says they fit; use escapeHatches only with explicit evidence that the front-door tool is insufficient.',
    ],
  };
}

