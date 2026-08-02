import { stdin as input, stdout as output } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import {
  clients, deriveApiUrlFromAppUrl, deriveMeUrl, isCancelError, normalizeAppUrl,
  resolveDefaultAppUrl, style, type ClientKey, type ClientSelection, type ExistingEnv, type KeypressInfo,
  type ParsedArgs, type TargetChoice,
} from './config-local-contracts.js';
import { browserAuth } from './browser-auth.js';

type AuthMethod = 'paste' | 'browser';

type SelectChoice<T> = {
  label: string;
  hint: string;
  value: T;
};

async function promptSelect<T>(title: string, description: string, choices: SelectChoice<T>[], initialIndex = 0): Promise<T> {
  if (input.setRawMode && output.isTTY) {
    return promptSelectInteractive(title, description, choices, initialIndex);
  }

  const rl = createInterface({ input, output });
  const lines = choices.map((c, i) => `  [${i + 1}] ${c.label}  ${c.hint}`);
  const line = (await rl.question(
    `${title}\n${lines.join('\n')}\nChoice [1]: `,
  )).trim().toLowerCase();
  await rl.close();
  const idx = parseInt(line, 10);
  if (idx >= 1 && idx <= choices.length) return choices[idx - 1].value;
  return choices[0].value;
}

async function promptSelectInteractive<T>(title: string, description: string, choices: SelectChoice<T>[], initialIndex = 0): Promise<T> {
  let selected = Math.max(0, Math.min(initialIndex, choices.length - 1));
  let renderedLines = 0;

  const formatChoice = (choice: SelectChoice<T>, active: boolean) => {
    const indicator = active ? style.cyan('◆') : style.dim('◇');
    const accent = active ? style.cyan('│') : style.dim('│');
    const label = active ? style.bold(choice.label) : choice.label;
    const hint = active ? style.cyan(choice.hint) : style.dim(choice.hint);
    return `${accent} ${indicator} ${label}  ${hint}`;
  };

  const render = () => {
    if (renderedLines > 0) {
      output.write(`\x1B[${renderedLines}A\x1B[0J`);
    }
    const lines = [
      `${style.cyan('◆')} ${style.bold(title)}`,
      `${style.dim('│')} ${style.dim(description)}`,
      style.dim('│'),
      ...choices.map((choice, index) => formatChoice(choice, index === selected)),
      style.dim('│'),
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

export async function promptTargetChoice(): Promise<ClientSelection> {
  const choices: TargetChoice[] = [
    {
      client: 'codex',
      value: { claude: false, cursor: false, codex: true, vscode: false, antigravity: false, zcode: false },
    },
    {
      client: 'claude',
      value: { claude: true, cursor: false, codex: false, vscode: false, antigravity: false, zcode: false },
    },
    {
      client: 'cursor',
      value: { claude: false, cursor: true, codex: false, vscode: false, antigravity: false, zcode: false },
    },
    {
      client: 'vscode',
      value: { claude: false, cursor: false, codex: false, vscode: true, antigravity: false, zcode: false },
    },
    {
      client: 'antigravity',
      value: { claude: false, cursor: false, codex: false, vscode: false, antigravity: true, zcode: false },
    },
    {
      client: 'zcode',
      value: { claude: false, cursor: false, codex: false, vscode: false, antigravity: false, zcode: true },
    },
    {
      client: 'all',
      value: { claude: true, cursor: true, codex: true, vscode: true, antigravity: true, zcode: true },
    },
  ];
  if (input.setRawMode && output.isTTY) {
    return promptTargetSelect(choices, 6);
  }

  const rl = createInterface({ input, output });
  const line = (await rl.question(
    'Where should Enfyra MCP config be written?\n'
      + '  [1] Codex        ./.codex/config.toml\n'
      + '  [2] Claude Code  ./.mcp.json\n'
      + '  [3] Cursor       ./.cursor/mcp.json\n'
      + '  [4] VS Code      ./.vscode/mcp.json\n'
      + '  [5] Antigravity  ./.agents/mcp_config.json\n'
      + '  [6] ZCode        ./.zcode/config.json\n'
      + '  [7] All [default]\n'
      + 'Choice [7]: ',
  )).trim().toLowerCase();
  await rl.close();
  if (line === '' || line === '7' || line === 'all' || line === 'a') {
    return { claude: true, cursor: true, codex: true, vscode: true, antigravity: true, zcode: true };
  }
  if (line === '1' || line === 'codex' || line === 'x') {
    return { claude: false, cursor: false, codex: true, vscode: false, antigravity: false, zcode: false };
  }
  if (line === '2' || line === 'claude' || line === 'claude-code') {
    return { claude: true, cursor: false, codex: false, vscode: false, antigravity: false, zcode: false };
  }
  if (line === '3' || line === 'cursor' || line === 'u') {
    return { claude: false, cursor: true, codex: false, vscode: false, antigravity: false, zcode: false };
  }
  if (line === '4' || line === 'vscode' || line === 'vs-code' || line === 'copilot') {
    return { claude: false, cursor: false, codex: false, vscode: true, antigravity: false, zcode: false };
  }
  if (line === '5' || line === 'antigravity') {
    return { claude: false, cursor: false, codex: false, vscode: false, antigravity: true, zcode: false };
  }
  if (line === '6' || line === 'zcode' || line === 'z') {
    return { claude: false, cursor: false, codex: false, vscode: false, antigravity: false, zcode: true };
  }
  return { claude: true, cursor: true, codex: true, vscode: true, antigravity: true, zcode: true };
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
      const hint = active ? style.cyan('Codex + Claude Code + Cursor + VS Code + Antigravity + ZCode') : style.dim('Codex + Claude Code + Cursor + VS Code + Antigravity + ZCode');
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

  if (apiToken === undefined) {
    const defaultApiToken = opts.apiToken ?? process.env.ENFYRA_API_TOKEN ?? existing.apiToken ?? '';
    await rl.close();

    const authMethod = await promptSelect<AuthMethod>(
      'Authenticate',
      'How do you want to provide your API token?',
      [
        { label: 'Paste an existing token', hint: 'Enter a token you already have', value: 'paste' },
        { label: 'Open browser to create a new token', hint: 'Login in browser, auto-create', value: 'browser' },
      ],
    );

    if (authMethod === 'browser') {
      try {
        const result = await browserAuth(appUrl);
        apiToken = result.token;
        console.log(`${style.green('✓')} Token received from browser.`);
      } catch (err: any) {
        console.log(`${style.yellow('!')} ${err.message || 'Browser auth failed.'}`);
        console.log(`${style.dim('│')} Falling back to manual token entry.`);
        const rl2 = createInterface({ input, output });
        const line = (await rl2.question(`${style.dim('└')} ENFYRA_API_TOKEN: `)).trim();
        await rl2.close();
        apiToken = line || defaultApiToken;
      }
    } else {
      const rl2 = createInterface({ input, output });
      const q2 = async (msg: string) => {
        try {
          return await rl2.question(msg);
        } catch (error) {
          if (isCancelError(error)) throw new Error('Cancelled');
          throw error;
        }
      };
      const hint = defaultApiToken ? ' (Enter = keep current)' : '';
      const meUrl = deriveMeUrl(appUrl);
      console.log('');
      console.log(`${style.cyan('◆')} ${style.bold('API token')}`);
      console.log(`${style.dim('│')} Create a token here if needed: ${style.cyan(meUrl)}`);
      const line = (await q2(`${style.dim('└')} ENFYRA_API_TOKEN${hint}: `)).trim();
      apiToken = line !== '' ? line : defaultApiToken;
      await rl2.close();
    }
  }

  return { apiUrl, apiToken };
}

export function resolveNonInteractive(opts: ParsedArgs, existing: ExistingEnv) {
  const appUrl = resolveDefaultAppUrl(opts, existing);
  const apiUrl = deriveApiUrlFromAppUrl(appUrl);
  const apiToken = opts.apiToken ?? process.env.ENFYRA_API_TOKEN ?? existing.apiToken ?? '';
  return { apiUrl, apiToken };
}
