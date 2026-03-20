# Enfyra MCP Server

MCP (Model Context Protocol) server for managing Enfyra instances via Claude Code.

## Features

- **Auto Token Refresh**: Automatically obtains and refreshes JWT tokens
- **Metadata Management**: Query tables, columns, relations, routes, hooks
- **CRUD Operations**: Create, read, update, delete records in any table
- **Route & Handler Management**: Create routes, handlers, pre/post hooks
- **Table Management**: Create tables and columns
- **Cache Control**: Reload metadata, routes, Swagger, GraphQL
- **Log Access**: View and tail log files

## Add to Claude Code

### Method 1: Global Configuration (Recommended)

Edit `~/.claude.json` and add to the `mcpServers` section:

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

**Important**:
- The `-y` flag automatically confirms installation
- After updating config, restart Claude Code for changes to take effect

| Variable | Description | Default |
|----------|-------------|---------|
| `ENFYRA_API_URL` | Base URL of Enfyra API | `http://localhost:3000/api` |
| `ENFYRA_EMAIL` | Admin email for authentication | - |
| `ENFYRA_PASSWORD` | Admin password for authentication | - |

## Available Tools

### Authentication
- `login` - Login and get new access token

### Metadata
- `get_all_metadata` - Get all system metadata
- `get_table_metadata` - Get metadata for a specific table
- `query_table` - Query any table with filters
- `find_one_record` - Find a single record

### CRUD
- `create_record` - Create a new record
- `update_record` - Update a record
- `delete_record` - Delete a record

### Routes & Handlers
- `get_all_routes` - Get all route definitions
- `create_route` - Create a new route
- `create_handler` - Create a handler for a route
- `create_pre_hook` - Create a pre-hook
- `create_post_hook` - Create a post-hook

### Tables
- `get_all_tables` - Get all table definitions
- `create_table` - Create a new table
- `create_column` - Create a column
- `sync_table_schema` - Sync DB schema with metadata

### System
- `reload_all` - Reload all caches
- `reload_metadata` - Reload metadata only
- `reload_routes` - Reload routes only
- `reload_swagger` - Reload Swagger spec
- `reload_graphql` - Reload GraphQL schema

### Logs
- `get_log_files` - List available log files
- `get_log_content` - Get log file content
- `tail_log` - Get last N lines from log

### Auth
- `get_current_user` - Get current user info
- `get_all_roles` - Get all roles

## Usage Examples

After configuring in Claude Code:

```
"Query all users"
→ Uses query_table with tableName="user_definition"

"Create a new API route for /api/tasks"
→ Uses create_route, then create_handler

"Debug the error logs"
→ Uses tail_log with filename="error.log"

"Deploy my metadata changes"
→ Uses reload_all
```

## Security Notes

- All operations go through Enfyra's REST API
- Authentication is required (JWT token with auto-refresh)
- Permissions are enforced by Enfyra's auth system
- Pre/Post hooks and RLS are applied to all queries