import { fetchAPI } from './fetch.js';
import {
  createOrPatch,
  findRecord,
  resolveRole,
} from './platform-data-operations.js';
import {
  sha256Text,
  validateExtensionCode,
  verifyExtensionRuntime,
} from './platform-extension-source.js';
import {
  getId,
  normalizeRestPath,
} from './platform-route-operations.js';
import {
  assertExtensionKnowledgeAck,
  assertGlobalRulesAck
} from './required-knowledge.js';
import { materializeSourceInput } from './source-artifacts.js';

export async function ensureMenu(apiUrl, {
  label,
  path,
  icon,
  type = 'Menu',
  order = 0,
  isPublic,
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
    ...(isPublic !== undefined ? { isPublic } : (!existing ? { isPublic: false } : {})),
  };
  const operation = await createOrPatch(apiUrl, 'enfyra_menu', existing, body);
  return {
    id: operation.id || getId(existing),
    path: normalizedPath || existing?.path || null,
    label,
    action: operation.action,
    operation,
  };
}

export async function ensureMenuAccess(apiUrl, {
  menuId,
  menuPath,
  roleId,
  roleName,
  isEnabled = true,
  globalRulesAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  if ((menuId == null) === (!menuPath)) throw new Error('Provide menuId or menuPath, not both.');
  if (roleId && roleName) throw new Error('Provide roleId or roleName, not both.');
  if (!roleId && !roleName) throw new Error('Provide roleId or roleName.');

  const menu = menuId != null
    ? await findRecord(apiUrl, 'enfyra_menu', { id: { _eq: menuId } }, 'id,_id,path,label')
    : await findRecord(apiUrl, 'enfyra_menu', { path: { _eq: normalizeRestPath(menuPath) } }, 'id,_id,path,label');
  if (!menu) throw new Error(`Menu not found: ${menuId ?? menuPath}`);

  const role = await resolveRole(apiUrl, { roleId, roleName });
  const menuRecordId = getId(menu);
  const roleRecordId = getId(role);
  const existing = await findRecord(
    apiUrl,
    'enfyra_menu_permission',
    { menu: { id: { _eq: menuRecordId } }, role: { id: { _eq: roleRecordId } } },
    'id,_id,isEnabled,menu.id,role.id,role.name',
  );
  const operation = await createOrPatch(apiUrl, 'enfyra_menu_permission', existing, {
    menu: { id: menuRecordId },
    role: { id: roleRecordId },
    isEnabled,
  });

  return {
    action: 'menu_access_ensured',
    menu: { id: menuRecordId, path: menu.path, label: menu.label },
    role: { id: roleRecordId, name: role.name },
    permission: { id: operation.id || getId(existing), isEnabled },
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
  sourceFile,
  sourceResourceUri,
  menuId,
  description,
  isEnabled = true,
  version = '1.0.0',
  globalRulesAckKey,
  extensionKnowledgeAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  assertExtensionKnowledgeAck(extensionKnowledgeAckKey);
  const materialized = materializeSourceInput({
    source: code,
    sourceFile,
    sourceResourceUri,
    fieldName: 'code',
    tableName: 'enfyra_extension',
    id: name,
  });
  const resolvedCode = materialized.source;
  if (type === 'page' && !menuId) {
    throw new Error('menuId is required for page extensions. Use ensure_menu first, then ensure_page_extension.');
  }
  if (type !== 'page' && menuId) {
    throw new Error('menuId is only valid for page extensions.');
  }
  const validation = await validateExtensionCode(apiUrl, resolvedCode, name);
  const existing = await findRecord(apiUrl, 'enfyra_extension', { name: { _eq: name } }, 'id,_id,name,menu.id,type');
  const operation = await createOrPatch(apiUrl, 'enfyra_extension', existing, {
    name,
    type,
    code: resolvedCode,
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
    expectedSha256: sha256Text(resolvedCode),
  });
  return {
    id: extensionId,
    name,
    type,
    action: operation.action,
    operation: { action: operation.action, id: extensionId },
    validation,
    sourceArtifact: materialized.sourceArtifact,
    verification,
  };
}
