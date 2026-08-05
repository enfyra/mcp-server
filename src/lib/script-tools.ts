/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { z } from 'zod';
// Import modules
import {
  SCRIPT_BACKED_TABLES,
  fetchScriptRecord,
  prepareGenericMutation,
  replaceOccurrence,
  scriptRecordLabel,
  sha256,
  sourcePreview,
  summarizeMutationResult,
} from './enfyra-tool-logic.js';
import { fetchAPI, validateTableName } from './fetch.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertGlobalRulesAck,
  dynamicCodeKnowledgeAckParam,
  globalRulesAckParam
} from './required-knowledge.js';
import { materializeSourceInput, resolveSourceInput, writeSourceArtifact } from './source-artifacts.js';

async function verifySavedScriptSource(tableName, id, expectedSourceCode) {
  const saved = await fetchScriptRecord(tableName, id);
  const savedSha256 = sha256(saved.sourceCode);
  const sourceArtifact = writeSourceArtifact({
    tableName,
    id,
    fieldName: saved.sourceField,
    source: saved.sourceCode,
  });
  return {
    valid: saved.sourceCode === expectedSourceCode,
    sourceField: saved.sourceField,
    sourceLength: saved.sourceCode.length,
    sourceSha256: savedSha256,
    sourceFile: sourceArtifact.tmpFile,
    sourceResourceUri: sourceArtifact.resourceUri,
  };
}

export function registerScriptTools(server, ENFYRA_API_URL) {
  server.tool(
    'get_script_source',
    [
      'Fetch the full editable source for one script-backed metadata record without preview truncation.',
      'Use search_runtime_zone first and pass the returned nextInspect.input to inspect the concrete record. The inspection already returns exact source artifacts.',
      'Call get_script_source only when a fresh artifact is needed for that located record. Never guess or probe record ids.',
    ].join(' '),
    {
      tableName: z.enum(SCRIPT_BACKED_TABLES).describe('Script-backed table to read'),
      id: z.string().describe('Concrete record id returned by search_runtime_zone, inspect output, or a successful create/update operation. Never guess an id.'),
    },
    async ({ tableName, id }) => {
      const { primaryKey, record, sourceField, sourceCode } = await fetchScriptRecord(tableName, id);
      const sourceArtifact = writeSourceArtifact({ tableName, id, fieldName: sourceField, source: sourceCode });
      return { content: [{ type: 'text', text: JSON.stringify({
        tableName,
        id,
        primaryKey,
        sourceField,
        sourceFile: sourceArtifact.tmpFile,
        sourceResourceUri: sourceArtifact.resourceUri,
        sourcePreview: sourceArtifact.preview,
        sourceLength: sourceCode.length,
        sourceSha256: sha256(sourceCode),
        scriptLanguage: record.scriptLanguage || record.language || null,
        record: scriptRecordLabel(tableName, record),
      }, null, 2) }] };
    },
  );

  server.tool(
    'patch_script_source',
    [
      'Patch sourceCode on a script-backed record using exact search/replace with optional hash checking.',
      'By default this returns a preview only. Set apply=true to validate through /admin/script/validate and save.',
      'Use get_script_source first for long scripts, then patch only the exact block you intend to change.',
    ].join(' '),
    {
      tableName: z.enum(SCRIPT_BACKED_TABLES).describe('Script-backed table to patch'),
      id: z.string().describe('Record ID to patch'),
      oldText: z.string().optional().describe('Exact text to replace. Omit when applying a previously returned sourceFile/sourceResourceUri artifact.'),
      newText: z.string().optional().describe('Replacement text. Omit when applying a previously returned sourceFile/sourceResourceUri artifact.'),
      sourceFile: z.string().optional().describe('Previously returned final patched source artifact tmpFile. Use this on apply=true to validate/apply the exact reviewed file without recomputing the patch.'),
      sourceResourceUri: z.string().optional().describe('Previously returned final patched source artifact URI.'),
      occurrence: z.enum(['first', 'all']).optional().default('all').describe('Replace first occurrence or all occurrences.'),
      expectedSourceSha256: z.string().optional().describe('Optional SHA-256 from get_script_source; fails if source changed.'),
      scriptLanguage: z.string().optional().describe('Script language to save. Defaults to existing scriptLanguage or javascript.'),
      apply: z.boolean().optional().default(false).describe('false returns preview only; true validates and saves.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when apply=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required when apply=true. Use dynamicCodeAckKey from get_enfyra_required_knowledge.'),
    },
    async ({ tableName, id, oldText, newText, sourceFile, sourceResourceUri, occurrence, expectedSourceSha256, scriptLanguage, apply, globalRulesAckKey, knowledgeAckKey }) => {
      const { record, sourceField, sourceCode } = await fetchScriptRecord(tableName, id);
      if (sourceField !== 'sourceCode') {
        throw new Error(`patch_script_source only saves sourceCode records. Record uses "${sourceField}"; use update_records intentionally for this legacy field.`);
      }
      const beforeHash = sha256(sourceCode);
      if (expectedSourceSha256 && expectedSourceSha256 !== beforeHash) {
        throw new Error(`Source hash mismatch. Current sha256 is ${beforeHash}; re-read with get_script_source before patching.`);
      }
      if ((sourceFile || sourceResourceUri) && (oldText !== undefined || newText !== undefined)) {
        throw new Error('When sourceFile/sourceResourceUri is provided, omit oldText and newText so the exact artifact is applied.');
      }
      if (!sourceFile && !sourceResourceUri && (oldText === undefined || newText === undefined)) {
        throw new Error('Provide oldText and newText, or provide sourceFile/sourceResourceUri from a reviewed patch artifact.');
      }
      const patchResult = sourceFile || sourceResourceUri
        ? { occurrences: 0, patched: resolveSourceInput({ sourceFile, sourceResourceUri, fieldName: 'sourceCode' }), replaced: false }
        : replaceOccurrence(sourceCode, oldText!, newText!, occurrence || 'all');
      const { occurrences, patched, replaced } = patchResult;
      const patchedArtifact = materializeSourceInput({
        source: patched,
        fieldName: 'sourceCode',
        tableName,
        id,
      });
      const exactPatched = patchedArtifact.source;
      const afterHash = sha256(exactPatched);
      const payload = {
        action: apply ? 'patch_script_source_applied' : 'patch_script_source_preview',
        tableName,
        id,
        sourceField,
        sourceLengthBefore: sourceCode.length,
        sourceLengthAfter: exactPatched.length,
        sourceSha256Before: beforeHash,
        sourceSha256After: afterHash,
        occurrences,
        replaced,
        preview: {
          before: sourcePreview(sourceCode, oldText),
          after: sourcePreview(exactPatched, newText || ''),
        },
        sourceArtifact: patchedArtifact.sourceArtifact,
        next: apply ? undefined : 'Call patch_script_source again with apply=true, sourceFile/sourceResourceUri from this artifact, and expectedSourceSha256 set to sourceSha256Before to validate and save.',
      };
      if (!apply) {
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
      assertGlobalRulesAck(globalRulesAckKey);
      assertDynamicCodeKnowledgeAck(knowledgeAckKey);
      const language = scriptLanguage || record.scriptLanguage || 'javascript';
      const prepared = await prepareGenericMutation(
        tableName,
        JSON.stringify({ sourceCode: exactPatched, scriptLanguage: language }),
      );
      const result = await fetchAPI(
        ENFYRA_API_URL,
        `/${tableName}/${encodeURIComponent(String(id))}`,
        { method: 'PATCH', body: JSON.stringify(prepared.payload) },
      );
      return { content: [{ type: 'text', text: JSON.stringify({
        ...payload,
        ...summarizeMutationResult(result, 'patch_script_source_applied', tableName),
        id,
        scriptLanguage: language,
        scriptValidation: prepared.scriptValidation,
        savedSource: await verifySavedScriptSource(tableName, id, exactPatched),
      }, null, 2) }] };
    },
  );

  server.tool(
    'update_script_source',
    [
      'Update sourceCode on a script-backed record without forcing the caller to JSON-escape long code.',
      'Pass sourceFile or sourceResourceUri from a prior inspect when the reviewed artifact is the intended full replacement; the MCP process reads it without echoing the source through the model call.',
      'Use this for enfyra_flow_step, enfyra_route_handler, enfyra_pre_hook, enfyra_post_hook, enfyra_websocket_event, enfyra_websocket, enfyra_oauth_config, and enfyra_bootstrap_script.',
      'The tool validates sourceCode through /admin/script/validate before saving, re-reads the saved source, returns a fresh artifact/hash verification, and never accepts compiledCode.',
    ].join(' '),
    {
      tableName: z.enum([
        'enfyra_route_handler',
        'enfyra_pre_hook',
        'enfyra_post_hook',
        'enfyra_flow_step',
        'enfyra_websocket_event',
        'enfyra_websocket',
        'enfyra_oauth_config',
        'enfyra_bootstrap_script',
      ]).describe('Script-backed table to update'),
      id: z.string().describe('Record ID to update'),
      sourceCode: z.string().optional().describe('Editable script sourceCode. Pass the raw code string; do not JSON-escape it yourself. Use sourceFile or sourceResourceUri instead for a previously inspected artifact.'),
      sourceFile: z.string().optional().describe('Previously returned source artifact tmpFile. The MCP server reads only artifacts created in this process; it rejects arbitrary paths.'),
      sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI. The MCP server reads only artifacts created in this process.'),
      expectedSourceSha256: z.string().optional().describe('Optional SHA-256 of the current saved source from inspect/get_script_source. Rejects a stale full replacement.'),
      scriptLanguage: z.string().optional().default('javascript').describe('Script language, usually javascript or typescript'),
      globalRulesAckKey: globalRulesAckParam(z),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
    },
    async ({ tableName, id, sourceCode, sourceFile, sourceResourceUri, expectedSourceSha256, scriptLanguage, globalRulesAckKey, knowledgeAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      assertDynamicCodeKnowledgeAck(knowledgeAckKey);
      validateTableName(tableName);
      const resolvedSourceCode = resolveSourceInput({
        source: sourceCode,
        sourceFile,
        sourceResourceUri,
        fieldName: 'sourceCode',
      });
      if (expectedSourceSha256) {
        const current = await fetchScriptRecord(tableName, id);
        const currentSha256 = sha256(current.sourceCode);
        if (expectedSourceSha256 !== currentSha256) {
          throw new Error(`Source hash mismatch. Current sha256 is ${currentSha256}; re-read the script artifact before replacing it.`);
        }
      }
      const prepared = await prepareGenericMutation(
        tableName,
        JSON.stringify({ sourceCode: resolvedSourceCode, scriptLanguage }),
      );
      const result = await fetchAPI(
        ENFYRA_API_URL,
        `/${tableName}/${encodeURIComponent(String(id))}`,
        { method: 'PATCH', body: JSON.stringify(prepared.payload) },
      );
      return { content: [{ type: 'text', text: JSON.stringify({
        ...summarizeMutationResult(result, 'updated_script_source', tableName),
        id,
        sourceLength: resolvedSourceCode.length,
        sourceSha256: sha256(resolvedSourceCode),
        scriptLanguage,
        scriptValidation: prepared.scriptValidation,
        savedSource: await verifySavedScriptSource(tableName, id, resolvedSourceCode),
      }, null, 2) }] };
    },
  );
}
