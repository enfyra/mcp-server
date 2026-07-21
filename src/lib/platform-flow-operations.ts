import { z } from 'zod';
import { createHash } from 'node:crypto';
import { fetchAPI } from './fetch.js';
import { fetchTableCatalog, fetchTableMetadata, fetchTableMetadataByRef, resolveTableCatalogEntry } from './metadata-client.js';
import {
  assertCustomEndpointRoute,
  assertDynamicEndpointContract,
  extractExplicitRepositoryTableNames,
  reviewDynamicEndpointContract,
} from './dynamic-endpoint-contract.js';
import { validatePortableScriptSource, validateScriptSourceIfPresent } from './mutation-guards.js';
import { writeSourceArtifact } from './source-artifacts.js';
import {
  normalizeEscapedVueSource,
  normalizeStrictBoolean,
} from './tool-input-normalization.js';
import {
  analyzeExtensionSfc,
  extensionElementAttributeValue,
  extensionElementHasAttribute,
} from './extension-sfc-analyzer.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAck,
  assertGlobalRulesAck,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';
import {
  createOrPatch,
  findRecord,
  normalizeFlowStepBody,
} from './platform-data-operations.js';
import {
  naturalPartialReload,
  parseJsonArrayArg,
  parseJsonObjectArg,
  sha256Text,
  validateDynamicScript,
} from './platform-extension-source.js';
import {
  getId,
} from './platform-route-operations.js';
import {
  step,
} from './platform-endpoint-workflow.js';

export async function ensureFlow(apiUrl, {
  name,
  triggerType = 'manual',
  triggerConfig,
  timeout,
  maxExecutions = 100,
  isEnabled = true,
  description,
  globalRulesAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  const existing = await findRecord(apiUrl, 'enfyra_flow', { name: { _eq: name } }, 'id,_id,name');
  const operation = await createOrPatch(apiUrl, 'enfyra_flow', existing, {
    name,
    triggerType,
    triggerConfig: parseJsonObjectArg('triggerConfig', triggerConfig, {}),
    timeout,
    maxExecutions,
    isEnabled,
    description,
  });
  const reload = naturalPartialReload('Flow metadata writes trigger the server partial reload contract; there is no dedicated flow reload endpoint.');
  return { action: 'flow_ensured', flow: { id: operation.id, name }, operation, reload };
}

export async function ensureFlowStep(apiUrl, {
  flowName,
  flowId,
  key,
  type,
  order,
  config,
  sourceCode,
  scriptLanguage,
  timeout,
  isEnabled,
  globalRulesAckKey,
  knowledgeAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  if (!flowName && !flowId) throw new Error('Provide flowName or flowId.');
  if (flowName && flowId) throw new Error('Provide flowName or flowId, not both.');
  const flow = flowId
    ? await findRecord(apiUrl, 'enfyra_flow', { id: { _eq: flowId } }, 'id,_id,name')
    : await findRecord(apiUrl, 'enfyra_flow', { name: { _eq: flowName } }, 'id,_id,name');
  if (!flow) throw new Error(`Flow not found: ${flowId || flowName}`);
  const parsedConfig = parseJsonObjectArg('config', config, {});
  assertDynamicCodeKnowledgeAckIf(Boolean(sourceCode && ['script', 'condition'].includes(type)), knowledgeAckKey);
  const validation = sourceCode && ['script', 'condition'].includes(type)
    ? await validateDynamicScript(apiUrl, sourceCode, scriptLanguage)
    : { validated: false, reason: 'no script validation required' };
  const existing = await findRecord(apiUrl, 'enfyra_flow_step', {
    flow: { id: { _eq: getId(flow) } },
    key: { _eq: key },
  }, 'id,_id,key,flow.id');
  const operation = await createOrPatch(apiUrl, 'enfyra_flow_step', existing, normalizeFlowStepBody({
    key,
    type,
    order,
    config: parsedConfig,
    sourceCode,
    scriptLanguage,
    timeout,
    isEnabled,
  }, getId(flow)));
  const reload = naturalPartialReload('Flow step writes trigger the server partial reload contract; there is no dedicated flow reload endpoint.');
  return { action: 'flow_step_ensured', flow: { id: getId(flow), name: flow.name }, step: { id: operation.id, key, type }, validation, operation, reload };
}

export const FLOW_STEP_TOOL_GUIDANCE = [
  {
    tool: 'ensure_query_flow_step',
    type: 'query',
    when: 'Read/list records from one table without custom branching or transformation.',
    config: { table: 'table_name', filter: {}, fields: 'id,name', limit: 20, sort: '-createdAt' },
  },
  {
    tool: 'ensure_create_flow_step',
    type: 'create',
    when: 'Create one record from static config only. Fixed step config is not template-transformed; use a script step when data comes from @FLOW_PAYLOAD, @FLOW_LAST, or @FLOW.',
    config: { table: 'table_name', data: { field: 'value' } },
  },
  {
    tool: 'ensure_update_flow_step',
    type: 'update',
    when: 'Update one statically known record. Use a script step when id or data comes from runtime flow values.',
    config: { table: 'table_name', id: '<static-id>', data: { field: 'value' } },
  },
  {
    tool: 'ensure_delete_flow_step',
    type: 'delete',
    when: 'Delete one statically known record. Use a script step when id comes from runtime flow values.',
    config: { table: 'table_name', id: '<static-id>' },
  },
  {
    tool: 'ensure_http_flow_step',
    type: 'http',
    when: 'Call an external HTTP API.',
    config: { url: 'https://example.com/api', method: 'POST', headers: {}, body: {}, timeout: 10000 },
  },
  {
    tool: 'ensure_condition_flow_step',
    type: 'condition',
    when: 'Branch into true/false child steps based on JavaScript truthiness.',
    sourceCode: 'return Boolean(@FLOW_PAYLOAD.enabled)',
  },
  {
    tool: 'ensure_sleep_flow_step',
    type: 'sleep',
    when: 'Wait for a short bounded delay.',
    config: { ms: 1000 },
  },
  {
    tool: 'ensure_trigger_flow_step',
    type: 'trigger_flow',
    when: 'Trigger another flow as a child/orchestration step.',
    config: { flowName: 'child-flow', payload: {} },
  },
  {
    tool: 'ensure_log_flow_step',
    type: 'log',
    when: 'Record a small execution note for diagnostics.',
    config: { message: 'Reached step_name' },
  },
  {
    tool: 'ensure_script_flow_step',
    type: 'script',
    when: 'Use only when logic needs loops, multiple tables, crypto, package calls, non-trivial transforms, or runtime checks not covered by the atomic step tools.',
    sourceCode: 'return { ok: true }',
  },
];

export function chooseFlowStepTool(intent) {
  const text = String(intent || '').toLowerCase();
  const hasAny = (patterns) => patterns.some((pattern) => pattern.test(text));
  if (hasAny([/\bif\b/, /\belse\b/, /\bbranch\b/, /\bcondition\b/, /\bwhen\b/, /\bcheck\b/, /nếu/, /điều kiện/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'condition');
  if (hasAny([/\bhttp\b/, /\bapi\b/, /\bwebhook\b/, /\bfetch\b/, /\brequest\b/, /\bpost\b/, /\bget\b/, /\bcall\b/, /gọi api/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'http');
  if (hasAny([/\bsleep\b/, /\bwait\b/, /\bdelay\b/, /\bpause\b/, /chờ/, /đợi/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'sleep');
  if (hasAny([/\btrigger\b/, /\bchild flow\b/, /\banother flow\b/, /\bsubflow\b/, /flow khác/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'trigger_flow');
  if (hasAny([/\bdelete\b/, /\bremove\b/, /\bdestroy\b/, /xóa/, /xoá/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'delete');
  if (hasAny([/\bupdate\b/, /\bpatch\b/, /\bset\b/, /\bmark\b/, /\bchange\b/, /cập nhật/, /đánh dấu/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'update');
  if (hasAny([/\bcreate\b/, /\binsert\b/, /\badd\b/, /\bstore\b/, /\bsave\b/, /tạo/, /thêm/, /lưu/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'create');
  if (hasAny([/\blog\b/, /\bdebug\b/, /\btrace\b/, /ghi log/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'log');
  if (hasAny([/\bquery\b/, /\bfind\b/, /\blist\b/, /\bread\b/, /\bload\b/, /\bcount\b/, /\bsearch\b/, /đọc/, /tìm/, /liệt kê/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'query');
  return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'script');
}

const FIXED_FLOW_STEP_TYPES = new Set(['query', 'create', 'update', 'delete', 'http', 'sleep', 'trigger_flow', 'log']);

const FLOW_RUNTIME_MACRO_PATTERN = /@FLOW(?:_PAYLOAD|_LAST|_META)?\b/u;

function findFlowRuntimeMacro(value): string | null {
  if (typeof value === 'string') return FLOW_RUNTIME_MACRO_PATTERN.exec(value)?.[0] || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findFlowRuntimeMacro(item);
      if (match) return match;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const item of Object.values(value)) {
    const match = findFlowRuntimeMacro(item);
    if (match) return match;
  }
  return null;
}

export function assertFixedFlowStepConfigIsStatic(type, config, index = 0) {
  if (!FIXED_FLOW_STEP_TYPES.has(String(type))) return;
  const macro = findFlowRuntimeMacro(config);
  if (!macro) return;
  throw new Error(
    `steps[${index}] uses ${macro} inside a ${type} config, but ESV fixed flow step configs are static and are not template-transformed. Use a script step for runtime payload/previous-step values, keep one business operation in that script, and call @LOGS(message, details?) for captured logs.`
  );
}

export function planFlowSteps(steps) {
  const items = Array.isArray(steps) ? steps : [];
  return items.map((step, index) => {
    const intent = typeof step === 'string' ? step : step?.intent;
    const key = typeof step === 'object' && step?.key ? String(step.key) : `step_${index + 1}`;
    const recommendation: any = chooseFlowStepTool(intent);
    return {
      order: index + 1,
      key,
      intent,
      tool: recommendation.tool,
      type: recommendation.type,
      suggestedInput: {
        key,
        name: typeof step === 'object' && step?.name ? step.name : key.replace(/_/g, ' '),
        order: index + 1,
        ...(recommendation.config ? { config: recommendation.config } : {}),
        ...(recommendation.sourceCode ? { sourceCode: recommendation.sourceCode } : {}),
        ...(recommendation.condition ? { condition: recommendation.condition } : {}),
      },
      reason: recommendation.when,
    };
  });
}

function normalizeFlowWorkflowStep(step, index) {
  const input = typeof step === 'string' ? { intent: step } : (step || {});
  const intent = String(input.intent || input.name || input.key || `Step ${index + 1}`);
  const recommended = chooseFlowStepTool(input.type || intent);
  const type = String(input.type || recommended.type || 'script');
  const guidance = FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === type);
  if (!guidance) {
    throw new Error(`steps[${index}].type must be one of ${FLOW_STEP_TOOL_GUIDANCE.map((item) => item.type).join(', ')}.`);
  }
  const key = String(input.key || intent)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || `step_${index + 1}`;
  const normalized = {
    index,
    key,
    name: input.name || intent,
    intent,
    type,
    order: input.order ?? index * 10,
    config: input.config ?? guidance.config ?? {},
    sourceCode: input.sourceCode ?? guidance.sourceCode,
    scriptLanguage: input.scriptLanguage || 'javascript',
    timeout: input.timeout,
    isEnabled: input.isEnabled ?? true,
    chosenByIntent: !input.type,
    recommendedTool: guidance.tool,
  };
  assertFixedFlowStepConfigIsStatic(type, normalized.config, index);
  return normalized;
}

export async function runFlowWorkflow(apiUrl, opts) {
  const steps = parseJsonArrayArg('steps', opts.steps, []);
  const plan = steps.map(normalizeFlowWorkflowStep);
  const hasDynamicCode = plan.some((step) => ['script', 'condition'].includes(step.type) && step.sourceCode);
  const triggerType = opts.triggerType || 'manual';
  const flowInput = {
    name: opts.name,
    triggerType,
    triggerConfig: triggerType === 'schedule' ? opts.triggerConfig : (opts.triggerConfig ?? {}),
    timeout: opts.timeout,
    maxExecutions: opts.maxExecutions,
    isEnabled: opts.isEnabled,
    description: opts.description,
    globalRulesAckKey: opts.globalRulesAckKey,
  };

  if (!opts.apply) {
    return {
      action: 'flow_workflow_planned',
      flow: {
        name: opts.name,
        triggerType,
      },
      stepCount: plan.length,
      plan,
      requiredAckParams: ['globalRulesAckKey', ...(hasDynamicCode ? ['knowledgeAckKey'] : [])],
      nextSteps: [
        'Review the plan. Prefer fixed step types only for static config; ESV does not interpolate @FLOW_PAYLOAD/@FLOW_LAST/@FLOW inside fixed-step config. Use one focused script step when runtime values are required.',
        'Call flow_workflow again with apply=true and the required ack params to create/update the flow and steps sequentially.',
        'Use test_flow_step for script, condition, or high-risk steps before triggering the flow.',
      ],
    };
  }

  if (!opts.name) throw new Error('name is required.');
  assertGlobalRulesAck(opts.globalRulesAckKey);
  if (hasDynamicCode) assertDynamicCodeKnowledgeAck(opts.knowledgeAckKey);
  const flowResult = await ensureFlow(apiUrl, flowInput);
  const flowId = flowResult.flow.id;
  const operations = [];
  for (const step of plan) {
    const result = await ensureFlowStep(apiUrl, {
      flowName: undefined,
      flowId,
      key: step.key,
      type: step.type,
      order: step.order,
      config: step.config,
      sourceCode: step.sourceCode,
      scriptLanguage: step.scriptLanguage,
      timeout: step.timeout,
      isEnabled: step.isEnabled,
      globalRulesAckKey: opts.globalRulesAckKey,
      knowledgeAckKey: opts.knowledgeAckKey,
    });
    operations.push({
      index: step.index,
      key: step.key,
      type: step.type,
      result,
    });
  }
  return {
    action: 'flow_workflow_applied',
    flow: flowResult.flow,
    flowResult: {
      action: flowResult.action,
      flow: flowResult.flow,
      reload: flowResult.reload,
    },
    stepCount: plan.length,
    plan: plan.map(({ sourceCode, ...step }) => ({
      ...step,
      ...(sourceCode ? { source: { length: sourceCode.length, sha256: sha256Text(sourceCode) } } : {}),
    })),
    operations: operations.map((operation) => ({
      index: operation.index,
      key: operation.key,
      type: operation.type,
      action: operation.result.action,
      flow: operation.result.flow,
      step: operation.result.step,
      validation: operation.result.validation,
      reload: operation.result.reload,
    })),
    sequential: true,
    nextSteps: [
      'Use test_flow_step for script, condition, or high-risk steps before triggering the flow.',
      'Use trigger_flow only after saved behavior is verified.',
    ],
  };
}
