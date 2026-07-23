import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeCodexConfig } from '../dist/lib/config-local-adapters.js';

test('Codex config disables dynamic tool packs so workflow mutations remain callable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'enfyra-mcp-codex-config-'));
  const configPath = join(root, 'config.toml');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(configPath, [
    '[features]',
    'example = true',
    '',
    '[mcp_servers.other]',
    'command = "other"',
    '',
  ].join('\n'));

  await mergeCodexConfig(configPath, 'http://localhost:3000/api', 'secret-token');

  const config = await readFile(configPath, 'utf8');
  assert.match(config, /\[features\]\s+example = true/);
  assert.match(config, /\[mcp_servers\.other\]\s+command = "other"/);
  assert.match(config, /\[mcp_servers\.enfyra\.env\][\s\S]*ENFYRA_MCP_DYNAMIC_TOOLS = "off"/);
});
