import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import {
  clients, deriveApiUrlFromAppUrl, deriveMeUrl, isCancelError, normalizeAppUrl,
  resolveDefaultAppUrl, style, type ClientKey, type ClientSelection, type ExistingEnv, type KeypressInfo,
  type ParsedArgs, type TargetChoice,
} from './config-local-contracts.js';

export async function promptTargetChoice(): Promise<ClientSelection> {
  const choices: TargetChoice[] = [
    {
      client: 'codex',
      value: { claude: false, cursor: false, codex: true, vscode: false, antigravity: false },
    },
    {
      client: 'claude',
      value: { claude: true, cursor: false, codex: false, vscode: false, antigravity: false },
    },
    {
      client: 'cursor',
      value: { claude: false, cursor: true, codex: false, vscode: false, antigravity: false },
    },
    {
      client: 'vscode',
      value: { claude: false, cursor: false, codex: false, vscode: true, antigravity: false },
    },
    {
      client: 'antigravity',
      value: { claude: false, cursor: false, codex: false, vscode: false, antigravity: true },
    },
    {
      client: 'all',
      value: { claude: true, cursor: true, codex: true, vscode: true, antigravity: true },
    },
  ];
  if (input.setRawMode && output.isTTY) {
    return promptTargetSelect(choices, 5);
  }

  const rl = createInterface({ input, output });
  const line = (await rl.question(
    'Where should Enfyra MCP config be written?\n'
      + '  [1] Codex        ./.codex/config.toml\n'
      + '  [2] Claude Code  ./.mcp.json\n'
      + '  [3] Cursor       ./.cursor/mcp.json\n'
      + '  [4] VS Code      ./.vscode/mcp.json\n'
      + '  [5] Antigravity  ./.agents/mcp_config.json\n'
      + '  [6] All [default]\n'
      + 'Choice [6]: ',
  )).trim().toLowerCase();
  await rl.close();
  if (line === '' || line === '6' || line === 'all' || line === 'a') {
    return { claude: true, cursor: true, codex: true, vscode: true, antigravity: true };
  }
  if (line === '1' || line === 'codex' || line === 'x') {
    return { claude: false, cursor: false, codex: true, vscode: false, antigravity: false };
  }
  if (line === '2' || line === 'claude' || line === 'claude-code') {
    return { claude: true, cursor: false, codex: false, vscode: false, antigravity: false };
  }
  if (line === '3' || line === 'cursor' || line === 'u') {
    return { claude: false, cursor: true, codex: false, vscode: false, antigravity: false };
  }
  if (line === '4' || line === 'vscode' || line === 'vs-code' || line === 'copilot') {
    return { claude: false, cursor: false, codex: false, vscode: true, antigravity: false };
  }
  if (line === '5' || line === 'antigravity') {
    return { claude: false, cursor: false, codex: false, vscode: false, antigravity: true };
  }
  return { claude: true, cursor: true, codex: true, vscode: true, antigravity: true };
}

async function promptTargetSelect(choices: TargetChoice[], initialIndex = 0): Promise<ClientSelection> {
  let selected = Math.max(0, Math.min(initialIndex, choices.length - 1));
  let renderedLines = 0;

  const formatChoice = (choice: TargetChoice, active: boolean) => {
    const indicator = active ? style.cyan('◆') : style.dim('◇');
    const accent = active ? style.cyan('│') : style.dim('│');
    if (choice.client === 'all') {
      const label = active ? style.bold(style.underline('All supported clients')) : 'All supported clients';
      const paddedLabel = label + ' '.repeat(22 - 'All supported clients'.length);
      const hint = active ? style.cyan('Codex + Claude Code + Cursor + VS Code + Antigravity') : style.dim('Codex + Claude Code + Cursor + VS Code + Antigravity');
      return `${accent} ${indicator} ${paddedLabel} ${hint}`;
    }

    const meta = clients[choice.client as ClientKey];
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
    const onKeypress = (_str: string, key: KeypressInfo = {}) => {
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

export async function promptConfig(opts: ParsedArgs, existing: ExistingEnv) {
  let appUrl = opts.appUrl ? normalizeAppUrl(opts.appUrl) : '';
  let apiToken = opts.apiToken;
  if (appUrl && apiToken !== undefined) {
    return { apiUrl: deriveApiUrlFromAppUrl(appUrl), apiToken };
  }

  const rl = createInterface({ input, output });
  const q = async (msg: string) => {
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

export function resolveNonInteractive(opts: ParsedArgs, existing: ExistingEnv) {
  const appUrl = resolveDefaultAppUrl(opts, existing);
  const apiUrl = deriveApiUrlFromAppUrl(appUrl);
  const apiToken = opts.apiToken ?? process.env.ENFYRA_API_TOKEN ?? existing.apiToken ?? '';
  return { apiUrl, apiToken };
}
