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
    '- Discover before deciding. For architecture/capability questions call `discover_enfyra_system`; for DB/pk/runtime/cache context call `discover_runtime_context`; for filters/deep/sort/relation query shape call `discover_query_capabilities`. Run broad discovery tools sequentially, not in parallel.',
    '- Inspect narrowly. Use `inspect_table`, `inspect_route`, and `inspect_feature` for the table/route/feature being changed instead of loading broad metadata.',
    '- Load examples only when needed. Before generating schemas, app connection code, OAuth, Socket.IO, handlers/hooks, flows, files, guards, permissions, or extensions, call `get_enfyra_examples` with the matching category.',
    '- For server scripts, call `discover_script_contexts` before writing or reviewing handler/hook/flow/websocket/GraphQL logic.',
    '- For existing script-backed records, use `trace_metadata_usage` then `get_script_source`; edit with `patch_script_source` or `update_script_source` so source is hash-checked and validated.',
    '- Validate behavior with `test_rest_endpoint`, `run_admin_test`, `test_flow_step`, or the route-specific tool before claiming a dynamic feature works.',
    '',
    '### Core Contracts',
    '- `query_table` and `get_all_routes` require explicit intent: pass `limit` for bounded reads or `all: true` for a complete list. Do not invent arbitrary limits such as 30 or 50.',
    '- Read tools are minimal by default. Pass explicit `fields`; use metadata inspection before guessing field/relation names. Field exclusion mode exists: `fields=-compiledCode`, and `fields=id,-compiledCode` still means all readable fields except `compiledCode`.',
    '- Mutations return ids/status by default. Re-read with `find_one_record` or `query_table` and explicit `fields` when the saved row matters.',
    '- Use `enfyra_user` as the user table. Model record links as real relations using relation `propertyName` values, not physical FK fields like `userId`, `conversationId`, `senderId`, or `memberId` in generated DB code.',
    '- Do not call internal/no-route system tables such as `enfyra_column` or `enfyra_session` through generic CRUD. Use table/column/relation tools and route-backed tables discovered from metadata.',
    '- Custom API paths use `create_route` without `mainTableId`; `create_table` is only for new persisted data.',
    '- For canonical table reads and RLS, preserve client-controlled query shape: do not override `@QUERY.fields`, `@QUERY.deep`, `@QUERY.sort`, `@QUERY.limit`, `@QUERY.page`, `@QUERY.meta`, `@QUERY.aggregate`, or `debugMode`. Merge only security filters into `@QUERY.filter`.',
    '- Script source is `sourceCode`; `compiledCode` is generated and may differ textually because macros expand. Do not warn about source/compiled mismatch unless validation or runtime behavior proves the compiled artifact is stale.',
    '- For intentional user/domain errors in scripts use `@THROW400`-style helpers or `$ctx.$throw[...]`, not `throw new Error(...)`.',
    '- Destructive operations are preview-first. Do not pass `confirm=true` until the user explicitly approves.',
    '- Operator posture: act from these contracts plus live metadata. Do not turn expected implementation details into speculative warnings; ask only for new product/design decisions or genuine ambiguity.',
    '',
    '### App Connection Defaults',
    '- Generated Nuxt/Next/SSR apps should use a same-origin proxy such as `/enfyra/**` to the Enfyra API. Browser code calls `/enfyra/login`, `/enfyra/me`, `/enfyra/logout`, and `/enfyra/<table>`; it should not store JWTs.',
    '- OAuth starts through the same proxy prefix with `redirect=<absoluteReturnUrl>` and `cookieBridgePrefix=/enfyra`. OAuth setup details live in `get_enfyra_examples({ category: "ssr-app-auth" })`.',
    '- Socket.IO browser clients connect to the gateway namespace, e.g. `io("/chat", { path: "/socket.io", withCredentials: true })`, while the app proxies `/socket.io/**` to Enfyra `/ws/socket.io/**`.',
    '',
    '### Dynamic Script Surface',
    '- Prefer macros when available: `@BODY`, `@QUERY`, `@PARAMS`, `@USER`, `@REQ`, `@RES`, `@REPOS`, `@CACHE`, `@HELPERS`, `@FETCH`, `@STORAGE`, `@UPLOADED_FILE`, `@SOCKET`, `@TRIGGER`, `@DATA`, `@ERROR`, `@STATUS`, `@ENV`, `@PKGS`, `@LOGS`, `@SHARE`, `@API`, `@THROW*`, `@FLOW*`, and `#table_name`. Call `discover_script_contexts` for exact per-surface availability.',
    '- `@SOCKET.roomSize(room)` is available in the server socket helper. Bound websocket contexts also have `reply`, `join`, `leave`, `disconnect`, `emitToCurrentRoom`, and `broadcastToRoom`; HTTP/flow contexts only have global emit helpers plus `roomSize`.',
    '',
    '### Direct HTTP Mapping',
    '- Route-backed table CRUD is REST: `GET /<table>?...`, `POST /<table>`, `PATCH /<table>/<id>`, `DELETE /<table>/<id>`. There is no `GET /<table>/<id>`; use a filtered list with `limit=1` or `find_one_record`.',
    '- REST public access is controlled by route `publicMethods`; otherwise direct HTTP needs Bearer JWT plus route permissions. GraphQL requires Bearer auth and table GraphQL enablement.',
    '',
    'When the user asks for details, fetch only the relevant live context or example category instead of relying on broad memorized rules.',
  ].join('\n');
}
