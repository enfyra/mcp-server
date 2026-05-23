#!/usr/bin/env node
/**
 * Enfyra MCP — entry: `config` subcommand (local project files) or stdio MCP server.
 */

import { config as loadEnv } from 'dotenv';

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
  console.log(`Enfyra MCP Server

Usage:
  npx @enfyra/mcp-server                 Start the MCP stdio server
  npx @enfyra/mcp-server config [flags]  Write local MCP host config

Common config flags:
  --codex             Write ~/.codex/config.toml
  --claude-code       Write ./.mcp.json
  --cursor            Write ./.cursor/mcp.json
  --reconfig          Prompt for host and credentials again, replacing the enfyra entry
  --yes               Non-interactive
  -a, --api-url       ENFYRA_API_URL
  -t, --api-token     ENFYRA_API_TOKEN
  -h, --help          Show config help

Run \`npx @enfyra/mcp-server config --help\` for full config details.
`);
  process.exit(0);
}
if (args[0] === 'config') {
  loadEnv({ quiet: true });
  const { runLocalConfig } = await import('./lib/config-local.mjs');
  await runLocalConfig(args.slice(1));
  process.exit(0);
}

loadEnv();
await import('./mcp-server-entry.mjs');
