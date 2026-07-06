# Enfyra MCP Server

Manage Enfyra instances from MCP-compatible coding tools such as **Codex**, **Claude Code**, **Cursor**, **VS Code / GitHub Copilot**, **Google Antigravity**, MCP Inspector, and other STDIO MCP hosts.

This package is the MCP bridge only. Assistant rules, schema behavior, dynamic script guidance, and examples are served through the MCP server itself from TypeScript source in `src/lib/mcp-instructions.ts`, `src/lib/mcp-examples.ts`, and tool descriptions in `src/mcp-server-entry.ts`. Published packages run the compiled `dist/index.js` entry.

## Quick Start

From your project root:

```bash
npx @enfyra/mcp-server@latest config
```

The config command writes project config for Codex, Claude Code, Cursor, VS Code / GitHub Copilot, and Google Antigravity. It preserves other MCP servers and replaces only the `enfyra` entry.

Interactive setup asks for your Enfyra app/admin URL, then guides you to the token page when needed and asks for `ENFYRA_API_TOKEN`.

Generated MCP host configs run `npx -y @enfyra/mcp-server@latest` so every host start resolves the current npm `latest` dist-tag published by Enfyra.

```bash
# Non-interactive, all supported clients
npx @enfyra/mcp-server@latest config --yes \
  --app-url http://localhost:3000 \
  -t efy_pat_your-token

# One or more clients
npx @enfyra/mcp-server@latest config --codex
npx @enfyra/mcp-server@latest config --cursor --claude-code
npx @enfyra/mcp-server@latest config --vscode
npx @enfyra/mcp-server@latest config --antigravity
```

Equivalent in this repo:

```bash
yarn build
yarn mcp:config
```

## Development

This repo uses Yarn 4 through Corepack and TypeScript source compiled to `dist`.

```bash
yarn typecheck
yarn build
yarn test
```

`yarn test` builds first and then runs Node tests against `dist` while static source assertions read `src/**/*.ts`.

## Choose A Client

| Client | Command | Project config |
|--------|---------|----------------|
| Codex | `npx @enfyra/mcp-server@latest config --codex` | `.codex/config.toml` |
| Claude Code | `npx @enfyra/mcp-server@latest config --claude-code` | `.mcp.json` |
| Cursor | `npx @enfyra/mcp-server@latest config --cursor` | `.cursor/mcp.json` |
| VS Code / GitHub Copilot | `npx @enfyra/mcp-server@latest config --vscode` | `.vscode/mcp.json` |
| Google Antigravity | `npx @enfyra/mcp-server@latest config --antigravity` | `.agents/mcp_config.json` |
| MCP Inspector / other project-scoped hosts | Paste the shared STDIO config below | Host-specific project config |

<details>
<summary><strong>Codex setup</strong></summary>

```bash
npx @enfyra/mcp-server@latest config --codex
```

Generated project config:

```toml
[mcp_servers.enfyra]
command = "npx"
args = ["-y", "@enfyra/mcp-server@latest"]

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
npx @enfyra/mcp-server@latest config --claude-code
```

Project config is written to `.mcp.json`. MCP server definitions do not belong in `.claude/settings.json`.

Claude Code also supports its own CLI:

```bash
claude mcp add --transport stdio --scope project \
  --env ENFYRA_API_URL=http://localhost:3000/api \
  --env ENFYRA_API_TOKEN=efy_pat_your-token \
  enfyra -- npx -y @enfyra/mcp-server@latest
```

Scope precedence when the same server name exists in multiple places is local, then project, then user. Project-scoped `.mcp.json` may require approval in Claude Code.

Official references: [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp) and [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings).

</details>

<details>
<summary><strong>Cursor setup</strong></summary>

```bash
npx @enfyra/mcp-server@latest config --cursor
```

Cursor project config is written to `.cursor/mcp.json`. Global config is `~/.cursor/mcp.json` on macOS/Linux or `%USERPROFILE%\.cursor\mcp.json` on Windows.

After edits, restart Cursor or reload MCP, then confirm the server under Cursor MCP settings. Use MCP logs if the server fails to start.

Official reference: [Cursor MCP](https://cursor.com/docs/context/mcp).

</details>

<details>
<summary><strong>VS Code / GitHub Copilot setup</strong></summary>

```bash
npx @enfyra/mcp-server@latest config --vscode
```

VS Code workspace config is written to `.vscode/mcp.json`:

```json
{
  "servers": {
    "enfyra": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@enfyra/mcp-server@latest"],
      "env": {
        "ENFYRA_API_URL": "http://localhost:3000/api",
        "ENFYRA_API_TOKEN": "efy_pat_your-token"
      }
    }
  }
}
```

Use the VS Code command `MCP: List Servers` to inspect or start the server after setup. This is a workspace config, so it stays tied to the current project.

Official references: [VS Code MCP servers](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) and [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

</details>

<details>
<summary><strong>Google Antigravity setup</strong></summary>

```bash
npx @enfyra/mcp-server@latest config --antigravity
```

Antigravity project config is written to `.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "enfyra": {
      "command": "npx",
      "args": ["-y", "@enfyra/mcp-server@latest"],
      "env": {
        "ENFYRA_API_URL": "http://localhost:3000/api",
        "ENFYRA_API_TOKEN": "efy_pat_your-token"
      }
    }
  }
}
```

Antigravity also documents a shared user config at `~/.gemini/config/mcp_config.json`; this helper intentionally writes the project-local `.agents/mcp_config.json` file so Enfyra URL and token stay scoped to the current workspace.

Official reference: [Antigravity MCP](https://antigravity.google/docs/mcp).

</details>

<details>
<summary><strong>Other MCP hosts and MCP Inspector</strong></summary>

Use the shared STDIO config with any project-scoped host that accepts an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "enfyra": {
      "command": "npx",
      "args": ["-y", "@enfyra/mcp-server@latest"],
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
npx @enfyra/mcp-server@latest config [options]
```

| Option | Use |
|--------|-----|
| `--app-url` | Set the Enfyra app/admin URL |
| `--api-token`, `-t` | Set `ENFYRA_API_TOKEN` |
| `--yes` | Non-interactive mode for CI/scripts |
| `--reconfig` | Prompt for target clients again and replace the existing `enfyra` entry |
| `--codex` | Write Codex config |
| `--claude-code`, `--claude` | Write Claude Code config |
| `--cursor` | Write Cursor config |
| `--vscode`, `--copilot` | Write VS Code / GitHub Copilot config |
| `--antigravity` | Write Google Antigravity config |
| `-h`, `--help` | Show CLI help |

Without a target flag, interactive mode asks which client to configure. Non-interactive mode defaults to all supported clients.

## Environment

| Variable | Description | Default |
|----------|-------------|---------|
| `ENFYRA_APP_URL` | App/admin URL used by setup | `http://localhost:3000` |
| `ENFYRA_API_URL` | Runtime API base written into MCP client config | Generated by setup |
| `ENFYRA_API_TOKEN` | Programmatic token from the Enfyra admin UI `/me` | Required |
| `ENFYRA_MCP_TOOLSET` | Tool visibility mode: `guided` for curated default tools, or `full` for every low-level escape hatch | `guided` |

For normal apps and demos, enter the app/admin URL such as `http://localhost:3000` or `https://demo.enfyra.io`. Treat the direct Enfyra backend host as private infrastructure unless you are debugging Enfyra core/server internals.

## Common Examples

Use `get_enfyra_examples` from the MCP tool list when asking an LLM to generate implementation patterns. It returns focused examples for:

- SSR app auth and proxy setup
- OAuth provider setup
- schema, columns, relations, indexes, and validation
- query filters, sorting, fields, deep relations, and aggregates
- handlers, hooks, permissions, and RLS
- websocket gateways and events
- flows
- files and storage
- Enfyra admin extensions

Use `discover_enfyra_workflows` when an LLM knows the goal but may not know the right Enfyra tool path. It returns progressive-disclosure workflow matches with first tools, required acknowledgements, verification tools, relevant example categories, and `avoidTools` boundaries that prevent near-correct but unsafe tool choices.

Use `get_enfyra_required_knowledge` before asking an LLM to mutate metadata, schema, routes, permissions, menus, packages, cache state, dynamic server code, or Enfyra extension code. It returns global rules plus acknowledgement keys that write tools verify before saving. Dynamic server code also requires the dynamic-code acknowledgement key, and extension code also requires the extension acknowledgement key.

## Runtime Safety

The MCP server includes safety guards for LLM callers:

- Generic record mutations validate fields against live metadata.
- Write tools require `get_enfyra_required_knowledge` acknowledgement before mutating Enfyra state. Discovery, validation, and preview tools remain available without the acknowledgement so agents can read and plan first. If the acknowledgement is missing, the tool error tells the caller to read `get_enfyra_required_knowledge` and pass the required key.
- Script-backed records validate `sourceCode` through `/admin/script/validate` before saving.
- `validate_dynamic_script` checks handler, hook, flow, websocket, GraphQL, and bootstrap script source without saving.
- `validate_extension_code` locally rejects common extension component-resolution mistakes, such as `resolveComponent()` or lowercase auto-injected component tags like `<ubutton>`, then checks Enfyra admin extension code through `/enfyra_extension/preview` without saving.
- Dynamic script guidance distinguishes secure repositories (`@REPOS.main`, `@REPOS.secure.<table>`) from trusted internal repositories (`@REPOS.<table>`), and tells agents not to return raw trusted records to users.
- `compiledCode` is generated from `sourceCode` and may differ textually because macros are expanded; the MCP server never accepts hand-written `compiledCode`.
- Long source/code values in read responses are written to `/tmp/enfyra-mcp-sources` and returned as length/hash/preview/tmpFile metadata so LLM callers can inspect full source from the file path without truncating tool output.
- JSON responses include `compressionStats` with estimated token savings. Arrays of objects are converted to columnar form only when the compact shape is smaller than raw JSON.
- Relation tools reject physical FK/junction names and resolve table ids from exact table names or aliases before schema mutation.
- Generated code should use relation property names such as `conversation`, `sender`, and `member` instead of physical FK fields such as `conversationId`, `senderId`, or `memberId`.
- Custom route tools reject `mainTableId` unless the route is the canonical table route.
- `discover_enfyra_workflows` maps task intent to workflow surfaces before the agent loads detailed examples or guesses between similar tools.
- Platform operation tools such as `api_endpoint_workflow`, `extension_workflow`, `flow_workflow`, `search_admin_extensions`, `debug_field_exposure`, `enable_route`, `disable_route`, `delete_route`, `public_route_methods`, `set_table_graphql`, `ensure_route_rate_limit`, `ensure_guard`, `ensure_field_permission`, `ensure_column_rule`, `ensure_websocket_event`, `ensure_menu`, `reorder_menus`, `ensure_page_extension`, `ensure_global_extension`, and `ensure_widget_extension` resolve metadata ids and validate code before saving.
- Schema changes are serialized.
- Destructive deletes return a preview before requiring `confirm=true`.

## Query Notes

Use explicit `fields` in read tools. Include mode is the default, such as `fields=id,email`. Any excluded field switches that scope to exclude mode: `fields=-compiledCode` returns all readable fields except `compiledCode`, and `fields=id,-compiledCode` still means all except `compiledCode`. Dotted exclusions such as `fields=-owner.avatar` work for relation fields when the relation exists in metadata. Every broad list/query call must pass either `limit` for a bounded page or `all: true` for a complete list. Locator searches on `get_all_routes` and `get_all_tables` may omit `limit` when `search` is provided; they return a small bounded lookup window. When a caller needs every matching row, pass `all: true` to `query_table`, `get_all_routes`, or `get_all_tables`; the tool should not choose an arbitrary page size like 30 or 50.

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

By default, the MCP server starts with `ENFYRA_MCP_TOOLSET=guided`, a curated tool surface optimized for weaker LLMs and one-shot success. It exposes workflow routing, focused discovery, runtime zone search, schema tools, query/CRUD envelopes, row-scope pre-hooks, focused extension patching, operation-level route/permission/extension/flow/websocket tools, validation, and narrow verification tools. Set `ENFYRA_MCP_TOOLSET=full` only for expert debugging or compatibility work that needs low-level escape hatches such as raw route construction, cache reloads, method metadata, broad metadata reads, or raw log file reads.

Routes have two separate controls. `isEnabled` controls runtime registration: disabled routes return `404`. Use `enable_route` and `disable_route` for this lifecycle. `publicMethods` controls anonymous access for enabled routes; use `public_route_methods` and `private_route_methods` for that access boundary.

Use `reorder_menus` for menu order or parent changes. It calls the Enfyra 2.2.6 `/admin/menu/reorder` operation route so hierarchy validation and menu cache invalidation are handled by the server instead of PATCHing individual `enfyra_menu` records.

Admin app page paths and API paths are different surfaces. A page extension path such as `/cloud/projects/:id` is a UI route unless an enabled Enfyra API route with that exact path exists. Use `test_rest_endpoint` only for actual API routes under `ENFYRA_API_URL`; verify page extensions through the app URL/browser or extension/menu metadata.

For authenticated route access, use `audit_route_access` before changing permissions and `ensure_route_access` to grant access by route path plus role/user. For production script edits, use `trace_metadata_usage`, `get_script_source`, and `patch_script_source` so changes are targeted, hash-checked, and validated.

## Security

Treat permission and security as the first step for every change: decide public/private methods, authenticated route access, owner/tenant scope, and field exposure before creating handlers, flows, extensions, or UI.

API calls use exchanged JWTs and Enfyra permissions are still enforced server-side. Keep `ENFYRA_API_TOKEN` out of committed config unless the project intentionally uses environment interpolation or another secret-management path.
