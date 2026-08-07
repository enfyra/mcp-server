import {
  createOrPatch,
  findRecord,
  fetchRecords,
  normalizeFlowStepBody,
} from './platform-data-operations.js';
import { fetchAPI } from './fetch.js';
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
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertGlobalRulesAck
} from './required-knowledge.js';
import { materializeSourceInput } from './source-artifacts.js';
import { executeSequentialBatch } from './sequential-batch.js';

export async function ensureFlow(apiUrl, {
  name,
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
    timeout,
    maxExecutions,
    isEnabled,
    description,
  });
  const reload = naturalPartialReload('Flow metadata writes trigger the server partial reload contract; there is no dedicated flow reload endpoint.');
  return { action: 'flow_ensured', flow: { id: operation.id, name }, operation, reload };
}

export async function ensureFlowTrigger(apiUrl, {
  flowName,
  flowId,
  type,
  config,
  tableEvent,
  routeId,
  tableId,
  isEnabled = true,
  globalRulesAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  const parsedConfig = parseJsonObjectArg('config', config, {});
  if (!flowName && !flowId) throw new Error('Provide flowName or flowId.');
  const flow = flowId
    ? await findRecord(apiUrl, 'enfyra_flow', { id: { _eq: flowId } }, 'id,_id,name')
    : await findRecord(apiUrl, 'enfyra_flow', { name: { _eq: flowName } }, 'id,_id,name');
  if (!flow) throw new Error(`Flow not found: ${flowId || flowName}`);
  const fid = getId(flow);
  if (type === 'schedule' && !parsedConfig?.cron) throw new Error('Schedule trigger requires config.cron.');
  if (type === 'event' && !tableId) throw new Error('Event trigger requires tableId.');
  if (type === 'event' && !tableEvent) throw new Error('Event trigger requires tableEvent (create|update|delete).');
  if (type === 'webhook' && !routeId) throw new Error('Webhook trigger requires routeId.');
  const existing = await findRecord(apiUrl, 'enfyra_flow_trigger', {
    flow: { id: { _eq: fid } },
    type: { _eq: type },
    ...(type === 'event' ? { tableEvent: { _eq: tableEvent }, table: { id: { _eq: tableId } } } : {}),
    ...(type === 'webhook' ? { route: { id: { _eq: routeId } } } : {}),
  }, 'id,_id,type');
  const body = {
    type,
    isEnabled,
    config: parsedConfig,
    tableEvent: type === 'event' ? tableEvent : null,
    route: type === 'webhook' ? { id: routeId } : null,
    table: type === 'event' ? { id: tableId } : null,
  };
  const operation = await createOrPatch(apiUrl, 'enfyra_flow_trigger', existing, {
    ...body,
    flow: { id: fid },
  });
  const reload = naturalPartialReload('Flow trigger writes trigger the server partial reload contract.');
  return { action: 'flow_trigger_ensured', flow: { id: fid, name: flow.name }, trigger: { id: operation.id, type }, operation, reload };
}

export async function removeFlowTrigger(apiUrl, {
  flowName,
  flowId,
  type,
  triggerId,
  globalRulesAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  if (!triggerId && !flowName && !flowId) throw new Error('Provide triggerId, or flowName/flowId with optional type.');
  let filter;
  let flowRef = null;
  if (triggerId) {
    filter = { id: { _eq: triggerId } };
  } else {
    const flow = flowId
      ? await findRecord(apiUrl, 'enfyra_flow', { id: { _eq: flowId } }, 'id,_id,name')
      : await findRecord(apiUrl, 'enfyra_flow', { name: { _eq: flowName } }, 'id,_id,name');
    if (!flow) throw new Error(`Flow not found: ${flowId || flowName}`);
    flowRef = { id: getId(flow), name: flow.name };
    filter = { flow: { id: { _eq: flowRef.id } }, ...(type ? { type: { _eq: type } } : {}) };
  }
  const existing = await findRecord(apiUrl, 'enfyra_flow_trigger', filter, 'id,_id,type,isEnabled');
  if (!existing) return { action: 'flow_trigger_not_found', ...(flowRef ? { flow: flowRef } : {}) };
  const operation = await createOrPatch(apiUrl, 'enfyra_flow_trigger', existing, { isEnabled: false });
  return { action: 'flow_trigger_disabled', ...(flowRef ? { flow: flowRef } : {}), trigger: { id: getId(existing), type: existing.type }, operation };
}

async function resolveFlowForOperation(apiUrl, { flowName, flowId }) {
  if (!flowName && flowId === undefined) throw new Error('Provide flowName or flowId.');
  if (flowName && flowId !== undefined) throw new Error('Provide flowName or flowId, not both.');
  const flow = flowId !== undefined
    ? await findRecord(apiUrl, 'enfyra_flow', { id: { _eq: flowId } }, 'id,_id,name,isEnabled,description,timeout,maxExecutions')
    : await findRecord(apiUrl, 'enfyra_flow', { name: { _eq: flowName } }, 'id,_id,name,isEnabled,description,timeout,maxExecutions');
  if (!flow) throw new Error(`Flow not found: ${flowId ?? flowName}`);
  return flow;
}

function summarizeFlowRows(rows, fields) {
  return rows.map((row) => Object.fromEntries(fields.map((field) => [field, field === 'id' ? getId(row) : row[field]])));
}

function parentId(row) {
  return row.parent?.id ?? row.parent?._id ?? null;
}

function orderFlowStepsForDeletion(rows) {
  const byId = new Map(rows.map((row) => [String(getId(row)), row]));
  const depth = (row) => {
    let current = row;
    let value = 0;
    const seen = new Set();
    while (current) {
      const currentId = String(getId(current));
      if (seen.has(currentId)) break;
      seen.add(currentId);
      const currentParentId = parentId(current);
      if (currentParentId === null || currentParentId === undefined) break;
      value += 1;
      current = byId.get(String(currentParentId));
    }
    return value;
  };
  return [...rows].sort((left, right) => depth(right) - depth(left));
}

function isDescendantOf(row, ancestorId, byId) {
  let currentParentId = parentId(row);
  const seen = new Set();
  while (currentParentId !== null && currentParentId !== undefined) {
    const parentKey = String(currentParentId);
    if (parentKey === String(ancestorId)) return true;
    if (seen.has(parentKey)) return false;
    seen.add(parentKey);
    const parent = byId.get(parentKey);
    if (!parent) return false;
    currentParentId = parentId(parent);
  }
  return false;
}

async function verifyFlowAbsent(apiUrl, flowId) {
  const [flow, triggers, steps] = await Promise.all([
    findRecord(apiUrl, 'enfyra_flow', { id: { _eq: flowId } }, 'id,_id,name'),
    fetchRecords(apiUrl, 'enfyra_flow_trigger', { flow: { id: { _eq: flowId } } }, 'id,_id,type', 1000),
    fetchRecords(apiUrl, 'enfyra_flow_step', { flow: { id: { _eq: flowId } } }, 'id,_id,key,type', 1000),
  ]);
  return {
    verificationMethod: 'flow_and_owned_records_reloaded',
    confirmedAbsent: !flow && triggers.length === 0 && steps.length === 0,
    remainingFlow: flow ? { id: getId(flow), name: flow.name } : null,
    remainingTriggerIds: triggers.map(getId),
    remainingStepIds: steps.map(getId),
  };
}

function isNotFoundFlowDeleteError(error) {
  return /API error \(404\)|not found/i.test(error instanceof Error ? error.message : String(error));
}

export async function deleteFlow(apiUrl, {
  flowName,
  flowId,
  expectedFlowId,
  expectedFlowName,
  confirm = false,
  skipNotFound = true,
  globalRulesAckKey,
}) {
  const flow = await resolveFlowForOperation(apiUrl, { flowName, flowId });
  const resolvedFlowId = getId(flow);
  if (confirm && (expectedFlowId === undefined || expectedFlowId === null)) {
    throw new Error('expectedFlowId is required when confirm=true. Pass the exact flow id returned by the preview.');
  }
  if (expectedFlowId !== undefined && expectedFlowId !== null && String(resolvedFlowId) !== String(expectedFlowId)) {
    throw new Error(`Flow id mismatch: resolved ${resolvedFlowId}, expected ${expectedFlowId}.`);
  }
  if (flow.isEnabled !== false) {
    if (confirm) {
      throw new Error(`Cannot delete enabled flow ${resolvedFlowId} (${flow.name}). Disable it first with ensure_flow(isEnabled=false), then request a fresh delete preview.`);
    }
    return {
      action: 'delete_flow_blocked_enabled',
      status: 'blocked_enabled',
      flow: { id: resolvedFlowId, name: flow.name, isEnabled: true },
      postcondition: {
        verificationMethod: 'not_run_enabled_flow',
        confirmedAbsent: false,
        remainingFlow: { id: resolvedFlowId, name: flow.name },
        remainingTriggerIds: [],
        remainingStepIds: [],
      },
      next: 'Disable the flow with ensure_flow(isEnabled=false), then request a fresh delete_flow preview before confirming deletion.',
    };
  }
  if (confirm && !expectedFlowName) {
    throw new Error('expectedFlowName is required when confirm=true. Pass the exact flow name returned by the preview.');
  }
  if (expectedFlowName && flow.name !== expectedFlowName) {
    throw new Error(`Flow name mismatch: resolved ${flow.name}, expected ${expectedFlowName}.`);
  }

  const [triggers, steps] = await Promise.all([
    fetchRecords(apiUrl, 'enfyra_flow_trigger', { flow: { id: { _eq: resolvedFlowId } } }, 'id,_id,type,isEnabled', 1000),
    fetchRecords(apiUrl, 'enfyra_flow_step', { flow: { id: { _eq: resolvedFlowId } } }, 'id,_id,key,type,stepOrder,isEnabled,parent.id', 1000),
  ]);
  const orderedSteps = orderFlowStepsForDeletion(steps);
  const preview = {
    flow: {
      id: resolvedFlowId,
      name: flow.name,
      isEnabled: flow.isEnabled !== false,
    },
    dependencies: {
      triggers: summarizeFlowRows(triggers, ['id', 'type', 'isEnabled']),
      steps: summarizeFlowRows(orderedSteps, ['id', 'key', 'type', 'stepOrder', 'isEnabled']),
    },
  };

  if (!confirm) {
    return {
      action: 'delete_flow_preview',
      ...preview,
      postcondition: {
        verificationMethod: 'not_run_preview',
        confirmedAbsent: false,
        remainingFlow: { id: resolvedFlowId, name: flow.name },
        remainingTriggerIds: triggers.map(getId),
        remainingStepIds: orderedSteps.map(getId),
      },
      next: 'Call delete_flow again with the same locator, confirm=true, expectedFlowId, and expectedFlowName from this preview.',
    };
  }

  assertGlobalRulesAck(globalRulesAckKey);
  const targets = [
    ...triggers.map((row) => ({ tableName: 'enfyra_flow_trigger', category: 'trigger', id: getId(row) })),
    ...orderedSteps.map((row) => ({ tableName: 'enfyra_flow_step', category: 'step', id: getId(row) })),
    { tableName: 'enfyra_flow', category: 'flow', id: resolvedFlowId },
  ];
  const batch = await executeSequentialBatch(targets, async (target) => {
    try {
      const result = await fetchAPI(apiUrl, `/${target.tableName}/${encodeURIComponent(String(target.id))}`, { method: 'DELETE' });
      return { category: target.category, id: target.id, statusCode: result?.statusCode, success: result?.success };
    } catch (error) {
      if (skipNotFound && isNotFoundFlowDeleteError(error)) {
        return { category: target.category, id: target.id, status: 'skipped_not_found', skipped: true };
      }
      throw error;
    }
  });
  const postcondition = await verifyFlowAbsent(apiUrl, resolvedFlowId);
  if (batch.status === 'partial_failure') {
    return {
      action: 'delete_flow_partial_failure',
      status: 'partial_failure',
      ...preview,
      deleted: batch.completed,
      failure: { ...batch.failure, target: targets[batch.failure.index] },
      remainingIndexes: batch.remainingIndexes,
      remainingTargets: batch.remainingIndexes.map((index) => targets[index]),
      requiresNewPreview: true,
      postcondition,
    };
  }
  return {
    action: 'flow_deleted',
    ...preview,
    deleted: batch.completed,
    postcondition,
    flowReload: naturalPartialReload('Flow deletion reloads the active flow registry and removes queued execution jobs owned by the deleted flow.'),
  };
}

export async function deleteFlowStep(apiUrl, {
  flowName,
  flowId,
  stepId,
  stepKey,
  expectedFlowId,
  expectedStepId,
  confirm = false,
  globalRulesAckKey,
}) {
  if (stepId === undefined && !stepKey) throw new Error('Provide stepId or stepKey.');
  if (stepId !== undefined && stepKey) throw new Error('Provide stepId or stepKey, not both.');
  if (stepKey && !flowName && flowId === undefined) throw new Error('flowName or flowId is required when locating a step by stepKey.');
  const flow = flowName || flowId !== undefined ? await resolveFlowForOperation(apiUrl, { flowName, flowId }) : null;
  const resolvedFlowId = flow ? getId(flow) : null;
  const step = stepId !== undefined
    ? await findRecord(apiUrl, 'enfyra_flow_step', { id: { _eq: stepId } }, 'id,_id,key,type,stepOrder,isEnabled,flow.id,flow.name,parent.id')
    : await findRecord(apiUrl, 'enfyra_flow_step', { flow: { id: { _eq: resolvedFlowId } }, key: { _eq: stepKey } }, 'id,_id,key,type,stepOrder,isEnabled,flow.id,flow.name,parent.id');
  if (!step) throw new Error(`Flow step not found: ${stepId ?? stepKey}`);
  const resolvedStepId = getId(step);
  const stepFlowId = step.flow?.id ?? step.flow?._id ?? null;
  if (resolvedFlowId !== null && String(stepFlowId) !== String(resolvedFlowId)) {
    throw new Error(`Flow step ${resolvedStepId} does not belong to flow ${resolvedFlowId}.`);
  }
  if (confirm && (expectedStepId === undefined || expectedStepId === null)) {
    throw new Error('expectedStepId is required when confirm=true. Pass the exact step id returned by the preview.');
  }
  if (confirm && (expectedFlowId === undefined || expectedFlowId === null)) {
    throw new Error('expectedFlowId is required when confirm=true. Pass the exact flow id returned by the preview.');
  }
  if (expectedStepId !== undefined && expectedStepId !== null && String(resolvedStepId) !== String(expectedStepId)) {
    throw new Error(`Flow step id mismatch: resolved ${resolvedStepId}, expected ${expectedStepId}.`);
  }
  if (expectedFlowId !== undefined && expectedFlowId !== null && String(stepFlowId) !== String(expectedFlowId)) {
    throw new Error(`Flow step flow id mismatch: resolved ${stepFlowId}, expected ${expectedFlowId}.`);
  }
  const allSteps = stepFlowId
    ? await fetchRecords(apiUrl, 'enfyra_flow_step', { flow: { id: { _eq: stepFlowId } } }, 'id,_id,key,type,stepOrder,isEnabled,parent.id', 1000)
    : [];
  const allStepsById = new Map(allSteps.map((row) => [String(getId(row)), row]));
  const children = allSteps.filter((row) => isDescendantOf(row, resolvedStepId, allStepsById));
  const orderedSteps = orderFlowStepsForDeletion([step, ...children]);
  const preview = {
    flow: { id: stepFlowId, name: step.flow?.name ?? flow?.name ?? null },
    step: { id: resolvedStepId, key: step.key, type: step.type, stepOrder: step.stepOrder, isEnabled: step.isEnabled !== false },
    dependencies: { childSteps: summarizeFlowRows(orderedSteps.filter((row) => String(getId(row)) !== String(resolvedStepId)), ['id', 'key', 'type', 'stepOrder', 'isEnabled']) },
  };
  if (!confirm) {
    return {
      action: 'delete_flow_step_preview',
      ...preview,
      postcondition: {
        verificationMethod: 'not_run_preview',
        confirmedAbsent: false,
        remainingStepIds: orderedSteps.map(getId),
      },
      next: 'Call delete_flow_step again with the same locator, confirm=true, expectedFlowId, and expectedStepId from this preview.',
    };
  }
  assertGlobalRulesAck(globalRulesAckKey);
  const batch = await executeSequentialBatch(orderedSteps, async (target) => fetchAPI(
    apiUrl,
    `/enfyra_flow_step/${encodeURIComponent(String(getId(target)))}`,
    { method: 'DELETE' },
  ));
  const remaining = await fetchRecords(apiUrl, 'enfyra_flow_step', { id: { _in: orderedSteps.map(getId) } }, 'id,_id,key', 1000);
  const postcondition = {
    verificationMethod: 'flow_steps_reloaded',
    confirmedAbsent: batch.status === 'completed' && remaining.length === 0,
    remainingStepIds: remaining.map(getId),
  };
  return {
    action: batch.status === 'partial_failure'
      ? 'delete_flow_step_partial_failure'
      : postcondition.confirmedAbsent ? 'flow_step_deleted' : 'delete_flow_step_unverified',
    ...preview,
    ...(batch.status === 'partial_failure'
      ? {
        status: 'partial_failure',
        deleted: batch.completed,
        failure: batch.failure,
        remainingIndexes: batch.remainingIndexes,
        remainingTargets: batch.remainingIndexes.map((index) => orderedSteps[index]),
        requiresNewPreview: true,
      }
      : { deleted: batch.completed }),
    postcondition,
    reload: naturalPartialReload('Flow step deletion reloads the active flow registry.'),
  };
}

export async function ensureFlowStep(apiUrl, {
  flowName,
  flowId,
  key,
  type,
  order,
  config,
  sourceCode,
  sourceFile,
  sourceResourceUri,
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
  const dynamicType = ['script', 'condition'].includes(type);
  if (dynamicType && sourceCode === undefined && sourceFile === undefined && sourceResourceUri === undefined) {
    throw new Error(`${type} flow steps require sourceCode, sourceFile, or sourceResourceUri.`);
  }
  const materialized = dynamicType && (sourceCode !== undefined || sourceFile !== undefined || sourceResourceUri !== undefined)
    ? materializeSourceInput({
      source: sourceCode,
      sourceFile,
      sourceResourceUri,
      fieldName: 'sourceCode',
      tableName: 'enfyra_flow_step',
      id: key,
    })
    : null;
  const effectiveSourceCode = materialized?.source;
  assertDynamicCodeKnowledgeAckIf(Boolean(effectiveSourceCode), knowledgeAckKey);
  const validation = effectiveSourceCode
    ? await validateDynamicScript(apiUrl, effectiveSourceCode, scriptLanguage)
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
    sourceCode: effectiveSourceCode,
    scriptLanguage,
    timeout,
    isEnabled,
  }, getId(flow)));
  const reload = naturalPartialReload('Flow step writes trigger the server partial reload contract; there is no dedicated flow reload endpoint.');
  return { action: 'flow_step_ensured', flow: { id: getId(flow), name: flow.name }, step: { id: operation.id, key, type }, validation, ...(materialized ? { sourceArtifact: materialized.sourceArtifact } : {}), operation, reload };
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
    sourceCode: input.sourceCode ?? (input.sourceFile || input.sourceResourceUri ? undefined : guidance.sourceCode),
    sourceFile: input.sourceFile,
    sourceResourceUri: input.sourceResourceUri,
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
  const hasDynamicCode = plan.some((step) => ['script', 'condition'].includes(step.type) && (step.sourceCode || step.sourceFile || step.sourceResourceUri));
  const flowInput = {
    name: opts.name,
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
      sourceFile: step.sourceFile,
      sourceResourceUri: step.sourceResourceUri,
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
