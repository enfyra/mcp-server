/** GraphQL SDL + HTTP endpoint are under the same base as REST. */
export function buildGraphqlUrls(apiBaseUrl) {
  const base = String(apiBaseUrl || '').replace(/\/$/, '');
  return {
    graphqlHttpUrl: `${base}/graphql`,
    graphqlSchemaUrl: `${base}/graphql-schema`,
  };
}

type McpInstructionOptions = {
  toolsetSummary?: string | null;
};

export function buildMcpServerInstructions(apiBaseUrl, options: McpInstructionOptions = {}) {
  const base = String(apiBaseUrl || '').replace(/\/$/, '');
  const { graphqlHttpUrl, graphqlSchemaUrl } = buildGraphqlUrls(apiBaseUrl);
  const toolsetSummary = options?.toolsetSummary || null;

  return [
    '## Enfyra MCP',
    '',
    `API base for this session: \`${base}\`.`,
    `GraphQL endpoints: \`${graphqlHttpUrl}\` and \`${graphqlSchemaUrl}\`.`,
    ...(toolsetSummary ? ['', toolsetSummary] : []),
    '',
    '### Operating Model',
    '- This instruction set is multi-model compatible: keep startup context small, then load exact workflow, examples, and required knowledge on demand.',
    '- For target sanity checks, call `get_enfyra_api_context`; do not load broad metadata only to confirm the API base.',
    '- When the goal is clear but the tool path is not, call `discover_enfyra_workflows` with intent/risk/surface. Use `detail: "plan"` before writes, follow `primaryPath`, and treat `avoidTools` as hard negative-routing boundaries.',
    '- Discover before deciding, then inspect narrowly. Use `inspect_table`, `inspect_route`, `inspect_feature`, `search_admin_extensions`, or `search_runtime_zone` for the exact table/route/feature/runtime artifact. Run broad discovery tools sequentially, not in parallel.',
    '- Load examples only when needed with `get_enfyra_examples`. For OAuth use `get_enfyra_examples({ category: "oauth-setup" })`. For extension UI, call `get_extension_theme_contract` before writing or reviewing UI, use `build_extension_*` tools for high-contract components such as drawers, modals, page shell headers/actions, permission gates, empty states, resource lists, FormEditor, Widget, menu/account panel registries, tabs, and upload modals, and call `get_theme_class_reference` only when exact classes are needed.',
    '- Prefer the most specific business operation tool over raw metadata CRUD.',
    '- Before any write, call `get_enfyra_required_knowledge({ scope })` with the right scope and pass returned ack keys into write tools. Choose scope by task domain:',
    '  • `schema` — table, column, relation, record CRUD, route permission, guard, field permission, column rule, cache reload, GraphQL enablement, log debug.',
    '  • `dynamic-code` — handler, pre-hook, post-hook, flow step script, websocket event, GraphQL resolver, bootstrap script, any sourceCode/source edit.',
    '  • `extension` — admin UI extension, menu, shell notification, account panel, page/widget/global extension, any enfyra_extension.code edit.',
    '  • `flow` — creating or updating a flow and its steps.',
    '  • Omit scope only when the task genuinely spans multiple domains (rare).',
    '- After reading knowledge, pass `globalRulesAckKey` into write tools; dynamic server code also needs `knowledgeAckKey` from the same response; extension code also needs `extensionKnowledgeAckKey`.',
    '- With non-root API tokens, call `get_permission_profile` before admin helper tools or 403 debugging. Admin helpers depend on route permissions such as `/admin/script/validate`.',
    '- Validate before claiming success: `validate_dynamic_script`, `validate_extension_code`, `test_rest_endpoint`, `run_admin_test`, `test_flow_step`, or the matching route-specific verifier.',
    '',
    '### Read And Query Rules',
    '- Tool JSON responses use `responseFormat: "json+columnar-v1"`; if rows are columnar, map values by `columns[index]`.',
    '- `query_table` requires `limit` or `all:true`; do not invent arbitrary limits. `get_all_routes`/`get_all_tables` may omit limit with `search` because locator searches are bounded.',
    '- Pass explicit `fields` after inspecting metadata. Field exclusion mode: `fields=-compiledCode`; `fields=id,-compiledCode` returns all readable fields except `compiledCode`.',
    '- `query_table` accepts native object `filter`, `deep`, and `aggregate`. Deep keys are relation names; inside deep use `fields`, `filter`, `sort`, `limit`, `page`, and `deep`.',
    '- Enfyra filters are not SQL. Do not use `_like`; use `_contains`, `_starts_with`, or `_ends_with`, and call `discover_query_capabilities` before non-trivial deep/sort/aggregate work.',
    '- Relation filters use relation `propertyName` values, not physical FK-shaped names: use `{ incident: { id: { _eq: id } } }`, not `{ incidentId: { _eq: id } }`.',
    '- For counts, prefer `count_records` or `meta=filterCount/totalCount`; do not guess `_sum` or `_count` aggregate syntax.',
    '- If REST exposes `isPublished=false` fields via fields/deep/dotted projection, run `debug_field_exposure`; treat confirmed leaks as Enfyra core issues, not UI or route-local hook fixes.',
    '',
    '### Mutation And Schema Rules',
    '- Mutation tools are plural-only and use native JSON arrays; pass one item in the array for a single create/update/delete.',
    '- Destructive operations are preview-first. Do not pass `confirm=true` until the user explicitly approves.',
    '- Before schema/app generation, call `get_schema_design_context`; use live column types and plural schema tools, not SQL guesses.',
    '- For schema creation, do not declare `id`, `_id`, `createdAt`, or `updatedAt`; Enfyra manages them. `create_tables` preflights the whole batch.',
    '- Use Enfyra relations, not physical FK fields like `userId`, `conversationId`, `senderId`, or `memberId`. Relation design stays minimal; Parent deep child collections are such a need for `inversePropertyName`.',
    '- Do not CRUD internal/no-route tables such as `enfyra_column` or `enfyra_session`; use schema/platform tools and route-backed tables discovered from metadata.',
    '- For custom API behavior, use `api_endpoint_workflow`; `create_tables` creates persisted data models, not behavior endpoints.',
    '',
    '### Security And Dynamic Code',
    '- Treat permission and security as the first design step for every route, handler, flow, extension, websocket, or data surface.',
    '- Route permissions only pass authenticated users through RoleGuard; handlers, hooks, RLS, and scripts must still enforce owner/tenant/project scope.',
    '- For canonical table reads and RLS, do not override `@QUERY.fields`, `@QUERY.deep`, `@QUERY.sort`, `@QUERY.limit`, `@QUERY.page`, `@QUERY.meta`, `@QUERY.aggregate`, or `debugMode`. Merge only security filters into `@QUERY.filter`.',
    '- For server scripts, call `discover_script_contexts` before writing/reviewing handlers, hooks, flow steps, websocket scripts, GraphQL, or bootstrap scripts.',
    '- Dynamic repo reads use `filter`, not `where`. In scripts, `find({deep})` does not auto-add projections: include relation names in top-level `fields` and set nested `deep.<relation>.fields`.',
    '- Prefer macros such as `@BODY`, `@QUERY`, `@PARAMS`, `@USER`, `@REQ`, `@RES`, `@REPOS`, `@CACHE`, `@HELPERS`, `@FETCH`, `@STORAGE`, `@UPLOADED_FILE`, `@SOCKET`, `@ENV`, `@PKGS`, `@API`, `@THROW*`, `@FLOW*`, and `#table_name`. Call `discover_script_contexts` for exact per-surface availability.',
    '- Script source is `sourceCode`; `compiledCode` is generated and may differ textually because macros expand. Do not turn expected implementation details into speculative warnings.',
    '- For user/domain errors use `@THROW`, not `throw new Error(...)`. Numeric helpers are raw HTTP messages and details must be an object/array; semantic helpers include `notFound(resource, identifier)` and `duplicate(resource, field, value)`.',
    '- `@SOCKET.roomSize(room)` is available in the server socket helper. Bound websocket contexts also have `reply`, `join`, `leave`, `disconnect`, `emitToCurrentRoom`, and `broadcastToRoom`; HTTP/flow contexts only have global emit helpers plus `roomSize`.',
    '',
    '### App And Route Defaults',
    '- Generated Nuxt/Next/SSR apps should use a same-origin proxy such as `/enfyra/**`; browser code calls `/enfyra/login`, `/enfyra/me`, `/enfyra/logout`, and `/enfyra/<table>` and should not store JWTs.',
    '- OAuth starts through the same proxy prefix with `redirect=<absoluteReturnUrl>` and `cookieBridgePrefix=/enfyra`.',
    '- Socket.IO browser clients connect to the gateway namespace with the app proxying `/socket.io/**` to Enfyra `/ws/socket.io/**`.',
    '- Route-backed table CRUD is REST: `GET /<table>?...`, `POST /<table>`, `PATCH /<table>/<id>`, `DELETE /<table>/<id>`. There is no dynamic `GET /<table>/<id>`; use filter + `limit=1` or `find_one_record`.',
    '- REST lifecycle uses `enfyra_route.isEnabled`; use `enable_route`/`disable_route`. Public REST uses `publicMethods`; otherwise use Bearer auth plus route permissions. GraphQL table data requires Bearer auth.',
    '- Admin app page/menu paths are UI routes, not API endpoints unless an enabled `enfyra_route.path` exists. Use `test_rest_endpoint` only for actual API routes under `ENFYRA_API_URL`.',
    '',
    'When the user asks for details, fetch only the relevant live context or example category instead of relying on broad memorized rules.',
  ].join('\n');
}
