import { z } from 'zod';
import {
  FLOW_STEP_TOOL_GUIDANCE,
  chooseFlowStepTool,
  deleteFlow,
  deleteFlowStep,
  ensureFlow,
  ensureFlowStep,
  ensureFlowTrigger,
  removeFlowTrigger,
  jsonText,
  planFlowSteps,
  runFlowWorkflow,
} from './platform-operation-logic.js';
import { destructivePreviewContent } from './destructive-preview.js';
import {
  dynamicCodeKnowledgeAckParam,
  globalRulesAckParam
} from './required-knowledge.js';

const FLOW_STEP_TIMEOUT_DESCRIPTION =
  'Step timeout in ms. Self-assess the step worst-case duration (record loops, multiple repository/cache/transaction round-trips, external package calls) and set an explicit value; leaving it unset uses the ESV flow-step default of 5000 ms, which is usually too low for multi-record script steps.';

export function registerPlatformFlowTools(server, ENFYRA_API_URL) {
  server.tool(
      'flow_workflow',
      [
        'Workflow front door for creating or updating an Enfyra flow and its steps in one guided path.',
        'For a fully specified, non-destructive flow, use apply=true to create/update the flow and all steps sequentially in one call. Use apply=false only when step types or risk need review.',
        'Prefer this over choosing individual ensure_*_flow_step tools in guided mode.',
        'Flow steps are script-only: every query, mutation, HTTP call, delay, child-flow trigger, and log runs inside one focused script step. Use condition steps only for true/false branching.',
        'Keep one business operation per step. Split long or mixed-responsibility script logic into named script/condition steps, or a triggered child flow for a cohesive reusable unit, while preserving operations that truly require one atomic transaction boundary.',
      ].join(' '),
      {
        name: z.string().describe('Flow name. Existing flow with this name is updated.'),
        steps: z.array(z.union([
          z.string(),
          z.object({
            key: z.string().optional().describe('Stable step key. Generated from intent when omitted.'),
            name: z.string().optional().describe('Human label. Defaults from intent.'),
            intent: z.string().optional().describe('Plain-language step intent. Used to choose script or condition when type is omitted.'),
            type: z.enum(['script', 'condition']).optional().describe('Explicit step type. Omit to let the workflow choose script or condition from intent.'),
            sourceCode: z.string().optional().describe('Only for script or condition steps. Prefer sourceFile/sourceResourceUri when the reviewed source already exists as an MCP artifact.'),
            sourceFile: z.string().optional().describe('Previously returned script source artifact tmpFile for this step.'),
            sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for this step.'),
            scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript'),
            order: z.number().optional().describe('Step order. Defaults to index * 10.'),
            timeout: z.number().int().positive().optional().describe(FLOW_STEP_TIMEOUT_DESCRIPTION),
            isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
          }),
        ])).min(1).max(30).describe('Ordered step intents/definitions. Keep one business operation per step.'),
        timeout: z.number().int().positive().optional().describe('Flow timeout in ms.'),
        maxExecutions: z.number().int().positive().optional().default(100).describe('Execution history cap.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable flow.'),
        description: z.string().optional().describe('Admin note.'),
        apply: z.boolean().optional().default(false).describe('false returns plan only; true applies flow and steps sequentially.'),
        globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when apply=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
        knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required when apply=true and any script/condition step has sourceCode or a source artifact.'),
      },
      async (input) => jsonText(await runFlowWorkflow(ENFYRA_API_URL, input)),
    );

  server.tool(
      'ensure_flow',
      'Business operation: create or update an Enfyra flow. Flows are always triggerable from code ($trigger, @TRIGGER, admin API). Use ensure_flow_trigger to add schedule/event/webhook triggers.',
      {
        name: z.string().describe('Flow name. Existing flow with this name is updated.'),
        timeout: z.number().int().positive().optional().describe('Flow timeout in ms.'),
        maxExecutions: z.number().int().positive().optional().default(100).describe('Execution history cap.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable flow.'),
        description: z.string().optional().describe('Admin note.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ name, timeout, maxExecutions, isEnabled, description, globalRulesAckKey }) => jsonText(await ensureFlow(ENFYRA_API_URL, {
        name,
        timeout,
        maxExecutions,
        isEnabled,
        description,
        globalRulesAckKey,
      })),
    );

  server.tool(
      'ensure_flow_trigger',
      'Business operation: create or update a trigger for an Enfyra flow. Types: schedule (cron), event (table mutation), webhook (route).',
      {
        flowName: z.string().optional().describe('Flow name to attach trigger to.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow ID to attach trigger to.'),
        type: z.enum(['schedule', 'event', 'webhook']).describe('Trigger type.'),
        config: z.union([z.record(z.any()), z.string()]).optional().describe('Type-specific config JSON. Schedule: {cron, timezone}.'),
        tableEvent: z.enum(['create', 'update', 'delete']).optional().describe('Required for event triggers: which mutation activates the flow.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Required for webhook triggers: route ID that triggers the flow.'),
        tableId: z.union([z.string(), z.number()]).optional().describe('Required for event triggers: table ID whose mutations trigger the flow.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable trigger.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await ensureFlowTrigger(ENFYRA_API_URL, input)),
    );

  server.tool(
      'remove_flow_trigger',
      'Business operation: disable a trigger on an Enfyra flow by trigger ID, or by flow + type.',
      {
        triggerId: z.union([z.string(), z.number()]).optional().describe('Trigger record ID to remove.'),
        flowName: z.string().optional().describe('Flow name (used with type to find trigger).'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow ID (used with type to find trigger).'),
        type: z.enum(['schedule', 'event', 'webhook']).optional().describe('Trigger type to remove.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await removeFlowTrigger(ENFYRA_API_URL, input)),
    );

  server.tool(
      'delete_flow',
      'Business operation: preview-first physical deletion of an already-disabled Enfyra flow, its triggers, and its saved steps. confirm=true requires the exact flow id and name from the preview; this tool never disables the flow for you.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        expectedFlowId: z.union([z.string(), z.number()]).optional().describe('Required when confirm=true. Exact flow id returned by the preview.'),
        expectedFlowName: z.string().optional().describe('Required when confirm=true. Exact flow name returned by the preview.'),
        confirm: z.boolean().optional().default(false).describe('false returns the dependency preview or an enabled-flow reminder; true deletes only an already-disabled flow and owned triggers/steps.'),
        skipNotFound: z.boolean().optional().default(true).describe('Continue when a dependency was already removed during a prior partial attempt.'),
        globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
      },
      async (input) => {
        const result = await deleteFlow(ENFYRA_API_URL, input);
        if (!input.confirm) return destructivePreviewContent('delete_flow', result, 1);
        const content = jsonText(result);
        return result.status === 'partial_failure' || result.postcondition?.confirmedAbsent !== true
          ? { ...content, isError: true }
          : content;
      },
    );

  server.tool(
      'delete_flow_step',
      'Business operation: preview-first physical deletion of one saved Enfyra flow step and any nested child steps. Locate by stepId or flowName/flowId plus stepKey, then confirm with the exact ids from the preview.',
      {
        flowName: z.string().optional().describe('Flow name. Required with stepKey unless flowId is supplied.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Required with stepKey unless flowName is supplied.'),
        stepId: z.union([z.string(), z.number()]).optional().describe('Flow step id. Use stepId or stepKey.'),
        stepKey: z.string().optional().describe('Stable step key. Use with flowName or flowId when stepId is unavailable.'),
        expectedFlowId: z.union([z.string(), z.number()]).optional().describe('Required when confirm=true. Exact flow id returned by the preview.'),
        expectedStepId: z.union([z.string(), z.number()]).optional().describe('Required when confirm=true. Exact step id returned by the preview.'),
        confirm: z.boolean().optional().default(false).describe('false returns the dependency preview; true deletes the step.'),
        globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
      },
      async (input) => {
        const result = await deleteFlowStep(ENFYRA_API_URL, input);
        if (!input.confirm) return destructivePreviewContent('delete_flow_step', result, 1);
        const content = jsonText(result);
        return result.postcondition?.confirmedAbsent !== true
          ? { ...content, isError: true }
          : content;
      },
    );

  server.tool(
      'choose_flow_step_tool',
      'Dry-run helper: choose the most specific Enfyra flow step tool for one intended step before mutating flow metadata.',
      {
        intent: z.string().describe('Plain-language description of what this one flow step should do.'),
      },
      async ({ intent }) => {
        const recommendation = chooseFlowStepTool(intent);
        return jsonText({
          action: 'flow_step_tool_recommended',
          intent,
          recommendation,
          availableStepTools: FLOW_STEP_TOOL_GUIDANCE,
          nextSteps: [
            `Call ${recommendation.tool} with a stable key and order.`,
            'Flow steps are script-only; condition is the only branch step type.',
            'After saving script or condition steps, use test_flow_step before relying on the flow.',
          ],
        });
      },
    );

  server.tool(
      'plan_flow_steps',
      'Dry-run helper: choose the ordered Enfyra flow step tools for a whole flow plan before mutating flow metadata.',
      {
        steps: z.array(z.union([
          z.string(),
          z.object({
            key: z.string().optional().describe('Stable step key. Generated when omitted.'),
            name: z.string().optional().describe('Human label. Defaults from key.'),
            intent: z.string().describe('Plain-language description of this step.'),
          }),
        ])).min(1).max(30).describe('Ordered step intents. Use this before ensure_script_flow_step/ensure_condition_flow_step calls when a flow has multiple steps.'),
      },
      async ({ steps }) => {
        const plan = planFlowSteps(steps);
        return jsonText({
          action: 'flow_steps_planned',
          stepCount: plan.length,
          plan,
          nextSteps: [
            'Create or update the flow with ensure_flow first, then attach schedule/event/webhook activation with ensure_flow_trigger when needed.',
            'Call ensure_script_flow_step or ensure_condition_flow_step for each planned step, passing flowName or flowId plus sourceCode/sourceFile/sourceResourceUri.',
            'Every planned step is a script step unless it is a condition branch.',
            'Use test_flow_step for script/condition/high-risk steps before triggering the full flow.',
          ],
        });
      },
    );

  server.tool(
      'ensure_script_flow_step',
      'Business operation: create or update one focused script flow step. Every flow step is script-only; use condition steps only for true/false branching. If the source mixes multiple business operations or becomes hard to test, split it into named script/condition steps or a triggered child flow; keep truly atomic repository mutations in one transaction boundary.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        sourceCode: z.string().optional().describe('Script sourceCode. Prefer sourceFile/sourceResourceUri when the reviewed source already exists as an MCP artifact.'),
        sourceFile: z.string().optional().describe('Previously returned script source artifact tmpFile.'),
        sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for the script.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
        timeout: z.number().int().positive().optional().describe(FLOW_STEP_TIMEOUT_DESCRIPTION),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
        knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'script',
      })),
    );

  server.tool(
      'ensure_condition_flow_step',
      'Business operation: create or update one focused condition flow step. Use this for dynamic conditional branching instead of choosing type=condition manually. The sourceCode must return a real boolean (true or false); the server rejects objects, arrays, strings, numbers, null, and undefined, so wrap values with Boolean(...) or return a comparison. Keep branching decisions separate from unrelated mutations or side effects, and split those into later named steps.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        sourceCode: z.string().optional().describe('Condition sourceCode that returns a boolean (true or false). Prefer sourceFile/sourceResourceUri when the reviewed source already exists as an MCP artifact.'),
        sourceFile: z.string().optional().describe('Previously returned script source artifact tmpFile.'),
        sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for the condition.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
        timeout: z.number().int().positive().optional().describe(FLOW_STEP_TIMEOUT_DESCRIPTION),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
        knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'condition',
      })),
    );

}
