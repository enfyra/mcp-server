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
    count: 96,
    hash: '8327bbf0edfeff6c2371a503e075a495d9064595f6b5e7f4da524656960dd087',
    maxTokens: 38000,
  },
  {
    name: 'guided-dynamic',
    env: {
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
    },
    count: 13,
    hash: '2f5f93c263df6c1ece14b6b6073ba1a8d804eb6772c177f2d7b9914433dd982d',
    maxTokens: 5000,
  },
  {
    name: 'guided-static',
    env: {
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'off',
    },
    count: 96,
    hash: '8327bbf0edfeff6c2371a503e075a495d9064595f6b5e7f4da524656960dd087',
    maxTokens: 38000,
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
