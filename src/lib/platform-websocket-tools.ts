import { z } from 'zod';
import {
  createOrPatch,
  findRecord,
  getId,
  jsonText,
  naturalPartialReload,
  normalizeRestPath,
  validateDynamicScript,
} from './platform-operation-logic.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertGlobalRulesAck,
  dynamicCodeKnowledgeAckParam,
  globalRulesAckParam
} from './required-knowledge.js';
import { materializeSourceInput } from './source-artifacts.js';

export function registerPlatformWebsocketTools(server, ENFYRA_API_URL) {
  server.tool(
      'ensure_websocket_gateway',
      'Business operation: create or update an Enfyra Socket.IO gateway. Connection handler sourceCode is validated before save.',
      {
        path: z.string().describe('Gateway namespace/path, e.g. /chat.'),
        sourceCode: z.string().optional().describe('Optional connection handler dynamic script sourceCode. Prefer sourceFile/sourceResourceUri when the reviewed source already exists as an MCP artifact.'),
        sourceFile: z.string().optional().describe('Previously returned connection handler source artifact tmpFile.'),
        sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for the connection handler.'),
        scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language for connection handler.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable gateway.'),
        description: z.string().optional().describe('Admin note.'),
        globalRulesAckKey: globalRulesAckParam(z),
        knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required when sourceCode is provided. Use dynamicCodeAckKey from get_enfyra_required_knowledge.'),
      },
      async ({ path, sourceCode, sourceFile, sourceResourceUri, scriptLanguage, isEnabled, description, globalRulesAckKey, knowledgeAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        const materialized = sourceCode !== undefined || sourceFile !== undefined || sourceResourceUri !== undefined
          ? materializeSourceInput({ source: sourceCode, sourceFile, sourceResourceUri, fieldName: 'sourceCode', tableName: 'enfyra_websocket', id: path })
          : null;
        assertDynamicCodeKnowledgeAckIf(Boolean(materialized), knowledgeAckKey);
        const normalizedPath = normalizeRestPath(path);
        const validation = !materialized
          ? { validated: false, reason: 'no sourceCode' }
          : await validateDynamicScript(ENFYRA_API_URL, materialized.source, scriptLanguage);
        const existing = await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { path: { _eq: normalizedPath } }, 'id,_id,path');
        const body = {
          path: normalizedPath,
          isEnabled,
          description,
          ...(materialized ? { sourceCode: materialized.source, scriptLanguage } : {}),
        };
        const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_websocket', existing, body);
        const reload = naturalPartialReload('Websocket metadata writes trigger the server partial reload contract; there is no dedicated websocket reload endpoint.');
        return jsonText({ action: 'websocket_gateway_ensured', gateway: { id: operation.id, path: normalizedPath }, validation, ...(materialized ? { sourceArtifact: materialized.sourceArtifact } : {}), operation, reload });
      },
    );

  server.tool(
      'ensure_websocket_event',
      'Business operation: create or update one websocket event handler. It resolves gateway path/id and validates sourceCode before save.',
      {
        gatewayPath: z.string().optional().describe('Gateway path, e.g. /chat. Use gatewayPath or gatewayId.'),
        gatewayId: z.union([z.string(), z.number()]).optional().describe('Gateway id. Use gatewayPath or gatewayId.'),
        eventName: z.string().describe('Socket event name.'),
        sourceCode: z.string().optional().describe('Event handler dynamic script sourceCode. Prefer sourceFile/sourceResourceUri when the reviewed source already exists as an MCP artifact.'),
        sourceFile: z.string().optional().describe('Previously returned event handler source artifact tmpFile.'),
        sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for the event handler.'),
        scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable event.'),
        description: z.string().optional().describe('Admin note.'),
        globalRulesAckKey: globalRulesAckParam(z),
        knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
      },
      async ({ gatewayPath, gatewayId, eventName, sourceCode, sourceFile, sourceResourceUri, scriptLanguage, isEnabled, description, globalRulesAckKey, knowledgeAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        assertDynamicCodeKnowledgeAck(knowledgeAckKey);
        const materialized = materializeSourceInput({ source: sourceCode, sourceFile, sourceResourceUri, fieldName: 'sourceCode', tableName: 'enfyra_websocket_event', id: eventName });
        if (!gatewayPath && !gatewayId) throw new Error('Provide gatewayPath or gatewayId.');
        if (gatewayPath && gatewayId) throw new Error('Provide gatewayPath or gatewayId, not both.');
        const gateway = gatewayId
          ? await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { id: { _eq: gatewayId } }, 'id,_id,path')
          : await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { path: { _eq: normalizeRestPath(gatewayPath) } }, 'id,_id,path');
        if (!gateway) throw new Error(`Websocket gateway not found: ${gatewayId || gatewayPath}`);
        const validation = await validateDynamicScript(ENFYRA_API_URL, materialized.source, scriptLanguage);
        const existing = await findRecord(ENFYRA_API_URL, 'enfyra_websocket_event', {
          gateway: { id: { _eq: getId(gateway) } },
          eventName: { _eq: eventName },
        }, 'id,_id,eventName,gateway.id');
        const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_websocket_event', existing, {
          gateway: { id: getId(gateway) },
          eventName,
          sourceCode: materialized.source,
          scriptLanguage,
          isEnabled,
          description,
        });
        const reload = naturalPartialReload('Websocket event writes trigger the server partial reload contract; there is no dedicated websocket reload endpoint.');
        return jsonText({ action: 'websocket_event_ensured', gateway: { id: getId(gateway), path: gateway.path }, eventName, validation, sourceArtifact: materialized.sourceArtifact, operation, reload });
      },
    );
}
