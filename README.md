# Enfyra MCP Server

MCP server for managing Enfyra instances from **Codex**, **Claude Code**, **Cursor**, and other MCP-compatible clients. All operations go through Enfyra's REST API.


**LLM rules (REST, GraphQL, auth, URL, mutation `create_{tableName}`, etc.):** not in this README — see **`src/lib/mcp-instructions.js`** (content sent via MCP `instructions`) and tool descriptions in **`src/index.mjs`**. This README only covers **MCP installation and configuration** for users/devs.

**Official docs:** [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp) · [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings) · [Cursor MCP (`mcp.json`)](https://cursor.com/docs/context/mcp)

---

## Quick local setup (`config` command)

From your **Enfyra project root**:

```bash
npx @enfyra/mcp-server config
```

- **Interactive (default in a terminal):** first asks **where** to write config — `[1]` Claude Code, `[2]` Cursor, `[3]` Codex, `[4]` all (default) — unless you already passed target flags. Then prompts for `ENFYRA_API_URL`, `ENFYRA_EMAIL`, and `ENFYRA_PASSWORD` when missing. Press **Enter** to accept bracketed defaults from env or existing `enfyra` config. Password **Enter** keeps the current saved password when updating.
- **Re-run anytime** to update the same files; other entries under `mcpServers` are preserved.
- **Non-interactive** (CI / scripts): `npx @enfyra/mcp-server config --yes` plus optional `-a` / `-e` / `-p` and/or env vars.
- **One host only:** `--claude-code` / `--claude` / `--claude-only` → `./.mcp.json`. `--cursor` / `--cursor-only` → `./.cursor/mcp.json`. `--codex` / `--codex-only` → `~/.codex/config.toml`. Pass multiple target flags to write each selected host.
- **Reconfigure:** `npx @enfyra/mcp-server config --reconfig` prompts for the target host again, uses existing values as defaults, and replaces the old `enfyra` entry for that host.
- **Help:** `npx @enfyra/mcp-server -h` or `npx @enfyra/mcp-server config --help`

Equivalent in this repo: `yarn mcp:config` (Yarn v1 reserves `yarn config` for registry settings). Same as `node src/index.mjs config` / `npm run mcp:config`.

---

## Which coding tool? (switch)

Use this table to see **where** each host stores config. The **`mcpServers.enfyra` JSON block** at the bottom of each section is identical; only the **file paths** and **CLI** differ.

| | **Codex** | **Claude Code** | **Cursor** |
|---|-----------|-----------------|------------|
| **Global (all projects)** | `~/.codex/config.toml` | `~/.claude.json` — scopes **user** or **local** | `~/.cursor/mcp.json` |
| **Project (repo)** | Use global config | **`.mcp.json`** at repository root (`--scope project`) | **`.cursor/mcp.json`** in the project |
| **Typical install** | `npx @enfyra/mcp-server config --codex` | `claude mcp add --transport stdio …` | Edit `mcp.json` or **Settings → MCP** |
| **Precedence / merge** | `config.toml` section is replaced for `enfyra`; other servers are preserved | local → project `.mcp.json` → user | Project `.cursor/mcp.json` overrides global `~/.cursor/mcp.json` |
| **Gotcha** | Restart Codex or start a new session after editing config | Do not put MCP server definitions in `.claude/settings.json` | Root **`.mcp.json`** is for Claude Code project scope, not Cursor — use **`.cursor/mcp.json`** for Cursor |

Expand **one** block below for step-by-step setup.

<details open>
<summary><strong>Codex</strong> — setup</summary>

The config command can write/update `~/.codex/config.toml` directly:

```bash
npx @enfyra/mcp-server config --codex
```

Non-interactive:

```bash
npx @enfyra/mcp-server config --codex --yes \
  -a http://localhost:3000/api \
  -e your-email@example.com \
  -p your-password
```

The generated TOML section is:

```toml
[mcp_servers.enfyra]
command = "npx"
args = ["-y", "@enfyra/mcp-server"]

[mcp_servers.enfyra.env]
ENFYRA_API_URL = "http://localhost:3000/api"
ENFYRA_EMAIL = "your-email@example.com"
ENFYRA_PASSWORD = "your-password"
```

The config writer replaces only `[mcp_servers.enfyra]` and `[mcp_servers.enfyra.env]`; other Codex config and other MCP servers are preserved. Restart Codex or start a new session after updating `~/.codex/config.toml`.

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
  --env ENFYRA_EMAIL=your-email@example.com \
  --env ENFYRA_PASSWORD=your-password \
  enfyra -- npx -y @enfyra/mcp-server

# Local scope (default) — only when this repo is cwd; still stored in ~/.claude.json under project path
claude mcp add --transport stdio \
  --env ENFYRA_API_URL=http://localhost:3000/api \
  --env ENFYRA_EMAIL=your-email@example.com \
  --env ENFYRA_PASSWORD=your-password \
  enfyra -- npx -y @enfyra/mcp-server

# Project scope — writes/updates .mcp.json at repo root (good for teams)
claude mcp add --transport stdio --scope project \
  --env ENFYRA_API_URL=http://localhost:3000/api \
  --env ENFYRA_EMAIL=your-email@example.com \
  --env ENFYRA_PASSWORD=your-password \
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

Paste the **same** `mcpServers` structure as in the [Shared](#shared-enfyra-mcp-json-and-environment) section. Cursor supports **interpolation**, e.g. `${env:ENFYRA_PASSWORD}`, `${workspaceFolder}`, for secrets and paths.

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
        "ENFYRA_EMAIL": "your-email@example.com",
        "ENFYRA_PASSWORD": "your-password"
      }
    }
  }
}
```

- `-y`: auto-confirm `npx` package install without prompting.
- **Restart** the coding tool after manual file edits.

| Variable | Description | Default |
|----------|-------------|---------|
| `ENFYRA_API_URL` | Base for REST + GraphQL + auth (see table below) | `http://localhost:3000/api` |
| `ENFYRA_EMAIL` | Admin email | — |
| `ENFYRA_PASSWORD` | Admin password | — |

### `ENFYRA_API_URL` — two valid setups

| Mode | Example | When to use |
|------|---------|-------------|
| **Via Nuxt admin (typical local dev)** | `http://localhost:3000/api` | Browser app on 3000; Nitro proxies `/api/*` to Nest (`API_URL`, often `http://localhost:1105`). GraphQL at `{ENFYRA_API_URL}/graphql` is proxied to the backend `/graphql`. |
| **Direct to Nest backend** | `http://localhost:1105` | Call Enfyra **without** the Nuxt prefix. **Do not** append `/api` unless your reverse proxy serves routes under `/api`—`http://localhost:1105/api/...` will not match default Nest paths. |

Pick the base URL that matches how **your** HTTP client reaches the same server as the Enfyra REST API.

### SSR app auth pattern

When an LLM builds a Nuxt, Next, or other SSR frontend for Enfyra, use a same-origin proxy:

- Browser code calls `{{ appOrigin }}/api/**`, never the raw Enfyra backend URL.
- Cookie-managed password login is `POST {{ appOrigin }}/api/login`, not `/api/auth/login`. The SSR route calls backend `/auth/login` and stores Enfyra `accessToken`, `refreshToken`, and `expTime` as httpOnly cookies.
- Cookie-managed OAuth should enable Enfyra OAuth cookie handling (`autoSetCookies` / set-cookies mode). Start OAuth at `{{ appOrigin }}/api/auth/:provider?redirect=...`; Enfyra redirects to `{{ appOrigin }}/api/auth/set-cookies`, then the SSR route sets cookies and redirects to the requested page.
- Use token-query OAuth callback pages only for non-SSR/manual-token apps.

---

## Tools (summary)

Metadata, query/CRUD, route/handler/hook, tables/columns, reload cache, logs, user/roles, login, menu/extension, `get_enfyra_api_context`. For full tool list and behavior, see the app after enabling MCP or the source in `src/index.mjs`.

## Security

API calls use JWT (MCP auto-refreshes). Permissions are enforced by Enfyra.
