/**
 * MCP server `instructions` — surfaced to the host (e.g. Claude Code) for the LLM.
 * Single source of truth for API/REST/GraphQL/auth/mutation naming; README does NOT feed the model.
 * Maintain all assistant-facing rules here (and tool descriptions in index.mjs).
 */

/** GraphQL shares the same URL prefix as REST: `{ENFYRA_API_URL}/graphql` and `{ENFYRA_API_URL}/graphql-schema`. */
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
  const getList = `${base}/<table_name>`;
  const getOneById = `${base}/<table_name>?filter={"id":{"_eq":"<id>"}}&limit=1`;
  const patchOne = `${base}/<table_name>/<id>`;
  const delOne = `${base}/<table_name>/<id>`;
  const examplePost = `${base}/post`;

  return [
    '## Enfyra API endpoints (answer user questions with these rules)',
    '',
    `**API base for this session:** \`${base}\` (from env ENFYRA_API_URL, no trailing slash).`,
    `**Full URL:** base + path segment. Example for table \`post\`: \`${examplePost}\`.`,
    '',
    '### After a new table is created',
    '- Enfyra creates a route at `/{table_name}` using the table **name** from `create_table` (not the alias).',
    '- **Four REST HTTP operations** on that resource:',
    `  - **GET** \`${getList}\` — list / filter (query: filter, sort, page, limit, fields, meta).`,
    `  - **POST** \`${getList}\` — create (JSON body).`,
    `  - **PATCH** \`${patchOne}\` — update one row.`,
    `  - **DELETE** \`${delOne}\` — delete one row.`,
    `- **No** **GET** \`${base}/<table_name>/<id>\`. For one row by id use **GET** \`${getOneById}\` or MCP \`query_table\` / \`find_one_record\`.`,
    '',
    '### Auth and publishedMethods (Enfyra server)',
    '- Each route has **publishedMethods** (which HTTP verbs are “public”) and **routePermissions** (roles/users for protected access).',
    '- If the **current request method** is listed in **publishedMethods** for that route, the server allows the call **without** a Bearer token (`RoleGuard`).',
    '- Otherwise the client must send an **Authorization** header with **Bearer** JWT from login. Then the user must satisfy **routePermissions** (unless root admin).',
    '- MCP tools that use `fetchAPI` authenticate with the configured admin credentials; explain to users that **direct HTTP** calls need a token unless the route/method is published.',
    '',
    '### Resolving the real REST path',
    '- Do **not** assume `route_definition.path` always equals `table_definition.name`. Paths are data-driven (custom prefixes, renames, multiple routes per table).',
    '- When unsure of the URL path, use MCP **`get_all_routes`** (or **`get_all_metadata`**) to read each route’s **path** and **mainTable** before stating a full URL.',
    '',
    '### MongoDB vs SQL primary key',
    '- On **SQL**, filters often use **`id`**. On **MongoDB**, documents may use **`_id`** — a filter for one row might be `{"_id":{"_eq":"..."}}` instead of `id`, depending on metadata.',
    '',
    '### GraphQL (same prefix as REST / ENFYRA_API_URL)',
    `- **POST** \`${graphqlHttpUrl}\` — GraphQL endpoint (body: GraphQL query). Example with default base: \`http://localhost:3000/api/graphql\`.`,
    `- **GET** \`${graphqlSchemaUrl}\` — current schema SDL (text), e.g. \`.../api/graphql-schema\`.`,
    '- A table appears in the schema only if its route has **both** `GQL_QUERY` and `GQL_MUTATION` in `availableMethods`, `path` = `/<table_name>`, and `mainTable` set.',
    '- **Query** field = same string as `table_definition.name`. **Mutations** are literal concat: `create_`+tableName, `update_`+tableName, `delete_`+tableName (e.g. tableName `post` → `create_post`, input type `postInput`). See `generate-type-defs.ts`. No mutations if no non-PK columns for input.',
    '- **Auth:** `publishedMethods` may include `GQL_QUERY` and/or `GQL_MUTATION` **separately** — each controls anonymous access for queries vs mutations. Otherwise Bearer JWT + `routePermissions` must list the same method key (`GQL_QUERY` / `GQL_MUTATION`).',
    '- MCP does not wrap GraphQL; use REST tools or tell users the URLs above.',
    '',
    '### WebSocket (Socket.IO)',
    '- Enfyra uses **Socket.IO**. Gateways and events are stored in **`websocket_definition`** and **`websocket_event_definition`**; manage via REST (MCP `create_record`, `update_record`, `query_table` on those tables).',
    '- **Gateway** (`websocket_definition`): `path` = namespace (e.g. `/chat`), `requireAuth` (JWT in `auth.token`), `connectionHandlerScript` (runs on connect), `connectionHandlerTimeout`, `isEnabled`.',
    '- **Event** (`websocket_event_definition`): `gateway` → gateway id, `eventName` (client emits), `handlerScript`, `timeout`, `isEnabled`.',
    '- **@SOCKET** in scripts: Connection handler — `@SOCKET.emit(event, data)` → this client; `@SOCKET.to(room).emit(event, data)` → room. Event handler — `@SOCKET.emit` → broadcast namespace; `@SOCKET.send` → this client; `@SOCKET.to(room).emit` → room.',
    '- **Context**: Connection — `@BODY` = {id, ip, headers}, `@USER` if auth. Event — `@BODY` = payload, `@USER` if auth. Both have `@SOCKET`.',
    '- **Client**: `io("ORIGIN/namespace", {auth: {token: JWT}})` — e.g. `io("http://localhost:3000/chat", {auth: {token: "…"}})`. WebSocket origin usually matches HTTP host (drop `/api` for WS path). `path` in gateway = namespace.',
    '- **Workflow**: Create gateway → `create_record` on `websocket_definition`. Create event → `create_record` on `websocket_event_definition` with `gateway: {id}`. Changes auto-reload; test handlers before saving.',
    '',
    '### MCP tool → HTTP',
    `- \`get_all_metadata\` → GET \`${base}/metadata\``,
    `- \`get_table_metadata\` → GET \`${base}/metadata/<tableName>\``,
    `- \`query_table\` → GET \`${base}/<tableName>?…\` (query string from tool args)`,
    `- \`find_one_record\` (by id) → GET \`${base}/<tableName>?filter=…&limit=1\``,
    `- \`create_record\` → POST \`${base}/<tableName>\``,
    `- \`update_record\` → PATCH \`${base}/<tableName>/<id>\``,
    `- \`delete_record\` → DELETE \`${base}/<tableName>/<id>\``,
    `- Tables \`websocket_definition\`, \`websocket_event_definition\` → same REST pattern. Other admin: \`${base}/route_definition\`, \`${base}/admin/reload\`, etc.`,
    '',
    'When asked which endpoint the API calls, respond with **HTTP method + full URL** using this base. Call `get_enfyra_api_context` to confirm the resolved base if needed.',
  ].join('\n');
}
