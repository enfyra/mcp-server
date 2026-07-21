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

const AUTO_INJECTED_EXTENSION_COMPONENT_TAGS = [
  'CommonDrawer',
  'CommonModal',
  'EmptyState',
  'FormEditor',
  'FormEditorLazy',
  'NuxtLink',
  'PermissionGate',
  'UBadge',
  'UButton',
  'UCheckbox',
  'UDropdownMenu',
  'UForm',
  'UFormField',
  'UIcon',
  'UInput',
  'UInputMenu',
  'UInputNumber',
  'UInputTags',
  'UInputTime',
  'UInputDate',
  'UModal',
  'USelect',
  'USelectMenu',
  'USkeleton',
  'USwitch',
  'UTabs',
  'UTextarea',
  'UTooltip',
  'Widget',
];

export const AUTO_INJECTED_EXTENSION_COMPONENT_BY_LOWERCASE = new Map(
  AUTO_INJECTED_EXTENSION_COMPONENT_TAGS.map((tag) => [tag.toLowerCase(), tag]),
);

export const FULL_WIDTH_EXTENSION_FIELD_TAGS = [
  'UInput',
  'UTextarea',
  'USelect',
  'USelectMenu',
  'UInputMenu',
  'UInputNumber',
  'UInputTags',
  'UInputTime',
  'UInputDate',
];

const FULL_WIDTH_EXTENSION_FIELD_PATTERN = new RegExp(`<(${FULL_WIDTH_EXTENSION_FIELD_TAGS.join('|')})(\\s[^<>]*?)(\\/?)>`, 'g');

function escapeSingleQuoted(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function quoteJsString(value) {
  return `'${escapeSingleQuoted(value)}'`;
}

function normalizeVueBodySnippet(body) {
  let code = String(body || '').trim();
  const changes: string[] = [];
  code = code.replace(FULL_WIDTH_EXTENSION_FIELD_PATTERN, (full, tag, attrs, slash) => {
    if (/\bdata-compact\b/.test(attrs) || /\bdata-inline\b/.test(attrs)) return full;
    if (/\bclass=/.test(attrs)) {
      const nextAttrs = attrs.replace(/class="([^"]*)"/, (classMatch, classes) => {
        if (String(classes).split(/\s+/).includes('w-full')) return classMatch;
        changes.push(`Added w-full to ${tag}.`);
        return `class="${classes} w-full"`;
      });
      if (nextAttrs !== attrs) return `<${tag}${nextAttrs}${slash}>`;
      return full;
    }
    changes.push(`Added class="w-full" to ${tag}.`);
    return `<${tag} class="w-full"${attrs}${slash}>`;
  });
  code = code.replace(/<button(\s[^>]*)?>/g, (full, attrs = '') => {
    if (/\btype=/.test(attrs)) return full;
    changes.push('Added type="button" to a native button.');
    return `<button type="button"${attrs}>`;
  });
  return { code, changes: Array.from(new Set(changes)) };
}

function findMissingFullWidthFieldControls(code) {
  const violations: Array<{ tag: string; snippet: string }> = [];
  for (const template of readTemplateBlocks(code)) {
    let match;
    FULL_WIDTH_EXTENSION_FIELD_PATTERN.lastIndex = 0;
    while ((match = FULL_WIDTH_EXTENSION_FIELD_PATTERN.exec(template))) {
      const [snippet, tag, attrs] = match;
      if (/\bdata-compact\b/.test(attrs) || /\bdata-inline\b/.test(attrs)) continue;
      const classMatch = attrs.match(/\bclass="([^"]*)"/);
      if (!classMatch || !classMatch[1].split(/\s+/).includes('w-full')) {
        violations.push({ tag, snippet: snippet.length > 160 ? `${snippet.slice(0, 157)}...` : snippet });
      }
    }
  }
  return violations;
}

function indentLines(code, spaces = 2) {
  const pad = ' '.repeat(spaces);
  return String(code || '')
    .split('\n')
    .map((line) => (line.trim() ? `${pad}${line}` : line))
    .join('\n');
}

function buildFooterActionObject(action) {
  if (!action) return null;
  if (typeof action === 'string') return action;
  const entries: string[] = [];
  if (action.labelExpression) entries.push(`label: ${action.labelExpression}`);
  else if (action.label) entries.push(`label: ${quoteJsString(action.label)}`);
  if (action.icon) entries.push(`icon: ${quoteJsString(action.icon)}`);
  if (action.loading) entries.push(`loading: ${action.loading}`);
  if (action.disabled) entries.push(`disabled: ${action.disabled}`);
  if (action.color) entries.push(`color: ${quoteJsString(action.color)}`);
  if (action.variant) entries.push(`variant: ${quoteJsString(action.variant)}`);
  if (action.tone) entries.push(`tone: ${quoteJsString(action.tone)}`);
  if (action.onClick) entries.push(`onClick: ${action.onClick}`);
  return `{ ${entries.join(', ')} }`;
}

function titleMarkup(title, titleExpression) {
  if (titleExpression) return `{{ ${titleExpression} }}`;
  return String(title || 'Untitled');
}

export function buildExtensionDrawerSnippet(input) {
  const normalized = normalizeVueBodySnippet(input.body || '');
  const titleContent = titleMarkup(input.title, input.titleExpression);
  const model = input.model || 'drawerOpen';
  const attrs = [
    `v-model="${model}"`,
    `direction="${input.direction || 'right'}"`,
  ];
  if (input.nested) attrs.push('nested');

  const cancelAction = input.cancelAction === false
    ? null
    : buildFooterActionObject(input.cancelAction || { label: 'Cancel', onClick: `() => (${model} = false)` });
  const primaryAction = buildFooterActionObject(input.primaryAction);
  const dangerAction = buildFooterActionObject(input.dangerAction);
  if (cancelAction) attrs.push(`:cancel-action="${cancelAction}"`);
  if (primaryAction) attrs.push(`:primary-action="${primaryAction}"`);
  if (dangerAction) attrs.push(`:danger-action="${dangerAction}"`);
  if (input.footerHint) attrs.push(`footer-hint="${escapeSingleQuoted(input.footerHint).replace(/"/g, '&quot;')}"`);

  const snippet = [
    '<CommonDrawer',
    ...attrs.map((attr) => `  ${attr}`),
    '>',
    '  <template #header>',
    `    <h2 class="text-lg font-semibold eapp-text-primary">${titleContent}</h2>`,
    '  </template>',
    '',
    '  <template #body>',
    indentLines(normalized.code, 4),
    '  </template>',
    '</CommonDrawer>',
  ].join('\n');

  const warnings: string[] = [];
  if (!primaryAction) warnings.push('Editing/create drawers usually need primaryAction for Save/Create.');
  return {
    action: 'extension_drawer_built',
    component: 'CommonDrawer',
    snippet,
    normalizedBodyChanges: normalized.changes,
    warnings,
    contract: [
      'Use #header and #body slots; do not use a title prop.',
      'Use primaryAction for Save/Create and dangerAction for destructive edit actions.',
      'Body form controls are normalized to class="w-full" unless intentionally compact.',
      'Native buttons in the body are normalized to type="button".',
    ],
  };
}

export function buildExtensionModalSnippet(input) {
  const normalized = normalizeVueBodySnippet(input.body || '');
  const titleContent = titleMarkup(input.title, input.titleExpression);
  const model = input.model || 'modalOpen';
  const tag = input.alias === 'UModal' ? 'UModal' : 'CommonModal';
  const attrs = [`v-model:open="${model}"`];
  const cancelAction = input.cancelAction === false
    ? null
    : buildFooterActionObject(input.cancelAction || { label: 'Cancel', onClick: `() => (${model} = false)` });
  const primaryAction = buildFooterActionObject(input.primaryAction);
  const dangerAction = buildFooterActionObject(input.dangerAction);
  if (cancelAction) attrs.push(`:cancel-action="${cancelAction}"`);
  if (primaryAction) attrs.push(`:primary-action="${primaryAction}"`);
  if (dangerAction) attrs.push(`:danger-action="${dangerAction}"`);
  if (input.footerHint) attrs.push(`footer-hint="${escapeSingleQuoted(input.footerHint).replace(/"/g, '&quot;')}"`);

  const snippet = [
    `<${tag}`,
    ...attrs.map((attr) => `  ${attr}`),
    '>',
    '  <template #header>',
    `    <h2 class="text-lg font-semibold eapp-text-primary">${titleContent}</h2>`,
    '  </template>',
    '',
    '  <template #body>',
    indentLines(normalized.code, 4),
    '  </template>',
    `</${tag}>`,
  ].join('\n');

  const warnings: string[] = [];
  if (!primaryAction && !dangerAction) warnings.push('Mutation or confirmation modals usually need primaryAction or dangerAction for the final action.');
  return {
    action: 'extension_modal_built',
    component: tag,
    snippet,
    normalizedBodyChanges: normalized.changes,
    warnings,
    contract: [
      'Use v-model:open and #header/#body slots; do not use a title prop.',
      'Use primaryAction for ordinary final actions and dangerAction for destructive confirmation.',
      'Body form controls are normalized to class="w-full" unless intentionally compact.',
      'Native buttons in the body are normalized to type="button".',
    ],
  };
}

function jsObjectLiteral(entries) {
  return `{ ${entries.filter(Boolean).join(', ')} }`;
}

function jsArrayLiteral(values) {
  return `[${(values || []).map(quoteJsString).join(', ')}]`;
}

function attrStaticOrBound(name, value, expression) {
  if (expression) return `:${name}="${expression}"`;
  if (value === undefined || value === null || value === '') return null;
  return `${name}="${String(value).replace(/"/g, '&quot;')}"`;
}

function buildHeaderActionLiteral(action) {
  const bareAssignment = String(action.onClick || '').match(/^\s*\(\s*\)\s*=>\s*\(?\s*([A-Za-z_$][\w$]*)\s*=(?!=)/);
  if (bareAssignment) {
    throw new Error(`Invalid header action onClick: assign ${bareAssignment[1]}.value inside script callbacks, or pass a handler name. Template ref auto-unwrapping does not apply in registry callbacks.`);
  }
  const entries = [
    action.id ? `id: ${quoteJsString(action.id)}` : null,
    action.label ? `label: ${quoteJsString(action.label)}` : null,
    action.icon ? `icon: ${quoteJsString(action.icon)}` : null,
    `color: ${quoteJsString(action.color || 'neutral')}`,
    `variant: ${quoteJsString(action.variant || 'outline')}`,
    action.loading ? `loading: ${action.loading}` : null,
    action.disabled ? `disabled: ${action.disabled}` : null,
    action.to ? `to: ${quoteJsString(action.to)}` : null,
    action.onClick ? `onClick: ${action.onClick}` : null,
    typeof action.order === 'number' ? `order: ${action.order}` : null,
    action.side ? `side: ${quoteJsString(action.side)}` : null,
  ];
  return jsObjectLiteral(entries);
}

export function buildExtensionPageShellSnippet(input) {
  const title = input.titleExpression || quoteJsString(input.title || 'Untitled');
  const headerEntries = [
    `title: ${title}`,
    input.description ? `description: ${quoteJsString(input.description)}` : null,
    input.leadingIcon ? `leadingIcon: ${quoteJsString(input.leadingIcon)}` : null,
    `gradient: ${quoteJsString(input.gradient || 'none')}`,
    `variant: ${quoteJsString(input.variant || 'minimal')}`,
  ];
  const actions = Array.isArray(input.headerActions) ? input.headerActions : [];
  const lines = [
    'const { registerPageHeader } = usePageHeaderRegistry();',
    `registerPageHeader(${jsObjectLiteral(headerEntries)});`,
  ];
  if (actions.length) {
    lines.push('const { register: registerHeaderActions } = useHeaderActionRegistry();');
    lines.push(`onMounted(() => {\n  registerHeaderActions([\n${actions.map((action) => `    ${buildHeaderActionLiteral(action)}`).join(',\n')}\n  ]);\n});`);
  }
  return {
    action: 'extension_page_shell_built',
    snippet: lines.join('\n'),
    contract: [
      'Use usePageHeaderRegistry so the app shell renders the page header.',
      'Use useHeaderActionRegistry for toolbar actions instead of rendering duplicate page headers or local top bars; register dynamic extension actions in onMounted after setup state exists.',
      'Use primary solid only for the main scope action; secondary actions default to neutral outline.',
    ],
  };
}

export function buildExtensionPermissionGateSnippet(input) {
  const normalized = normalizeVueBodySnippet(input.body || '<slot />');
  let condition;
  if (input.condition) {
    condition = input.condition;
  } else if (input.route) {
    const methods = Array.isArray(input.methods) && input.methods.length ? input.methods : ['GET'];
    condition = `{ or: [{ route: ${quoteJsString(input.route)}, methods: [${methods.map(quoteJsString).join(', ')}] }] }`;
  } else {
    condition = 'null';
  }
  const snippet = [
    `<PermissionGate :condition="${condition}">`,
    indentLines(normalized.code, 2),
    '</PermissionGate>',
  ].join('\n');
  return {
    action: 'extension_permission_gate_built',
    component: 'PermissionGate',
    snippet,
    normalizedBodyChanges: normalized.changes,
    warnings: condition === 'null' ? ['No condition/route was provided. PermissionGate with null condition permits the slot.'] : [],
    contract: [
      'PermissionGate is only operator UX; backend route permissions and owner checks remain authoritative.',
      'PermissionGate renders its slot directly and should not be used as a layout wrapper.',
    ],
  };
}

export function buildExtensionEmptyStateSnippet(input) {
  const action = input.action
    ? `\n  :action="${buildFooterActionObject(input.action)}"`
    : '';
  return {
    action: 'extension_empty_state_built',
    component: 'EmptyState',
    snippet: `<EmptyState\n  title="${String(input.title || 'No items found').replace(/"/g, '&quot;')}"\n  description="${String(input.description || '').replace(/"/g, '&quot;')}"\n  icon="${input.icon || 'lucide:inbox'}"\n  size="${input.size || 'sm'}"\n  variant="${input.variant || 'naked'}"${action}\n/>`,
    contract: [
      'Dynamic extensions expose the app empty-state component as EmptyState.',
      'Use variant="naked" inside framed panels/lists and outline/subtle for standalone framed empty surfaces.',
    ],
  };
}

export function buildExtensionResourceListSnippet(input) {
  const itemsExpression = input.itemsExpression || 'items';
  const itemName = input.itemName || 'item';
  const keyExpression = input.keyExpression || `${itemName}.id`;
  const titleExpression = input.titleExpression || `${itemName}.title || ${quoteJsString('Untitled')}`;
  const descriptionExpression = input.descriptionExpression || `${itemName}.description`;
  const iconExpression = input.iconExpression || quoteJsString(input.icon || 'lucide:file-text');
  const onClick = input.onClick ? `\n      :on-click="() => ${input.onClick}"` : '';
  const stats = input.statsExpression ? `\n      :stats="${input.statsExpression}"` : '';
  const actions = input.actionsExpression ? `\n      :actions="${input.actionsExpression}"` : '';
  const topBadge = input.topBadgeExpression ? `\n      :top-badge="${input.topBadgeExpression}"` : '';
  const itemsPerPageExpression = input.itemsPerPageExpression || '0';
  const pageModel = String(itemsPerPageExpression) !== '0'
    ? `\n  v-model:page="${input.pageExpression || 'page'}"`
    : '';
  const frame = [
    `<CommonResourceListFrame${pageModel}`,
    `  :loading="${input.loadingExpression || 'pending'}"`,
    `  :has-items="${itemsExpression}.length > 0"`,
    `  :total="${input.totalExpression || `${itemsExpression}.length`}"`,
    `  :items-per-page="${itemsPerPageExpression}"`,
    `  empty-title="${String(input.emptyTitle || 'No items found').replace(/"/g, '&quot;')}"`,
    `  empty-description="${String(input.emptyDescription || '').replace(/"/g, '&quot;')}"`,
    `  empty-icon="${input.emptyIcon || 'lucide:inbox'}"`,
    '>',
    `  <CommonResourceListItem`,
    `    v-for="${itemName} in ${itemsExpression}"`,
    `    :key="${keyExpression}"`,
    `    :title="${titleExpression}"`,
    `    :description="${descriptionExpression}"`,
    `    :icon="${iconExpression}"`,
    '    icon-color="primary"',
    `${stats}${actions}${topBadge}${onClick}`,
    '  />',
    '</CommonResourceListFrame>',
  ].join('\n');
  const snippet = input.constrained === false
    ? frame
    : ['<section class="eapp-page-constrained-wide space-y-4">', indentLines(frame, 2), '</section>'].join('\n');
  return {
    action: 'extension_resource_list_built',
    components: ['CommonResourceListFrame', 'CommonResourceListItem'],
    snippet,
    contract: [
      'Use CommonResourceListFrame and CommonResourceListItem for operational lists instead of ad hoc cards.',
      'CommonResourceListFrame supports extension default slots. It renders rows when loading is false and hasItems is true; inspect the source artifact, hasItems/items expressions, and API response shape before replacing it.',
      'Keep first-load skeleton, empty state, and pagination owned by the frame.',
      'Keep search and filter controls in a separate compact surface before the list; do not wrap filters and all rows in one oversized card.',
      'Keep operational list pages constrained with eapp-page-constrained-wide unless the workflow intentionally owns a full-bleed canvas.',
      'Use explicit bounded list data and natural pagination/search outside this snippet when the domain list can grow.',
    ],
  };
}

export function buildExtensionResourceGridSnippet(input) {
  const itemsExpression = input.itemsExpression || 'items';
  const itemName = input.itemName || 'item';
  const keyExpression = input.keyExpression || `${itemName}.id`;
  const defaultBody = [
    `<h2 class="font-semibold eapp-text-primary">{{ ${itemName}.title || 'Untitled' }}</h2>`,
    `<p v-if="${itemName}.description" class="text-sm eapp-text-secondary line-clamp-2">{{ ${itemName}.description }}</p>`,
  ].join('\n');
  const normalized = normalizeVueBodySnippet(input.cardBody || defaultBody);
  const frame = [
    '<CommonResourceListFrame',
    '  variant="plain"',
    `  :loading="${input.loadingExpression || 'pending'}"`,
    `  :has-items="${itemsExpression}.length > 0"`,
    `  :total="${input.totalExpression || `${itemsExpression}.length`}"`,
    `  :items-per-page="${input.itemsPerPageExpression || '0'}"`,
    `  empty-title="${String(input.emptyTitle || 'No items found').replace(/"/g, '&quot;')}"`,
    `  empty-description="${String(input.emptyDescription || '').replace(/"/g, '&quot;')}"`,
    `  empty-icon="${input.emptyIcon || 'lucide:inbox'}"`,
    '>',
    '  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">',
    `    <UCard v-for="${itemName} in ${itemsExpression}" :key="${keyExpression}" class="h-full eapp-surface-card eapp-radius-panel border eapp-divider">`,
    '      <div class="flex h-full flex-col gap-4">',
    indentLines(normalized.code, 8),
    '      </div>',
    '    </UCard>',
    '  </div>',
    '</CommonResourceListFrame>',
  ].join('\n');
  const constrained = input.constrained === false
    ? frame
    : ['<section class="eapp-page-constrained-wide space-y-4">', indentLines(frame, 2), '</section>'].join('\n');
  return {
    action: 'extension_resource_grid_built',
    component: 'CommonResourceListFrame',
    snippet: constrained,
    normalizedBodyChanges: normalized.changes,
    contract: [
      'Use this card grid for dashboard/workboard/catalog collections; use resource_list for dense operational rows.',
      'The default desktop layout uses three columns only at xl because the admin sidebar consumes viewport width.',
      'Keep the page constrained unless the workflow intentionally owns a canvas or other full-bleed surface.',
      'Keep card actions inside cardBody and align them with flex layout rather than floating them at the viewport edge.',
    ],
  };
}

export function buildExtensionFormEditorSnippet(input) {
  const tag = input.lazy === false ? 'FormEditor' : 'FormEditorLazy';
  const attrs = [
    `v-model="${input.model || 'form'}"`,
    `v-model:errors="${input.errors || 'errors'}"`,
    attrStaticOrBound('table-name', input.tableName, input.tableNameExpression),
    input.mode ? `mode="${input.mode}"` : null,
    input.loadingExpression ? `:loading="${input.loadingExpression}"` : null,
    input.layout ? `layout="${input.layout}"` : null,
    input.includes?.length ? `:includes="${jsArrayLiteral(input.includes)}"` : null,
    input.excluded?.length ? `:excluded="${jsArrayLiteral(input.excluded)}"` : null,
    input.sectionsExpression ? `:sections="${input.sectionsExpression}"` : null,
    input.fieldMapExpression ? `:field-map="${input.fieldMapExpression}"` : null,
    input.virtualFieldsExpression ? `:virtual-fields="${input.virtualFieldsExpression}"` : null,
    input.currentRecordIdExpression ? `:current-record-id="${input.currentRecordIdExpression}"` : null,
    input.hasChangedHandler ? `@has-changed="${input.hasChangedHandler}"` : null,
    input.virtualFieldEmitHandler ? `@virtual-field-emit="${input.virtualFieldEmitHandler}"` : null,
  ].filter(Boolean);
  const snippet = [
    `<${tag}`,
    ...attrs.map((attr) => `  ${attr}`),
    '/>',
  ].join('\n');
  return {
    action: 'extension_form_editor_built',
    component: tag,
    snippet,
    contract: [
      'Prefer FormEditor/FormEditorLazy for direct table-backed forms instead of hand-built UInput/UTextarea fields.',
      'Use v-model for record state and v-model:errors for validation errors.',
      'Use includes/sections to keep generated forms focused; do not expose compiledCode or unrelated system fields.',
      'Use fieldMap only for behavior/renderer overrides such as code fields or custom labels.',
    ],
  };
}

export function buildExtensionWidgetSnippet(input) {
  const attrs = [`:id="${typeof input.id === 'number' ? input.id : quoteJsString(input.id)}"`];
  for (const [key, value] of Object.entries(input.props || {})) {
    attrs.push(`:${key}="${value}"`);
  }
  for (const [event, handler] of Object.entries(input.events || {})) {
    attrs.push(`@${event}="${handler}"`);
  }
  return {
    action: 'extension_widget_built',
    component: 'Widget',
    snippet: `<Widget ${attrs.join(' ')} />`,
    warnings: typeof input.id === 'number' ? [] : ['Widget ids should be numeric enfyra_extension ids; do not pass extension name or extensionId string.'],
    contract: [
      'Widget :id is the numeric enfyra_extension id, not name or extensionId.',
      'Pass safe props/events; keep page-level mutation and modal ownership in the page unless the widget intentionally owns the full workflow.',
    ],
  };
}

export function buildExtensionMenuNotificationSnippet(input) {
  const targetEntries = [
    input.targetId !== undefined ? `id: ${quoteJsString(input.targetId)}` : null,
    input.path ? `path: ${quoteJsString(input.path)}` : null,
    input.route ? `route: ${quoteJsString(input.route)}` : null,
  ];
  const entries = [
    `id: ${quoteJsString(input.id || 'extension-menu-notification')}`,
    `target: ${jsObjectLiteral(targetEntries)}`,
    input.valueExpression ? `value: ${input.valueExpression}` : input.value !== undefined ? `value: ${quoteJsString(input.value)}` : null,
    `color: ${quoteJsString(input.color || 'primary')}`,
    input.title ? `title: ${quoteJsString(input.title)}` : null,
    typeof input.order === 'number' ? `order: ${input.order}` : null,
  ];
  return {
    action: 'extension_menu_notification_built',
    snippet: [
      'const { register: registerMenuNotification } = useMenuNotificationRegistry();',
      `registerMenuNotification(${jsObjectLiteral(entries)});`,
    ].join('\n'),
    contract: [
      'Use count/value only when the signal source already owns an exact or bounded count.',
      'Omit value for a dot-only notification when realtime only proves new attention exists.',
      'Do not fetch destination domain lists solely to decorate the menu.',
    ],
  };
}

export function buildExtensionAccountPanelSnippet(input) {
  const entries = [
    `id: ${quoteJsString(input.id || 'extension-account-panel-item')}`,
    typeof input.order === 'number' ? `order: ${input.order}` : null,
    input.label ? `label: ${quoteJsString(input.label)}` : null,
    input.description ? `description: ${quoteJsString(input.description)}` : null,
    input.icon ? `icon: ${quoteJsString(input.icon)}` : null,
    input.countExpression ? `count: ${input.countExpression}` : input.count !== undefined ? `count: ${quoteJsString(input.count)}` : null,
    input.badgeExpression ? `badge: ${input.badgeExpression}` : input.badge !== undefined ? `badge: ${quoteJsString(input.badge)}` : null,
    input.badgeColor ? `badgeColor: ${quoteJsString(input.badgeColor)}` : null,
    input.trailingIcon ? `trailingIcon: ${quoteJsString(input.trailingIcon)}` : null,
    input.expandedExpression ? `expanded: ${input.expandedExpression}` : null,
    input.contentComponent ? `contentComponent: ${input.contentComponent}` : null,
    input.contentPropsExpression ? `contentProps: ${input.contentPropsExpression}` : null,
    input.onClick ? `onClick: ${input.onClick}` : null,
    input.onToggle ? `onToggle: ${input.onToggle}` : null,
  ];
  return {
    action: 'extension_account_panel_item_built',
    snippet: [
      'const { register: registerAccountPanelItem } = useAccountPanelRegistry();',
      `registerAccountPanelItem(${jsObjectLiteral(entries)});`,
    ].join('\n'),
    contract: [
      'Prefer data-driven account panel rows over fully custom row components.',
      'Use count for notification-style chips; count takes precedence over badge.',
      'Use onClick for direct actions and onToggle/contentComponent for expandable inline UI.',
    ],
  };
}

export function buildExtensionTabsSnippet(input) {
  const model = input.model || 'activeTab';
  const items = input.itemsExpression || 'tabs';
  const body = input.body || '<div>{{ item.label }}</div>';
  const snippet = [
    `<UTabs v-model="${model}" :items="${items}" class="w-full">`,
    '  <template #content="{ item }">',
    indentLines(normalizeVueBodySnippet(body).code, 4),
    '  </template>',
    '</UTabs>',
  ].join('\n');
  return {
    action: 'extension_tabs_built',
    component: 'UTabs',
    snippet,
    contract: [
      'Use app-level UTabs chrome instead of custom tab bars.',
      'Do not add local full-width bottom borders/dividers to tab lists.',
      'Keep tab items data-driven and render panel content through #content.',
    ],
  };
}

export function buildExtensionUploadModalSnippet(input) {
  const model = input.model || 'showUploadModal';
  const attrs = [
    `v-model="${model}"`,
    `title="${String(input.title || 'Upload Files').replace(/"/g, '&quot;')}"`,
    `accept="${input.accept || '*/*'}"`,
    input.multiple !== false ? ':multiple="true"' : ':multiple="false"',
    input.maxSizeExpression ? `:max-size="${input.maxSizeExpression}"` : ':max-size="10 * 1024 * 1024"',
    input.loadingExpression ? `:loading="${input.loadingExpression}"` : null,
    input.uploadProgressExpression ? `:upload-progress="${input.uploadProgressExpression}"` : null,
    input.fileProgressExpression ? `:file-progress="${input.fileProgressExpression}"` : null,
    input.dragText ? `drag-text="${String(input.dragText).replace(/"/g, '&quot;')}"` : null,
    input.acceptText ? `accept-text="${String(input.acceptText).replace(/"/g, '&quot;')}"` : null,
    input.uploadText ? `upload-text="${String(input.uploadText).replace(/"/g, '&quot;')}"` : null,
    input.uploadingText ? `uploading-text="${String(input.uploadingText).replace(/"/g, '&quot;')}"` : null,
    `@upload="${input.uploadHandler || 'handleUpload'}"`,
    input.errorHandler ? `@error="${input.errorHandler}"` : null,
  ].filter(Boolean);
  const headerContent = input.headerContent ? [
    '>',
    '  <template #header-content>',
    indentLines(normalizeVueBodySnippet(input.headerContent).code, 4),
    '  </template>',
    '</CommonUploadModal>',
  ] : ['/>'];
  return {
    action: 'extension_upload_modal_built',
    component: 'CommonUploadModal',
    snippet: [
      '<CommonUploadModal',
      ...attrs.map((attr) => `  ${attr}`),
      ...headerContent,
    ].join('\n'),
    companionSnippet: [
      'const {',
      '  uploadProgress,',
      '  trackedUploadProgressById,',
      '  beginTrackedUploadProgress,',
      '  getUploadProgressHeaders,',
      '  resetUploadProgress,',
      '} = useFileUploadProgress();',
    ].join('\n'),
    contract: [
      'Use useFileUploadProgress for admin-socket upload progress.',
      'Send x-enfyra-upload-id via getUploadProgressHeaders(id) for each uploaded file.',
      'For multi-file uploads, call the useApi batch files path once, pass per-file headers through headersByIndex, and map each upload id to fileProgress[index].',
      'CommonUploadModal owns selected-file rows and per-row progress chrome.',
    ],
  };
}
