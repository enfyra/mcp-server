# Enfyra MCP Server v0.1.70

## Features

- Added `discover_script_contexts.runtimeTypes` as the authoritative script-visible contract for `$ctx` values, repository result envelopes, helpers, flow context, WebSocket context, and nullable runtime values.

## Bug Fixes

- Improved `src/mcp-server-entry.ts` and `src/lib/enfyra-mcp-server.ts` composition boundaries so tool registration, wrapper order, and stdio startup remain independently maintainable.
- Improved platform, schema, route, workflow, example, runtime-zone, and local-config modules by separating registrars, operations, registries, planners, adapters, and reusable TypeScript contracts.
- Improved schema mutation safety by keeping table, column, and relation writes on the single queue owned by `src/lib/schema-mutation-coordinator.ts`.
- Updated MCP contract tests with stable guided/full manifest parity checks and domain-owned source bundles.
