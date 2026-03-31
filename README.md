# Enfyra MCP Server

MCP server for managing Enfyra instances from **Claude Code**, **Cursor**, and other MCP-compatible clients. All operations go through Enfyra's REST API.


**LLM rules (REST, GraphQL, auth, URL, mutation `create_{tableName}`, etc.):** not in this README — see **`src/lib/mcp-instructions.js`** (content sent via MCP `instructions`) and tool descriptions in **`src/index.mjs`**. This README only covers **MCP installation and configuration** for users/devs.

**Official docs:** [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp) · [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings) · [Cursor MCP (`mcp.json`)](https://cursor.com/docs/context/mcp)

---

## Quick local setup (`config` command)

From your **Enfyra project root** (where you want `.mcp.json` / `.cursor/mcp.json`):

```bash
npx @enfyra/mcp-server config
```

- **Interactive (default in a terminal):** first asks **where** to write config — `[1]` Claude Code only, `[2]` Cursor only, `[3]` both (default) — unless you already passed `--claude-code` / `--cursor` / etc. Then prompts for `ENFYRA_API_URL`, `ENFYRA_EMAIL`, and `ENFYRA_PASSWORD` when missing. Press **Enter** to accept bracketed defaults (env + existing `enfyra` in either local file). Password **Enter** keeps the current saved password when updating.
- **Re-run anytime** to update the same files; other entries under `mcpServers` are preserved.
- **Non-interactive** (CI / scripts): `npx @enfyra/mcp-server config --yes` plus optional `-a` / `-e` / `-p` and/or env vars.
- **One IDE only:** `--claude-code` / `--claude` / `--claude-only` → `./.mcp.json` only. `--cursor` / `--cursor-only` → `./.cursor/mcp.json` only. Pass **both** target flags → write both files (same as default).
- **Help:** `npx @enfyra/mcp-server config --help`

Equivalent in this repo: `yarn mcp:config` (Yarn v1 reserves `yarn config` for registry settings). Same as `node src/index.mjs config` / `npm run mcp:config`.

---

## Which coding tool? (switch)

Use this table to see **where** each host stores config. The **`mcpServers.enfyra` JSON block** at the bottom of each section is identical; only the **file paths** and **CLI** differ.

| | **Claude Code** | **Cursor** |
|---|-----------------|------------|
| **Global (all projects)** | `~/.claude.json` — scopes **user** or **local** | `~/.cursor/mcp.json` |
| **Project (repo)** | **`.mcp.json`** at repository root (`--scope project`) | **`.cursor/mcp.json`** in the project |
| **Typical install** | `claude mcp add --transport stdio …` | Edit `mcp.json` or **Settings → MCP** |
| **Precedence / merge** | local → project `.mcp.json` → user | Project `.cursor/mcp.json` overrides global `~/.cursor/mcp.json` |
| **Gotcha** | Do not put MCP server definitions in `.claude/settings.json` | Root **`.mcp.json`** is for Claude Code project scope, not Cursor — use **`.cursor/mcp.json`** for Cursor |

Expand **one** block below for step-by-step setup.

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

---

## Tools (summary)

Metadata, query/CRUD, route/handler/hook, tables/columns, reload cache, logs, user/roles, login, menu/extension, `get_enfyra_api_context`. For full tool list and behavior, see the app after enabling MCP or the source in `src/index.mjs`.

## Security

API calls use JWT (MCP auto-refreshes). Permissions are enforced by Enfyra.
