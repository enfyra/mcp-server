import { stdin as input, stdout as output } from 'node:process';
import type { ClientKey, ExistingEnv, ParsedArgs } from './config-local-types.js';
export type { ChoiceClientKey, ClientKey, ClientSelection, ExistingEnv, KeypressInfo, ParsedArgs, TargetChoice } from './config-local-types.js';

const forceColor = process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== '0';
const canStyle = forceColor || (output.isTTY && process.env.NO_COLOR == null);
export const style = {
  bold: (value: string) => canStyle ? `\x1B[1m${value}\x1B[22m` : value,
  dim: (value: string) => canStyle ? `\x1B[2m${value}\x1B[22m` : value,
  cyan: (value: string) => canStyle ? `\x1B[36m${value}\x1B[39m` : value,
  green: (value: string) => canStyle ? `\x1B[32m${value}\x1B[39m` : value,
  magenta: (value: string) => canStyle ? `\x1B[35m${value}\x1B[39m` : value,
  blue: (value: string) => canStyle ? `\x1B[34m${value}\x1B[39m` : value,
  yellow: (value: string) => canStyle ? `\x1B[33m${value}\x1B[39m` : value,
  underline: (value: string) => canStyle ? `\x1B[4m${value}\x1B[24m` : value,
  inverse: (value: string) => canStyle ? `\x1B[7m${value}\x1B[27m` : value,
};
export const clients: Record<ClientKey, { label: string; path: string; color: (value: string) => string }> = {
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
  vscode: {
    label: 'VS Code / Copilot',
    path: './.vscode/mcp.json',
    color: style.blue,
  },
  antigravity: {
    label: 'Antigravity',
    path: './.agents/mcp_config.json',
    color: style.yellow,
  },
};

export function statusIcon(kind: 'success' | 'warn' | string) {
  if (kind === 'success') return canStyle ? style.green('✓') : 'Done';
  if (kind === 'warn') return canStyle ? style.yellow('!') : 'Warning';
  return canStyle ? style.cyan('•') : '-';
}

export function isCancelError(error: unknown) {
  const item = error as { code?: unknown; message?: unknown };
  return item?.code === 'ABORT_ERR' || (item?.message || '') === 'Cancelled';
}

export function exitCancelled() {
  console.log('\nCancelled.');
  process.exit(130);
}

export function printHelp() {
  console.log(`${style.bold('Enfyra MCP config')}
${style.dim('Write project-local MCP client config for Enfyra.')}

${style.bold('Usage')}
  npx @enfyra/mcp-server@latest config [options]

${style.bold('Supported clients')}
  Codex        ./.codex/config.toml
  Claude Code  ./.mcp.json
  Cursor       ./.cursor/mcp.json
  VS Code      ./.vscode/mcp.json
  Antigravity  ./.agents/mcp_config.json

${style.bold('Options')}
  --app-url <url>          Enfyra app/admin URL, for example https://demo.enfyra.io
  --api-token, -t <secret>  ENFYRA_API_TOKEN
  --reconfig              Always choose target again in interactive mode and replace the old enfyra config for that target
  --yes                   Non-interactive: no prompts (CI / scripts); use CLI, env, existing file, then defaults

${style.bold('Client selection')}
  Non-interactive default is all supported clients. In a TTY with no target flags, choose with ↑/↓.

  --claude-code, --claude, --claude-only   Only ./.mcp.json (Claude Code project scope)
  --cursor, --cursor-only                  Only ./.cursor/mcp.json (Cursor)
  --codex, --codex-only                    Only ./.codex/config.toml (Codex project scope)
  --vscode, --copilot, --vscode-only       Only ./.vscode/mcp.json (VS Code / Copilot)
  --antigravity, --antigravity-only        Only ./.agents/mcp_config.json (Antigravity)
  Passing multiple target flags writes each selected target.

  -h, --help              Show this help

${style.bold('Interactive mode')}
  Choose Codex, Claude Code, Cursor, VS Code, Antigravity, or all clients; then enter ENFYRA_APP_URL and ENFYRA_API_TOKEN.
  Existing Enfyra config and environment variables are used as defaults. Re-run anytime to update.

${style.bold('Examples')}
  npx @enfyra/mcp-server@latest config
  npx @enfyra/mcp-server@latest config --yes
  npx @enfyra/mcp-server@latest config --codex --cursor
  npx @enfyra/mcp-server@latest config --vscode
  npx @enfyra/mcp-server@latest config --antigravity
  npx @enfyra/mcp-server@latest config --claude-code
  npx @enfyra/mcp-server@latest config --reconfig
  npx @enfyra/mcp-server@latest config --app-url http://localhost:3000 -t 'efy_pat_...'
  ENFYRA_APP_URL=https://demo.enfyra.io ENFYRA_API_TOKEN=efy_pat_... npx @enfyra/mcp-server@latest config --yes
`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    appUrl: undefined,
    apiToken: undefined,
    claude: true,
    cursor: true,
    codex: true,
    help: false,
    yes: false,
    reconfig: false,
    vscode: true,
    antigravity: true,
    targetExplicit: false,
  };
  let pickClaude = false;
  let pickCursor = false;
  let pickCodex = false;
  let pickVscode = false;
  let pickAntigravity = false;
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
    else if (a === '--vscode-only' || a === '--vscode' || a === '--copilot') pickVscode = true;
    else if (a === '--antigravity-only' || a === '--antigravity') pickAntigravity = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  out.targetExplicit = pickClaude || pickCursor || pickCodex || pickVscode || pickAntigravity;
  if (out.targetExplicit) {
    out.claude = pickClaude;
    out.cursor = pickCursor;
    out.codex = pickCodex;
    out.vscode = pickVscode;
    out.antigravity = pickAntigravity;
  }
  return out;
}

export function normalizeAppUrl(appUrl: unknown) {
  const raw = String(appUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.replace(/\/(?:api|enfyra)$/i, '') || raw;
}

export function deriveApiUrlFromAppUrl(appUrl: unknown) {
  const normalized = normalizeAppUrl(appUrl);
  return normalized ? `${normalized}/api` : 'http://localhost:3000/api';
}

export function deriveAppUrlFromApiUrl(apiUrl: unknown) {
  return normalizeAppUrl(apiUrl);
}

export function deriveMeUrl(appUrl: unknown) {
  const normalized = normalizeAppUrl(appUrl);
  return normalized ? `${normalized}/me` : '/me';
}

export function resolveDefaultAppUrl(opts: ParsedArgs, existing: ExistingEnv) {
  const appCandidate = opts.appUrl ?? process.env.ENFYRA_APP_URL;
  if (appCandidate) return normalizeAppUrl(appCandidate);
  const apiCandidate = process.env.ENFYRA_API_URL ?? existing.apiUrl;
  if (apiCandidate) return deriveAppUrlFromApiUrl(apiCandidate);
  return 'http://localhost:3000';
}
