import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { parse as parseEnv } from 'dotenv';
import { countTokens } from 'gpt-tokenizer';
import { WORKFLOW_SURFACES, workflowToolNames } from '../dist/lib/tool-routing.js';
import { isToolVisibleInToolset } from '../dist/lib/toolset-filter.js';

const rootEnvPath = fileURLToPath(new URL('../../.codex/.env', import.meta.url));
const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const rootEnv = parseEnv(readFileSync(rootEnvPath));
const reportPath = '/tmp/enfyra-mcp-p2-eval.json';
const profiles = ['all', 'extension', 'schema', 'runtime', 'operations'];

function parseToolResult(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (result.isError) throw new Error(text || 'MCP tool returned an error result.');
  if (!text) throw new Error('MCP tool returned no text content.');
  return JSON.parse(text);
}

async function connect(toolset, profile) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      ...rootEnv,
      ENFYRA_MCP_TOOLSET: toolset,
      ENFYRA_MCP_PROFILE: profile,
      ENFYRA_MCP_USAGE_DISABLE: '1',
    },
    stderr: 'inherit',
  });
  const client = new Client({ name: `enfyra-contract-eval-${toolset}-${profile}`, version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

function measureTools(tools) {
  const serialized = JSON.stringify(tools);
  return {
    count: tools.length,
    chars: serialized.length,
    tokenizerTokens: countTokens(serialized),
  };
}

async function main() {
  assert.ok(rootEnv.ENFYRA_API_URL, `ENFYRA_API_URL is required in ${rootEnvPath}`);
  assert.ok(rootEnv.ENFYRA_API_TOKEN, `ENFYRA_API_TOKEN is required in ${rootEnvPath}`);
  const surfaces = {};
  const outputSchemas = {};
  for (const profile of profiles) {
    const { client, transport } = await connect('guided', profile);
    try {
      const listed = await client.listTools();
      const incomplete = listed.tools.filter((tool) => !tool.annotations || [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ].some((key) => typeof tool.annotations[key] !== 'boolean'));
      assert.deepEqual(incomplete.map((tool) => tool.name), []);
      assert.ok(listed.tools.some((tool) => tool.name === 'search_enfyra_tools' && tool.outputSchema));
      assert.ok(listed.tools.some((tool) => tool.name === 'execute_enfyra_tool' && tool.outputSchema));
      if (profile === 'operations') {
        assert.ok(listed.tools.some((tool) => tool.name === 'setup_oauth_provider' && tool.outputSchema));
      }
      surfaces[`guided/${profile}`] = measureTools(listed.tools);
      outputSchemas[`guided/${profile}`] = {
        covered: listed.tools.filter((tool) => tool.outputSchema).length,
        total: listed.tools.length,
      };
    } finally {
      await transport.close();
    }
  }

  const fullConnection = await connect('full', 'all');
  try {
    const listed = await fullConnection.client.listTools();
    assert.deepEqual(listed.tools.filter((tool) => !tool.annotations).map((tool) => tool.name), []);
    surfaces['full/all'] = measureTools(listed.tools);
    outputSchemas['full/all'] = {
      covered: listed.tools.filter((tool) => tool.outputSchema).length,
      total: listed.tools.length,
    };
  } finally {
    await fullConnection.transport.close();
  }

  const dynamicConnection = await connect('guided', 'all');
  const dynamicPacks = {};
  try {
    let listChangedNotifications = 0;
    dynamicConnection.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChangedNotifications += 1;
    });
    const initial = await dynamicConnection.client.listTools();
    assert.ok(initial.tools.some((tool) => tool.name === 'select_enfyra_workflow'));
    assert.ok(!initial.tools.some((tool) => tool.name === 'create_tables'));
    dynamicPacks.initial = measureTools(initial.tools);

    const routed = parseToolResult(await dynamicConnection.client.callTool({
      name: 'discover_enfyra_workflows',
      arguments: { intent: 'create a temporary widget extension', detail: 'plan', limit: 1 },
    }));
    assert.deepEqual(routed.nextSelection, {
      tool: 'select_enfyra_workflow',
      input: { surface: 'extension', mode: 'replace' },
    });
    dynamicPacks.discoveryNextSelection = routed.nextSelection;

    for (const surface of WORKFLOW_SURFACES) {
      const selected = parseToolResult(await dynamicConnection.client.callTool({
        name: 'select_enfyra_workflow',
        arguments: { surface, mode: 'replace' },
      }));
      assert.equal(selected.action, 'enfyra_workflow_selected');
      assert.deepEqual(selected.activeSurfaces, [surface]);
      const listed = await dynamicConnection.client.listTools();
      const visible = new Set(listed.tools.map((tool) => tool.name));
      const expected = workflowToolNames(surface)
        .filter((name) => isToolVisibleInToolset(name, 'guided', 'all'));
      const missing = expected.filter((name) => !visible.has(name));
      assert.deepEqual(missing, [], `${surface} dynamic pack is missing direct guided tools`);
      if (surface === 'oauth') {
        assert.ok(listed.tools.some((tool) => tool.name === 'setup_oauth_provider' && tool.outputSchema));
      }
      dynamicPacks[surface] = measureTools(listed.tools);
    }

    await dynamicConnection.client.callTool({
      name: 'select_enfyra_workflow',
      arguments: { surface: 'schema', mode: 'replace' },
    });
    await dynamicConnection.client.callTool({
      name: 'select_enfyra_workflow',
      arguments: { surface: 'extension', mode: 'add' },
    });
    const combinedTools = await dynamicConnection.client.listTools();
    assert.ok(combinedTools.tools.some((tool) => tool.name === 'create_tables'));
    assert.ok(combinedTools.tools.some((tool) => tool.name === 'extension_workflow'));
    dynamicPacks['schema+extension'] = measureTools(combinedTools.tools);

    await dynamicConnection.client.callTool({
      name: 'select_enfyra_workflow',
      arguments: { mode: 'reset' },
    });
    const resetTools = await dynamicConnection.client.listTools();
    assert.deepEqual(resetTools.tools.map((tool) => tool.name).sort(), initial.tools.map((tool) => tool.name).sort());
    dynamicPacks.reset = measureTools(resetTools.tools);
    assert.ok(listChangedNotifications >= WORKFLOW_SURFACES.length + 3);
    dynamicPacks.listChangedNotifications = listChangedNotifications;
  } finally {
    await dynamicConnection.transport.close();
  }

  const { client, transport } = await connect('guided', 'extension');
  const scenarios = [];
  try {
    const context = parseToolResult(await client.callTool({ name: 'get_enfyra_api_context', arguments: {} }));
    assert.match(context.enfyraApiUrl, /^http:\/\/(?:localhost|127\.0\.0\.1):3000\/api$/);
    scenarios.push({ name: 'local_target', status: 'passed' });

    const catalog = parseToolResult(await client.callTool({
      name: 'search_enfyra_tools',
      arguments: { query: 'build_extension_drawer', scope: 'hidden', limit: 3 },
    }));
    const builder = catalog.tools.find((tool) => tool.name === 'build_extension_drawer');
    assert.equal(builder.invocation.mode, 'catalog');
    assert.equal(builder.annotations.readOnlyHint, true);
    assert.equal(builder.availability.status, 'allowed');
    assert.ok(builder.inputSchema.properties.body);
    scenarios.push({ name: 'catalog_discovery_and_pat_capability', status: 'passed' });

    const executed = parseToolResult(await client.callTool({
      name: 'execute_enfyra_tool',
      arguments: { name: 'build_extension_drawer', arguments: { title: 'Edit item', body: '<UInput v-model="form.name" />' } },
    }));
    assert.equal(executed.action, 'enfyra_catalog_tool_executed');
    assert.match(JSON.stringify(executed.result), /CommonDrawer/);
    scenarios.push({ name: 'catalog_read_only_execution', status: 'passed' });

    const blockedMutation = await client.callTool({
      name: 'execute_enfyra_tool',
      arguments: { name: 'create_route', arguments: { path: '/should-not-run' } },
    });
    assert.equal(blockedMutation.isError, true);
    assert.match(blockedMutation.content[0].text, /mutation or destructive tool/i);
    scenarios.push({ name: 'catalog_mutation_block', status: 'passed' });

    const records = parseToolResult(await client.callTool({
      name: 'query_table',
      arguments: { tableName: 'enfyra_method', fields: ['id', 'name'], limit: 1 },
    }));
    assert.equal(records.dataBoundary.trust, 'untrusted');
    assert.equal(records.schemaReceipt.metadataChecked, true);
    assert.equal(records.schemaReceipt.requestedFieldsValidated, true);
    assert.deepEqual(records.schemaReceipt.requestedTopLevelFields, ['id', 'name']);
    scenarios.push({ name: 'untrusted_data_boundary', status: 'passed' });

    const exactMissing = parseToolResult(await client.callTool({
      name: 'search_admin_extensions',
      arguments: { mode: 'search', name: '__mcp_contract_absence_fixture__' },
    }));
    assert.equal(exactMissing.matchMode, 'exact');
    assert.equal(exactMissing.targetFound, false);
    assert.equal(exactMissing.exactMatchCount, 0);
    assert.deepEqual(exactMissing.results, []);
    scenarios.push({ name: 'exact_extension_absence', status: 'passed' });

    const firstPage = parseToolResult(await client.callTool({
      name: 'search_runtime_zone',
      arguments: { zone: 'api_runtime', maxResults: 2 },
    }));
    assert.ok(firstPage.page);
    assert.ok(firstPage.page.returned <= 2);
    if (firstPage.page.nextCursor) {
      const secondPage = parseToolResult(await client.callTool({
        name: 'search_runtime_zone',
        arguments: { zone: 'api_runtime', maxResults: 2, cursor: firstPage.page.nextCursor },
      }));
      assert.ok(secondPage.page.offset > firstPage.page.offset);
    }
    scenarios.push({ name: 'bounded_cursor_pagination', status: 'passed' });

    const located = parseToolResult(await client.callTool({
      name: 'search_admin_extensions',
      arguments: { query: 'cloud', maxResults: 1 },
    }));
    assert.ok(located.results[0]?.nextInspect?.input);
    const inspected = parseToolResult(await client.callTool({
      name: 'search_admin_extensions',
      arguments: located.results[0].nextInspect.input,
    }));
    assert.match(inspected.source.resourceUri, /^enfyra-source:\/\/artifact\//);
    const resource = await client.readResource({ uri: inspected.source.resourceUri });
    assert.ok(resource.contents[0]?.text?.length > 0);
    scenarios.push({ name: 'source_resource_uri', status: 'passed' });
  } finally {
    await transport.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    target: 'local-root-workspace',
    surfaces,
    dynamicPacks,
    outputSchemas,
    scenarios,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
}

await main();
