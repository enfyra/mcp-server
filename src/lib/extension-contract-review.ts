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
  escapeRegExp,
  readTemplateBlocks,
} from './platform-extension-source.js';
import {
  AnyRecord,
} from './platform-shared-operations.js';

export function reviewExtensionUiContract(code, options: AnyRecord = {}) {
  const source = String(code || '');
  const pattern = String(options.pattern || 'auto');
  const issues: Array<{ severity: 'error' | 'warning'; rule: string; message: string; suggestion: string }> = [];
  const push = (severity, rule, message, suggestion) => issues.push({ severity, rule, message, suggestion });
  const analysis = analyzeExtensionSfc(source);
  const elements = analysis.elements;
  const byTag = (tag: string) => elements.filter((element) => element.tag === tag);
  const hasStaticOrBound = (element, name: string) => (
    extensionElementHasAttribute(element, name, null) || extensionElementHasAttribute(element, name, 'bind')
  );
  const drawers = byTag('CommonDrawer');
  const modals = [...byTag('CommonModal'), ...byTag('UModal')];
  const allClasses = new Set(elements.flatMap((element) => element.classes));

  if (!analysis.valid) {
    push('error', 'vue-sfc-parse', `Vue SFC parsing failed: ${analysis.errors[0]}`, 'Fix the malformed SFC/template before reviewing UI policy.');
  }
  if (drawers.some((element) => hasStaticOrBound(element, 'title'))) {
    push('error', 'common-drawer-slots', 'CommonDrawer should not use title/:title props in generated extensions.', 'Use #header with a heading, and #body for content.');
  }
  if (modals.some((element) => hasStaticOrBound(element, 'title'))) {
    push('error', 'common-modal-slots', 'CommonModal/UModal should not use title/:title props in generated extensions.', 'Use #header with a heading, and #body for content.');
  }
  if (drawers.some((element) => !hasStaticOrBound(element, 'primary-action') && !hasStaticOrBound(element, 'primaryAction'))) {
    push('warning', 'drawer-primary-action', 'CommonDrawer has no primaryAction.', 'Editing/create drawers should wire Save/Create through primaryAction.');
  }
  if (drawers.some((element) => !hasStaticOrBound(element, 'cancel-action') && !hasStaticOrBound(element, 'cancelAction'))) {
    push('warning', 'drawer-cancel-action', 'CommonDrawer has no cancelAction.', 'Use cancelAction for the ordinary Cancel footer button unless the workflow intentionally has no cancel.');
  }
  if (modals.some((element) => /delete|remove|confirm|cannot be undone/i.test(element.text) && !hasStaticOrBound(element, 'danger-action') && !hasStaticOrBound(element, 'dangerAction'))) {
    push('warning', 'modal-danger-action', 'Destructive/confirmation modal has no dangerAction.', 'Wire the final destructive action through dangerAction.');
  }
  for (const element of elements.filter((item) => ['UInput', 'UTextarea', 'USelectMenu', 'USelect'].includes(item.tag))) {
    const intentionallyCompact = extensionElementHasAttribute(element, 'data-compact', null)
      || extensionElementHasAttribute(element, 'data-inline', null);
    if (!intentionallyCompact && !element.classes.includes('w-full')) {
      push('warning', 'modal-drawer-field-width', `${element.tag} is missing class="w-full".`, 'Use class="w-full" for form controls inside modal/drawer body forms unless intentionally inline.');
    }
  }
  for (const element of byTag('button')) {
    if (!hasStaticOrBound(element, 'type')) {
      push('warning', 'native-button-type', 'Native button is missing type="button".', 'Add type="button" unless the button intentionally submits a form.');
    }
  }

  if (pattern === 'resource_list') {
    const frames = byTag('CommonResourceListFrame');
    if (frames.length === 0) {
      push('error', 'resource-list-frame-required', 'Operational resource lists must use CommonResourceListFrame.', 'Use build_extension_ui kind=resource_list so loading, empty state, total, and pagination stay list-owned.');
    }
    if (byTag('CommonResourceListItem').length === 0) {
      push('error', 'resource-list-item-required', 'Operational resource rows must use CommonResourceListItem.', 'Move title, description, badge, stats, metadata, navigation, and row actions into CommonResourceListItem.');
    }
    if (elements.some((element) => ['UCard', 'article'].includes(element.tag) && extensionElementHasAttribute(element, 'for', 'for'))) {
      push('error', 'resource-list-ad-hoc-cards', 'A resource-list screen still renders inventory rows as repeated cards.', 'Use CommonResourceListItem for homogeneous operational rows; reserve resource_grid for workboards and catalogs.');
    }
    if (elements.some((element) => ['table', 'UTable'].includes(element.tag))) {
      push('error', 'resource-list-ad-hoc-table', 'A resource-list screen still renders its primary inventory as a table.', 'Use CommonResourceListItem so row metadata and actions remain responsive on narrow screens.');
    }
    const frame = frames[0];
    if (frame && !hasStaticOrBound(frame, 'loading')) {
      push('error', 'resource-list-loading-owned', 'CommonResourceListFrame is missing its loading contract.', 'Bind :loading to the first-load state.');
    }
    if (frame && !hasStaticOrBound(frame, 'has-items') && !hasStaticOrBound(frame, 'hasItems')) {
      push('error', 'resource-list-empty-owned', 'CommonResourceListFrame is missing its has-items contract.', 'Bind :has-items and keep the empty state owned by the frame.');
    }
    if (frame && !hasStaticOrBound(frame, 'empty-title') && !hasStaticOrBound(frame, 'emptyTitle')) {
      push('error', 'resource-list-empty-copy', 'CommonResourceListFrame is missing an empty-state title.', 'Provide concise empty-title and, when useful, empty-description and empty-icon.');
    }
    const itemsPerPage = frame
      ? extensionElementAttributeValue(frame, 'items-per-page', 'bind') ?? extensionElementAttributeValue(frame, 'itemsPerPage', 'bind')
      : null;
    if (itemsPerPage && itemsPerPage !== '0' && !extensionElementHasAttribute(frame, 'page', 'model')) {
      push('error', 'resource-list-pagination-owned', 'A paginated CommonResourceListFrame is missing its page model.', 'Bind v-model:page on the frame so pagination state stays list-owned.');
    }
    if (!allClasses.has('eapp-page-constrained-wide')) {
      push('warning', 'resource-list-width', 'The operational list is not constrained for wide admin viewports.', 'Wrap the page inventory in eapp-page-constrained-wide unless this extension intentionally owns a full-bleed canvas.');
    }
    const frameIndex = frame ? elements.indexOf(frame) : elements.length;
    const beforeFrame = elements.slice(0, frameIndex);
    const hasSearchOrFilterControl = beforeFrame.some((element) => (
      ['UInput', 'UInputMenu', 'USelect', 'USelectMenu'].includes(element.tag)
      && element.attributes.some((attribute) => /search|filter/i.test(`${attribute.name} ${attribute.value || ''}`))
    ));
    const hasFilterSurface = beforeFrame.some((element) => element.classes.some((name) => ['eapp-surface-card', 'eapp-surface-muted'].includes(name)));
    if (hasSearchOrFilterControl && !hasFilterSurface) {
      push('warning', 'resource-list-filter-surface', 'Search or filter controls are not in a separate compact surface before the list.', 'Place controls in a compact eapp-surface-card or eapp-surface-muted block, separate from CommonResourceListFrame.');
    }
  }

  if (pattern === 'resource_grid') {
    const frame = byTag('CommonResourceListFrame')[0];
    if (!frame || extensionElementAttributeValue(frame, 'variant', null) !== 'plain') {
      push('error', 'resource-grid-frame', 'Resource grids must use CommonResourceListFrame variant="plain".', 'Use build_extension_ui kind=resource_grid so loading and empty state remain list-owned without duplicate contained chrome.');
    }
    if (!allClasses.has('md:grid-cols-2') || !allClasses.has('xl:grid-cols-3')) {
      push('error', 'resource-grid-breakpoints', 'Resource grids must use the admin-shell one/two/three-column breakpoints.', 'Use one column by default, md:grid-cols-2, and xl:grid-cols-3.');
    }
    if (!allClasses.has('eapp-page-constrained-wide')) {
      push('warning', 'resource-grid-width', 'The resource grid is not constrained for the admin shell.', 'Keep eapp-page-constrained-wide unless the workflow intentionally owns a full-bleed canvas.');
    }
  }

  if (pattern === 'auto'
    && elements.some((element) => ['UCard', 'article'].includes(element.tag) && extensionElementHasAttribute(element, 'for', 'for'))
    && byTag('CommonResourceListFrame').length === 0) {
    push('warning', 'ad-hoc-inventory', 'Repeated cards were found without a shared list frame.', 'Choose resource_list for dense operational rows or resource_grid for a workboard/catalog, then use the matching builder contract.');
  }

  if (byTag('UButton').some((element) => hasStaticOrBound(element, 'disabled') && /Already|Completed|Granted|Handled/i.test(element.text))) {
    push('warning', 'disabled-terminal-action', 'A terminal state appears as a disabled action button.', 'Render terminal state as a badge or metadata and omit the unavailable action.');
  }
  return {
    action: 'extension_ui_contract_reviewed',
    pattern,
    valid: issues.every((issue) => issue.severity !== 'error'),
    issueCount: issues.length,
    issues,
    nextSteps: issues.length
      ? [pattern === 'resource_list' || pattern === 'resource_grid'
        ? `Use build_extension_ui kind=${pattern} for the canonical layout, then apply with patch_extension_code/update_extension_code.`
        : 'Use the matching build_extension_ui contract, then apply with patch_extension_code/update_extension_code.']
      : ['Snippet matches the checked modal/drawer contract rules. Still validate the final SFC before saving.'],
  };
}

function collectExtensionRuntimeIssues(code) {
  const source = String(code || '');
  const issues: Array<{ severity: 'error' | 'warning'; rule: string; message: string; suggestion: string }> = [];
  const push = (severity, rule, message, suggestion) => issues.push({ severity, rule, message, suggestion });
  const analysis = analyzeExtensionSfc(source);

  if (/(?:^|[>\n;])\s*import(?:\s.+?\sfrom\s+|\s*['"])/m.test(source)) {
    push('error', 'static-import', 'Static import statements are not allowed in enfyra_extension.code.', 'Use injected globals/components directly, or load app packages with getPackages(["package-name"]) inside runtime code.');
  }
  if (/\buseToast\s*\(/.test(source)) {
    push('error', 'use-toast-directly', 'Dynamic extensions should not call useToast() directly.', 'Use useNotify() and call success/error/warning/info(title, description?).');
  }
  if (/\b(?:window|globalThis)\.(?:confirm|alert|prompt)\s*\(/.test(source) || /(^|[^.\w])(?:alert|prompt)\s*\(/m.test(source)) {
    push('error', 'browser-dialog', 'Dynamic extensions must not use browser alert/confirm/prompt dialogs.', 'For ordinary destructive confirmation call build_extension_ui kind=confirm and use useConfirm(); use CommonModal only for richer confirmation content.');
  }
  if (/\buseNotify\s*\(\s*\)\s*\.add\s*\(/.test(source) || /\b\w+\s*\.add\s*\(\s*\{\s*title\s*:/.test(source)) {
    push('error', 'use-notify-add', 'useNotify() does not accept Nuxt toast object payloads through add().', 'Call notify.success/error/warning/info(title, description?) instead.');
  }
  if (/\b(?:query|body|filter|deep|aggregate)\s*:\s*JSON\.stringify\s*\(/.test(source)) {
    push('error', 'use-api-json-stringify-options', 'useApi query/body/filter/deep/aggregate options must be plain objects or computed objects, not JSON strings.', 'Pass the object directly to useApi or execute().');
  }
  if (analysis.elements.some((element) => (
    ['CommonModal', 'UModal'].includes(element.tag)
    && extensionElementHasAttribute(element, 'model', 'model')
  ))) {
    push('error', 'modal-open-model', 'CommonModal/UModal must bind v-model:open, not the default v-model contract.', 'Call build_extension_ui kind=modal and preserve its v-model:open binding.');
  }
  if (analysis.elements.some((element) => element.tag === 'CommonEmptyState')) {
    push('error', 'unavailable-common-empty-state', 'CommonEmptyState is not registered in the dynamic extension runtime.', 'Use the injected EmptyState alias or build_extension_ui kind=empty_state/resource_list/resource_grid.');
  }
  const scriptBlocks = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  const scriptSource = scriptBlocks.length ? scriptBlocks.join('\n') : (/<template\b/i.test(source) ? '' : source);
  const refNames = new Set(
    [...scriptSource.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|shallowRef)\s*\(/g)].map((match) => match[1]),
  );
  const bareRefActionPattern = /\bonClick\s*:\s*\(\s*\)\s*=>\s*\(?\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  let bareRefActionMatch;
  while ((bareRefActionMatch = bareRefActionPattern.exec(scriptSource))) {
    const refName = bareRefActionMatch[1];
    if (refNames.has(refName)) {
      push('error', 'script-ref-assignment', `Script callback tries to reassign const ref ${refName}.`, `Assign ${refName}.value or call a handler; template ref auto-unwrapping does not apply inside registry/action callbacks.`);
    }
  }
  const executeAliasPattern = /\bexecute\s*:\s*([A-Za-z_$][\w$]*)/g;
  let executeAliasMatch;
  while ((executeAliasMatch = executeAliasPattern.exec(source))) {
    const executeAlias = executeAliasMatch[1];
    const references = source.match(new RegExp(`\\b${escapeRegExp(executeAlias)}\\b`, 'g'))?.length || 0;
    if (references === 1) {
      push('error', 'use-api-unused-execute', `useApi execute alias ${executeAlias} is never used.`, `Call or reference ${executeAlias} from onMounted, a watcher, or a user action; for read builders keep autoLoad enabled.`);
    }
  }
  if (/\buseApi\s*\(/.test(source) && !/\bexecute\s*:/.test(source) && !/\brefresh\s*:/.test(source) && !/\.\s*(?:execute|refresh)\s*\(/.test(source)) {
    push('warning', 'use-api-no-execute-alias', 'useApi() appears without an execute/refresh alias or call.', 'Call useApi() as a top-level setup composable, then call or await execute()/refresh() from onMounted, watchers, or user actions when the request should run.');
  }
  if (/\buseNotify\s*\(/.test(source) && !/\bnotify\.(?:success|error|warning|info)\s*\(/.test(source) && !/\b(?:success|error|warning|info)\s*:\s*\w+/.test(source)) {
    push('warning', 'use-notify-no-helper-call', 'useNotify() appears without a success/error/warning/info helper call.', 'Use the semantic helper methods instead of low-level toast payloads.');
  }
  return issues;
}

export function reviewExtensionRuntimeContract(code) {
  const issues = collectExtensionRuntimeIssues(code);
  return {
    action: 'extension_runtime_contract_reviewed',
    valid: issues.every((issue) => issue.severity !== 'error'),
    issueCount: issues.length,
    issues,
    nextSteps: issues.length
      ? ['Use build_extension_ui kind=api_usage or kind=notify for known-good snippets, then patch/update the extension.']
      : ['Snippet matches the checked runtime composable/package rules. Still validate the final SFC before saving.'],
  };
}
