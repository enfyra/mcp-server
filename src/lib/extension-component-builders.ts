
const AUTO_INJECTED_EXTENSION_COMPONENT_TAGS = [
  'CommonDrawer',
  'CommonModal',
  'DataTable',
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
  const pageExpression = input.pageExpression || 'page';
  const totalExpression = input.totalExpression || 'total';
  const itemsPerPageExpression = input.itemsPerPageExpression ?? 'pageSize';
  const paginated = String(itemsPerPageExpression) !== '0';
  const rowClick = input.rowClickExpression ? `  @row-click="${input.rowClickExpression}"` : '';
  const table = [
    '<DataTable',
    `  :data="${itemsExpression}"`,
    `  :columns="${input.columnsExpression || 'columns'}"`,
    `  :loading="${input.loadingExpression || 'pending'}"`,
    ...(rowClick ? [rowClick] : []),
    '>',
    '  <template #empty>',
    '    <EmptyState',
    `      title="${String(input.emptyTitle || 'No items found').replace(/"/g, '&quot;')}"`,
    `      description="${String(input.emptyDescription || '').replace(/"/g, '&quot;')}"`,
    `      icon="${input.emptyIcon || 'lucide:inbox'}"`,
    '      variant="naked"',
    '      size="sm"',
    '    />',
    '  </template>',
    ...(paginated ? [
      '  <template #footer>',
      '    <div class="grid grid-cols-2 items-center gap-x-2 gap-y-3 sm:flex sm:flex-wrap sm:justify-between sm:gap-3">',
      `      <span class="whitespace-nowrap text-xs tabular-nums eapp-text-secondary">{{ ${totalExpression} > 0 ? Math.min((${pageExpression} - 1) * ${itemsPerPageExpression} + 1, ${totalExpression}) : 0 }}–{{ Math.min(${pageExpression} * ${itemsPerPageExpression}, ${totalExpression}) }} / {{ ${totalExpression} }}</span>`,
      '      <label class="flex items-center justify-end gap-2 whitespace-nowrap text-xs eapp-text-secondary sm:ml-auto">',
      '        Rows per page',
      `        <USelect v-model="${itemsPerPageExpression}" :items="[10, 20, 50, 100]" size="sm" class="w-18" data-compact aria-label="Rows per page" />`,
      '      </label>',
      '      <UPagination',
      `        v-model:page="${pageExpression}"`,
      `        :total="${totalExpression}"`,
      `        :items-per-page="${itemsPerPageExpression}"`,
      '        size="sm"',
      '        :ui="{ root: \'!w-full col-span-2 justify-self-end border-t eapp-divider pt-3 sm:!w-auto sm:col-auto sm:border-0 sm:pt-0\', list: \'flex-nowrap justify-end\', first: \'max-md:!hidden\', last: \'max-md:!hidden\' }"',
      '      />',
      '    </div>',
      '  </template>',
    ] : []),
    '</DataTable>',
  ].join('\n');
  const snippet = input.constrained === false
    ? table
    : ['<section class="eapp-page-constrained-wide space-y-4">', indentLines(table, 2), '</section>'].join('\n');
  return {
    action: 'extension_resource_list_built',
    components: ['DataTable', 'EmptyState', ...(paginated ? ['USelect', 'UPagination'] : [])],
    snippet,
    contract: [
      'Lists of records with information fields must use DataTable, not raw UTable, HTML tables, repeated cards, or CommonResourceListItem rows. Review/save with uiPattern="resource_list".',
      'Define columns with accessorKey/id and header; size ID, status, date/count, and action columns explicitly, and leave descriptive columns flexible. Numeric IDs use 88px; long string IDs use 224px with ellipsis.',
      'Bind data, columns, and loading. DataTable owns first-load skeletons, the empty slot, and native horizontal scrolling; keep existing rows mounted during refresh.',
      'Columns visibility defaults to enabled for extensions and /data. Only built-in Settings tables explicitly disable showColumnVisibility.',
      'Fetch one bounded server page with explicit display fields and ID. Bind page/pageSize to the API query, reset page to 1 when filters or pageSize change, and use meta.filterCount for filtered totals or meta.totalCount for unfiltered totals. Do not add client pagination to a server page.',
      'Keep rows-per-page, range, and UPagination inside DataTable #footer; persist bounded 10/20/50/100 choices per list with one stable semantic key. The caller owns setup refs, persistence, and query wiring; use itemsPerPageExpression=0 only for a known bounded non-paginated dataset.',
      'Show status as a badge; put Enable/Disable and destructive actions in a row ellipsis menu using named cell slots such as #actions-cell with row.original. row-click emits the original record.',
      'Keep search/filter controls in a separate compact surface and constrain list pages with eapp-page-constrained-wide unless the extension intentionally owns a full-bleed canvas.',
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
      'Use this card grid only for genuine visual dashboards/workboards/catalogs, not information lists; record lists must use the resource_list DataTable builder.',
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
      'Use a widget extension as the decomposition boundary for an independent page section or repeated panel that should be reviewed, enabled, and maintained separately.',
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
