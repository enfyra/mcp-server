import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { countTokens } from 'gpt-tokenizer';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { WORKFLOW_SURFACES, workflowToolNames } from '../dist/lib/tool-routing.js';
import { isToolInProfile } from '../dist/lib/toolset-filter.js';
import { connectRootMcp } from './support/root-mcp-client.mjs';

const report = { target: 'local-root-workspace', surfaces: {}, workflows: {}, scenarios: [] };
for (const profile of ['all', 'extension', 'schema', 'runtime', 'operations']) {
  const { client, execute, executeRaw, discover } = await connectRootMcp(profile, 'off');
  try {
    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { notifications += 1; });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ['enfyra']);
    assert.ok(tools[0].outputSchema);
    assert.deepEqual(tools[0].annotations, { title: 'Enfyra', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    report.surfaces[profile] = { count: tools.length, tokenizerTokens: countTokens(JSON.stringify(tools)) };
    const catalog = await discover('get_permission_profile');
    assert.equal(catalog.tools[0].name, 'get_permission_profile');
    assert.equal(catalog.tools[0].invocation.tool, 'enfyra');
    assert.ok(catalog.tools[0].inputSchema);
    assert.ok(['allowed', 'unknown'].includes(catalog.tools[0].availability.status));
    await execute('get_permission_profile');
    assert.deepEqual((await client.listTools()).tools, tools);

    if (profile === 'all') {
      for (const surface of WORKFLOW_SURFACES) {
        const routed = await execute('discover_enfyra_workflows', { surface, detail: 'plan', limit: 1 });
        assert.equal(routed.workflows[0].key, surface);
        for (const name of workflowToolNames(surface).filter((name) => isToolInProfile(name))) {
          const found = await discover(name);
          assert.equal(found.tools[0].name, name, `${surface}/${name}`);
          assert.ok(found.tools[0].inputSchema);
        }
        report.workflows[surface] = 'passed';
      }
      for (const name of ['create_route', 'reload_all', 'enfyra', 'select_enfyra_workflow']) {
        assert.equal((await executeRaw(name)).isError, true);
      }
      report.scenarios.push('guided_allowlist_and_recursion_block');
      const records = await execute('query_table', { tableName: 'enfyra_method', fields: ['id', 'name'], limit: 1 });
      assert.equal(records.dataBoundary.trust, 'untrusted');
      assert.equal(records.schemaReceipt.metadataChecked, true);
      assert.equal(records.schemaReceipt.requestedFieldsValidated, true);
      report.scenarios.push('query_schema_receipt_and_untrusted_output');
      const projection = await execute('inspect_rest_projection', { tableName: 'enfyra_method', fields: ['id', 'name'], access: 'authenticated', limit: 1 });
      assert.equal(projection.requestExecuted, true);
      assert.notEqual(projection.verdict, 'schema_contract_mismatch');
      report.scenarios.push('rest_projection');
      const first = await execute('search_runtime_zone', { zone: 'api_runtime', maxResults: 2 });
      assert.ok(first.page.returned <= 2);
      if (first.page.nextCursor) {
        const second = await execute('search_runtime_zone', { zone: 'api_runtime', maxResults: 2, cursor: first.page.nextCursor });
        assert.ok(second.page.offset > first.page.offset);
      }
      report.scenarios.push('runtime_cursor_pagination');
    }
    assert.deepEqual((await client.listTools()).tools, tools);
    assert.equal(notifications, 0);
  } finally {
    await client.close();
  }
}
writeFileSync('/tmp/enfyra-mcp-contracts.json', JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
