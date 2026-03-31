#!/usr/bin/env node
/**
 * Enfyra MCP — entry: `config` subcommand (local project files) or stdio MCP server.
 */

import { config as loadEnv } from 'dotenv';

const args = process.argv.slice(2);
if (args[0] === 'config') {
  loadEnv({ quiet: true });
  const { runLocalConfig } = await import('./lib/config-local.mjs');
  await runLocalConfig(args.slice(1));
  process.exit(0);
}

loadEnv();
await import('./mcp-server-entry.mjs');
