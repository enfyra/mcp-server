import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { countTokens } from 'gpt-tokenizer';

test('every profile and tool-loading override keeps one stable public gateway', async (t) => {
  let canonical;
  for (const profile of ['all', 'extension', 'schema', 'runtime', 'operations']) {
    for (const dynamic of [undefined, 'on', 'off']) {
      const env = {
        ...process.env,
        ENFYRA_API_URL: 'http://127.0.0.1:1/api',
        ENFYRA_API_TOKEN: 'manifest-fixture',
        ENFYRA_MCP_USAGE_DISABLE: '1',
        ENFYRA_MCP_PROFILE: profile,
      };
      if (dynamic === undefined) delete env.ENFYRA_MCP_DYNAMIC_TOOLS;
      else env.ENFYRA_MCP_DYNAMIC_TOOLS = dynamic;
      const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env, stderr: 'pipe' });
      const client = new Client({ name: 'gateway-manifest', version: '1.0.0' });
      try {
        await client.connect(transport);
        const { tools, nextCursor } = await client.listTools();
        assert.equal(nextCursor, undefined);
        assert.deepEqual(tools.map(({ name }) => name), ['enfyra']);
        assert.ok(tools[0].outputSchema);
        assert.equal(tools[0].annotations.readOnlyHint, false);
        assert.equal(tools[0].annotations.destructiveHint, true);
        if (canonical) assert.deepEqual(tools, canonical);
        else canonical = tools;
        const manifestTokens = countTokens(JSON.stringify(tools));
        const instructionTokens = countTokens(client.getInstructions() ?? '');
        assert.ok(manifestTokens < 1000, `manifest uses ${manifestTokens} tokens`);
        assert.ok(instructionTokens < 850, `instructions use ${instructionTokens} tokens`);
        const overview = await client.callTool({ name: 'enfyra', arguments: { action: 'discover' } });
        assert.notEqual(overview.isError, true);
        const exact = await client.callTool({ name: 'enfyra', arguments: { action: 'discover', query: 'get_enfyra_required_knowledge', limit: 1 } });
        assert.notEqual(exact.isError, true);
        assert.equal(exact.structuredContent.tools[0].name, 'get_enfyra_required_knowledge');
        assert.deepEqual((await client.listTools()).tools, tools);
        t.diagnostic(`${profile}/${dynamic ?? 'default'}: 1 tool; manifest=${manifestTokens} tokens; instructions=${instructionTokens} tokens`);
      } finally {
        await client.close();
      }
    }
  }
});
