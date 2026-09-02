# Enfyra MCP Server

Connect Enfyra to MCP-compatible coding tools such as Codex, Claude Code, Cursor, VS Code / GitHub Copilot, Google Antigravity, ZCode, and other STDIO MCP hosts.

## Install and Configure

Run this from the project that should use Enfyra:

```bash
npx @enfyra/mcp-server@latest config
```

The setup asks for:

- the Enfyra app/admin URL, such as `http://localhost:3000` or `https://demo.enfyra.io`;
- an `ENFYRA_API_TOKEN` created from the Enfyra admin UI `/me` page;
- the MCP clients to configure.

It writes project-local configuration and replaces only the `enfyra` server entry.

| Client | Command | Project config |
|---|---|---|
| Codex | `npx @enfyra/mcp-server@latest config --codex` | `.codex/config.toml` |
| Claude Code | `npx @enfyra/mcp-server@latest config --claude-code` | `.mcp.json` |
| Cursor | `npx @enfyra/mcp-server@latest config --cursor` | `.cursor/mcp.json` |
| VS Code / GitHub Copilot | `npx @enfyra/mcp-server@latest config --vscode` | `.vscode/mcp.json` |
| Google Antigravity | `npx @enfyra/mcp-server@latest config --antigravity` | `.agents/mcp_config.json` |
| ZCode | `npx @enfyra/mcp-server@latest config --zcode` | `.zcode/config.json` |

Non-interactive setup for all supported clients:

```bash
npx @enfyra/mcp-server@latest config --yes \
  --app-url http://localhost:3000 \
  --api-token efy_pat_your-token
```

Remove temporary source artifacts and local telemetry files created by MCP:

```bash
npx @enfyra/mcp-server@latest cleanup
```

Configure more than one selected client:

```bash
npx @enfyra/mcp-server@latest config --cursor --claude-code
```

## Manual Configuration

For hosts that accept an `mcpServers` JSON block:

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

Codex project configuration uses TOML:

```toml
[mcp_servers.enfyra]
command = "npx"
args = ["-y", "@enfyra/mcp-server@latest"]

[mcp_servers.enfyra.env]
ENFYRA_API_URL = "http://localhost:3000/api"
ENFYRA_API_TOKEN = "efy_pat_your-token"
```

ZCode uses a nested `mcp.servers` JSON structure in `.zcode/config.json`:

```json
{
  "mcp": {
    "servers": {
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
}
```

Restart or reload the MCP client after writing configuration. Keep the token out of committed files.

## Config Command

```bash
npx @enfyra/mcp-server@latest config [options]
```

| Option | Use |
|---|---|
| `--app-url` | Set the Enfyra app/admin URL |
| `--api-token`, `-t` | Set `ENFYRA_API_TOKEN` |
| `--yes` | Run non-interactively |
| `--reconfig` | Select clients again and replace the existing `enfyra` entry |
| `--static-tools` | Use the guided static compatibility manifest instead of dynamic packs |
| `--codex` | Write Codex config |
| `--claude-code`, `--claude` | Write Claude Code config |
| `--cursor` | Write Cursor config |
| `--vscode`, `--copilot` | Write VS Code / GitHub Copilot config |
| `--antigravity` | Write Google Antigravity config |
| `--zcode` | Write ZCode config |
| `-h`, `--help` | Show CLI help |

## Environment

| Variable | Description | Default |
|---|---|---|
| `ENFYRA_API_URL` | Runtime API base written into MCP config | Required |
| `ENFYRA_API_TOKEN` | Programmatic token from the Enfyra admin UI `/me` | Required |

The MCP server starts with a compact guided catalog. For a hidden guided operation, call `search_enfyra_tools` to load its exact schema, then call `execute_enfyra_tool`; low-level tools remain hidden. No tool-loading configuration is needed. Re-running `config` preserves existing `ENFYRA_MCP_DYNAMIC_TOOLS` and `ENFYRA_MCP_PROFILE` values. Use `--static-tools` only for a compatibility client that needs the complete direct manifest.

The MCP sends this PAT directly through Enfyra Server's native `x-enfyra-pat` header. It does not exchange the PAT for a short-lived access token or send it as a Bearer token.

## Verify the Connection

Open a new session in the configured MCP client and ask it to:

```text
Use Enfyra MCP to show the connected API context.
```

Then try a read-only request:

```text
Use Enfyra MCP to list the available tables without changing anything.
```

## Development

This repository uses Yarn 4 and TypeScript:

```bash
yarn typecheck
yarn test
```

Use [AGENTS.md](./AGENTS.md) for maintainer architecture, tool contracts, verification rules, and backend sync points. LLM runtime guidance is served by the MCP instructions, tool descriptions, workflow discovery, required-knowledge tools, builders, and examples—not by this README.
