import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASELINES = [
  {
    name: 'guided-dynamic',
    env: {
      ENFYRA_MCP_TOOLSET: 'guided',
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
    },
    count: 13,
    hash: 'a309d4289cb5d8559f61b058c8492ecdbc6b84236e79411b4712a613d90c328b',
  },
  {
    name: 'guided-static',
    env: {
      ENFYRA_MCP_TOOLSET: 'guided',
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'off',
    },
    count: 84,
    hash: 'd8c13cc29d91f143fb82b79db9a27d4ef7f06c121825a6594e61d9436eb915b7',
  },
  {
    name: 'full',
    env: {
      ENFYRA_MCP_TOOLSET: 'full',
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'off',
    },
    count: 132,
    hash: '7275e319cebf5255c7949d7d0c57534b9663707f878c7aacbf46a52e763e0e7c',
  },
];

async function readManifest(baseline) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: { ...process.env, ...baseline.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'tool-manifest-parity', version: '1.0.0' });
  await client.connect(transport);
  try {
    const page = await client.listTools();
    const tools = [...page.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, description, inputSchema, annotations }) => ({
        name,
        description,
        inputSchema,
        annotations,
      }));
    const serialized = JSON.stringify(tools);
    return {
      count: tools.length,
      hash: createHash('sha256').update(serialized).digest('hex'),
    };
  } finally {
    await client.close();
  }
}

for (const baseline of BASELINES) {
  test(`tool manifest remains stable for ${baseline.name}`, async () => {
    const manifest = await readManifest(baseline);
    assert.deepEqual(manifest, {
      count: baseline.count,
      hash: baseline.hash,
    });
  });
}
