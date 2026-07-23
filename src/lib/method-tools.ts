/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
// Import modules
import { exchangeApiToken, refreshAccessToken, getValidToken, resetTokens, getTokenExpiry, initAuth } from './auth.js';
import { fetchAPI, validateFilter, validateTableName } from './fetch.js';
import {
  fetchMetadataContext,
  fetchMetadataTables,
  fetchTableCatalog,
  fetchTableMetadata,
  fetchTableMetadataByRef,
} from './metadata-client.js';
import { buildMcpServerInstructions, buildGraphqlUrls } from './mcp-instructions.js';
import { getExamples, listExampleCategories } from './mcp-examples.js';
import { WORKFLOW_SURFACES, discoverWorkflowRoutes } from './tool-routing.js';
import { getSupportedColumnTypesFromMetadata, registerTableTools } from './table-tools.js';
import { registerPlatformOperationTools, validateExtensionCode } from './platform-operation-tools.js';
import { registerRuntimeZoneTools } from './runtime-zone-tools.js';
import { registerOAuthProviderTools } from './oauth-tools.js';
import { registerDynamicRepositoryBuilder } from './dynamic-repository-builder.js';
import { buildDynamicScriptContextTypeContract } from './dynamic-script-context-contract.js';
import { destructivePreviewContent } from './destructive-preview.js';
import { assertCreateHandlerRouteBoundary } from './dynamic-endpoint-contract.js';
import { assertGenericRecordMutationAllowed, parseRecordBatchData, parseRecordData, prepareRecordBatchMutation, prepareRecordMutation, validatePortableScriptSource, validateScriptSourceIfPresent } from './mutation-guards.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAckIf,
  assertGlobalRulesAck,
  acknowledgeRequiredKnowledge,
  buildRequiredKnowledgePayload,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';
import { validateMainTableRoutePath } from './route-guards.js';
import { assertRecordFieldsReadable, buildDeletePostcondition, buildQuerySchemaReceipt } from './record-contracts.js';
import { installColumnarToolFormatter, jsonContent } from './response-format.js';
import { startMcpUsageTelemetry } from './mcp-usage-telemetry.js';
import { startRuntimeCacheSocket } from './runtime-cache-socket.js';
import { executeSequentialBatch } from './sequential-batch.js';
import { compactSourceFields, readSourceArtifactResource, writeSourceArtifact } from './source-artifacts.js';
import { installToolsetFilter, normalizeDynamicToolPacks, normalizeMcpProfile, normalizeMcpToolset, summarizeToolsetForInstructions } from './toolset-filter.js';
import { installToolAnnotations } from './tool-contracts.js';
import { installToolOutputContracts } from './tool-output-contracts.js';
import { registerToolCatalogTools } from './tool-catalog.js';
import { registerWorkflowToolPack } from './workflow-tool-packs.js';
import type { ToolAvailability } from './types.js';
import {
  findRoutePermission,
  mergeMethodNames,
  normalizeMethodNames,
  resolveRoleByNameOrId,
  routeAvailableMethodNames,
  routePublicMethodNames,
  summarizeRouteAccess,
  summarizeRoutePermission,
  validateMethodsForRoute,
} from './route-permission-tools.js';
import {
  MethodPatchBody,
  findMethodRecordByName,
  getId,
  getPrimaryFieldName,
  invalidateMethodMap,
  normalizeHexColorInput,
  normalizeMethodNameInput,
  parseJsonObjectInput,
  summarizeMutationResult,
  unwrapData,
} from './enfyra-tool-logic.js';

export function registerMethodTools(server, ENFYRA_API_URL) {
  server.tool(
    'list_methods',
    'List enfyra_method records with their UI colors. Use this before creating route methods or method-colored UI.',
    {},
    async () => {
      const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_method?fields=id,_id,name,buttonColor,textColor,isSystem&sort=name&limit=0');
      const methods = unwrapData(result).map((method) => ({
        id: getId(method),
        name: method.name,
        buttonColor: method.buttonColor,
        textColor: method.textColor,
        isSystem: method.isSystem === true,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({
        tableName: 'enfyra_method',
        methods,
        appUi: '/settings/methods',
      }, null, 2) }] };
    },
  );

  server.tool(
    'create_method',
    'Create a enfyra_method record with app badge colors. Prefer this over generic create_records for enfyra_method.',
    {
      method: z.string().describe('Uppercase method name, e.g. GET, POST, PUT, CUSTOM_METHOD. Must start with A-Z and contain only A-Z, 0-9, or underscore.'),
      buttonColor: z.string().describe('Badge background color as full hex, e.g. #dbeafe.'),
      textColor: z.string().describe('Badge text color as full hex, e.g. #1d4ed8.'),
      isSystem: z.boolean().optional().default(false).describe('Set true only for built-in/runtime-owned methods. Normal app methods should leave this false.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ method, buttonColor, textColor, isSystem, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      const normalizedMethod = normalizeMethodNameInput(method);
      const existing = await findMethodRecordByName(normalizedMethod);
      if (existing) {
        throw new Error(`Method ${normalizedMethod} already exists with id ${getId(existing)}. Use update_method to change colors.`);
      }
      const body = {
        name: normalizedMethod,
        buttonColor: normalizeHexColorInput(buttonColor, 'buttonColor'),
        textColor: normalizeHexColorInput(textColor, 'textColor'),
        isSystem: isSystem === true,
      };
      const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_method', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      invalidateMethodMap();
      return { content: [{ type: 'text', text: JSON.stringify({
        ...summarizeMutationResult(result, 'created', 'enfyra_method'),
        name: normalizedMethod,
        appUi: '/settings/methods',
      }, null, 2) }] };
    },
  );

  server.tool(
    'update_method',
    'Update a enfyra_method record color pair, and optionally rename non-system methods. Prefer this over generic update_records for enfyra_method.',
    {
      id: z.string().optional().describe('Method record id. If omitted, method is used to find the record.'),
      method: z.string().optional().describe('Existing method name to find, or new name when id is provided.'),
      buttonColor: z.string().optional().describe('Badge background color as full hex, e.g. #dbeafe.'),
      textColor: z.string().optional().describe('Badge text color as full hex, e.g. #1d4ed8.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ id, method, buttonColor, textColor, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      let targetId = id;
      let existing = null;
      if (!targetId) {
        if (!method) throw new Error('Provide id or method.');
        const normalizedMethod = normalizeMethodNameInput(method);
        existing = await findMethodRecordByName(normalizedMethod);
        if (!existing) throw new Error(`Method ${normalizedMethod} was not found.`);
        targetId = getId(existing);
      }
  
      const body: MethodPatchBody = {};
      if (buttonColor !== undefined) {
        body.buttonColor = normalizeHexColorInput(buttonColor, 'buttonColor');
      }
      if (textColor !== undefined) {
        body.textColor = normalizeHexColorInput(textColor, 'textColor');
      }
      if (method !== undefined && id) {
        body.name = normalizeMethodNameInput(method);
      }
      if (Object.keys(body).length === 0) {
        throw new Error('Provide buttonColor, textColor, or a new method name.');
      }
  
      const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_method/${encodeURIComponent(String(targetId))}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      invalidateMethodMap();
      return { content: [{ type: 'text', text: JSON.stringify({
        ...summarizeMutationResult(result, 'updated', 'enfyra_method'),
        id: targetId,
        appUi: '/settings/methods',
      }, null, 2) }] };
    },
  );

  server.tool(
    'delete_method',
    'Preview or delete one enfyra_method record, then verify absence by primary key. System/default methods are rejected; only delete unused custom methods.',
    {
      id: z.string().optional().describe('Method record id. If omitted, method is used to find the record.'),
      method: z.string().optional().describe('Method name to find when id is omitted.'),
      expectedId: z.string().optional().describe('Required when confirm=true. Pass the exact method id returned by the preview.'),
      confirm: z.boolean().optional().default(false).describe('Required true to apply the destructive delete. Omit/false returns a preview only.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
    },
    async ({ id, method, expectedId, confirm, globalRulesAckKey }) => {
      let targetId = id;
      let target = null;
      if (!targetId) {
        if (!method) throw new Error('Provide id or method.');
        target = await findMethodRecordByName(normalizeMethodNameInput(method));
        if (!target) throw new Error(`Method ${method} was not found.`);
        targetId = getId(target);
      }
      const primaryKey = await getPrimaryFieldName('enfyra_method');
      if (!target) {
        const filter = encodeURIComponent(JSON.stringify({ [primaryKey]: { _eq: targetId } }));
        const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_method?filter=${filter}&limit=1&fields=id,_id,name,buttonColor,textColor,isSystem`);
        target = unwrapData(result)[0] || null;
      }
      if (!target) throw new Error(`Method id ${targetId} was not found.`);
      if (!confirm) {
        return destructivePreviewContent('delete_method', {
          action: 'delete_method_preview',
          id: targetId,
          name: target.name,
          isSystem: target.isSystem === true,
          destructive: true,
          postcondition: {
            verificationMethod: 'not_run_preview',
            confirmedAbsent: false,
            remainingMethods: [{ id: targetId, name: target.name }],
          },
          warning: 'Only delete unused custom methods. Deleting a method can affect route method relations.',
          next: `Call delete_method again with the same locator, expectedId=${String(targetId)}, and confirm=true to delete.`,
        }, 1);
      }
      assertGlobalRulesAck(globalRulesAckKey);
      if (!expectedId) {
        throw new Error('expectedId is required when confirm=true. Pass the exact method id returned by the preview.');
      }
      if (String(expectedId) !== String(targetId)) {
        throw new Error(`Method id mismatch: resolved ${targetId}, expected ${expectedId}.`);
      }
      if (target.isSystem === true) {
        throw new Error(`Method ${target.name || targetId} is system-owned and cannot be deleted.`);
      }
      const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_method/${encodeURIComponent(String(targetId))}`, { method: 'DELETE' });
      invalidateMethodMap();
      let postcondition;
      try {
        const filter = encodeURIComponent(JSON.stringify({ [primaryKey]: { _eq: targetId } }));
        const verification = await fetchAPI(ENFYRA_API_URL, `/enfyra_method?filter=${filter}&limit=1&fields=id,_id,name`);
        const remainingMethods = unwrapData(verification).map((record) => ({
          id: getId(record),
          name: record.name,
        }));
        postcondition = {
          verificationMethod: 'method_read_by_primary_key',
          confirmedAbsent: remainingMethods.length === 0,
          remainingMethods,
        };
      } catch (error) {
        postcondition = {
          verificationMethod: 'method_read_by_primary_key',
          confirmedAbsent: false,
          remainingMethods: [],
          verificationError: String((error as any)?.message || error),
        };
      }
      const content = jsonContent({
        action: postcondition.confirmedAbsent ? 'deleted' : 'delete_method_unverified',
        tableName: 'enfyra_method',
        id: targetId,
        statusCode: result?.statusCode,
        success: result?.success,
        postcondition,
      });
      return postcondition.confirmedAbsent ? content : { ...content, isError: true };
    },
  );

  server.tool(
    'run_admin_test',
    [
      'Run an Enfyra admin test without saving metadata. Wraps POST /admin/test/run.',
      'Kinds: script, flow_step, websocket_event, websocket_connection. Use this to validate dynamic script, flow, or websocket behavior before creating records.',
      'kind=script captures logs but not socket emitted calls. Use kind=websocket_event or kind=websocket_connection when emitted capture is required; admin websocket tests still do not prove a real Socket.IO client transport/handshake.',
    ].join(' '),
    {
      kind: z.enum(['script', 'flow_step', 'websocket_event', 'websocket_connection']).describe('Admin test kind'),
      body: z.union([z.record(z.any()), z.string()]).describe('Test body as a native JSON object. A JSON string is accepted for compatibility. Include script and optional context for script; type/config plus payload for flow_step; or script/gatewayPath/eventName/payload for websocket tests. Do not include kind; the tool adds it.'),
    },
    async ({ kind, body }) => {
      const parsed = parseJsonObjectInput(body, 'body');
      const sourceCode = kind === 'flow_step'
        ? parsed?.config?.sourceCode ?? parsed?.config?.code
        : parsed?.script ?? parsed?.sourceCode;
      if (typeof sourceCode === 'string') validatePortableScriptSource(sourceCode);
      const result = await fetchAPI(ENFYRA_API_URL, '/admin/test/run', {
        method: 'POST',
        body: JSON.stringify({ ...parsed, kind }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'test_flow_step',
    'Test a single flow step without saving it. Wraps POST /admin/test/run with kind=flow_step. Pass runtime @FLOW_PAYLOAD data through payload; the tool forwards it using the ESV test-run contract.',
    {
      type: z.enum(['script', 'condition', 'query', 'create', 'update', 'delete', 'http', 'trigger_flow', 'sleep', 'log']).describe('Flow step type'),
      config: z.union([z.record(z.any()), z.string()]).describe('Step config as a native JSON object. A JSON string is accepted for compatibility.'),
      timeout: z.number().optional().describe('Timeout in ms'),
      key: z.string().optional().describe('Optional step key for mock flow context'),
      payload: z.union([z.record(z.any()), z.string()]).optional().describe('Runtime payload object exposed to the script as @FLOW_PAYLOAD. A JSON object string is accepted for compatibility.'),
      mockFlow: z.union([z.record(z.any()), z.string()]).optional().describe('Optional advanced mockFlow object for $last/$meta or other flow context. A JSON string is accepted for compatibility. Use payload for @FLOW_PAYLOAD.'),
    },
    async ({ type, config, timeout, key, payload, mockFlow }) => {
      const parsedConfig = parseJsonObjectInput(config, 'config');
      const sourceCode = parsedConfig?.sourceCode ?? parsedConfig?.code;
      if (typeof sourceCode === 'string') validatePortableScriptSource(sourceCode);
      const parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (parsedPayload !== undefined && (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload))) {
        throw new Error('payload must be a JSON object.');
      }
      const body = {
        type,
        config: parsedConfig,
        ...(timeout ? { timeout } : {}),
        ...(key ? { key } : {}),
        ...(parsedPayload !== undefined ? { payload: parsedPayload } : {}),
        ...(mockFlow ? { mockFlow: parseJsonObjectInput(mockFlow, 'mockFlow') } : {}),
      };
      const result = await fetchAPI(ENFYRA_API_URL, '/admin/test/run', {
        method: 'POST',
        body: JSON.stringify({ ...body, kind: 'flow_step' }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'trigger_flow',
    'Trigger an enabled saved flow by id or name. Disabled flows are not registered for execution; use test_flow_step to verify their step contract without enabling them.',
    {
      flowIdOrName: z.union([z.string(), z.number()]).describe('Flow id or name accepted by FlowService.trigger'),
      payload: z.union([z.record(z.any()), z.string()]).optional().describe('Payload as a native JSON object. A JSON string is accepted for compatibility. Default {}.'),
    },
    async ({ flowIdOrName, payload }) => {
      const rawIdentifier = String(flowIdOrName);
      const filter = typeof flowIdOrName === 'number' || /^\d+$/.test(rawIdentifier)
        ? { id: { _eq: flowIdOrName } }
        : { name: { _eq: rawIdentifier } };
      const lookup = await fetchAPI(ENFYRA_API_URL, `/enfyra_flow?filter=${encodeURIComponent(JSON.stringify(filter))}&limit=1&fields=id,_id,name,isEnabled`);
      const flow = unwrapData(lookup)[0];
      if (!flow) throw new Error(`Flow not found: ${rawIdentifier}`);
      if (flow.isEnabled === false) {
        throw new Error(`Flow "${flow.name || rawIdentifier}" is disabled and is not registered for execution. Use test_flow_step to verify its saved step contract, or explicitly enable the flow before trigger_flow.`);
      }
      const flowId = flow.id ?? flow._id;
      const result = await fetchAPI(ENFYRA_API_URL, `/admin/flow/trigger/${encodeURIComponent(String(flowId))}`, {
        method: 'POST',
        body: JSON.stringify({
          payload: payload ? parseJsonObjectInput(payload, 'payload') : {},
        }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
