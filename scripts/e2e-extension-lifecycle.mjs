import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseEnv } from 'dotenv';

const rootEnvPath = fileURLToPath(new URL('../../.codex/.env', import.meta.url));
const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const rootEnv = parseEnv(readFileSync(rootEnvPath));
const fixtureName = `McpExtensionLifecycle_${Date.now()}_${randomUUID().slice(0, 8)}`;
const initialMarker = 'mcp-extension-e2e-v1';
const updatedMarker = 'mcp-extension-e2e-v2';
const initialCode = `<template>
  <section class="eapp-surface-card eapp-radius-panel border eapp-divider p-4">
    <p data-mcp-e2e="${initialMarker}">${initialMarker}</p>
  </section>
</template>`;

function parseToolResult(result) {
  if (result.isError) {
    const message = result.content?.map((item) => item.type === 'text' ? item.text : '').filter(Boolean).join('\n');
    throw new Error(message || 'MCP tool returned an error result.');
  }
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP tool returned no JSON text content.');
  return JSON.parse(text);
}

async function main() {
  assert.ok(rootEnv.ENFYRA_API_URL, `ENFYRA_API_URL is required in ${rootEnvPath}`);
  assert.ok(rootEnv.ENFYRA_API_TOKEN, `ENFYRA_API_TOKEN is required in ${rootEnvPath}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      ...rootEnv,
      ENFYRA_MCP_TOOLSET: 'guided',
      ENFYRA_MCP_PROFILE: 'extension',
    },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'enfyra-extension-lifecycle-e2e', version: '1.0.0' });
  let extensionId = null;
  let connected = false;
  let primaryError = null;
  let cleanupError = null;

  const call = async (name, args = {}) => parseToolResult(await client.callTool({ name, arguments: args }));
  try {
    await client.connect(transport);
    connected = true;
    const context = await call('get_enfyra_api_context');
    assert.match(context.enfyraApiUrl, /^http:\/\/(?:localhost|127\.0\.0\.1):3000\/api$/);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(toolNames.length >= 20 && toolNames.length <= 40, `extension profile returned ${toolNames.length} tools`);
    assert.ok(toolNames.includes('extension_workflow'));
    assert.ok(toolNames.includes('patch_extension_code'));
    assert.ok(toolNames.includes('verify_extension_runtime'));
    assert.equal(toolNames.includes('create_tables'), false);

    await call('get_enfyra_required_knowledge', { scope: 'extension' });
    const created = await call('extension_workflow', {
      name: fixtureName,
      type: 'widget',
      code: initialCode,
      description: 'Ephemeral MCP extension lifecycle E2E fixture',
      isEnabled: false,
      version: '0.0.0-e2e',
      applyAll: true,
    });
    extensionId = created.extension?.id;
    assert.equal(created.complete, true);
    assert.ok(extensionId, 'extension_workflow did not return the created extension id');

    const preview = await call('patch_extension_code', {
      id: extensionId,
      search: initialMarker,
      replace: updatedMarker,
      replaceAll: true,
      apply: false,
    });
    assert.equal(preview.action, 'extension_code_patch_previewed');
    assert.equal(preview.occurrences, 2);
    assert.ok(preview.currentSha256);
    assert.ok(preview.nextSha256);

    const patched = await call('patch_extension_code', {
      id: extensionId,
      search: initialMarker,
      replace: updatedMarker,
      replaceAll: true,
      expectedSha256: preview.currentSha256,
      apply: true,
    });
    assert.equal(patched.action, 'extension_code_patch_applied');
    assert.equal(patched.nextSha256, preview.nextSha256);

    const verified = await call('verify_extension_runtime', {
      id: extensionId,
      expectedSha256: preview.nextSha256,
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.checks.savedRecord.status, 'passed');
    assert.equal(verified.checks.expectedHash.status, 'passed');
    assert.equal(verified.checks.serverCompile.status, 'passed');
    assert.equal(verified.checks.uiContract.status, 'passed');
    assert.equal(verified.checks.themeContract.status, 'passed');
    assert.equal(verified.checks.runtimeContract.status, 'passed');
    assert.equal(verified.checks.browserRender.status, 'not_run');
  } catch (error) {
    primaryError = error;
  } finally {
    if (connected && !extensionId) {
      try {
        const located = await call('query_table', {
          tableName: 'enfyra_extension',
          fields: ['id', 'name'],
          filter: { name: { _eq: fixtureName } },
          limit: 1,
        });
        extensionId = (located.data || located.rows || [])[0]?.id || null;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (extensionId) {
      try {
        await call('delete_records', {
          tableName: 'enfyra_extension',
          items: [{ id: extensionId }],
          confirm: false,
        });
        const deleted = await call('delete_records', {
          tableName: 'enfyra_extension',
          items: [{ id: extensionId }],
          confirm: true,
        });
        assert.equal(deleted.deleted?.length, 1);
        const remaining = await call('query_table', {
          tableName: 'enfyra_extension',
          fields: ['id', 'name'],
          filter: { id: { _eq: extensionId } },
          limit: 1,
        });
        const rows = remaining.data || remaining.rows || [];
        assert.equal(rows.length, 0, `fixture ${fixtureName} still exists after cleanup`);
      } catch (error) {
        cleanupError = error;
      }
    }
    await client.close().catch(() => undefined);
  }

  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], 'Extension lifecycle E2E failed and fixture cleanup also failed.');
  }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  process.stdout.write(`${JSON.stringify({ passed: true, profile: 'extension', lifecycle: ['create', 'patch-preview', 'patch-apply', 'verify', 'cleanup'], fixtureRemoved: true })}\n`);
}

await main();
