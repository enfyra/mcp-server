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
    '### Work Flow',
    '- For a quick target/base sanity check, call `get_enfyra_api_context`; do not call broad discovery just to confirm which instance this MCP is connected to.',
    '- When the task intent is clear but the right tool path is not, call `discover_enfyra_workflows` with the intent, risk, and optional surface. Use `detail: "plan"` before writes and follow `primaryPath` in order; do not choose from the flat tool list first.',
    '- Discover before deciding. For architecture/capability questions call `discover_enfyra_system`; for DB/pk/runtime/cache context call `discover_runtime_context`; for filters/deep/sort/relation query shape call `discover_query_capabilities`. Run broad discovery tools sequentially, not in parallel.',
    '- Inspect narrowly. Use `inspect_table`, `inspect_route`, `inspect_feature`, and DB-backed runtime zone tools for the table/route/feature/surface being changed instead of loading broad metadata.',
    '- For admin UI/menu/extensions use `search_admin_extensions`; for other DB-backed artifacts use `search_runtime_zone`: search then inspect with `nextInspect.input`.',
    '- Load examples only when needed. Use `get_enfyra_examples` by category. Before extension UI, call `get_extension_theme_contract`; call `get_theme_class_reference` for exact eapp/Nuxt UI theme classes.',
    '- For server scripts, call `discover_script_contexts` before writing or reviewing handler/hook/flow/websocket/GraphQL logic.',
    '- Before mutating metadata/schema/routes/permissions/menus/packages/cache/code/extensions, call `get_enfyra_required_knowledge` and pass `globalRulesAckKey` plus required code/extension ack keys.',
    '- With non-root API tokens, call `get_permission_profile` before admin helper tools or 403 debugging.',
    '- Prefer the most specific business operation tool over raw metadata CRUD. `discover_enfyra_workflows` provides the current operation-tool map and negative-routing avoidTools.',
    '- Before saving standalone dynamic script code, call `validate_dynamic_script` or `/admin/script/validate` unless the write tool validates. For extensions, prefer atomic save tools.',
    '- Extension SFCs must use auto-injected components directly in templates, such as `<UButton>`, and must not call `resolveComponent()` for Nuxt UI/eApp components.',
    '- For existing script-backed records, use `trace_metadata_usage` then `get_script_source`; edit with `patch_script_source` or `update_script_source` so source is hash-checked and validated.',
    '- Validate behavior with `test_rest_endpoint`, `run_admin_test`, `test_flow_step`, or the route-specific tool before claiming a dynamic feature works.',
    '',
    '### Core Contracts',
    '- Tool JSON responses use `responseFormat: "json+columnar-v1"`. If rows are columnar, read values by matching `columns[index]` to `rows[n][index]`; do not guess row keys.',
    '- `query_table` needs `limit` or `all:true`; do not invent arbitrary limits. `get_all_routes`/`get_all_tables` omit limit with `search`.',
    '- Read tools are minimal by default. Pass explicit `fields`; inspect metadata before guessing. Field exclusion mode: `fields=-compiledCode`; `fields=id,-compiledCode` means all readable fields except `compiledCode`.',
    '- Mutations return ids/status. Re-read with explicit `fields` only when saved shape matters.',
    '- Mutation tools are plural-only: pass native JSON arrays, using one-item arrays for single writes.',
    '- For schema creation, do not declare `id`, `_id`, `createdAt`, or `updatedAt`; Enfyra manages them. `create_tables` strips them; `create_columns` rejects them.',
    '- Relation indexes/uniques use same-table relation `propertyName`s. Put owning relations in the same `create_tables` item, or add relation uniques later with `update_tables`.',
    '- Fields in `uniques`, including `["event","attendee"]`, must not also appear in `indexes`; uniques already index them. `create_tables` preflights the whole batch.',
    '- After `create_tables`, use `cleanupHints.recordCreateOrder` for seeding and `cleanupHints.recordDeleteOrder` for cleanup to avoid FK retries.',
    '- Dynamic repo reads use `filter`, not `where`: `@REPOS.main.find({filter})` for route main table, or `#table.find({filter})` / `@REPOS.table.find({filter})` for explicit tables.',
    '- In scripts, `find({deep})` does not auto-add projections: if you need `row.owner`, include `owner` in top-level `fields` and set `deep.owner.fields`.',
    '- `@REPOS.secure.<table>` is not portable and MCP rejects it. For explicit-table handlers use `#table`/`@REPOS.table` with exact `fields`, relation filters, auth checks, and shaped output; never return raw trusted rows.',
    '- Secure repository choice is not a substitute for authorization. Handlers and hooks still need route access, owner/tenant filters, and explicit checks before returning or mutating records.',
    '- Filters, sort helpers, counts, and aggregates over unpublished fields/private relations are sensitive data surfaces; do not expose them in user-facing endpoints.',
    '- Use `enfyra_user` as the user table. Model record links as real relations using relation `propertyName` values, not physical FK fields like `userId`, `conversationId`, `senderId`, or `memberId` in generated DB code.',
    '- Before schema/app generation, call `get_schema_design_context`; use live types and plural schema tools, not SQL guesses.',
    '- Relation design stays minimal: create owning relations first; add `inversePropertyName` only for a concrete response/UI/deep/aggregate/traversal need. Parent deep child collections are such a need.',
    '- Do not call internal/no-route system tables such as `enfyra_column` or `enfyra_session` through generic CRUD. Use table/column/relation tools and route-backed tables discovered from metadata.',
    '- Custom API paths use `api_endpoint_workflow` when a handler is needed and the model should follow returned nextSteps. Use lower-level `create_route` without `mainTableId` only when intentionally creating a route shell; `create_tables` is only for new persisted data.',
    '- For canonical table reads and RLS, preserve client-controlled query shape: do not override `@QUERY.fields`, `@QUERY.deep`, `@QUERY.sort`, `@QUERY.limit`, `@QUERY.page`, `@QUERY.meta`, `@QUERY.aggregate`, or `debugMode`. Merge only security filters into `@QUERY.filter`.',
    '- Enfyra filters are not SQL. Do not use `_like`; use `_contains`, `_starts_with`, or `_ends_with` for text matching, and call `discover_query_capabilities` when unsure.',
    '- Relation filters use relation propertyName values, not physical FK-shaped names: use `{ incident: { id: { _eq: id } } }`, not `{ incidentId: { _eq: id } }`.',
    '- `query_table` accepts native object `filter`, `deep`, and `aggregate`; always pass `limit` or `all:true`. Deep keys are relation names; MCP auto-adds missing top-level deep fields. Deep options: `fields`, `filter`, `sort`, `limit`, `page`, `deep`; never `_fields`.',
    '- For counts, prefer `count_records` or `meta=filterCount/totalCount`. Do not guess `_sum`/`_count`; call `discover_query_capabilities` before `aggregate`.',
    '- If REST exposes `isPublished=false` fields via fields/deep, use `debug_field_exposure`; treat confirmed leaks as core issues, not UI/hook fixes.',
    '- Script source is `sourceCode`; `compiledCode` is generated and may differ textually because macros expand. Do not warn about source/compiled mismatch unless validation or runtime behavior proves the compiled artifact is stale.',
    '- For user/domain errors use `@THROW`, not `throw new Error(...)`. Numeric helpers are raw HTTP messages; details must be an object/array. Semantic helpers: `notFound(resource, identifier)`, `duplicate(resource, field, value)`.',
    '- Destructive operations are preview-first. Do not pass `confirm=true` until the user explicitly approves.',
    '- Treat permission and security as the first design step for any route, handler, flow, extension, or data surface.',
    '- Admin UI `usePermissions()` and backend RoleGuard use route permissions; use `audit_route_access`/`ensure_route_access`.',
    '- Route permissions only let authenticated users reach the route after RoleGuard; handlers, hooks, or RLS must still enforce record ownership and tenant/project scope.',
    '- Operator posture: act from these contracts plus live metadata. Do not turn expected implementation details into speculative warnings; ask only for new product/design decisions or genuine ambiguity.',
    '',
    '### App Connection Defaults',
    '- Generated Nuxt/Next/SSR apps should use a same-origin proxy such as `/enfyra/**` to the Enfyra API. Browser code calls `/enfyra/login`, `/enfyra/me`, `/enfyra/logout`, and `/enfyra/<table>`; it should not store JWTs.',
    '- OAuth starts through the same proxy prefix with `redirect=<absoluteReturnUrl>` and `cookieBridgePrefix=/enfyra`. Provider setup details live in `get_enfyra_examples({ category: "oauth-setup" })`.',
    '- Socket.IO browser clients connect to the gateway namespace, e.g. `io("/chat", { path: "/socket.io", withCredentials: true })`, while the app proxies `/socket.io/**` to Enfyra `/ws/socket.io/**`.',
    '',
    '### Dynamic Script Surface',
    '- Prefer macros such as `@BODY`, `@QUERY`, `@USER`, `@REQ`, `@RES`, `@REPOS`, `@CACHE`, `@FETCH`, `@UPLOADED_FILE`, `@SOCKET`, `@ENV`, `@PKGS`, `@API`, `@THROW*`, `@FLOW*`, and `#table_name`. Call `discover_script_contexts` for exact per-surface availability.',
    '- For custom endpoints without a route main table, prefer `#table_name`; select safe fields, enforce auth before mutation/return, and return a compact shaped payload.',
    '- For script relation reads, keep `fields` and `deep` in sync: parent `fields` selects relation properties; `deep.<relation>.fields` selects related record fields.',
    '- `@SOCKET.roomSize(room)` is available in the server socket helper. Bound websocket contexts also have `reply`, `join`, `leave`, `disconnect`, `emitToCurrentRoom`, and `broadcastToRoom`; HTTP/flow contexts only have global emit helpers plus `roomSize`.',
    '',
    '### Direct HTTP Mapping',
    '- Route-backed table CRUD is REST: `GET /<table>?...`, `POST /<table>`, `PATCH /<table>/<id>`, `DELETE /<table>/<id>`. There is no `GET /<table>/<id>`; use a filtered list with `limit=1` or `find_one_record`.',
    '- REST lifecycle uses `enfyra_route.isEnabled`; use `enable_route`/`disable_route`. Public access uses `publicMethods`; otherwise use Bearer auth plus route permissions. GraphQL table data requires Bearer auth.',
    '- Admin app page/menu paths such as `/cloud/projects/:id` are UI routes, not Enfyra API endpoints unless an enabled `enfyra_route.path` with the same path exists. Use `test_rest_endpoint` only for paths that are actual API routes under `ENFYRA_API_URL`; verify page extensions through the app URL/browser or by reading the extension/menu metadata.',
    '',
    'When the user asks for details, fetch only the relevant live context or example category instead of relying on broad memorized rules.',
  ].join('\n');
}
