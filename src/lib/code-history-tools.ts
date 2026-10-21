import { z } from 'zod';
import type { CodeHistoryEntry } from '../types/code-history.types.js';
import { fetchAPI } from './fetch.js';
import { VERSIONED_CODE_TABLES, prepareCodeUpdate, readCodeRecord } from './code-version.js';
import { assertGlobalRulesAck, globalRulesAckParam } from './required-knowledge.js';
import { writeSourceArtifact } from './source-artifacts.js';

export function registerCodeHistoryTools(server, apiUrl: string) {
  server.tool('get_code_history', 'Read a bounded history page for one exact dynamic-code table and record ID. Source pre-images are omitted; use inspect_code_revision for an exact revision.', {
    tableName: z.enum(VERSIONED_CODE_TABLES),
    recordId: z.string().min(1),
    page: z.number().int().min(1).optional().default(1),
    limit: z.number().int().min(1).max(100).optional().default(20),
  }, async ({ tableName, recordId, page, limit }) => {
    const query = new URLSearchParams({ filter: JSON.stringify({ tableName: { _eq: tableName }, recordId: { _eq: recordId } }), fields: 'id,tableName,recordId,action,fromVersion,toVersion,restoredFrom,changedByEmail,changedBySource,createdAt', sort: '-createdAt,-id', page: String(page), limit: String(limit), meta: 'filterCount' });
    const result = await fetchAPI(apiUrl, `/enfyra_audit?${query}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.tool('inspect_code_revision', 'Inspect one exact audit entry. Returns the previous source through a process-scoped source artifact, not inline code. Deleted records are history-only and cannot be restored.', {
    auditId: z.string().min(1),
  }, async ({ auditId }) => {
    const result = await readCodeRecord<CodeHistoryEntry>('enfyra_audit', auditId, 'id,tableName,recordId,action,fromVersion,toVersion,restoredFrom,previous', path => fetchAPI(apiUrl, path));
    const entry = result.data?.[0];
    if (!entry) throw new Error('Audit entry not found.');
    const sourceField = entry.tableName === 'enfyra_extension' ? 'code' : 'sourceCode';
    const source = entry.previous?.[sourceField];
    const artifact = typeof source === 'string' ? writeSourceArtifact({ tableName: entry.tableName, id: `audit-${auditId}`, source, fieldName: sourceField }) : undefined;
    const sourceArtifact = artifact ? { resourceUri: artifact.resourceUri, tmpFile: artifact.tmpFile, sha256: artifact.sha256, length: artifact.length } : undefined;
    return { content: [{ type: 'text', text: JSON.stringify({ auditId, tableName: entry.tableName, recordId: entry.recordId, action: entry.action, fromVersion: entry.fromVersion, toVersion: entry.toVersion, restoredFrom: entry.restoredFrom, restorable: ['update', 'revert'].includes(entry.action) && !!entry.previous, sourceArtifact }) }] };
  });

  server.tool('restore_code_revision', 'Restore an inspected audit pre-image as a NEW version, preserving history. Does not recreate deleted records. Omit version to increment the current patch; supply a greater valid custom version to override. The server enforces target PATCH permissions.', {
    auditId: z.string().min(1),
    version: z.string().optional(),
    globalRulesAckKey: globalRulesAckParam(z),
  }, async ({ auditId, version, globalRulesAckKey }) => {
    assertGlobalRulesAck(globalRulesAckKey);
    const result = await readCodeRecord<CodeHistoryEntry>('enfyra_audit', auditId, 'id,tableName,recordId,action', path => fetchAPI(apiUrl, path));
    const entry = result.data?.[0];
    if (!entry || !['update', 'revert'].includes(entry.action) || !VERSIONED_CODE_TABLES.some(table => table === entry.tableName)) throw new Error('This audit entry cannot be restored.');
    const prepared = await prepareCodeUpdate(`/${entry.tableName}/${encodeURIComponent(String(entry.recordId))}`, { version }, path => fetchAPI(apiUrl, path));
    await fetchAPI(apiUrl, '/admin/code-audit/revert', { method: 'POST', body: JSON.stringify({ auditId, version: prepared.version }) });
    const saved = await readCodeRecord(entry.tableName, String(entry.recordId), 'version', path => fetchAPI(apiUrl, path));
    if (saved.data?.[0]?.version !== prepared.version) throw new Error('Restore returned without the expected version; inspect current state before retrying.');
    return { content: [{ type: 'text', text: JSON.stringify({ action: 'code_revision_restored', auditId, tableName: entry.tableName, recordId: entry.recordId, version: prepared.version, verified: true }) }] };
  });
}
