import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { countTokens } from 'gpt-tokenizer';

const BASELINES = [
  {
    name: 'guided-default',
    env: {
      ENFYRA_MCP_PROFILE: 'all',
    },
    unsetDynamic: true,
    count: 13,
    hash: 'ac48d885d6a6a35ce43c8ee30267c31517ef82521200fc92758115211e71f6d8',
    maxTokens: 5000,
  },
  {
    name: 'guided-dynamic',
    env: {
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
    },
    count: 13,
    hash: 'ac48d885d6a6a35ce43c8ee30267c31517ef82521200fc92758115211e71f6d8',
    maxTokens: 5000,
  },
  {
    name: 'guided-static',
    env: {
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'off',
    },
    count: 107,
    hash: 'ff782fa3a67c2457a05f253aa9e7fed407101c1904e185b22b0f423946dca315',
    maxTokens: 41000,
  },
];

async function readManifest(baseline) {
  const env = { ...process.env, ...baseline.env };
  if (baseline.unsetDynamic) delete env.ENFYRA_MCP_DYNAMIC_TOOLS;
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'tool-manifest-parity', version: '1.0.0' });
  await client.connect(transport);
  try {
    const page = await client.listTools();
    const tools = [...page.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, description, inputSchema, outputSchema, annotations }) => ({
        name,
        description,
        inputSchema,
        outputSchema,
        annotations,
      }));
    const serialized = JSON.stringify(tools);
    return {
      count: tools.length,
      hash: createHash('sha256').update(serialized).digest('hex'),
      tokenizerTokens: countTokens(serialized),
    };
  } finally {
    await client.close();
  }
}

for (const baseline of BASELINES) {
  test(`tool manifest remains stable for ${baseline.name}`, async () => {
    const manifest = await readManifest(baseline);
    assert.deepEqual({ count: manifest.count, hash: manifest.hash }, {
      count: baseline.count,
      hash: baseline.hash,
    });
    assert.ok(
      manifest.tokenizerTokens <= baseline.maxTokens,
      `${baseline.name} tool manifest uses ${manifest.tokenizerTokens} tokens; budget is ${baseline.maxTokens}`,
    );
  });
}

test('the default compact catalog manifest remains safely below the host tool cap', async () => {
  const manifest = await readManifest(BASELINES[0]);
  assert.ok(manifest.count < 64, `default manifest exposes ${manifest.count} tools`);
  assert.ok(manifest.tokenizerTokens < 5000, `default manifest uses ${manifest.tokenizerTokens} tokens`);
});
