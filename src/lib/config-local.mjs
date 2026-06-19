import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin as input, stdout as output, cwd } from 'node:process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const SERVER_KEY = 'enfyra';
const forceColor = process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== '0';
const canStyle = forceColor || (output.isTTY && process.env.NO_COLOR == null);
const style = {
  bold: value => canStyle ? `\x1B[1m${value}\x1B[22m` : value,
  dim: value => canStyle ? `\x1B[2m${value}\x1B[22m` : value,
  cyan: value => canStyle ? `\x1B[36m${value}\x1B[39m` : value,
  green: value => canStyle ? `\x1B[32m${value}\x1B[39m` : value,
  magenta: value => canStyle ? `\x1B[35m${value}\x1B[39m` : value,
  blue: value => canStyle ? `\x1B[34m${value}\x1B[39m` : value,
  yellow: value => canStyle ? `\x1B[33m${value}\x1B[39m` : value,
  underline: value => canStyle ? `\x1B[4m${value}\x1B[24m` : value,
  inverse: value => canStyle ? `\x1B[7m${value}\x1B[27m` : value,
};

const clients = {
  codex: {
    label: 'Codex',
    path: './.codex/config.toml',
    color: style.green,
  },
  claude: {
    label: 'Claude Code',
    path: './.mcp.json',
    color: style.magenta,
  },
  cursor: {
    label: 'Cursor',
    path: './.cursor/mcp.json',
    color: style.cyan,
  },
};

function statusIcon(kind) {
  if (kind === 'success') return canStyle ? style.green('✓') : 'Done';
  if (kind === 'warn') return canStyle ? style.yellow('!') : 'Warning';
  return canStyle ? style.cyan('•') : '-';
}

function isCancelError(error) {
  return error?.code === 'ABORT_ERR' || (error?.message || '') === 'Cancelled';
}

function exitCancelled() {
  console.log('\nCancelled.');
  process.exit(130);
}

function printHelp() {
  console.log(`${style.bold('Enfyra MCP config')}
${style.dim('Write local MCP client config for Enfyra.')}

${style.bold('Usage')}
  npx @enfyra/mcp-server config [options]

${style.bold('Supported clients')}
  Codex        ./.codex/config.toml
  Claude Code  ./.mcp.json
  Cursor       ./.cursor/mcp.json
  Other MCP hosts can use the shared stdio JSON from the README.

${style.bold('Options')}
  --app-url <url>          Enfyra app/admin URL, for example https://demo.enfyra.io
  --api-token, -t <secret>  ENFYRA_API_TOKEN
  --global                Write global/user config for selected clients instead of project config
  --reconfig              Always choose target again in interactive mode and replace the old enfyra config for that target
  --yes                   Non-interactive: no prompts (CI / scripts); use CLI, env, existing file, then defaults

${style.bold('Client selection')}
  Non-interactive default is all supported clients. In a TTY with no target flags, choose with ↑/↓.

  --claude-code, --claude, --claude-only   Only ./.mcp.json (Claude Code project scope)
  --cursor, --cursor-only                  Only ./.cursor/mcp.json (Cursor)
  --codex, --codex-only                    Only ./.codex/config.toml (Codex project scope)
  Passing multiple target flags writes each selected target.

  -h, --help              Show this help

${style.bold('Interactive mode')}
  Choose Codex, Claude Code, Cursor, or all clients; then enter ENFYRA_APP_URL and ENFYRA_API_TOKEN.
  Existing Enfyra config and environment variables are used as defaults. Re-run anytime to update.

${style.bold('Examples')}
  npx @enfyra/mcp-server config
  npx @enfyra/mcp-server config --yes
  npx @enfyra/mcp-server config --codex --cursor
  npx @enfyra/mcp-server config --claude-code
  npx @enfyra/mcp-server config --global --codex
  npx @enfyra/mcp-server config --reconfig
  npx @enfyra/mcp-server config --app-url http://localhost:3000 -t 'efy_pat_...'
  ENFYRA_APP_URL=https://demo.enfyra.io ENFYRA_API_TOKEN=efy_pat_... npx @enfyra/mcp-server config --yes
`);
}

function parseArgs(argv) {
  const out = {
    appUrl: undefined,
    apiToken: undefined,
    claude: true,
    cursor: true,
    codex: true,
    help: false,
    yes: false,
    reconfig: false,
    global: false,
  };
  let pickClaude = false;
  let pickCursor = false;
  let pickCodex = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v == null) throw new Error(`Missing value after ${a}`);
      i += 1;
      return v;
    };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === 'help') out.help = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--reconfig') out.reconfig = true;
    else if (a === '--global') out.global = true;
    else if (a === '--app-url') out.appUrl = next();
    else if (a === '--api-url' || a === '-a') {
      throw new Error(`${a} is no longer supported for setup; use --app-url instead`);
    }
    else if (a === '--api-token' || a === '-t') out.apiToken = next();
    else if (a === '--email' || a === '-e' || a === '--password' || a === '-p') {
      throw new Error(`${a} is no longer supported; use --api-token instead`);
    }
    else if (a === '--claude-only' || a === '--claude-code' || a === '--claude') pickClaude = true;
    else if (a === '--cursor-only' || a === '--cursor') pickCursor = true;
    else if (a === '--codex-only' || a === '--codex') pickCodex = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  out.targetExplicit = pickClaude || pickCursor || pickCodex;
  if (out.targetExplicit) {
    out.claude = pickClaude;
    out.cursor = pickCursor;
    out.codex = pickCodex;
  }
  return out;
}

function buildServerEntry(apiUrl, apiToken) {
  return {
    command: 'npx',
    args: ['-y', '@enfyra/mcp-server'],
    env: {
      ENFYRA_API_URL: apiUrl,
      ENFYRA_API_TOKEN: apiToken,
    },
  };
}

function normalizeAppUrl(appUrl) {
  const raw = String(appUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.replace(/\/(?:api|enfyra)$/i, '') || raw;
}

function deriveApiUrlFromAppUrl(appUrl) {
  const normalized = normalizeAppUrl(appUrl);
  return normalized ? `${normalized}/api` : 'http://localhost:3000/api';
}

function deriveAppUrlFromApiUrl(apiUrl) {
  return normalizeAppUrl(apiUrl);
}

function deriveMeUrl(appUrl) {
  const normalized = normalizeAppUrl(appUrl);
  return normalized ? `${normalized}/me` : '/me';
}

function resolveDefaultAppUrl(opts, existing) {
  const appCandidate = opts.appUrl ?? process.env.ENFYRA_APP_URL;
  if (appCandidate) return normalizeAppUrl(appCandidate);
  const apiCandidate = process.env.ENFYRA_API_URL ?? existing.apiUrl;
  if (apiCandidate) return deriveAppUrlFromApiUrl(apiCandidate);
  return 'http://localhost:3000';
}

async function mergeMcpFile(absPath, serverEntry) {
  let data = { mcpServers: {} };
  try {
    const raw = await readFile(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      data.mcpServers = { ...parsed.mcpServers };
    } else if (parsed && typeof parsed === 'object') {
      data = { ...parsed, mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object' ? { ...parsed.mcpServers } : {} };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  data.mcpServers = { ...data.mcpServers, [SERVER_KEY]: serverEntry };
  const dir = dirname(absPath);
  await mkdir(dir, { recursive: true });
  await writeFile(absPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function buildCodexTomlBlock(apiUrl, apiToken) {
  return [
    '[mcp_servers.enfyra]',
    'command = "npx"',
    'args = ["-y", "@enfyra/mcp-server"]',
    '',
    '[mcp_servers.enfyra.env]',
    `ENFYRA_API_URL = ${tomlString(apiUrl)}`,
    `ENFYRA_API_TOKEN = ${tomlString(apiToken)}`,
    '',
  ].join('\n');
}

async function mergeCodexConfig(absPath, apiUrl, apiToken) {
  let raw = '';
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (e) {
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

  const prefix = kept.join('\n').trimEnd();
  const next = prefix ? `${prefix}\n\n${buildCodexTomlBlock(apiUrl, apiToken)}` : buildCodexTomlBlock(apiUrl, apiToken);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, next, 'utf8');
}

function parseTomlString(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.replace(/^['"]|['"]$/g, '');
  }
}

async function readCodexEnfyraEnv(absPath) {
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

function getCodexConfigPath(root, globalScope) {
  return globalScope ? join(homedir(), '.codex', 'config.toml') : join(root, '.codex', 'config.toml');
}

function getClaudeConfigPath(root, globalScope) {
  return globalScope ? join(homedir(), '.mcp.json') : join(root, '.mcp.json');
}

function getCursorConfigPath(root, globalScope) {
  return globalScope ? join(homedir(), '.cursor', 'mcp.json') : join(root, '.cursor', 'mcp.json');
}

function getClientPath(client, root, globalScope) {
  if (client === 'claude') return getClaudeConfigPath(root, globalScope);
  if (client === 'cursor') return getCursorConfigPath(root, globalScope);
  if (client === 'codex') return getCodexConfigPath(root, globalScope);
  throw new Error(`Unknown MCP client: ${client}`);
}

async function loadExistingEnfyraEnv(root, readClaude, readCursor, readCodex, globalScope) {
  const paths = [];
  if (readClaude) paths.push(getClaudeConfigPath(root, globalScope));
  if (readCursor) paths.push(getCursorConfigPath(root, globalScope));
  if (!globalScope && !readClaude && readCursor) paths.push(join(root, '.mcp.json'));
  const seen = new Set();
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      const raw = await readFile(p, 'utf8');
      const j = JSON.parse(raw);
      const e = j?.mcpServers?.[SERVER_KEY]?.env;
      if (e && typeof e === 'object' && (e.ENFYRA_API_URL || e.ENFYRA_API_TOKEN)) {
        return {
          apiUrl: typeof e.ENFYRA_API_URL === 'string' ? e.ENFYRA_API_URL : '',
          apiToken: typeof e.ENFYRA_API_TOKEN === 'string' ? e.ENFYRA_API_TOKEN : '',
        };
      }
    } catch {
      /* */
    }
  }
  if (readCodex) {
    const codex = await readCodexEnfyraEnv(getCodexConfigPath(root, globalScope));
    if (codex) return codex;
  }
  return { apiUrl: '', apiToken: '' };
}

async function promptTargetChoice() {
  const choices = [
    {
      client: 'codex',
      value: { claude: false, cursor: false, codex: true },
    },
    {
      client: 'claude',
      value: { claude: true, cursor: false, codex: false },
    },
    {
      client: 'cursor',
      value: { claude: false, cursor: true, codex: false },
    },
    {
      client: 'all',
      value: { claude: true, cursor: true, codex: true },
    },
  ];
  if (input.setRawMode && output.isTTY) {
    return promptTargetSelect(choices, 3);
  }

  const rl = createInterface({ input, output });
  const line = (await rl.question(
    'Where should Enfyra MCP config be written?\n'
      + '  [1] Codex        ./.codex/config.toml\n'
      + '  [2] Claude Code  ./.mcp.json\n'
      + '  [3] Cursor       ./.cursor/mcp.json\n'
      + '  [4] All [default]\n'
      + 'Choice [4]: ',
  )).trim().toLowerCase();
  await rl.close();
  if (line === '' || line === '4' || line === 'all' || line === 'a') {
    return { claude: true, cursor: true, codex: true };
  }
  if (line === '1' || line === 'codex' || line === 'x') {
    return { claude: false, cursor: false, codex: true };
  }
  if (line === '2' || line === 'claude' || line === 'claude-code') {
    return { claude: true, cursor: false, codex: false };
  }
  if (line === '3' || line === 'cursor' || line === 'u') {
    return { claude: false, cursor: true, codex: false };
  }
  return { claude: true, cursor: true, codex: true };
}

async function promptTargetSelect(choices, initialIndex = 0) {
  let selected = Math.max(0, Math.min(initialIndex, choices.length - 1));
  let renderedLines = 0;

  const formatChoice = (choice, active) => {
    const indicator = active ? style.cyan('◆') : style.dim('◇');
    const accent = active ? style.cyan('│') : style.dim('│');
    if (choice.client === 'all') {
      const label = active ? style.bold(style.underline('All supported clients')) : 'All supported clients';
      const paddedLabel = label + ' '.repeat(22 - 'All supported clients'.length);
      const hint = active ? style.cyan('Codex + Claude Code + Cursor') : style.dim('Codex + Claude Code + Cursor');
      return `${accent} ${indicator} ${paddedLabel} ${hint}`;
    }

    const meta = clients[choice.client];
    const label = active ? style.bold(meta.color(meta.label)) : meta.color(meta.label);
    const paddedLabel = label + ' '.repeat(Math.max(1, 22 - meta.label.length));
    const path = active ? style.cyan(meta.path) : style.dim(meta.path);
    return `${accent} ${indicator} ${paddedLabel} ${path}`;
  };

  const render = () => {
    if (renderedLines > 0) {
      output.write(`\x1B[${renderedLines}A\x1B[0J`);
    }
    const lines = [
      `${style.cyan('◆')} ${style.bold('Enfyra MCP setup')}`,
      `${style.dim('│')} ${style.dim('Choose where to write the project config.')}`,
      style.dim('│'),
      ...choices.map((choice, index) => formatChoice(choice, index === selected)),
      style.dim('│'),
      style.dim('Choose one client config, or write all supported project configs.'),
      `${style.dim('└')} ${style.dim('Use ↑/↓ to move, Enter to select, Ctrl+C to cancel.')}`,
    ];
    renderedLines = lines.length;
    output.write(`${lines.join('\n')}\n`);
  };

  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    const cleanup = () => {
      input.off('keypress', onKeypress);
      if (!wasRaw) input.setRawMode(false);
      output.write('\x1B[?25h');
    };
    const finish = () => {
      cleanup();
      resolve(choices[selected].value);
    };
    const onKeypress = (_str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        output.write('\n');
        reject(new Error('Cancelled'));
        return;
      }
      if (key.name === 'up') {
        selected = selected <= 0 ? choices.length - 1 : selected - 1;
        render();
        return;
      }
      if (key.name === 'down') {
        selected = selected >= choices.length - 1 ? 0 : selected + 1;
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
      }
    };

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write('\x1B[?25l');
    input.on('keypress', onKeypress);
    render();
  });
}

async function promptConfig(opts, existing) {
  let appUrl = opts.appUrl ? normalizeAppUrl(opts.appUrl) : '';
  let apiToken = opts.apiToken;
  if (appUrl && apiToken !== undefined) {
    return { apiUrl: deriveApiUrlFromAppUrl(appUrl), apiToken };
  }

  const rl = createInterface({ input, output });
  const q = async (msg) => {
    try {
      return await rl.question(msg);
    } catch (error) {
      if (isCancelError(error)) {
        throw new Error('Cancelled');
      }
      throw error;
    }
  };

  const defaultAppUrl = resolveDefaultAppUrl(opts, existing);
  if (!appUrl) {
    console.log(`${style.cyan('◆')} ${style.bold('Connect to Enfyra')}`);
    console.log(`${style.dim('│')} Enter the Enfyra app URL.`);
    const line = (await q(`${style.dim('└')} ENFYRA_APP_URL ${style.dim(`[${defaultAppUrl}]`)}: `)).trim();
    appUrl = normalizeAppUrl(line || defaultAppUrl);
  }
  const apiUrl = deriveApiUrlFromAppUrl(appUrl);

  const defaultApiToken = opts.apiToken ?? process.env.ENFYRA_API_TOKEN ?? existing.apiToken ?? '';
  if (apiToken === undefined) {
    const hint = defaultApiToken ? ' (Enter = keep current)' : '';
    const meUrl = deriveMeUrl(appUrl);
    console.log('');
    console.log(`${style.cyan('◆')} ${style.bold('API token')}`);
    console.log(`${style.dim('│')} If you do not have a token yet, create one here: ${style.cyan(meUrl)}`);
    const line = (await q(`${style.dim('└')} ENFYRA_API_TOKEN${hint}: `)).trim();
    apiToken = line !== '' ? line : defaultApiToken;
  }

  await rl.close();
  return { apiUrl, apiToken };
}

function resolveNonInteractive(opts, existing) {
  const appUrl = resolveDefaultAppUrl(opts, existing);
  const apiUrl = deriveApiUrlFromAppUrl(appUrl);
  const apiToken = opts.apiToken ?? process.env.ENFYRA_API_TOKEN ?? existing.apiToken ?? '';
  return { apiUrl, apiToken };
}

export async function runLocalConfig(argv) {
  const onSigint = () => exitCancelled();
  const onUnhandledRejection = (error) => {
    if (isCancelError(error)) exitCancelled();
  };
  const onUncaughtException = (error) => {
    if (isCancelError(error)) exitCancelled();
    throw error;
  };
  process.once('SIGINT', onSigint);
  process.once('unhandledRejection', onUnhandledRejection);
  process.once('uncaughtException', onUncaughtException);

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message || e);
    printHelp();
    process.exit(1);
    return;
  }
  if (opts.help) {
    printHelp();
    return;
  }

  const root = cwd();
  const usePrompt = !opts.yes && input.isTTY && output.isTTY;

  let writeClaude = opts.claude;
  let writeCursor = opts.cursor;
  let writeCodex = opts.codex;
  if (usePrompt && (!opts.targetExplicit || opts.reconfig)) {
    const t = await promptTargetChoice();
    writeClaude = t.claude;
    writeCursor = t.cursor;
    writeCodex = t.codex;
  }

  const existing = await loadExistingEnfyraEnv(root, writeClaude, writeCursor, writeCodex, opts.global);

  let apiUrl;
  let apiToken;
  try {
    if (usePrompt) {
      const resolved = await promptConfig(opts, existing);
      apiUrl = resolved.apiUrl;
      apiToken = resolved.apiToken;
    } else {
      const resolved = resolveNonInteractive(opts, existing);
      apiUrl = resolved.apiUrl;
      apiToken = resolved.apiToken;
    }
  } catch (error) {
    if (isCancelError(error)) {
      exitCancelled();
      return;
    }
    throw error;
  }

  const serverEntry = buildServerEntry(apiUrl, apiToken);
  const written = [];

  if (writeCodex) {
    const p = getClientPath('codex', root, opts.global);
    await mergeCodexConfig(p, apiUrl, apiToken);
    written.push({ client: 'codex', path: p });
  }
  if (writeClaude) {
    const p = getClientPath('claude', root, opts.global);
    await mergeMcpFile(p, serverEntry);
    written.push({ client: 'claude', path: p });
  }
  if (writeCursor) {
    const p = getClientPath('cursor', root, opts.global);
    await mergeMcpFile(p, serverEntry);
    written.push({ client: 'cursor', path: p });
  }

  const scopeLabel = opts.global ? 'global/user' : 'project';
  console.log(`${statusIcon('success')} ${style.bold(style.green('Enfyra MCP config updated'))} ${style.dim(`(${scopeLabel})`)}\n`);
  for (const entry of written) {
    const meta = clients[entry.client];
    console.log(`  ${style.cyan('•')} ${style.bold(meta.color(meta.label))}`);
    console.log(`    ${style.dim(entry.path)}`);
  }

  const selectedClients = new Set(written.map(entry => entry.client));
  console.log(`\n${style.bold(style.blue('Next steps'))}`);
  if (selectedClients.has('codex')) {
    console.log('  - Codex: open this folder in a new Codex session and approve the project MCP config if prompted.');
  }
  if (selectedClients.has('claude')) {
    console.log('  - Claude Code: open this folder; approve project MCP if prompted.');
  }
  if (selectedClients.has('cursor')) {
    console.log('  - Cursor: restart Cursor or reload MCP, then confirm the server under Settings -> MCP.');
  }
  console.log('  - Re-run this command anytime to update the same Enfyra entries.');
  if (!apiToken) {
    console.log(`\n${statusIcon('warn')} ${style.yellow('ENFYRA_API_TOKEN is empty; tools will not authenticate until it is set.')}`);
  }
  process.off('SIGINT', onSigint);
  process.off('unhandledRejection', onUnhandledRejection);
  process.off('uncaughtException', onUncaughtException);
}
