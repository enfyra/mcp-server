# Enfyra MCP Server

Connect Enfyra to MCP-compatible coding tools such as Codex, Claude Code, Cursor, VS Code / GitHub Copilot, Google Antigravity, and other STDIO MCP hosts.

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

Non-interactive setup for all supported clients:

```bash
npx @enfyra/mcp-server@latest config --yes \
  --app-url http://localhost:3000 \
  --api-token efy_pat_your-token
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
| `--codex` | Write Codex config |
| `--claude-code`, `--claude` | Write Claude Code config |
| `--cursor` | Write Cursor config |
| `--vscode`, `--copilot` | Write VS Code / GitHub Copilot config |
| `--antigravity` | Write Google Antigravity config |
| `-h`, `--help` | Show CLI help |

## Environment

| Variable | Description | Default |
|---|---|---|
| `ENFYRA_APP_URL` | App/admin URL used by setup | `http://localhost:3000` |
| `ENFYRA_API_URL` | Runtime API base written into MCP config | Derived from the app URL |
| `ENFYRA_API_TOKEN` | Programmatic token from the Enfyra admin UI `/me` | Required |
| `ENFYRA_MCP_TOOLSET` | `guided` for the normal curated toolset or `full` for low-level debugging tools | `guided` |
| `ENFYRA_MCP_PROFILE` | Guided domain surface: `all`, `extension`, `schema`, `runtime`, or `operations`; ignored by `full` | `all` |

The API token is exchanged for a short-lived access token at runtime. It is not sent directly as a Bearer token.

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
