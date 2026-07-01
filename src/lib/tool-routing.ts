// @ts-nocheck
export const WORKFLOW_SURFACES = [
  'api-endpoint',
  'extension',
  'schema',
  'record-data',
  'dynamic-script',
  'route-access',
  'guards-permissions-rules',
  'flow',
  'websocket',
  'graphql',
  'package',
  'cache',
  'logs-debug',
  'auth-context',
];

const ALL_DETAILS = ['summary', 'plan', 'full'];

export const TOOL_WORKFLOWS = [
  {
    key: 'api-endpoint',
    title: 'Custom REST endpoint with handler',
    useWhen: [
      'Creating or changing a custom API path with handler behavior.',
      'Changing public/private method access on a custom endpoint.',
      'Adding route permissions for endpoint access.',
    ],
    keywords: ['endpoint', 'api', 'route handler', 'handler', 'webhook', 'custom route', 'rest path'],
    firstTools: ['get_enfyra_required_knowledge', 'discover_script_contexts', 'inspect_route'],
    inspectTools: ['inspect_route', 'get_all_routes', 'trace_metadata_usage'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'discover_script_contexts'],
    writeTools: ['api_endpoint_workflow', 'create_api_endpoint', 'enable_route', 'public_route_methods', 'private_route_methods', 'ensure_route_access'],
    verifyTools: ['test_rest_endpoint', 'run_admin_test'],
    avoidTools: [
      {
        tool: 'create_route',
        when: 'a handler-backed endpoint or route permission plan is needed',
        useInstead: 'api_endpoint_workflow',
        reason: 'The workflow validates source, reads live route/handler/access state, applies one safe step at a time, and returns nextSteps.',
      },
      {
        tool: 'create_table',
        when: 'the user asked for custom behavior at an API path',
        useInstead: 'api_endpoint_workflow',
        reason: 'Tables create persisted data models; custom route handlers own behavior endpoints.',
      },
    ],
    requiredAck: ['globalRulesAckKey', 'dynamicCodeAckKey when saving handler source'],
    exampleCategories: ['handlers-hooks', 'permissions-rls'],
    nextStepTemplate: [
      'Inspect the route or run api_endpoint_workflow with apply=false.',
      'Read required knowledge before apply/applyAll.',
      'Apply one pending step or use applyAll only when the plan is fully understood.',
      'Verify the endpoint with test_rest_endpoint or run_admin_test.',
    ],
  },
  {
    key: 'extension',
    title: 'Admin extension, menu, shell notification, or account panel UI',
    useWhen: [
      'Creating or changing Enfyra admin page/widget/global extensions.',
      'Adding menu entries, menu notification dots/counts, account panel rows, or shell actions.',
      'Reviewing extension UI theme/layout/component usage.',
    ],
    keywords: ['extension', 'menu', 'account panel', 'notification', 'chip', 'badge', 'sidebar', 'shell', 'page ui', 'widget'],
    firstTools: ['get_enfyra_required_knowledge', 'get_extension_theme_contract', 'inspect_feature'],
    inspectTools: ['inspect_feature', 'trace_metadata_usage', 'get_script_source'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'get_extension_theme_contract', 'get_theme_class_reference'],
    writeTools: ['extension_workflow', 'ensure_menu', 'reorder_menus', 'update_extension_code', 'ensure_page_extension', 'ensure_global_extension', 'ensure_widget_extension'],
    verifyTools: ['validate_extension_code', 'inspect_feature'],
    avoidTools: [
      {
        tool: 'create_record/update_record on enfyra_extension',
        when: 'creating or changing extension code',
        useInstead: 'update_extension_code for an existing extension id/name, or extension_workflow/ensure_*_extension for create/wire flows',
        reason: 'Extension operation tools validate local guards plus /enfyra_extension/preview and save only after validation succeeds.',
      },
      {
        tool: 'query_table on destination domain lists',
        when: 'decorating menu/account panel notifications',
        useInstead: 'notification summary/realtime shell signal plus destination-page fetch on click',
        reason: 'Shell notifications should not fetch messages, tickets, orders, or jobs lists solely for a badge.',
      },
      {
        tool: 'update_record/PATCH enfyra_menu for order or parent changes',
        when: 'drag-and-drop or programmatic menu ordering changes sibling order or parent',
        useInstead: 'reorder_menus',
        reason: 'The Enfyra 2.2.6 /admin/menu/reorder route validates menu hierarchy constraints and emits menu cache invalidation.',
      },
    ],
    requiredAck: ['globalRulesAckKey', 'extensionAckKey when saving extension code'],
    exampleCategories: ['extensions'],
    nextStepTemplate: [
      'Call get_extension_theme_contract before writing or reviewing UI.',
      'Inspect the existing menu/extension/global shell registration.',
      'Use extension_workflow with apply=false when page/menu wiring or shell notification behavior needs multiple steps.',
      'Use reorder_menus for menu order/parent changes instead of patching individual enfyra_menu records.',
      'Choose count only when the source already owns an exact count; choose dot/chip for new-attention signals.',
      'Validate extension code or use an ensure_*_extension tool that validates before saving.',
    ],
  },
  {
    key: 'schema',
    title: 'Table, column, relation, validation, or schema metadata change',
    useWhen: [
      'Creating or changing tables, columns, relations, indexes, or validation metadata.',
      'Designing relation direction or inverse relation exposure.',
      'Changing GraphQL/table schema flags alongside metadata.',
    ],
    keywords: ['schema', 'table', 'column', 'relation', 'field', 'index', 'validation', 'inverse'],
    firstTools: ['get_enfyra_required_knowledge', 'inspect_table', 'get_all_tables'],
    inspectTools: ['inspect_table', 'get_table_metadata', 'get_all_tables'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'get_enfyra_examples'],
    writeTools: ['create_table', 'update_table', 'delete_table', 'create_column', 'update_column', 'delete_column', 'create_relation', 'delete_relation', 'ensure_column_rule'],
    verifyTools: ['inspect_table', 'get_table_metadata'],
    avoidTools: [
      {
        tool: 'create_record/update_record on enfyra_column or enfyra_relation',
        when: 'changing schema metadata',
        useInstead: 'table/column/relation schema tools',
        reason: 'Schema tools resolve table ids, preserve relation contracts, and reject physical FK names.',
      },
      {
        tool: 'manual inversePropertyName',
        when: 'there is no concrete response/UI/deep-query/aggregate need for reverse traversal',
        useInstead: 'owning relation only',
        reason: 'Relation design stays minimal unless the reverse field is actually used.',
      },
    ],
    requiredAck: ['globalRulesAckKey'],
    exampleCategories: ['schema-relations'],
    nextStepTemplate: [
      'Inspect the existing table and relations.',
      'Decide owner relation and whether an inverse is actually needed.',
      'Apply schema tool changes with globalRulesAckKey.',
      'Re-inspect metadata instead of assuming the saved shape.',
    ],
  },
  {
    key: 'record-data',
    title: 'Route-backed table data query or CRUD',
    useWhen: [
      'Reading or mutating normal route-backed records.',
      'Counting records or finding one row by filter.',
      'Testing filters, fields, deep relations, pagination, or aggregate query shape.',
    ],
    keywords: ['record', 'crud', 'query', 'count', 'filter', 'aggregate', 'deep', 'sort', 'pagination'],
    firstTools: ['inspect_table', 'discover_query_capabilities'],
    inspectTools: ['inspect_table', 'get_table_metadata', 'discover_query_capabilities'],
    knowledgeTools: ['get_enfyra_required_knowledge for writes'],
    writeTools: ['create_record', 'update_record', 'delete_record'],
    verifyTools: ['find_one_record', 'query_table', 'count_records'],
    avoidTools: [
      {
        tool: 'query_table without limit or all=true',
        when: 'listing records',
        useInstead: 'query_table with a bounded limit or all=true for intentional complete reads',
        reason: 'List/query tools require explicit paging intent.',
      },
      {
        tool: 'generic CRUD on internal/no-route system tables',
        when: 'changing schema, sessions, columns, or other no-route internals',
        useInstead: 'specific schema/platform tools',
        reason: 'Generic CRUD is for route-backed tables only.',
      },
    ],
    requiredAck: ['globalRulesAckKey for writes', 'dynamicCodeAckKey for script-backed sourceCode writes', 'extensionAckKey for extension code writes'],
    exampleCategories: ['queries-deep'],
    nextStepTemplate: [
      'Inspect table metadata and choose fields explicitly.',
      'Use bounded pagination or all=true deliberately.',
      'For writes, read required knowledge and use metadata-backed field names only.',
      'Re-read with explicit fields after mutation when saved shape matters.',
    ],
  },
  {
    key: 'dynamic-script',
    title: 'Dynamic server code: handlers, hooks, scripts, or source patches',
    useWhen: [
      'Writing or reviewing handler, hook, flow step, websocket, GraphQL, or bootstrap sourceCode.',
      'Editing an existing script-backed metadata record.',
      'Debugging macro, repository, or validation behavior.',
    ],
    keywords: ['sourcecode', 'script', 'hook', 'pre hook', 'post hook', 'compiledcode', 'macro', 'repos', 'bootstrap'],
    firstTools: ['get_enfyra_required_knowledge', 'discover_script_contexts', 'trace_metadata_usage'],
    inspectTools: ['trace_metadata_usage', 'get_script_source', 'discover_script_contexts'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'discover_script_contexts'],
    writeTools: ['patch_script_source', 'update_script_source', 'create_handler', 'create_pre_hook', 'create_post_hook', 'api_endpoint_workflow'],
    verifyTools: ['validate_dynamic_script', 'run_admin_test', 'test_rest_endpoint', 'test_flow_step'],
    avoidTools: [
      {
        tool: 'update_record with compiledCode',
        when: 'editing dynamic scripts',
        useInstead: 'patch_script_source or update_script_source with sourceCode',
        reason: 'compiledCode is generated and may differ because macros expand.',
      },
      {
        tool: 'throw new Error for intentional user/domain failures',
        when: 'writing generated dynamic server code',
        useInstead: '@THROW400-style macros or native $ctx.$throw helpers',
        reason: 'Intentional domain errors should use the platform error contract.',
      },
    ],
    requiredAck: ['globalRulesAckKey', 'dynamicCodeAckKey'],
    exampleCategories: ['handlers-hooks'],
    nextStepTemplate: [
      'Discover script context macros for the surface.',
      'Read existing source through trace_metadata_usage/get_script_source when patching.',
      'Validate source before save unless the chosen write tool already validates.',
      'Verify behavior with the route/test runner that matches the script surface.',
    ],
  },
  {
    key: 'route-access',
    title: 'Authenticated route access and public/private method state',
    useWhen: [
      'Debugging 403/401 route access.',
      'Granting role/user access to a route method.',
      'Changing publicMethods or availableMethods.',
    ],
    keywords: ['permission', '403', '401', 'role', 'route access', 'public method', 'private method', 'available method'],
    firstTools: ['get_permission_profile', 'inspect_route', 'audit_route_access'],
    inspectTools: ['get_permission_profile', 'inspect_route', 'audit_route_access'],
    knowledgeTools: ['get_enfyra_required_knowledge'],
    writeTools: ['ensure_route_access', 'add_route_methods', 'replace_route_methods', 'remove_route_methods', 'public_route_methods', 'private_route_methods', 'enable_route', 'disable_route'],
    verifyTools: ['audit_route_access', 'test_rest_endpoint'],
    avoidTools: [
      {
        tool: 'raw enfyra_route_permission CRUD',
        when: 'granting route access',
        useInstead: 'ensure_route_access',
        reason: 'The operation tool resolves roles/methods and merges existing method grants safely.',
      },
      {
        tool: 'public_route_methods',
        when: 'the desired behavior is authenticated user access',
        useInstead: 'ensure_route_access',
        reason: 'publicMethods grants anonymous access; route permissions grant authenticated access.',
      },
    ],
    requiredAck: ['globalRulesAckKey for writes'],
    exampleCategories: ['permissions-rls'],
    nextStepTemplate: [
      'Inspect route and permission profile before changing access.',
      'Decide anonymous publicMethods versus authenticated route permission.',
      'Use route operation tools instead of raw permission CRUD.',
      'Audit and test the route after the change.',
    ],
  },
  {
    key: 'guards-permissions-rules',
    title: 'Guards, field permissions, and column validation rules',
    useWhen: [
      'Adding route guards, guard rules, field permissions, or column rules.',
      'Restricting field read/write behavior.',
      'Adding body validation rules at metadata level.',
    ],
    keywords: ['guard', 'field permission', 'column rule', 'validation rule', 'rule', 'rls'],
    firstTools: ['get_enfyra_required_knowledge', 'inspect_table', 'inspect_route'],
    inspectTools: ['inspect_table', 'inspect_route', 'discover_query_capabilities'],
    knowledgeTools: ['get_enfyra_required_knowledge'],
    writeTools: ['ensure_guard', 'ensure_field_permission', 'ensure_column_rule'],
    verifyTools: ['test_rest_endpoint', 'query_table', 'run_admin_test'],
    avoidTools: [
      {
        tool: 'raw create_record on guard/rule tables',
        when: 'a dedicated ensure_* operation exists',
        useInstead: 'ensure_guard, ensure_field_permission, or ensure_column_rule',
        reason: 'Ensure tools resolve ids and preserve the current rule contract.',
      },
    ],
    requiredAck: ['globalRulesAckKey'],
    exampleCategories: ['permissions-rls', 'schema-relations'],
    nextStepTemplate: [
      'Inspect the target table/route and decide the security boundary first.',
      'Use the specific ensure_* operation for the rule surface.',
      'Verify with the route/query behavior the rule is meant to protect.',
    ],
  },
  {
    key: 'flow',
    title: 'Flow, scheduled/manual flow, or flow step',
    useWhen: [
      'Creating or changing manual/scheduled flows.',
      'Choosing or writing a flow step.',
      'Testing or triggering a flow.',
    ],
    keywords: ['flow', 'scheduled', 'manual flow', 'flow step', 'trigger flow', 'workflow'],
    firstTools: ['get_enfyra_required_knowledge', 'choose_flow_step_tool', 'discover_script_contexts'],
    inspectTools: ['inspect_feature', 'query_table'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'discover_script_contexts'],
    writeTools: ['ensure_manual_flow', 'ensure_scheduled_flow', 'ensure_query_flow_step', 'ensure_create_flow_step', 'ensure_update_flow_step', 'ensure_delete_flow_step', 'ensure_http_flow_step', 'ensure_sleep_flow_step', 'ensure_trigger_flow_step', 'ensure_log_flow_step', 'ensure_condition_flow_step', 'ensure_script_flow_step'],
    verifyTools: ['test_flow_step', 'run_admin_test', 'trigger_flow'],
    avoidTools: [
      {
        tool: 'ensure_script_flow_step',
        when: 'a fixed query/create/update/delete/http/sleep/trigger/log step can express the operation',
        useInstead: 'choose_flow_step_tool then the fixed-type ensure_*_flow_step',
        reason: 'Atomic step types are easier to inspect, test, and maintain than oversized scripts.',
      },
    ],
    requiredAck: ['globalRulesAckKey', 'dynamicCodeAckKey for script or condition source'],
    exampleCategories: ['flows'],
    nextStepTemplate: [
      'Use choose_flow_step_tool before mutating when step type is unclear.',
      'Prefer fixed-type flow step tools over script steps.',
      'Validate/test script or condition steps before relying on the flow.',
      'Trigger manually only after the saved steps are verified.',
    ],
  },
  {
    key: 'websocket',
    title: 'Socket.IO gateway or websocket event',
    useWhen: [
      'Creating or changing websocket gateways/events.',
      'Writing websocket handler source.',
      'Testing websocket event logic.',
    ],
    keywords: ['websocket', 'socket', 'socket.io', 'gateway', 'realtime', 'room'],
    firstTools: ['get_enfyra_required_knowledge', 'discover_script_contexts', 'inspect_feature'],
    inspectTools: ['inspect_feature', 'discover_script_contexts'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'discover_script_contexts'],
    writeTools: ['ensure_websocket_gateway', 'ensure_websocket_event'],
    verifyTools: ['run_admin_test'],
    avoidTools: [
      {
        tool: 'raw CRUD on enfyra_websocket_event',
        when: 'saving websocket event source',
        useInstead: 'ensure_websocket_event',
        reason: 'The operation tool validates script source and preserves gateway/event linkage.',
      },
    ],
    requiredAck: ['globalRulesAckKey', 'dynamicCodeAckKey when saving event source'],
    exampleCategories: ['websocket'],
    nextStepTemplate: [
      'Discover websocket script context before writing source.',
      'Ensure gateway first, then event.',
      'Use run_admin_test for event/connection scripts where possible.',
    ],
  },
  {
    key: 'graphql',
    title: 'GraphQL enablement and query surface',
    useWhen: [
      'Enabling/disabling GraphQL for a table.',
      'Checking GraphQL endpoint/schema behavior.',
      'Clarifying REST route methods versus GraphQL table exposure.',
    ],
    keywords: ['graphql', 'gql', 'schema endpoint'],
    firstTools: ['discover_enfyra_system', 'inspect_table'],
    inspectTools: ['discover_enfyra_system', 'inspect_table'],
    knowledgeTools: ['get_enfyra_required_knowledge for writes'],
    writeTools: ['set_table_graphql', 'update_table'],
    verifyTools: ['reload_graphql', 'discover_enfyra_system'],
    avoidTools: [
      {
        tool: 'public_route_methods',
        when: 'trying to expose GraphQL table data',
        useInstead: 'set_table_graphql plus GraphQL auth planning',
        reason: 'REST publicMethods do not make GraphQL table data anonymous.',
      },
    ],
    requiredAck: ['globalRulesAckKey for writes'],
    exampleCategories: ['queries-deep'],
    nextStepTemplate: [
      'Inspect the table and GraphQL enablement state.',
      'Use set_table_graphql for enablement changes.',
      'Remember GraphQL table data requires Bearer auth even when REST is public.',
    ],
  },
  {
    key: 'package',
    title: 'Runtime package install or package-backed extension/script support',
    useWhen: [
      'Installing npm packages for dynamic code or extension runtime use.',
      'Checking package availability before using getPackages in extensions.',
    ],
    keywords: ['package', 'npm', 'install', 'dependency', 'getpackages'],
    firstTools: ['search_npm', 'get_enfyra_required_knowledge'],
    inspectTools: ['search_npm', 'query_table'],
    knowledgeTools: ['get_enfyra_required_knowledge'],
    writeTools: ['install_package'],
    verifyTools: ['query_table'],
    avoidTools: [
      {
        tool: 'raw create_record on enfyra_package',
        when: 'installing packages',
        useInstead: 'install_package',
        reason: 'The package tool resolves package metadata and avoids duplicate package records.',
      },
    ],
    requiredAck: ['globalRulesAckKey'],
    exampleCategories: ['extensions', 'handlers-hooks'],
    nextStepTemplate: [
      'Search package metadata first.',
      'Install with install_package and globalRulesAckKey.',
      'Use getPackages inside extension runtime code rather than static imports.',
    ],
  },
  {
    key: 'cache',
    title: 'Cache reload or stale metadata/runtime diagnosis',
    useWhen: [
      'Diagnosing stale routes, metadata, GraphQL, or full runtime cache.',
      'Manually reloading only after natural partial reload appears stale.',
    ],
    keywords: ['cache', 'reload', 'stale', 'refresh metadata', 'reload routes'],
    firstTools: ['inspect_table', 'inspect_route', 'get_enfyra_api_context'],
    inspectTools: ['inspect_table', 'inspect_route', 'get_enfyra_api_context'],
    knowledgeTools: ['get_enfyra_required_knowledge for manual reloads'],
    writeTools: ['reload_metadata', 'reload_routes', 'reload_graphql', 'reload_all'],
    verifyTools: ['inspect_table', 'inspect_route', 'discover_enfyra_system'],
    avoidTools: [
      {
        tool: 'manual reload tools',
        when: 'a successful metadata mutation already triggered natural partial reload and no stale evidence exists',
        useInstead: 'verify behavior first with inspect/test tools',
        reason: 'Manual reloads should be evidence-driven, not reflexive.',
      },
    ],
    requiredAck: ['globalRulesAckKey for manual reload tools'],
    exampleCategories: [],
    nextStepTemplate: [
      'Verify stale behavior with narrow inspect/test tools.',
      'Choose the narrowest reload surface if stale evidence exists.',
      'Re-verify the same narrow behavior after reload.',
    ],
  },
  {
    key: 'logs-debug',
    title: 'Logs, runtime diagnostics, and test runner debugging',
    useWhen: [
      'Reading app/error logs.',
      'Searching logs for route, flow, websocket, or dynamic script failures.',
      'Running admin tests for supported runtime surfaces.',
    ],
    keywords: ['log', 'debug', 'error', 'trace', 'tail', 'diagnostic', 'test runner'],
    firstTools: ['get_log_files', 'search_logs'],
    inspectTools: ['get_log_files', 'get_log_content', 'tail_log', 'search_logs'],
    knowledgeTools: [],
    writeTools: [],
    verifyTools: ['run_admin_test', 'test_flow_step', 'test_rest_endpoint'],
    avoidTools: [
      {
        tool: 'broad metadata discovery',
        when: 'the problem is a concrete runtime error with known log text',
        useInstead: 'search_logs or tail_log',
        reason: 'Log tools are narrower and cheaper for runtime debugging.',
      },
    ],
    requiredAck: [],
    exampleCategories: [],
    nextStepTemplate: [
      'Search or tail the narrowest log first.',
      'Use the matching test tool to reproduce once the failing surface is known.',
      'Patch only after the failing step is identified.',
    ],
  },
  {
    key: 'auth-context',
    title: 'MCP target, auth token, current user, and permission profile',
    useWhen: [
      'Confirming which Enfyra instance MCP is connected to.',
      'Debugging API-token exchange or current MCP user permissions.',
      'Checking whether non-root tokens can call admin helper routes.',
    ],
    keywords: ['auth', 'token', 'current user', 'permission profile', 'target', 'api base', '403', 'exchange'],
    firstTools: ['get_enfyra_api_context', 'get_current_user', 'get_permission_profile'],
    inspectTools: ['get_enfyra_api_context', 'get_current_user', 'get_permission_profile'],
    knowledgeTools: [],
    writeTools: ['login'],
    verifyTools: ['get_current_user', 'get_permission_profile'],
    avoidTools: [
      {
        tool: 'discover_enfyra_system',
        when: 'only confirming the connected API base',
        useInstead: 'get_enfyra_api_context',
        reason: 'Target sanity checks should be cheap and should not load broad metadata.',
      },
    ],
    requiredAck: [],
    exampleCategories: ['ssr-app-auth', 'oauth-setup'],
    nextStepTemplate: [
      'Use get_enfyra_api_context for target sanity checks.',
      'Use get_permission_profile before assuming admin helper route access with non-root tokens.',
      'Use login only when an interactive credential login is explicitly needed.',
    ],
  },
];

function compactWorkflow(workflow) {
  return {
    key: workflow.key,
    title: workflow.title,
    useWhen: workflow.useWhen,
  };
}

function planWorkflow(workflow) {
  return {
    ...compactWorkflow(workflow),
    firstTools: workflow.firstTools,
    inspectTools: workflow.inspectTools,
    knowledgeTools: workflow.knowledgeTools,
    writeTools: workflow.writeTools,
    verifyTools: workflow.verifyTools,
    requiredAck: workflow.requiredAck,
    exampleCategories: workflow.exampleCategories,
    nextSteps: workflow.nextStepTemplate,
    avoidTools: workflow.avoidTools,
  };
}

function fullWorkflow(workflow) {
  return {
    ...planWorkflow(workflow),
    keywords: workflow.keywords,
  };
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function scoreWorkflow(workflow, { intent, surface, risk }) {
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
  if (risk === 'write' && workflow.writeTools.length) score += 2;
  if (risk === 'destructive' && workflow.avoidTools.some((item) => normalize(item.when).includes('delete'))) score += 2;
  return score;
}

export function listWorkflowSurfaces() {
  return TOOL_WORKFLOWS.map(compactWorkflow);
}

export function discoverWorkflowRoutes({
  intent = '',
  surface,
  risk = 'unknown',
  detail = 'summary',
  limit = 5,
} = {}) {
  const normalizedSurface = surface ? normalize(surface) : undefined;
  const normalizedDetail = ALL_DETAILS.includes(detail) ? detail : 'summary';
  const normalizedRisk = normalize(risk) || 'unknown';
  const formatter = normalizedDetail === 'full'
    ? fullWorkflow
    : normalizedDetail === 'plan'
      ? planWorkflow
      : compactWorkflow;
  const scored = TOOL_WORKFLOWS
    .map((workflow) => ({ workflow, score: scoreWorkflow(workflow, { intent, surface: normalizedSurface, risk: normalizedRisk }) }))
    .filter((item) => !normalizedSurface || item.workflow.key === normalizedSurface || item.score > 0)
    .sort((a, b) => b.score - a.score || a.workflow.key.localeCompare(b.workflow.key));
  const selected = (scored.length ? scored : TOOL_WORKFLOWS.map((workflow) => ({ workflow, score: 0 })))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 10)));
  return {
    action: 'enfyra_workflows_discovered',
    intent: intent || null,
    requestedSurface: surface || null,
    risk: normalizedRisk,
    detail: normalizedDetail,
    matchedWorkflowCount: scored.length,
    workflows: selected.map((item) => ({
      score: item.score,
      ...formatter(item.workflow),
    })),
    surfaces: normalizedDetail === 'summary' ? WORKFLOW_SURFACES : undefined,
    guidance: [
      'Use this as progressive disclosure: pick the closest workflow, then call its firstTools instead of loading every Enfyra tool/example.',
      'For writes, call get_enfyra_required_knowledge and pass the returned acknowledgement keys into write tools.',
      'Treat avoidTools as negative routing boundaries; they prevent near-correct tool choices from crossing the wrong platform contract.',
    ],
  };
}
