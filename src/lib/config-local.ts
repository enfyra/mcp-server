import { stdin as input, stdout as output, cwd } from 'node:process';
import {
  clients, exitCancelled, isCancelError, parseArgs, printHelp, statusIcon, style, type ParsedArgs,
} from './config-local-contracts.js';
import {
  assertProjectConfigUntracked, buildServerEntry, ensureProjectConfigIgnored, getClientPath,
  loadExistingEnfyraEnv, mergeCodexConfig, mergeMcpFile, mergeVscodeMcpFile,
} from './config-local-adapters.js';
import { promptConfig, promptTargetChoice, resolveNonInteractive } from './config-local-prompts.js';

export async function runLocalConfig(argv: string[]) {
  const onSigint = () => exitCancelled();
  const onUnhandledRejection = (error: unknown) => {
    if (isCancelError(error)) exitCancelled();
  };
  const onUncaughtException = (error: unknown) => {
    if (isCancelError(error)) exitCancelled();
    throw error;
  };
  process.once('SIGINT', onSigint);
  process.once('unhandledRejection', onUnhandledRejection);
  process.once('uncaughtException', onUncaughtException);

  let opts: ParsedArgs;
  try {
    opts = parseArgs(argv);
  } catch (e: any) {
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
  let writeVscode = opts.vscode;
  let writeAntigravity = opts.antigravity;
  if (usePrompt && (!opts.targetExplicit || opts.reconfig)) {
    const t = await promptTargetChoice();
    writeClaude = t.claude;
    writeCursor = t.cursor;
    writeCodex = t.codex;
    writeVscode = t.vscode;
    writeAntigravity = t.antigravity;
  }

  const existing = await loadExistingEnfyraEnv(root, writeClaude, writeCursor, writeCodex, writeVscode, writeAntigravity);

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
  } catch (error: any) {
    if (isCancelError(error)) {
      exitCancelled();
      return;
    }
    throw error;
  }

  const serverEntry = buildServerEntry(apiUrl, apiToken);
  const written = [];
  const selectedPaths = [
    ...(writeCodex ? [getClientPath('codex', root)] : []),
    ...(writeClaude ? [getClientPath('claude', root)] : []),
    ...(writeCursor ? [getClientPath('cursor', root)] : []),
    ...(writeVscode ? [getClientPath('vscode', root)] : []),
    ...(writeAntigravity ? [getClientPath('antigravity', root)] : []),
  ];
  await assertProjectConfigUntracked(root, selectedPaths);

  if (writeCodex) {
    const p = getClientPath('codex', root);
    await mergeCodexConfig(p, apiUrl, apiToken);
    written.push({ client: 'codex', path: p });
  }
  if (writeClaude) {
    const p = getClientPath('claude', root);
    await mergeMcpFile(p, serverEntry);
    written.push({ client: 'claude', path: p });
  }
  if (writeCursor) {
    const p = getClientPath('cursor', root);
    await mergeMcpFile(p, serverEntry);
    written.push({ client: 'cursor', path: p });
  }
  if (writeVscode) {
    const p = getClientPath('vscode', root);
    await mergeVscodeMcpFile(p, serverEntry);
    written.push({ client: 'vscode', path: p });
  }
  if (writeAntigravity) {
    const p = getClientPath('antigravity', root);
    await mergeMcpFile(p, serverEntry);
    written.push({ client: 'antigravity', path: p });
  }

  await ensureProjectConfigIgnored(root, written.map((entry) => entry.path));

  console.log(`${statusIcon('success')} ${style.bold(style.green('Enfyra MCP config updated'))} ${style.dim('(project)')}\n`);
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
  if (selectedClients.has('vscode')) {
    console.log('  - VS Code / Copilot: run MCP: List Servers or reload the workspace, then start the Enfyra server if prompted.');
  }
  if (selectedClients.has('antigravity')) {
    console.log('  - Antigravity: reopen the workspace or reload MCP servers so ./.agents/mcp_config.json is picked up.');
  }
  console.log('  - Re-run this command anytime to update the same Enfyra entries.');
  if (!apiToken) {
    console.log(`\n${statusIcon('warn')} ${style.yellow('ENFYRA_API_TOKEN is empty; tools will not authenticate until it is set.')}`);
  }
  process.off('SIGINT', onSigint);
  process.off('unhandledRejection', onUnhandledRejection);
  process.off('uncaughtException', onUncaughtException);
}
