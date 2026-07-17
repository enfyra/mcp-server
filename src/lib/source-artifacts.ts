import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_PREVIEW_CHARS = 480;
const DEFAULT_INLINE_LIMIT = 1400;
const SOURCE_FIELD_NAMES = new Set([
  'sourceCode',
  'code',
  'compiledCode',
  'handlerScript',
  'connectionHandlerScript',
]);
const SOURCE_ARTIFACTS = new Map<string, { path: string; mimeType: string }>();

type SourceArtifactInput = {
  tableName?: string;
  id: string | number;
  fieldName: string;
  source: string;
};

type CompactSourceFieldsOptions = {
  tableName?: string;
  idField?: string;
  alwaysWrite?: boolean;
};

function sha256(value: string) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function safePart(value: unknown) {
  const source = String(value || 'source').trim();
  return source.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'source';
}

function extensionForField(fieldName: string) {
  if (fieldName === 'code') return '.vue';
  if (fieldName.endsWith('.diff') || fieldName === 'diff') return '.diff';
  return '.js';
}

function mimeTypeForExtension(extension: string) {
  if (extension === '.vue') return 'text/x-vue';
  if (extension === '.diff') return 'text/x-diff';
  return 'text/javascript';
}

function artifactId(tableName: string | undefined, id: string | number, fieldName: string, hash: string) {
  return [safePart(tableName), safePart(id), safePart(fieldName), hash.slice(0, 16)].join('-');
}

export function writeSourceArtifact({ tableName, id, fieldName, source }: SourceArtifactInput) {
  const hash = sha256(source);
  const extension = extensionForField(fieldName);
  const dir = join(tmpdir(), 'enfyra-mcp-sources');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileName = [
    safePart(tableName),
    safePart(id),
    safePart(fieldName),
    hash.slice(0, 12),
  ].join('-') + extension;
  const path = join(dir, fileName);
  writeFileSync(path, source, { mode: 0o600 });
  const resourceId = artifactId(tableName, id, fieldName, hash);
  const resourceUri = `enfyra-source://artifact/${encodeURIComponent(resourceId)}`;
  SOURCE_ARTIFACTS.set(resourceId, { path, mimeType: mimeTypeForExtension(extension) });
  return {
    resourceUri,
    tmpFile: path,
    length: source.length,
    sha256: hash,
    preview: source.length > DEFAULT_PREVIEW_CHARS
      ? `${source.slice(0, DEFAULT_PREVIEW_CHARS)}...`
      : source,
  };
}

export function readSourceArtifactResource(resourceUri: string) {
  let resourceId = '';
  try {
    const uri = new URL(resourceUri);
    if (uri.protocol !== 'enfyra-source:' || uri.hostname !== 'artifact') throw new Error('unsupported URI');
    resourceId = decodeURIComponent(uri.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('Invalid Enfyra source artifact URI.');
  }
  const artifact = SOURCE_ARTIFACTS.get(resourceId);
  if (!artifact) throw new Error('Source artifact is unavailable in this MCP process. Inspect the live artifact again to create a fresh resource URI.');
  return {
    uri: resourceUri,
    mimeType: artifact.mimeType,
    text: readFileSync(artifact.path, 'utf8'),
  };
}

export function compactSourceField({ tableName, id, fieldName, source, alwaysWrite = false }: SourceArtifactInput & { alwaysWrite?: boolean }) {
  if (typeof source !== 'string') return source;
  if (!alwaysWrite && source.length <= DEFAULT_INLINE_LIMIT) return source;
  return writeSourceArtifact({ tableName, id, fieldName, source });
}

export function compactSourceFields(value: unknown, { tableName, idField = 'id', alwaysWrite = false }: CompactSourceFieldsOptions = {}): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactSourceFields(item, { tableName, idField, alwaysWrite }));
  }
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const recordId = String(record[idField] ?? record._id ?? record.id ?? 'record');
  const out: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(record)) {
    if (SOURCE_FIELD_NAMES.has(key) && typeof fieldValue === 'string') {
      out[key] = compactSourceField({
        tableName,
        id: recordId,
        fieldName: key,
        source: fieldValue,
        alwaysWrite,
      });
    } else if (fieldValue && typeof fieldValue === 'object') {
      out[key] = compactSourceFields(fieldValue, { tableName, idField, alwaysWrite });
    } else {
      out[key] = fieldValue;
    }
  }
  return out;
}
