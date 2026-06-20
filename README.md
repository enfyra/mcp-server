# Enfyra MCP Server

Manage Enfyra instances from MCP-compatible coding tools such as **Codex**, **Claude Code**, **Cursor**, MCP Inspector, and other STDIO MCP hosts.

This package is the MCP bridge only. Assistant rules, schema behavior, dynamic script guidance, and examples are served through the MCP server itself from `src/lib/mcp-instructions.js`, `src/lib/mcp-examples.js`, and tool descriptions in `src/mcp-server-entry.mjs`.

## Quick Start

From your project root:

```bash
npx @enfyra/mcp-server config
```

The config command writes project config for Codex, Claude Code, and Cursor. It preserves other MCP servers and replaces only the `enfyra` entry.

Interactive setup asks for your Enfyra app/admin URL, then guides you to the token page when needed and asks for `ENFYRA_API_TOKEN`.

```bash
# Non-interactive, all supported clients
npx @enfyra/mcp-server config --yes \
  --app-url http://localhost:3000 \
  -t efy_pat_your-token

# One or more clients
npx @enfyra/mcp-server config --codex
npx @enfyra/mcp-server config --cursor --claude-code
```

Equivalent in this repo:

```bash
yarn mcp:config
```

## Choose A Client

| Client | Command | Project config |
|--------|---------|----------------|
| Codex | `npx @enfyra/mcp-server config --codex` | `.codex/config.toml` |
| Claude Code | `npx @enfyra/mcp-server config --claude-code` | `.mcp.json` |
| Cursor | `npx @enfyra/mcp-server config --cursor` | `.cursor/mcp.json` |
| MCP Inspector / other hosts | Paste the shared STDIO config below | Host-specific `mcpServers` config |

<details>
<summary><strong>Codex setup</strong></summary>

```bash
npx @enfyra/mcp-server config --codex
```

Generated project config:

```toml
[mcp_servers.enfyra]
command = "npx"
args = ["-y", "@enfyra/mcp-server"]

[mcp_servers.enfyra.env]
ENFYRA_API_URL = "http://localhost:3000/api"
ENFYRA_API_TOKEN = "efy_pat_your-token"
```

The writer replaces only `[mcp_servers.enfyra]` and `[mcp_servers.enfyra.env]`. Other Codex config and other MCP servers are preserved.

Open this folder in a new Codex session and approve the project MCP config if prompted. The setup command only writes `.codex/config.toml`; it does not ship or create `.codex/skills`.

Official reference: [Codex config](https://developers.openai.com/codex/config-reference).

</details>

<details>
<summary><strong>Claude Code setup</strong></summary>

```bash
npx @enfyra/mcp-server config --claude-code
```

Project config is written to `.mcp.json`. MCP server definitions do not belong in `.claude/settings.json`.

Claude Code also supports its own CLI:

```bash
claude mcp add --transport stdio --scope project \
  --env ENFYRA_API_URL=http://localhost:3000/api \
  --env ENFYRA_API_TOKEN=efy_pat_your-token \
  enfyra -- npx -y @enfyra/mcp-server
```

Scope precedence when the same server name exists in multiple places is local, then project, then user. Project-scoped `.mcp.json` may require approval in Claude Code.

Official references: [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp) and [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings).

</details>

<details>
<summary><strong>Cursor setup</strong></summary>

```bash
npx @enfyra/mcp-server config --cursor
```

Cursor project config is written to `.cursor/mcp.json`. Global config is `~/.cursor/mcp.json` on macOS/Linux or `%USERPROFILE%\.cursor\mcp.json` on Windows.

After edits, restart Cursor or reload MCP, then confirm the server under Cursor MCP settings. Use MCP logs if the server fails to start.

Official reference: [Cursor MCP](https://cursor.com/docs/context/mcp).

</details>

<details>
<summary><strong>Other MCP hosts and MCP Inspector</strong></summary>

Use the shared STDIO config with any host that accepts an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "enfyra": {
      "command": "npx",
      "args": ["-y", "@enfyra/mcp-server"],
      "env": {
        "ENFYRA_API_URL": "http://localhost:3000/api",
        "ENFYRA_API_TOKEN": "efy_pat_your-token"
      }
    }
  }
}
```

`ENFYRA_API_TOKEN` is a programmatic token from the Enfyra admin UI `/me`. It is not a JWT; the MCP server exchanges it through `POST {ENFYRA_API_URL}/auth/token/exchange` before calling Enfyra REST APIs.

Official reference: [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector).

</details>

## Config Command

```bash
npx @enfyra/mcp-server config [options]
```

| Option | Use |
|--------|-----|
| `--app-url` | Set the Enfyra app/admin URL |
| `--api-token`, `-t` | Set `ENFYRA_API_TOKEN` |
| `--yes` | Non-interactive mode for CI/scripts |
| `--global` | Write global/user config instead of project config |
| `--reconfig` | Prompt for target clients again and replace the existing `enfyra` entry |
| `--codex` | Write Codex config |
| `--claude-code`, `--claude` | Write Claude Code config |
| `--cursor` | Write Cursor config |
| `-h`, `--help` | Show CLI help |

Without a target flag, interactive mode asks which client to configure. Non-interactive mode defaults to all supported clients.

## Environment

| Variable | Description | Default |
|----------|-------------|---------|
| `ENFYRA_APP_URL` | App/admin URL used by setup | `http://localhost:3000` |
| `ENFYRA_API_URL` | Runtime API base written into MCP client config | Generated by setup |
| `ENFYRA_API_TOKEN` | Programmatic token from the Enfyra admin UI `/me` | Required |

For normal apps and demos, enter the app/admin URL such as `http://localhost:3000` or `https://demo.enfyra.io`. Treat the direct Enfyra backend host as private infrastructure unless you are debugging Enfyra core/server internals.

## Common Examples

Use `get_enfyra_examples` from the MCP tool list when asking an LLM to generate implementation patterns. It returns focused examples for:

- SSR app auth and proxy setup
- schema, columns, relations, indexes, and validation
- query filters, sorting, fields, deep relations, and aggregates
- handlers, hooks, permissions, and RLS
- websocket gateways and events
- flows
- files and storage
- Enfyra admin extensions

## Runtime Safety

The MCP server includes safety guards for LLM callers:

- Generic record mutations validate fields against live metadata.
- Script-backed records validate `sourceCode` through `/admin/script/validate` before saving.
- `validate_dynamic_script` checks handler, hook, flow, websocket, GraphQL, and bootstrap script source without saving.
- `validate_extension_code` checks Enfyra admin extension code through `/enfyra_extension/preview` without saving.
- `compiledCode` is generated from `sourceCode` and may differ textually because macros are expanded; the MCP server never accepts hand-written `compiledCode`.
- Relation tools reject physical FK/junction names.
- Generated code should use relation property names such as `conversation`, `sender`, and `member` instead of physical FK fields such as `conversationId`, `senderId`, or `memberId`.
- Custom route tools reject `mainTableId` unless the route is the canonical table route.
- Platform operation tools such as `create_api_endpoint`, `set_route_public_methods`, `set_table_graphql`, `ensure_guard`, `ensure_field_permission`, `ensure_column_rule`, `ensure_websocket_event`, `ensure_flow_step`, and `ensure_menu_extension_page` resolve metadata ids and validate code before saving.
- Schema changes are serialized.
- Destructive deletes return a preview before requiring `confirm=true`.

## Query Notes

Use explicit `fields` in read tools. Include mode is the default, such as `fields=id,email`. Any excluded field switches that scope to exclude mode: `fields=-compiledCode` returns all readable fields except `compiledCode`, and `fields=id,-compiledCode` still means all except `compiledCode`. Dotted exclusions such as `fields=-owner.avatar` work for relation fields when the relation exists in metadata. Every list/query call must pass either `limit` for a bounded page or `all: true` for a complete list. When a caller needs every matching row, pass `all: true` to `query_table` or `get_all_routes`; the tool sends REST `limit=0` instead of making the model choose an arbitrary page size like 30 or 50.

## Enfyra URL Pattern

Generated apps should use a same-origin proxy:

```js
export default defineNuxtConfig({
  routeRules: {
    "/enfyra/**": {
      proxy: {
        to: `${process.env.ENFYRA_API_URL}/**`,
        fetchOptions: { redirect: "manual" }
      }
    }
  }
})
```

Browser code then calls:

```text
POST /enfyra/login
GET  /enfyra/me
POST /enfyra/logout
GET  /enfyra/<table>
```

Do not create custom login/logout/me routes that manually set Enfyra token cookies when the proxy is enough.

## Tool Summary

The MCP server exposes tools for metadata discovery, examples, query/CRUD, method management, route access audit/grant, routes, handlers, hooks, tables, columns, relations, cache reloads, logs, users, roles, packages, menus, extensions, scripts, flows, websocket, files, and `get_enfyra_api_context`.

For authenticated route access, use `audit_route_access` before changing permissions and `ensure_route_access` to grant access by route path plus role/user. For production script edits, use `trace_metadata_usage`, `get_script_source`, and `patch_script_source` so changes are targeted, hash-checked, and validated.

## Security

API calls use exchanged JWTs and Enfyra permissions are still enforced server-side. Keep `ENFYRA_API_TOKEN` out of committed config unless the project intentionally uses environment interpolation or another secret-management path.
