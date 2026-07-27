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
      ENFYRA_MCP_TOOLSET: 'guided',
      ENFYRA_MCP_PROFILE: 'all',
    },
    unsetDynamic: true,
    count: 84,
    hash: '90f8f6bcf0bb91dce1cc7dfcf1f32e6b5b01863a860136e11225a3cbfc6d5fab',
    maxTokens: 34000,
  },
  {
    name: 'guided-dynamic',
    env: {
      ENFYRA_MCP_TOOLSET: 'guided',
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
    },
    count: 13,
    hash: 'd7cf661155fb22bf99377a11579d0264781ac364b0cb458c6272851532af8b36',
    maxTokens: 5000,
  },
  {
    name: 'guided-static',
    env: {
      ENFYRA_MCP_TOOLSET: 'guided',
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'off',
    },
    count: 84,
    hash: '90f8f6bcf0bb91dce1cc7dfcf1f32e6b5b01863a860136e11225a3cbfc6d5fab',
    maxTokens: 34000,
  },
  {
    name: 'full',
    env: {
      ENFYRA_MCP_TOOLSET: 'full',
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'off',
    },
    count: 133,
    hash: '70407a0d3d0fae8de40672ff7080a8edbf82331ec8c15af576c450a26f36a97e',
    maxTokens: 49000,
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
