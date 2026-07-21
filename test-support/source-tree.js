import { readdirSync, readFileSync } from 'node:fs';

const sourceRoot = new URL('../src/', import.meta.url);

function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) return collectTypeScriptFiles(child);
      return entry.name.endsWith('.ts') ? [child] : [];
    });
}

export function readSourceTree() {
  return collectTypeScriptFiles(sourceRoot)
    .sort((left, right) => left.pathname.localeCompare(right.pathname))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

export function readSourceFiles(...paths) {
  return paths
    .map((path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'))
    .join('\n');
}

function readLibModules(predicate) {
  return readdirSync(new URL('../src/lib/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && predicate(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => readSourceFiles(`lib/${entry.name}`))
    .join('\n');
}

export function readEntrySource() {
  const owners = new Set([
    'enfyra-mcp-server.ts', 'discovery-tools.ts', 'record-tools.ts', 'script-tools.ts',
    'method-tools.ts', 'route-tools.ts', 'route-inspection-tools.ts', 'route-definition-tools.ts',
    'route-access-tools.ts', 'system-tools.ts', 'log-tools.ts', 'identity-tools.ts', 'package-tools.ts',
    'tool-runtime-config.ts', 'tool-metadata-operations.ts', 'tool-permission-profile.ts',
    'tool-record-operations.ts', 'tool-script-operations.ts', 'tool-route-inspection.ts',
  ]);
  return readLibModules((name) => owners.has(name));
}

export const readPlatformSource = () => readLibModules((name) => name.startsWith('platform-') || name.startsWith('extension-'));
export const readSchemaSource = () => readLibModules((name) => name.startsWith('schema-') || name === 'table-tools.ts');
export const readRoutingSource = () => readLibModules((name) => name.startsWith('workflow-') || name === 'tool-routing.ts');
export const readExamplesSource = () => readLibModules((name) => name.startsWith('mcp-example'));
export const readRuntimeZoneSource = () => readLibModules((name) => name.startsWith('runtime-zone-'));

export function registeredToolNamesFromSource() {
  return new Set(
    [...readSourceTree().matchAll(/server\.tool\(\s*['"]([a-z0-9_]+)['"]/g)]
      .map((match) => match[1]),
  );
}
