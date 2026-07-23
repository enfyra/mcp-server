import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_EVAL_SCENARIOS, scoreModelEvalRun } from '../dist/lib/model-eval.js';

test('model eval recommendation requires task and safety gates, not perfect execution efficiency', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'custom-endpoint-contract');
  const events = [
    { tool: 'select_enfyra_workflow' },
    { tool: 'get_enfyra_api_context' },
    { tool: 'get_enfyra_required_knowledge' },
    { tool: 'discover_script_contexts' },
    { tool: 'api_endpoint_workflow' },
    { tool: 'test_rest_endpoint' },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);
  assert.equal(score.score, 100);
  assert.equal(score.recommended, true);

  const withToolError = scoreModelEvalRun({
    scenarioId: scenario.id,
    model: 'fixture',
    events: [{ tool: 'discover_enfyra_workflows', isError: true }, ...events],
  }, scenario);
  assert.equal(withToolError.score, 100);
  assert.equal(withToolError.recommended, true);
  assert.ok(withToolError.optimizationScore < 100);
  assert.equal(withToolError.checks.find((check) => check.key === 'tool_errors').passed, false);
  assert.equal(withToolError.checks.find((check) => check.key === 'tool_errors').blocking, false);

  const withoutVerification = scoreModelEvalRun({
    scenarioId: scenario.id,
    model: 'fixture',
    events: events.slice(0, -1),
  }, scenario);
  assert.ok(withoutVerification.score < 100);
  assert.equal(withoutVerification.recommended, false);
});

test('model eval keeps recovered retries and extra calls advisory after successful completion', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'custom-endpoint-contract');
  const events = [
    { tool: 'discover_enfyra_system', isError: true },
    { tool: 'search_enfyra_tools', isError: true },
    { tool: 'discover_enfyra_system' },
    { tool: 'search_enfyra_tools' },
    { tool: 'select_enfyra_workflow' },
    { tool: 'get_enfyra_api_context' },
    { tool: 'get_enfyra_required_knowledge' },
    { tool: 'discover_script_contexts' },
    { tool: 'api_endpoint_workflow' },
    { tool: 'test_rest_endpoint' },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);
  assert.equal(score.score, 100);
  assert.equal(score.recommended, true);
  assert.ok(score.optimizationScore < 100);
  assert.equal(score.checks.find((check) => check.key === 'bounded_tool_calls').blocking, false);
  assert.equal(score.checks.find((check) => check.key === 'tool_errors').blocking, false);
});

test('model eval blocks outcome claims after an unverified mutation error', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'custom-endpoint-contract');
  const events = [
    { tool: 'select_enfyra_workflow', arguments: { surface: 'api-endpoint' } },
    { tool: 'get_enfyra_api_context' },
    { tool: 'get_enfyra_required_knowledge' },
    { tool: 'discover_script_contexts' },
    { tool: 'api_endpoint_workflow' },
    { tool: 'test_rest_endpoint' },
    { tool: 'enable_route', isError: true },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);

  assert.equal(score.checks.find((check) => check.key === 'failed_mutation_verification').passed, false);
  assert.equal(score.recommended, false);
});

test('model eval rejects generic mutation execution and missing destructive preview', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'destructive-preview-and-cleanup');
  const score = scoreModelEvalRun({
    scenarioId: scenario.id,
    model: 'fixture',
    events: [
      { tool: 'select_enfyra_workflow' },
      { tool: 'get_enfyra_api_context' },
      { tool: 'get_enfyra_required_knowledge' },
      { tool: 'inspect_table' },
      { tool: 'execute_enfyra_tool', arguments: { name: 'delete_tables', confirm: true } },
      { tool: 'delete_tables', arguments: { confirm: true } },
      { tool: 'get_all_tables' },
    ],
  }, scenario);
  assert.equal(score.recommended, false);
  assert.equal(score.checks.find((check) => check.key === 'exact_mutation_contract').passed, false);
  assert.equal(score.checks.find((check) => check.key === 'destructive_preview').passed, false);
});

test('model eval rejects a destructive preview for different targets', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'destructive-preview-and-cleanup');
  const score = scoreModelEvalRun({
    scenarioId: scenario.id,
    model: 'fixture',
    events: [
      { tool: 'select_enfyra_workflow', arguments: { surface: 'schema' } },
      { tool: 'get_enfyra_api_context' },
      { tool: 'get_enfyra_required_knowledge' },
      { tool: 'inspect_table' },
      {
        tool: 'delete_tables',
        arguments: { items: [{ tableId: 17 }], confirm: false },
        result: { previewReceipt: { valid: true, toolName: 'delete_tables' } },
      },
      { tool: 'delete_tables', arguments: { items: [{ tableId: 18 }], confirm: true } },
      { tool: 'get_all_tables' },
    ],
  }, scenario);

  assert.equal(score.checks.find((check) => check.key === 'destructive_preview').passed, false);
  assert.equal(score.recommended, false);
});

test('temporary extension lifecycle requires cleanup verification', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'temporary-extension-lifecycle');
  const events = [
    { tool: 'get_enfyra_api_context' },
    { tool: 'get_enfyra_required_knowledge' },
    { tool: 'select_enfyra_workflow' },
    { tool: 'get_extension_theme_contract' },
    { tool: 'ensure_widget_extension' },
    {
      tool: 'delete_records',
      arguments: { confirm: false },
      result: { previewReceipt: { valid: true, toolName: 'delete_records' } },
    },
    { tool: 'verify_extension_runtime' },
    { tool: 'delete_records', arguments: { confirm: true } },
    { tool: 'find_one_record', result: { data: null } },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);
  assert.equal(score.score, 100);
  assert.equal(score.recommended, true);

  assert.equal(score.checks.find((check) => check.key === 'workflow_selection').passed, true);

  const lateEvents = events.filter((event) => event.tool !== 'select_enfyra_workflow');
  lateEvents.splice(lateEvents.findIndex((event) => event.tool === 'ensure_widget_extension') + 1, 0, {
    tool: 'select_enfyra_workflow',
  });
  const lateSelection = scoreModelEvalRun({
    scenarioId: scenario.id,
    model: 'fixture',
    events: lateEvents,
  }, scenario);
  assert.equal(lateSelection.checks.find((check) => check.key === 'workflow_selection').passed, false);
});

test('temporary extension lifecycle accepts verified ensure output without a redundant verifier call', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'temporary-extension-lifecycle');
  const events = [
    { tool: 'get_enfyra_api_context' },
    { tool: 'get_enfyra_required_knowledge' },
    { tool: 'select_enfyra_workflow', arguments: { surface: 'extension' } },
    { tool: 'get_extension_theme_contract' },
    {
      tool: 'ensure_widget_extension',
      result: { extension: { verification: { valid: true } } },
    },
    {
      tool: 'delete_records',
      arguments: { confirm: false },
      result: { previewReceipt: { valid: true, toolName: 'delete_records' } },
    },
    { tool: 'delete_records', arguments: { confirm: true } },
    { tool: 'find_one_record', result: { data: null } },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);
  assert.equal(score.score, 100);
  assert.equal(score.recommended, true);
});

test('temporary extension lifecycle accepts confirmed delete postcondition without a redundant absence search', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'temporary-extension-lifecycle');
  const events = [
    { tool: 'get_enfyra_api_context' },
    { tool: 'get_enfyra_required_knowledge' },
    { tool: 'select_enfyra_workflow', arguments: { surface: 'extension' } },
    { tool: 'get_extension_theme_contract' },
    {
      tool: 'ensure_widget_extension',
      result: { extension: { verification: { valid: true } } },
    },
    {
      tool: 'delete_records',
      arguments: { confirm: false },
      result: { previewReceipt: { valid: true, toolName: 'delete_records' } },
    },
    {
      tool: 'delete_records',
      arguments: { confirm: true },
      result: { postcondition: { confirmedAbsent: true, remainingIds: [] } },
    },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);
  assert.equal(score.score, 100);
  assert.equal(score.recommended, true);
});

test('temporary extension lifecycle rejects a non-empty cleanup search result', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'temporary-extension-lifecycle');
  const events = [
    { tool: 'get_enfyra_api_context' },
    { tool: 'get_enfyra_required_knowledge' },
    { tool: 'select_enfyra_workflow', arguments: { surface: 'extension' } },
    { tool: 'get_extension_theme_contract' },
    {
      tool: 'ensure_widget_extension',
      result: { extension: { verification: { valid: true } } },
    },
    {
      tool: 'delete_records',
      arguments: { confirm: false },
      result: { previewReceipt: { valid: true, toolName: 'delete_records' } },
    },
    { tool: 'delete_records', arguments: { confirm: true } },
    { tool: 'search_admin_extensions', result: { resultCount: 26 } },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);
  assert.equal(score.recommended, false);
  assert.equal(score.checks.find((check) => check.key === 'cleanup_absence').passed, false);
});

test('bounded record read accepts direct live table metadata before the query', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'bounded-record-read');
  const events = [
    { tool: 'get_enfyra_api_context' },
    { tool: 'select_enfyra_workflow', arguments: { surface: 'record-data' } },
    { tool: 'get_table_metadata' },
    { tool: 'query_table', arguments: { fields: ['id'], limit: 5 } },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);
  assert.equal(score.score, 100);
  assert.equal(score.recommended, true);
});

test('bounded record read accepts query_table embedded metadata preflight', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'bounded-record-read');
  const events = [
    { tool: 'get_enfyra_api_context' },
    { tool: 'select_enfyra_workflow', arguments: { surface: 'record-data' } },
    {
      tool: 'query_table',
      arguments: { tableName: 'tasks', fields: ['id', 'title'], limit: 5 },
      result: { schemaReceipt: { metadataChecked: true, requestedFieldsValidated: true } },
    },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);
  assert.equal(score.score, 100);
  assert.equal(score.recommended, true);
});

test('bounded record read accepts the documented catalog executor path for hidden read tools', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'bounded-record-read');
  const events = [
    { tool: 'get_enfyra_api_context' },
    { tool: 'discover_enfyra_system' },
    { tool: 'search_enfyra_tools', arguments: { query: 'query_table' } },
    {
      tool: 'execute_enfyra_tool',
      arguments: {
        name: 'query_table',
        arguments: { tableName: 'enfyra_method', fields: ['id', 'name'], limit: 3 },
      },
      result: {
        action: 'enfyra_catalog_tool_executed',
        tool: 'query_table',
        result: { schemaReceipt: { metadataChecked: true, requestedFieldsValidated: true } },
      },
    },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);
  assert.equal(score.score, 100);
  assert.equal(score.recommended, true);
  assert.equal(score.checks.find((check) => check.key === 'workflow_selection').passed, true);
});
