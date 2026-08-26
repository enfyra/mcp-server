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
    count: 14,
    hash: 'f41073d5d1f040c1ddf9c1d08bc34599ce940f985f4be88e237a7ffa545b935e',
    maxTokens: 5000,
  },
  {
    name: 'guided-dynamic',
    env: {
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
    },
    count: 14,
    hash: 'f41073d5d1f040c1ddf9c1d08bc34599ce940f985f4be88e237a7ffa545b935e',
    maxTokens: 5000,
  },
  {
    name: 'guided-static',
    env: {
      ENFYRA_MCP_PROFILE: 'all',
      ENFYRA_MCP_DYNAMIC_TOOLS: 'off',
    },
    count: 105,
    hash: 'b30a2c1d952f6eb82a3cab03a915f6f01ff6374a44b875379d7dc510edee88ea',
    maxTokens: 40100,
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

test('dynamic workflow packs keep every one- or two-surface manifest below the tool cap', async () => {
  const env = {
    ...process.env,
    ENFYRA_MCP_PROFILE: 'all',
    ENFYRA_MCP_DYNAMIC_TOOLS: 'on',
  };
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'dynamic-tool-cap', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { WORKFLOW_SURFACES } = await import('../dist/lib/tool-routing.js');
    for (const surface of WORKFLOW_SURFACES) {
      await client.callTool({ name: 'select_enfyra_workflow', arguments: { surface, mode: 'replace' } });
      const oneSurface = await client.listTools();
      assert.ok(oneSurface.tools.length < 64, `${surface} exposes ${oneSurface.tools.length} tools`);

      for (const additionalSurface of WORKFLOW_SURFACES) {
        if (additionalSurface === surface) continue;
        await client.callTool({ name: 'select_enfyra_workflow', arguments: { surface: additionalSurface, mode: 'add' } });
        const twoSurfaces = await client.listTools();
        assert.ok(
          twoSurfaces.tools.length < 64,
          `${surface} + ${additionalSurface} exposes ${twoSurfaces.tools.length} tools`,
        );
        await client.callTool({ name: 'select_enfyra_workflow', arguments: { surface, mode: 'replace' } });
      }
    }
  } finally {
    await client.close();
  }
});
