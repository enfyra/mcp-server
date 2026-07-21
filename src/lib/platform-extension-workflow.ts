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
  validateExtensionCode,
} from './platform-extension-source.js';
import {
  findRecord,
} from './platform-data-operations.js';
import {
  getId,
  normalizeRestPath,
  refId,
} from './platform-route-operations.js';
import {
  extensionMatches,
  step,
} from './platform-endpoint-workflow.js';
import {
  ensureExtension,
  ensureMenu,
} from './platform-resource-operations.js';

async function resolveExtensionWorkflowState(apiUrl, opts) {
  const type = opts.type || 'page';
  if (type === 'page' && opts.menuId && (opts.menuLabel || opts.menuPath)) {
    throw new Error('Provide menuId or menuLabel/menuPath for page extension workflow, not both.');
  }
  if (type !== 'page' && (opts.menuId || opts.menuLabel || opts.menuPath)) {
    throw new Error('Menu fields are only valid for page extensions.');
  }
  const validation = await validateExtensionCode(apiUrl, opts.code, opts.name);
  const existingExtension = await findRecord(apiUrl, 'enfyra_extension', { name: { _eq: opts.name } }, 'id,_id,name,type,menu.id,description,isEnabled,version,code');
  let menu = null;
  if (type === 'page' && opts.menuId) {
    menu = await findRecord(apiUrl, 'enfyra_menu', { id: { _eq: opts.menuId } }, 'id,_id,label,path,type,order,isEnabled');
    if (!menu) throw new Error(`Menu not found: ${opts.menuId}`);
  } else if (type === 'page' && (opts.menuPath || opts.menuLabel)) {
    const normalizedPath = opts.menuPath ? normalizeRestPath(opts.menuPath) : undefined;
    menu = normalizedPath
      ? await findRecord(apiUrl, 'enfyra_menu', { path: { _eq: normalizedPath } }, 'id,_id,label,path,type,order,isEnabled')
      : await findRecord(apiUrl, 'enfyra_menu', { label: { _eq: opts.menuLabel } }, 'id,_id,label,path,type,order,isEnabled');
  }

  const menuId = opts.menuId || getId(menu);
  const steps = [];
  steps.push(step('completed', 'validate_extension', 'Validate extension code', { validation }));
  if (type === 'page') {
    if (menuId) {
      const menuNeedsUpdate = Boolean(menu && (
        (opts.menuLabel !== undefined && menu.label !== opts.menuLabel)
        || (opts.menuPath !== undefined && menu.path !== normalizeRestPath(opts.menuPath))
        || (opts.menuType !== undefined && menu.type !== opts.menuType)
        || (opts.menuOrder !== undefined && Number(menu.order || 0) !== Number(opts.menuOrder))
        || (opts.menuIsEnabled !== undefined && Boolean(menu.isEnabled) !== Boolean(opts.menuIsEnabled))
      ));
      steps.push(step(menuNeedsUpdate ? 'pending' : 'completed', 'ensure_menu', 'Ensure page menu', {
        menuId,
        menu: menu ? { id: getId(menu), label: menu.label, path: menu.path } : { id: menuId },
      }));
    } else if (opts.menuLabel) {
      steps.push(step('pending', 'ensure_menu', 'Create page menu', {
        reason: 'No existing menu matched; ensure_menu will create it.',
      }));
    } else {
      steps.push(step('blocked', 'ensure_menu', 'Create or select page menu', {
        reason: 'Page extensions require menuId or menuLabel. Provide menuId for an existing menu or menuLabel/menuPath to create/update one.',
      }));
    }
  }

  const effectiveMenuId = type === 'page' ? menuId : undefined;
  const saveStatus = steps.some((item) => ['blocked', 'waiting'].includes(item.status))
    ? 'waiting'
    : extensionMatches(existingExtension, { ...opts, type }, effectiveMenuId)
      ? 'completed'
      : 'pending';
  steps.push(step(saveStatus, 'save_extension', `Ensure ${type} extension`, {
    extensionId: getId(existingExtension),
    currentType: existingExtension?.type || null,
    desiredType: type,
    menuId: effectiveMenuId || null,
    reason: saveStatus === 'waiting' ? 'Menu must exist before saving page extension.' : undefined,
  }));

  const firstRunnable = steps.find((item) => item.status === 'pending') || null;
  const blocked = steps.find((item) => item.status === 'blocked') || null;
  return {
    extension: {
      name: opts.name,
      type,
      id: getId(existingExtension),
      menuId: effectiveMenuId || null,
    },
    validation,
    existingExtension: existingExtension ? {
      id: getId(existingExtension),
      name: existingExtension.name,
      type: existingExtension.type,
      menuId: refId(existingExtension.menu) || null,
    } : null,
    menu: menu ? { id: getId(menu), label: menu.label, path: menu.path } : null,
    steps,
    firstRunnable,
    blocked,
    nextSteps: blocked
      ? [{ tool: 'extension_workflow', input: { name: opts.name, type }, reason: blocked.reason }]
      : firstRunnable
        ? [{
          tool: 'extension_workflow',
          input: { name: opts.name, type, apply: true, stepId: firstRunnable.id },
          stepId: firstRunnable.id,
          requiresKnowledgeAck: 'globalRulesAckKey and extensionAckKey from get_enfyra_required_knowledge',
        }]
        : [],
  };
}

async function applyExtensionWorkflowStep(apiUrl, state, opts, stepId) {
  const selectedStep = stepId
    ? state.steps.find((item) => item.id === stepId)
    : state.firstRunnable;
  if (!selectedStep) return { action: 'noop', reason: 'No runnable step remains.' };
  if (selectedStep.status !== 'pending') {
    throw new Error(`Step "${selectedStep.id}" is ${selectedStep.status}, not pending.`);
  }

  const type = opts.type || 'page';
  if (selectedStep.id === 'ensure_menu') {
    if (type !== 'page') throw new Error('ensure_menu step is only valid for page extensions.');
    if (!opts.menuLabel && !opts.menuId) throw new Error('menuLabel or menuId is required for ensure_menu.');
    return {
      action: 'menu_ensured',
      menu: await ensureMenu(apiUrl, {
        label: opts.menuLabel || state.menu?.label || opts.name,
        path: opts.menuPath || state.menu?.path,
        icon: opts.menuIcon,
        type: opts.menuType,
        order: opts.menuOrder,
        permission: opts.menuPermission,
        description: opts.menuDescription,
        isEnabled: opts.menuIsEnabled,
        globalRulesAckKey: opts.globalRulesAckKey,
      }),
    };
  }

  if (selectedStep.id === 'save_extension') {
    let menuId = opts.menuId || state.extension.menuId;
    if (type === 'page' && !menuId) {
      const freshState = await resolveExtensionWorkflowState(apiUrl, opts);
      menuId = freshState.extension.menuId;
    }
    if (type === 'page' && !menuId) throw new Error('Page extension menu is missing. Apply ensure_menu first.');
    return {
      action: `${type}_extension_ensured`,
      extension: await ensureExtension(apiUrl, {
        name: opts.name,
        type,
        code: opts.code,
        menuId,
        description: opts.description,
        isEnabled: opts.isEnabled,
        version: opts.version,
        globalRulesAckKey: opts.globalRulesAckKey,
        extensionKnowledgeAckKey: opts.extensionKnowledgeAckKey,
      }),
    };
  }

  throw new Error(`Unsupported extension workflow step: ${selectedStep.id}`);
}

export async function runExtensionWorkflow(apiUrl, opts) {
  let state = await resolveExtensionWorkflowState(apiUrl, opts);
  const operations = [];
  if (opts.apply || opts.applyAll) {
    assertGlobalRulesAck(opts.globalRulesAckKey);
    assertExtensionKnowledgeAck(opts.extensionKnowledgeAckKey);
    const maxSteps = opts.applyAll ? 5 : 1;
    for (let i = 0; i < maxSteps; i += 1) {
      if (state.blocked || !state.firstRunnable) break;
      operations.push(await applyExtensionWorkflowStep(apiUrl, state, opts, opts.stepId));
      if (!opts.applyAll) break;
      state = await resolveExtensionWorkflowState(apiUrl, opts);
    }
  }
  const latestState = operations.length ? await resolveExtensionWorkflowState(apiUrl, opts) : state;
  return {
    action: operations.length ? 'extension_workflow_advanced' : 'extension_workflow_planned',
    extension: latestState.extension,
    validation: latestState.validation,
    menu: latestState.menu,
    existingExtension: latestState.existingExtension,
    steps: latestState.steps,
    operations,
    complete: latestState.steps.every((item) => ['completed', 'skipped'].includes(item.status)),
    nextSteps: latestState.nextSteps,
    guidance: [
      'Call get_extension_theme_contract before generating or reviewing extension UI.',
      'For high-contract UI/runtime code, call build_extension_ui after extension acknowledgement before patching raw Vue: drawer, modal, page shell, permission gate, empty state, resource list, form editor, widget, menu notification, account panel item, tabs, upload modal, api usage, notify, runtime review, theme classes, theme review, or full review.',
      'Use build_extension_ui kind=api_usage, notify, theme_classes, runtime_review, theme_review, or review instead of hand-writing those contracts from memory.',
      'Extension validation rejects common field controls without class="w-full" unless intentionally marked data-compact or data-inline.',
      'PermissionGate renders the permitted slot directly and is UX-only; backend permissions and owner checks remain authoritative.',
      'For menu/account-panel notifications, use counts only when the signal source already owns an exact count; otherwise use a dot/chip for new attention.',
      'Do not fetch destination domain lists solely to decorate the shell; destination pages own domain fetching after click.',
      'Unrestricted menu permission is null, not {}. Empty permission objects are normalized to null by ensure_menu.',
    ],
  };
}
