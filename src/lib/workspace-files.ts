import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorkspacePaths } from './workspace-types.js';

export function sourceHash(source: string) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function workspaceTarget(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Workspace target must be an HTTP API URL without credentials, query or fragment.');
  return url.href.replace(/\/$/, '');
}

export function safeWorkspacePath(root: string, name: string) {
  try { if (lstatSync(root).isSymbolicLink()) throw new Error(`Workspace symlink is not allowed: ${root}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!name || isAbsolute(name) || name.includes('\\') || name.split('/').some((part) => part === '..' || part === '.' || !part)) throw new Error('Workspace path must be a relative path without traversal.');
  const target = resolve(root, name);
  if (!target.startsWith(`${root}${sep}`)) throw new Error('Workspace path is outside the project.');
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Workspace symlink is not allowed: ${current}`);
      if (current !== target && !stat.isDirectory()) throw new Error(`Workspace parent is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}

export function readWorkspaceFile(root: string, name: string): string | null {
  const file = safeWorkspacePath(root, name);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}

export function writeWorkspaceFile(root: string, name: string, content: string, expected?: string | null) {
  const file = safeWorkspacePath(root, name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  safeWorkspacePath(root, name);
  if (expected !== undefined && readWorkspaceFile(root, name) !== expected) throw new Error(`Local file changed while synchronizing: ${name}`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let mode = 0o600;
  try { mode = lstatSync(file).mode & 0o777; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const fd = openSync(temporary, 'wx', mode);
  try {
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
    safeWorkspacePath(root, name);
    if (expected !== undefined && readWorkspaceFile(root, name) !== expected) throw new Error(`Local file changed while synchronizing: ${name}`);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}

export function workspacePaths(projectRoot: string, target: string): WorkspacePaths {
  if (!isAbsolute(projectRoot)) throw new Error('projectRoot must be an absolute project directory.');
  const root = realpathSync(projectRoot);
  if (!lstatSync(root).isDirectory()) throw new Error('projectRoot must be a directory.');
  return {
    projectRoot: root,
    workspaceRoot: safeWorkspacePath(root, 'enfyra'),
    tempRoot: safeWorkspacePath(root, `.tmp/enfyra/${sourceHash(target).slice(0, 16)}/${process.pid}`),
    target,
    manifestPath: 'enfyra/.state/sync.json',
    planPath: 'enfyra/.state/push-plan.json',
  };
}

export function ensureWorkspaceIgnored(paths: WorkspacePaths) {
  const root = paths.projectRoot;
  const patterns = ['/enfyra/', '/.tmp/enfyra/'];
  let isRepository = false;
  try { execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { stdio: 'pipe' }); isRepository = true; }
  catch (error) {
    if (!(error as { stderr?: Buffer }).stderr?.toString().includes('not a git repository')) throw error;
  }
  if (isRepository) {
    const tracked = execFileSync('git', ['-C', root, 'ls-files', '--', 'enfyra', '.tmp/enfyra'], { encoding: 'utf8' });
    if (tracked.trim()) throw new Error('Workspace paths are already tracked by Git. Untrack them explicitly before preparing the workspace.');
  }
  const original = readWorkspaceFile(root, '.gitignore');
  const lines = (original ?? '').split(/\r?\n/);
  const missing = patterns.filter((pattern) => !lines.includes(pattern));
  if (missing.length) writeWorkspaceFile(root, '.gitignore', `${original ?? ''}${original && !original.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, original);
  if (isRepository) {
    for (const path of ['enfyra/project.json', '.tmp/enfyra/source.js']) execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', path], { stdio: 'pipe' });
  }
  return isRepository;
}

export async function withWorkspaceLock<T>(paths: WorkspacePaths, run: () => Promise<T>): Promise<T> {
  const lock = safeWorkspacePath(paths.projectRoot, 'enfyra/.state/workspace.lock');
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Workspace is locked by another operation. Retry when it finishes; inspect an abandoned lock before removing it.');
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return await run();
  } finally {
    try { closeSync(fd); } finally { rmSync(lock, { force: true }); }
  }
}
