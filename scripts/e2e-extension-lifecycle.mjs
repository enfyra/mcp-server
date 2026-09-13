import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectRootMcp } from './support/root-mcp-client.mjs';
const fixtureName = `McpExtensionLifecycle_${Date.now()}_${randomUUID().slice(0, 8)}`;
const initialMarker = 'mcp-extension-e2e-v1';
const updatedMarker = 'mcp-extension-e2e-v2';
const initialCode = `<template>
  <section class="eapp-surface-card eapp-radius-panel border eapp-divider p-4">
    <p data-mcp-e2e="${initialMarker}">${initialMarker}</p>
  </section>
</template>`;

async function main() {
  const { client, execute: call, discover } = await connectRootMcp('extension');
  let extensionId = null;
  let primaryError = null;
  let cleanupError = null;

  try {
    const context = await call('get_enfyra_api_context');
    assert.match(context.enfyraApiUrl, /^http:\/\/(?:localhost|127\.0\.0\.1):3000\/api$/);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.deepEqual(toolNames, ['enfyra']);
    for (const name of ['extension_workflow', 'patch_extension_code', 'verify_extension_runtime', 'delete_extension']) {
      assert.equal((await discover(name)).tools[0].name, name);
    }

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
    const inspected = await call('search_admin_extensions', { mode: 'inspect', id: extensionId });
    assert.match(inspected.source.resourceUri, /^enfyra-source:\/\/artifact\//);
    const resource = await client.readResource({ uri: inspected.source.resourceUri });
    assert.match(resource.contents[0].text, new RegExp(updatedMarker));
  } catch (error) {
    primaryError = error;
  } finally {
    if (!extensionId) {
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
        await call('delete_extension', {
          id: extensionId,
          confirm: false,
        });
        const deleted = await call('delete_extension', {
          id: extensionId,
          expectedExtensionId: extensionId,
          confirm: true,
        });
        assert.equal(deleted.postcondition?.confirmedAbsent, true);
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
