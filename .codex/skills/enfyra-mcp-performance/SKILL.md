# Enfyra MCP Performance And Debug Mode

Use this skill when designing, reviewing, or debugging Enfyra apps through MCP where performance, read/write shape, indexes, websocket latency, RLS filters, or query correctness matter.

## Rules
- Verify capability with live metadata before claiming performance behavior. Use `inspect_table`, `inspect_route`, `discover_query_capabilities`, and `discover_runtime_context` first.
- Treat metadata as lazy. Use `GET /metadata` only for `dbType` and `enfyraVersion`, use `GET /metadata/:name` for one schema, and use the lightweight `enfyra_table` catalog for table discovery. Only explicit broad schema search may fetch multiple table schemas, with bounded concurrency and runtime-cache reuse.
- Prefer indexed relation filters over scalar mirror columns. Relation property names can be used in `indexes` and `uniques`; Enfyra resolves them to physical FK columns.
- For hot read paths, design indexes with the most selective/user-scoped field first. Examples: `["member","is_read","conversation"]` for unread lookup and `["conversation","member","is_read"]` for mark-read updates.
- Use existence checks for UI dots and badges unless the user explicitly needs exact counts. Avoid count queries on every conversation row.
- Use `meta=filterCount` or MCP `count_records` only when count is the product requirement.
- For RLS hooks, mutate `@QUERY.filter` and preserve existing user filters with `_and`. `@QUERY.filter` is already `{}` when omitted.
- For dynamic scripts, keep runtime values in their original type. Do not wrap ids or payload values in `String(...)`, `Number(...)`, or `Boolean(...)`.
- For websocket apps, connect browsers through the Enfyra app/Nuxt bridge, not the hidden backend. Event handlers should be script-owned and use `@SOCKET` explicitly.
- Authenticated websocket gateways load `user_definition` once and expose it as `@USER`; do not ask clients to send their own `senderId`.
- Enfyra automatically joins authenticated sockets to `user_<userId>` after the connection script succeeds. App scripts should use this for `emitToUser` and should not re-join that room manually.

## Debug Workflow
1. Inspect the table schema, relations, indexes, and route permissions before changing code.
2. Reproduce with the smallest real request or Socket.IO event. Prefer `test_rest_endpoint` or `run_admin_test` when available.
3. If the problem is performance, state the exact query shape and expected index. Add or update `indexes` on `table_definition` through `create_table` or `update_table`.
4. Reload metadata/cache after schema or script changes when the tool does not do it automatically.
5. Retest the exact route/event and compare behavior before/after. Do not invent benchmark numbers.

## Chat App Review Checklist
- Confirm REST and Socket.IO both go through the app origin. REST uses the app proxy prefix; Socket.IO uses `/ws/<namespace>` and `path: "/ws/socket.io"` when the app bridge exposes that path.
- Confirm browser code never stores or forwards custom JWT cookies when the Enfyra app/proxy already manages cookies.
- Confirm `chat:join` queries `chat_conversation` visible to `@USER`, then joins `conversation:<id>`. Do not join rooms from raw membership member ids.
- Confirm `chat:message` uses `@SOCKET.broadcastToRoom("conversation:" + conversationId, ...)` and persists with `@REPOS` inside the event script. Do not add a flow just to save chat messages.
- Confirm new DM UX creates no empty conversation. A draft opens first; the first message calls a creation event that creates the conversation and message together.
- Confirm route-level RLS is server-side: pre-hooks merge membership filters into `@QUERY.filter` with `_and`; the client must not fetch all conversations then filter locally.
- Confirm conversation titles are computed from visible memberships from the current user's perspective. DM title should be the other person, not the current user.
- Confirm message history uses cursor pagination, newest messages first from the API then reversed for display; loading older messages preserves scroll.
- Confirm disconnect state disables chat input and shows a visible retry banner immediately.
- Confirm typing state is room-scoped, user-aware, and remains active while the input has text, even if the user pauses typing.

## Chat Read/Unread Pattern
- Use a join table, e.g. `chat_message_read`, with:
  - `message` relation to `chat_message`
  - `conversation` relation to `chat_conversation`
  - `member` relation to `user_definition`
  - `is_read` boolean
  - `read_at` date nullable
- Add unique `["message","member"]`.
- Add indexes `["member","is_read","conversation"]` and `["conversation","member","is_read"]`.
- On message create, create read rows for conversation members. Sender rows start as read; other member rows start unread.
- On conversation open/read, update unread rows for `@USER` in that conversation to read.
- UI unread dots should check whether an unread row exists; count only when requested.
