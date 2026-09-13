import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const rootConfigPath = fileURLToPath(new URL('../../../.codex/config.toml', import.meta.url));
const serverEntry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

export function parseToolResult(result) {
  if (result.isError) throw new Error(result.content?.find((item) => item.type === 'text')?.text || 'MCP operation failed.');
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text);
}

export async function connectRootMcp(profile = 'all', dynamic) {
  const python = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3'].find((command) => spawnSync(command, ['-c', 'import tomllib'], { stdio: 'ignore' }).status === 0);
  assert.ok(python, 'Python with tomllib is required to read the root MCP connection.');
  const configured = JSON.parse(execFileSync(python, ['-c',
    'import json,sys,tomllib; c=tomllib.load(open(sys.argv[1],"rb")); print(json.dumps(c["mcp_servers"]["enfyra"]["env"]))',
    rootConfigPath,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.match(configured.ENFYRA_API_URL ?? '', /^http:\/\/(?:localhost|127\.0\.0\.1):3000\/api$/);
  assert.ok(configured.ENFYRA_API_TOKEN, 'Root MCP connection must configure ENFYRA_API_TOKEN.');
  const env = { ...process.env, ...configured, ENFYRA_MCP_PROFILE: profile, ENFYRA_MCP_USAGE_DISABLE: '1' };
  if (dynamic === undefined) delete env.ENFYRA_MCP_DYNAMIC_TOOLS;
  else env.ENFYRA_MCP_DYNAMIC_TOOLS = dynamic;
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: 'pipe' });
  const client = new Client({ name: 'enfyra-local-gateway-e2e', version: '1.0.0' });
  await client.connect(transport);
  const executeRaw = (name, args = {}) => client.callTool({ name: 'enfyra', arguments: { action: 'execute', name, arguments: args } });
  const execute = async (name, args = {}) => parseToolResult(await executeRaw(name, args)).result;
  const discover = async (query, limit = 1) => parseToolResult(await client.callTool({ name: 'enfyra', arguments: { action: 'discover', ...(query ? { query } : {}), limit } }));
  try {
    const context = await execute('get_enfyra_api_context');
    assert.equal(context.enfyraApiUrl, configured.ENFYRA_API_URL);
    await execute('get_current_user');
  } catch (error) {
    await client.close();
    throw error;
  }
  return { client, execute, executeRaw, discover };
}
