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
  'storage-file',
  'identity-access',
  'platform-config',
  'package',
  'cache',
  'logs-debug',
  'auth-context',
] as const;

const ALL_DETAILS = ['summary', 'plan', 'full'] as const;

type WorkflowSurface = typeof WORKFLOW_SURFACES[number];
type WorkflowDetail = typeof ALL_DETAILS[number];

type AvoidToolRule = {
  tool: string;
  when: string;
  useInstead: string;
  reason: string;
};

type WorkflowPathStep = {
  order: number;
  tool: string;
  purpose: string;
  when?: string;
  stopWhen?: string;
};

type ToolWorkflow = {
  key: WorkflowSurface;
  title: string;
  useWhen: string[];
  keywords: string[];
  firstTools: string[];
  inspectTools: string[];
  knowledgeTools: string[];
  writeTools: string[];
  verifyTools: string[];
  avoidTools: AvoidToolRule[];
  requiredAck: string[];
  exampleCategories: string[];
  nextStepTemplate: string[];
  recommendedScope: string;
};

type WorkflowRouteOptions = {
  intent?: string;
  surface?: string;
  risk?: string;
  detail?: string;
  limit?: number;
};

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
        tool: 'create_tables',
        when: 'the user asked for custom behavior at an API path',
        useInstead: 'api_endpoint_workflow',
        reason: 'Tables create persisted data models; custom route handlers own behavior endpoints.',
      },
    ],
    requiredAck: ['globalRulesAckKey', 'dynamicCodeAckKey when saving handler source'],
    exampleCategories: ['handlers-hooks', 'permissions-rls'],
    nextStepTemplate: [
      'For an ambiguous, high-risk, or approval-gated change, inspect the route or run api_endpoint_workflow with apply=false.',
      'Read required knowledge before applying.',
      'For a fully specified non-destructive endpoint, use applyAll after the required narrow reads; otherwise apply one reviewed pending step.',
      'Verify the endpoint with test_rest_endpoint or run_admin_test.',
    ],
    recommendedScope: 'dynamic-code',
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
    firstTools: ['get_enfyra_required_knowledge', 'get_extension_theme_contract', 'search_admin_extensions'],
    inspectTools: ['search_admin_extensions(mode=search)', 'search_admin_extensions(mode=inspect)', 'search_runtime_zone(mode=search, zone=admin_ui)'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'get_extension_theme_contract', 'get_theme_class_reference', 'build_extension_ui'],
    writeTools: ['extension_workflow', 'ensure_menu', 'reorder_menus', 'patch_extension_code', 'update_extension_code', 'ensure_page_extension', 'ensure_global_extension', 'ensure_widget_extension'],
    verifyTools: ['build_extension_ui(kind=runtime_review|theme_review|review)', 'validate_extension_code', 'search_admin_extensions(mode=search)', 'search_runtime_zone(mode=search, zone=admin_ui)'],
    avoidTools: [
      {
        tool: 'create_records/update_records on enfyra_extension',
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
        tool: 'update_records/PATCH enfyra_menu for order or parent changes',
        when: 'drag-and-drop or programmatic menu ordering changes sibling order or parent',
        useInstead: 'reorder_menus',
        reason: 'The Enfyra 2.2.6 /admin/menu/reorder route validates menu hierarchy constraints and emits menu cache invalidation.',
      },
    ],
    requiredAck: ['globalRulesAckKey', 'extensionAckKey when saving extension code'],
    exampleCategories: ['extensions'],
    nextStepTemplate: [
      'Call get_extension_theme_contract before writing or reviewing UI.',
      'Use search_admin_extensions to locate the existing menu/extension/global shell registration, then inspect one candidate before editing.',
      'Use extension_workflow with apply=false only when page/menu wiring is ambiguous or needs approval; use applyAll after narrow inspection when the requested create/wire contract is fully specified.',
      'Use reorder_menus for menu order/parent changes instead of patching individual enfyra_menu records.',
      'Choose count only when the source already owns an exact count; choose dot/chip for new-attention signals.',
      'Validate extension code or use an ensure_*_extension tool that validates before saving.',
    ],
    recommendedScope: 'extension',
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
    firstTools: ['get_enfyra_required_knowledge', 'get_schema_design_context', 'inspect_table', 'get_all_tables'],
    inspectTools: ['get_schema_design_context', 'inspect_table', 'get_table_metadata', 'get_all_tables'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'get_schema_design_context', 'get_enfyra_examples'],
    writeTools: ['create_tables', 'update_tables', 'delete_tables', 'create_columns', 'update_columns', 'delete_columns', 'create_relations', 'delete_relations', 'ensure_column_rule'],
    verifyTools: ['inspect_table', 'get_table_metadata'],
    avoidTools: [
      {
        tool: 'create_records/update_records on enfyra_column or enfyra_relation',
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
      'Call get_schema_design_context and read liveColumnTypes plus metadata input attributes before choosing column/table/relation shapes.',
      'Inspect the existing table and relations.',
      'Decide owner relation and whether an inverse is actually needed.',
      'Apply schema tool changes with globalRulesAckKey.',
      'Re-inspect metadata instead of assuming the saved shape.',
    ],
    recommendedScope: 'schema',
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
    knowledgeTools: ['get_enfyra_required_knowledge'],
    writeTools: ['create_records', 'update_records', 'delete_records'],
    verifyTools: ['find_one_record', 'query_table', 'count_records', 'debug_field_exposure'],
    avoidTools: [
      {
        tool: 'query_table without limit or all=true',
        when: 'listing records',
        useInstead: 'query_table with a bounded limit or all=true for intentional complete reads',
        reason: 'List/query tools require explicit paging intent.',
      },
      {
        tool: 'single-record CRUD tools',
        when: 'creating, updating, or deleting one row',
        useInstead: 'plural tools with a one-item array',
        reason: 'MCP write tools are bulk envelopes; they accept native arrays, preflight arrays, and run sequentially even for one item.',
      },
      {
        tool: 'generic CRUD on internal/no-route system tables',
        when: 'changing schema, sessions, columns, or other no-route internals',
        useInstead: 'specific schema/platform tools',
        reason: 'Generic CRUD is for route-backed tables only.',
      },
      {
        tool: 'route-local pre-hook or frontend hiding',
        when: 'REST fields/deep appears to return an isPublished=false field',
        useInstead: 'debug_field_exposure',
        reason: 'Unpublished field exposure is a core contract issue; first produce a compact repro and escalation shape.',
      },
    ],
    requiredAck: ['globalRulesAckKey for writes', 'dynamicCodeAckKey for script-backed sourceCode writes', 'extensionAckKey for extension code writes'],
    exampleCategories: ['queries-deep'],
    nextStepTemplate: [
      'Inspect table metadata and choose fields explicitly.',
      'Use bounded pagination or all=true deliberately.',
      'For suspected hidden/private field leaks through fields/deep, run debug_field_exposure and escalate core exposure instead of patching UI/hooks.',
      'For writes, read required knowledge and use plural mutation tools with native array inputs, even for one item.',
      'Re-read with explicit fields after mutation when saved shape matters.',
    ],
    recommendedScope: 'schema',
  },
  {
    key: 'dynamic-script',
    title: 'Dynamic server code: handlers, hooks, scripts, or source patches',
    useWhen: [
      'Writing or reviewing handler, hook, flow step, websocket, or bootstrap sourceCode.',
      'Editing an existing script-backed metadata record.',
      'Debugging macro, repository, or validation behavior.',
    ],
    keywords: ['sourcecode', 'script', 'hook', 'pre hook', 'post hook', 'compiledcode', 'macro', 'repos', 'bootstrap'],
    firstTools: ['get_enfyra_required_knowledge', 'discover_script_contexts', 'build_dynamic_repository_usage', 'search_runtime_zone'],
    inspectTools: ['search_runtime_zone(mode=search, zone=api_runtime|flow_runtime|websocket_runtime)', 'search_runtime_zone(mode=inspect)', 'trace_metadata_usage', 'get_script_source', 'discover_script_contexts'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'discover_script_contexts', 'build_dynamic_repository_usage'],
    writeTools: ['patch_script_source', 'update_script_source', 'create_handler', 'create_pre_hook', 'create_post_hook', 'api_endpoint_workflow'],
    verifyTools: ['validate_dynamic_script', 'run_admin_test', 'test_rest_endpoint', 'test_flow_step'],
    avoidTools: [
      {
        tool: 'update_records with compiledCode',
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
      'Generate repository access with build_dynamic_repository_usage instead of composing secure/trusted syntax from memory.',
      'Read existing source through trace_metadata_usage/get_script_source when patching.',
      'Validate source before save unless the chosen write tool already validates.',
      'Verify behavior with the route/test runner that matches the script surface.',
    ],
    recommendedScope: 'dynamic-code',
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
    recommendedScope: 'schema',
  },
  {
    key: 'guards-permissions-rules',
    title: 'Guards, field permissions, and column validation rules',
    useWhen: [
      'Adding route guards, guard rules, field permissions, or column rules.',
      'Adding request rate limits or throttling to a route.',
      'Restricting field read/write behavior.',
      'Adding body validation rules at metadata level.',
    ],
    keywords: ['guard', 'rate limit', 'throttle', 'field permission', 'column rule', 'validation rule', 'rule', 'rls'],
    firstTools: ['get_enfyra_required_knowledge', 'inspect_table', 'inspect_route'],
    inspectTools: ['inspect_table', 'inspect_route', 'discover_query_capabilities'],
    knowledgeTools: ['get_enfyra_required_knowledge'],
    writeTools: ['ensure_route_rate_limit', 'ensure_guard', 'ensure_field_permission', 'ensure_column_rule', 'create_pre_hook'],
    verifyTools: ['test_rest_endpoint', 'query_table', 'run_admin_test'],
    avoidTools: [
      {
        tool: 'raw create_records on guard/rule tables',
        when: 'a dedicated ensure_* operation exists',
        useInstead: 'ensure_route_rate_limit, ensure_guard, ensure_field_permission, or ensure_column_rule',
        reason: 'Ensure tools resolve ids and preserve the current rule contract.',
      },
      {
        tool: 'create_pre_hook',
        when: 'the requirement is request throttling or rate limiting',
        useInstead: 'ensure_route_rate_limit',
        reason: 'Rate limits belong to the built-in guard engine, not custom pre-hook scripts.',
      },
      {
        tool: 'ensure_field_permission',
        when: 'the requirement is owner/tenant row scoping or RLS query filtering',
        useInstead: 'create_pre_hook',
        reason: 'Field permissions protect field visibility; row ownership/RLS is enforced by pre-hooks that merge owner/tenant filters into @QUERY.filter.',
      },
    ],
    requiredAck: ['globalRulesAckKey'],
    exampleCategories: ['permissions-rls', 'schema-relations'],
    nextStepTemplate: [
      'Inspect the target table/route and decide the security boundary first.',
      'Use create_pre_hook for owner/tenant row filters; use ensure_field_permission only for field visibility.',
      'Use the specific ensure_* operation for guard, field, or column rule surfaces.',
      'Verify with the route/query behavior the rule is meant to protect.',
    ],
    recommendedScope: 'schema',
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
    firstTools: ['get_enfyra_required_knowledge', 'flow_workflow', 'plan_flow_steps', 'discover_script_contexts'],
    inspectTools: ['inspect_feature', 'query_table'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'discover_script_contexts'],
    writeTools: ['flow_workflow', 'plan_flow_steps'],
    verifyTools: ['test_flow_step', 'run_admin_test', 'trigger_flow'],
    avoidTools: [
      {
        tool: 'ensure_script_flow_step',
        when: 'a fixed query/create/update/delete/http/sleep/trigger/log step can express the operation',
        useInstead: 'flow_workflow or plan_flow_steps',
        reason: 'Atomic step types are easier to inspect, test, and maintain than oversized scripts.',
      },
    ],
    requiredAck: ['globalRulesAckKey', 'dynamicCodeAckKey for script or condition source'],
    exampleCategories: ['flows'],
    nextStepTemplate: [
      'Use flow_workflow with apply=false for multi-step flows; use plan_flow_steps only for dry-run step selection.',
      'Prefer fixed step types over script steps.',
      'Validate/test script or condition steps before relying on the flow.',
      'Trigger manually only after the saved steps are verified.',
    ],
    recommendedScope: 'flow',
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
    recommendedScope: 'dynamic-code',
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
    knowledgeTools: ['get_enfyra_required_knowledge'],
    writeTools: ['set_table_graphql', 'update_tables'],
    verifyTools: ['test_graphql', 'discover_enfyra_system'],
    avoidTools: [
      {
        tool: 'public_route_methods',
        when: 'trying to expose GraphQL table data',
        useInstead: 'set_table_graphql plus GraphQL auth planning',
        reason: 'REST publicMethods do not make GraphQL table data anonymous.',
      },
    ],
    requiredAck: ['globalRulesAckKey for writes'],
    exampleCategories: ['graphql'],
    nextStepTemplate: [
      'Inspect the table and GraphQL enablement state.',
      'Use set_table_graphql for enablement changes.',
      'Run test_graphql with an authenticated query and inspect GraphQL errors as data.',
      'Remember GraphQL table data requires Bearer auth even when REST is public.',
    ],
    recommendedScope: 'schema',
  },
  {
    key: 'storage-file',
    title: 'Files, folders, storage configuration, and file permissions',
    useWhen: [
      'Inspecting or configuring storage providers and folders.',
      'Managing file metadata, public state, or file permissions.',
      'Building browser upload behavior and progress handling.',
    ],
    keywords: ['file upload', 'upload progress', 'storage config', 'storage provider', 'folder', 'file permission', 'asset'],
    firstTools: ['search_runtime_zone', 'get_enfyra_examples'],
    inspectTools: ['search_runtime_zone(mode=search, zone=storage_file)', 'search_runtime_zone(mode=inspect)', 'inspect_table', 'query_table'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'get_enfyra_examples(category=files)'],
    writeTools: ['create_records', 'update_records', 'delete_records'],
    verifyTools: ['search_runtime_zone', 'query_table'],
    avoidTools: [
      {
        tool: 'create_records on enfyra_file for binary upload',
        when: 'uploading file bytes from a browser or dynamic script',
        useInstead: 'multipart /enfyra/enfyra_file or @STORAGE helpers',
        reason: 'File metadata CRUD does not provide object upload, rollback, or progress behavior.',
      },
    ],
    requiredAck: ['globalRulesAckKey for metadata writes'],
    exampleCategories: ['files'],
    nextStepTemplate: [
      'Search storage_file runtime state, then inspect the selected record/table.',
      'Use the files examples for browser proxy, multipart, progress, and @STORAGE contracts.',
      'Use generic record tools only for metadata/configuration rows, never as a binary upload substitute.',
    ],
    recommendedScope: 'schema',
  },
  {
    key: 'identity-access',
    title: 'Users, roles, OAuth configuration, and application identity access',
    useWhen: [
      'Inspecting or managing Enfyra users and roles.',
      'Configuring OAuth providers or OAuth account metadata.',
      'Designing application login, session, refresh, and role access behavior.',
    ],
    keywords: ['user role', 'oauth provider', 'oauth config', 'oauth account', 'login flow', 'session refresh', 'identity access'],
    firstTools: ['search_runtime_zone', 'get_enfyra_examples'],
    inspectTools: ['search_runtime_zone(mode=search, zone=auth_security)', 'search_runtime_zone(mode=inspect)', 'query_table', 'get_permission_profile'],
    knowledgeTools: ['get_enfyra_required_knowledge', 'get_enfyra_examples(category=oauth-setup|ssr-app-auth)'],
    writeTools: ['create_records', 'update_records', 'delete_records', 'ensure_route_access'],
    verifyTools: ['query_table', 'get_permission_profile', 'test_rest_endpoint'],
    avoidTools: [
      {
        tool: 'custom login/logout/me routes',
        when: 'a browser app can use the Enfyra same-origin proxy and cookies',
        useInstead: 'the built-in /login, /me, /logout, refresh, and OAuth routes through /enfyra',
        reason: 'Custom token-cookie routes duplicate the supported identity lifecycle and are easier to get wrong.',
      },
    ],
    requiredAck: ['globalRulesAckKey for identity metadata writes'],
    exampleCategories: ['ssr-app-auth', 'oauth-setup'],
    nextStepTemplate: [
      'Separate MCP token context from application user/role/OAuth configuration.',
      'Inspect auth_security runtime records and the live table contract before writes.',
      'Verify built-in auth behavior through the app-origin proxy or the narrow REST endpoint.',
    ],
    recommendedScope: 'schema',
  },
  {
    key: 'platform-config',
    title: 'Platform settings and CORS origins',
    useWhen: [
      'Inspecting or changing enfyra_setting values.',
      'Adding, updating, or removing allowed CORS origins.',
      'Checking runtime platform configuration before application integration.',
    ],
    keywords: ['cors', 'allowed origin', 'platform setting', 'enfyra_setting', 'enfyra_cors_origin'],
    firstTools: ['inspect_table', 'query_table'],
    inspectTools: ['inspect_table', 'query_table', 'discover_runtime_context'],
    knowledgeTools: ['get_enfyra_required_knowledge'],
    writeTools: ['create_records', 'update_records', 'delete_records'],
    verifyTools: ['query_table', 'discover_runtime_context'],
    avoidTools: [
      {
        tool: 'inventing setting keys or CORS fields',
        when: 'live metadata has not been inspected',
        useInstead: 'inspect_table for enfyra_setting or enfyra_cors_origin',
        reason: 'Platform configuration is metadata-backed and field names must come from the current Enfyra version.',
      },
    ],
    requiredAck: ['globalRulesAckKey for writes'],
    exampleCategories: [],
    nextStepTemplate: [
      'Inspect the exact configuration table and current row first.',
      'Apply a focused generic record mutation with acknowledgement.',
      'Re-read the same row and verify application behavior before manual reloads.',
    ],
    recommendedScope: 'schema',
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
        tool: 'raw create_records on enfyra_package',
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
    recommendedScope: 'schema',
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
    knowledgeTools: ['get_enfyra_required_knowledge'],
    writeTools: [],
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
      'If stale evidence truly requires manual reload, switch to ENFYRA_MCP_TOOLSET=full and choose the narrowest reload surface.',
      'Re-verify the same narrow behavior after reload.',
    ],
    recommendedScope: 'schema',
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
    firstTools: ['search_logs', 'tail_log'],
    inspectTools: ['search_logs', 'tail_log'],
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
    recommendedScope: 'schema',
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
    recommendedScope: 'schema',
  },
] satisfies ToolWorkflow[];

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
        step(7, 'validate_extension_code', 'Validate only when the chosen write tool did not already validate and save atomically.'),
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
        step(5, 'get_script_source', 'Read editable sourceCode and hash for the selected record.'),
        step(6, 'patch_script_source or update_script_source', 'Patch or replace source with validation and hash checks.'),
        step(7, 'test_rest_endpoint / run_admin_test / test_flow_step', 'Verify through the runtime path that owns the script.'),
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
        step(5, 'test_flow_step or trigger_flow', 'Verify a step or enqueue the flow intentionally.'),
      ];
    case 'websocket':
      return [
        step(1, 'get_enfyra_required_knowledge', 'Read websocket/dynamic-code contracts.'),
        step(2, 'discover_script_contexts', 'Load socket helpers and room APIs.'),
        step(3, 'search_runtime_zone', 'Locate existing websocket gateway/event with zone=websocket_runtime when editing.'),
        step(4, 'ensure_websocket_gateway / ensure_websocket_event', 'Create or update gateway/event through validation-aware tools.'),
        step(5, 'run_admin_test', 'Verify connection/event handler behavior with the admin test runner.'),
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
        step(4, 'create_records / update_records / delete_records', 'Mutate metadata/configuration rows only after reading required knowledge; do not use record CRUD to upload bytes.'),
        step(5, 'search_runtime_zone or query_table', 'Verify the saved metadata and public/permission state.'),
      ];
    case 'identity-access':
      return [
        step(1, 'search_runtime_zone', 'Search users, roles, permissions, guards, and OAuth config with zone=auth_security.'),
        step(2, 'get_enfyra_examples', 'Load oauth-setup or ssr-app-auth only when that identity path is involved.'),
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
  return tool.split(/\s+or\s+| \/ /g).map((item) => item.trim()).filter(Boolean);
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
}: WorkflowRouteOptions = {}) {
  const normalizedSurface = surface ? normalize(surface) : undefined;
  const normalizedDetail = normalizeDetail(detail);
  const normalizedRisk = normalizeRisk(risk);
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
      'Use this as progressive disclosure: pick the closest workflow and follow primaryPath in order instead of choosing from the flat MCP tool list.',
      'For writes, call get_enfyra_required_knowledge and pass the returned acknowledgement keys into write tools.',
      'Treat avoidTools as negative routing boundaries; they prevent near-correct tool choices from crossing the wrong platform contract.',
      'Use advancedTools only when the primaryPath says they fit; use escapeHatches only with explicit evidence that the front-door tool is insufficient.',
    ],
  };
}
