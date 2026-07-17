import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_EVAL_SCENARIOS, scoreModelEvalRun } from '../dist/lib/model-eval.js';

test('model eval requires 100 percent for recommendation', () => {
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
  assert.ok(withToolError.score < 100);
  assert.equal(withToolError.checks.find((check) => check.key === 'tool_errors').passed, false);

  const withoutVerification = scoreModelEvalRun({
    scenarioId: scenario.id,
    model: 'fixture',
    events: events.slice(0, -1),
  }, scenario);
  assert.ok(withoutVerification.score < 100);
  assert.equal(withoutVerification.recommended, false);
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

test('temporary extension lifecycle requires cleanup verification', () => {
  const scenario = MODEL_EVAL_SCENARIOS.find((item) => item.id === 'temporary-extension-lifecycle');
  const events = [
    { tool: 'get_enfyra_api_context' },
    { tool: 'get_enfyra_required_knowledge' },
    { tool: 'select_enfyra_workflow' },
    { tool: 'get_extension_theme_contract' },
    { tool: 'ensure_widget_extension' },
    { tool: 'delete_records', arguments: { confirm: false } },
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
    { tool: 'delete_records', arguments: { confirm: false } },
    { tool: 'delete_records', arguments: { confirm: true } },
    { tool: 'find_one_record', result: { data: null } },
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
    { tool: 'delete_records', arguments: { confirm: false } },
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
    { tool: 'query_table' },
  ];
  const score = scoreModelEvalRun({ scenarioId: scenario.id, model: 'fixture', events }, scenario);
  assert.equal(score.score, 100);
  assert.equal(score.recommended, true);
});
