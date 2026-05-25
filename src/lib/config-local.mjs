import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin as input, stdout as output, cwd } from 'node:process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const SERVER_KEY = 'enfyra';

function printHelp() {
  console.log(`enfyra-mcp — write MCP config (Codex + Claude Code + Cursor)

Usage:
  npx @enfyra/mcp-server config [options]

Writes project config under the current working directory:
  • ./.mcp.json           — Claude Code project scope
  • ./.cursor/mcp.json    — Cursor project scope
  • ./.codex/config.toml  — Codex project scope

Options:
  --api-url, -a <url>     ENFYRA_API_URL
  --api-token, -t <secret> ENFYRA_API_TOKEN
  --global                Write global/user config for selected hosts instead of project config
  --reconfig              Always choose target again in interactive mode and replace the old enfyra config for that target
  --yes                   Non-interactive: no prompts (CI / scripts); use CLI, env, existing file, then defaults
  Target — non-interactive default is all; with TTY and no target flags, choose with ↑/↓:
  --claude-code, --claude, --claude-only   Only ./.mcp.json (Claude Code project scope)
  --cursor, --cursor-only                  Only ./.cursor/mcp.json (Cursor)
  --codex, --codex-only                    Only ./.codex/config.toml (Codex project scope)
  Passing multiple target flags writes each selected target.
  -h, --help              Show this help

Interactive mode: lets you choose Claude Code / Cursor / Codex / all if you did not pass target flags; then asks for URL / API token
  when missing. Existing project config is used as defaults. Re-run to update.

Examples:
  npx @enfyra/mcp-server config
  npx @enfyra/mcp-server config --claude-code
  npx @enfyra/mcp-server config --cursor --yes
  npx @enfyra/mcp-server config --codex --yes
  npx @enfyra/mcp-server config --global --codex
  npx @enfyra/mcp-server config --reconfig
  npx @enfyra/mcp-server config -a http://localhost:3000/api -t 'efy_pat_...'
  npx @enfyra/mcp-server config --yes
  ENFYRA_API_TOKEN=efy_pat_... npx @enfyra/mcp-server config --yes
`);
}

function parseArgs(argv) {
  const out = {
    apiUrl: undefined,
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
    else if (a === '--api-url' || a === '-a') out.apiUrl = next();
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

  const next = `${kept.join('\n').trimEnd()}\n\n${buildCodexTomlBlock(apiUrl, apiToken)}`;
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
      label: 'Claude Code — project ./.mcp.json',
      value: { claude: true, cursor: false, codex: false },
    },
    {
      label: 'Cursor — project ./.cursor/mcp.json',
      value: { claude: false, cursor: true, codex: false },
    },
    {
      label: 'Codex — project ./.codex/config.toml',
      value: { claude: false, cursor: false, codex: true },
    },
    {
      label: 'All',
      value: { claude: true, cursor: true, codex: true },
    },
  ];
  if (input.setRawMode && output.isTTY) {
    return promptTargetSelect(choices, 3);
  }

  const rl = createInterface({ input, output });
  const line = (await rl.question(
    'Where should Enfyra MCP config be written?\n'
      + '  [1] Claude Code — ./.mcp.json\n'
      + '  [2] Cursor — ./.cursor/mcp.json\n'
      + '  [3] Codex — ./.codex/config.toml\n'
      + '  [4] All [default]\n'
      + 'Choice [4]: ',
  )).trim().toLowerCase();
  await rl.close();
  if (line === '' || line === '4' || line === 'all' || line === 'a') {
    return { claude: true, cursor: true, codex: true };
  }
  if (line === '1' || line === 'c' || line === 'claude') {
    return { claude: true, cursor: false, codex: false };
  }
  if (line === '2' || line === 'u' || line === 'cursor') {
    return { claude: false, cursor: true, codex: false };
  }
  if (line === '3' || line === 'x' || line === 'codex') {
    return { claude: false, cursor: false, codex: true };
  }
  return { claude: true, cursor: true, codex: true };
}

async function promptTargetSelect(choices, initialIndex = 0) {
  let selected = Math.max(0, Math.min(initialIndex, choices.length - 1));
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) {
      output.write(`\x1B[${renderedLines}A\x1B[0J`);
    }
    const lines = [
      'Where should Enfyra MCP config be written?',
      ...choices.map((choice, index) => `${index === selected ? '›' : ' '} ${choice.label}`),
      '',
      'Use ↑/↓ to move, Enter to select.',
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
  let apiUrl = opts.apiUrl;
  let apiToken = opts.apiToken;
  if (apiUrl !== undefined && apiToken !== undefined) {
    return { apiUrl: String(apiUrl).replace(/\/$/, ''), apiToken };
  }

  const rl = createInterface({ input, output });
  const q = (msg) => rl.question(msg);

  const defaultUrl = (
    opts.apiUrl ??
    process.env.ENFYRA_API_URL ??
    (existing.apiUrl || undefined) ??
    'http://localhost:3000/api'
  ).replace(/\/$/, '');
  if (apiUrl === undefined) {
    const line = (await q(`ENFYRA_API_URL [${defaultUrl}]: `)).trim();
    apiUrl = line || defaultUrl;
  }
  apiUrl = String(apiUrl).replace(/\/$/, '');

  const defaultApiToken = opts.apiToken ?? process.env.ENFYRA_API_TOKEN ?? existing.apiToken ?? '';
  if (apiToken === undefined) {
    const hint = defaultApiToken ? ' (Enter = keep current)' : '';
    const line = (await q(`ENFYRA_API_TOKEN${hint}: `)).trim();
    apiToken = line !== '' ? line : defaultApiToken;
  }

  await rl.close();
  return { apiUrl, apiToken };
}

function resolveNonInteractive(opts, existing) {
  const apiUrl = (
    opts.apiUrl ??
    process.env.ENFYRA_API_URL ??
    (existing.apiUrl || undefined) ??
    'http://localhost:3000/api'
  ).replace(/\/$/, '');
  const apiToken = opts.apiToken ?? process.env.ENFYRA_API_TOKEN ?? existing.apiToken ?? '';
  return { apiUrl, apiToken };
}

export async function runLocalConfig(argv) {
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
  if (usePrompt) {
    const resolved = await promptConfig(opts, existing);
    apiUrl = resolved.apiUrl;
    apiToken = resolved.apiToken;
  } else {
    const resolved = resolveNonInteractive(opts, existing);
    apiUrl = resolved.apiUrl;
    apiToken = resolved.apiToken;
  }

  const serverEntry = buildServerEntry(apiUrl, apiToken);
  const written = [];

  if (writeClaude) {
    const p = getClaudeConfigPath(root, opts.global);
    await mergeMcpFile(p, serverEntry);
    written.push(p);
  }
  if (writeCursor) {
    const p = getCursorConfigPath(root, opts.global);
    await mergeMcpFile(p, serverEntry);
    written.push(p);
  }
  if (writeCodex) {
    const p = getCodexConfigPath(root, opts.global);
    await mergeCodexConfig(p, apiUrl, apiToken);
    written.push(p);
  }

  console.log('Enfyra MCP — local config updated:\n');
  for (const p of written) console.log(`  ${p}`);
  console.log('\nNext steps:');
  console.log('  • Codex: open this folder in a new Codex session so project ./.codex/config.toml is loaded.');
  console.log('  • Claude Code: open this folder; approve project MCP if prompted (`claude mcp reset-project-choices` to reset).');
  console.log('  • Cursor: open this folder, restart Cursor or reload MCP, then confirm server under Settings → MCP.');
  console.log('  • Run `config` again anytime to change values (same files are merged/overwritten for `enfyra`).');
  if (!apiToken) {
    console.log('\nWarning: ENFYRA_API_TOKEN is empty — tools will not authenticate until set.');
  }
}
