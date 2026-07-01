import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compactSourceFields, writeSourceArtifact } from '../dist/lib/source-artifacts.js';

test('writeSourceArtifact stores full source in tmp and returns compact metadata', () => {
  const source = 'export default ' + 'x'.repeat(1600);
  const artifact = writeSourceArtifact({
    tableName: 'enfyra_extension',
    id: 8,
    fieldName: 'code',
    source,
  });

  assert.match(artifact.tmpFile, /enfyra-mcp-sources/);
  assert.match(artifact.tmpFile, /\.vue$/);
  assert.equal(artifact.length, source.length);
  assert.equal(readFileSync(artifact.tmpFile, 'utf8'), source);
  assert.notEqual(artifact.preview, source);
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
