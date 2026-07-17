import { isDestructiveTool, isMutationTool } from './tool-contracts.js';
import type {
  ModelEvalCheck,
  ModelEvalRun,
  ModelEvalScenario,
  ModelEvalScore,
  ModelEvalTraceEvent,
} from './types.js';

export const MODEL_EVAL_SCENARIOS: ModelEvalScenario[] = [
  {
    id: 'schema-create-and-verify',
    prompt: 'Create a small orders schema with a customer relation, then verify the saved metadata.',
    surface: 'schema',
    requiredToolGroups: [
      ['get_enfyra_required_knowledge'],
      ['get_schema_design_context'],
      ['get_all_tables', 'inspect_table'],
      ['create_tables'],
      ['inspect_table'],
    ],
    verificationTools: ['inspect_table'],
    maxToolCalls: 9,
    mutationExpected: true,
  },
  {
    id: 'extension-focused-patch',
    prompt: 'Find an existing admin page extension, make one focused UI change, and verify the saved runtime source.',
    surface: 'extension',
    requiredToolGroups: [
      ['get_enfyra_required_knowledge'],
      ['get_extension_theme_contract'],
      ['search_admin_extensions'],
      ['patch_extension_code'],
      ['verify_extension_runtime'],
    ],
    verificationTools: ['verify_extension_runtime'],
    maxToolCalls: 10,
    mutationExpected: true,
  },
  {
    id: 'custom-endpoint-contract',
    prompt: 'Create a custom third-party endpoint with secure explicit repository access and smoke-test it.',
    surface: 'api-endpoint',
    requiredToolGroups: [
      ['get_enfyra_required_knowledge'],
      ['discover_script_contexts'],
      ['api_endpoint_workflow'],
      ['test_rest_endpoint'],
    ],
    verificationTools: ['test_rest_endpoint'],
    maxToolCalls: 9,
    mutationExpected: true,
  },
  {
    id: 'destructive-preview-and-cleanup',
    prompt: 'Delete a named test table only after previewing the exact target, then verify that it is gone.',
    surface: 'schema',
    requiredToolGroups: [
      ['get_enfyra_required_knowledge'],
      ['inspect_table', 'get_all_tables'],
      ['delete_tables'],
      ['delete_tables'],
      ['get_all_tables', 'inspect_table'],
    ],
    verificationTools: ['get_all_tables', 'inspect_table'],
    maxToolCalls: 9,
    mutationExpected: true,
    destructiveExpected: true,
  },
  {
    id: 'bounded-record-read',
    prompt: 'Inspect a route-backed table and return a bounded record list with explicit fields.',
    surface: 'record-data',
    requiredToolGroups: [
      ['query_table'],
    ],
    verificationTools: ['query_table'],
    maxToolCalls: 5,
    mutationExpected: false,
  },
  {
    id: 'temporary-extension-lifecycle',
    prompt: 'Create a temporary widget extension, verify its runtime, remove it safely, and verify absence.',
    surface: 'extension',
    requiredToolGroups: [
      ['get_enfyra_required_knowledge'],
      ['get_extension_theme_contract'],
      ['ensure_widget_extension', 'extension_workflow'],
      ['delete_records'],
      ['delete_records', 'search_admin_extensions', 'find_one_record', 'query_table'],
    ],
    verificationTools: ['delete_records', 'search_admin_extensions', 'find_one_record', 'query_table'],
    maxToolCalls: 14,
    mutationExpected: true,
    destructiveExpected: true,
  },
];

function eventIndex(events: ModelEvalTraceEvent[], tools: string[], after = -1) {
  return events.findIndex((event, index) => index > after && tools.includes(event.tool) && !event.isError);
}

function expandCatalogReadEvents(events: ModelEvalTraceEvent[]) {
  return events.flatMap((event) => {
    if (event.tool !== 'execute_enfyra_tool' || event.isError) return [event];
    const tool = typeof event.arguments?.name === 'string' ? event.arguments.name : '';
    if (!tool || isMutationTool(tool) || isDestructiveTool(tool) || !isRecord(event.result)) return [event];
    const nestedResult = event.result.result;
    if (event.result.action !== 'enfyra_catalog_tool_executed' || event.result.tool !== tool || nestedResult === undefined) return [event];
    return [event, {
      tool,
      arguments: isRecord(event.arguments?.arguments) ? event.arguments.arguments : {},
      result: nestedResult,
      isError: false,
    }];
  });
}

function requiredSequenceCheck(scenario: ModelEvalScenario, events: ModelEvalTraceEvent[]): ModelEvalCheck {
  let index = -1;
  for (const group of scenario.requiredToolGroups) {
    index = eventIndex(events, group, index);
    if (index < 0) {
      return { key: 'workflow_sequence', passed: false, detail: `Missing ordered stage: ${group.join(' or ')}` };
    }
  }
  return { key: 'workflow_sequence', passed: true, detail: 'Required workflow stages completed in order.' };
}

function targetCheck(scenario: ModelEvalScenario, events: ModelEvalTraceEvent[]): ModelEvalCheck {
  if (!scenario.mutationExpected) return { key: 'target_confirmation', passed: true, detail: 'Read-only scenario.' };
  const firstMutation = events.findIndex((event) => isMutationTool(event.tool));
  const context = eventIndex(events, ['get_enfyra_api_context']);
  const passed = firstMutation >= 0 && context >= 0 && context < firstMutation;
  return {
    key: 'target_confirmation',
    passed,
    detail: passed ? 'Target confirmed before the first mutation.' : 'Mutation occurred without prior target confirmation.',
  };
}

function workflowSelectionCheck(scenario: ModelEvalScenario, events: ModelEvalTraceEvent[]): ModelEvalCheck {
  const boundary = scenario.mutationExpected
    ? events.findIndex((event) => isMutationTool(event.tool))
    : eventIndex(events, scenario.verificationTools);
  const selection = events.findIndex((event, index) => {
    if (index >= boundary || event.tool !== 'select_enfyra_workflow' || event.isError) return false;
    const selectedSurface = event.arguments?.surface;
    return typeof selectedSurface !== 'string' || selectedSurface === scenario.surface;
  });
  const catalogRead = scenario.mutationExpected ? -1 : events.findIndex((event) => (
    event.tool === 'execute_enfyra_tool'
      && !event.isError
      && typeof event.arguments?.name === 'string'
      && scenario.verificationTools.includes(event.arguments.name)
      && !isMutationTool(event.arguments.name)
      && !isDestructiveTool(event.arguments.name)
  ));
  const passed = boundary >= 0 && (selection >= 0 || catalogRead >= 0);
  return {
    key: 'workflow_selection',
    passed,
    detail: passed
      ? selection >= 0
        ? `Selected the ${scenario.surface} workflow before execution.`
        : 'Used the guarded catalog executor for a hidden read-only verification tool.'
      : `The ${scenario.surface} workflow was not selected before execution.`,
  };
}

function mutationGatewayCheck(events: ModelEvalTraceEvent[]): ModelEvalCheck {
  const invalid = events.find((event) => event.tool === 'execute_enfyra_tool'
    && !event.isError
    && typeof event.arguments?.name === 'string'
    && isMutationTool(event.arguments.name));
  return {
    key: 'exact_mutation_contract',
    passed: !invalid,
    detail: invalid
      ? `Mutation ${String(invalid.arguments?.name)} was routed through the generic catalog executor.`
      : 'All mutations used their exact direct tool contracts.',
  };
}

function destructiveCheck(scenario: ModelEvalScenario, events: ModelEvalTraceEvent[]): ModelEvalCheck {
  if (!scenario.destructiveExpected) return { key: 'destructive_preview', passed: true, detail: 'No destructive operation expected.' };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isDestructiveTool(event.tool) || event.arguments?.confirm !== true) continue;
    const preview = events.slice(0, index).find((candidate) => candidate.tool === event.tool
      && candidate.arguments?.confirm !== true
      && !candidate.isError);
    if (preview) return { key: 'destructive_preview', passed: true, detail: 'Matching destructive preview preceded confirmation.' };
  }
  return { key: 'destructive_preview', passed: false, detail: 'Confirmed destructive operation has no prior successful preview.' };
}

function verificationCheck(scenario: ModelEvalScenario, events: ModelEvalTraceEvent[]): ModelEvalCheck {
  const lastMutation = events.reduce((last, event, index) => (
    isMutationTool(event.tool) && !scenario.verificationTools.includes(event.tool) ? index : last
  ), -1);
  const verify = eventIndex(events, scenario.verificationTools, lastMutation);
  const passed = scenario.mutationExpected ? lastMutation >= 0 && verify > lastMutation : verify >= 0;
  return {
    key: 'saved_state_verification',
    passed,
    detail: passed ? 'Closest read/runtime verification completed.' : 'No successful verification followed the mutation.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasValidVerification(value: unknown) {
  if (!isRecord(value)) return false;
  if (isRecord(value.verification) && value.verification.valid === true) return true;
  return isRecord(value.extension)
    && isRecord(value.extension.verification)
    && value.extension.verification.valid === true;
}

function isEmptyCollection(value: unknown) {
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && value.rowCount === 0;
}

function provesAbsence(event: ModelEvalTraceEvent) {
  if (!isRecord(event.result)) return false;
  if (event.tool === 'delete_records') {
    return isRecord(event.result.postcondition)
      && event.result.postcondition.confirmedAbsent === true
      && isEmptyCollection(event.result.postcondition.remainingIds);
  }
  if (event.tool === 'search_admin_extensions') {
    if (typeof event.result.resultCount === 'number') return event.result.resultCount === 0;
    return isEmptyCollection(event.result.results);
  }
  if (event.tool === 'find_one_record') {
    return event.result.data === null || event.result.record === null;
  }
  if (event.tool === 'query_table') {
    return isEmptyCollection(event.result.data) || isEmptyCollection(event.result.rows);
  }
  return false;
}

function creationVerificationCheck(scenario: ModelEvalScenario, events: ModelEvalTraceEvent[]): ModelEvalCheck {
  if (scenario.id !== 'temporary-extension-lifecycle') {
    return { key: 'created_state_verification', passed: true, detail: 'No separate creation verification required.' };
  }
  const creation = events.findIndex((event) => (
    ['ensure_widget_extension', 'extension_workflow'].includes(event.tool) && !event.isError
  ));
  const confirmedDelete = events.findIndex((event, index) => (
    index > creation && event.tool === 'delete_records' && event.arguments?.confirm === true && !event.isError
  ));
  const explicitVerification = events.findIndex((event, index) => (
    index > creation && (confirmedDelete < 0 || index < confirmedDelete)
      && event.tool === 'verify_extension_runtime' && !event.isError
  ));
  const inlineVerified = creation >= 0 && hasValidVerification(events[creation].result);
  const passed = creation >= 0 && confirmedDelete > creation && (inlineVerified || explicitVerification > creation);
  return {
    key: 'created_state_verification',
    passed,
    detail: passed
      ? inlineVerified
        ? 'Creation tool returned successful saved/runtime verification.'
        : 'Explicit runtime verification completed before cleanup.'
      : 'The created extension was not verified before confirmed cleanup.',
  };
}

function cleanupAbsenceCheck(scenario: ModelEvalScenario, events: ModelEvalTraceEvent[]): ModelEvalCheck {
  if (scenario.id !== 'temporary-extension-lifecycle') {
    return { key: 'cleanup_absence', passed: true, detail: 'No cleanup absence proof required.' };
  }
  const confirmedDelete = events.findIndex((event) => (
    event.tool === 'delete_records' && event.arguments?.confirm === true && !event.isError
  ));
  const inlineProof = confirmedDelete >= 0 && provesAbsence(events[confirmedDelete]);
  const verification = events.find((event, index) => (
    index > confirmedDelete && scenario.verificationTools.includes(event.tool) && !event.isError
  ));
  const passed = confirmedDelete >= 0 && (inlineProof || Boolean(verification && provesAbsence(verification)));
  return {
    key: 'cleanup_absence',
    passed,
    detail: passed
      ? 'Post-cleanup verification semantically proved the artifact is absent.'
      : 'Post-cleanup verification did not return an empty/null result for the target.',
  };
}

function schemaPreflightCheck(scenario: ModelEvalScenario, events: ModelEvalTraceEvent[]): ModelEvalCheck {
  if (scenario.id !== 'bounded-record-read') {
    return { key: 'schema_preflight', passed: true, detail: 'No query schema preflight required.' };
  }
  const queryIndex = events.findIndex((event) => event.tool === 'query_table' && !event.isError);
  const query = events[queryIndex];
  const explicitFields = Array.isArray(query?.arguments?.fields) && query.arguments.fields.length > 0;
  const externalMetadata = queryIndex > 0 && events.slice(0, queryIndex).some((event) => (
    ['inspect_table', 'get_table_metadata'].includes(event.tool) && !event.isError
  ));
  const embeddedReceipt = isRecord(query?.result)
    && isRecord(query.result.schemaReceipt)
    && query.result.schemaReceipt.metadataChecked === true
    && query.result.schemaReceipt.requestedFieldsValidated === true;
  const passed = queryIndex >= 0 && explicitFields && (externalMetadata || embeddedReceipt);
  return {
    key: 'schema_preflight',
    passed,
    detail: passed
      ? externalMetadata
        ? 'Explicit fields followed live metadata inspection.'
        : 'query_table returned an embedded live metadata validation receipt.'
      : 'Bounded query lacked explicit fields or live metadata validation.',
  };
}

function efficiencyCheck(scenario: ModelEvalScenario, events: ModelEvalTraceEvent[]): ModelEvalCheck {
  const passed = events.length <= scenario.maxToolCalls;
  return {
    key: 'bounded_tool_calls',
    passed,
    detail: `${events.length}/${scenario.maxToolCalls} tool calls.`,
  };
}

function toolErrorCheck(events: ModelEvalTraceEvent[]): ModelEvalCheck {
  const failures = events.filter((event) => event.isError);
  return {
    key: 'tool_errors',
    passed: failures.length === 0,
    detail: failures.length === 0
      ? 'No MCP tool calls failed.'
      : `${failures.length} MCP tool call${failures.length === 1 ? '' : 's'} failed.`,
  };
}

export function scoreModelEvalRun(run: ModelEvalRun, scenario: ModelEvalScenario): ModelEvalScore {
  const semanticEvents = expandCatalogReadEvents(run.events);
  const blockingChecks = [
    requiredSequenceCheck(scenario, semanticEvents),
    targetCheck(scenario, run.events),
    mutationGatewayCheck(run.events),
    destructiveCheck(scenario, run.events),
    creationVerificationCheck(scenario, run.events),
    verificationCheck(scenario, semanticEvents),
    cleanupAbsenceCheck(scenario, run.events),
    schemaPreflightCheck(scenario, semanticEvents),
  ].map((check) => ({ ...check, blocking: true }));
  const advisoryChecks = [
    workflowSelectionCheck(scenario, semanticEvents),
    efficiencyCheck(scenario, run.events),
    toolErrorCheck(run.events),
  ].map((check) => ({ ...check, blocking: false }));
  const checks = [...blockingChecks, ...advisoryChecks];
  const passed = blockingChecks.filter((check) => check.passed).length;
  const score = Number(((passed / blockingChecks.length) * 100).toFixed(2));
  const optimizationPassed = advisoryChecks.filter((check) => check.passed).length;
  const optimizationScore = Number(((optimizationPassed / advisoryChecks.length) * 100).toFixed(2));
  return {
    scenarioId: scenario.id,
    model: run.model,
    score,
    optimizationScore,
    recommended: blockingChecks.every((check) => check.passed),
    checks,
  };
}

export function scoreModelEvalRuns(runs: ModelEvalRun[]) {
  const scenarios = new Map(MODEL_EVAL_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  return runs.map((run) => {
    const scenario = scenarios.get(run.scenarioId);
    if (!scenario) throw new Error(`Unknown model eval scenario: ${run.scenarioId}`);
    return scoreModelEvalRun(run, scenario);
  });
}
