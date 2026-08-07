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

export function registerPlatformFlowTools(server, ENFYRA_API_URL) {
  server.tool(
      'flow_workflow',
      [
        'Workflow front door for creating or updating an Enfyra flow and its steps in one guided path.',
        'For a fully specified, non-destructive flow, use apply=true to create/update the flow and all steps sequentially in one call. Use apply=false only when step types or risk need review.',
        'Prefer this over choosing individual ensure_*_flow_step tools in guided mode.',
        'Fixed query/create/update/delete/http/sleep/trigger/log config is static in current ESV and does not interpolate @FLOW_PAYLOAD/@FLOW_LAST/@FLOW; use a focused script step for runtime values.',
      ].join(' '),
      {
        name: z.string().describe('Flow name. Existing flow with this name is updated.'),
        steps: z.array(z.union([
          z.string(),
          z.object({
            key: z.string().optional().describe('Stable step key. Generated from intent when omitted.'),
            name: z.string().optional().describe('Human label. Defaults from intent.'),
            intent: z.string().optional().describe('Plain-language step intent. Used to choose a fixed step type when type is omitted.'),
            type: z.enum(['query', 'create', 'update', 'delete', 'http', 'condition', 'sleep', 'trigger_flow', 'log', 'script']).optional().describe('Explicit step type. Omit to let the workflow choose from intent.'),
            config: z.union([z.record(z.any()), z.string()]).optional().describe('Step config object or JSON string. Fixed-step config is static and cannot contain @FLOW_PAYLOAD/@FLOW_LAST/@FLOW. Use a focused script step for runtime values.'),
            sourceCode: z.string().optional().describe('Only for script or condition steps. Prefer sourceFile/sourceResourceUri when the reviewed source already exists as an MCP artifact.'),
            sourceFile: z.string().optional().describe('Previously returned script source artifact tmpFile for this step.'),
            sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for this step.'),
            scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript'),
            order: z.number().optional().describe('Step order. Defaults to index * 10.'),
            timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
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
      'Business operation: create or update an Enfyra flow. Flows are always triggerable from code ($trigger, trigger_flow step, admin API). Use ensure_flow_trigger to add schedule/event/webhook triggers.',
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
            'Use ensure_script_flow_step only when the atomic tools cannot express the behavior.',
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
        ])).min(1).max(30).describe('Ordered step intents. Use this before ensure_*_flow_step calls when a flow has multiple steps.'),
      },
      async ({ steps }) => {
        const plan = planFlowSteps(steps);
        return jsonText({
          action: 'flow_steps_planned',
          stepCount: plan.length,
          plan,
          nextSteps: [
            'Create or update the flow with ensure_flow first, then attach schedule/event/webhook activation with ensure_flow_trigger when needed.',
            'Call each planned ensure_*_flow_step in order, adding flowName or flowId plus table/query/config details.',
            'Use ensure_script_flow_step only for steps where the plan chose script because fixed step types are insufficient.',
            'Use test_flow_step for script/condition/high-risk steps before triggering the full flow.',
          ],
        });
      },
    );

  server.tool(
      'ensure_script_flow_step',
      'Business operation: create or update one script flow step. Use this for JavaScript/TypeScript flow logic instead of choosing type=script manually.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        sourceCode: z.string().optional().describe('Script sourceCode. Prefer sourceFile/sourceResourceUri when the reviewed source already exists as an MCP artifact.'),
        sourceFile: z.string().optional().describe('Previously returned script source artifact tmpFile.'),
        sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for the script.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        config: z.string().optional().describe('Step config JSON object.'),
        scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
        timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
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
      'Business operation: create or update one condition flow step. Use this for dynamic conditional branching instead of choosing type=condition manually.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        sourceCode: z.string().optional().describe('Condition sourceCode. Prefer sourceFile/sourceResourceUri when the reviewed source already exists as an MCP artifact.'),
        sourceFile: z.string().optional().describe('Previously returned script source artifact tmpFile.'),
        sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for the condition.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        config: z.string().optional().describe('Step config JSON object.'),
        scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
        timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
        knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'condition',
      })),
    );

  server.tool(
      'ensure_query_flow_step',
      'Business operation: create or update one query flow step. Use this for repository/query-style flow steps instead of choosing type=query manually.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        config: z.string().describe('Step config JSON object.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'query',
      })),
    );

  server.tool(
      'ensure_http_flow_step',
      'Business operation: create or update one HTTP flow step. Use this for outbound HTTP calls instead of choosing type=http manually.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        config: z.string().describe('Step config JSON object.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'http',
      })),
    );

  server.tool(
      'ensure_create_flow_step',
      'Business operation: create or update one create-record flow step. Use this for a single table insert instead of writing script code.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        config: z.string().describe('Step config JSON object: { "table": "...", "data": { ... } }.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'create',
      })),
    );

  server.tool(
      'ensure_update_flow_step',
      'Business operation: create or update one update-record flow step. Use this for a single table update by id instead of writing script code.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        config: z.string().describe('Step config JSON object: { "table": "...", "id": "...", "data": { ... } }.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'update',
      })),
    );

  server.tool(
      'ensure_delete_flow_step',
      'Business operation: create or update one delete-record flow step. Use this for a single table delete by id instead of writing script code.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        config: z.string().describe('Step config JSON object: { "table": "...", "id": "..." }.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'delete',
      })),
    );

  server.tool(
      'ensure_sleep_flow_step',
      'Business operation: create or update one sleep/wait flow step. Use this for delays instead of choosing type=sleep manually.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        config: z.string().describe('Step config JSON object.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'sleep',
      })),
    );

  server.tool(
      'ensure_log_flow_step',
      'Business operation: create or update one log flow step. Use this for lightweight execution diagnostics instead of script code.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        config: z.string().describe('Step config JSON object: { "message": "..." }.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'log',
      })),
    );

  server.tool(
      'ensure_trigger_flow_step',
      'Business operation: create or update one child-flow trigger step. Use this for flow-to-flow orchestration instead of choosing type=trigger_flow manually.',
      {
        flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
        flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
        key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
        config: z.string().describe('Step config JSON object.'),
        order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
        timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
        ...input,
        type: 'trigger_flow',
      })),
    );
}
