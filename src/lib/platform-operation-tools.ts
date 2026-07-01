// @ts-nocheck
import { z } from 'zod';

import { fetchAPI } from './fetch.js';
import { validateScriptSourceIfPresent } from './mutation-guards.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAck,
  assertGlobalRulesAck,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';

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
const AUTO_INJECTED_EXTENSION_COMPONENT_BY_LOWERCASE = new Map(
  AUTO_INJECTED_EXTENSION_COMPONENT_TAGS.map((tag) => [tag.toLowerCase(), tag]),
);

function unwrapData(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

function getId(record) {
  return record?.id ?? record?._id ?? null;
}

function refId(value) {
  return typeof value === 'object' && value !== null ? getId(value) : value;
}

function sameId(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function firstDataRecord(result) {
  return Array.isArray(result?.data) ? result.data[0] : result;
}

function normalizeRestPath(path) {
  if (!path) return '/';
  if (/^https?:\/\//i.test(path)) {
    throw new Error('Only Enfyra API paths are allowed, not full external URLs.');
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeMethodName(method) {
  const value = String(method || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid method "${method}". Method names must start with A-Z and contain only A-Z, 0-9, or underscore.`);
  }
  return value;
}

function methodNamesFromRecords(records, methodIdNameMap) {
  return (records || [])
    .map((method) => method?.name || methodIdNameMap[String(getId(method))] || null)
    .filter(Boolean)
    .map(normalizeMethodName);
}

function uniqueMethodNames(names) {
  return [...new Set((names || []).map(normalizeMethodName))];
}

function resolveMethodRefs(methodMap, names) {
  return uniqueMethodNames(names).map((name) => {
    const id = methodMap[name];
    if (!id) throw new Error(`Unknown method "${name}". Valid methods: ${Object.keys(methodMap).sort().join(', ')}`);
    return { id };
  });
}

function mergeMethods(existing, requested, mode) {
  const existingNames = uniqueMethodNames(existing);
  const requestedNames = uniqueMethodNames(requested);
  if (mode === 'replace') return requestedNames;
  if (mode === 'remove') return existingNames.filter((method) => !requestedNames.includes(method));
  return uniqueMethodNames([...existingNames, ...requestedNames]);
}

async function fetchAll(apiUrl, path) {
  return unwrapData(await fetchAPI(apiUrl, path));
}

async function getMethodContext(apiUrl) {
  const methods = await fetchAll(apiUrl, '/enfyra_method?limit=0&fields=id,_id,name');
  const methodMap = {};
  const methodIdNameMap = {};
  for (const method of methods) {
    if (!method?.name) continue;
    const name = normalizeMethodName(method.name);
    const id = getId(method);
    methodMap[name] = id;
    methodIdNameMap[String(id)] = name;
  }
  return { methods, methodMap, methodIdNameMap };
}

async function reloadRoutes(apiUrl) {
  try {
    const result = await fetchAPI(apiUrl, '/admin/reload/routes', { method: 'POST' });
    return { attempted: true, succeeded: true, result };
  } catch (error) {
    return { attempted: true, succeeded: false, error: error?.message || String(error) };
  }
}

async function resolveRoute(apiUrl, { path, routeId }) {
  if (!path && !routeId) throw new Error('Provide path or routeId.');
  if (path && routeId) throw new Error('Provide path or routeId, not both.');
  const routes = await fetchAll(apiUrl, '/enfyra_route?limit=1000&fields=id,_id,path,isEnabled,availableMethods.*,publicMethods.*,mainTable.name');
  const normalizedPath = path ? normalizeRestPath(path) : null;
  const route = routes.find((item) => (routeId ? sameId(getId(item), routeId) : item.path === normalizedPath));
  if (!route) throw new Error(`Route not found: ${routeId || normalizedPath}`);
  return { route, routes, path: route.path };
}

async function updateRouteMethods(apiUrl, { path, routeId, methods, mode, isEnabled, globalRulesAckKey }) {
  assertGlobalRulesAck(globalRulesAckKey);
  const [{ route }, { methodMap, methodIdNameMap }] = await Promise.all([
    resolveRoute(apiUrl, { path, routeId }),
    getMethodContext(apiUrl),
  ]);
  const existingAvailable = methodNamesFromRecords(route.availableMethods, methodIdNameMap);
  const existingPublic = methodNamesFromRecords(route.publicMethods, methodIdNameMap);
  const finalAvailable = mergeMethods(existingAvailable, methods, mode);
  const finalPublic = existingPublic.filter((method) => finalAvailable.includes(method));
  const body = {
    availableMethods: resolveMethodRefs(methodMap, finalAvailable),
    publicMethods: resolveMethodRefs(methodMap, finalPublic),
  };
  if (isEnabled !== undefined) body.isEnabled = isEnabled;

  const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const routeReload = await reloadRoutes(apiUrl);
  return {
    action: 'route_methods_updated',
    route: { id: getId(route), path: route.path },
    before: { availableMethods: existingAvailable, publicMethods: existingPublic },
    after: { availableMethods: finalAvailable, publicMethods: finalPublic },
    result,
    routeReload,
  };
}

async function updateRoutePublicMethods(apiUrl, { path, routeId, methods, mode, globalRulesAckKey }) {
  assertGlobalRulesAck(globalRulesAckKey);
  const [{ route }, { methodMap, methodIdNameMap }] = await Promise.all([
    resolveRoute(apiUrl, { path, routeId }),
    getMethodContext(apiUrl),
  ]);
  const availableMethods = methodNamesFromRecords(route.availableMethods, methodIdNameMap);
  const existingPublic = methodNamesFromRecords(route.publicMethods, methodIdNameMap);
  const requestedMethods = uniqueMethodNames(methods);
  const unavailable = requestedMethods.filter((method) => !availableMethods.includes(method));
  if (unavailable.length > 0) {
    throw new Error(`Cannot make unavailable route method(s) public: ${unavailable.join(', ')}. First call add_route_methods to add them to availableMethods.`);
  }
  const finalPublic = mergeMethods(existingPublic, requestedMethods, mode);
  const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, {
    method: 'PATCH',
    body: JSON.stringify({ publicMethods: resolveMethodRefs(methodMap, finalPublic) }),
  });
  const routeReload = await reloadRoutes(apiUrl);
  return {
    action: 'route_public_methods_updated',
    route: { id: getId(route), path: route.path },
    availableMethods,
    publicMethodsBefore: existingPublic,
    publicMethodsAfter: finalPublic,
    publicAccess: finalPublic.length > 0 ? 'Methods listed in publicMethods bypass auth/RoleGuard.' : 'No public methods remain on this route.',
    result,
    routeReload,
  };
}

async function setRouteEnabled(apiUrl, { path, routeId, isEnabled, globalRulesAckKey }) {
  assertGlobalRulesAck(globalRulesAckKey);
  const { route } = await resolveRoute(apiUrl, { path, routeId });
  const before = route?.isEnabled !== false;
  if (before === isEnabled) {
    return {
      action: isEnabled ? 'route_already_enabled' : 'route_already_disabled',
      route: { id: getId(route), path: route.path },
      before: { isEnabled: before },
      after: { isEnabled },
      runtimeBehavior: isEnabled ? 'Enabled routes are registered at runtime.' : 'Disabled routes are not registered at runtime and return 404.',
      routeReload: { attempted: false, succeeded: true, reason: 'No route lifecycle change was needed.' },
    };
  }

  const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, {
    method: 'PATCH',
    body: JSON.stringify({ isEnabled }),
  });
  const routeReload = await reloadRoutes(apiUrl);
  return {
    action: isEnabled ? 'route_enabled' : 'route_disabled',
    route: { id: getId(route), path: route.path },
    before: { isEnabled: before },
    after: { isEnabled },
    runtimeBehavior: isEnabled ? 'The route should now be registered at runtime.' : 'The route should now return 404 because disabled routes are not registered at runtime.',
    result,
    routeReload,
  };
}

async function fetchRouteDependencies(apiUrl, routeId) {
  const routeFilter = filterQuery({ route: { id: { _eq: routeId } } });
  const routeIdFilter = filterQuery({ routeId: { _eq: routeId } });
  const [handlers, permissions, preHooks, postHooks, guards] = await Promise.all([
    fetchAll(apiUrl, `/enfyra_route_handler?filter=${routeIdFilter}&fields=id,_id,routeId,method.name&limit=0`),
    fetchAll(apiUrl, `/enfyra_route_permission?filter=${routeFilter}&fields=id,_id,route.id,role.name,isEnabled&limit=0`),
    fetchAll(apiUrl, `/enfyra_pre_hook?filter=${routeFilter}&fields=id,_id,route.id,name,isEnabled&limit=0`),
    fetchAll(apiUrl, `/enfyra_post_hook?filter=${routeFilter}&fields=id,_id,route.id,name,isEnabled&limit=0`),
    fetchAll(apiUrl, `/enfyra_guard?filter=${routeFilter}&fields=id,_id,route.id,name,isEnabled&limit=0`),
  ]);
  return { handlers, permissions, preHooks, postHooks, guards };
}

function summarizeRouteDependencies(dependencies) {
  return {
    handlers: dependencies.handlers.map((item) => ({ id: getId(item), method: item?.method?.name || null })),
    permissions: dependencies.permissions.map((item) => ({ id: getId(item), role: item?.role?.name || null, isEnabled: item?.isEnabled !== false })),
    preHooks: dependencies.preHooks.map((item) => ({ id: getId(item), name: item?.name || null, isEnabled: item?.isEnabled !== false })),
    postHooks: dependencies.postHooks.map((item) => ({ id: getId(item), name: item?.name || null, isEnabled: item?.isEnabled !== false })),
    guards: dependencies.guards.map((item) => ({ id: getId(item), name: item?.name || null, isEnabled: item?.isEnabled !== false })),
  };
}

async function deleteRows(apiUrl, tableName, rows) {
  const deleted = [];
  for (const row of rows) {
    const id = getId(row);
    if (id === null || id === undefined) continue;
    await fetchAPI(apiUrl, `/${tableName}/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
    deleted.push(id);
  }
  return deleted;
}

async function deleteRoute(apiUrl, { path, routeId, expectedPath, confirm, globalRulesAckKey }) {
  const { route } = await resolveRoute(apiUrl, { path, routeId });
  if (expectedPath && route.path !== normalizeRestPath(expectedPath)) {
    throw new Error(`Route path mismatch: resolved ${route.path}, expected ${normalizeRestPath(expectedPath)}.`);
  }

  const dependencies = await fetchRouteDependencies(apiUrl, getId(route));
  const dependencySummary = summarizeRouteDependencies(dependencies);
  const preview = {
    route: { id: getId(route), path: route.path, isEnabled: route?.isEnabled !== false },
    dependencies: dependencySummary,
  };

  if (!confirm) {
    return {
      action: 'delete_route_preview',
      ...preview,
      next: 'Call delete_route again with confirm=true and expectedPath set to this route path to delete the route and related handlers/hooks/permissions/guards.',
    };
  }
  assertGlobalRulesAck(globalRulesAckKey);

  await deleteRows(apiUrl, 'enfyra_route_handler', dependencies.handlers);
  await deleteRows(apiUrl, 'enfyra_pre_hook', dependencies.preHooks);
  await deleteRows(apiUrl, 'enfyra_post_hook', dependencies.postHooks);
  await deleteRows(apiUrl, 'enfyra_guard', dependencies.guards);
  await deleteRows(apiUrl, 'enfyra_route_permission', dependencies.permissions);
  const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, { method: 'DELETE' });
  const routeReload = await reloadRoutes(apiUrl);

  return {
    action: 'route_deleted',
    ...preview,
    deleted: {
      handlers: dependencies.handlers.map(getId).filter((id) => id !== null && id !== undefined),
      permissions: dependencies.permissions.map(getId).filter((id) => id !== null && id !== undefined),
      preHooks: dependencies.preHooks.map(getId).filter((id) => id !== null && id !== undefined),
      postHooks: dependencies.postHooks.map(getId).filter((id) => id !== null && id !== undefined),
      guards: dependencies.guards.map(getId).filter((id) => id !== null && id !== undefined),
      route: getId(route),
    },
    result,
    routeReload,
  };
}

async function findHandler(apiUrl, routeId, methodId) {
  const filter = encodeURIComponent(JSON.stringify({
    route: { id: { _eq: routeId } },
    method: { id: { _eq: methodId } },
  }));
  const result = await fetchAPI(apiUrl, `/enfyra_route_handler?filter=${filter}&limit=1&fields=id,_id,route.id,method.id,method.name,sourceCode,scriptLanguage,timeout`);
  return unwrapData(result)[0] || null;
}

function jsonText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function getExtensionThemeContract() {
  return {
    action: 'extension_theme_contract',
    useBefore: [
      'Call this before writing or reviewing Enfyra admin page, widget, or global extension UI.',
      'Then call validate_extension_code or an ensure_*_extension tool before saving.',
    ],
    layout: [
      'The extension is already mounted inside the Enfyra app shell. Do not add a duplicate page header, centered page wrapper, or root-level page padding.',
      'Page extensions should be full-bleed, responsive, and split large operations into focused pages or UTabs.',
      'Use usePageHeaderRegistry for the shell title and useHeaderActionRegistry/useSubHeaderActionRegistry for page actions.',
      'Use useMenuNotificationRegistry from global extensions to register sidebar menu notification counts or dots. Register stable ids, target menus by id/path/route, use value for counts, omit value for a dot, and choose color from primary/success/warning/error/info/neutral.',
      'For shell menu notifications, first decide the signal source. Use a count only when the source already owns an exact count, such as a notification summary endpoint or bounded unread-notification query. Use a dot when a realtime event only proves that something new exists. Do not poll a domain list such as messages, tickets, orders, or jobs solely to decorate the menu; the destination page owns domain fetching.',
      'Use useAccountPanelRegistry for account panel rows. AccountPanelItem supports count as the preferred numeric/text badge value, badge as a legacy alias, and badgeColor primary/neutral/info/error/warning/success.',
      'For detail/form workflows that should stay left-aligned with empty space on the right, wrap the body in eapp-page-constrained; use eapp-page-constrained-wide only when the workflow genuinely needs more width.',
      'Card/list grids inside the default shell must account for the 280px desktop sidebar. Do not switch general card grids to three columns at lg; use md:grid-cols-2 xl:grid-cols-3 unless a local container proves three columns have enough width.',
    ],
    theme: [
      'Use eApp theme class tokens, not hardcoded light/dark colors and not raw CSS variables inside extension templates. The app owns the CSS variable implementation; generated extensions should choose class tokens by intent.',
      'Primary color is runtime-configurable through the app color picker and must affect extension identity UI. For Nuxt UI components, choose color="primary" by semantic intent and let the app map it through the primary contract; do not choose a concrete palette. For custom extension UI, first choose whether the element is neutral surface, runtime-primary identity, or status. Regular panels, KPI cards, list rows, and large content blocks should use eapp-surface-card, eapp-surface-muted, eapp-surface-flat, eapp-surface-hover, eapp-divide-y, and eapp-text-* classes. Entity identity, selected/current state, active progress, primary tiles, primary icons, and primary CTA fills should use eapp-primary-surface, eapp-primary-soft, eapp-primary-subtle, eapp-primary-solid, eapp-primary-text, eapp-primary-border, or eapp-primary-ring so the color picker controls them.',
      'Use eapp-primary-surface only for larger entity/feature blocks, selected/current cards, tiles, or cards that should read like normal app cards with a very subtle active-primary tint; it supplies selected identity color but does not replace card chrome, so keep normal border/radius classes such as border plus eapp-radius-panel on the element. It is not a saturated selected-state fill and must not be applied broadly to every KPI/list wrapper. Add eapp-primary-surface-hover when that block is clickable. Use eapp-primary-soft for compact selected entity chips, pills, square icon tiles using eapp-icon-tile, and identity callouts; add eapp-primary-soft-hover when compact surfaces are clickable; use eapp-primary-subtle for a slightly stronger selected fill; use eapp-primary-solid only for primary identity fills; use eapp-primary-text for identity icons or inline text. eapp-identity-* remains an alias for the same runtime-primary intent, but eapp-primary-* is preferred in new extension code.',
      'Nuxt UI secondary is still a valid semantic color when the product intentionally wants a secondary action or state. Do not use color="secondary", from-secondary-*, bg-secondary-*, text-secondary-*, or cyan/purple/green palette utilities merely to approximate an entity accent; use eapp-primary-* and let the app decide the color.',
      'The app runs on Tailwind v4. Short Tailwind color utilities are the canonical way to apply contract colors and ARE allowed: bg-primary, text-primary, border-primary, ring-primary, bg-success, text-error, etc., including opacity modifiers (bg-primary/10, ring-success/20) which v4 resolves via color-mix. They are generated from the token-backed config (primary -> --md-primary runtime, success/error/warning/info -> --st-* status, secondary -> --md-tertiary) so they follow the color picker and dark theme. Do NOT use raw CSS-variable utilities (text-[var(--*)], bg-[var(--*)], border-[var(--*)]), hardcoded hex, inline style colors, or concrete palette substitution (color="violet", from-cyan-*, text-violet-*, bg-green-*, bg-emerald-*, text-green-*, dark:bg-zinc-950). For intent surfaces with no Tailwind equivalent (selected identity block, soft/solid/subtle surface, divider, radius, modal chrome) use the eapp-* classes below; the app owns how they map to the active color picker value.',
      'Use UButton color="primary" only for the single main action for the current scope. Refresh, back, navigation, filters, and secondary actions should be neutral variants unless they are the main mutation.',
      'PageHeader gradient must be "none" for generated operational extensions unless the user explicitly asks for a decorative page accent. Do not hardcode cyan, violet, purple, blue, or green PageHeader gradients to force color variety.',
      'Do not inject global CSS, create theme guards, redefine the app palette, or solve one extension by overriding the whole app shell.',
      'For panels/cards, prefer eapp-surface-card, eapp-surface-hover, eapp-surface-muted, eapp-surface-flat, and eapp-divide-y. Use eapp-text-primary, eapp-text-secondary, eapp-text-tertiary, or eapp-text-quaternary for copy.',
      'Never use Nuxt UI neutral semantic classes such as bg-default, bg-muted, border-default, divide-default, text-muted, text-dimmed, or hardcoded dark palettes such as dark:bg-zinc-950, bg-slate-*, text-gray-*, border-black, or black.',
      'Never use bare border/divide-y for panels or rows: pair borders with eapp-divider or use eapp-divide-y for row separators.',
      'Use radius tokens or mapped rounded utilities consistently: --radius-card for cards, --radius-panel for nested panels, --radius-control for buttons/inputs, --radius-subcontrol for compact inner controls, and --radius-pill for pills.',
      'Status colors must remain readable in both themes and must stay scoped to badges, small icons, or short status text. Use UBadge/UAlert semantic colors or eapp-status-success-soft/text/border, eapp-status-warning-soft/text/border, eapp-status-danger-soft/text/border, eapp-status-info-soft/text/border, and eapp-status-neutral-soft/text/border. Do not read --badge-* variables directly from extension templates. Do not color large panels, alert-like success blocks, KPI cards, list containers, or reconciliation/attention blocks green/yellow/red because the status is good/warning/error; use neutral app surfaces for the block and place a small status badge/icon inside.',
      'Keep dark and light contrast comparable. Do not make dark mode more neon or lower-contrast than light mode; prefer muted soft backgrounds with clear text and visible borders.',
    ],
    decisionCases: [
      {
        intent: 'Normal accent, decorative icon, feature icon, non-state tile, active tab fill, progress fill, selected segment, primary metric accent, or primary action.',
        colorContract: 'Use runtime primary so the app color picker controls the color.',
        use: 'UButton/UBadge color="primary", eapp-primary-soft, eapp-primary-subtle, eapp-primary-solid, eapp-primary-text, or eapp-primary-surface when the whole block is selected/current identity.',
        avoid: 'Do not pick cyan, purple, green, amber, secondary, or concrete Tailwind palettes just because they look good.',
      },
      {
        intent: 'True semantic state: error, danger, destructive, warning, pending attention, success, healthy, running, failed, info, or notice.',
        colorContract: 'Use the matching state/status color because the color communicates meaning, not brand identity.',
        use: 'UAlert/UBadge color="error|warning|success|info|neutral", or eapp-status-success|warning|danger|info|neutral soft/text/border classes for custom compact status chips/icons.',
        avoid: 'Do not force semantic state UI to primary; an error must stay error, a warning must stay warning, success can stay success when it is a badge/icon/short status.',
      },
      {
        intent: 'Large ordinary surface: KPI card, list container, table panel, detail panel, summary block, empty state panel, reconciliation block, or attention block.',
        colorContract: 'Use neutral app surfaces first; large surfaces should not become state-colored or arbitrary accent-colored.',
        use: 'eapp-surface-card, eapp-surface-hover, eapp-surface-muted, eapp-surface-flat, eapp-divide-y, and eapp-text-* classes.',
        avoid: 'Do not color large blocks green/yellow/red because their content says healthy/warning/error; place a status badge/icon inside the neutral block instead.',
      },
      {
        intent: 'Selected/current entity or user-selected option where the whole block is the active identity.',
        colorContract: 'Use runtime primary identity surface, but subtly.',
        use: 'eapp-primary-surface plus optional eapp-primary-surface-hover; eapp-primary-soft/text for the icon or chip inside.',
        avoid: 'Do not use eapp-primary-surface for every card in a grid/list or as a broad page background.',
      },
    ],
    components: [
      'Use Nuxt UI/eApp components for normal controls: UButton, UInput, UTextarea, USelectMenu/USelect, USwitch, UCheckbox, UTabs, UBadge, UModal, and CommonDrawer when available.',
      'Use auto-injected components directly in the template with PascalCase names. Do not call resolveComponent() to manually resolve Nuxt UI/eApp components inside extension SFCs; it can compile but render unresolved lowercase DOM tags such as <ubutton>.',
      'Buttons should have stable geometry: hover may change color, border, or shadow but must not move the button or resize its content. Disabled buttons keep disabled cursor/visual state.',
      'Inputs and textareas should not add hover movement or decorative hover states; focus, invalid, disabled, and loading states must be explicit.',
      'Dynamic extensions resolve UModal to the app CommonModal. Do not pass ui.content: "eapp-surface-card" or "surface-card" to UModal/CommonModal; modal content uses the app modal surface and caller ui.content should only append z-index, width, or max-width classes.',
      'CommonModal and CommonDrawer own action-only footers through cancelAction, primaryAction, dangerAction, leadingActions, and footerHint. Pass footer button intent through those props instead of custom footer slots. cancelAction defaults to neutral outline; use dangerAction for irreversible destructive work and tone: "primary" for Keep editing in discard dialogs.',
      'Use custom #footer content only when the footer contains real custom layout or non-button content. Every modal/drawer button should use type="button" unless it intentionally submits a form.',
      'Use CommonDrawer for side-panel editing. Open drawers immediately on user action and render loading/error/content inside the drawer instead of waiting for fetch before opening.',
      'Use UTabs for page sections and large grouped forms instead of custom tab bars; the app-level Nuxt UI override owns active and inactive indicators, focus rings, spacing, and theme contrast.',
      'Use UBadge or token-backed badge spans for status. Keep badges legible in both themes with tokenized background, text, and border.',
      'Use shell registries for shell badges: useAccountPanelRegistry for the account panel and useMenuNotificationRegistry for sidebar menus. Do not draw detached fixed-position badges over the app shell.',
    ],
    loadingAndLists: [
      'For first load of card/list pages, render calm skeleton cards with a slow pulse. Use USkeleton or shared loading components so the app-owned skeleton theme controls contrast and accent matching. For subsequent pagination/filter refreshes, keep the card shells mounted and skeletonize card content until the new list is ready.',
      'Keep pagination inside the same transition/loading branch as the list. Do not show pagination before the list content has left loading.',
      'Use bounded pagination for operational lists. Do not replace pagination with arbitrary fixed caps such as 30 or 50.',
      'Empty states should use an app-matched card surface with compact icon tile, title, and description; do not use huge blank white panels or naked UEmpty chrome on page surfaces.',
    ],
    interaction: [
      'Every mutating button needs pending/disabled state, success/error feedback, and must close or update its modal when the operation completes.',
      'Do not refetch broad lists after selecting one row. Keep local selection state and fetch only the detail or mutation result needed.',
      'Customer-facing toasts must describe the operation. Do not surface raw job ids, flow ids, or worker ids.',
    ],
    security: [
      'Decide route permission, owner scope, and field exposure before writing UI or backend logic.',
      'UI checks are only guidance; handlers/hooks must independently enforce owner/root-admin authorization.',
      'Use the most specific business route or MCP tool. Do not write directly to raw tables when a domain route exists.',
    ],
    patternExamples: [
      {
        useWhen: 'Ordinary KPI, metric, or summary card where the whole card is not selected/current identity.',
        use: 'Neutral card surface; put runtime-primary only on a small identity icon tile, progress fill, or main CTA inside the card.',
        snippet: '<article class="eapp-surface-card p-4"><div class="flex items-start justify-between gap-3"><div><p class="text-sm eapp-text-tertiary">Metric</p><p class="mt-2 text-2xl font-semibold eapp-text-primary">{{ value }}</p></div><span class="eapp-primary-soft eapp-icon-tile"><UIcon name="lucide:square-stack" class="size-5 eapp-primary-text" /></span></div></article>',
      },
      {
        useWhen: 'Selected/current entity, active plan, chosen package, or the single block that represents the active identity.',
        use: 'eapp-primary-surface for the selected/current block, with eapp-primary-soft/text for compact icon parts.',
        snippet: '<article class="eapp-primary-surface eapp-primary-surface-hover eapp-radius-panel border p-4"><div class="flex items-center gap-3"><span class="eapp-primary-soft eapp-icon-tile"><UIcon name="lucide:box" class="size-5 eapp-primary-text" /></span><div><p class="font-semibold eapp-text-primary">{{ name }}</p><p class="text-sm eapp-text-tertiary">Currently selected</p></div></div></article>',
      },
      {
        useWhen: 'Progress, active tab indicator, selected segment fill, or primary visual meter.',
        use: 'Neutral track plus eapp-primary-solid fill so the app color picker controls the fill.',
        snippet: '<div class="h-1.5 overflow-hidden eapp-radius-pill eapp-surface-muted"><div class="eapp-primary-solid h-full" :style="{ width: progressWidth }"></div></div>',
      },
      {
        useWhen: 'Success, warning, error, info, healthy, running, failed, pending, or attention status.',
        use: 'UBadge/status badge tokens and optionally a small icon only. Keep large alert/panel/card backgrounds neutral unless the whole block is an identity block.',
        snippet: '<section class="eapp-surface-card p-4"><div class="flex items-center justify-between gap-3"><p class="font-semibold eapp-text-primary">Reconciliation</p><UBadge color="success" variant="soft">Healthy</UBadge></div><p class="mt-1 text-sm eapp-text-tertiary">Latest report found no mismatches.</p></section>',
      },
      {
        useWhen: 'List rows, table-like records, history rows, and secondary navigation rows.',
        use: 'Neutral row surface, tokenized dividers, hover surface-muted, with small status/identity chips inside.',
        snippet: '<div class="eapp-surface-card eapp-divide-y"><button class="flex w-full items-center justify-between px-4 py-3 text-left eapp-surface-hover"><span class="text-sm font-medium eapp-text-primary">{{ row.name }}</span><UBadge color="neutral" variant="soft">{{ row.state }}</UBadge></button></div>',
      },
      {
        useWhen: 'Primary action for the current scope, such as create/save/apply/open-current.',
        use: 'UButton color="primary" variant="solid"; secondary actions stay neutral.',
        snippet: '<div class="flex justify-end gap-2"><UButton color="neutral" variant="outline">Cancel</UButton><UButton color="primary" variant="solid" icon="lucide:save">Save</UButton></div>',
      },
    ],
    compactExample: '<template><section class="min-h-full w-full space-y-4"><article class="eapp-surface-card p-4"><div class="flex items-start justify-between gap-3"><div><p class="text-sm eapp-text-tertiary">Neutral KPI</p><p class="mt-2 text-2xl font-semibold eapp-text-primary">24</p></div><span class="eapp-primary-soft eapp-icon-tile"><UIcon name="lucide:square-stack" class="size-5 eapp-primary-text" /></span></div><div class="mt-3 h-1.5 overflow-hidden eapp-radius-pill eapp-surface-muted"><div class="eapp-primary-solid h-full w-1/2"></div></div></article><section class="eapp-surface-card p-4"><div class="flex items-center justify-between gap-3"><p class="font-semibold eapp-text-primary">Status block stays neutral</p><UBadge color="success" variant="soft">Healthy</UBadge></div></section></section></template>',
    shellNotificationContract: {
      menu: 'useMenuNotificationRegistry().register({ id, target: { id?, path?, route? }, value?, color?, title?, order? }). value renders a count/chip; omitting value renders a dot. Parent menus sum numeric child values.',
      accountPanel: 'useAccountPanelRegistry().register({ id, label, description, icon, count?, badge?, badgeColor?, expanded?, onToggle?, contentComponent? }). count is preferred over badge and the account trigger sums numeric visible item counts, capped at 99+.',
      lifecycle: 'Register from global extensions for app-wide notification state; stable ids replace previous registrations and component-owned registrations are removed on unmount.',
      reasoning: 'Counts and dots are different promises. A count says the shell knows an exact or bounded number from an appropriate notification/summary source. A dot says the shell only knows that new attention exists. Avoid fetching the destination domain list just to make a menu badge more precise.',
    },
    contractAuthority: [
      'This is the authoritative Enfyra theme & color contract. Source of truth: documents/app/theme-color-contract.md. The app owns color through app/utils/primary-colors.ts (Material You seed-to-role generation), app/assets/css/theme.css (semantic variables and Nuxt UI ramps), app/assets/css/main.css (extension-safe semantic utilities), and app/app.config.ts (Nuxt UI component mapping). Pages and extensions only CONSUME classes/Nuxt UI props; they never define colors.',
      'Every color flows from two base layers: --md-* (Material You, runtime primary picker) and --st-* (status). Runtime primary roles are generated with SchemeTonalSpot. Success/warning/info stay fixed status quarts; error follows the generated Material error role through the single --danger-* lane. All Nuxt UI semantic colors (primary/secondary/success/warning/error/info/neutral) are re-pointed to these, so Nuxt UI is used per its docs but colors are decided by Enfyra. This applies to the shell, system pages, and compiled dynamic extensions.',
      'Call get_theme_class_reference for the full class->variable->Nuxt UI table when you need the exact class name or variable.',
    ],
    classReference: {
      surfaces: ['eapp-surface-card (default card; --card-bg/--card-border)', 'eapp-surface-muted (recessed/track; --surface-muted)', 'eapp-surface-flat (flush; --surface-default)', 'eapp-surface-hover (clickable row hover)'],
      text: ['eapp-text-primary', 'eapp-text-secondary', 'eapp-text-tertiary', 'eapp-text-quaternary'],
      primaryIdentity: ['eapp-primary-solid (solid fill/meter)', 'eapp-primary-text (inline/icon)', 'eapp-primary-soft + -hover (compact chip/tile)', 'eapp-primary-subtle (stronger selected fill)', 'eapp-primary-surface + -hover (large selected identity block)', 'eapp-primary-border', 'eapp-primary-ring'],
      status: ['eapp-status-success|warning|danger|info|neutral -soft/-text/-border (badges/small icons/short text only)'],
      radius: ['eapp-radius-card', 'eapp-radius-panel', 'eapp-radius-control', 'eapp-radius-subcontrol', 'eapp-radius-pill'],
      dividers: ['eapp-divider', 'eapp-divide-y'],
      modal: ['eapp-modal-surface (modal content chrome; never surface-card)'],
      nuxtUiMapping: 'primary=--md-primary(runtime), secondary=--md-tertiary(runtime), success=--st-success, warning=--st-warning, error=--st-error, info=--st-info, neutral=neutral surfaces',
    },
  };
}

function getThemeClassReference() {
  return {
    action: 'theme_class_reference',
    authority: 'Authoritative Enfyra theme & color contract. Source of truth: documents/app/theme-color-contract.md. App owns color via theme.css + main.css + app.config.ts only; pages/extensions consume classes and Nuxt UI props.',
    baseLayers: {
      material: '--md-* (runtime primary picker, HCT/Material You). Drives identity/brand. Never read directly in templates.',
      status: '--st-success/--st-warning/--st-error/--st-info. Fixed semantic palette. Never read directly in templates.',
    },
    nuxtUiColors: {
      primary: 'runtime --md-primary (main brand action/identity). NEVER substitute a concrete palette.',
      secondary: 'runtime --md-tertiary (intentional secondary accent only).',
      success: '--st-success (healthy/success).',
      warning: '--st-warning (pending/attention).',
      error: 'single --danger-* lane from Material error roles (destructive/error). Ghost danger text uses --danger-on-surface; danger fills use --danger-surface.',
      info: '--st-info (informational).',
      neutral: 'neutral surfaces (secondary chrome, non-actions).',
    },
    classes: [
      { group: 'Surfaces (large ordinary - keep neutral)', classes: 'eapp-surface-card, eapp-surface-muted, eapp-surface-flat, eapp-surface-hover' },
      { group: 'Text', classes: 'eapp-text-primary, eapp-text-secondary, eapp-text-tertiary, eapp-text-quaternary' },
      { group: 'Runtime primary identity', classes: 'eapp-primary-solid, eapp-primary-text, eapp-primary-soft(+hover), eapp-primary-subtle, eapp-primary-surface(+hover), eapp-primary-border, eapp-primary-ring' },
      { group: 'Status (badges/small icons/short text only)', classes: 'eapp-status-{success|warning|danger|info|neutral}-{soft|text|border}' },
      { group: 'Radius', classes: 'eapp-radius-card, eapp-radius-panel, eapp-radius-control, eapp-radius-subcontrol, eapp-radius-pill' },
      { group: 'Icon tile geometry', classes: 'eapp-icon-tile, eapp-icon-tile-sm, eapp-icon-tile-lg' },
      { group: 'Dividers', classes: 'eapp-divider, eapp-divide-y' },
      { group: 'Modal', classes: 'eapp-modal-surface (never surface-card as modal ui.content)' },
    ],
    forbidden: [
      'Raw CSS variables in templates: text-[var(--*)], bg-[var(--*)], border-[var(--*)].',
      'Tailwind palette accents: from-cyan-*, text-violet-*, bg-green-*, bg-emerald-*, text-gray-*, bg-slate-*, dark:bg-zinc-950.',
      'Concrete palette substitution (color="violet"/"cyan"/..., from-cyan-*, text-violet-*, bg-green-*, bg-emerald-*, dark:bg-zinc-950).',
      'Hardcoded hex colors or inline style="color:#..." for theme-driven surfaces.',
      'Reading --md-* / --st-* / --badge-* base variables directly from extension templates.',
    ],
    allowedShortUtilities: [
      'Tailwind v4 short utilities ARE canonical and preferred: bg-primary, text-primary, border-primary, ring-primary, bg-success, text-error, bg-warning, text-info, bg-secondary.',
      'Opacity modifiers work natively via v4 color-mix: bg-primary/10, ring-primary/20, text-primary/70, bg-success/15.',
      'Use eapp-* classes only for intent surfaces with no Tailwind equivalent (eapp-primary-surface/solid/soft/subtle, eapp-surface-card/muted/flat/hover, eapp-divider/divide-y, eapp-radius-*, eapp-modal-surface).',
    ],
    chooseByIntent: [
      'Normal accent / active tab / progress / primary CTA -> primary (eapp-primary-* or color="primary").',
      'True semantic state -> status (eapp-status-* or color="success|warning|error|info").',
      'Large ordinary surface -> eapp-surface-*; put a small status badge inside.',
      'Whole block is active identity -> eapp-primary-surface (+hover), subtle only.',
    ],
  };
}

function parseJsonObjectArg(name, value, fallback = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return parsed;
}

function parseJsonArrayArg(name, value, fallback = []) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array.`);
  }
  return parsed;
}

function filterQuery(filter) {
  return encodeURIComponent(JSON.stringify(filter));
}

async function reloadBestEffort(apiUrl, path) {
  try {
    const result = await fetchAPI(apiUrl, path, { method: 'POST' });
    return { attempted: true, succeeded: true, result };
  } catch (error) {
    return { attempted: true, succeeded: false, error: error?.message || String(error) };
  }
}

function naturalPartialReload(reason) {
  return { attempted: false, succeeded: true, reason };
}

async function validateDynamicScript(apiUrl, sourceCode, scriptLanguage = 'javascript') {
  const result = await fetchAPI(apiUrl, '/admin/script/validate', {
    method: 'POST',
    body: JSON.stringify({ sourceCode, scriptLanguage }),
  });
  if (result?.valid === false || result?.success === false) {
    throw new Error(result?.error?.message || 'Dynamic script validation failed.');
  }
  return {
    valid: true,
    scriptLanguage,
    compiledLength: typeof result?.data?.compiledCode === 'string' ? result.data.compiledCode.length : undefined,
  };
}

function readTemplateBlocks(code) {
  const blocks = [];
  const lower = String(code || '').toLowerCase();
  let index = 0;
  while (index < lower.length) {
    const openStart = lower.indexOf('<template', index);
    if (openStart === -1) break;
    const boundary = lower[openStart + '<template'.length];
    if (boundary && !/\s|>/.test(boundary)) {
      index = openStart + 1;
      continue;
    }
    const openEnd = lower.indexOf('>', openStart + '<template'.length);
    if (openEnd === -1) break;
    const closeStart = lower.indexOf('</template', openEnd + 1);
    if (closeStart === -1) break;
    blocks.push(String(code).slice(openEnd + 1, closeStart));
    index = closeStart + '</template'.length;
  }
  return blocks;
}

function readTemplateTagName(template, start) {
  const next = template[start + 1];
  if (!next || next === '!' || next === '?') return null;
  let index = start + (next === '/' ? 2 : 1);
  while (/\s/.test(template[index] || '')) index += 1;
  const nameStart = index;
  while (/[\w.-]/.test(template[index] || '')) index += 1;
  return index > nameStart ? template.slice(nameStart, index) : null;
}

export function validateExtensionCodeLocally(code) {
  if (/\bresolveComponent\s*\(/.test(String(code || ''))) {
    throw new Error('Invalid extension component resolution: do not call resolveComponent() in Enfyra extensions. Use auto-injected components such as <UButton> directly in the template so the app/compiler resolves them correctly.');
  }

  const violations = [];
  for (const template of readTemplateBlocks(code)) {
    let index = 0;
    while (index < template.length) {
      const tagStart = template.indexOf('<', index);
      if (tagStart === -1) break;
      const tagName = readTemplateTagName(template, tagStart);
      if (tagName && tagName === tagName.toLowerCase() && !tagName.includes('-')) {
        const expected = AUTO_INJECTED_EXTENSION_COMPONENT_BY_LOWERCASE.get(tagName);
        if (expected) violations.push({ tag: tagName, expected });
      }
      index = tagStart + 1;
    }
  }
  if (violations.length) {
    const first = violations[0];
    throw new Error(`Invalid extension component casing: use <${first.expected}> instead of <${first.tag}>. Enfyra/Nuxt UI auto-injected components must keep PascalCase in extension templates; lowercase tags render as unresolved DOM elements.`);
  }
  return { componentCasing: 'passed' };
}

export async function validateExtensionCode(apiUrl, code, name) {
  const localChecks = validateExtensionCodeLocally(code);
  const result = await fetchAPI(apiUrl, '/enfyra_extension/preview', {
    method: 'POST',
    body: JSON.stringify({ code, name }),
  });
  if (result?.success === false) {
    throw new Error(result?.error?.message || 'Extension validation failed.');
  }
  return {
    valid: true,
    localChecks,
    extensionId: result?.extensionId || name || null,
    compiledLength: typeof result?.compiledCode === 'string' ? result.compiledCode.length : undefined,
  };
}

async function updateExtensionCode(apiUrl, {
  id,
  name,
  code,
  description,
  isEnabled,
  version,
  globalRulesAckKey,
  extensionKnowledgeAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  assertExtensionKnowledgeAck(extensionKnowledgeAckKey);
  if (!id && !name) throw new Error('Provide id or name to update an existing extension.');
  const existing = id
    ? await findRecord(apiUrl, 'enfyra_extension', { id: { _eq: id } }, 'id,_id,name,type,menu.id')
    : await findRecord(apiUrl, 'enfyra_extension', { name: { _eq: name } }, 'id,_id,name,type,menu.id');
  if (!existing) throw new Error(`Extension not found: ${id || name}`);
  const extensionId = getId(existing);
  const validation = await validateExtensionCode(apiUrl, code, name || existing.name || extensionId);
  const body = {
    code,
    ...(description !== undefined ? { description } : {}),
    ...(isEnabled !== undefined ? { isEnabled } : {}),
    ...(version !== undefined ? { version } : {}),
  };
  const result = await fetchAPI(apiUrl, `/enfyra_extension/${encodeURIComponent(String(extensionId))}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return {
    action: 'extension_code_updated',
    id: extensionId,
    name: existing.name || name || null,
    type: existing.type || null,
    result,
    validation,
  };
}

function normalizeMetadataTables(metadata) {
  const tables = metadata?.data?.tables || metadata?.tables || metadata?.data || [];
  return Array.isArray(tables) ? tables : Object.values(tables || {});
}

async function getMetadataTables(apiUrl) {
  return normalizeMetadataTables(await fetchAPI(apiUrl, '/metadata'));
}

function resolveTable(tables, tableName) {
  const table = tables.find((item) => item?.name === tableName || item?.alias === tableName || sameId(getId(item), tableName));
  if (!table) throw new Error(`Table not found: ${tableName}`);
  return table;
}

function resolveColumn(table, columnName) {
  const column = (table.columns || []).find((item) => item?.name === columnName || sameId(getId(item), columnName));
  if (!column) throw new Error(`Column not found: ${table.name}.${columnName}`);
  return column;
}

function resolveRelation(table, relationName) {
  const relation = (table.relations || []).find((item) => item?.propertyName === relationName || item?.name === relationName || sameId(getId(item), relationName));
  if (!relation) throw new Error(`Relation not found: ${table.name}.${relationName}`);
  return relation;
}

async function findRecord(apiUrl, tableName, filter, fields = '*') {
  const result = await fetchAPI(apiUrl, `/${tableName}?filter=${filterQuery(filter)}&limit=1&fields=${encodeURIComponent(fields)}`);
  return unwrapData(result)[0] || null;
}

async function fetchRecords(apiUrl, tableName, filter, fields = '*', limit = 1000) {
  const result = await fetchAPI(apiUrl, `/${tableName}?filter=${filterQuery(filter)}&limit=${limit}&fields=${encodeURIComponent(fields)}`);
  return unwrapData(result);
}

async function createOrPatch(apiUrl, tableName, existing, body) {
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

async function resolveRole(apiUrl, { roleId, roleName }) {
  if (roleId && roleName) throw new Error('Provide roleId or roleName, not both.');
  if (!roleId && !roleName) return null;
  if (roleId) return { id: roleId, name: null };
  const role = await findRecord(apiUrl, 'enfyra_role', { name: { _eq: roleName } }, 'id,_id,name');
  if (!role) throw new Error(`Role not found: ${roleName}`);
  return { id: getId(role), name: role.name };
}

function assertOneScope({ roleId, roleName, allowedUserIds }) {
  if (!roleId && !roleName && (!allowedUserIds || allowedUserIds.length === 0)) {
    throw new Error('Provide roleId, roleName, or allowedUserIds.');
  }
}

function normalizeFlowStepBody(step, flowId) {
  const body = {
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

async function ensureMenu(apiUrl, {
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
  const operation = await createOrPatch(apiUrl, 'enfyra_menu', existing, {
    label,
    ...(normalizedPath ? { path: normalizedPath } : {}),
    icon,
    type,
    order,
    permission: parseJsonObjectArg('permission', permission, undefined),
    description,
    isEnabled,
  });
  return {
    id: operation.id || getId(existing),
    path: normalizedPath || existing?.path || null,
    label,
    action: operation.action,
    operation,
  };
}

async function reorderMenus(apiUrl, { updates, globalRulesAckKey }) {
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

async function ensureExtension(apiUrl, {
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
  return {
    id: operation.id || getId(existing),
    name,
    type,
    action: operation.action,
    operation,
    validation,
  };
}

async function ensureFlow(apiUrl, {
  name,
  triggerType = 'manual',
  triggerConfig,
  timeout,
  maxExecutions = 100,
  isEnabled = true,
  description,
  globalRulesAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  const existing = await findRecord(apiUrl, 'enfyra_flow', { name: { _eq: name } }, 'id,_id,name');
  const operation = await createOrPatch(apiUrl, 'enfyra_flow', existing, {
    name,
    triggerType,
    triggerConfig: parseJsonObjectArg('triggerConfig', triggerConfig, {}),
    timeout,
    maxExecutions,
    isEnabled,
    description,
  });
  const reload = naturalPartialReload('Flow metadata writes trigger the server partial reload contract; there is no dedicated flow reload endpoint.');
  return { action: 'flow_ensured', flow: { id: operation.id, name }, operation, reload };
}

async function ensureFlowStep(apiUrl, {
  flowName,
  flowId,
  key,
  type,
  order,
  config,
  sourceCode,
  scriptLanguage,
  timeout,
  isEnabled,
  globalRulesAckKey,
  knowledgeAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  if (!flowName && !flowId) throw new Error('Provide flowName or flowId.');
  if (flowName && flowId) throw new Error('Provide flowName or flowId, not both.');
  const flow = flowId
    ? await findRecord(apiUrl, 'enfyra_flow', { id: { _eq: flowId } }, 'id,_id,name')
    : await findRecord(apiUrl, 'enfyra_flow', { name: { _eq: flowName } }, 'id,_id,name');
  if (!flow) throw new Error(`Flow not found: ${flowId || flowName}`);
  const parsedConfig = parseJsonObjectArg('config', config, {});
  assertDynamicCodeKnowledgeAckIf(Boolean(sourceCode && ['script', 'condition'].includes(type)), knowledgeAckKey);
  const validation = sourceCode && ['script', 'condition'].includes(type)
    ? await validateDynamicScript(apiUrl, sourceCode, scriptLanguage)
    : { validated: false, reason: 'no script validation required' };
  const existing = await findRecord(apiUrl, 'enfyra_flow_step', {
    flow: { id: { _eq: getId(flow) } },
    key: { _eq: key },
  }, 'id,_id,key,flow.id');
  const operation = await createOrPatch(apiUrl, 'enfyra_flow_step', existing, normalizeFlowStepBody({
    key,
    type,
    order,
    config: parsedConfig,
    sourceCode,
    scriptLanguage,
    timeout,
    isEnabled,
  }, getId(flow)));
  const reload = naturalPartialReload('Flow step writes trigger the server partial reload contract; there is no dedicated flow reload endpoint.');
  return { action: 'flow_step_ensured', flow: { id: getId(flow), name: flow.name }, step: { id: operation.id, key, type }, validation, operation, reload };
}

const FLOW_STEP_TOOL_GUIDANCE = [
  {
    tool: 'ensure_query_flow_step',
    type: 'query',
    when: 'Read/list records from one table without custom branching or transformation.',
    config: { table: 'table_name', filter: {}, fields: 'id,name', limit: 20, sort: '-createdAt' },
  },
  {
    tool: 'ensure_create_flow_step',
    type: 'create',
    when: 'Create one record in one table from static config or previous flow values.',
    config: { table: 'table_name', data: { field: 'value' } },
  },
  {
    tool: 'ensure_update_flow_step',
    type: 'update',
    when: 'Update one known record by id.',
    config: { table: 'table_name', id: '@FLOW_PAYLOAD.id', data: { field: 'value' } },
  },
  {
    tool: 'ensure_delete_flow_step',
    type: 'delete',
    when: 'Delete one known record by id.',
    config: { table: 'table_name', id: '@FLOW_PAYLOAD.id' },
  },
  {
    tool: 'ensure_http_flow_step',
    type: 'http',
    when: 'Call an external HTTP API.',
    config: { url: 'https://example.com/api', method: 'POST', headers: {}, body: {}, timeout: 10000 },
  },
  {
    tool: 'ensure_condition_flow_step',
    type: 'condition',
    when: 'Branch into true/false child steps based on JavaScript truthiness.',
    sourceCode: 'return Boolean(@FLOW_PAYLOAD.enabled)',
  },
  {
    tool: 'ensure_sleep_flow_step',
    type: 'sleep',
    when: 'Wait for a short bounded delay.',
    config: { ms: 1000 },
  },
  {
    tool: 'ensure_trigger_flow_step',
    type: 'trigger_flow',
    when: 'Trigger another flow as a child/orchestration step.',
    config: { flowName: 'child-flow', payload: {} },
  },
  {
    tool: 'ensure_log_flow_step',
    type: 'log',
    when: 'Record a small execution note for diagnostics.',
    config: { message: 'Reached step_name' },
  },
  {
    tool: 'ensure_script_flow_step',
    type: 'script',
    when: 'Use only when logic needs loops, multiple tables, crypto, package calls, non-trivial transforms, or runtime checks not covered by the atomic step tools.',
    sourceCode: 'return { ok: true }',
  },
];

function chooseFlowStepTool(intent) {
  const text = String(intent || '').toLowerCase();
  const hasAny = (patterns) => patterns.some((pattern) => pattern.test(text));
  if (hasAny([/\bif\b/, /\belse\b/, /\bbranch\b/, /\bcondition\b/, /\bwhen\b/, /\bcheck\b/, /nếu/, /điều kiện/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'condition');
  if (hasAny([/\bhttp\b/, /\bapi\b/, /\bwebhook\b/, /\bfetch\b/, /\brequest\b/, /\bpost\b/, /\bget\b/, /\bcall\b/, /gọi api/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'http');
  if (hasAny([/\bsleep\b/, /\bwait\b/, /\bdelay\b/, /\bpause\b/, /chờ/, /đợi/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'sleep');
  if (hasAny([/\btrigger\b/, /\bchild flow\b/, /\banother flow\b/, /\bsubflow\b/, /flow khác/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'trigger_flow');
  if (hasAny([/\bdelete\b/, /\bremove\b/, /\bdestroy\b/, /xóa/, /xoá/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'delete');
  if (hasAny([/\bupdate\b/, /\bpatch\b/, /\bset\b/, /\bmark\b/, /\bchange\b/, /cập nhật/, /đánh dấu/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'update');
  if (hasAny([/\bcreate\b/, /\binsert\b/, /\badd\b/, /\bstore\b/, /\bsave\b/, /tạo/, /thêm/, /lưu/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'create');
  if (hasAny([/\blog\b/, /\bdebug\b/, /\btrace\b/, /ghi log/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'log');
  if (hasAny([/\bquery\b/, /\bfind\b/, /\blist\b/, /\bread\b/, /\bload\b/, /\bcount\b/, /\bsearch\b/, /đọc/, /tìm/, /liệt kê/])) return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'query');
  return FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === 'script');
}

function normalizeEndpointAccess(anonymousAccess, makePublic) {
  if (makePublic !== undefined) return makePublic ? 'public' : 'private';
  return anonymousAccess || 'private';
}

function sourceMatches(existingHandler, sourceCode, scriptLanguage, timeout) {
  if (!existingHandler) return false;
  if (String(existingHandler.sourceCode ?? '') !== String(sourceCode ?? '')) return false;
  if (scriptLanguage && String(existingHandler.scriptLanguage || 'javascript') !== String(scriptLanguage)) return false;
  if (timeout !== undefined && Number(existingHandler.timeout) !== Number(timeout)) return false;
  return true;
}

function extensionMatches(existingExtension, opts, menuId) {
  if (!existingExtension) return false;
  if (String(existingExtension.type || '') !== String(opts.type || 'page')) return false;
  if (String(existingExtension.code ?? '') !== String(opts.code ?? '')) return false;
  if (opts.description !== undefined && String(existingExtension.description || '') !== String(opts.description || '')) return false;
  if (opts.isEnabled !== undefined && Boolean(existingExtension.isEnabled) !== Boolean(opts.isEnabled)) return false;
  if (opts.version !== undefined && String(existingExtension.version || '') !== String(opts.version)) return false;
  if ((opts.type || 'page') === 'page' && menuId && String(refId(existingExtension.menu)) !== String(menuId)) return false;
  if ((opts.type || 'page') !== 'page' && refId(existingExtension.menu)) return false;
  return true;
}

function step(status, id, title, detail = {}) {
  return { id, title, status, ...detail };
}

async function resolveApiEndpointWorkflowState(apiUrl, opts) {
  const normalizedPath = normalizeRestPath(opts.path);
  const methodName = normalizeMethodName(opts.method);
  const access = normalizeEndpointAccess(opts.anonymousAccess, opts.public);
  const { methodMap, methodIdNameMap } = await getMethodContext(apiUrl);
  const methodId = methodMap[methodName];
  if (!methodId) throw new Error(`Unknown method "${methodName}". Valid methods: ${Object.keys(methodMap).sort().join(', ')}`);

  const [routes, scriptValidation] = await Promise.all([
    fetchAll(apiUrl, '/enfyra_route?limit=1000&fields=id,_id,path,isEnabled,description,availableMethods.*,publicMethods.*,mainTable.name'),
    validateScriptSourceIfPresent(fetchAPI, apiUrl, 'enfyra_route_handler', {
      sourceCode: opts.sourceCode,
      scriptLanguage: opts.scriptLanguage || 'javascript',
    }),
  ]);

  const route = routes.find((item) => item.path === normalizedPath) || null;
  const routeId = getId(route);
  const availableMethods = methodNamesFromRecords(route?.availableMethods || [], methodIdNameMap);
  const publicMethods = methodNamesFromRecords(route?.publicMethods || [], methodIdNameMap);
  const methodAvailable = availableMethods.includes(methodName);
  const routeNeedsUpdate = !!route && (
    route.isEnabled === false
    || !methodAvailable
    || (access === 'public' && !publicMethods.includes(methodName))
    || (access === 'private' && publicMethods.includes(methodName))
    || (opts.description !== undefined && route.description !== opts.description)
  );
  const handler = route ? await findHandler(apiUrl, routeId, methodId) : null;
  const handlerMatches = sourceMatches(handler, opts.sourceCode, opts.scriptLanguage || 'javascript', opts.timeout);
  const handlerNeedsOverwrite = !!handler && !handlerMatches;

  let permission = null;
  let role = null;
  let permissionMethods = [];
  let permissionMissingMethods = [];
  if (opts.roleName || opts.roleId || opts.allowedUserIds?.length) {
    if (access === 'public') {
      permissionMissingMethods = [];
    } else if (!route) {
      permissionMissingMethods = [methodName];
    } else {
      const permissions = await fetchRecords(apiUrl, 'enfyra_route_permission', {
        route: { id: { _eq: routeId } },
      }, 'id,_id,route.id,role.id,role.name,allowedUsers.id,methods.*', 1000);
      role = await resolveRole(apiUrl, { roleId: opts.roleId, roleName: opts.roleName });
      const allowedUserIds = (opts.allowedUserIds || []).map(String).sort();
      permission = permissions.find((candidate) => {
        const candidateRoleId = refId(candidate.role);
        const candidateUserIds = (candidate.allowedUsers || []).map((item) => String(refId(item))).sort();
        if (role && String(candidateRoleId) !== String(role.id)) return false;
        if (!role && candidateRoleId !== null && candidateRoleId !== undefined) return false;
        return allowedUserIds.length === candidateUserIds.length
          && allowedUserIds.every((value, index) => value === candidateUserIds[index]);
      }) || null;
      permissionMethods = methodNamesFromRecords(permission?.methods || [], methodIdNameMap);
      permissionMissingMethods = permissionMethods.includes(methodName) ? [] : [methodName];
    }
  }

  const smokeTestRequested = opts.smokeTestQuery !== undefined || opts.smokeTestBody !== undefined;
  const steps = [
    route
      ? step(routeNeedsUpdate ? 'pending' : 'completed', 'sync_route', 'Ensure route method and public access', {
        routeId,
        availableMethods,
        publicMethods,
        desiredAccess: access,
      })
      : step('pending', 'create_route', 'Create custom route', {
        desiredAccess: access,
      }),
    handler
      ? step(handlerNeedsOverwrite ? (opts.overwrite ? 'pending' : 'blocked') : 'completed', 'save_handler', 'Create or update route handler', {
        handlerId: getId(handler),
        reason: handlerNeedsOverwrite && !opts.overwrite ? 'Existing handler differs. Re-run with overwrite=true to update it.' : undefined,
      })
      : step(route && methodAvailable ? 'pending' : 'waiting', 'save_handler', 'Create route handler', {
        reason: !route ? 'Route must exist first.' : methodAvailable ? undefined : 'Route method must be available first.',
      }),
  ];

  if (opts.roleName || opts.roleId || opts.allowedUserIds?.length) {
    steps.push(
      access === 'public'
        ? step('skipped', 'ensure_route_access', 'Ensure authenticated route access', {
          reason: 'Method is public, so route permission is not required for anonymous access.',
        })
        : step(permissionMissingMethods.length ? (route ? 'pending' : 'waiting') : 'completed', 'ensure_route_access', 'Ensure authenticated route access', {
          permissionId: getId(permission),
          role,
          allowedUserIds: opts.allowedUserIds || [],
          methods: permissionMethods,
          missingMethods: permissionMissingMethods,
        }),
    );
  }

  if (smokeTestRequested) {
    const blockers = steps.filter((item) => ['pending', 'waiting', 'blocked'].includes(item.status));
    steps.push(step(blockers.length ? 'waiting' : 'pending', 'smoke_test', 'Smoke-test the endpoint', {
      reason: blockers.length ? 'Endpoint must be ready before smoke test.' : undefined,
    }));
  }

  const firstRunnable = steps.find((item) => item.status === 'pending') || null;
  const blocked = steps.find((item) => item.status === 'blocked') || null;

  return {
    endpoint: {
      path: normalizedPath,
      method: methodName,
      anonymousAccess: access,
      routeId,
      handlerId: getId(handler),
    },
    methodId,
    methodMap,
    methodIdNameMap,
    route,
    handler,
    role,
    scriptValidation,
    steps,
    firstRunnable,
    blocked,
    nextSteps: blocked
      ? [{ tool: 'api_endpoint_workflow', input: { path: normalizedPath, method: methodName, overwrite: true }, reason: blocked.reason }]
      : firstRunnable
        ? [{
          tool: 'api_endpoint_workflow',
          input: { path: normalizedPath, method: methodName, apply: true },
          stepId: firstRunnable.id,
          requiresKnowledgeAck: firstRunnable.id === 'save_handler' ? 'dynamicCodeAckKey from get_enfyra_required_knowledge' : undefined,
        }]
        : [],
  };
}

async function applyApiEndpointWorkflowStep(apiUrl, state, opts, stepId) {
  const selectedStep = stepId
    ? state.steps.find((item) => item.id === stepId)
    : state.firstRunnable;
  if (!selectedStep) return { action: 'noop', reason: 'No runnable step remains.' };
  if (selectedStep.status !== 'pending') {
    throw new Error(`Step "${selectedStep.id}" is ${selectedStep.status}, not pending.`);
  }

  const endpoint = state.endpoint;
  if (selectedStep.id === 'create_route') {
    const result = await fetchAPI(apiUrl, '/enfyra_route', {
      method: 'POST',
      body: JSON.stringify({
        path: endpoint.path,
        description: opts.description,
        isEnabled: true,
        availableMethods: [{ id: state.methodId }],
        publicMethods: endpoint.anonymousAccess === 'public' ? [{ id: state.methodId }] : [],
      }),
    });
    return { action: 'route_created', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'sync_route') {
    const availableMethods = methodNamesFromRecords(state.route.availableMethods, state.methodIdNameMap);
    const publicMethods = methodNamesFromRecords(state.route.publicMethods, state.methodIdNameMap);
    const finalAvailable = uniqueMethodNames([...availableMethods, endpoint.method]);
    const finalPublic = endpoint.anonymousAccess === 'public'
      ? uniqueMethodNames([...publicMethods, endpoint.method])
      : publicMethods.filter((method) => method !== endpoint.method);
    const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(endpoint.routeId))}`, {
      method: 'PATCH',
      body: JSON.stringify({
        isEnabled: true,
        availableMethods: resolveMethodRefs(state.methodMap, finalAvailable),
        publicMethods: resolveMethodRefs(state.methodMap, finalPublic),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
      }),
    });
    return { action: 'route_synced', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'save_handler') {
    assertDynamicCodeKnowledgeAck(opts.knowledgeAckKey);
    if (!endpoint.routeId) throw new Error('Route must exist before saving handler.');
    const body = {
      sourceCode: opts.sourceCode,
      scriptLanguage: opts.scriptLanguage || 'javascript',
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    };
    if (state.handler) {
      const result = await fetchAPI(apiUrl, `/enfyra_route_handler/${encodeURIComponent(String(getId(state.handler)))}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return { action: 'handler_updated', result, routeReload: await reloadRoutes(apiUrl) };
    }
    const result = await fetchAPI(apiUrl, '/enfyra_route_handler', {
      method: 'POST',
      body: JSON.stringify({
        route: { id: endpoint.routeId },
        method: { id: state.methodId },
        ...body,
      }),
    });
    return { action: 'handler_created', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'ensure_route_access') {
    assertOneScope(opts);
    const role = state.role || await resolveRole(apiUrl, { roleId: opts.roleId, roleName: opts.roleName });
    const existing = state.steps.find((item) => item.id === 'ensure_route_access')?.permissionId
      ? await findRecord(apiUrl, 'enfyra_route_permission', { id: { _eq: state.steps.find((item) => item.id === 'ensure_route_access').permissionId } }, 'id,_id,methods.*')
      : null;
    const existingMethods = methodNamesFromRecords(existing?.methods || [], state.methodIdNameMap);
    const finalMethods = uniqueMethodNames([...existingMethods, endpoint.method]);
    const body = {
      isEnabled: true,
      description: opts.routePermissionDescription,
      methods: resolveMethodRefs(state.methodMap, finalMethods),
      ...(role ? { role: { id: role.id } } : {}),
      ...(opts.allowedUserIds?.length ? { allowedUsers: opts.allowedUserIds.map((id) => ({ id })) } : {}),
    };
    const result = existing
      ? await fetchAPI(apiUrl, `/enfyra_route_permission/${encodeURIComponent(String(getId(existing)))}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      : await fetchAPI(apiUrl, '/enfyra_route_permission', {
        method: 'POST',
        body: JSON.stringify({
          route: { id: endpoint.routeId },
          ...body,
        }),
      });
    return { action: existing ? 'route_access_updated' : 'route_access_created', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'smoke_test') {
    const query = parseJsonObjectArg('smokeTestQuery', opts.smokeTestQuery, {});
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) queryParams.set(key, String(value));
    }
    const body = opts.smokeTestBody === undefined ? undefined : parseJsonObjectArg('smokeTestBody', opts.smokeTestBody, {});
    const smokePath = `${endpoint.path}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    const result = await fetchAPI(apiUrl, smokePath, {
      method: endpoint.method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { action: 'smoke_test_passed', result };
  }

  throw new Error(`Unsupported workflow step: ${selectedStep.id}`);
}

async function runApiEndpointWorkflow(apiUrl, opts) {
  let state = await resolveApiEndpointWorkflowState(apiUrl, opts);
  const operations = [];
  let completedEphemeralStepId = null;
  if (opts.apply || opts.applyAll) {
    assertGlobalRulesAck(opts.globalRulesAckKey);
    if (opts.applyAll && state.steps.some((item) => item.id === 'save_handler' && ['pending', 'waiting'].includes(item.status))) {
      assertDynamicCodeKnowledgeAck(opts.knowledgeAckKey);
    }
    const maxSteps = opts.applyAll ? 10 : 1;
    for (let i = 0; i < maxSteps; i += 1) {
      if (state.blocked || !state.firstRunnable) break;
      const operation = await applyApiEndpointWorkflowStep(apiUrl, state, opts, opts.stepId);
      operations.push(operation);
      if (state.firstRunnable.id === 'smoke_test') {
        completedEphemeralStepId = 'smoke_test';
        break;
      }
      if (!opts.applyAll) break;
      state = await resolveApiEndpointWorkflowState(apiUrl, opts);
    }
  }
  const latestState = operations.length ? await resolveApiEndpointWorkflowState(apiUrl, opts) : state;
  const latestSteps = completedEphemeralStepId
    ? latestState.steps.map((item) => (
      item.id === completedEphemeralStepId
        ? { ...item, status: 'completed', result: 'passed' }
        : item
    ))
    : latestState.steps;
  const nextSteps = completedEphemeralStepId
    ? latestState.nextSteps.filter((item) => item.stepId !== completedEphemeralStepId)
    : latestState.nextSteps;
  return {
    action: operations.length ? 'api_endpoint_workflow_advanced' : 'api_endpoint_workflow_planned',
    endpoint: latestState.endpoint,
    scriptValidation: latestState.scriptValidation,
    steps: latestSteps,
    operations,
    complete: latestSteps.every((item) => ['completed', 'skipped'].includes(item.status)),
    nextSteps,
    cleanupHints: latestState.endpoint.routeId
      ? [
        `Use delete_route({ routeId: ${JSON.stringify(latestState.endpoint.routeId)}, confirm: false }) to preview route-owned handlers, hooks, guards, and permissions before cleanup.`,
        `Then call delete_route({ routeId: ${JSON.stringify(latestState.endpoint.routeId)}, expectedPath: ${JSON.stringify(latestState.endpoint.path)}, confirm: true }) when the route contract is no longer needed.`,
      ]
      : [],
  };
}

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

async function runExtensionWorkflow(apiUrl, opts) {
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
      'For menu/account-panel notifications, use counts only when the signal source already owns an exact count; otherwise use a dot/chip for new attention.',
      'Do not fetch destination domain lists solely to decorate the shell; destination pages own domain fetching after click.',
    ],
  };
}

export function registerPlatformOperationTools(server, ENFYRA_API_URL) {
  server.tool(
    'validate_dynamic_script',
    [
      'Validate Enfyra dynamic script code before saving it to any script-backed metadata record.',
      'Use this before create/update of handlers, hooks, flow steps, websocket scripts, GraphQL scripts, or bootstrap scripts when the user is iterating on code.',
      'This calls the same server compiler contract used by Enfyra, but does not save anything.',
    ].join(' '),
    {
      sourceCode: z.string().describe('Raw dynamic script sourceCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language to validate.'),
    },
    async ({ sourceCode, scriptLanguage }) => jsonText({
      action: 'dynamic_script_validated',
      validation: await validateDynamicScript(ENFYRA_API_URL, sourceCode, scriptLanguage),
    }),
  );

  server.tool(
    'validate_extension_code',
    [
      'Validate Enfyra admin extension code before saving it to enfyra_extension.',
      'Use this only when the user explicitly wants a validation-only check. For normal edits, use update_extension_code or ensure_*_extension so successful validation saves in the same tool call.',
      'This calls /enfyra_extension/preview and does not save anything.',
      'Call get_extension_theme_contract first when generating or reviewing UI.',
    ].join(' '),
    {
      code: z.string().describe('Vue SFC or compiled extension bundle code.'),
      name: z.string().optional().describe('Optional extension name/id used by the preview compiler.'),
    },
    async ({ code, name }) => jsonText({
      action: 'extension_code_validated',
      validation: await validateExtensionCode(ENFYRA_API_URL, code, name),
    }),
  );

  server.tool(
    'update_extension_code',
    [
      'Business operation: update an existing Enfyra admin extension code by id or name.',
      'It runs local extension guards and /enfyra_extension/preview first, then saves the code in the same call only when validation succeeds.',
      'Use this instead of validate_extension_code followed by update_record when editing an existing page/widget/global extension.',
      'Call get_extension_theme_contract first when generating or reviewing UI.',
    ].join(' '),
    {
      id: z.union([z.string(), z.number()]).optional().describe('Existing extension id. Provide id or name.'),
      name: z.string().optional().describe('Existing extension unique name. Provide id or name.'),
      code: z.string().describe('Vue SFC extension code.'),
      description: z.string().optional().describe('Optional replacement extension description. Omit to preserve.'),
      isEnabled: z.boolean().optional().describe('Optional enabled state. Omit to preserve.'),
      version: z.string().optional().describe('Optional extension version. Omit to preserve.'),
      globalRulesAckKey: globalRulesAckParam(z),
      extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
    },
    async (input) => jsonText(await updateExtensionCode(ENFYRA_API_URL, input)),
  );

  server.tool(
    'get_extension_theme_contract',
    'Return the concise Enfyra admin extension UI/theme/security contract. Call before writing or reviewing extension UI.',
    {},
    async () => jsonText(getExtensionThemeContract()),
  );

  server.tool(
    'get_theme_class_reference',
    [
      'Return the authoritative Enfyra theme & color class reference: class -> CSS variable -> Nuxt UI semantic color -> intent.',
      'Call this whenever you need the exact eapp-* class name or the Nuxt UI color mapping for shell, system page, or dynamic extension UI.',
      'Source of truth: documents/app/theme-color-contract.md.',
    ].join(' '),
    {},
    async () => jsonText(getThemeClassReference()),
  );

  server.tool(
    'extension_workflow',
    [
      'Step-by-step workflow for creating or updating Enfyra admin page, global, or widget extensions.',
      'Use this when an LLM is building extension UI, menu shell notifications, account panel entries, or page/menu wiring and should follow live nextSteps instead of guessing raw enfyra_extension mutations.',
      'With apply=false it validates code, reads live menu/extension state, and returns pending steps.',
      'With apply=true it applies exactly the next pending step. With applyAll=true it advances all currently safe pending steps.',
      'Call get_extension_theme_contract before generating or reviewing UI.',
    ].join(' '),
    {
      name: z.string().describe('Extension unique name.'),
      type: z.enum(['page', 'global', 'widget']).optional().default('page').describe('Extension type. Page extensions need a menu. Global extensions are for shell-wide registration.'),
      code: z.string().describe('Vue SFC extension code.'),
      menuId: z.union([z.string(), z.number()]).optional().describe('Existing menu id for a page extension. Provide this or menuLabel/menuPath.'),
      menuLabel: z.string().optional().describe('Menu label to create or update for a page extension when menuId is not provided.'),
      menuPath: z.string().optional().describe('Admin app route path for the page menu, e.g. /cloud/support.'),
      menuIcon: z.string().optional().describe('Optional menu icon name.'),
      menuType: z.enum(['Menu', 'Dropdown Menu']).optional().describe('Menu type. Omit to preserve an existing menu value or use the platform default for a new menu.'),
      menuOrder: z.number().optional().describe('Menu display order. Omit to preserve an existing menu value or use the platform default for a new menu.'),
      menuPermission: z.string().optional().describe('Optional menu permission JSON object.'),
      menuDescription: z.string().optional().describe('Optional menu admin note.'),
      menuIsEnabled: z.boolean().optional().describe('Enable the menu. Omit to preserve an existing menu value or use the platform default for a new menu.'),
      description: z.string().optional().describe('Extension description.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
      version: z.string().optional().default('1.0.0').describe('Extension version.'),
      apply: z.boolean().optional().default(false).describe('false returns plan only; true applies exactly the next pending step.'),
      applyAll: z.boolean().optional().default(false).describe('true applies all safe pending steps in order. Prefer apply=true for production changes.'),
      stepId: z.string().optional().describe('Optional pending step id to apply. Omit to apply the next pending step.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when apply/applyAll mutates metadata. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
      extensionKnowledgeAckKey: extensionKnowledgeAckParam(z).optional().describe('Required when apply/applyAll saves extension code. Use extensionAckKey from get_enfyra_required_knowledge.'),
    },
    async (input) => jsonText(await runExtensionWorkflow(ENFYRA_API_URL, input)),
  );

  server.tool(
    'set_table_graphql',
    'Business operation: enable or disable GraphQL for one table through enfyra_graphql, then reload GraphQL. REST route methods do not control GraphQL.',
    {
      tableName: z.string().describe('Table name, alias, or id.'),
      isEnabled: z.boolean().describe('Desired GraphQL enabled state for the table.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ tableName, isEnabled, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      const table = resolveTable(await getMetadataTables(ENFYRA_API_URL), tableName);
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_graphql', { table: { id: { _eq: getId(table) } } }, 'id,_id,table.id,isEnabled');
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_graphql', existing, {
        table: { id: getId(table) },
        isEnabled,
      });
      const graphqlReload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/graphql');
      return jsonText({
        action: 'table_graphql_set',
        table: { id: getId(table), name: table.name },
        graphql: { id: operation.id, isEnabled },
        operation,
        graphqlReload,
      });
    },
  );

  server.tool(
    'add_route_methods',
    'Business operation: add HTTP methods to an existing route.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      methods: z.array(z.string()).min(1).describe('HTTP method names to add.'),
      isEnabled: z.boolean().optional().describe('Optionally enable/disable the route in the same safe patch.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ path, routeId, methods, isEnabled, globalRulesAckKey }) => jsonText(await updateRouteMethods(ENFYRA_API_URL, {
      path,
      routeId,
      methods,
      mode: 'merge',
      isEnabled,
      globalRulesAckKey,
    })),
  );

  server.tool(
    'replace_route_methods',
    'Business operation: replace an existing route availableMethods list exactly.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      methods: z.array(z.string()).min(1).describe('Exact HTTP method names for availableMethods.'),
      isEnabled: z.boolean().optional().describe('Optionally enable/disable the route in the same safe patch.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ path, routeId, methods, isEnabled, globalRulesAckKey }) => jsonText(await updateRouteMethods(ENFYRA_API_URL, {
      path,
      routeId,
      methods,
      mode: 'replace',
      isEnabled,
      globalRulesAckKey,
    })),
  );

  server.tool(
    'remove_route_methods',
    'Business operation: remove HTTP methods from an existing route.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      methods: z.array(z.string()).min(1).describe('HTTP method names to remove.'),
      isEnabled: z.boolean().optional().describe('Optionally enable/disable the route in the same safe patch.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ path, routeId, methods, isEnabled, globalRulesAckKey }) => jsonText(await updateRouteMethods(ENFYRA_API_URL, {
      path,
      routeId,
      methods,
      mode: 'remove',
      isEnabled,
      globalRulesAckKey,
    })),
  );

  server.tool(
    'enable_route',
    'Business operation: enable an existing route. Enabled routes are registered at runtime; disabled routes return 404.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ path, routeId, globalRulesAckKey }) => jsonText(await setRouteEnabled(ENFYRA_API_URL, {
      path,
      routeId,
      isEnabled: true,
      globalRulesAckKey,
    })),
  );

  server.tool(
    'disable_route',
    'Business operation: disable an existing route without deleting metadata. Disabled routes are not registered at runtime and return 404.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ path, routeId, globalRulesAckKey }) => jsonText(await setRouteEnabled(ENFYRA_API_URL, {
      path,
      routeId,
      isEnabled: false,
      globalRulesAckKey,
    })),
  );

  server.tool(
    'delete_route',
    'Business operation: preview-first delete for a route and its route-owned handlers, hooks, guards, and permissions. Use only when a route contract is retired.',
    {
      path: z.string().optional().describe('Route path, e.g. /old-endpoint. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      expectedPath: z.string().optional().describe('Optional safety check. When confirm=true, pass the path returned by the preview.'),
      confirm: z.boolean().optional().default(false).describe('false returns a dependency preview only; true deletes the route and related route-owned records.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
    },
    async (input) => jsonText(await deleteRoute(ENFYRA_API_URL, input)),
  );

  server.tool(
    'public_route_methods',
    'Business operation: make existing route methods public/anonymous.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      methods: z.array(z.string()).min(1).describe('HTTP method names to make public. They must already be available on the route.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ path, routeId, methods, globalRulesAckKey }) => jsonText(await updateRoutePublicMethods(ENFYRA_API_URL, {
      path,
      routeId,
      methods,
      mode: 'merge',
      globalRulesAckKey,
    })),
  );

  server.tool(
    'private_route_methods',
    'Business operation: make specific public route methods private again.',
    {
      path: z.string().optional().describe('Route path, e.g. /sum. Use either path or routeId.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Route id. Use either path or routeId.'),
      methods: z.array(z.string()).min(1).describe('HTTP method names to remove from publicMethods.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ path, routeId, methods, globalRulesAckKey }) => jsonText(await updateRoutePublicMethods(ENFYRA_API_URL, {
      path,
      routeId,
      methods,
      mode: 'remove',
      globalRulesAckKey,
    })),
  );

  server.tool(
    'api_endpoint_workflow',
    [
      'Step-by-step workflow for creating or updating a custom REST endpoint.',
      'Use this when an LLM is building or changing endpoint behavior and should follow live nextSteps instead of guessing raw metadata mutations.',
      'With apply=false it validates sourceCode, reads live route/handler/access state, and returns pending steps.',
      'With apply=true it applies only the next pending step, then returns a fresh plan. With applyAll=true it advances all currently safe pending steps.',
    ].join(' '),
    {
      path: z.string().describe('Custom route path, e.g. /sum. Must not be a full URL.'),
      method: z.string().describe('HTTP method for the handler, e.g. GET or POST.'),
      sourceCode: z.string().describe('Handler sourceCode. Use macros such as @QUERY, @BODY, @THROW400, @REPOS, @USER. Do not send compiledCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      anonymousAccess: z.enum(['public', 'private']).optional().default('private').describe('public adds the method to publicMethods; private removes this method from publicMethods.'),
      public: z.boolean().optional().describe('Compatibility alias for anonymousAccess. true means public, false means private.'),
      roleId: z.union([z.string(), z.number()]).optional().describe('Optional role id for authenticated route permission.'),
      roleName: z.string().optional().describe('Optional role name for authenticated route permission, e.g. user.'),
      allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Optional user id scope for authenticated route permission.'),
      routePermissionDescription: z.string().optional().describe('Optional admin note for created/updated route permission.'),
      description: z.string().optional().describe('Route description.'),
      timeout: z.number().int().positive().optional().describe('Optional handler timeout in ms.'),
      overwrite: z.boolean().optional().default(false).describe('Required to update an existing handler whose sourceCode/scriptLanguage/timeout differs.'),
      smokeTestQuery: z.string().optional().describe('Optional query JSON object for a smoke test, e.g. {"a":"1","b":"2"}.'),
      smokeTestBody: z.string().optional().describe('Optional body JSON object for a smoke test.'),
      apply: z.boolean().optional().default(false).describe('false returns plan only; true applies exactly the next pending step.'),
      applyAll: z.boolean().optional().default(false).describe('true applies all safe pending steps in order. Prefer apply=true for production changes.'),
      stepId: z.string().optional().describe('Optional pending step id to apply. Omit to apply the next pending step.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when apply/applyAll mutates metadata. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required when apply/applyAll reaches the save_handler step. Use dynamicCodeAckKey from get_enfyra_required_knowledge.'),
    },
    async (input) => jsonText(await runApiEndpointWorkflow(ENFYRA_API_URL, input)),
  );

  server.tool(
    'create_api_endpoint',
    [
      'Business operation: create or update a custom REST endpoint with a handler in one safe operation.',
      'Prefer api_endpoint_workflow when route access, role/user permissions, overwrite decisions, or multi-step planning matter.',
      'Use this one-shot helper only when the endpoint contract is already clear and no authenticated route-permission step is needed in the same operation, such as a simple public webhook or private admin-only utility that will be granted separately.',
      'It creates the route without mainTableId, ensures the method is available, validates sourceCode, creates or overwrites the route handler, optionally makes the method public, reloads routes, and can smoke-test the endpoint.',
      'Use table/schema tools separately when the user needs persisted data. This tool is for custom behavior endpoints.',
    ].join(' '),
    {
      path: z.string().describe('Custom route path, e.g. /sum. Must not be a full URL.'),
      method: z.string().describe('HTTP method for the handler, e.g. GET or POST.'),
      sourceCode: z.string().describe('Handler sourceCode. Use macros such as @QUERY, @BODY, @THROW400, @REPOS, @USER. Do not send compiledCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      public: z.boolean().optional().default(false).describe('When true, the method is added to publicMethods for anonymous access.'),
      description: z.string().optional().describe('Route description.'),
      timeout: z.number().int().positive().optional().describe('Optional handler timeout in ms.'),
      overwrite: z.boolean().optional().default(false).describe('If a handler already exists for route+method, false fails; true updates its sourceCode.'),
      smokeTestQuery: z.string().optional().describe('Optional query JSON object for a smoke test after save, e.g. {"a":"1","b":"2"}.'),
      smokeTestBody: z.string().optional().describe('Optional body JSON object for a smoke test after save.'),
      globalRulesAckKey: globalRulesAckParam(z),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
    },
    async ({ path, method, sourceCode, scriptLanguage, public: makePublic, description, timeout, overwrite, smokeTestQuery, smokeTestBody, globalRulesAckKey, knowledgeAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      assertDynamicCodeKnowledgeAck(knowledgeAckKey);
      const normalizedPath = normalizeRestPath(path);
      const methodName = normalizeMethodName(method);
      const { methodMap, methodIdNameMap } = await getMethodContext(ENFYRA_API_URL);
      const methodId = methodMap[methodName];
      if (!methodId) throw new Error(`Unknown method "${methodName}". Valid methods: ${Object.keys(methodMap).sort().join(', ')}`);

      const routes = await fetchAll(ENFYRA_API_URL, '/enfyra_route?limit=1000&fields=id,_id,path,isEnabled,availableMethods.*,publicMethods.*,mainTable.name');
      let route = routes.find((item) => item.path === normalizedPath);
      let routeAction = 'existing';
      if (!route) {
        const createRouteResult = await fetchAPI(ENFYRA_API_URL, '/enfyra_route', {
          method: 'POST',
          body: JSON.stringify({
            path: normalizedPath,
            description,
            isEnabled: true,
            availableMethods: [{ id: methodId }],
            publicMethods: makePublic ? [{ id: methodId }] : [],
          }),
        });
        route = firstDataRecord(createRouteResult);
        routeAction = 'created';
      } else {
        const availableMethods = methodNamesFromRecords(route.availableMethods, methodIdNameMap);
        const publicMethods = methodNamesFromRecords(route.publicMethods, methodIdNameMap);
        const finalAvailable = uniqueMethodNames([...availableMethods, methodName]);
        const finalPublic = makePublic ? uniqueMethodNames([...publicMethods, methodName]) : publicMethods;
        const patchRouteResult = await fetchAPI(ENFYRA_API_URL, `/enfyra_route/${encodeURIComponent(String(getId(route)))}`, {
          method: 'PATCH',
          body: JSON.stringify({
            availableMethods: resolveMethodRefs(methodMap, finalAvailable),
            publicMethods: resolveMethodRefs(methodMap, finalPublic.filter((item) => finalAvailable.includes(item))),
            ...(description !== undefined ? { description } : {}),
          }),
        });
        route = firstDataRecord(patchRouteResult) || route;
        routeAction = 'updated';
      }

      const routeId = getId(route);
      const scriptValidation = await validateScriptSourceIfPresent(fetchAPI, ENFYRA_API_URL, 'enfyra_route_handler', {
        sourceCode,
        scriptLanguage,
      });
      const existingHandler = await findHandler(ENFYRA_API_URL, routeId, methodId);
      let handlerResult;
      let handlerAction;
      if (existingHandler) {
        if (!overwrite) {
          throw new Error(`Handler already exists for ${methodName} ${normalizedPath} with id ${getId(existingHandler)}. Re-run with overwrite=true to update it.`);
        }
        handlerAction = 'updated';
        const body = { sourceCode, scriptLanguage };
        if (timeout !== undefined) body.timeout = timeout;
        handlerResult = await fetchAPI(ENFYRA_API_URL, `/enfyra_route_handler/${encodeURIComponent(String(getId(existingHandler)))}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        handlerAction = 'created';
        const body = {
          route: { id: routeId },
          method: { id: methodId },
          sourceCode,
          scriptLanguage,
        };
        if (timeout !== undefined) body.timeout = timeout;
        handlerResult = await fetchAPI(ENFYRA_API_URL, '/enfyra_route_handler', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }

      const routeReload = await reloadRoutes(ENFYRA_API_URL);
      let smokeTest = null;
      if (smokeTestQuery !== undefined || smokeTestBody !== undefined) {
        const query = smokeTestQuery ? JSON.parse(smokeTestQuery) : {};
        if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('smokeTestQuery must be a JSON object.');
        const queryParams = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined && value !== null) queryParams.set(key, String(value));
        }
        const body = smokeTestBody ? JSON.parse(smokeTestBody) : undefined;
        const smokePath = `${normalizedPath}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
        smokeTest = await fetchAPI(ENFYRA_API_URL, smokePath, {
          method: methodName,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      }

      const savedHandler = firstDataRecord(handlerResult);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            action: 'api_endpoint_ready',
            endpoint: {
              path: normalizedPath,
              method: methodName,
              public: makePublic,
              routeId,
              handlerId: getId(savedHandler) || getId(existingHandler),
            },
            routeAction,
            handlerAction,
            scriptValidation,
            routeReload,
            smokeTest,
            usage: {
              restPath: `${ENFYRA_API_URL.replace(/\/$/, '')}${normalizedPath}`,
              auth: makePublic ? 'anonymous allowed for this method' : 'Bearer auth and route access are required unless another guard bypass applies',
            },
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'ensure_column_rule',
    'Business operation: create or update a column validation rule. It resolves table/column ids and avoids duplicate rules for the same column+ruleType.',
    {
      tableName: z.string().describe('Table name, alias, or id.'),
      columnName: z.string().describe('Column name or id.'),
      ruleType: z.enum(['min', 'max', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'custom']).describe('Validation rule type.'),
      value: z.string().optional().describe('Rule config JSON object, usually {"v": ...}.'),
      message: z.string().optional().describe('Custom validation error message.'),
      description: z.string().optional().describe('Admin note.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable the rule.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ tableName, columnName, ruleType, value, message, description, isEnabled, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      const table = resolveTable(await getMetadataTables(ENFYRA_API_URL), tableName);
      const column = resolveColumn(table, columnName);
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_column_rule', {
        column: { id: { _eq: getId(column) } },
        ruleType: { _eq: ruleType },
      }, 'id,_id,column.id,ruleType');
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_column_rule', existing, {
        column: { id: getId(column) },
        ruleType,
        value: parseJsonObjectArg('value', value, null),
        message,
        description,
        isEnabled,
      });
      return jsonText({
        action: 'column_rule_ensured',
        table: { id: getId(table), name: table.name },
        column: { id: getId(column), name: column.name },
        ruleType,
        operation,
      });
    },
  );

  server.tool(
    'ensure_field_permission',
    'Business operation: create or update one field permission. It resolves table field ids, enforces exactly one column/relation target, and enforces a role/user scope.',
    {
      tableName: z.string().describe('Table name, alias, or id.'),
      columnName: z.string().optional().describe('Column name/id to protect. Use exactly one of columnName or relationName.'),
      relationName: z.string().optional().describe('Relation propertyName/id to protect. Use exactly one of columnName or relationName.'),
      action: z.enum(['read', 'create', 'update']).optional().default('read').describe('Field action.'),
      effect: z.enum(['allow', 'deny']).optional().default('allow').describe('Permission effect.'),
      roleId: z.union([z.string(), z.number()]).optional().describe('Role id scope.'),
      roleName: z.string().optional().describe('Role name scope.'),
      allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Direct user id scope.'),
      condition: z.string().optional().describe('Condition JSON object using field permission DSL.'),
      description: z.string().optional().describe('Admin note.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable the permission.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ tableName, columnName, relationName, action, effect, roleId, roleName, allowedUserIds, condition, description, isEnabled, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      if (!!columnName === !!relationName) throw new Error('Provide exactly one of columnName or relationName.');
      assertOneScope({ roleId, roleName, allowedUserIds });
      const [tables, role] = await Promise.all([
        getMetadataTables(ENFYRA_API_URL),
        resolveRole(ENFYRA_API_URL, { roleId, roleName }),
      ]);
      const table = resolveTable(tables, tableName);
      const field = columnName ? resolveColumn(table, columnName) : resolveRelation(table, relationName);
      const filter = {
        action: { _eq: action },
        effect: { _eq: effect },
        ...(columnName ? { column: { id: { _eq: getId(field) } } } : { relation: { id: { _eq: getId(field) } } }),
        ...(role ? { role: { id: { _eq: role.id } } } : {}),
      };
      const existing = role
        ? await findRecord(ENFYRA_API_URL, 'enfyra_field_permission', filter, 'id,_id,column.id,relation.id,role.id,action,effect')
        : null;
      const body = {
        action,
        effect,
        isEnabled,
        description,
        condition: parseJsonObjectArg('condition', condition, null),
        ...(columnName ? { column: { id: getId(field) } } : { relation: { id: getId(field) } }),
        ...(role ? { role: { id: role.id } } : {}),
        ...(allowedUserIds?.length ? { allowedUsers: allowedUserIds.map((id) => ({ id })) } : {}),
      };
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_field_permission', existing, body);
      const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/metadata');
      return jsonText({
        action: 'field_permission_ensured',
        table: { id: getId(table), name: table.name },
        field: { id: getId(field), name: columnName ? field.name : field.propertyName, kind: columnName ? 'column' : 'relation' },
        scope: { role, allowedUserIds: allowedUserIds || [] },
        operation,
        reload,
      });
    },
  );

  server.tool(
    'ensure_guard',
    'Business operation: create or update a request guard and optional guard rules. It resolves route/method ids and prevents pre_auth user-based rules.',
    {
      name: z.string().describe('Guard name. Existing guard with this name is updated unless guardId is provided.'),
      guardId: z.union([z.string(), z.number()]).optional().describe('Optional existing guard id.'),
      position: z.enum(['pre_auth', 'post_auth']).optional().default('pre_auth').describe('Guard position.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Optional route id.'),
      path: z.string().optional().describe('Optional route path.'),
      methods: z.array(z.string()).optional().describe('HTTP method names.'),
      combinator: z.enum(['and', 'or']).optional().default('and').describe('Rule combinator.'),
      priority: z.number().optional().default(0).describe('Lower runs earlier.'),
      isGlobal: z.boolean().optional().default(false).describe('Apply globally.'),
      isEnabled: z.boolean().optional().default(false).describe('Enable guard. Defaults false to avoid lockout.'),
      description: z.string().optional().describe('Admin note.'),
      rules: z.string().optional().describe('Rules JSON array: [{type, config, priority, isEnabled, description, userIds}].'),
      rulesMode: z.enum(['append', 'replace', 'none']).optional().default('append').describe('append creates rules, replace disables existing rules first, none leaves rules unchanged.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ name, guardId, position, routeId, path, methods, combinator, priority, isGlobal, isEnabled, description, rules, rulesMode, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      if (path && routeId) throw new Error('Provide path or routeId, not both.');
      const ruleInputs = parseJsonArrayArg('rules', rules, []);
      if (position === 'pre_auth') {
        const invalid = ruleInputs.filter((rule) => rule.type === 'rate_limit_by_user' || (Array.isArray(rule.userIds) && rule.userIds.length));
        if (invalid.length) throw new Error('pre_auth guards cannot use user-based rules or userIds. Use post_auth.');
      }
      let route = null;
      if (!isGlobal && (routeId || path)) {
        route = (await resolveRoute(ENFYRA_API_URL, { path, routeId })).route;
      }
      const { methodMap } = await getMethodContext(ENFYRA_API_URL);
      const existing = guardId
        ? await findRecord(ENFYRA_API_URL, 'enfyra_guard', { id: { _eq: guardId } }, 'id,_id,name')
        : await findRecord(ENFYRA_API_URL, 'enfyra_guard', { name: { _eq: name } }, 'id,_id,name');
      const guardBody = {
        name,
        position,
        combinator,
        priority,
        isGlobal,
        isEnabled,
        description,
        ...(route ? { route: { id: getId(route) } } : {}),
        ...(methods?.length ? { methods: resolveMethodRefs(methodMap, methods) } : {}),
      };
      const guardOperation = await createOrPatch(ENFYRA_API_URL, 'enfyra_guard', existing, guardBody);
      const resolvedGuardId = guardOperation.id || getId(existing);
      const existingRules = rulesMode === 'replace'
        ? await fetchRecords(ENFYRA_API_URL, 'enfyra_guard_rule', { guard: { id: { _eq: resolvedGuardId } } }, 'id,_id,isEnabled')
        : [];
      const disabledRules = [];
      for (const rule of existingRules) {
        disabledRules.push(await fetchAPI(ENFYRA_API_URL, `/enfyra_guard_rule/${encodeURIComponent(String(getId(rule)))}`, {
          method: 'PATCH',
          body: JSON.stringify({ isEnabled: false }),
        }));
      }
      const createdRules = [];
      if (rulesMode !== 'none') {
        for (const rule of ruleInputs) {
          createdRules.push(await fetchAPI(ENFYRA_API_URL, '/enfyra_guard_rule', {
            method: 'POST',
            body: JSON.stringify({
              type: rule.type,
              config: rule.config,
              priority: rule.priority ?? 0,
              isEnabled: rule.isEnabled ?? true,
              description: rule.description,
              guard: { id: resolvedGuardId },
              ...(Array.isArray(rule.userIds) && rule.userIds.length ? { users: rule.userIds.map((id) => ({ id })) } : {}),
            }),
          }));
        }
      }
      const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/guards');
      return jsonText({
        action: 'guard_ensured',
        guard: { id: resolvedGuardId, name, route: route ? route.path : null, isGlobal },
        guardOperation,
        disabledRuleCount: disabledRules.length,
        createdRuleCount: createdRules.length,
        reload,
      });
    },
  );

  server.tool(
    'ensure_websocket_gateway',
    'Business operation: create or update an Enfyra Socket.IO gateway. Connection handler sourceCode is validated before save.',
    {
      path: z.string().describe('Gateway namespace/path, e.g. /chat.'),
      sourceCode: z.string().optional().describe('Optional connection handler dynamic script sourceCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language for connection handler.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable gateway.'),
      description: z.string().optional().describe('Admin note.'),
      globalRulesAckKey: globalRulesAckParam(z),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required when sourceCode is provided. Use dynamicCodeAckKey from get_enfyra_required_knowledge.'),
    },
    async ({ path, sourceCode, scriptLanguage, isEnabled, description, globalRulesAckKey, knowledgeAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      assertDynamicCodeKnowledgeAckIf(sourceCode !== undefined, knowledgeAckKey);
      const normalizedPath = normalizeRestPath(path);
      const validation = sourceCode === undefined
        ? { validated: false, reason: 'no sourceCode' }
        : await validateDynamicScript(ENFYRA_API_URL, sourceCode, scriptLanguage);
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { path: { _eq: normalizedPath } }, 'id,_id,path');
      const body = {
        path: normalizedPath,
        isEnabled,
        description,
        ...(sourceCode !== undefined ? { sourceCode, scriptLanguage } : {}),
      };
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_websocket', existing, body);
      const reload = naturalPartialReload('Websocket metadata writes trigger the server partial reload contract; there is no dedicated websocket reload endpoint.');
      return jsonText({ action: 'websocket_gateway_ensured', gateway: { id: operation.id, path: normalizedPath }, validation, operation, reload });
    },
  );

  server.tool(
    'ensure_websocket_event',
    'Business operation: create or update one websocket event handler. It resolves gateway path/id and validates sourceCode before save.',
    {
      gatewayPath: z.string().optional().describe('Gateway path, e.g. /chat. Use gatewayPath or gatewayId.'),
      gatewayId: z.union([z.string(), z.number()]).optional().describe('Gateway id. Use gatewayPath or gatewayId.'),
      eventName: z.string().describe('Socket event name.'),
      sourceCode: z.string().describe('Event handler dynamic script sourceCode.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable event.'),
      description: z.string().optional().describe('Admin note.'),
      globalRulesAckKey: globalRulesAckParam(z),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
    },
    async ({ gatewayPath, gatewayId, eventName, sourceCode, scriptLanguage, isEnabled, description, globalRulesAckKey, knowledgeAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      assertDynamicCodeKnowledgeAck(knowledgeAckKey);
      if (!gatewayPath && !gatewayId) throw new Error('Provide gatewayPath or gatewayId.');
      if (gatewayPath && gatewayId) throw new Error('Provide gatewayPath or gatewayId, not both.');
      const gateway = gatewayId
        ? await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { id: { _eq: gatewayId } }, 'id,_id,path')
        : await findRecord(ENFYRA_API_URL, 'enfyra_websocket', { path: { _eq: normalizeRestPath(gatewayPath) } }, 'id,_id,path');
      if (!gateway) throw new Error(`Websocket gateway not found: ${gatewayId || gatewayPath}`);
      const validation = await validateDynamicScript(ENFYRA_API_URL, sourceCode, scriptLanguage);
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_websocket_event', {
        gateway: { id: { _eq: getId(gateway) } },
        eventName: { _eq: eventName },
      }, 'id,_id,eventName,gateway.id');
      const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_websocket_event', existing, {
        gateway: { id: getId(gateway) },
        eventName,
        sourceCode,
        scriptLanguage,
        isEnabled,
        description,
      });
      const reload = naturalPartialReload('Websocket event writes trigger the server partial reload contract; there is no dedicated websocket reload endpoint.');
      return jsonText({ action: 'websocket_event_ensured', gateway: { id: getId(gateway), path: gateway.path }, eventName, validation, operation, reload });
    },
  );

  server.tool(
    'ensure_manual_flow',
    'Business operation: create or update a manually triggered Enfyra flow. Use this when the flow is run by API, admin action, another flow, or hook.',
    {
      name: z.string().describe('Flow name. Existing flow with this name is updated.'),
      timeout: z.number().int().positive().optional().describe('Flow timeout in ms.'),
      maxExecutions: z.number().int().positive().optional().default(100).describe('Execution history cap.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable flow.'),
      description: z.string().optional().describe('Admin note.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ name, timeout, maxExecutions, isEnabled, description, globalRulesAckKey }) => jsonText(await ensureFlow(ENFYRA_API_URL, {
      name,
      triggerType: 'manual',
      timeout,
      maxExecutions,
      isEnabled,
      description,
      globalRulesAckKey,
    })),
  );

  server.tool(
    'ensure_scheduled_flow',
    'Business operation: create or update a scheduled Enfyra flow. Use this only for cron/time-based flows.',
    {
      name: z.string().describe('Flow name. Existing flow with this name is updated.'),
      triggerConfig: z.string().describe('Schedule config JSON object.'),
      timeout: z.number().int().positive().optional().describe('Flow timeout in ms.'),
      maxExecutions: z.number().int().positive().optional().default(100).describe('Execution history cap.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable flow.'),
      description: z.string().optional().describe('Admin note.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ name, triggerConfig, timeout, maxExecutions, isEnabled, description, globalRulesAckKey }) => jsonText(await ensureFlow(ENFYRA_API_URL, {
      name,
      triggerType: 'schedule',
      triggerConfig,
      timeout,
      maxExecutions,
      isEnabled,
      description,
      globalRulesAckKey,
    })),
  );

  server.tool(
    'choose_flow_step_tool',
    'Dry-run helper: choose the most specific Enfyra flow step tool for one intended step before mutating flow metadata.',
    {
      intent: z.string().describe('Plain-language description of what this one flow step should do.'),
    },
    async ({ intent }) => {
      const recommendation = chooseFlowStepTool(intent);
      return jsonText({
        action: 'flow_step_tool_recommended',
        intent,
        recommendation,
        availableStepTools: FLOW_STEP_TOOL_GUIDANCE,
        nextSteps: [
          `Call ${recommendation.tool} with a stable key and order.`,
          'Use ensure_script_flow_step only when the atomic tools cannot express the behavior.',
          'After saving script or condition steps, use test_flow_step before relying on the flow.',
        ],
      });
    },
  );

  server.tool(
    'ensure_script_flow_step',
    'Business operation: create or update one script flow step. Use this for JavaScript/TypeScript flow logic instead of choosing type=script manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      sourceCode: z.string().describe('Script sourceCode.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      config: z.string().optional().describe('Step config JSON object.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      globalRulesAckKey: globalRulesAckParam(z),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'script',
    })),
  );

  server.tool(
    'ensure_condition_flow_step',
    'Business operation: create or update one condition flow step. Use this for dynamic conditional branching instead of choosing type=condition manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      sourceCode: z.string().describe('Condition sourceCode.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      config: z.string().optional().describe('Step config JSON object.'),
      scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      globalRulesAckKey: globalRulesAckParam(z),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'condition',
    })),
  );

  server.tool(
    'ensure_query_flow_step',
    'Business operation: create or update one query flow step. Use this for repository/query-style flow steps instead of choosing type=query manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'query',
    })),
  );

  server.tool(
    'ensure_http_flow_step',
    'Business operation: create or update one HTTP flow step. Use this for outbound HTTP calls instead of choosing type=http manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'http',
    })),
  );

  server.tool(
    'ensure_create_flow_step',
    'Business operation: create or update one create-record flow step. Use this for a single table insert instead of writing script code.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object: { "table": "...", "data": { ... } }.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'create',
    })),
  );

  server.tool(
    'ensure_update_flow_step',
    'Business operation: create or update one update-record flow step. Use this for a single table update by id instead of writing script code.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object: { "table": "...", "id": "...", "data": { ... } }.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'update',
    })),
  );

  server.tool(
    'ensure_delete_flow_step',
    'Business operation: create or update one delete-record flow step. Use this for a single table delete by id instead of writing script code.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object: { "table": "...", "id": "..." }.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'delete',
    })),
  );

  server.tool(
    'ensure_sleep_flow_step',
    'Business operation: create or update one sleep/wait flow step. Use this for delays instead of choosing type=sleep manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'sleep',
    })),
  );

  server.tool(
    'ensure_log_flow_step',
    'Business operation: create or update one log flow step. Use this for lightweight execution diagnostics instead of script code.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object: { "message": "..." }.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'log',
    })),
  );

  server.tool(
    'ensure_trigger_flow_step',
    'Business operation: create or update one child-flow trigger step. Use this for flow-to-flow orchestration instead of choosing type=trigger_flow manually.',
    {
      flowName: z.string().optional().describe('Flow name. Use flowName or flowId.'),
      flowId: z.union([z.string(), z.number()]).optional().describe('Flow id. Use flowName or flowId.'),
      key: z.string().describe('Stable step key. Existing step with flow+key is updated.'),
      config: z.string().describe('Step config JSON object.'),
      order: z.number().optional().default(0).describe('Step order. Saved as enfyra_flow_step.stepOrder.'),
      timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText(await ensureFlowStep(ENFYRA_API_URL, {
      ...input,
      type: 'trigger_flow',
    })),
  );

  server.tool(
    'ensure_menu',
    'Business operation: create or update one admin menu item. Use this instead of raw enfyra_menu CRUD.',
    {
      label: z.string().describe('Menu label.'),
      path: z.string().optional().describe('Admin app route path for leaf menu items, e.g. /reports.'),
      icon: z.string().optional().describe('Menu icon name.'),
      type: z.enum(['Menu', 'Dropdown Menu']).optional().default('Menu').describe('Menu type.'),
      order: z.number().optional().default(0).describe('Display order.'),
      permission: z.string().optional().describe('Menu permission JSON object.'),
      description: z.string().optional().describe('Admin note.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable menu.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText({
      action: 'menu_ensured',
      menu: await ensureMenu(ENFYRA_API_URL, input),
    }),
  );

  server.tool(
    'reorder_menus',
    [
      'Business operation: reorder Enfyra admin menus and optionally move menus under a new parent.',
      'Uses the server /admin/menu/reorder route introduced in Enfyra 2.2.6 instead of PATCHing each enfyra_menu record.',
      'The server validates duplicate ids, non-negative integer order, dropdown-only parents, /data child restrictions, system menu parent locks, cycle prevention, persistence, and menu cache invalidation.',
    ].join(' '),
    {
      updates: z.array(z.object({
        id: z.union([z.string(), z.number()]).describe('Menu id to reorder.'),
        order: z.number().int().nonnegative().describe('Sibling order index. Must be a non-negative integer.'),
        parent: z.union([z.string(), z.number(), z.null()]).optional().describe('New parent menu id, or null for a root menu. Parent must be a Dropdown Menu.'),
      })).min(1).describe('Menu order/parent updates, usually the changed siblings from drag-and-drop.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async (input) => jsonText(await reorderMenus(ENFYRA_API_URL, input)),
  );

  server.tool(
    'ensure_page_extension',
    'Business operation: create or update one page extension attached to an existing menu. Validates extension code before save. Call get_extension_theme_contract first for UI work.',
    {
      name: z.string().describe('Extension unique name.'),
      code: z.string().describe('Vue SFC extension code.'),
      menuId: z.union([z.string(), z.number()]).describe('Existing menu id for this page extension.'),
      description: z.string().optional().describe('Extension description.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
      version: z.string().optional().default('1.0.0').describe('Extension version.'),
      globalRulesAckKey: globalRulesAckParam(z),
      extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
    },
    async (input) => jsonText({
      action: 'page_extension_ensured',
      extension: await ensureExtension(ENFYRA_API_URL, { ...input, type: 'page' }),
    }),
  );

  server.tool(
    'ensure_global_extension',
    'Business operation: create or update one global shell extension. Validates extension code before save and rejects menu coupling. Call get_extension_theme_contract first for UI work.',
    {
      name: z.string().describe('Extension unique name.'),
      code: z.string().describe('Vue SFC extension code.'),
      description: z.string().optional().describe('Extension description.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
      version: z.string().optional().default('1.0.0').describe('Extension version.'),
      globalRulesAckKey: globalRulesAckParam(z),
      extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
    },
    async (input) => jsonText({
      action: 'global_extension_ensured',
      extension: await ensureExtension(ENFYRA_API_URL, { ...input, type: 'global' }),
    }),
  );

  server.tool(
    'ensure_widget_extension',
    'Business operation: create or update one widget extension. Validates extension code before save and rejects menu coupling. Call get_extension_theme_contract first for UI work.',
    {
      name: z.string().describe('Extension unique name.'),
      code: z.string().describe('Vue SFC extension code.'),
      description: z.string().optional().describe('Extension description.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
      version: z.string().optional().default('1.0.0').describe('Extension version.'),
      globalRulesAckKey: globalRulesAckParam(z),
      extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
    },
    async (input) => jsonText({
      action: 'widget_extension_ensured',
      extension: await ensureExtension(ENFYRA_API_URL, { ...input, type: 'widget' }),
    }),
  );

}
