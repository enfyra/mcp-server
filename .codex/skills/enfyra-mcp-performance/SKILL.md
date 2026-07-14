---
name: enfyra-mcp-performance
description: Diagnose or improve Enfyra MCP and generated-app performance, including tool-list/context token cost, lazy metadata reads, response compression, query/index shape, counts versus existence checks, RLS filters, websocket latency, runtime cache behavior, and performance-sensitive examples. Use for benchmark work, slow MCP interactions, excessive context, or hot Enfyra query/realtime paths.
---

# Enfyra MCP Performance

## Start with Evidence

1. Identify whether cost is MCP context, MCP output, backend query, script execution, websocket lifecycle, or app fetching.
2. Inspect the exact tool/query/route/event and live metadata before proposing an optimization.
3. Record the current request shape and deterministic metric. Do not invent benchmark numbers.
4. Change the narrowest owner and repeat the same measurement.

## MCP Context and Output

- Measure serialized `tools/list` count, characters, and tokenizer estimate for both guided and full toolsets.
- Keep guided tools limited to normal completion paths; use workflow routing and lazy builders instead of loading many specialized schemas.
- Keep startup instructions compact. Load domain knowledge and examples only when the workflow needs them.
- Use columnar formatting only when smaller than raw JSON and retain compression statistics.
- Write long source values to tmp artifacts instead of returning them inline.
- Cache only reload-domain control-plane GETs; normal table data remains uncached.

## Query and Index Shape

- Verify live table relations, indexes, permissions, and query behavior first.
- Prefer indexed relation filters over scalar mirror columns.
- Put the most selective/user-scoped field first for the actual hot query shape.
- Use existence checks for attention dots unless the product needs an exact count.
- Use `meta=filterCount` or MCP `count_records` when exact count is required.
- Preserve caller query shape when merging RLS filters into `@QUERY.filter`.
- Keep runtime ids and payload values in their original types; do not add speculative coercion.

## Realtime

- Browser sockets connect through the Enfyra app bridge, not the hidden backend.
- Keep event behavior in websocket handlers and use `@SOCKET` explicitly.
- Authenticated sockets receive `@USER` and automatically join `user_<userId>` after successful connection handling.
- Avoid a flow hop for latency-sensitive persistence unless the workflow genuinely requires background execution.

For chat-specific review and unread/index patterns, read [references/realtime-chat.md](references/realtime-chat.md) only when the task involves chat or conversation messaging.

## Verification

Run `yarn typecheck` and `yarn test`. For tool-surface changes, benchmark both guided and full `tools/list`. For backend performance claims, retest the exact route/event and state the observed evidence only.
