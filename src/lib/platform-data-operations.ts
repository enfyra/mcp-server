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
  firstDataRecord,
  getId,
  sameId,
  unwrapData,
} from './platform-route-operations.js';
import {
  filterQuery,
} from './platform-extension-source.js';
import {
  step,
} from './platform-endpoint-workflow.js';
import {
  FlowStepBody,
} from './platform-shared-operations.js';

export function resolveColumn(table, columnName) {
  const column = (table.columns || []).find((item) => item?.name === columnName || sameId(getId(item), columnName));
  if (!column) throw new Error(`Column not found: ${table.name}.${columnName}`);
  return column;
}

export function resolveRelation(table, relationName) {
  const relation = (table.relations || []).find((item) => item?.propertyName === relationName || item?.name === relationName || sameId(getId(item), relationName));
  if (!relation) throw new Error(`Relation not found: ${table.name}.${relationName}`);
  return relation;
}

export async function findRecord(apiUrl, tableName, filter, fields = '*') {
  const result = await fetchAPI(apiUrl, `/${tableName}?filter=${filterQuery(filter)}&limit=1&fields=${encodeURIComponent(fields)}`);
  return unwrapData(result)[0] || null;
}

export async function fetchRecords(apiUrl, tableName, filter, fields = '*', limit = 1000) {
  const result = await fetchAPI(apiUrl, `/${tableName}?filter=${filterQuery(filter)}&limit=${limit}&fields=${encodeURIComponent(fields)}`);
  return unwrapData(result);
}

export async function createOrPatch(apiUrl, tableName, existing, body) {
  if (existing) {
    const result = await fetchAPI(apiUrl, `/${tableName}/${encodeURIComponent(String(getId(existing)))}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return { action: 'updated', result, id: getId(firstDataRecord(result)) || getId(existing) };
  }
  const result = await fetchAPI(apiUrl, `/${tableName}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { action: 'created', result, id: getId(firstDataRecord(result)) };
}

export async function resolveRole(apiUrl, { roleId, roleName }) {
  if (roleId && roleName) throw new Error('Provide roleId or roleName, not both.');
  if (!roleId && !roleName) return null;
  if (roleId) return { id: roleId, name: null };
  const role = await findRecord(apiUrl, 'enfyra_role', { name: { _eq: roleName } }, 'id,_id,name');
  if (!role) throw new Error(`Role not found: ${roleName}`);
  return { id: getId(role), name: role.name };
}

export function assertOneScope({ roleId, roleName, allowedUserIds }) {
  if (!roleId && !roleName && (!allowedUserIds || allowedUserIds.length === 0)) {
    throw new Error('Provide roleId, roleName, or allowedUserIds.');
  }
}

export function normalizeFlowStepBody(step, flowId) {
  const body: FlowStepBody = {
    key: step.key,
    type: step.type,
    stepOrder: step.order ?? 0,
    config: step.config ?? {},
    timeout: step.timeout,
    isEnabled: step.isEnabled ?? true,
    flow: { id: flowId },
  };
  if (step.sourceCode !== undefined) body.sourceCode = step.sourceCode;
  if (step.scriptLanguage !== undefined) body.scriptLanguage = step.scriptLanguage;
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}
