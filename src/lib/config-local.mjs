import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output, cwd } from 'node:process';
import { dirname, join } from 'node:path';

const SERVER_KEY = 'enfyra';

function printHelp() {
  console.log(`enfyra-mcp — write local project MCP config (Claude Code + Cursor)

Usage:
  npx @enfyra/mcp-server config [options]

Writes only under the current working directory:
  • ./.mcp.json           — Claude Code project scope
  • ./.cursor/mcp.json    — Cursor project scope

Options:
  --api-url, -a <url>     ENFYRA_API_URL
  --email, -e <email>     ENFYRA_EMAIL
  --password, -p <secret> ENFYRA_PASSWORD
  --yes                   Non-interactive: no prompts (CI / scripts); use CLI, env, existing file, then defaults
  Target — non-interactive default is both; with TTY and no target flags, you are prompted [1]/[2]/[3]:
  --claude-code, --claude, --claude-only   Only ./.mcp.json (Claude Code project scope)
  --cursor, --cursor-only                  Only ./.cursor/mcp.json (Cursor)
  Passing both target flags writes both files.
  -h, --help              Show this help

Interactive mode: asks Claude Code vs Cursor vs both if you did not pass target flags; then asks for URL / email / password
  when missing. Existing ./.mcp.json and ./.cursor/mcp.json are used as defaults. Re-run to update.

Examples:
  npx @enfyra/mcp-server config
  npx @enfyra/mcp-server config --claude-code
  npx @enfyra/mcp-server config --cursor --yes
  npx @enfyra/mcp-server config -a http://localhost:3000/api -e admin@x.com -p 'secret'
  npx @enfyra/mcp-server config --yes
  ENFYRA_PASSWORD=secret npx @enfyra/mcp-server config --yes -e admin@x.com
`);
}

function parseArgs(argv) {
  const out = {
    apiUrl: undefined,
    email: undefined,
    password: undefined,
    claude: true,
    cursor: true,
    help: false,
    yes: false,
  };
  let pickClaude = false;
  let pickCursor = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v == null) throw new Error(`Missing value after ${a}`);
      i += 1;
      return v;
    };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--api-url' || a === '-a') out.apiUrl = next();
    else if (a === '--email' || a === '-e') out.email = next();
    else if (a === '--password' || a === '-p') out.password = next();
    else if (a === '--claude-only' || a === '--claude-code' || a === '--claude') pickClaude = true;
    else if (a === '--cursor-only' || a === '--cursor') pickCursor = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  out.targetExplicit = pickClaude || pickCursor;
  if (pickClaude || pickCursor) {
    if (pickClaude && pickCursor) {
      out.claude = true;
      out.cursor = true;
    } else if (pickClaude) {
      out.claude = true;
      out.cursor = false;
    } else {
      out.claude = false;
      out.cursor = true;
    }
  }
  return out;
}

function buildServerEntry(apiUrl, email, password) {
  return {
    command: 'npx',
    args: ['-y', '@enfyra/mcp-server'],
    env: {
      ENFYRA_API_URL: apiUrl,
      ENFYRA_EMAIL: email,
      ENFYRA_PASSWORD: password,
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

async function loadExistingEnfyraEnv(root, readClaude, readCursor) {
  const paths = [];
  if (readClaude) paths.push(join(root, '.mcp.json'));
  if (readCursor) paths.push(join(root, '.cursor', 'mcp.json'));
  if (!readClaude && readCursor) paths.push(join(root, '.mcp.json'));
  const seen = new Set();
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      const raw = await readFile(p, 'utf8');
      const j = JSON.parse(raw);
      const e = j?.mcpServers?.[SERVER_KEY]?.env;
      if (e && typeof e === 'object' && (e.ENFYRA_API_URL || e.ENFYRA_EMAIL || e.ENFYRA_PASSWORD)) {
        return {
          apiUrl: typeof e.ENFYRA_API_URL === 'string' ? e.ENFYRA_API_URL : '',
          email: typeof e.ENFYRA_EMAIL === 'string' ? e.ENFYRA_EMAIL : '',
          password: typeof e.ENFYRA_PASSWORD === 'string' ? e.ENFYRA_PASSWORD : '',
        };
      }
    } catch {
      /* */
    }
  }
  return { apiUrl: '', email: '', password: '' };
}

async function promptTargetChoice() {
  const rl = createInterface({ input, output });
  const line = (await rl.question(
    'Where should Enfyra MCP config be written?\n'
      + '  [1] Claude Code — ./.mcp.json\n'
      + '  [2] Cursor — ./.cursor/mcp.json\n'
      + '  [3] Both [default]\n'
      + 'Choice [3]: ',
  )).trim().toLowerCase();
  await rl.close();
  if (line === '' || line === '3' || line === 'both' || line === 'b') {
    return { claude: true, cursor: true };
  }
  if (line === '1' || line === 'c' || line === 'claude') {
    return { claude: true, cursor: false };
  }
  if (line === '2' || line === 'u' || line === 'cursor') {
    return { claude: false, cursor: true };
  }
  return { claude: true, cursor: true };
}

async function promptConfig(opts, existing) {
  let apiUrl = opts.apiUrl;
  let email = opts.email;
  let password = opts.password;
  if (apiUrl !== undefined && email !== undefined && password !== undefined) {
    return { apiUrl: String(apiUrl).replace(/\/$/, ''), email, password };
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

  const defaultEmail = opts.email ?? process.env.ENFYRA_EMAIL ?? existing.email ?? '';
  if (email === undefined) {
    const hint = defaultEmail ? `[${defaultEmail}]` : '[empty]';
    const line = (await q(`ENFYRA_EMAIL ${hint}: `)).trim();
    email = line || defaultEmail;
  }

  const defaultPass = opts.password ?? process.env.ENFYRA_PASSWORD ?? existing.password ?? '';
  if (password === undefined) {
    const hint = existing.password ? '(Enter = keep current)' : '(optional)';
    const line = (await q(`ENFYRA_PASSWORD ${hint}: `)).trim();
    password = line !== '' ? line : defaultPass;
  }

  await rl.close();
  return { apiUrl, email, password };
}

function resolveNonInteractive(opts, existing) {
  const apiUrl = (
    opts.apiUrl ??
    process.env.ENFYRA_API_URL ??
    (existing.apiUrl || undefined) ??
    'http://localhost:3000/api'
  ).replace(/\/$/, '');
  const email = opts.email ?? process.env.ENFYRA_EMAIL ?? existing.email ?? '';
  const password = opts.password ?? process.env.ENFYRA_PASSWORD ?? existing.password ?? '';
  return { apiUrl, email, password };
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
  if (usePrompt && !opts.targetExplicit) {
    const t = await promptTargetChoice();
    writeClaude = t.claude;
    writeCursor = t.cursor;
  }

  const existing = await loadExistingEnfyraEnv(root, true, true);

  let apiUrl;
  let email;
  let password;
  if (usePrompt) {
    const resolved = await promptConfig(opts, existing);
    apiUrl = resolved.apiUrl;
    email = resolved.email;
    password = resolved.password;
  } else {
    const resolved = resolveNonInteractive(opts, existing);
    apiUrl = resolved.apiUrl;
    email = resolved.email;
    password = resolved.password;
  }

  const serverEntry = buildServerEntry(apiUrl, email, password);
  const written = [];

  if (writeClaude) {
    const p = join(root, '.mcp.json');
    await mergeMcpFile(p, serverEntry);
    written.push(p);
  }
  if (writeCursor) {
    const p = join(root, '.cursor', 'mcp.json');
    await mergeMcpFile(p, serverEntry);
    written.push(p);
  }

  console.log('Enfyra MCP — local config updated:\n');
  for (const p of written) console.log(`  ${p}`);
  console.log('\nNext steps:');
  console.log('  • Claude Code: open this folder; approve project MCP if prompted (`claude mcp reset-project-choices` to reset).');
  console.log('  • Cursor: restart Cursor or reload MCP; confirm server under Settings → MCP.');
  console.log('  • Run `config` again anytime to change values (same files are merged/overwritten for `enfyra`).');
  if (!email || !password) {
    console.log('\nWarning: ENFYRA_EMAIL or ENFYRA_PASSWORD is empty — tools may not authenticate until set.');
  }
}
