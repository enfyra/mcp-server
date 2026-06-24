/**
 * MCP server instructions are sent to the host model on connect.
 * Keep this small: route the model to the right discovery/example tools and
 * keep only contracts that must be known before any tool call.
 */

/** GraphQL SDL + HTTP endpoint are under the same base as REST. */
export function buildGraphqlUrls(apiBaseUrl) {
  const base = String(apiBaseUrl || '').replace(/\/$/, '');
  return {
    graphqlHttpUrl: `${base}/graphql`,
    graphqlSchemaUrl: `${base}/graphql-schema`,
  };
}

export function buildMcpServerInstructions(apiBaseUrl) {
  const base = String(apiBaseUrl || '').replace(/\/$/, '');
  const { graphqlHttpUrl, graphqlSchemaUrl } = buildGraphqlUrls(apiBaseUrl);

  return [
    '## Enfyra MCP',
    '',
    `API base for this session: \`${base}\`.`,
    `GraphQL endpoints: \`${graphqlHttpUrl}\` and \`${graphqlSchemaUrl}\`.`,
    '',
    '### Work Flow',
    '- For a quick target/base sanity check, call `get_enfyra_api_context`; do not call broad discovery just to confirm which instance this MCP is connected to.',
    '- Discover before deciding. For architecture/capability questions call `discover_enfyra_system`; for DB/pk/runtime/cache context call `discover_runtime_context`; for filters/deep/sort/relation query shape call `discover_query_capabilities`. Run broad discovery tools sequentially, not in parallel.',
    '- Inspect narrowly. Use `inspect_table`, `inspect_route`, and `inspect_feature` for the table/route/feature being changed instead of loading broad metadata.',
    '- Load examples only when needed. Before generating schemas, app connection code, OAuth, Socket.IO, handlers/hooks, flows, files, guards, permissions, or extensions, call `get_enfyra_examples` with the matching category. Before extension UI work, call `get_extension_theme_contract` and follow the app-shell/theme/security contract.',
    '- For server scripts, call `discover_script_contexts` before writing or reviewing handler/hook/flow/websocket/GraphQL logic.',
    '- With non-root API tokens, call `get_permission_profile` before relying on admin helper tools or when debugging 403s. MCP admin helpers require ordinary route permissions for static admin routes such as `/admin/script/validate`, `/admin/test/run`, `/admin/flow/trigger/:id`, and `/admin/reload/*`.',
    '- Prefer the most specific business operation tool over raw metadata CRUD: `api_endpoint_workflow` for step-by-step endpoint work; `create_api_endpoint` only when a one-shot endpoint operation is clearly safe; route tools such as `enable_route`, `disable_route`, `delete_route`, `add_route_methods`, `public_route_methods`, and `private_route_methods`; `set_table_graphql`; `ensure_guard`; permission/rule tools; websocket tools; flow tools such as `ensure_manual_flow`, `ensure_scheduled_flow`, `choose_flow_step_tool`, and fixed-type flow step tools; and extension tools such as `ensure_menu`, `ensure_page_extension`, `ensure_global_extension`, and `ensure_widget_extension`.',
    '- Before saving standalone dynamic script or extension code, call `validate_dynamic_script` or `validate_extension_code` unless the chosen ensure/update tool already validates the code.',
    '- For existing script-backed records, use `trace_metadata_usage` then `get_script_source`; edit with `patch_script_source` or `update_script_source` so source is hash-checked and validated.',
    '- Validate behavior with `test_rest_endpoint`, `run_admin_test`, `test_flow_step`, or the route-specific tool before claiming a dynamic feature works.',
    '',
    '### Core Contracts',
    '- Tool JSON responses use `responseFormat: "json+columnar-v1"`. Large arrays of objects may be encoded as `{ format: "columnar-v1", columns: [...], rows: [[...]], rowCount }` only when that is smaller than raw JSON; read each row value by matching `columns[index]` to `rows[n][index]`. Do not guess object keys inside `rows`. `compressionStats` estimates token savings and includes whether compression was applied; use it only when the user asks about savings.',
    '- `query_table`, `get_all_routes`, and `get_all_tables` require explicit intent: pass `limit` for bounded reads or `all: true` for a complete list. Do not invent arbitrary limits such as 30 or 50.',
    '- Read tools are minimal by default. Pass explicit `fields`; use metadata inspection before guessing field/relation names. Field exclusion mode exists: `fields=-compiledCode`, and `fields=id,-compiledCode` still means all readable fields except `compiledCode`.',
    '- Mutations return ids/status by default. Re-read with `find_one_record` or `query_table` and explicit `fields` when the saved row matters.',
    '- Dynamic repository reads use `filter`, not `where`: `@REPOS.table.find({ filter: {...} })`, `#table.find({ filter: {...} })`, and `exists(filter)`.',
    '- Use `enfyra_user` as the user table. Model record links as real relations using relation `propertyName` values, not physical FK fields like `userId`, `conversationId`, `senderId`, or `memberId` in generated DB code.',
    '- Relation design must stay minimal. Create the owning relation needed for writes/filters first; add `inversePropertyName` only when a concrete response, UI, deep query, aggregate sort/count, or parent-to-child traversal will use that reverse field. For schema work, explicitly review existing relations and mention which inverses are intentionally present or intentionally omitted.',
    '- Do not call internal/no-route system tables such as `enfyra_column` or `enfyra_session` through generic CRUD. Use table/column/relation tools and route-backed tables discovered from metadata.',
    '- Custom API paths use `api_endpoint_workflow` when a handler is needed and the model should follow returned nextSteps. Use lower-level `create_route` without `mainTableId` only when intentionally creating a route shell; `create_table` is only for new persisted data.',
    '- For canonical table reads and RLS, preserve client-controlled query shape: do not override `@QUERY.fields`, `@QUERY.deep`, `@QUERY.sort`, `@QUERY.limit`, `@QUERY.page`, `@QUERY.meta`, `@QUERY.aggregate`, or `debugMode`. Merge only security filters into `@QUERY.filter`.',
    '- Script source is `sourceCode`; `compiledCode` is generated and may differ textually because macros expand. Do not warn about source/compiled mismatch unless validation or runtime behavior proves the compiled artifact is stale.',
    '- For intentional user/domain errors in scripts use `@THROW400`-style helpers or `$ctx.$throw[...]`, not `throw new Error(...)`.',
    '- Destructive operations are preview-first. Do not pass `confirm=true` until the user explicitly approves.',
    '- Treat permission and security as the first design step for any route, handler, flow, extension, or data surface: decide public/private methods, authenticated route access, owner/tenant scope, and field exposure before writing feature logic.',
    '- Enfyra admin UI `usePermissions()` and backend RoleGuard both use route permissions: root admin passes; direct `allowedRoutePermissions` and role `routePermissions` grant route+method access. Use `audit_route_access` and `ensure_route_access` to inspect or grant these permissions.',
    '- Route permissions only let authenticated users reach the route after RoleGuard; handlers, hooks, or RLS must still enforce record ownership and tenant/project scope.',
    '- Operator posture: act from these contracts plus live metadata. Do not turn expected implementation details into speculative warnings; ask only for new product/design decisions or genuine ambiguity.',
    '',
    '### App Connection Defaults',
    '- Generated Nuxt/Next/SSR apps should use a same-origin proxy such as `/enfyra/**` to the Enfyra API. Browser code calls `/enfyra/login`, `/enfyra/me`, `/enfyra/logout`, and `/enfyra/<table>`; it should not store JWTs.',
    '- OAuth starts through the same proxy prefix with `redirect=<absoluteReturnUrl>` and `cookieBridgePrefix=/enfyra`. Provider setup details live in `get_enfyra_examples({ category: "oauth-setup" })`.',
    '- Socket.IO browser clients connect to the gateway namespace, e.g. `io("/chat", { path: "/socket.io", withCredentials: true })`, while the app proxies `/socket.io/**` to Enfyra `/ws/socket.io/**`.',
    '',
    '### Dynamic Script Surface',
    '- Prefer macros when available: `@BODY`, `@QUERY`, `@PARAMS`, `@USER`, `@REQ`, `@RES`, `@REPOS`, `@CACHE`, `@HELPERS`, `@FETCH`, `@STORAGE`, `@UPLOADED_FILE`, `@SOCKET`, `@TRIGGER`, `@DATA`, `@ERROR`, `@STATUS`, `@ENV`, `@PKGS`, `@LOGS`, `@SHARE`, `@API`, `@THROW*`, `@FLOW*`, and `#table_name`. Call `discover_script_contexts` for exact per-surface availability.',
    '- `@SOCKET.roomSize(room)` is available in the server socket helper. Bound websocket contexts also have `reply`, `join`, `leave`, `disconnect`, `emitToCurrentRoom`, and `broadcastToRoom`; HTTP/flow contexts only have global emit helpers plus `roomSize`.',
    '',
    '### Direct HTTP Mapping',
    '- Route-backed table CRUD is REST: `GET /<table>?...`, `POST /<table>`, `PATCH /<table>/<id>`, `DELETE /<table>/<id>`. There is no `GET /<table>/<id>`; use a filtered list with `limit=1` or `find_one_record`.',
    '- REST route lifecycle is controlled by `enfyra_route.isEnabled`: disabled routes are not registered at runtime and return 404. Use `enable_route`/`disable_route` instead of raw route PATCH. REST public access is controlled by route `publicMethods`; otherwise direct HTTP needs Bearer JWT plus route permissions. GraphQL table data requires Bearer auth and table GraphQL enablement; anonymous root/schema probes may still return a 200 without exposing table data.',
    '- Admin app page/menu paths such as `/cloud/projects/:id` are UI routes, not Enfyra API endpoints unless an enabled `enfyra_route.path` with the same path exists. Use `test_rest_endpoint` only for paths that are actual API routes under `ENFYRA_API_URL`; verify page extensions through the app URL/browser or by reading the extension/menu metadata.',
    '',
    'When the user asks for details, fetch only the relevant live context or example category instead of relying on broad memorized rules.',
  ].join('\n');
}
