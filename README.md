# Enfyra MCP Server

MCP server for managing Enfyra instances from **Claude Code** (and other MCP clients). All operations go through Enfyra's REST API.

**LLM rules (REST, GraphQL, auth, URL, mutation `create_{tableName}`, etc.):** not in this README — see **`src/lib/mcp-instructions.js`** (content sent via MCP `instructions`) and tool descriptions in **`src/index.mjs`**. This README only covers **MCP installation and configuration** for users/devs.

## Install in Claude Code

Edit `~/.claude.json` and add to `mcpServers`:

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

- `-y`: auto-confirm package install without prompting.
- **Restart Claude Code** after updating config.

**Local dev (running this repo):** use `node` with path to `src/index.mjs`; see `.mcp.json` in the project.

| Variable | Description | Default |
|----------|-------------|---------|
| `ENFYRA_API_URL` | API base URL (usually includes `/api`) | `http://localhost:3000/api` |
| `ENFYRA_EMAIL` | Admin email | — |
| `ENFYRA_PASSWORD` | Admin password | — |

## Tools (summary)

Metadata, query/CRUD, route/handler/hook, tables/columns, reload cache, logs, user/roles, login, menu/extension, `get_enfyra_api_context`. For full tool list and behavior, see the app after enabling MCP or the source in `src/index.mjs`.

## Security

API calls use JWT (MCP auto-refreshes). Permissions are enforced by Enfyra.
