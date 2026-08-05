import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cleanupMcpTempFiles,
} from '../dist/lib/cleanup.js';
import {
  readSourceArtifactFile,
  writeSourceArtifact,
} from '../dist/lib/source-artifacts.js';

test('cleanup removes MCP source artifacts and known telemetry files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'enfyra-mcp-cleanup-test-'));
  const usageDir = join(root, 'usage');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(usageDir, { recursive: true });
  await Promise.all([
    writeFile(join(usageDir, 'usage-2026-08-05.jsonl'), 'usage\n'),
    writeFile(join(usageDir, 'upload-2026-08-05-123.jsonl'), 'upload\n'),
    writeFile(join(usageDir, 'state.json'), '{}'),
    writeFile(join(usageDir, 'keep.txt'), 'unrelated\n'),
  ]);

  const artifact = writeSourceArtifact({
    tableName: 'enfyra_extension',
    id: 8,
    fieldName: 'code',
    source: '<template>cleanup</template>',
  });

  const result = cleanupMcpTempFiles({ usageDir });

  assert.equal(result.sourceArtifacts.removed, true);
  assert.equal(result.usageFiles.removedFiles, 3);
  assert.equal(existsSync(artifact.tmpFile), false);
  assert.equal(existsSync(join(usageDir, 'keep.txt')), true);
  await assert.rejects(readFile(join(usageDir, 'usage-2026-08-05.jsonl')));
  assert.throws(
    () => readSourceArtifactFile(artifact.tmpFile),
    /Source artifact file is unavailable/,
  );
});
