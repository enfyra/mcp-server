import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_PREVIEW_CHARS = 1200;
const DEFAULT_INLINE_LIMIT = 1400;
const SOURCE_FIELD_NAMES = new Set([
  'sourceCode',
  'code',
  'compiledCode',
  'handlerScript',
  'connectionHandlerScript',
]);

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
  return '.js';
}

export function writeSourceArtifact({ tableName, id, fieldName, source }: SourceArtifactInput) {
  const hash = sha256(source);
  const dir = join(tmpdir(), 'enfyra-mcp-sources');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileName = [
    safePart(tableName),
    safePart(id),
    safePart(fieldName),
    hash.slice(0, 12),
  ].join('-') + extensionForField(fieldName);
  const path = join(dir, fileName);
  writeFileSync(path, source, { mode: 0o600 });
  return {
    tmpFile: path,
    length: source.length,
    sha256: hash,
    preview: source.length > DEFAULT_PREVIEW_CHARS
      ? `${source.slice(0, DEFAULT_PREVIEW_CHARS)}...`
      : source,
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
