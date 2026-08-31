import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SOURCE_ARTIFACT_DIR,
  compactSourceFields,
  materializeSourceInput,
  normalizeExtensionSourceArgs,
  readSourceArtifactFile,
  readSourceArtifactResource,
  resolveSourceInput,
  writeSourceArtifact,
} from '../dist/lib/source-artifacts.js';

test('writeSourceArtifact stores full source in tmp and returns compact metadata', () => {
  const source = 'export default ' + 'x'.repeat(1600);
  const artifact = writeSourceArtifact({
    tableName: 'enfyra_extension',
    id: 8,
    fieldName: 'code',
    source,
  });

  assert.match(artifact.tmpFile, /enfyra-mcp-sources/);
  assert.match(SOURCE_ARTIFACT_DIR, new RegExp(`enfyra-mcp-sources[/\\\\]${process.pid}$`));
  assert.match(artifact.tmpFile, /\.vue$/);
  assert.match(artifact.resourceUri, /^enfyra-source:\/\/artifact\//);
  assert.equal(artifact.length, source.length);
  assert.equal(readFileSync(artifact.tmpFile, 'utf8'), source);
  assert.equal(readSourceArtifactFile(artifact.tmpFile), source);
  assert.equal(resolveSourceInput({ sourceFile: artifact.tmpFile, fieldName: 'sourceCode' }), source);
  assert.equal(resolveSourceInput({ sourceResourceUri: artifact.resourceUri, fieldName: 'sourceCode' }), source);
  const resource = readSourceArtifactResource(artifact.resourceUri);
  assert.equal(resource.text, source);
  assert.equal(resource.mimeType, 'text/x-vue');
  assert.notEqual(artifact.preview, source);
  assert.ok(artifact.preview.length <= 600);
});

test('source input accepts public code and sourceCode aliases without weakening exclusivity', () => {
  assert.equal(resolveSourceInput({ code: 'hook code', fieldName: 'sourceCode' }), 'hook code');
  assert.equal(resolveSourceInput({ sourceCode: 'script code', fieldName: 'sourceCode' }), 'script code');
  assert.throws(
    () => resolveSourceInput({ source: 'inline', code: 'alias', fieldName: 'sourceCode' }),
    /exactly one/,
  );
});

test('source input ignores blank artifact fields from weak clients', () => {
  assert.equal(resolveSourceInput({
    sourceCode: 'valid source',
    sourceFile: '',
    sourceResourceUri: '  ',
    fieldName: 'sourceCode',
  }), 'valid source');
});

test('extension source serialization keeps exactly one selected source field', () => {
  const artifact = writeSourceArtifact({ tableName: 'enfyra_extension', id: 9, fieldName: 'code', source: '<template />' });
  assert.deepEqual(normalizeExtensionSourceArgs({ code: '<template />', description: 'x' }), { code: '<template />', description: 'x' });
  assert.deepEqual(normalizeExtensionSourceArgs({ sourceFile: artifact.tmpFile, description: 'x' }), { sourceFile: artifact.tmpFile, description: 'x' });
  assert.deepEqual(normalizeExtensionSourceArgs({ sourceResourceUri: artifact.resourceUri, description: 'x' }), { sourceResourceUri: artifact.resourceUri, description: 'x' });
  assert.deepEqual(normalizeExtensionSourceArgs({ code: '', sourceFile: artifact.tmpFile }), { sourceFile: artifact.tmpFile });
});

test('extension source serialization rejects ambiguous source fields', () => {
  const artifact = writeSourceArtifact({ tableName: 'enfyra_extension', id: 10, fieldName: 'code', source: '<template />' });
  for (const input of [
    { code: '<template />', sourceFile: artifact.tmpFile },
    { code: '<template />', sourceResourceUri: artifact.resourceUri },
    { sourceFile: artifact.tmpFile, sourceResourceUri: artifact.resourceUri },
  ]) assert.throws(() => normalizeExtensionSourceArgs(input), /exactly one/);
  assert.throws(() => resolveSourceInput({ fieldName: 'code' }), /Provide exactly one of code, sourceFile, or sourceResourceUri/);
});

test('source input rejects arbitrary files and ambiguous inline/artifact inputs', () => {
  assert.throws(
    () => readSourceArtifactFile('/tmp/not-an-enfyra-artifact.js'),
    /Source artifact file is unavailable/,
  );
  assert.throws(
    () => resolveSourceInput({ source: 'inline', sourceFile: '/tmp/not-an-enfyra-artifact.js', fieldName: 'sourceCode' }),
    /exactly one/,
  );
  assert.throws(
    () => resolveSourceInput({ sourceCode: 'inline', sourceResourceUri: 'enfyra-source://artifact/real', fieldName: 'sourceCode' }),
    /exactly one/,
  );
});

test('materializeSourceInput makes inline and artifact inputs follow one tmp-file path', () => {
  const original = writeSourceArtifact({ tableName: 'enfyra_flow_step', id: 9, fieldName: 'sourceCode', source: 'return 9;' });
  const materialized = materializeSourceInput({
    sourceFile: original.tmpFile,
    fieldName: 'sourceCode',
    tableName: 'enfyra_flow_step',
    id: 9,
  });
  assert.match(materialized.sourceArtifact.tmpFile, /enfyra-mcp-sources/);
  assert.equal(readSourceArtifactFile(materialized.sourceArtifact.tmpFile), 'return 9;');
  assert.equal(materialized.source, 'return 9;');
});

test('compactSourceFields replaces long source fields with tmp artifact references', () => {
  const source = '<template>' + 'a'.repeat(1800) + '</template>';
  const compacted = compactSourceFields({
    id: 42,
    name: 'CloudProjectDetail',
    code: source,
    nested: { sourceCode: source },
  }, { tableName: 'enfyra_extension' });

  assert.equal(compacted.name, 'CloudProjectDetail');
  assert.equal(compacted.code.length, source.length);
  assert.equal(readFileSync(compacted.code.tmpFile, 'utf8'), source);
  assert.equal(compacted.nested.sourceCode.length, source.length);
  assert.equal(readFileSync(compacted.nested.sourceCode.tmpFile, 'utf8'), source);
});
