import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  getToolOutputSchema,
  installToolOutputContracts,
  validateStructuredToolOutput,
} from '../dist/lib/tool-output-contracts.js';
import { formatJsonPayload } from '../dist/lib/response-format.js';

test('core workflow tools receive formal output schemas', () => {
  for (const name of [
    'discover_enfyra_workflows',
    'select_enfyra_workflow',
    'search_enfyra_tools',
    'execute_enfyra_tool',
    'get_enfyra_api_context',
    'setup_oauth_provider',
    'get_permission_profile',
    'search_runtime_zone',
    'search_admin_extensions',
    'inspect_table',
    'inspect_route',
    'api_endpoint_workflow',
    'extension_workflow',
    'flow_workflow',
    'verify_extension_runtime',
  ]) {
    assert.ok(getToolOutputSchema(name), `${name} has no output schema`);
  }
});

test('output contract wrapper migrates contracted legacy calls to registerTool', () => {
  const registrations = [];
  const server = {
    tool() { throw new Error('contracted tool should use registerTool'); },
    registerTool(name, config, handler) {
      registrations.push({ name, config, handler });
      return { enabled: true };
    },
  };
  installToolOutputContracts(server);
  server.tool('discover_enfyra_workflows', '', {}, async () => null);
  assert.equal(registrations[0].name, 'discover_enfyra_workflows');
  assert.ok(registrations[0].config.outputSchema instanceof z.ZodType);
  assert.equal(registrations[0].config.outputSchema.safeParse({
    responseFormat: 'json+columnar-v1',
    action: 'enfyra_workflows_discovered',
    profile: 'all',
    workflows: [],
    guidance: [],
    extra: true,
  }).success, true);
});

test('structured output validation accepts matching contracts and rejects drift', () => {
  assert.equal(validateStructuredToolOutput('discover_enfyra_workflows', {
    responseFormat: 'json+columnar-v1',
    action: 'enfyra_workflows_discovered',
    profile: 'all',
    workflows: [],
    guidance: [],
  }).success, true);
  const invalid = validateStructuredToolOutput('discover_enfyra_workflows', {
    responseFormat: 'json+columnar-v1',
    action: 'wrong_action',
  });
  assert.equal(invalid.success, false);
});

test('record read and delete output contracts require deterministic receipts', () => {
  assert.equal(validateStructuredToolOutput('query_table', {
    responseFormat: 'json-v1',
    schemaReceipt: {
      tableName: 'tasks',
      primaryKey: 'id',
      metadataChecked: true,
      requestedFieldsValidated: true,
      requestedTopLevelFields: ['id'],
    },
  }).success, true);
  assert.equal(validateStructuredToolOutput('query_table', {
    responseFormat: 'json-v1',
  }).success, false);

  assert.equal(validateStructuredToolOutput('delete_records', {
    responseFormat: 'json-v1',
    action: 'deleted_records',
    postcondition: {
      verificationMethod: 'route_read_by_primary_keys',
      requestedIds: ['1'],
      remainingIds: [],
      confirmedAbsent: true,
    },
  }).success, true);
  assert.equal(validateStructuredToolOutput('delete_records', {
    responseFormat: 'json-v1',
    action: 'deleted_records',
  }).success, false);

  for (const toolName of ['delete_tables', 'delete_columns', 'delete_relations', 'delete_method', 'delete_route']) {
    assert.equal(validateStructuredToolOutput(toolName, {
      responseFormat: 'json-v1',
      action: `${toolName}_preview`,
      previewReceipt: {
        version: 1,
        valid: true,
        toolName,
        action: `${toolName}_preview`,
        targetCount: 1,
      },
      postcondition: {
        verificationMethod: 'not_run_preview',
        confirmedAbsent: false,
      },
    }).success, true, `${toolName} preview receipt should validate`);
    assert.equal(validateStructuredToolOutput(toolName, {
      responseFormat: 'json-v1',
      action: `${toolName}_deleted`,
    }).success, false, `${toolName} must include a postcondition`);
  }
});

test('OAuth provider output contract requires a callback handoff and runtime verification', () => {
  assert.equal(validateStructuredToolOutput('setup_oauth_provider', {
    responseFormat: 'json-v1',
    action: 'oauth_provider_enfyra_config_saved',
    status: 'provider_console_action_required',
    setupComplete: false,
    provider: 'google',
    operation: 'created',
    callbackUri: 'https://demo.enfyra.io/api/auth/google/callback',
    providerConsole: {
      field: 'Authorized redirect URIs',
      value: 'https://demo.enfyra.io/api/auth/google/callback',
      instruction: 'Add this exact URI.',
      confirmationRequired: true,
    },
    verification: {
      configPersisted: true,
      runtimeProviderActive: true,
      providerConsoleConfirmed: false,
    },
    next: {
      instruction: 'Present callbackUri and stop for confirmation.',
      requiresUserConfirmation: true,
      afterConfirmation: 'Verify the existing OAuth button and /me.',
    },
  }).success, true);
  assert.equal(validateStructuredToolOutput('setup_oauth_provider', {
    responseFormat: 'json-v1',
    action: 'oauth_provider_enfyra_config_saved',
  }).success, false);
});

test('structured output validation accepts record arrays after columnar formatting', () => {
  const workflowOutput = formatJsonPayload({
    action: 'enfyra_workflows_discovered',
    profile: 'all',
    workflows: Array.from({ length: 12 }, (_, index) => ({
      key: `surface-${index}`,
      title: `Workflow surface ${index}`,
      score: 12 - index,
      recommendedScope: `scope-${index}`,
    })),
    guidance: [],
  });
  assert.equal(workflowOutput.workflows.format, 'columnar-v1');
  assert.equal(validateStructuredToolOutput('discover_enfyra_workflows', workflowOutput).success, true);

  const catalogOutput = formatJsonPayload({
    action: 'enfyra_tools_searched',
    resultCount: 2,
    page: {},
    tools: Array.from({ length: 12 }, (_, index) => ({
      name: `tool_${index}`,
      risk: 'read',
      description: `Read-only catalog tool number ${index}`,
      availability: 'visible',
    })),
    guidance: [],
  });
  assert.equal(catalogOutput.tools.format, 'columnar-v1');
  assert.equal(validateStructuredToolOutput('search_enfyra_tools', catalogOutput).success, true);
});
