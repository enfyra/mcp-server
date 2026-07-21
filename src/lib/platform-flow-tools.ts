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
  FLOW_STEP_TOOL_GUIDANCE,
  chooseFlowStepTool,
  ensureFlow,
  ensureFlowStep,
  jsonText,
  planFlowSteps,
  runFlowWorkflow,
} from './platform-operation-logic.js';

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
        triggerType: z.enum(['manual', 'schedule']).optional().default('manual').describe('manual for API/admin/hook/child flow usage, schedule for cron/time-based flows.'),
        triggerConfig: z.union([z.record(z.any()), z.string()]).optional().describe('Trigger config object or JSON string. Required for scheduled flows.'),
        steps: z.array(z.union([
          z.string(),
          z.object({
            key: z.string().optional().describe('Stable step key. Generated from intent when omitted.'),
            name: z.string().optional().describe('Human label. Defaults from intent.'),
            intent: z.string().optional().describe('Plain-language step intent. Used to choose a fixed step type when type is omitted.'),
            type: z.enum(['query', 'create', 'update', 'delete', 'http', 'condition', 'sleep', 'trigger_flow', 'log', 'script']).optional().describe('Explicit step type. Omit to let the workflow choose from intent.'),
            config: z.union([z.record(z.any()), z.string()]).optional().describe('Step config object or JSON string. Fixed-step config is static and cannot contain @FLOW_PAYLOAD/@FLOW_LAST/@FLOW. Use a focused script step for runtime values.'),
            sourceCode: z.string().optional().describe('Only for script or condition steps. Use fixed step types when possible.'),
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
        knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required when apply=true and any script/condition step has sourceCode.'),
      },
      async (input) => jsonText(await runFlowWorkflow(ENFYRA_API_URL, input)),
    );

  server.tool(
      'ensure_manual_flow',
      'Business operation: create or update a manually triggered Enfyra flow. Use this when the flow is run by API, admin action, another flow, or hook.',
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
        triggerType: 'manual',
        triggerConfig: {},
        timeout,
        maxExecutions,
        isEnabled,
        description,
        globalRulesAckKey,
      })),
    );

  server.tool(
      'ensure_scheduled_flow',
      'Business operation: create or update a scheduled Enfyra flow. Use this only for cron/time-based flows.',
      {
        name: z.string().describe('Flow name. Existing flow with this name is updated.'),
        triggerConfig: z.string().describe('Schedule config JSON object.'),
        timeout: z.number().int().positive().optional().describe('Flow timeout in ms.'),
        maxExecutions: z.number().int().positive().optional().default(100).describe('Execution history cap.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable flow.'),
        description: z.string().optional().describe('Admin note.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ name, triggerConfig, timeout, maxExecutions, isEnabled, description, globalRulesAckKey }) => jsonText(await ensureFlow(ENFYRA_API_URL, {
        name,
        triggerType: 'schedule',
        triggerConfig,
        timeout,
        maxExecutions,
        isEnabled,
        description,
        globalRulesAckKey,
      })),
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
            'Create or update the flow with ensure_manual_flow or ensure_scheduled_flow first.',
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
        sourceCode: z.string().describe('Script sourceCode.'),
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
        sourceCode: z.string().describe('Condition sourceCode.'),
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
