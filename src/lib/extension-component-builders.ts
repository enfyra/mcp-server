
const AUTO_INJECTED_EXTENSION_COMPONENT_TAGS = [
  'CommonDrawer',
  'CommonModal',
  'DataTable',
  'EmptyState',
  'FormEditor',
  'FormEditorLazy',
  'NuxtLink',
  'PermissionGate',
  'TabbedPanel',
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
    action.loading ? (/\.value\b/.test(String(action.loading)) ? `get loading() { return ${action.loading}; }` : `loading: ${action.loading}`) : null,
    action.disabled ? (/\.value\b/.test(String(action.disabled)) ? `get disabled() { return ${action.disabled}; }` : `disabled: ${action.disabled}`) : null,
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
      'The native shell owns inset geometry, fixed headers, scrolling and a centered 80rem content container. Use eapp-page-constrained (1000px) or eapp-page-constrained-wide (1200px) only for a narrower centered body; do not add root page padding or a duplicate outer card.',
      'Use useHeaderActionRegistry for toolbar actions instead of rendering duplicate page headers or local top bars; register dynamic extension actions in onMounted after setup state exists.',
      'Place page-form Save/Reset actions in the shell header and target the active editable tab; keep drawer/modal mutation actions in their managed footer.',
      'Pass refs/computed values for loading and disabled, or reactive expressions containing .value; the builder emits getters for expressions so header state does not freeze at registration.',
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
  const cursor = input.paginationMode === 'cursor';
  const paginationBindings = cursor ? [
    `  :page="${pageExpression}"`,
    `  :pagination-config="{ mode: 'cursor', itemsPerPage: ${itemsPerPageExpression}, showPageSize: true, loading: ${input.loadingExpression || 'pending'}, hasNextPage: ${input.hasNextPageExpression || 'hasNextPage'} }"`,
    `  @update:page="${input.pageChangeExpression || 'setPage'}"`,
    `  @page-size-change="${input.pageSizeChangeExpression || 'setPageSize'}"`,
  ] : [
    `  v-model:page="${pageExpression}"`,
    `  :pagination-config="{ total: ${totalExpression}, itemsPerPage: ${itemsPerPageExpression}, showPageSize: true, loading: ${input.loadingExpression || 'pending'} }"`,
    `  @page-size-change="${input.pageSizeChangeExpression || `${itemsPerPageExpression} = $event; ${pageExpression} = 1`}"`,
  ];
  const rowClick = input.rowClickExpression ? `  @row-click="${input.rowClickExpression}"` : '';
  const searchToolbar = input.searchExpression ? [
    '  <template #toolbar>',
    `    <form class="w-full min-w-0 sm:w-96" @submit.prevent="${input.searchSubmitExpression || 'applySearch'}">`,
    '      <UFieldGroup class="w-full">',
    `        <UInput v-model="${input.searchExpression}" icon="lucide:search" size="sm" :ui="{ base: 'h-7 py-1' }" class="w-full min-w-0 flex-1" placeholder="${String(input.searchPlaceholder || 'Search records').replace(/"/g, '&quot;')}" aria-label="${String(input.searchLabel || 'Search records').replace(/"/g, '&quot;')}" />`,
    `        <UButton type="submit" size="sm" color="neutral" variant="outline" :loading="${input.loadingExpression || 'pending'}">Search</UButton>`,
    '      </UFieldGroup>',
    '    </form>',
    '  </template>',
  ] : [];
  const table = [
    '<DataTable',
    `  :data="${itemsExpression}"`,
    `  :columns="${input.columnsExpression || 'columns'}"`,
    `  :loading="${input.loadingExpression || 'pending'}"`,
    ...(paginated ? paginationBindings : []),
    ...(rowClick ? [rowClick] : []),
    '>',
    ...searchToolbar,
    '  <template #empty>',
    '    <EmptyState',
    `      title="${String(input.emptyTitle || 'No items found').replace(/"/g, '&quot;')}"`,
    `      description="${String(input.emptyDescription || '').replace(/"/g, '&quot;')}"`,
    `      icon="${input.emptyIcon || 'lucide:inbox'}"`,
    '      variant="naked"',
    '      size="sm"',
    '    />',
    '  </template>',
    '</DataTable>',
  ].join('\n');
  const snippet = input.constrained === false
    ? table
    : ['<section class="eapp-page-constrained-wide space-y-4">', indentLines(table, 2), '</section>'].join('\n');
  return {
    action: 'extension_resource_list_built',
    components: ['DataTable', 'EmptyState', ...(input.searchExpression ? ['UFieldGroup', 'UInput', 'UButton'] : [])],
    snippet,
    contract: [
      'Lists of records with information fields must use DataTable, not raw UTable, HTML tables, repeated cards, or CommonResourceListItem rows. Review/save with uiPattern="resource_list".',
      'Define columns with accessorKey/id and header; size ID, status, date/count, and action columns explicitly, and leave descriptive columns flexible. Numeric IDs use 88px; long string IDs use 224px with ellipsis.',
      'Bind data, columns, and loading for every request. DataTable owns native UTable loading through header progress, with no default row skeletons and no empty message while pending. Keep existing rows mounted during same-dataset refreshes; hide stale rows when changing datasets.',
      'Columns visibility defaults to enabled for extensions and /data. Only built-in Settings tables explicitly disable showColumnVisibility.',
      'Fetch one bounded server page with explicit display fields and ID. Bind page/pageSize to the API query, reset page to 1 when filters or pageSize change, and use meta.filterCount for filtered totals or meta.totalCount for unfiltered totals. Do not add client pagination to a server page.',
      'Use DataTable paginationConfig and @page-size-change for the shared footer; never copy pagination/selector CSS into extensions. Offset uses v-model:page. Cursor uses :page and @update:page with hasNextPage/loading; the handler selects the requested page cursor, replaces rows and commits page only after a successful response. Save visited cursors for Previous and fetch one extra row to determine Next availability. Reset cursor history on filters or page-size changes. Both control modes occupy the same footer position: centered on mobile and right-aligned on desktop. The main footer stays in-flow; offset mode retains its mini pager by default, and cursor mode has the same scoped mini pager on mobile. Mini controls stay left/range right on one line. Set paginationConfig.floating=false to disable it. Raw UPagination outside DataTable keeps Nuxt UI defaults. Both modes retain 10/20/50/100 page sizes; the caller owns query/cursor state and stable-key persistence. Use itemsPerPageExpression=0 only for known bounded non-paginated data.',
      'Show status as a badge; put Enable/Disable and destructive actions in a row ellipsis menu using named cell slots such as #actions-cell with row.original. row-click emits the original record.',
      'The shell centers and constrains every page. Use eapp-page-constrained-wide for an optional narrower list; keep search/filter controls compact and avoid a second border around DataTable.',
      'A single-dataset toolbar starts with a bounded search group on the left; native Columns stays on the right. Do not repeat the shell title and instruction paragraph next to search. Use size=sm for input and Search button to match Columns, keep widths responsive, and submit on Enter. Pass searchExpression/searchSubmitExpression/searchPlaceholder/searchLabel for this scaffold; callers own the query and first-page reset.',
      'The app input base is 44px even with size=sm. Compact table search uses its native ui.base slot (h-7 py-1) to match the 28px Columns button; preserve all theme-owned border/background/focus styling and do not change page-form field geometry.',
      'A distinct dataset title is useful when a page has multiple tables. Put long guidance in the page description, concise scope/count in the shared footer or dataset toolbar, and complex filters in one eapp-bordered-region outside the table. Avoid arbitrary height, alignment or padding overrides on the native toolbar.',
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
    `    <UCard v-for="${itemName} in ${itemsExpression}" :key="${keyExpression}" class="h-full">`,
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
      'Keep the grid within the centered shell content; use eapp-page-constrained-wide for a narrower workboard.',
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
      'Centered standalone page forms use one neutral border with the app radius and the default content background against the neutral workspace. Use eapp-form-region for a custom page form; inside TabbedPanel, drawers and modals keep forms flat rather than nesting another card.',
      'Register page-form Save/Reset in useHeaderActionRegistry for the active tab; drawer/modal forms use their managed footer actions.',
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
  if (input.placement === 'secondary') {
    const snippet = [
      `<UTabs v-model="${model}" :items="${items}" variant="pill" color="primary" data-secondary-navigation`,
      '  :unmount-on-hide="false"',
      ...(input.content === false ? ['  :content="false"'] : []),
      ...(input.content === false ? ['/>' ] : ['>', '  <template #content="{ item }">', indentLines(normalizeVueBodySnippet(body).code, 4), '  </template>', '</UTabs>']),
    ].join('\n');
    return {
      action: 'extension_tabs_built',
      component: 'UTabs',
      snippet,
      contract: [
        'Secondary navigation belongs in the content body: native pill UTabs use a neutral rounded tray, a solid primary active surface and theme-owned on-primary text/icon contrast.',
        'Keep native keyboard, indicator measurement, and panel context. When the caller owns panels, set content=false and retain its visibility/draft ownership.',
        'eApp owns pill chrome globally through app.config.ts: do not generate ui/style overrides for tab colors, radius, indicators, focus, or spacing. Extensions only choose native variant/color and own their state and content.',
      ],
    };
  }
  const snippet = [
    `<TabbedPanel v-model="${model}" :items="${items}" class="w-full">`,
    '  <template #content="{ item }">',
    indentLines(normalizeVueBodySnippet(body).code, 4),
    '  </template>',
    '</TabbedPanel>',
  ].join('\n');
  return {
    action: 'extension_tabs_built',
    component: 'TabbedPanel',
    snippet,
    contract: [
      'TabbedPanel is the registered app-owned wrapper around native UTabs with one neutral frame and a muted header containing the tab strip.',
      'The panel owns gutters, the divider aligned with the active indicator, and the app radius; do not copy tab CSS or add another card/border around its content.',
      'Keep tab items data-driven and render panel content through #content.',
      'Hidden tab panels stay mounted by default to preserve drafts. Bind the selected tab to the URL query in the caller when navigation state must survive reloads.',
      'For secondary navigation in the content body, call this builder with placement=secondary. It generates native pill UTabs with a neutral rounded tray, a solid theme-primary active surface and on-primary text/icons instead of another framed TabbedPanel.',
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
