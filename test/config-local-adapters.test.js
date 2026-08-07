import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildServerEntry,
  getClientPath,
  mergeCodexConfig,
  mergeMcpFile,
  mergeVscodeMcpFile,
  mergeZcodeConfig,
} from '../dist/lib/config-local-adapters.js';
import { parseArgs } from '../dist/lib/config-local-contracts.js';

const EXPECTED_ENV = {
  ENFYRA_API_URL: 'http://localhost:3000/api',
  ENFYRA_API_TOKEN: 'secret-token',
};

test('all supported clients are selected equally by default and explicit selectors stay isolated', () => {
  const clientFlags = {
    codex: '--codex',
    claude: '--claude-code',
    cursor: '--cursor',
    vscode: '--vscode',
    antigravity: '--antigravity',
    zcode: '--zcode',
  };
  const defaultSelection = parseArgs([]);

  for (const client of Object.keys(clientFlags)) {
    assert.equal(defaultSelection[client], true);
  }

  for (const [selectedClient, flag] of Object.entries(clientFlags)) {
    const selection = parseArgs([flag]);
    for (const client of Object.keys(clientFlags)) {
      assert.equal(selection[client], client === selectedClient);
    }
  }
});

test('compact and static tool loading modes are explicit mutually exclusive config choices', () => {
  assert.equal(parseArgs([]).toolMode, 'preserve');
  assert.equal(parseArgs(['--compact-tools']).toolMode, 'compact');
  assert.equal(parseArgs(['--static-tools']).toolMode, 'static');
  assert.throws(() => parseArgs(['--compact-tools', '--static-tools']), /cannot be combined/i);

  assert.deepEqual(buildServerEntry('http://localhost:3000/api', 'secret-token', { toolMode: 'compact' }).env, {
    ...EXPECTED_ENV,
    ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
  });
});

test('Codex config preserves existing advanced MCP runtime settings by default', async (t) => {
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
    '[mcp_servers.enfyra]',
    'command = "old"',
    '',
    '[mcp_servers.enfyra.env]',
    'ENFYRA_API_URL = "http://old.test/api"',
    'ENFYRA_API_TOKEN = "old-token"',
    'ENFYRA_MCP_DYNAMIC_TOOLS = "on"',
    'ENFYRA_MCP_PROFILE = "schema"',
    '',
  ].join('\n'));

  await mergeCodexConfig(configPath, 'http://localhost:3000/api', 'secret-token');

  const config = await readFile(configPath, 'utf8');
  assert.match(config, /\[features\]\s+example = true/);
  assert.match(config, /\[mcp_servers\.other\]\s+command = "other"/);
  assert.match(config, /\[mcp_servers\.enfyra\.env\][\s\S]*ENFYRA_API_URL = "http:\/\/localhost:3000\/api"/);
  assert.match(config, /\[mcp_servers\.enfyra\.env\][\s\S]*ENFYRA_API_TOKEN = "secret-token"/);
  assert.match(config, /ENFYRA_MCP_DYNAMIC_TOOLS = "on"/);
  assert.match(config, /ENFYRA_MCP_PROFILE = "schema"/);
});

test('JSON MCP hosts preserve existing advanced MCP runtime settings by default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'enfyra-mcp-json-config-'));
  const configPath = join(root, '.mcp.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      other: { command: 'other' },
      enfyra: {
        command: 'old',
        env: {
          ENFYRA_API_URL: 'http://old.test/api',
          ENFYRA_API_TOKEN: 'old-token',
          ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
          ENFYRA_MCP_PROFILE: 'schema',
        },
      },
    },
  }));

  await mergeMcpFile(
    configPath,
    buildServerEntry('http://localhost:3000/api', 'secret-token'),
  );

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(config.mcpServers.enfyra.env, {
    ...EXPECTED_ENV,
    ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
    ENFYRA_MCP_PROFILE: 'schema',
  });
  assert.deepEqual(config.mcpServers.enfyra.args, ['-y', '@enfyra/mcp-server@latest']);
  assert.deepEqual(config.mcpServers.other, { command: 'other' });
});

test('an explicit static mode overrides an existing compact host setting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'enfyra-mcp-static-config-'));
  const configPath = join(root, '.mcp.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      enfyra: {
        env: {
          ENFYRA_API_URL: 'http://old.test/api',
          ENFYRA_API_TOKEN: 'old-token',
          ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
          ENFYRA_MCP_PROFILE: 'runtime',
        },
      },
    },
  }));

  await mergeMcpFile(
    configPath,
    buildServerEntry('http://localhost:3000/api', 'secret-token', { toolMode: 'static' }),
  );

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(config.mcpServers.enfyra.env, {
    ...EXPECTED_ENV,
    ENFYRA_MCP_DYNAMIC_TOOLS: 'off',
    ENFYRA_MCP_PROFILE: 'runtime',
  });
});

test('every supported host serializes the same Enfyra package and environment contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'enfyra-mcp-host-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverEntry = buildServerEntry(EXPECTED_ENV.ENFYRA_API_URL, EXPECTED_ENV.ENFYRA_API_TOKEN);
  const paths = {
    codex: getClientPath('codex', root),
    claude: getClientPath('claude', root),
    cursor: getClientPath('cursor', root),
    vscode: getClientPath('vscode', root),
    antigravity: getClientPath('antigravity', root),
    zcode: getClientPath('zcode', root),
  };

  await mergeCodexConfig(paths.codex, EXPECTED_ENV.ENFYRA_API_URL, EXPECTED_ENV.ENFYRA_API_TOKEN);
  await Promise.all([
    mergeMcpFile(paths.claude, serverEntry),
    mergeMcpFile(paths.cursor, serverEntry),
    mergeVscodeMcpFile(paths.vscode, serverEntry),
    mergeMcpFile(paths.antigravity, serverEntry),
    mergeZcodeConfig(paths.zcode, serverEntry),
  ]);

  for (const client of ['claude', 'cursor', 'antigravity']) {
    const config = JSON.parse(await readFile(paths[client], 'utf8'));
    assert.deepEqual(config.mcpServers.enfyra, serverEntry);
  }

  const vscodeConfig = JSON.parse(await readFile(paths.vscode, 'utf8'));
  assert.deepEqual(vscodeConfig.servers.enfyra, {
    type: 'stdio',
    ...serverEntry,
  });

  const zcodeConfig = JSON.parse(await readFile(paths.zcode, 'utf8'));
  assert.deepEqual(zcodeConfig.mcp.servers.enfyra, serverEntry);

  const codexConfig = await readFile(paths.codex, 'utf8');
  assert.match(codexConfig, /command = "npx"/);
  assert.match(codexConfig, /args = \["-y", "@enfyra\/mcp-server@latest"\]/);
  assert.match(codexConfig, /ENFYRA_API_URL = "http:\/\/localhost:3000\/api"/);
  assert.match(codexConfig, /ENFYRA_API_TOKEN = "secret-token"/);
  assert.doesNotMatch(codexConfig, /ENFYRA_MCP_DYNAMIC_TOOLS|ENFYRA_MCP_TOOLSET|ENFYRA_MCP_PROFILE/);
});

test('VS Code MCP config keeps the same two-setting Enfyra boundary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'enfyra-mcp-vscode-config-'));
  const configPath = join(root, 'mcp.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  await mergeVscodeMcpFile(
    configPath,
    buildServerEntry('https://demo.enfyra.io/api', 'secret-token'),
  );

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.servers.enfyra.type, 'stdio');
  assert.deepEqual(config.servers.enfyra.env, {
    ENFYRA_API_URL: 'https://demo.enfyra.io/api',
    ENFYRA_API_TOKEN: 'secret-token',
  });
});

test('manual Codex configuration documents optional compact tool mode', async () => {
  const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
  const readme = await readFile(readmePath, 'utf8');
  assert.match(readme, /\[mcp_servers\.enfyra\.env\][\s\S]*ENFYRA_API_URL/);
  assert.match(readme, /\[mcp_servers\.enfyra\.env\][\s\S]*ENFYRA_API_TOKEN/);
  assert.match(readme, /--compact-tools/);
  assert.match(readme, /--static-tools/);
});

test('ZCode config uses nested mcp.servers and preserves existing settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'enfyra-mcp-zcode-config-'));
  const configPath = join(root, '.zcode', 'config.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  await mergeZcodeConfig(
    configPath,
    buildServerEntry('http://localhost:3000/api', 'secret-token'),
  );

  let config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(config.mcp.servers.enfyra.env, EXPECTED_ENV);
  assert.deepEqual(config.mcp.servers.enfyra.args, ['-y', '@enfyra/mcp-server@latest']);

  // Merge again with existing advanced runtime env preserved
  await writeFile(configPath, JSON.stringify({
    mcp: {
      servers: {
        other: { command: 'other' },
        enfyra: {
          command: 'old',
          env: {
            ENFYRA_API_URL: 'http://old.test/api',
            ENFYRA_API_TOKEN: 'old-token',
            ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
          },
        },
      },
    },
    hooks: { enabled: true },
  }));

  await mergeZcodeConfig(
    configPath,
    buildServerEntry('http://localhost:3000/api', 'secret-token'),
  );

  config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(config.mcp.servers.enfyra.env, {
    ...EXPECTED_ENV,
    ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
  });
  assert.deepEqual(config.mcp.servers.other, { command: 'other' });
  assert.deepEqual(config.hooks, { enabled: true });
});
