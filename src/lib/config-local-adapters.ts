import { execFile as execFileCallback } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { ExistingEnv, McpServerEntryOptions } from './config-local-contracts.js';

const SERVER_KEY = 'enfyra';
const MCP_PACKAGE_SPEC = '@enfyra/mcp-server@latest';
const PRIVATE_FILE_MODE = 0o600;
const execFile = promisify(execFileCallback);
type JsonRecord = Record<string, any>;
type ServerEntry = ReturnType<typeof buildServerEntry>;
const ADVANCED_RUNTIME_ENV_KEYS = [
  'ENFYRA_MCP_DYNAMIC_TOOLS',
  'ENFYRA_MCP_PROFILE',
] as const;

function advancedRuntimeEnv(env: unknown) {
  const source = env && typeof env === 'object' && !Array.isArray(env) ? env as JsonRecord : {};
  const result: JsonRecord = {};
  for (const key of ADVANCED_RUNTIME_ENV_KEYS) {
    if (typeof source[key] === 'string' && source[key]) result[key] = source[key];
  }
  return result;
}

function runtimeEnvForMode(options: McpServerEntryOptions = {}) {
  if (options.toolMode === 'compact') {
    return { ENFYRA_MCP_DYNAMIC_TOOLS: 'on' };
  }
  if (options.toolMode === 'static') {
    return { ENFYRA_MCP_DYNAMIC_TOOLS: 'off' };
  }
  return {};
}

function mergeServerEntry(existing: unknown, next: ServerEntry): ServerEntry {
  const existingEntry = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as JsonRecord
    : {};
  return {
    ...next,
    env: {
      ...advancedRuntimeEnv(existingEntry.env),
      ...next.env,
    },
  };
}

async function writePrivateFile(path: string, content: string) {
  await writeFile(path, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  await chmod(path, PRIVATE_FILE_MODE);
}

export async function ensureProjectConfigIgnored(root: string, paths: string[]) {
  const gitignorePath = join(root, '.gitignore');
  let gitignore = '';
  try {
    gitignore = await readFile(gitignorePath, 'utf8');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const existing = new Set(
    gitignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  );
  const entries = paths
    .map((path) => relative(root, path).split('\\').join('/'))
    .filter((path) => path && !existing.has(path));
  if (!entries.length) return;
  const prefix = gitignore && !gitignore.endsWith('\n') ? '\n' : '';
  await appendFile(gitignorePath, `${prefix}${entries.join('\n')}\n`, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
}

export async function assertProjectConfigUntracked(root: string, paths: string[]) {
  const entries = paths
    .map((path) => relative(root, path).split('\\').join('/'))
    .filter(Boolean);
  if (!entries.length) return;
  try {
    const { stdout } = await execFile('git', [
      '-C',
      root,
      'ls-files',
      '--',
      ...entries,
    ]);
    const tracked = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (tracked.length) {
      throw new Error(
        `Refusing to write tracked MCP config files: ${tracked.join(', ')}. Remove them from Git tracking before storing a token.`,
      );
    }
  } catch (error: any) {
    if (error?.code === 128) return;
    throw error;
  }
}

export function buildServerEntry(apiUrl: string, apiToken: string, options: McpServerEntryOptions = {}) {
  return {
    command: 'npx',
    args: ['-y', MCP_PACKAGE_SPEC],
    env: {
      ENFYRA_API_URL: apiUrl,
      ENFYRA_API_TOKEN: apiToken,
      ...runtimeEnvForMode(options),
    },
  };
}

export async function mergeMcpFile(absPath: string, serverEntry: ServerEntry) {
  let data: JsonRecord & { mcpServers: JsonRecord } = { mcpServers: {} };
  try {
    const raw = await readFile(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = { ...parsed, mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object' ? { ...parsed.mcpServers } : {} };
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  data.mcpServers = {
    ...data.mcpServers,
    [SERVER_KEY]: mergeServerEntry(data.mcpServers[SERVER_KEY], serverEntry),
  };
  const dir = dirname(absPath);
  await mkdir(dir, { recursive: true });
  await writePrivateFile(absPath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function mergeVscodeMcpFile(absPath: string, serverEntry: ServerEntry) {
  let data: JsonRecord & { servers: JsonRecord } = { servers: {} };
  try {
    const raw = await readFile(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      data = {
        ...parsed,
        servers: parsed.servers && typeof parsed.servers === 'object' ? { ...parsed.servers } : {},
      };
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  data.servers = {
    ...data.servers,
    [SERVER_KEY]: {
      type: 'stdio',
      ...mergeServerEntry(data.servers[SERVER_KEY], serverEntry),
    },
  };
  await mkdir(dirname(absPath), { recursive: true });
  await writePrivateFile(absPath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function mergeZcodeConfig(absPath: string, serverEntry: ServerEntry) {
  let data: JsonRecord = {};
  try {
    const raw = await readFile(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = { ...parsed };
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  const mcp = data.mcp && typeof data.mcp === 'object' && !Array.isArray(data.mcp) ? { ...data.mcp } : {};
  const servers = mcp.servers && typeof mcp.servers === 'object' && !Array.isArray(mcp.servers) ? { ...mcp.servers } : {};
  servers[SERVER_KEY] = mergeServerEntry(servers[SERVER_KEY], serverEntry);
  mcp.servers = servers;
  data.mcp = mcp;
  await mkdir(dirname(absPath), { recursive: true });
  await writePrivateFile(absPath, `${JSON.stringify(data, null, 2)}\n`);
}

function tomlString(value: unknown) {
  return JSON.stringify(String(value ?? ''));
}

function buildCodexTomlBlock(apiUrl: string, apiToken: string, runtimeEnv: JsonRecord = {}) {
  return [
    '[mcp_servers.enfyra]',
    'command = "npx"',
    `args = ["-y", "${MCP_PACKAGE_SPEC}"]`,
    '',
    '[mcp_servers.enfyra.env]',
    `ENFYRA_API_URL = ${tomlString(apiUrl)}`,
    `ENFYRA_API_TOKEN = ${tomlString(apiToken)}`,
    ...ADVANCED_RUNTIME_ENV_KEYS
      .filter((key) => typeof runtimeEnv[key] === 'string' && runtimeEnv[key])
      .map((key) => `${key} = ${tomlString(runtimeEnv[key])}`),
    '',
  ].join('\n');
}

export async function mergeCodexConfig(absPath: string, apiUrl: string, apiToken: string, options: McpServerEntryOptions = {}) {
  let raw = '';
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  const kept = [];
  let skip = false;
  for (const line of raw.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const section = header[1].trim();
      skip = section === 'mcp_servers.enfyra' || section.startsWith('mcp_servers.enfyra.');
    }
    if (!skip) kept.push(line);
  }

  const runtimeEnv = {
    ...readCodexAdvancedRuntimeEnv(raw),
    ...runtimeEnvForMode(options),
  };
  const prefix = kept.join('\n').trimEnd();
  const next = prefix ? `${prefix}\n\n${buildCodexTomlBlock(apiUrl, apiToken, runtimeEnv)}` : buildCodexTomlBlock(apiUrl, apiToken, runtimeEnv);
  await mkdir(dirname(absPath), { recursive: true });
  await writePrivateFile(absPath, next);
}

function parseTomlString(value: unknown) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.replace(/^['"]|['"]$/g, '');
  }
}

function readCodexAdvancedRuntimeEnv(raw: string) {
  const values: JsonRecord = {};
  let inEnv = false;
  for (const line of raw.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inEnv = header[1].trim() === 'mcp_servers.enfyra.env';
      continue;
    }
    if (!inEnv) continue;
    const pair = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!pair || !ADVANCED_RUNTIME_ENV_KEYS.includes(pair[1] as typeof ADVANCED_RUNTIME_ENV_KEYS[number])) continue;
    values[pair[1]] = parseTomlString(pair[2]);
  }
  return advancedRuntimeEnv(values);
}

async function readCodexEnfyraEnv(absPath: string): Promise<ExistingEnv | null> {
  try {
    const raw = await readFile(absPath, 'utf8');
    const values = { apiUrl: '', apiToken: '' };
    let inEnv = false;
    for (const line of raw.split(/\r?\n/)) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) {
        inEnv = header[1].trim() === 'mcp_servers.enfyra.env';
        continue;
      }
      if (!inEnv) continue;
      const pair = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (!pair) continue;
      const key = pair[1];
      const value = parseTomlString(pair[2]);
      if (key === 'ENFYRA_API_URL') values.apiUrl = value;
      if (key === 'ENFYRA_API_TOKEN') values.apiToken = value;
    }
    if (values.apiUrl || values.apiToken) return values;
  } catch {
    /* */
  }
  return null;
}

async function readZcodeEnfyraEnv(absPath: string): Promise<ExistingEnv | null> {
  try {
    const raw = await readFile(absPath, 'utf8');
    const j = JSON.parse(raw);
    const e = j?.mcp?.servers?.[SERVER_KEY]?.env;
    if (e && typeof e === 'object' && (e.ENFYRA_API_URL || e.ENFYRA_API_TOKEN)) {
      return {
        apiUrl: typeof e.ENFYRA_API_URL === 'string' ? e.ENFYRA_API_URL : '',
        apiToken: typeof e.ENFYRA_API_TOKEN === 'string' ? e.ENFYRA_API_TOKEN : '',
      };
    }
  } catch {
    /* */
  }
  return null;
}

function getCodexConfigPath(root: string) {
  return join(root, '.codex', 'config.toml');
}

function getClaudeConfigPath(root: string) {
  return join(root, '.mcp.json');
}

function getCursorConfigPath(root: string) {
  return join(root, '.cursor', 'mcp.json');
}

function getVscodeConfigPath(root: string) {
  return join(root, '.vscode', 'mcp.json');
}

function getAntigravityConfigPath(root: string) {
  return join(root, '.agents', 'mcp_config.json');
}

function getZcodeConfigPath(root: string) {
  return join(root, '.zcode', 'config.json');
}

export function getClientPath(client, root) {
  if (client === 'claude') return getClaudeConfigPath(root);
  if (client === 'cursor') return getCursorConfigPath(root);
  if (client === 'codex') return getCodexConfigPath(root);
  if (client === 'vscode') return getVscodeConfigPath(root);
  if (client === 'antigravity') return getAntigravityConfigPath(root);
  if (client === 'zcode') return getZcodeConfigPath(root);
  throw new Error(`Unknown MCP client: ${client}`);
}

async function readMcpServerEnv(absPath: string, serverRootKey: 'mcpServers' | 'servers'): Promise<ExistingEnv | null> {
  try {
    const raw = await readFile(absPath, 'utf8');
    const j = JSON.parse(raw);
    const e = j?.[serverRootKey]?.[SERVER_KEY]?.env;
    if (e && typeof e === 'object' && (e.ENFYRA_API_URL || e.ENFYRA_API_TOKEN)) {
      return {
        apiUrl: typeof e.ENFYRA_API_URL === 'string' ? e.ENFYRA_API_URL : '',
        apiToken: typeof e.ENFYRA_API_TOKEN === 'string' ? e.ENFYRA_API_TOKEN : '',
      };
    }
  } catch {
    /* */
  }
  return null;
}

export async function loadExistingEnfyraEnv(root: string, readClaude: boolean, readCursor: boolean, readCodex: boolean, readVscode: boolean, readAntigravity: boolean, readZcode: boolean): Promise<ExistingEnv> {
  const paths: Array<{ path: string; rootKey: 'mcpServers' | 'servers' }> = [];
  if (readClaude) paths.push({ path: getClaudeConfigPath(root), rootKey: 'mcpServers' });
  if (readCursor) paths.push({ path: getCursorConfigPath(root), rootKey: 'mcpServers' });
  if (!readClaude && readCursor) paths.push({ path: getClaudeConfigPath(root), rootKey: 'mcpServers' });
  if (readVscode) paths.push({ path: getVscodeConfigPath(root), rootKey: 'servers' });
  if (readAntigravity) paths.push({ path: getAntigravityConfigPath(root), rootKey: 'mcpServers' });
  const seen = new Set();
  for (const entry of paths) {
    const key = `${entry.rootKey}:${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const env = await readMcpServerEnv(entry.path, entry.rootKey);
    if (env) return env;
  }
  if (readZcode) {
    const zcode = await readZcodeEnfyraEnv(getZcodeConfigPath(root));
    if (zcode) return zcode;
  }
  if (readCodex) {
    const codex = await readCodexEnfyraEnv(getCodexConfigPath(root));
    if (codex) return codex;
  }
  return { apiUrl: '', apiToken: '' };
}
