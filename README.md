# Enfyra MCP Server

MCP server for managing Enfyra instances from **Codex**, **Claude Code**, **Cursor**, and other MCP-compatible clients. All operations go through Enfyra's REST API.


**LLM rules (REST, GraphQL, auth, URL, mutation `create_{tableName}`, etc.):** not in this README — see **`src/lib/mcp-instructions.js`** (content sent via MCP `instructions`), **`src/lib/mcp-examples.js`** (concrete examples loaded through `get_enfyra_examples`), and tool descriptions in **`src/mcp-server-entry.mjs`**. This README only covers **MCP installation and configuration** for users/devs.

**Official docs:** [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp) · [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings) · [Cursor MCP (`mcp.json`)](https://cursor.com/docs/context/mcp)

---

## Quick local setup (`config` command)

From your **Enfyra project root**:

```bash
npx @enfyra/mcp-server config
```

- **Interactive (default in a terminal):** first asks **where** to write config with an arrow-key selector — Claude Code, Cursor, Codex, or all — unless you already passed target flags. Then prompts for `ENFYRA_API_URL` and `ENFYRA_API_TOKEN` when missing. Press **Enter** to accept bracketed defaults from env or existing `enfyra` config.
- **Re-run anytime** to update the same files; other entries under `mcpServers` are preserved.
- **Non-interactive** (CI / scripts): `npx @enfyra/mcp-server config --yes` plus optional `-a` / `-t` and/or env vars.
- **One host only:** `--claude-code` / `--claude` / `--claude-only` → `./.mcp.json`. `--cursor` / `--cursor-only` → `./.cursor/mcp.json`. `--codex` / `--codex-only` → `./.codex/config.toml`. Pass multiple target flags to write each selected host.
- **Reconfigure:** `npx @enfyra/mcp-server config --reconfig` prompts for the target host again, uses existing project values as defaults, and replaces the old project `enfyra` entry for that host.
- **Global/user config:** add `--global` only when you intentionally want the selected host config under your home directory instead of this project.
- **Help:** `npx @enfyra/mcp-server -h` or `npx @enfyra/mcp-server config --help`

Equivalent in this repo: `yarn mcp:config` (Yarn v1 reserves `yarn config` for registry settings). Same as `node src/index.mjs config` / `npm run mcp:config`.

---

## Which coding tool? (switch)

Use this table to see **where** each host stores config. The **`mcpServers.enfyra` JSON block** at the bottom of each section is identical; only the **file paths** and **CLI** differ.

| | **Codex** | **Claude Code** | **Cursor** |
|---|-----------|-----------------|------------|
| **Project (repo, default)** | **`.codex/config.toml`** in the project | **`.mcp.json`** at repository root | **`.cursor/mcp.json`** in the project |
| **Global (explicit `--global`)** | `~/.codex/config.toml` | `~/.mcp.json` from this helper, or Claude's `~/.claude.json` via `claude mcp add --scope user` | `~/.cursor/mcp.json` |
| **Typical install** | `npx @enfyra/mcp-server config --codex` | `npx @enfyra/mcp-server config --claude-code` | `npx @enfyra/mcp-server config --cursor` |
| **Precedence / merge** | Project config is merged/replaced for `enfyra` | Project `.mcp.json` is merged/replaced for `enfyra` | Project `.cursor/mcp.json` is merged/replaced for `enfyra` |
| **Gotcha** | Open this folder in a new Codex session after editing config | Do not put MCP server definitions in `.claude/settings.json` | Root **`.mcp.json`** is for Claude Code project scope, not Cursor — use **`.cursor/mcp.json`** for Cursor |

Expand **one** block below for step-by-step setup.

<details open>
<summary><strong>Codex</strong> — setup</summary>

The config command writes project Codex config to `./.codex/config.toml` by default:

```bash
npx @enfyra/mcp-server config --codex
```

Non-interactive:

```bash
npx @enfyra/mcp-server config --codex --yes \
  -a http://localhost:3000/api \
  -t efy_pat_your-token
```

The generated TOML section is:

```toml
[mcp_servers.enfyra]
command = "npx"
args = ["-y", "@enfyra/mcp-server"]

[mcp_servers.enfyra.env]
ENFYRA_API_URL = "http://localhost:3000/api"
ENFYRA_API_TOKEN = "efy_pat_your-token"
```

The config writer replaces only `[mcp_servers.enfyra]` and `[mcp_servers.enfyra.env]`; other Codex config and other MCP servers are preserved. Open this folder in a new Codex session after updating `./.codex/config.toml`. Use `--global --codex` only when you intentionally want `~/.codex/config.toml`.

</details>

<details open>
<summary><strong>Claude Code</strong> — setup</summary>

MCP server definitions are **not** placed in `.claude/settings.json`; that folder is for other Claude Code settings.

### Choose scope (Claude Code)

| Goal | Location | Claude Code scope | Typical use |
|------|----------|-------------------|-------------|
| Same Enfyra MCP in **every** project on your machine | **`~/.claude.json`** | **user** (`claude mcp add … --scope user`) | One admin stack you always use |
| MCP only when this **repo is cwd**, private to you, often with secrets | **`~/.claude.json`** | **local** (default: `claude mcp add …` without `--scope project`) | Per-machine URLs or tokens; nothing committed |
| **Team** / reproducible setup; commit config to git | **`.mcp.json`** at the **repository root** | **project** (`claude mcp add … --scope project`) | Shared onboarding; env expansion supported |

**Precedence when the same server name exists in more than one place:** **local** → **project** (`.mcp.json`) → **user**. See the [official MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp).

**Project `.mcp.json` approval:** Claude Code may prompt before trusting project-scoped servers; use `claude mcp reset-project-choices` to reset.

### `claude mcp add` — user, local, or project

Use the CLI (recommended). **User** and **local** configs are stored in **`~/.claude.json`**; **project** (`--scope project`) writes **`./.mcp.json`** at the repo root.

```bash
# User scope — available in all projects (options before server name per Claude Code docs)
claude mcp add --transport stdio --scope user \
  --env ENFYRA_API_URL=http://localhost:3000/api \
  --env ENFYRA_API_TOKEN=efy_pat_your-token \
  enfyra -- npx -y @enfyra/mcp-server

# Local scope (default) — only when this repo is cwd; still stored in ~/.claude.json under project path
claude mcp add --transport stdio \
  --env ENFYRA_API_URL=http://localhost:3000/api \
  --env ENFYRA_API_TOKEN=efy_pat_your-token \
  enfyra -- npx -y @enfyra/mcp-server

# Project scope — writes/updates .mcp.json at repo root (good for teams)
claude mcp add --transport stdio --scope project \
  --env ENFYRA_API_URL=http://localhost:3000/api \
  --env ENFYRA_API_TOKEN=efy_pat_your-token \
  enfyra -- npx -y @enfyra/mcp-server
```

On **native Windows** (not WSL), stdio servers using `npx` often need the `cmd /c` wrapper — see [Claude Code MCP — Windows](https://docs.anthropic.com/en/docs/claude-code/mcp).

You can set env vars with **`--env`** (as above), edit **`~/.claude.json`** / **`.mcp.json`**, or use the `/mcp` UI.

### Manual JSON (Claude Code)

Use inside **`.mcp.json`** `mcpServers`, or merge into **`~/.claude.json`** per [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings) for your scope. Reuse the **shared JSON** in the [Shared](#shared-enfyra-mcp-json-and-environment) section below.

### `.mcp.json` only (Claude Code project, manual)

If you skip the CLI, add **`mcpServers.enfyra`** to **`.mcp.json`** at the repository root. Official docs support **environment variable expansion** in `.mcp.json`.

**Local dev (this monorepo):** point `command` / `args` / `cwd` at `node` and `src/index.mjs` inside your clone — see the sample **`.mcp.json`** in this repository (adjust `cwd` or use expansion).

</details>

<details>
<summary><strong>Cursor</strong> — setup</summary>

Cursor reads MCP from **`mcp.json`** in two places ([Cursor docs](https://cursor.com/docs/context/mcp)):

| Scope | Path |
|-------|------|
| **Global** | `~/.cursor/mcp.json` (macOS/Linux) or `%USERPROFILE%\.cursor\mcp.json` (Windows) |
| **Project** | **`.cursor/mcp.json`** inside the project (directory **`.cursor`** at repo root) |

Paste the **same** `mcpServers` structure as in the [Shared](#shared-enfyra-mcp-json-and-environment) section. Cursor supports **interpolation**, e.g. `${env:ENFYRA_API_TOKEN}`, `${workspaceFolder}`, for secrets and paths.

Optional **STDIO** fields per Cursor: `type`, `command`, `args`, `env`, `envFile` — see [STDIO server configuration](https://cursor.com/docs/context/mcp).

**After edits:** restart Cursor (or toggle the server under **Settings → Features → Model Context Protocol**). Use **Output → MCP Logs** if the server fails to start.

**Using both Cursor and Claude Code in one repo:** keep **`.cursor/mcp.json`** for Cursor and **`.mcp.json`** (root) for Claude Code **project** scope if needed — they are different files.

</details>

---

## Shared: Enfyra MCP JSON and environment

Use this block in any host-specific `mcp.json` / `mcpServers` merge (adjust env or use `${env:…}` where your editor supports it).

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

- `-y`: auto-confirm `npx` package install without prompting.
- **Restart** the coding tool after manual file edits.

| Variable | Description | Default |
|----------|-------------|---------|
| `ENFYRA_API_URL` | Base for REST + GraphQL + auth through the Nuxt/app proxy | `http://localhost:3000/api` |
| `ENFYRA_API_TOKEN` | Programmatic token from eApp `/me`. MCP exchanges it through `/auth/token/exchange` for an access token. | — |

`ENFYRA_API_TOKEN` is a long-lived programmatic token, not a JWT. MCP must never send it directly as `Authorization: Bearer <token>` to REST tools. The MCP client first calls `POST {ENFYRA_API_URL}/auth/token/exchange` with `{ "apiToken": ENFYRA_API_TOKEN }`, caches the returned `accessToken`, and uses that JWT as the Bearer token for subsequent requests.

Schema and script tools include safety guards for LLM callers: generic record mutations validate request fields against live metadata, script-backed records must validate `sourceCode` before save through `/admin/script/validate` and fail closed if validation is unavailable, relation metadata rejects physical FK/junction inputs, custom routes reject `mainTableId` unless the path is the canonical table route, schema tools serialize table/column/relation changes, and destructive deletes require `confirm=true` after returning a preview.

Quick checklist for a new LLM using Enfyra MCP: discover the live system first, inspect the specific table/route, load the matching example category, mutate with explicit fields and relation property names, validate or test scripts/routes before relying on them, re-read the saved row when mutation output is summarized, and preview destructive operations before confirming.

Use `update_script_source` when updating existing long script-backed records such as `flow_step_definition`, `route_handler_definition`, hook tables, websocket scripts, GraphQL scripts, or bootstrap scripts. It accepts raw `sourceCode` directly, validates the source, and saves `sourceCode`/`scriptLanguage` without requiring the caller to manually JSON-escape the full script. Use generic `update_record` for small record patches or patches that include non-script metadata fields.

For route contracts that intentionally keep workflow fields out of request bodies, generic `create_record`, `update_record`, and `delete_record` accept optional `queryParams` as a JSON object string. For example, a renewal workflow can keep `expires_at=YYYY-MM-DD` in the URL query while `validateBody` remains enabled for the table body.

### `ENFYRA_API_URL` — use the app proxy

For normal apps and demos, set `ENFYRA_API_URL` to the Nuxt/app proxy:

```text
http://localhost:3000/api
```

The Enfyra backend is private infrastructure. MCP, browser code, SSR routes, GraphQL calls, and generated app code should go through the app origin `/api/**`; do not connect them directly to the backend host/port. Direct backend URLs are only for Enfyra core/server debugging when you intentionally bypass the app proxy.

### SSR app auth pattern

When an LLM builds a Nuxt, Next, or other SSR frontend for Enfyra, follow the same-origin proxy pattern:

- Browser code calls a same-origin proxy such as `{{ appOrigin }}/enfyra/**`, never the raw Enfyra backend URL.
- Nuxt can proxy it with `routeRules: { "/enfyra/**": { proxy: { to: `${API_URL}/**`, fetchOptions: { redirect: "manual" } } } }`. Keep redirects manual so OAuth set-cookie redirects reach the browser as real HTTP redirects with `Set-Cookie`.
- Generated apps should not create custom login/logout/me routes that manually set `accessToken`, `refreshToken`, or `expTime` cookies when the proxy is enough.
- Password login is `POST /enfyra/login`, not `/enfyra/auth/login`.
- Fetch the current user with `GET /enfyra/me` and logout with `POST /enfyra/logout`.
- OAuth starts through the same proxy prefix, for example `/enfyra/auth/google?redirect=<absoluteReturnUrl>&cookieBridgePrefix=/enfyra`. `redirect` must include the app origin, and `cookieBridgePrefix` is the same proxy prefix that reaches Enfyra API routes. Enfyra validates the redirect, exchanges OAuth on its callback, then redirects through `{redirect.origin}{cookieBridgePrefix}/auth/set-cookies` so the third app origin stores the cookies before returning to `redirect`.
- Socket.IO browser clients use a same-origin bridge too. Connect to the namespace, e.g. `io("/chat", { path: "/socket.io", withCredentials: true })`, and proxy `/socket.io/**` to the Enfyra app bridge `/ws/socket.io/**`. The backend gateway metadata path remains `/chat`.
- Use token-query OAuth callback pages only for non-SSR/manual-token apps.

---

## Tools (summary)

Metadata, examples, query/CRUD, method management, route/handler/hook, tables/columns, reload cache, logs, user/roles, login, menu/extension, `get_enfyra_api_context`. For full tool list and behavior, see the app after enabling MCP or the source in `src/mcp-server-entry.mjs`.

Use `get_enfyra_examples` when asking an LLM to generate concrete Enfyra implementation patterns. It returns categorized examples for SSR app auth/OAuth/proxy setup, schema/relations, queries/deep, handlers/hooks, permissions/RLS, websocket, flows, files, and extensions.

## Security

API calls use JWT (MCP auto-refreshes). Permissions are enforced by Enfyra.
