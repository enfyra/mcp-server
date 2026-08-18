import { fetchAPI } from './fetch.js';
import {
  createOrPatch,
  fetchRecords,
  findRecord,
  resolveRole,
} from './platform-data-operations.js';
import {
  reloadBestEffort,
  sha256Text,
  validateExtensionCode,
  verifyExtensionRuntime,
} from './platform-extension-source.js';
import {
  getId,
  normalizeRestPath,
  sameId,
} from './platform-route-operations.js';
import {
  assertExtensionKnowledgeAck,
  assertGlobalRulesAck
} from './required-knowledge.js';
import { materializeSourceInput } from './source-artifacts.js';

export async function ensureMenu(apiUrl, {
  menuId = undefined,
  label,
  path,
  icon,
  type,
  order,
  isPublic,
  description,
  isEnabled,
  globalRulesAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  const effectiveType = type || 'Menu';
  const normalizedPath = path ? normalizeRestPath(path) : undefined;
  const fields = 'id,_id,label,path,icon,type,order,description,isEnabled,isPublic,parent.id,extension.id,menuPermissions.id';
  let existing = menuId != null
    ? await findRecord(apiUrl, 'enfyra_menu', { id: { _eq: menuId } }, fields)
    : normalizedPath
      ? await findRecord(apiUrl, 'enfyra_menu', { path: { _eq: normalizedPath } }, fields)
      : await findRecord(apiUrl, 'enfyra_menu', { label: { _eq: label }, type: { _eq: effectiveType } }, fields);
  if (menuId != null && !existing) throw new Error(`Menu not found: ${menuId}`);
  if (!existing && label) {
    const sameLabel = await fetchRecords(apiUrl, 'enfyra_menu', { label: { _eq: label }, type: { _eq: effectiveType } }, fields, 1000);
    if (sameLabel.length > 1) throw new Error(`Multiple menus match label "${label}" and type "${type}". Provide menuId.`);
    if (sameLabel.length === 1) existing = sameLabel[0];
  }
  if (existing && normalizedPath) {
    const pathOwner = await findRecord(apiUrl, 'enfyra_menu', { path: { _eq: normalizedPath } }, 'id,_id,label,path,type');
    if (pathOwner && !sameId(getId(pathOwner), getId(existing))) {
      throw new Error(`Menu path collision: ${normalizedPath} is already used by menu ${getId(pathOwner)}.`);
    }
  }
  const body: Record<string, any> = {};
  if (label !== undefined) body.label = label;
  if (normalizedPath !== undefined) body.path = normalizedPath;
  if (!existing) {
    body.icon = icon;
    body.type = effectiveType;
    body.order = order;
    body.description = description;
    body.isEnabled = isEnabled;
    body.isPublic = isPublic ?? false;
  } else {
    if (icon !== undefined) body.icon = icon;
    if (type !== undefined) body.type = type;
    if (order !== undefined) body.order = order;
    if (description !== undefined) body.description = description;
    if (isEnabled !== undefined) body.isEnabled = isEnabled;
    if (isPublic !== undefined) body.isPublic = isPublic;
  }
  const operation = await createOrPatch(apiUrl, 'enfyra_menu', existing, body);
  const id = operation.id || getId(existing);
  const runtimeReload = await reloadBestEffort(apiUrl, '/admin/reload/metadata');
  const saved = await findRecord(apiUrl, 'enfyra_menu', { id: { _eq: id } }, fields);
  return {
    id,
    menuId: id,
    oldPath: existing?.path || null,
    newPath: saved?.path || normalizedPath || existing?.path || null,
    path: saved?.path || normalizedPath || existing?.path || null,
    label: saved?.label || label || null,
    action: operation.action,
    operation: { action: operation.action, id },
    runtimeReload,
    postcondition: {
      confirmed: Boolean(saved && sameId(getId(saved), id)),
      menu: saved ? {
        id: getId(saved),
        label: saved.label || null,
        path: saved.path || null,
        parentId: saved.parent ? getId(saved.parent) : null,
        order: saved.order ?? null,
        type: saved.type || null,
        isEnabled: saved.isEnabled,
        isPublic: saved.isPublic,
        extensionId: saved.extension ? getId(saved.extension) : null,
        menuPermissionIds: Array.isArray(saved.menuPermissions) ? saved.menuPermissions.map((item) => getId(item)) : [],
      } : null,
    },
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
    const normalizedUpdate: { id: string | number; order: number; parent?: string | number | null } = {
      id,
      order,
    };
    if (item.parent !== undefined) {
      normalizedUpdate.parent = item.parent === null || String(item.parent).trim() === ''
        ? null
        : item.parent;
    }
    return normalizedUpdate;
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

function summarizeExtension(extension) {
  return {
    id: getId(extension),
    name: extension?.name || null,
    type: extension?.type || null,
    isEnabled: extension?.isEnabled !== false,
    isSystem: extension?.isSystem === true,
    menu: extension?.menu
      ? {
        id: getId(extension.menu),
        label: extension.menu.label || null,
        path: extension.menu.path || null,
      }
      : null,
  };
}

function summarizeMenu(menu) {
  return {
    id: getId(menu),
    label: menu?.label || null,
    path: menu?.path || null,
    type: menu?.type || null,
    isEnabled: menu?.isEnabled !== false,
    isSystem: menu?.isSystem === true,
    parent: menu?.parent
      ? {
        id: getId(menu.parent),
        label: menu.parent.label || null,
        path: menu.parent.path || null,
      }
      : null,
  };
}

async function resolveExtensionForDeletion(apiUrl, { id, name }) {
  if ((id === undefined || id === null) === (!name)) {
    throw new Error('Provide id or name, not both.');
  }
  const extension = await findRecord(
    apiUrl,
    'enfyra_extension',
    id !== undefined && id !== null ? { id: { _eq: id } } : { name: { _eq: name } },
    'id,_id,name,type,isEnabled,isSystem,menu.id,menu.label,menu.path',
  );
  if (!extension) throw new Error(`Extension not found: ${id ?? name}`);
  return extension;
}

export async function deleteExtension(apiUrl, {
  id,
  name,
  expectedExtensionId,
  confirm = false,
  globalRulesAckKey,
}) {
  const extension = await resolveExtensionForDeletion(apiUrl, { id, name });
  const extensionId = getId(extension);
  if (confirm && (expectedExtensionId === undefined || expectedExtensionId === null)) {
    throw new Error('expectedExtensionId is required when confirm=true. Pass the exact extension id returned by the preview.');
  }
  if (expectedExtensionId !== undefined && expectedExtensionId !== null && !sameId(extensionId, expectedExtensionId)) {
    throw new Error(`Extension id mismatch: resolved ${extensionId}, expected ${expectedExtensionId}.`);
  }

  const preview = {
    extension: summarizeExtension(extension),
    dependencies: {
      linkedMenu: extension?.menu ? summarizeMenu(extension.menu) : null,
      deletionBehavior: 'The extension is removed; its linked menu is preserved and unlinked by the server relation contract.',
    },
  };

  if (!confirm) {
    return {
      action: 'delete_extension_preview',
      ...preview,
      postcondition: {
        verificationMethod: 'not_run_preview',
        confirmedAbsent: false,
      },
      next: 'Call delete_extension again with the same locator, confirm=true, and expectedExtensionId from this preview.',
    };
  }

  assertGlobalRulesAck(globalRulesAckKey);
  if (extension?.isSystem === true) {
    throw new Error(`Extension ${extensionId} is system-owned and cannot be deleted.`);
  }

  const result = await fetchAPI(apiUrl, `/enfyra_extension/${encodeURIComponent(String(extensionId))}`, {
    method: 'DELETE',
  });
  const remaining = await findRecord(
    apiUrl,
    'enfyra_extension',
    { id: { _eq: extensionId } },
    'id,_id,name,type,isEnabled,isSystem,menu.id,menu.label,menu.path',
  );
  const postcondition = {
    verificationMethod: 'extension_query_by_id',
    confirmedAbsent: !remaining,
    remainingExtension: remaining ? summarizeExtension(remaining) : null,
  };
  return {
    action: 'extension_deleted',
    ...preview,
    result,
    postcondition,
    runtimeReload: {
      attempted: false,
      succeeded: true,
      reason: 'The Enfyra extension mutation lifecycle reloads extension runtime metadata and invalidates the extension cache.',
    },
  };
}

async function resolveMenuForDeletion(apiUrl, { menuId, menuPath }) {
  if ((menuId === undefined || menuId === null) === (!menuPath)) {
    throw new Error('Provide menuId or menuPath, not both.');
  }
  const menu = await findRecord(
    apiUrl,
    'enfyra_menu',
    menuId !== undefined && menuId !== null
      ? { id: { _eq: menuId } }
      : { path: { _eq: normalizeRestPath(menuPath) } },
    'id,_id,label,path,type,isEnabled,isSystem,parent.id,parent.label,parent.path',
  );
  if (!menu) throw new Error(`Menu not found: ${menuId ?? normalizeRestPath(menuPath)}`);
  return menu;
}

async function fetchMenuDeletionDependencies(apiUrl, menuId) {
  const children = await fetchRecords(
    apiUrl,
    'enfyra_menu',
    { parent: { id: { _eq: menuId } } },
    'id,_id,label,path,type,isEnabled,isSystem,parent.id',
    1000,
  );
  const permissions = await fetchRecords(
    apiUrl,
    'enfyra_menu_permission',
    { menu: { id: { _eq: menuId } } },
    'id,_id,isEnabled,role.id,role.name',
    1000,
  );
  const extensions = await fetchRecords(
    apiUrl,
    'enfyra_extension',
    { menu: { id: { _eq: menuId } } },
    'id,_id,name,type,isEnabled,isSystem,menu.id',
    1000,
  );
  return { children, permissions, extensions };
}

function summarizeMenuDependencies(dependencies) {
  return {
    children: dependencies.children.map((item) => ({
      id: getId(item),
      label: item?.label || null,
      path: item?.path || null,
      type: item?.type || null,
      isSystem: item?.isSystem === true,
    })),
    permissions: dependencies.permissions.map((item) => ({
      id: getId(item),
      role: item?.role?.name || null,
      isEnabled: item?.isEnabled !== false,
    })),
    extensions: dependencies.extensions.map(summarizeExtension),
  };
}

export async function deleteMenu(apiUrl, {
  menuId,
  menuPath,
  expectedMenuId,
  confirm = false,
  globalRulesAckKey,
}) {
  const menu = await resolveMenuForDeletion(apiUrl, { menuId, menuPath });
  const resolvedMenuId = getId(menu);
  if (confirm && (expectedMenuId === undefined || expectedMenuId === null)) {
    throw new Error('expectedMenuId is required when confirm=true. Pass the exact menu id returned by the preview.');
  }
  if (expectedMenuId !== undefined && expectedMenuId !== null && !sameId(resolvedMenuId, expectedMenuId)) {
    throw new Error(`Menu id mismatch: resolved ${resolvedMenuId}, expected ${expectedMenuId}.`);
  }

  const dependencies = await fetchMenuDeletionDependencies(apiUrl, resolvedMenuId);
  const preview = {
    menu: summarizeMenu(menu),
    dependencies: summarizeMenuDependencies(dependencies),
    deletionBehavior: 'The menu is removed; child menus are detached, menu visibility rows cascade, and linked extensions are preserved and unlinked by the server relation contract.',
  };

  if (!confirm) {
    return {
      action: 'delete_menu_preview',
      ...preview,
      postcondition: {
        verificationMethod: 'not_run_preview',
        confirmedAbsent: false,
      },
      next: 'Call delete_menu again with the same locator, confirm=true, and expectedMenuId from this preview.',
    };
  }

  assertGlobalRulesAck(globalRulesAckKey);
  if (menu?.isSystem === true) {
    throw new Error(`Menu ${resolvedMenuId} is system-owned and cannot be deleted.`);
  }
  if (dependencies.children.some((item) => item?.isSystem === true)) {
    throw new Error(`Menu ${resolvedMenuId} has system-owned child menus and cannot be deleted.`);
  }
  if (dependencies.extensions.some((item) => item?.isSystem === true)) {
    throw new Error(`Menu ${resolvedMenuId} has a system-owned extension and cannot be deleted.`);
  }

  const result = await fetchAPI(apiUrl, `/enfyra_menu/${encodeURIComponent(String(resolvedMenuId))}`, {
    method: 'DELETE',
  });
  const remainingMenu = await findRecord(
    apiUrl,
    'enfyra_menu',
    { id: { _eq: resolvedMenuId } },
    'id,_id,label,path,type,isEnabled,isSystem,parent.id,parent.label,parent.path',
  );
  const remainingChildren = await fetchRecords(
    apiUrl,
    'enfyra_menu',
    { parent: { id: { _eq: resolvedMenuId } } },
    'id,_id,label,path,type,isEnabled,isSystem,parent.id',
    1000,
  );
  const remainingPermissions = await fetchRecords(
    apiUrl,
    'enfyra_menu_permission',
    { menu: { id: { _eq: resolvedMenuId } } },
    'id,_id,isEnabled,role.id,role.name',
    1000,
  );
  const remainingExtensions = await fetchRecords(
    apiUrl,
    'enfyra_extension',
    { menu: { id: { _eq: resolvedMenuId } } },
    'id,_id,name,type,isEnabled,isSystem,menu.id',
    1000,
  );
  const postcondition = {
    verificationMethod: 'menu_query_and_dependency_queries',
    confirmedAbsent: !remainingMenu
      && remainingChildren.length === 0
      && remainingPermissions.length === 0
      && remainingExtensions.length === 0,
    remainingMenu: remainingMenu ? summarizeMenu(remainingMenu) : null,
    remainingChildren: remainingChildren.map(summarizeMenu),
    remainingPermissions: remainingPermissions.map((item) => ({ id: getId(item), role: item?.role?.name || null })),
    remainingExtensions: remainingExtensions.map(summarizeExtension),
  };
  return {
    action: 'menu_deleted',
    ...preview,
    result,
    postcondition,
    runtimeReload: {
      attempted: false,
      succeeded: true,
      reason: 'The Enfyra menu mutation lifecycle reloads menu runtime metadata and invalidates menu/extension cache dependencies.',
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
