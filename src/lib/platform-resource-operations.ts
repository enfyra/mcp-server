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
  getId,
  normalizeRestPath,
} from './platform-route-operations.js';
import {
  createOrPatch,
  findRecord,
} from './platform-data-operations.js';
import {
  normalizeMenuPermissionArg,
  sha256Text,
  validateExtensionCode,
  verifyExtensionRuntime,
} from './platform-extension-source.js';

export async function ensureMenu(apiUrl, {
  label,
  path,
  icon,
  type = 'Menu',
  order = 0,
  permission,
  description,
  isEnabled = true,
  globalRulesAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  const normalizedPath = path ? normalizeRestPath(path) : undefined;
  const existing = normalizedPath
    ? await findRecord(apiUrl, 'enfyra_menu', { path: { _eq: normalizedPath } }, 'id,_id,path,label')
    : await findRecord(apiUrl, 'enfyra_menu', { label: { _eq: label } }, 'id,_id,path,label');
  const body: Record<string, any> = {
    label,
    ...(normalizedPath ? { path: normalizedPath } : {}),
    icon,
    type,
    order,
    description,
    isEnabled,
  };
  if (permission !== undefined) {
    body.permission = normalizeMenuPermissionArg(permission);
  } else if (!existing) {
    body.permission = null;
  }
  const operation = await createOrPatch(apiUrl, 'enfyra_menu', existing, body);
  return {
    id: operation.id || getId(existing),
    path: normalizedPath || existing?.path || null,
    label,
    action: operation.action,
    operation,
  };
}

export async function reorderMenus(apiUrl, { updates, globalRulesAckKey }) {
  assertGlobalRulesAck(globalRulesAckKey);
  const seen = new Set();
  const normalizedUpdates = updates.map((item, index) => {
    const id = item?.id;
    if (id === null || id === undefined || String(id).trim() === '') {
      throw new Error(`updates[${index}].id is required.`);
    }
    const key = String(id);
    if (seen.has(key)) throw new Error(`Duplicate menu id in reorder payload: ${key}`);
    seen.add(key);
    const order = Number(item.order);
    if (!Number.isInteger(order) || order < 0) {
      throw new Error(`updates[${index}].order must be a non-negative integer.`);
    }
    const parent = item.parent === undefined || item.parent === null || String(item.parent).trim() === ''
      ? null
      : item.parent;
    return { id, order, parent };
  });
  const result = await fetchAPI(apiUrl, '/admin/menu/reorder', {
    method: 'POST',
    body: JSON.stringify({ updates: normalizedUpdates }),
  });
  return {
    action: 'menus_reordered',
    updates: normalizedUpdates,
    result,
    reload: {
      attempted: false,
      succeeded: true,
      reason: '/admin/menu/reorder persists order/parent updates and emits enfyra_menu cache invalidation.',
    },
  };
}

export async function ensureExtension(apiUrl, {
  name,
  type,
  code,
  menuId,
  description,
  isEnabled = true,
  version = '1.0.0',
  globalRulesAckKey,
  extensionKnowledgeAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  assertExtensionKnowledgeAck(extensionKnowledgeAckKey);
  if (type === 'page' && !menuId) {
    throw new Error('menuId is required for page extensions. Use ensure_menu first, then ensure_page_extension.');
  }
  if (type !== 'page' && menuId) {
    throw new Error('menuId is only valid for page extensions.');
  }
  const validation = await validateExtensionCode(apiUrl, code, name);
  const existing = await findRecord(apiUrl, 'enfyra_extension', { name: { _eq: name } }, 'id,_id,name,menu.id,type');
  const operation = await createOrPatch(apiUrl, 'enfyra_extension', existing, {
    name,
    type,
    code,
    ...(menuId ? { menu: { id: menuId } } : {}),
    description,
    isEnabled,
    version,
  });
  const extensionId = operation.id || getId(existing);
  const verification = await verifyExtensionRuntime(apiUrl, {
    id: extensionId,
    name: extensionId ? undefined : name,
    uiPattern: undefined,
    expectedSha256: sha256Text(code),
  });
  return {
    id: extensionId,
    name,
    type,
    action: operation.action,
    operation: { action: operation.action, id: extensionId },
    validation,
    verification,
  };
}
