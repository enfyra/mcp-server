import { z } from 'zod';
import { createHash } from 'node:crypto';

import { fetchAPI } from './fetch.js';
import { fetchTableCatalog, fetchTableMetadataByRef, resolveTableCatalogEntry } from './metadata-client.js';
import { validatePortableScriptSource, validateScriptSourceIfPresent } from './mutation-guards.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAck,
  assertGlobalRulesAck,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';

type AnyRecord = Record<string, any>;
type MethodMap = Record<string, string | number>;
type MethodIdNameMap = Record<string, string>;
type RouteMethodBody = {
  availableMethods: Array<{ id: string | number }>;
  publicMethods: Array<{ id: string | number }>;
  isEnabled?: boolean;
};
type FlowStepBody = {
  key: any;
  type: any;
  stepOrder: any;
  config: any;
  timeout: any;
  isEnabled: any;
  flow: { id: any };
  sourceCode?: any;
  scriptLanguage?: any;
};
type HandlerBody = {
  sourceCode: any;
  scriptLanguage: any;
  timeout?: any;
};
type RouteHandlerBody = HandlerBody & {
  route: { id: any };
  method: { id: any };
};
type WorkflowNextStep = {
  tool: string;
  input: AnyRecord;
  reason?: string;
  stepId?: string;
  requiresKnowledgeAck?: string;
  requiredAckParams?: string[];
};

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
const AUTO_INJECTED_EXTENSION_COMPONENT_BY_LOWERCASE = new Map(
  AUTO_INJECTED_EXTENSION_COMPONENT_TAGS.map((tag) => [tag.toLowerCase(), tag]),
);
const FULL_WIDTH_EXTENSION_FIELD_TAGS = [
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

function normalizeMethodName(method): string {
  const value = String(method || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid method "${method}". Method names must start with A-Z and contain only A-Z, 0-9, or underscore.`);
  }
  return value;
}

function methodNamesFromRecords(records, methodIdNameMap): string[] {
  return (records || [])
    .map((method) => method?.name || methodIdNameMap[String(getId(method))] || null)
    .filter(Boolean)
    .map(normalizeMethodName);
}

function uniqueMethodNames(names): string[] {
  return Array.from(new Set<string>((names || []).map((name) => normalizeMethodName(name))));
}

function resolveMethodRefs(methodMap: MethodMap, names): Array<{ id: string | number }> {
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
  const methodMap: MethodMap = {};
  const methodIdNameMap: MethodIdNameMap = {};
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
  const body: RouteMethodBody = {
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

function escapeSingleQuoted(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function quoteJsString(value) {
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
  const snippet = [
    '<CommonResourceListFrame',
    `  :loading="${input.loadingExpression || 'pending'}"`,
    `  :has-items="${itemsExpression}.length > 0"`,
    `  :total="${input.totalExpression || `${itemsExpression}.length`}"`,
    `  :items-per-page="${input.itemsPerPageExpression || '0'}"`,
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
  return {
    action: 'extension_resource_list_built',
    components: ['CommonResourceListFrame', 'CommonResourceListItem'],
    snippet,
    contract: [
      'Use CommonResourceListFrame and CommonResourceListItem for operational lists instead of ad hoc cards.',
      'CommonResourceListFrame supports extension default slots. It renders rows when loading is false and hasItems is true; inspect the source artifact, hasItems/items expressions, and API response shape before replacing it.',
      'Keep first-load skeleton, empty state, and pagination owned by the frame.',
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

function toPascalIdentifier(value, fallback = 'Items') {
  const raw = String(value || fallback)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
  return raw || fallback;
}

function buildExtensionSort(sort: unknown): string | undefined {
  if (!Array.isArray(sort) || sort.length === 0) return undefined;
  const fields = sort.map((entry) => {
    const field = String((entry as AnyRecord)?.field || '').trim();
    if (!field) throw new Error('Each extension sort entry requires a field.');
    return String((entry as AnyRecord)?.direction || 'asc').toLowerCase() === 'desc'
      ? `-${field}`
      : field;
  });
  return fields.join(',');
}

export function buildExtensionApiUsageSnippet(input: AnyRecord = {}) {
  const resource = String(input.resource || input.name || 'items');
  const pascal = toPascalIdentifier(resource, 'Items');
  const operation = String(input.operation || input.mode || input.intent || '').toLowerCase() || String(input.method || 'GET').toLowerCase();
  const normalizedOperation = ({
    get: 'list',
    read: 'list',
    load: 'list',
    post: 'create',
    patch: 'update',
    put: 'update',
    del: 'delete',
    remove: 'delete',
    destroy: 'delete',
  } as Record<string, string>)[operation] || operation;
  const defaultMethodByOperation: Record<string, string> = {
    list: 'GET',
    find_one: 'GET',
    create: 'POST',
    update: 'PATCH',
    delete: 'DELETE',
    batch_update: 'PATCH',
    batch_delete: 'DELETE',
  };
  const method = String(input.method || defaultMethodByOperation[normalizedOperation] || 'GET').toUpperCase();
  const rawPath = String(input.path || `/${resource}`);
  const path = rawPath.replace(/\/:id\/?$/, '');
  const responseName = input.responseName || `${resource}Response`;
  const pendingName = input.pendingName || `${resource}Pending`;
  const errorName = input.errorName || `${resource}Error`;
  const executeName = input.executeName || (method === 'GET' ? `load${pascal}` : `${normalizedOperation.replace(/(^|_)([a-z])/g, (_m, _p, ch) => ch.toUpperCase()).replace(/^./, (ch) => ch.toLowerCase())}${pascal}Api`);
  const refreshName = input.refreshName || `refresh${pascal}`;
  const sort = buildExtensionSort(input.sort);
  const rawQuery = input.query && typeof input.query === 'object' && !Array.isArray(input.query)
    ? input.query
    : null;
  if (rawQuery?.sort !== undefined && !sort) {
    throw new Error('Pass extension sort through the structured sort input, not query.sort.');
  }
  const structuredQuery = rawQuery || sort
    ? { ...(rawQuery || {}), ...(sort ? { sort } : {}) }
    : null;
  if (structuredQuery && input.queryExpression) {
    throw new Error('Pass either query or queryExpression to build_extension_api_usage, not both. Use structured query plus sort for Enfyra REST ordering.');
  }
  const queryName = input.queryName || `${resource}Query`;
  const queryExpression = structuredQuery ? queryName : input.queryExpression;
  const options: string[] = [];
  if (method !== 'GET') options.push(`method: ${quoteJsString(method)}`);
  if (queryExpression) options.push(`query: ${queryExpression}`);
  if (input.bodyExpression) options.push(`body: ${input.bodyExpression}`);
  if (input.errorContext) options.push(`errorContext: ${quoteJsString(input.errorContext)}`);
  if (input.onErrorExpression) options.push(`onError: ${input.onErrorExpression}`);
  const optionsLiteral = options.length ? `, {\n  ${options.join(',\n  ')}\n}` : '';
  const lines = [
    ...(structuredQuery ? [`const ${queryName} = computed(() => (${JSON.stringify(structuredQuery, null, 2)}));`, ''] : []),
    `const { data: ${responseName}, pending: ${pendingName}, error: ${errorName}, execute: ${executeName}, refresh: ${refreshName} } = useApi(${quoteJsString(path)}${optionsLiteral});`,
  ];
  if (method === 'GET') {
    const rowsName = input.rowsName || resource;
    lines.push(`const ${rowsName} = computed(() => ${responseName}.value?.data || []);`);
    if (input.autoLoad !== false) {
      lines.push(`onMounted(() => { ${executeName}(); });`);
    }
  } else if (normalizedOperation === 'create') {
    const handlerName = input.handlerName || `create${pascal.replace(/s$/, '')}`;
    const payloadName = input.payloadName || 'payload';
    lines.push(...[
      '',
      `async function ${handlerName}(${payloadName}) {`,
      `  const response = await ${executeName}({ body: ${payloadName} });`,
      '  if (!response) return null;',
      '  return response;',
      '}',
    ]);
  } else if (normalizedOperation === 'update') {
    const handlerName = input.handlerName || `update${pascal.replace(/s$/, '')}`;
    const recordName = input.recordName || 'record';
    const bodyName = input.bodyName || 'body';
    const idExpression = input.idExpression || `${recordName}.id`;
    const bodyArg = bodyName === 'body' ? 'body' : `body: ${bodyName}`;
    lines.push(...[
      '',
      `async function ${handlerName}(${recordName}, ${bodyName}) {`,
      `  const response = await ${executeName}({ id: ${idExpression}, ${bodyArg} });`,
      '  if (!response) return null;',
      '  return response;',
      '}',
    ]);
  } else if (normalizedOperation === 'delete') {
    const handlerName = input.handlerName || `delete${pascal.replace(/s$/, '')}`;
    const recordName = input.recordName || 'record';
    const idExpression = input.idExpression || `${recordName}.id`;
    lines.push(...[
      '',
      `async function ${handlerName}(${recordName}) {`,
      `  const response = await ${executeName}({ id: ${idExpression} });`,
      '  if (!response) return null;',
      '  return response;',
      '}',
    ]);
  } else if (normalizedOperation === 'batch_update' || normalizedOperation === 'batch_delete') {
    const handlerName = input.handlerName || `${normalizedOperation === 'batch_update' ? 'update' : 'delete'}${pascal}Batch`;
    const idsName = input.idsName || 'ids';
    const bodyName = input.bodyName || 'body';
    const args = normalizedOperation === 'batch_update' ? `{ ids: ${idsName}, body: ${bodyName} }` : `{ ids: ${idsName} }`;
    lines.push(...[
      '',
      `async function ${handlerName}(${normalizedOperation === 'batch_update' ? `${idsName}, ${bodyName}` : idsName}) {`,
      `  const response = await ${executeName}(${args});`,
      '  if (!response) return null;',
      '  return response;',
      '}',
    ]);
  } else {
    const handlerName = input.handlerName || `${method.toLowerCase()}${pascal}Record`;
    lines.push(...[
      '',
      `async function ${handlerName}(payload) {`,
      `  const response = await ${executeName}({ body: payload });`,
      '  if (!response) return null;',
      '  return response;',
      '}',
    ]);
  }
  return {
    action: 'extension_api_usage_built',
    operation: normalizedOperation,
    snippet: lines.join('\n'),
    contract: [
      'useApi returns refs plus execute/refresh; it does not auto-run.',
      'The useApi path is the base route string or a () => string getter; do not pass computed refs and do not put :id placeholders in the path.',
      'Pass query/body as objects or computed objects, not JSON.stringify strings.',
      'For Enfyra REST ordering, use structured sort entries with field and direction; the generated query always emits one comma-separated sort string such as "-isPinned,-updatedAt", never sort arrays or field:DESC tokens.',
      'Read normal list rows from data.value?.data or from the direct execute() response.',
      'For mutations, call execute({ body }), execute({ id, body }), execute({ id }), or execute({ ids }) from a user action.',
    ],
  };
}

export function buildExtensionNotifySnippet(input: AnyRecord = {}) {
  const kind = ['success', 'error', 'warning', 'info'].includes(input.kind) ? input.kind : 'success';
  const title = input.title || (kind === 'success' ? 'Saved' : 'Notice');
  const description = input.description || '';
  const args = description ? `${quoteJsString(title)}, ${quoteJsString(description)}` : quoteJsString(title);
  return {
    action: 'extension_notify_usage_built',
    snippet: [
      'const notify = useNotify();',
      `await notify.${kind}(${args});`,
    ].join('\n'),
    contract: [
      'useNotify exposes success/error/warning/info(title, description?) helpers.',
      'Do not pass Nuxt toast object payloads and do not call notify.add().',
      'The helpers are async; await them inside submit/mutation handlers when ordering matters.',
    ],
  };
}

export function buildExtensionConfirmSnippet(input: AnyRecord = {}) {
  const resource = String(input.resource || 'items');
  const singular = resource.replace(/s$/i, '') || 'item';
  const pascal = toPascalIdentifier(resource, 'Items');
  const recordName = input.recordName || singular;
  const handlerName = input.handlerName || `confirmDelete${toPascalIdentifier(singular, 'Item')}`;
  const executeName = input.executeName || `delete${pascal}Api`;
  const refreshName = input.refreshName || `refresh${pascal}`;
  const idExpression = input.idExpression || `${recordName}.id`;
  const title = input.title || `Delete ${singular}`;
  const contentExpression = input.contentExpression || `\`Delete "\${${recordName}.title || 'this ${singular}'}"?\``;
  const confirmText = input.confirmText || 'Delete';
  const cancelText = input.cancelText || 'Cancel';
  const mutationExpression = input.mutationExpression || `${executeName}({ id: ${idExpression} })`;
  const refresh = input.refresh === false ? null : input.refreshExpression || refreshName;

  return {
    action: 'extension_confirm_workflow_built',
    snippet: [
      'const { confirm } = useConfirm();',
      '',
      `async function ${handlerName}(${recordName}) {`,
      '  const confirmed = await confirm({',
      `    title: ${quoteJsString(title)},`,
      `    content: ${contentExpression},`,
      `    confirmText: ${quoteJsString(confirmText)},`,
      `    cancelText: ${quoteJsString(cancelText)},`,
      '  });',
      '  if (!confirmed) return null;',
      '',
      `  const response = await ${mutationExpression};`,
      '  if (!response) return null;',
      ...(refresh ? ['', `  await ${refresh}();`] : []),
      '  return response;',
      '}',
    ].join('\n'),
    contract: [
      'useConfirm() opens the eApp GlobalConfirm/CommonModal and resolves true only after the user accepts.',
      'Run the destructive mutation only after confirmed is true, then refresh the affected resource list when needed.',
      'Never use window.confirm, window.alert, alert, or prompt in an extension.',
      'Use CommonModal directly only when the confirmation needs form fields, richer detail, or a custom destructive workflow that useConfirm cannot express.',
    ],
  };
}

export function reviewExtensionUiContract(code) {
  const source = String(code || '');
  const issues: Array<{ severity: 'error' | 'warning'; rule: string; message: string; suggestion: string }> = [];
  const push = (severity, rule, message, suggestion) => issues.push({ severity, rule, message, suggestion });

  if (/<CommonDrawer\b[^>]*(?:\s:title=|\stitle=)/.test(source)) {
    push('error', 'common-drawer-slots', 'CommonDrawer should not use title/:title props in generated extensions.', 'Use #header with a heading, and #body for content.');
  }
  if (/<(?:CommonModal|UModal)\b[^>]*(?:\s:title=|\stitle=)/.test(source)) {
    push('error', 'common-modal-slots', 'CommonModal/UModal should not use title/:title props in generated extensions.', 'Use #header with a heading, and #body for content.');
  }
  if (/<CommonDrawer\b/.test(source) && !/primary-action=/.test(source)) {
    push('warning', 'drawer-primary-action', 'CommonDrawer has no primaryAction.', 'Editing/create drawers should wire Save/Create through primaryAction.');
  }
  if (/<CommonDrawer\b/.test(source) && !/cancel-action=/.test(source)) {
    push('warning', 'drawer-cancel-action', 'CommonDrawer has no cancelAction.', 'Use cancelAction for the ordinary Cancel footer button unless the workflow intentionally has no cancel.');
  }
  if (/<(?:CommonModal|UModal)\b/.test(source) && /delete|remove|confirm|cannot be undone/i.test(source) && !/danger-action=/.test(source)) {
    push('warning', 'modal-danger-action', 'Destructive/confirmation modal has no dangerAction.', 'Wire the final destructive action through dangerAction.');
  }
  const fieldPattern = /<(UInput|UTextarea|USelectMenu|USelect)(\s[^<>]*?)\/?>/g;
  let fieldMatch;
  while ((fieldMatch = fieldPattern.exec(source))) {
    const [, tag, attrs] = fieldMatch;
    const classMatch = attrs.match(/\bclass="([^"]*)"/);
    if (!classMatch || !classMatch[1].split(/\s+/).includes('w-full')) {
      push('warning', 'modal-drawer-field-width', `${tag} is missing class="w-full".`, 'Use class="w-full" for form controls inside modal/drawer body forms unless intentionally inline.');
    }
  }
  const buttonPattern = /<button(\s[^>]*)?>/g;
  let buttonMatch;
  while ((buttonMatch = buttonPattern.exec(source))) {
    if (!/\btype=/.test(buttonMatch[1] || '')) {
      push('warning', 'native-button-type', 'Native button is missing type="button".', 'Add type="button" unless the button intentionally submits a form.');
    }
  }
  return {
    action: 'extension_ui_contract_reviewed',
    valid: issues.every((issue) => issue.severity !== 'error'),
    issueCount: issues.length,
    issues,
    nextSteps: issues.length
      ? ['Use build_extension_ui with kind=drawer or kind=modal for replacement snippets, then apply with patch_extension_code/update_extension_code.']
      : ['Snippet matches the checked modal/drawer contract rules. Still validate the final SFC before saving.'],
  };
}

function collectExtensionRuntimeIssues(code) {
  const source = String(code || '');
  const issues: Array<{ severity: 'error' | 'warning'; rule: string; message: string; suggestion: string }> = [];
  const push = (severity, rule, message, suggestion) => issues.push({ severity, rule, message, suggestion });

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
  if (/<(?:CommonModal|UModal)\b[^>]*\bv-model\s*=/.test(source)) {
    push('error', 'modal-open-model', 'CommonModal/UModal must bind v-model:open, not the default v-model contract.', 'Call build_extension_ui kind=modal and preserve its v-model:open binding.');
  }
  if (/<CommonEmptyState\b/.test(source)) {
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

const THEME_CLASS_INTENTS = {
  neutral_surface: {
    classes: 'eapp-surface-card eapp-radius-panel border eapp-divider',
    use: 'Ordinary cards, panels, KPI containers, list containers, detail blocks, and status blocks that should stay neutral.',
  },
  muted_surface: {
    classes: 'eapp-surface-muted eapp-radius-panel',
    use: 'Recessed areas, tracks, secondary panels, or subdued containers.',
  },
  flat_surface: {
    classes: 'eapp-surface-flat',
    use: 'Flush content areas that should follow the app surface without card chrome.',
  },
  hover_row: {
    classes: 'eapp-surface-hover eapp-divider',
    use: 'Clickable rows inside lists or tables.',
  },
  primary_identity: {
    classes: 'eapp-primary-surface eapp-radius-panel border',
    use: 'A selected/current entity, active plan, active package, or the single larger block representing current identity.',
  },
  primary_soft_icon_tile: {
    classes: 'eapp-primary-soft eapp-icon-tile',
    childClasses: 'eapp-primary-text',
    use: 'Compact runtime-primary icon tiles, selected chips, and small identity accents.',
  },
  primary_progress: {
    trackClasses: 'eapp-surface-muted eapp-radius-pill',
    fillClasses: 'eapp-primary-solid',
    use: 'Progress or meter fill controlled by the runtime primary color.',
  },
  status_success: {
    classes: 'eapp-status-success-soft eapp-status-success-text eapp-status-success-border',
    nuxtUi: { color: 'success', variant: 'soft' },
    use: 'Small success/healthy badges, chips, or icons only.',
  },
  status_warning: {
    classes: 'eapp-status-warning-soft eapp-status-warning-text eapp-status-warning-border',
    nuxtUi: { color: 'warning', variant: 'soft' },
    use: 'Small warning/attention badges, chips, or icons only.',
  },
  status_danger: {
    classes: 'eapp-status-danger-soft eapp-status-danger-text eapp-status-danger-border',
    nuxtUi: { color: 'error', variant: 'soft' },
    use: 'Small danger/error/destructive badges, chips, or icons only.',
  },
  status_info: {
    classes: 'eapp-status-info-soft eapp-status-info-text eapp-status-info-border',
    nuxtUi: { color: 'info', variant: 'soft' },
    use: 'Small informational badges, chips, or icons only.',
  },
  primary_action: {
    nuxtUi: { color: 'primary', variant: 'solid' },
    use: 'The single main action for the current scope.',
  },
  secondary_action: {
    nuxtUi: { color: 'neutral', variant: 'outline' },
    use: 'Visible secondary actions, refresh, filters, cancel, and navigation alternatives.',
  },
  ghost_navigation_action: {
    nuxtUi: { color: 'neutral', variant: 'ghost' },
    use: 'Back/navigation/icon actions that should not compete with the primary action.',
  },
  danger_action: {
    nuxtUi: { color: 'error', variant: 'solid' },
    use: 'Final destructive actions such as Delete or Remove.',
  },
  divider: {
    classes: 'eapp-divider',
    listClasses: 'eapp-divide-y',
    use: 'Borders and row separators in extension UI.',
  },
  text: {
    primary: 'eapp-text-primary',
    secondary: 'eapp-text-secondary',
    tertiary: 'eapp-text-tertiary',
    quaternary: 'eapp-text-quaternary',
    use: 'Copy hierarchy in extension UI.',
  },
} as const;

function buildExtensionThemeClasses(input: AnyRecord = {}) {
  const intent = String(input.intent || '').trim();
  if (!intent || !(intent in THEME_CLASS_INTENTS)) {
    return {
      action: 'extension_theme_classes_listed',
      validIntents: Object.keys(THEME_CLASS_INTENTS),
      note: 'Call again with one intent to get the exact classes/props for that theme contract.',
    };
  }
  const contract = THEME_CLASS_INTENTS[intent];
  return {
    action: 'extension_theme_classes_built',
    intent,
    contract,
    hardRules: [
      'Do not use raw CSS variable utilities such as text-[var(...)], bg-[var(...)], or border-[var(...)] in extension templates.',
      'Do not use hardcoded Tailwind palettes such as bg-violet-*, text-cyan-*, bg-green-*, dark:bg-zinc-*, or hex/rgb/hsl colors.',
      'Use status classes only for compact badges/icons/short text; keep large panels neutral.',
    ],
  };
}

function collectExtensionThemeIssues(code) {
  const source = String(code || '');
  const issues: Array<{ severity: 'error' | 'warning'; rule: string; message: string; suggestion: string }> = [];
  const push = (severity, rule, message, suggestion) => issues.push({ severity, rule, message, suggestion });
  const concretePalettes = [
    'slate', 'gray', 'zinc', 'neutral', 'stone',
    'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo',
    'violet', 'purple', 'fuchsia', 'pink', 'rose',
  ].join('|');
  const paletteClassPattern = new RegExp(`(?:^|[\\s"'])(?:dark:)?(?:bg|text|border|ring|divide|from|via|to)-(${concretePalettes})-(?:\\d{2,3}|950)(?:\\/\\d+)?`, 'i');
  const rawCssVarPattern = /\b(?:bg|text|border|ring|divide|from|via|to)-\[\s*var\(--/i;
  const neutralSemanticClassPattern = /\b(?:bg-default|bg-muted|border-default|divide-default|text-muted|text-dimmed)\b/;
  const concreteNuxtUiColors = [
    'slate', 'gray', 'zinc', 'stone',
    'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo',
    'violet', 'purple', 'fuchsia', 'pink', 'rose',
  ].join('|');
  const concreteNuxtColorPattern = new RegExp(`\\bcolor\\s*=\\s*["'](${concreteNuxtUiColors})["']`, 'i');

  if (rawCssVarPattern.test(source)) {
    push('error', 'raw-css-var-utility', 'Raw CSS variable utility classes are not allowed in generated extension templates.', 'Use eapp-* class tokens or Nuxt UI semantic color props by intent.');
  }
  if (paletteClassPattern.test(source)) {
    push('error', 'hardcoded-tailwind-palette', 'Hardcoded Tailwind palette classes are not allowed in themeable extension UI.', 'Use eapp-surface-*, eapp-primary-*, eapp-status-*, or Nuxt UI semantic colors.');
  }
  if (neutralSemanticClassPattern.test(source)) {
    push('error', 'nuxt-neutral-class', 'Nuxt UI neutral shortcut classes are not part of the extension theme contract.', 'Use eapp-surface-* and eapp-text-* classes instead.');
  }
  if (concreteNuxtColorPattern.test(source)) {
    push('error', 'concrete-nuxt-color', 'Concrete Nuxt UI palette colors are not allowed in generated extension UI.', 'Use color="primary|neutral|success|warning|error|info" by semantic intent.');
  }
  if (/#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i.test(source) || /\b(?:rgba?|hsla?|oklch|lab|lch)\s*\(/i.test(source)) {
    push('error', 'hardcoded-color-value', 'Hardcoded color values are not allowed in extension UI.', 'Use the Enfyra theme class contract instead of hex/rgb/hsl/oklch/lab/lch values.');
  }
  if (/\bstyle\s*=\s*["'][^"']*(?:color|background(?:-color)?|border-color)\s*:/i.test(source)) {
    push('error', 'inline-color-style', 'Inline color styles bypass the app theme contract.', 'Use eapp-* classes or Nuxt UI semantic props instead of inline color/background/border-color.');
  }
  if (/\bgradient\s*:\s*['"](?!none['"])[^'"]+['"]/.test(source) || /\bgradient\s*=\s*['"](?!none['"])[^'"]+['"]/.test(source)) {
    push('error', 'page-header-gradient', 'Generated operational extension pages must use PageHeader gradient "none" unless the user explicitly requests decoration.', 'Set gradient: "none" in usePageHeaderRegistry or omit decorative gradients.');
  }
  if (/<(?:article|section|div)\b[^>]*class=["'][^"']*(?:eapp-status-(?:success|warning|danger|info)-soft|bg-(?:success|warning|error|info)(?:\b|\/))/i.test(source)) {
    push('warning', 'large-status-surface', 'Status color appears on a large container.', 'Keep large panels neutral and put status color on a compact UBadge/icon/short text inside.');
  }
  const primaryActionCount = (source.match(/\bcolor\s*=\s*["']primary["']/g) || []).length;
  if (primaryActionCount > 2) {
    push('warning', 'primary-overuse', 'Many primary-colored controls were found.', 'Use primary only for the main action or identity accent; use neutral variants for secondary actions.');
  }
  const primarySurfaceCount = (source.match(/\beapp-primary-surface\b/g) || []).length;
  if (primarySurfaceCount > 3) {
    push('warning', 'primary-surface-overuse', 'eapp-primary-surface appears many times.', 'Use eapp-primary-surface only for selected/current identity blocks, not every card in a list/grid.');
  }
  if (/<(?:article|section|div)\b[^>]*class=["'][^"']*\bborder\b(?![^"']*\beapp-divider\b)/i.test(source)) {
    push('warning', 'bare-border-token', 'A bordered panel is missing eapp-divider.', 'Pair intentional borders with eapp-divider so borders follow the app theme contract.');
  }
  return issues;
}

export function reviewExtensionThemeContract(code) {
  const issues = collectExtensionThemeIssues(code);
  return {
    action: 'extension_theme_contract_reviewed',
    valid: issues.every((issue) => issue.severity !== 'error'),
    issueCount: issues.length,
    issues,
    nextSteps: issues.length
      ? ['Use build_extension_ui kind=theme_classes to choose classes/props by intent, then patch/update the extension.']
      : ['Snippet matches the checked theme contract rules. Still validate the final SFC before saving.'],
  };
}

export function buildExtensionUiSnippet(kind: string, input: AnyRecord = {}) {
  let result;
  switch (kind) {
    case 'drawer':
      result = buildExtensionDrawerSnippet(input);
      break;
    case 'modal':
      result = buildExtensionModalSnippet(input);
      break;
    case 'page_shell':
      result = buildExtensionPageShellSnippet(input);
      break;
    case 'permission_gate':
      result = buildExtensionPermissionGateSnippet(input);
      break;
    case 'empty_state':
      result = buildExtensionEmptyStateSnippet(input);
      break;
    case 'resource_list':
      result = buildExtensionResourceListSnippet(input);
      break;
    case 'resource_grid':
      result = buildExtensionResourceGridSnippet(input);
      break;
    case 'form_editor':
      result = buildExtensionFormEditorSnippet(input);
      break;
    case 'widget':
      result = buildExtensionWidgetSnippet(input);
      break;
    case 'menu_notification':
      result = buildExtensionMenuNotificationSnippet(input);
      break;
    case 'account_panel_item':
      result = buildExtensionAccountPanelSnippet(input);
      break;
    case 'tabs':
      result = buildExtensionTabsSnippet(input);
      break;
    case 'upload_modal':
      result = buildExtensionUploadModalSnippet(input);
      break;
    case 'api_usage':
      result = buildExtensionApiUsageSnippet(input);
      break;
    case 'notify':
      result = buildExtensionNotifySnippet(input);
      break;
    case 'confirm':
      result = buildExtensionConfirmSnippet(input);
      break;
    case 'runtime_review':
      if (!input?.code) {
        throw new Error('build_extension_ui kind=runtime_review requires input.code.');
      }
      result = reviewExtensionRuntimeContract(input.code);
      break;
    case 'theme_classes':
      result = buildExtensionThemeClasses(input);
      break;
    case 'theme_review':
      if (!input?.code) {
        throw new Error('build_extension_ui kind=theme_review requires input.code.');
      }
      result = reviewExtensionThemeContract(input.code);
      break;
    case 'review':
      if (!input?.code) {
        throw new Error('build_extension_ui kind=review requires input.code.');
      }
      const uiReview = reviewExtensionUiContract(input.code);
      const themeReview = reviewExtensionThemeContract(input.code);
      const runtimeReview = reviewExtensionRuntimeContract(input.code);
      result = {
        action: 'extension_ui_theme_runtime_contract_reviewed',
        valid: uiReview.valid && themeReview.valid && runtimeReview.valid,
        issueCount: uiReview.issueCount + themeReview.issueCount + runtimeReview.issueCount,
        ui: uiReview,
        theme: themeReview,
        runtime: runtimeReview,
      };
      break;
    default:
      throw new Error(`Unsupported extension UI builder kind: ${kind}`);
  }
  return {
    gateway: 'build_extension_ui',
    kind,
    ...result,
  };
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
      'Register dynamic extension header actions inside onMounted after setup refs and handlers exist; build_extension_ui kind=page_shell generates this lifecycle shape.',
      'Use build_extension_ui kind=menu_notification for sidebar menu notification registration snippets.',
      'For shell menu notifications, first decide the signal source. Use a count only when the source already owns an exact count, such as a notification summary endpoint or bounded unread-notification query. Use a dot when a realtime event only proves that something new exists. Do not poll a domain list such as messages, tickets, orders, or jobs solely to decorate the menu; the destination page owns domain fetching.',
      'Use build_extension_ui kind=account_panel_item for account panel row registration snippets.',
      'For detail/form workflows that should stay left-aligned with empty space on the right, wrap the body in eapp-page-constrained; use eapp-page-constrained-wide only when the workflow genuinely needs more width.',
      'Card/list grids inside the default shell must account for the 280px desktop sidebar. Do not switch general card grids to three columns at lg; use md:grid-cols-2 xl:grid-cols-3 unless a local container proves three columns have enough width.',
    ],
    theme: [
      'Do not choose theme classes from memory. Decide the UI intent, then call build_extension_ui kind=theme_classes with that intent to receive the exact class/prop contract.',
      'Call build_extension_ui kind=theme_review or kind=review before saving extension UI; validate_extension_code and extension write tools also reject hard theme violations.',
      'Never fix one extension by injecting global CSS, redefining the app palette, or adding theme guards.',
      'Use get_theme_class_reference only when debugging theme internals or when the user explicitly asks for the full theme/class map.',
    ],
    themeIntents: [
      'neutral_surface',
      'muted_surface',
      'flat_surface',
      'hover_row',
      'primary_identity',
      'primary_soft_icon_tile',
      'primary_progress',
      'status_success',
      'status_warning',
      'status_danger',
      'status_info',
      'primary_action',
      'secondary_action',
      'ghost_navigation_action',
      'danger_action',
      'divider',
      'text',
    ],
    components: [
      'Use Nuxt UI/eApp components for normal controls: UButton, UInput, UTextarea, USelectMenu/USelect, USwitch, UCheckbox, UTabs, UBadge, UModal, and CommonDrawer when available.',
      'Use auto-injected components directly in the template with PascalCase names. Do not call resolveComponent() to manually resolve Nuxt UI/eApp components inside extension SFCs; it can compile but render unresolved lowercase DOM tags such as <ubutton>.',
      'Buttons should have stable geometry: hover may change color, border, or shadow but must not move the button or resize its content. Disabled buttons keep disabled cursor/visual state.',
      'Inputs and textareas should not add hover movement or decorative hover states; focus, invalid, disabled, and loading states must be explicit.',
      'For drawers, modals, page shell headers/actions, permission gates, empty states, resource lists, resource grids, form editors, widgets, menu/account panel registries, tabs, upload modals, api_usage, notify, and runtime/theming reviews, call build_extension_ui with the matching kind after extension acknowledgement before patching raw Vue.',
      'Use build_extension_ui kind=theme_classes for theme classes by intent, and kind=runtime_review, theme_review, or review before saving generated snippets that include composables, theme classes, high-contract UI, or native buttons.',
      'Use build_extension_ui kind=resource_grid for workboards, dashboards, catalogs, and responsive card collections instead of placing UCard children directly into a full-width list frame.',
      'Use the EmptyState runtime alias returned by build_extension_ui kind=empty_state; CommonEmptyState is not registered as a dynamic extension tag.',
      'Extension validation rejects UInput, UTextarea, USelect, USelectMenu, UInputMenu, UInputNumber, UInputTags, UInputTime, and UInputDate without class="w-full" unless marked data-compact or data-inline.',
      'Use UBadge or token-backed badge spans for status. Keep badges legible in both themes with tokenized background, text, and border.',
    ],
    appComposables: [
      'Call useApi() as a top-level setup composable. It returns data/error/pending/status refs plus execute/refresh; call or await execute()/refresh() from onMounted, watchers, or user actions when the request should run.',
      'Do not write useNotify shapes from memory. Use build_extension_ui kind=notify for known-good notification snippets. Use build_extension_ui kind=api_usage only when a generated fetch/mutation scaffold is useful.',
      'Use build_extension_ui kind=runtime_review or kind=review before saving extension code that includes useApi, useNotify, getPackages, or package loading.',
      'validate_extension_code and extension write tools reject static imports, useToast/useNotify.add misuse, and JSON.stringify useApi options.',
    ],
    shellComponentContracts: {
      CommonDrawer: [
        'Use build_extension_ui kind=drawer for generated drawer/editing snippets.',
        'The builder owns slots, managed footer actions, full-width fields, native button types, and loading/error/body structure. CommonDrawer disables drag dismissal globally; do not add handle-only, drag handlers, or swipe-to-close behavior.',
      ],
      CommonModal: [
        'Use build_extension_ui kind=modal for generated modal/confirmation snippets.',
        'The builder owns UModal/CommonModal aliasing, slots, managed footer actions, full-width fields, native button types, and modal surface constraints.',
      ],
      PermissionGate: [
        'Use build_extension_ui kind=permission_gate for generated permission wrapper snippets.',
        'UI gates are operator UX only; backend route permissions and handler/hook owner checks remain authoritative.',
      ],
      Widget: [
        'Use build_extension_ui kind=widget for generated widget include snippets.',
        'The builder owns numeric id usage, reactive prop/event wiring, and page/widget ownership warnings.',
      ],
      actionButtons: [
        'Use build_extension_ui kind=review for generated snippets with native buttons or theme classes.',
        'Validation/review catches missing type="button" and high-contract component mistakes before saving.',
      ],
    },
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
    shellNotificationContract: {
      menu: 'useMenuNotificationRegistry().register({ id, target: { id?, path?, route? }, value?, color?, title?, order? }). value renders a count/chip; omitting value renders a dot. Parent menus sum numeric child values.',
      accountPanel: 'useAccountPanelRegistry().register({ id, label, description, icon, count?, badge?, badgeColor?, expanded?, onToggle?, contentComponent? }). count is preferred over badge and the account trigger sums numeric visible item counts, capped at 99+.',
      lifecycle: 'Register from global extensions for app-wide notification state; stable ids replace previous registrations and component-owned registrations are removed on unmount.',
      reasoning: 'Counts and dots are different promises. A count says the shell knows an exact or bounded number from an appropriate notification/summary source. A dot says the shell only knows that new attention exists. Avoid fetching the destination domain list just to make a menu badge more precise.',
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

function normalizeMenuPermissionArg(permission) {
  const parsed = parseJsonObjectArg('permission', permission, null);
  if (!parsed) return null;
  if (Object.keys(parsed).length === 0) return null;
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
  validatePortableScriptSource(sourceCode);
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

function findInvalidExtensionSortSyntax(code) {
  const source = String(code || '');
  if (/\bsort\s*:\s*\[[\s\S]*?\]/u.test(source)) {
    return 'sort arrays create repeated query parameters.';
  }
  if (/\bsort\s*:\s*(['"`])[^'"`]*:\s*(?:asc|desc)\1/iu.test(source)) {
    return 'SQL-style field:ASC/field:DESC tokens are not valid Enfyra REST sort syntax.';
  }
  return null;
}

export function validateExtensionCodeLocally(code) {
  if (/\bresolveComponent\s*\(/.test(String(code || ''))) {
    throw new Error('Invalid extension component resolution: do not call resolveComponent() in Enfyra extensions. Use auto-injected components such as <UButton> directly in the template so the app/compiler resolves them correctly.');
  }

  const invalidSortSyntax = findInvalidExtensionSortSyntax(code);
  if (invalidSortSyntax) {
    throw new Error(`Invalid extension sort contract: ${invalidSortSyntax} Use build_extension_api_usage with structured sort entries; Enfyra REST requires one comma-separated string such as "-isPinned,-updatedAt".`);
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

  const missingFullWidthFields = findMissingFullWidthFieldControls(code);
  if (missingFullWidthFields.length) {
    const first = missingFullWidthFields[0];
    throw new Error(`Invalid extension field width: <${first.tag}> must include class="w-full" in Enfyra extensions unless it is intentionally compact with data-compact or data-inline. First offending snippet: ${first.snippet}`);
  }

  const themeReview = reviewExtensionThemeContract(code);
  const firstThemeError = themeReview.issues.find((issue) => issue.severity === 'error');
  if (firstThemeError) {
    throw new Error(`Invalid extension theme contract: ${firstThemeError.message} Rule: ${firstThemeError.rule}. ${firstThemeError.suggestion}`);
  }

  const runtimeReview = reviewExtensionRuntimeContract(code);
  const firstRuntimeError = runtimeReview.issues.find((issue) => issue.severity === 'error');
  if (firstRuntimeError) {
    throw new Error(`Invalid extension runtime contract: ${firstRuntimeError.message} Rule: ${firstRuntimeError.rule}. ${firstRuntimeError.suggestion}`);
  }

  return { componentCasing: 'passed', fieldWidth: 'passed', themeContract: 'passed', runtimeContract: 'passed' };
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
  const body: AnyRecord = {
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

function sha256Text(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function whitespaceFlexiblePattern(search) {
  const parts = String(search ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error('search must contain at least one non-whitespace token.');
  return new RegExp(parts.map(escapeRegExp).join('\\s+'), 'g');
}

function regexMatches(code, regex) {
  const matches = [];
  regex.lastIndex = 0;
  let match = regex.exec(code);
  while (match) {
    matches.push(match);
    if (match[0] === '') regex.lastIndex += 1;
    match = regex.exec(code);
  }
  regex.lastIndex = 0;
  return matches;
}

function replaceFirstExact(code, search, replace) {
  const index = code.indexOf(search);
  if (index === -1) return code;
  return `${code.slice(0, index)}${replace}${code.slice(index + search.length)}`;
}

function normalizeExtensionPatch(input, index) {
  const search = input?.search;
  if (typeof search !== 'string' || search.length === 0) {
    throw new Error(`patches[${index}].search must be a non-empty string.`);
  }
  if (input?.replace === undefined) {
    throw new Error(`patches[${index}].replace is required.`);
  }
  const searchMode = input?.searchMode || 'exact';
  if (!['exact', 'whitespace'].includes(searchMode)) {
    throw new Error(`patches[${index}].searchMode must be "exact" or "whitespace".`);
  }
  return {
    search,
    replace: String(input.replace),
    searchMode,
    replaceAll: Boolean(input?.replaceAll),
  };
}

function normalizeExtensionPatchInputs({ search, replace, searchMode, replaceAll, patches }) {
  if (Array.isArray(patches) && patches.length > 0) {
    return patches.map(normalizeExtensionPatch);
  }
  return [normalizeExtensionPatch({ search, replace, searchMode, replaceAll }, 0)];
}

function applyOneExtensionPatch(code, patch, index) {
  const beforeLength = code.length;
  let occurrences = 0;
  let nextCode = code;

  if (patch.searchMode === 'whitespace') {
    const regex = whitespaceFlexiblePattern(patch.search);
    occurrences = regexMatches(code, regex).length;
    if (occurrences === 0) {
      throw new Error(`Patch ${index} search fragment was not found with whitespace-flex matching.`);
    }
    if (!patch.replaceAll && occurrences !== 1) {
      throw new Error(`Patch ${index} expected search fragment to occur exactly once; found ${occurrences}. Use replaceAll=true, a more specific fragment, or update_extension_code for a full replacement.`);
    }
    let replaced = false;
    nextCode = code.replace(regex, (match) => {
      if (patch.replaceAll) return patch.replace;
      if (replaced) return match;
      replaced = true;
      return patch.replace;
    });
  } else {
    occurrences = code.split(patch.search).length - 1;
    if (occurrences === 0) {
      throw new Error(`Patch ${index} search fragment was not found.`);
    }
    if (!patch.replaceAll && occurrences !== 1) {
      throw new Error(`Patch ${index} expected search fragment to occur exactly once; found ${occurrences}. Use replaceAll=true, a more specific fragment, or update_extension_code for a full replacement.`);
    }
    nextCode = patch.replaceAll
      ? code.split(patch.search).join(patch.replace)
      : replaceFirstExact(code, patch.search, patch.replace);
  }

  return {
    code: nextCode,
    result: {
      index,
      searchMode: patch.searchMode,
      replaceAll: patch.replaceAll,
      occurrences,
      beforeLength,
      afterLength: nextCode.length,
    },
  };
}

export function applyExtensionCodePatches(code, patches) {
  const normalizedPatches = normalizeExtensionPatchInputs(patches);
  let nextCode = String(code ?? '');
  const results = [];
  normalizedPatches.forEach((patch, index) => {
    const applied = applyOneExtensionPatch(nextCode, patch, index);
    nextCode = applied.code;
    results.push(applied.result);
  });
  return { code: nextCode, patches: normalizedPatches, results };
}

async function patchExtensionCode(apiUrl, {
  id,
  name,
  search,
  replace,
  searchMode,
  replaceAll,
  patches,
  expectedSha256,
  apply,
  description,
  isEnabled,
  version,
  globalRulesAckKey,
  extensionKnowledgeAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  assertExtensionKnowledgeAck(extensionKnowledgeAckKey);
  if (!id && !name) throw new Error('Provide id or name to patch an existing extension.');
  const existing = id
    ? await findRecord(apiUrl, 'enfyra_extension', { id: { _eq: id } }, 'id,_id,name,type,menu.id,code')
    : await findRecord(apiUrl, 'enfyra_extension', { name: { _eq: name } }, 'id,_id,name,type,menu.id,code');
  if (!existing) throw new Error(`Extension not found: ${id || name}`);
  const extensionId = getId(existing);
  const currentCode = String(existing.code ?? '');
  const currentSha256 = sha256Text(currentCode);
  if (expectedSha256 && expectedSha256 !== currentSha256) {
    throw new Error(`Extension code hash mismatch. Expected ${expectedSha256}, got ${currentSha256}. Re-read the extension before patching.`);
  }
  const patchResult = applyExtensionCodePatches(currentCode, { search, replace, searchMode, replaceAll, patches });
  const nextCode = patchResult.code;
  const nextSha256 = sha256Text(nextCode);
  const occurrences = patchResult.results.reduce((total, item) => total + item.occurrences, 0);
  const nextStepPatchInput = patchResult.patches.length === 1
    ? {
      search: patchResult.patches[0].search,
      replace: patchResult.patches[0].replace,
      searchMode: patchResult.patches[0].searchMode,
      replaceAll: patchResult.patches[0].replaceAll,
    }
    : { patches: patchResult.patches };
  const preview = {
    action: apply ? 'extension_code_patch_applied' : 'extension_code_patch_previewed',
    id: extensionId,
    name: existing.name || name || null,
    type: existing.type || null,
    currentSha256,
    nextSha256,
    currentLength: currentCode.length,
    nextLength: nextCode.length,
    occurrences,
    patchResults: patchResult.results,
    atomic: patchResult.patches.length > 1,
    apply: Boolean(apply),
  };
  if (!apply) {
    return {
      ...preview,
      nextStep: {
        tool: 'patch_extension_code',
        input: { id: extensionId, expectedSha256: currentSha256, ...nextStepPatchInput, apply: true },
      },
    };
  }
  const result = await updateExtensionCode(apiUrl, {
    id: extensionId,
    name: undefined,
    code: nextCode,
    description,
    isEnabled,
    version,
    globalRulesAckKey,
    extensionKnowledgeAckKey,
  });
  return {
    ...preview,
    result,
    validation: result.validation,
  };
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

function planFlowSteps(steps) {
  const items = Array.isArray(steps) ? steps : [];
  return items.map((step, index) => {
    const intent = typeof step === 'string' ? step : step?.intent;
    const key = typeof step === 'object' && step?.key ? String(step.key) : `step_${index + 1}`;
    const recommendation: any = chooseFlowStepTool(intent);
    return {
      order: index + 1,
      key,
      intent,
      tool: recommendation.tool,
      type: recommendation.type,
      suggestedInput: {
        key,
        name: typeof step === 'object' && step?.name ? step.name : key.replace(/_/g, ' '),
        order: index + 1,
        ...(recommendation.config ? { config: recommendation.config } : {}),
        ...(recommendation.sourceCode ? { sourceCode: recommendation.sourceCode } : {}),
        ...(recommendation.condition ? { condition: recommendation.condition } : {}),
      },
      reason: recommendation.when,
    };
  });
}

function normalizeFlowWorkflowStep(step, index) {
  const input = typeof step === 'string' ? { intent: step } : (step || {});
  const intent = String(input.intent || input.name || input.key || `Step ${index + 1}`);
  const recommended = chooseFlowStepTool(input.type || intent);
  const type = String(input.type || recommended.type || 'script');
  const guidance = FLOW_STEP_TOOL_GUIDANCE.find((item) => item.type === type);
  if (!guidance) {
    throw new Error(`steps[${index}].type must be one of ${FLOW_STEP_TOOL_GUIDANCE.map((item) => item.type).join(', ')}.`);
  }
  const key = String(input.key || intent)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || `step_${index + 1}`;
  return {
    index,
    key,
    name: input.name || intent,
    intent,
    type,
    order: input.order ?? index * 10,
    config: input.config ?? guidance.config ?? {},
    sourceCode: input.sourceCode ?? guidance.sourceCode,
    scriptLanguage: input.scriptLanguage || 'javascript',
    timeout: input.timeout,
    isEnabled: input.isEnabled ?? true,
    chosenByIntent: !input.type,
    recommendedTool: guidance.tool,
  };
}

async function runFlowWorkflow(apiUrl, opts) {
  const steps = parseJsonArrayArg('steps', opts.steps, []);
  const plan = steps.map(normalizeFlowWorkflowStep);
  const hasDynamicCode = plan.some((step) => ['script', 'condition'].includes(step.type) && step.sourceCode);
  const triggerType = opts.triggerType || 'manual';
  const flowInput = {
    name: opts.name,
    triggerType,
    triggerConfig: triggerType === 'schedule' ? opts.triggerConfig : (opts.triggerConfig ?? {}),
    timeout: opts.timeout,
    maxExecutions: opts.maxExecutions,
    isEnabled: opts.isEnabled,
    description: opts.description,
    globalRulesAckKey: opts.globalRulesAckKey,
  };

  if (!opts.apply) {
    return {
      action: 'flow_workflow_planned',
      flow: {
        name: opts.name,
        triggerType,
      },
      stepCount: plan.length,
      plan,
      requiredAckParams: ['globalRulesAckKey', ...(hasDynamicCode ? ['knowledgeAckKey'] : [])],
      nextSteps: [
        'Review the plan. Prefer fixed step types; script is only for logic not covered by query/create/update/delete/http/sleep/trigger/log/condition.',
        'Call flow_workflow again with apply=true and the required ack params to create/update the flow and steps sequentially.',
        'Use test_flow_step for script, condition, or high-risk steps before triggering the flow.',
      ],
    };
  }

  if (!opts.name) throw new Error('name is required.');
  assertGlobalRulesAck(opts.globalRulesAckKey);
  if (hasDynamicCode) assertDynamicCodeKnowledgeAck(opts.knowledgeAckKey);
  const flowResult = await ensureFlow(apiUrl, flowInput);
  const flowId = flowResult.flow.id;
  const operations = [];
  for (const step of plan) {
    const result = await ensureFlowStep(apiUrl, {
      flowName: undefined,
      flowId,
      key: step.key,
      type: step.type,
      order: step.order,
      config: step.config,
      sourceCode: step.sourceCode,
      scriptLanguage: step.scriptLanguage,
      timeout: step.timeout,
      isEnabled: step.isEnabled,
      globalRulesAckKey: opts.globalRulesAckKey,
      knowledgeAckKey: opts.knowledgeAckKey,
    });
    operations.push({
      index: step.index,
      key: step.key,
      type: step.type,
      result,
    });
  }
  return {
    action: 'flow_workflow_applied',
    flow: flowResult.flow,
    flowResult,
    stepCount: plan.length,
    plan,
    operations,
    sequential: true,
    nextSteps: [
      'Use test_flow_step for script, condition, or high-risk steps before triggering the flow.',
      'Use trigger_flow only after saved behavior is verified.',
    ],
  };
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

function step(status, id, title, detail: AnyRecord = {}): AnyRecord {
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

  const pendingAckParams = firstRunnable
    ? [
      'globalRulesAckKey',
      ...(firstRunnable.id === 'save_handler' ? ['knowledgeAckKey'] : []),
    ]
    : [];
  const nextSteps: WorkflowNextStep[] = blocked
    ? [{ tool: 'api_endpoint_workflow', input: { path: normalizedPath, method: methodName, overwrite: true }, reason: blocked.reason }]
    : firstRunnable
      ? [{
        tool: 'api_endpoint_workflow',
        input: { path: normalizedPath, method: methodName, apply: true },
        stepId: firstRunnable.id,
        requiredAckParams: pendingAckParams,
        requiresKnowledgeAck: pendingAckParams.length
          ? `Pass ${pendingAckParams.join(' and ')} from get_enfyra_required_knowledge when applying this step.`
          : undefined,
      }]
      : [];

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
    nextSteps,
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

export function registerPlatformOperationTools(server, ENFYRA_API_URL) {
  const extensionFooterActionSchema = z.object({
    label: z.string().optional().describe('Static action label. Use labelExpression instead for dynamic labels.'),
    labelExpression: z.string().optional().describe('Raw Vue expression for a dynamic label, e.g. mode === "create" ? "Create" : "Save".'),
    icon: z.string().optional().describe('Optional icon name such as lucide:save or lucide:trash-2.'),
    loading: z.string().optional().describe('Raw Vue expression/ref name for loading state, e.g. saving.'),
    disabled: z.string().optional().describe('Raw Vue expression/ref name for disabled state, e.g. saving || !canSubmit.'),
    color: z.string().optional().describe('Optional component-supported color. Usually omit and let the managed action choose intent.'),
    variant: z.string().optional().describe('Optional component-supported variant. Usually omit and let the managed action choose intent.'),
    tone: z.string().optional().describe('Optional action tone when supported by the shell component.'),
    onClick: z.string().describe('Raw Vue expression or function reference for the click handler, e.g. saveNote or () => (open = false).'),
  });
  const extensionHeaderActionSchema = z.object({
    id: z.string().describe('Stable action id.'),
    label: z.string().optional().describe('Action label.'),
    icon: z.string().optional().describe('Icon name such as lucide:plus or lucide:refresh-cw.'),
    color: z.string().optional().default('neutral').describe('Nuxt UI color. Use primary only for the single main scope action; otherwise neutral.'),
    variant: z.string().optional().default('outline').describe('Nuxt UI variant. Use solid for the main scope action; otherwise outline/ghost.'),
    loading: z.string().optional().describe('Raw Vue expression/ref name for loading state.'),
    disabled: z.string().optional().describe('Raw Vue expression/ref name for disabled state.'),
    to: z.string().optional().describe('Route path for visible navigation actions.'),
    onClick: z.string().optional().describe('Script callback expression or handler reference. Prefer a handler name; bare ref assignments must use ref.value, e.g. () => (modalOpen.value = true).'),
    order: z.number().optional().describe('Sort order in the shell header action area.'),
    side: z.enum(['left', 'right']).optional().describe('Optional shell side.'),
  });

  server.tool(
    'validate_dynamic_script',
    [
      'Validate Enfyra dynamic script code before saving it to any script-backed metadata record.',
      'Use this before create/update of handlers, hooks, flow steps, websocket scripts, OAuth provisioning scripts, or bootstrap scripts when the user is iterating on code.',
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
    'patch_extension_code',
    [
      'Focused operation: patch an existing Enfyra admin extension code by exact search/replace.',
      'Use this for small UI fixes instead of rewriting the whole Vue SFC.',
      'For edits that temporarily unbalance Vue tags or slots, pass patches=[{search,replace},...] so all patches are applied in memory, then the final SFC is validated and saved atomically when apply=true.',
      'Default searchMode="exact"; use searchMode="whitespace" only when indentation/newline variation is the problem.',
      'Default replaceAll=false requires exactly one match; set replaceAll=true only after preview confirms the match count.',
      'It hash-checks the current code, validates with /enfyra_extension/preview, and saves only when apply=true.',
      'Default apply=false returns a preview and nextStep input.',
    ].join(' '),
    {
      id: z.union([z.string(), z.number()]).optional().describe('Existing extension id. Provide id or name.'),
      name: z.string().optional().describe('Existing extension unique name. Provide id or name.'),
      search: z.string().optional().describe('Single-patch search fragment. Exact by default; JSON strings can contain \\n for multiline fragments. Omit when using patches.'),
      replace: z.string().optional().describe('Single-patch replacement code fragment. Required when search is provided. Omit when using patches.'),
      searchMode: z.enum(['exact', 'whitespace']).optional().default('exact').describe('Single-patch matching mode. exact is safest. whitespace treats each run of whitespace in search as flexible whitespace.'),
      replaceAll: z.boolean().optional().default(false).describe('Single-patch replace-all mode. false requires exactly one match; true replaces every match after previewing the count.'),
      patches: z.array(z.object({
        search: z.string().describe('Patch search fragment. JSON strings can contain \\n for multiline fragments.'),
        replace: z.string().describe('Patch replacement fragment.'),
        searchMode: z.enum(['exact', 'whitespace']).optional().default('exact').describe('Patch matching mode. Use whitespace only for indentation/newline variation.'),
        replaceAll: z.boolean().optional().default(false).describe('Patch replace-all mode. false requires exactly one match for this patch.'),
      })).optional().describe('Atomic multi-patch list. Patches apply sequentially in memory and only the final SFC is validated/saved when apply=true. Use this for slot/tag pairs that would be invalid as intermediate states.'),
      expectedSha256: z.string().optional().describe('Optional SHA-256 of current extension code from a prior inspect/read. Rejects stale patches.'),
      apply: z.boolean().optional().default(false).describe('Preview by default. Set true to validate and save.'),
      description: z.string().optional().describe('Optional replacement extension description. Omit to preserve.'),
      isEnabled: z.boolean().optional().describe('Optional enabled state. Omit to preserve.'),
      version: z.string().optional().describe('Optional extension version. Omit to preserve.'),
      globalRulesAckKey: globalRulesAckParam(z),
      extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
    },
    async (input) => jsonText(await patchExtensionCode(ENFYRA_API_URL, input)),
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
    'build_extension_ui',
    [
      'Lazy gateway for Enfyra admin extension UI builders.',
      'Use this after get_enfyra_required_knowledge(scope="extension") when a high-contract extension UI snippet is needed.',
      'It keeps guided startup small by dispatching drawer, modal, page_shell, permission_gate, empty_state, resource_list, resource_grid, form_editor, widget, menu_notification, account_panel_item, tabs, upload_modal, api_usage, notify, confirm, runtime_review, theme_classes, theme_review, or review internally instead of exposing every builder tool up front.',
    ].join(' '),
    {
      kind: z.enum([
        'drawer',
        'modal',
        'page_shell',
        'permission_gate',
        'empty_state',
        'resource_list',
        'resource_grid',
        'form_editor',
        'widget',
        'menu_notification',
        'account_panel_item',
        'tabs',
        'upload_modal',
        'api_usage',
        'notify',
        'confirm',
        'runtime_review',
        'theme_classes',
        'theme_review',
        'review',
      ]).describe('Which extension UI contract builder/reviewer to run.'),
      input: z.record(z.any()).optional().default({}).describe('Builder input object. For kind=api_usage, pass { path, resource, method? }; for kind=confirm, pass { resource, executeName?, refreshName?, recordName?, idExpression? }; for kind=notify, pass { kind, title, description? }. For kind=theme_classes, pass { intent }. For kind=runtime_review/theme_review/review, pass { code }.'),
      extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
    },
    async ({ kind, input, extensionKnowledgeAckKey }) => {
      assertExtensionKnowledgeAck(extensionKnowledgeAckKey);
      return jsonText(buildExtensionUiSnippet(kind, input));
    },
  );

  server.tool(
    'build_extension_api_usage',
    [
      'Generate a contract-safe useApi snippet for Enfyra admin extensions.',
      'Use this instead of writing useApi calls from memory so route paths, execute({ id, body }), query/body objects, and mutation handlers follow the app composable contract.',
      'The tool returns code only; apply it with patch_extension_code or update_extension_code and then validate/save normally.',
    ].join(' '),
    {
      operation: z.enum(['list', 'find_one', 'create', 'update', 'delete', 'batch_update', 'batch_delete']).default('list').describe('API usage pattern to generate. Reads use the base route with query objects; mutations append ids through execute options.'),
      resource: z.string().default('items').describe('Resource variable base name, e.g. notes, projects, messages.'),
      path: z.string().optional().describe('Base API route path such as /notes. Do not include /:id; the builder strips a trailing /:id if provided.'),
      query: z.record(z.any()).optional().describe('Static Enfyra query object. Use this with sort for filter/page/limit reads; do not JSON.stringify it or put sort arrays inside it.'),
      queryExpression: z.string().optional().describe('Raw Vue expression for reactive query state. Do not JSON.stringify and do not use it to construct sort values; use structured sort instead.'),
      queryName: z.string().optional().describe('Variable name for the generated computed query when query is provided.'),
      sort: z.array(z.object({
        field: z.string().min(1).describe('Metadata field or supported aggregate sort expression.'),
        direction: z.enum(['asc', 'desc']).default('asc').describe('Enfyra sort direction.'),
      })).optional().describe('Structured sort order. The builder emits one Enfyra REST sort string, for example [{ field: "isPinned", direction: "desc" }, { field: "updatedAt", direction: "desc" }] becomes "-isPinned,-updatedAt".'),
      bodyExpression: z.string().optional().describe('Raw Vue expression for default body object/computed when useful. Do not JSON.stringify.'),
      errorContext: z.string().optional().describe('Safe error context label for useApi error reporting.'),
      responseName: z.string().optional().describe('Optional data ref variable name.'),
      pendingName: z.string().optional().describe('Optional pending ref variable name.'),
      errorName: z.string().optional().describe('Optional error ref variable name.'),
      executeName: z.string().optional().describe('Optional execute alias name.'),
      refreshName: z.string().optional().describe('Optional refresh alias name.'),
      rowsName: z.string().optional().describe('Optional computed rows variable for list/find_one operations.'),
      handlerName: z.string().optional().describe('Optional generated handler function name for mutations.'),
      recordName: z.string().optional().describe('Record parameter name for update/delete handlers.'),
      payloadName: z.string().optional().describe('Payload parameter name for create handlers.'),
      bodyName: z.string().optional().describe('Body parameter name for update/batch_update handlers.'),
      idsName: z.string().optional().describe('Ids parameter name for batch handlers.'),
      idExpression: z.string().optional().describe('Raw id expression for update/delete handlers. Defaults to record.id.'),
      autoLoad: z.boolean().optional().default(true).describe('For reads, generate onMounted(() => execute()).'),
      onErrorExpression: z.string().optional().describe('Raw onError handler expression when custom handling is needed.'),
      extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
    },
    async ({ extensionKnowledgeAckKey, ...input }) => {
      assertExtensionKnowledgeAck(extensionKnowledgeAckKey);
      return jsonText(buildExtensionApiUsageSnippet(input));
    },
  );

  server.tool(
    'build_extension_drawer',
    [
      'Generate a contract-safe CommonDrawer Vue snippet for Enfyra admin extensions.',
      'Use this before writing or patching drawer/editing workflows so the model does not have to remember CommonDrawer slots, footer action props, full-width fields, or button type rules.',
      'The tool returns code only; apply it with patch_extension_code or update_extension_code and then validate/save normally.',
    ].join(' '),
    {
      model: z.string().optional().default('drawerOpen').describe('Vue state variable used with v-model.'),
      title: z.string().optional().describe('Static drawer title.'),
      titleExpression: z.string().optional().describe('Raw Vue expression for a dynamic title.'),
      direction: z.enum(['right', 'left', 'top', 'bottom']).optional().default('right').describe('Drawer direction.'),
      nested: z.boolean().optional().default(false).describe('Set true when rendering a drawer inside another modal/drawer.'),
      body: z.string().describe('Vue template body content for #body. UInput/UTextarea/select controls are normalized to w-full; native buttons get type="button".'),
      cancelAction: z.union([extensionFooterActionSchema, z.literal(false)]).optional().describe('Cancel action object. Omit for a default Cancel that closes the model; false disables cancelAction.'),
      primaryAction: extensionFooterActionSchema.optional().describe('Primary action. Editing/create drawers should wire Save/Create here.'),
      dangerAction: extensionFooterActionSchema.optional().describe('Danger action. Destructive edit drawers should wire Delete here.'),
      footerHint: z.string().optional().describe('Optional footer hint text when supported by CommonDrawer.'),
    },
    async (input) => jsonText(buildExtensionDrawerSnippet(input)),
  );

  server.tool(
    'build_extension_modal',
    [
      'Generate a contract-safe CommonModal/UModal Vue snippet for Enfyra admin extensions.',
      'Use this before writing or patching confirmation/edit modals so the model does not have to remember v-model:open, slots, final action props, full-width fields, or button type rules.',
      'The tool returns code only; apply it with patch_extension_code or update_extension_code and then validate/save normally.',
    ].join(' '),
    {
      model: z.string().optional().default('modalOpen').describe('Vue state variable used with v-model:open.'),
      title: z.string().optional().describe('Static modal title.'),
      titleExpression: z.string().optional().describe('Raw Vue expression for a dynamic title.'),
      alias: z.enum(['CommonModal', 'UModal']).optional().default('CommonModal').describe('Use UModal only when preserving an existing UModal tag is useful; dynamic extensions resolve it to CommonModal.'),
      body: z.string().describe('Vue template body content for #body. UInput/UTextarea/select controls are normalized to w-full; native buttons get type="button".'),
      cancelAction: z.union([extensionFooterActionSchema, z.literal(false)]).optional().describe('Cancel action object. Omit for a default Cancel that closes the model; false disables cancelAction.'),
      primaryAction: extensionFooterActionSchema.optional().describe('Primary final action for non-destructive submit/confirm flows.'),
      dangerAction: extensionFooterActionSchema.optional().describe('Danger final action for destructive confirmation flows.'),
      footerHint: z.string().optional().describe('Optional footer hint text when supported by CommonModal.'),
    },
    async (input) => jsonText(buildExtensionModalSnippet(input)),
  );

  server.tool(
    'review_extension_ui_contract',
    [
      'Review an Enfyra extension Vue snippet for common modal/drawer contract mistakes.',
      'Use this before patching or saving generated extension UI when CommonDrawer, CommonModal, UModal, UInput, UTextarea, USelect, or native buttons are involved.',
      'This is a static contract review, not a compiler validation; still validate the final SFC before saving.',
    ].join(' '),
    {
      code: z.string().describe('Vue SFC or template snippet to review.'),
    },
    async ({ code }) => jsonText(reviewExtensionUiContract(code)),
  );

  server.tool(
    'build_extension_page_shell',
    [
      'Generate page-header and shell-header-action script setup code for Enfyra page extensions.',
      'Use this so generated page extensions register shell chrome through usePageHeaderRegistry/useHeaderActionRegistry instead of rendering duplicate local headers.',
    ].join(' '),
    {
      title: z.string().optional().describe('Static page title.'),
      titleExpression: z.string().optional().describe('Raw Vue expression for a dynamic title.'),
      description: z.string().optional().describe('Optional page description.'),
      leadingIcon: z.string().optional().describe('Optional page header icon.'),
      gradient: z.enum(['none', 'purple', 'blue', 'cyan']).optional().default('none').describe('Generated operational extensions should usually use none.'),
      variant: z.enum(['default', 'minimal', 'stats-focus']).optional().default('minimal').describe('Page header variant.'),
      headerActions: z.array(extensionHeaderActionSchema).optional().describe('Optional shell header actions registered through useHeaderActionRegistry.'),
    },
    async (input) => jsonText(buildExtensionPageShellSnippet(input)),
  );

  server.tool(
    'build_extension_permission_gate',
    [
      'Generate a PermissionGate wrapper snippet for Enfyra admin extension UI.',
      'Use this when a visible button/block/list needs operator UX gating; backend route permissions and owner checks still remain authoritative.',
    ].join(' '),
    {
      route: z.string().optional().describe('API route path to gate against, e.g. /notes.'),
      methods: z.array(z.string()).optional().describe('HTTP methods for the route condition. Defaults to GET when route is provided.'),
      condition: z.string().optional().describe('Raw Vue permission condition expression. Overrides route/methods when provided.'),
      body: z.string().describe('Vue template content to render inside PermissionGate. Field controls are normalized to w-full.'),
    },
    async (input) => jsonText(buildExtensionPermissionGateSnippet(input)),
  );

  server.tool(
    'build_extension_empty_state',
    [
      'Generate an EmptyState snippet for Enfyra admin extensions.',
      'Use this for app-matched empty/error/no-results states instead of hand-rolled blank panels.',
    ].join(' '),
    {
      title: z.string().optional().describe('Empty state title.'),
      description: z.string().optional().describe('Empty state description.'),
      icon: z.string().optional().describe('Icon name. Defaults to lucide:inbox.'),
      size: z.enum(['sm', 'md', 'lg']).optional().default('sm').describe('Empty state size.'),
      variant: z.enum(['outline', 'naked', 'soft', 'subtle', 'solid']).optional().default('naked').describe('Use naked inside existing panels/lists.'),
      action: extensionFooterActionSchema.optional().describe('Optional primary empty-state action.'),
    },
    async (input) => jsonText(buildExtensionEmptyStateSnippet(input)),
  );

  server.tool(
    'build_extension_resource_list',
    [
      'Generate a CommonResourceListFrame/CommonResourceListItem snippet for Enfyra admin extensions.',
      'Use this for operational list pages so loading, empty state, pagination placement, row chrome, icons, stats, and row actions follow the app contract.',
    ].join(' '),
    {
      itemsExpression: z.string().optional().default('items').describe('Vue expression for the row array, e.g. notes.'),
      itemName: z.string().optional().default('item').describe('Loop variable name.'),
      keyExpression: z.string().optional().describe('Vue expression for :key. Defaults to item.id.'),
      titleExpression: z.string().optional().describe('Vue expression for item title. Defaults to item.title || "Untitled".'),
      descriptionExpression: z.string().optional().describe('Vue expression for item description. Defaults to item.description.'),
      icon: z.string().optional().describe('Static row icon when iconExpression is omitted.'),
      iconExpression: z.string().optional().describe('Vue expression for row icon.'),
      loadingExpression: z.string().optional().default('pending').describe('Vue expression for frame loading.'),
      totalExpression: z.string().optional().describe('Vue expression for total rows.'),
      itemsPerPageExpression: z.string().optional().describe('Vue expression for items per page; use 0 to hide pagination.'),
      statsExpression: z.string().optional().describe('Vue expression returning ResourceListStat[] for each row.'),
      actionsExpression: z.string().optional().describe('Vue expression returning ResourceListAction[] for each row.'),
      topBadgeExpression: z.string().optional().describe('Vue expression returning a ResourceListTopBadge for each row.'),
      onClick: z.string().optional().describe('Raw Vue expression called for row click, e.g. openEdit(item).'),
      emptyTitle: z.string().optional().describe('Empty title.'),
      emptyDescription: z.string().optional().describe('Empty description.'),
      emptyIcon: z.string().optional().describe('Empty icon.'),
    },
    async (input) => jsonText(buildExtensionResourceListSnippet(input)),
  );

  server.tool(
    'build_extension_resource_grid',
    [
      'Generate a constrained responsive CommonResourceListFrame card grid for Enfyra admin extensions.',
      'Use this for workboards, catalogs, dashboards, and other card collections so generated pages do not become full-width horizontal strips.',
      'The tool owns the page constraint, plain list-frame chrome, md/two-column and xl/three-column breakpoints, semantic card surface, loading/empty frame, and stable card height.',
    ].join(' '),
    {
      itemsExpression: z.string().optional().default('items').describe('Vue expression for the card array, e.g. notes.'),
      itemName: z.string().optional().default('item').describe('Loop variable name.'),
      keyExpression: z.string().optional().describe('Vue expression for :key. Defaults to item.id.'),
      cardBody: z.string().optional().describe('Card body Vue template. Defaults to semantic title/description. Fields and native buttons are normalized.'),
      loadingExpression: z.string().optional().default('pending').describe('Vue expression for frame loading.'),
      totalExpression: z.string().optional().describe('Vue expression for total cards.'),
      itemsPerPageExpression: z.string().optional().describe('Vue expression for items per page; use 0 to hide pagination.'),
      emptyTitle: z.string().optional().describe('Empty state title.'),
      emptyDescription: z.string().optional().describe('Empty state description.'),
      emptyIcon: z.string().optional().describe('Empty state icon.'),
      constrained: z.boolean().optional().default(true).describe('Wrap in eapp-page-constrained-wide. Disable only for intentional full-bleed surfaces.'),
    },
    async (input) => jsonText(buildExtensionResourceGridSnippet(input)),
  );

  server.tool(
    'build_extension_form_editor',
    [
      'Generate a FormEditor/FormEditorLazy snippet for Enfyra table-backed extension forms.',
      'Use this instead of hand-writing UInput/UTextarea fields when the form maps directly to a table record.',
    ].join(' '),
    {
      tableName: z.string().optional().describe('Static table name.'),
      tableNameExpression: z.string().optional().describe('Raw Vue expression for dynamic table name.'),
      model: z.string().optional().default('form').describe('Record state variable for v-model.'),
      errors: z.string().optional().default('errors').describe('Errors state variable for v-model:errors.'),
      mode: z.enum(['create', 'update']).optional().describe('Optional fixed form mode.'),
      loadingExpression: z.string().optional().describe('Raw Vue expression/ref for loading.'),
      layout: z.enum(['stack', 'grid']).optional().describe('Form layout.'),
      includes: z.array(z.string()).optional().describe('Fields to include. Prefer explicit includes for focused generated forms.'),
      excluded: z.array(z.string()).optional().describe('Fields to exclude. compiledCode is always excluded by FormEditor.'),
      sectionsExpression: z.string().optional().describe('Raw Vue expression for FormEditorSection[].'),
      fieldMapExpression: z.string().optional().describe('Raw Vue expression for fieldMap overrides.'),
      virtualFieldsExpression: z.string().optional().describe('Raw Vue expression for virtual fields.'),
      currentRecordIdExpression: z.string().optional().describe('Raw Vue expression for current record id.'),
      hasChangedHandler: z.string().optional().describe('Handler expression for @has-changed.'),
      virtualFieldEmitHandler: z.string().optional().describe('Handler expression for @virtual-field-emit.'),
      lazy: z.boolean().optional().default(true).describe('Use FormEditorLazy by default.'),
    },
    async (input) => jsonText(buildExtensionFormEditorSnippet(input)),
  );

  server.tool(
    'build_extension_widget',
    [
      'Generate a Widget snippet for reusing a widget extension inside an Enfyra page extension.',
      'Use this so agents pass numeric widget ids and keep prop/event ownership explicit.',
    ].join(' '),
    {
      id: z.union([z.number(), z.string()]).describe('Numeric enfyra_extension widget id. Strings are allowed but return a warning because names/extensionId are wrong for Widget.'),
      props: z.record(z.string()).optional().describe('Map of prop name to raw Vue expression.'),
      events: z.record(z.string()).optional().describe('Map of event name to handler expression.'),
    },
    async (input) => jsonText(buildExtensionWidgetSnippet(input)),
  );

  server.tool(
    'build_extension_menu_notification',
    [
      'Generate useMenuNotificationRegistry registration code for a global extension.',
      'Use this for sidebar menu count chips or dot notifications without mutating enfyra_menu records.',
    ].join(' '),
    {
      id: z.string().optional().describe('Stable notification id.'),
      targetId: z.union([z.string(), z.number()]).optional().describe('Target menu id.'),
      path: z.string().optional().describe('Target menu path.'),
      route: z.string().optional().describe('Target route path.'),
      value: z.union([z.string(), z.number()]).optional().describe('Static count/chip value. Omit with valueExpression for a dot.'),
      valueExpression: z.string().optional().describe('Raw Vue expression for count/chip value. Omit value for a dot-only notification.'),
      color: z.enum(['primary', 'success', 'warning', 'error', 'info', 'neutral']).optional().default('primary').describe('Chip/dot color intent.'),
      title: z.string().optional().describe('Optional tooltip/title.'),
      order: z.number().optional().describe('Sort order when multiple notifications target the same menu.'),
    },
    async (input) => jsonText(buildExtensionMenuNotificationSnippet(input)),
  );

  server.tool(
    'build_extension_account_panel_item',
    [
      'Generate useAccountPanelRegistry registration code for a global extension.',
      'Use this for data-driven account panel rows instead of drawing full custom sidebar/account UI.',
    ].join(' '),
    {
      id: z.string().optional().describe('Stable account panel item id.'),
      order: z.number().optional().describe('Display order.'),
      label: z.string().optional().describe('Row label.'),
      description: z.string().optional().describe('Row description.'),
      icon: z.string().optional().describe('Leading icon.'),
      count: z.union([z.string(), z.number()]).optional().describe('Static notification chip value.'),
      countExpression: z.string().optional().describe('Raw Vue expression for notification chip value.'),
      badge: z.union([z.string(), z.number()]).optional().describe('Legacy static badge value. Prefer count.'),
      badgeExpression: z.string().optional().describe('Raw Vue expression for badge. Prefer countExpression.'),
      badgeColor: z.enum(['primary', 'neutral', 'info', 'error', 'warning', 'success']).optional().describe('Chip color.'),
      trailingIcon: z.string().optional().describe('Trailing icon.'),
      expandedExpression: z.string().optional().describe('Raw Vue expression controlling expanded state.'),
      contentComponent: z.string().optional().describe('Raw component reference for inline expanded content.'),
      contentPropsExpression: z.string().optional().describe('Raw Vue expression for content props.'),
      onClick: z.string().optional().describe('Direct action handler expression.'),
      onToggle: z.string().optional().describe('Expandable row toggle handler expression.'),
    },
    async (input) => jsonText(buildExtensionAccountPanelSnippet(input)),
  );

  server.tool(
    'build_extension_tabs',
    [
      'Generate a UTabs snippet for Enfyra extension page sections.',
      'Use this instead of custom tab bars so app-wide tab chrome owns active indicators, focus rings, spacing, and theme contrast.',
    ].join(' '),
    {
      model: z.string().optional().default('activeTab').describe('Active tab model variable.'),
      itemsExpression: z.string().optional().default('tabs').describe('Raw Vue expression for tab items.'),
      body: z.string().optional().describe('Vue template body for #content="{ item }".'),
    },
    async (input) => jsonText(buildExtensionTabsSnippet(input)),
  );

  server.tool(
    'build_extension_upload_modal',
    [
      'Generate a CommonUploadModal snippet and upload-progress companion snippet for Enfyra extensions.',
      'Use this for file upload UI so progress, selected-file rows, and x-enfyra-upload-id wiring follow the app contract.',
    ].join(' '),
    {
      model: z.string().optional().default('showUploadModal').describe('Modal open state variable.'),
      title: z.string().optional().describe('Upload modal title.'),
      accept: z.string().optional().default('*/*').describe('Accepted mime/extensions.'),
      multiple: z.boolean().optional().default(true).describe('Allow multiple files.'),
      maxSizeExpression: z.string().optional().describe('Raw Vue expression for max file size.'),
      loadingExpression: z.string().optional().describe('Raw Vue expression/ref for upload pending state.'),
      uploadProgressExpression: z.string().optional().describe('Raw Vue expression/ref for aggregate upload progress.'),
      fileProgressExpression: z.string().optional().describe('Raw Vue expression for per-row progress map.'),
      dragText: z.string().optional().describe('Drag/drop text.'),
      acceptText: z.string().optional().describe('Accept/help text.'),
      uploadText: z.string().optional().describe('Upload action text.'),
      uploadingText: z.string().optional().describe('Uploading action text.'),
      uploadHandler: z.string().optional().default('handleUpload').describe('@upload handler expression.'),
      errorHandler: z.string().optional().describe('@error handler expression.'),
      headerContent: z.string().optional().describe('Optional #header-content template, e.g. storage selector. Fields are normalized to w-full.'),
    },
    async (input) => jsonText(buildExtensionUploadModalSnippet(input)),
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
      menuPermission: z.string().optional().describe('Optional menu permission JSON object. Omit for unrestricted menus; empty objects are normalized to null.'),
      menuDescription: z.string().optional().describe('Optional menu admin note.'),
      menuIsEnabled: z.boolean().optional().describe('Enable the menu. Omit to preserve an existing menu value or use the platform default for a new menu.'),
      description: z.string().optional().describe('Extension description.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
      version: z.string().optional().default('1.0.0').describe('Extension version.'),
      apply: z.boolean().optional().default(false).describe('false returns plan only; true applies exactly the next pending step. When true, always pass globalRulesAckKey; also pass knowledgeAckKey when saving handler sourceCode.'),
      applyAll: z.boolean().optional().default(false).describe('true applies all safe pending steps in order. Prefer apply=true for production changes. When true, always pass globalRulesAckKey and pass knowledgeAckKey if handler sourceCode may be saved.'),
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
      const catalog = await fetchTableCatalog(ENFYRA_API_URL);
      const table = resolveTableCatalogEntry(catalog, tableName);
      if (!table) throw new Error(`Table not found: ${tableName}`);
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
      sourceCode: z.string().describe('Handler sourceCode. Use macros such as @QUERY, @BODY, @THROW400, @REPOS, and @USER. Repository calls are async and reads return result.data. Use @REPOS.main or #secure.table_name/@REPOS.secure.table_name for user-facing access; reserve trusted repos for intentional field-permission bypass. Do not send compiledCode.'),
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
      'For sourceCode, call discover_script_contexts first. Use #secure.table_name or @REPOS.secure.table_name for explicit user-facing table access; reserve #table_name/@REPOS.table_name for intentional trusted internal access.',
      'Use table/schema tools separately when the user needs persisted data. This tool is for custom behavior endpoints.',
    ].join(' '),
    {
      path: z.string().describe('Custom route path, e.g. /sum. Must not be a full URL.'),
      method: z.string().describe('HTTP method for the handler, e.g. GET or POST.'),
      sourceCode: z.string().describe('Handler sourceCode. Use macros such as @QUERY, @BODY, @THROW400, @REPOS, and @USER. Repository calls are async and reads return result.data. Use @REPOS.main or #secure.table_name/@REPOS.secure.table_name for user-facing access; reserve trusted repos for intentional field-permission bypass. Do not send compiledCode.'),
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
        const body: HandlerBody = { sourceCode, scriptLanguage };
        if (timeout !== undefined) body.timeout = timeout;
        handlerResult = await fetchAPI(ENFYRA_API_URL, `/enfyra_route_handler/${encodeURIComponent(String(getId(existingHandler)))}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        handlerAction = 'created';
        const body: RouteHandlerBody = {
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
      const table = await fetchTableMetadataByRef(ENFYRA_API_URL, tableName);
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
      const [table, role] = await Promise.all([
        fetchTableMetadataByRef(ENFYRA_API_URL, tableName),
        resolveRole(ENFYRA_API_URL, { roleId, roleName }),
      ]);
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
    'ensure_route_rate_limit',
    'Business operation: create or update a route rate-limit guard through the Enfyra guard engine. Prefer this over pre-hooks or raw guard JSON for request throttling.',
    {
      name: z.string().optional().describe('Optional guard name. Defaults to a stable name based on path, methods, and scope.'),
      routeId: z.union([z.string(), z.number()]).optional().describe('Optional route id.'),
      path: z.string().optional().describe('Route path to protect, e.g. /newsletter_signup.'),
      methods: z.array(z.string()).default(['POST']).describe('HTTP method names to protect.'),
      scope: z.enum(['ip', 'user', 'route']).default('ip').describe('Rate-limit key scope. Use ip for public/pre-auth routes, user for authenticated users, route for a shared route-wide limit.'),
      maxRequests: z.number().int().positive().describe('Allowed request count per window.'),
      perSeconds: z.number().int().positive().describe('Window length in seconds.'),
      position: z.enum(['pre_auth', 'post_auth']).optional().describe('Optional override. Defaults to pre_auth for ip/route and post_auth for user.'),
      priority: z.number().optional().default(0).describe('Lower runs earlier.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable the guard. Defaults true.'),
      description: z.string().optional().describe('Admin note.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ name, routeId, path, methods, scope, maxRequests, perSeconds, position, priority, isEnabled, description, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      if (path && routeId) throw new Error('Provide path or routeId, not both.');
      const resolvedPosition = position || (scope === 'user' ? 'post_auth' : 'pre_auth');
      if (scope === 'user' && resolvedPosition === 'pre_auth') {
        throw new Error('User-scoped rate limits require post_auth because user identity is unavailable before auth.');
      }
      const { route } = await resolveRoute(ENFYRA_API_URL, { path, routeId });
      const { methodMap } = await getMethodContext(ENFYRA_API_URL);
      const methodNames = uniqueMethodNames(methods?.length ? methods : ['POST']);
      const ruleType = scope === 'user' ? 'rate_limit_by_user' : scope === 'route' ? 'rate_limit_by_route' : 'rate_limit_by_ip';
      const guardName = name || `Rate limit ${scope} ${route.path} ${methodNames.join('_')}`;
      const existing = await findRecord(ENFYRA_API_URL, 'enfyra_guard', { name: { _eq: guardName } }, 'id,_id,name');
      const guardBody = {
        name: guardName,
        position: resolvedPosition,
        combinator: 'and',
        priority,
        isGlobal: false,
        isEnabled,
        description: description || `Rate-limit ${methodNames.join(', ')} ${route.path} by ${scope}.`,
        route: { id: getId(route) },
        methods: resolveMethodRefs(methodMap, methodNames),
      };
      const guardOperation = await createOrPatch(ENFYRA_API_URL, 'enfyra_guard', existing, guardBody);
      const guardId = guardOperation.id || getId(existing);
      const existingRules = await fetchRecords(ENFYRA_API_URL, 'enfyra_guard_rule', { guard: { id: { _eq: guardId } } }, 'id,_id,isEnabled');
      const disabledRules = [];
      for (const rule of existingRules) {
        disabledRules.push(await fetchAPI(ENFYRA_API_URL, `/enfyra_guard_rule/${encodeURIComponent(String(getId(rule)))}`, {
          method: 'PATCH',
          body: JSON.stringify({ isEnabled: false }),
        }));
      }
      const rule = await fetchAPI(ENFYRA_API_URL, '/enfyra_guard_rule', {
        method: 'POST',
        body: JSON.stringify({
          type: ruleType,
          config: { maxRequests, perSeconds },
          priority: 0,
          isEnabled: true,
          description: `${maxRequests} request${maxRequests === 1 ? '' : 's'} per ${perSeconds} seconds by ${scope}.`,
          guard: { id: guardId },
        }),
      });
      const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/guards');
      return jsonText({
        action: 'route_rate_limit_ensured',
        route: { id: getId(route), path: route.path },
        methods: methodNames,
        guard: { id: guardId, name: guardName, position: resolvedPosition, isEnabled },
        rule: { type: ruleType, config: { maxRequests, perSeconds }, result: rule },
        disabledRuleCount: disabledRules.length,
        reload,
        next: 'Call inspect_route({ path }) to confirm the guard is attached, then test behavior through the actual REST route if doing so will not consume a production rate-limit bucket.',
      });
    },
  );

  server.tool(
    'ensure_guard',
    'Advanced business operation: create or update a custom request guard tree and optional guard rules. For simple request throttling use ensure_route_rate_limit instead.',
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
    'flow_workflow',
    [
      'Workflow front door for creating or updating an Enfyra flow and its steps in one guided path.',
      'For a fully specified, non-destructive flow, use apply=true to create/update the flow and all steps sequentially in one call. Use apply=false only when step types or risk need review.',
      'Prefer this over choosing individual ensure_*_flow_step tools in guided mode.',
    ].join(' '),
    {
      name: z.string().describe('Flow name. Existing flow with this name is updated.'),
      triggerType: z.enum(['manual', 'schedule']).optional().default('manual').describe('manual for API/admin/hook/child flow usage, schedule for cron/time-based flows.'),
      triggerConfig: z.union([z.record(z.any()), z.string()]).optional().describe('Trigger config object or JSON string. Required for scheduled flows.'),
      steps: z.array(z.union([
        z.string(),
        z.object({
          key: z.string().optional().describe('Stable step key. Generated from intent when omitted.'),
          name: z.string().optional().describe('Human label. Defaults from intent.'),
          intent: z.string().optional().describe('Plain-language step intent. Used to choose a fixed step type when type is omitted.'),
          type: z.enum(['query', 'create', 'update', 'delete', 'http', 'condition', 'sleep', 'trigger_flow', 'log', 'script']).optional().describe('Explicit step type. Omit to let the workflow choose from intent.'),
          config: z.union([z.record(z.any()), z.string()]).optional().describe('Step config object or JSON string. For query/create/update/delete/http/sleep/trigger/log steps, prefer config over sourceCode.'),
          sourceCode: z.string().optional().describe('Only for script or condition steps. Use fixed step types when possible.'),
          scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript'),
          order: z.number().optional().describe('Step order. Defaults to index * 10.'),
          timeout: z.number().int().positive().optional().describe('Step timeout in ms.'),
          isEnabled: z.boolean().optional().default(true).describe('Enable step.'),
        }),
      ])).min(1).max(30).describe('Ordered step intents/definitions. Keep one business operation per step.'),
      timeout: z.number().int().positive().optional().describe('Flow timeout in ms.'),
      maxExecutions: z.number().int().positive().optional().default(100).describe('Execution history cap.'),
      isEnabled: z.boolean().optional().default(true).describe('Enable flow.'),
      description: z.string().optional().describe('Admin note.'),
      apply: z.boolean().optional().default(false).describe('false returns plan only; true applies flow and steps sequentially.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when apply=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
      knowledgeAckKey: dynamicCodeKnowledgeAckParam(z).optional().describe('Required when apply=true and any script/condition step has sourceCode.'),
    },
    async (input) => jsonText(await runFlowWorkflow(ENFYRA_API_URL, input)),
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
      triggerConfig: {},
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
    'plan_flow_steps',
    'Dry-run helper: choose the ordered Enfyra flow step tools for a whole flow plan before mutating flow metadata.',
    {
      steps: z.array(z.union([
        z.string(),
        z.object({
          key: z.string().optional().describe('Stable step key. Generated when omitted.'),
          name: z.string().optional().describe('Human label. Defaults from key.'),
          intent: z.string().describe('Plain-language description of this step.'),
        }),
      ])).min(1).max(30).describe('Ordered step intents. Use this before ensure_*_flow_step calls when a flow has multiple steps.'),
    },
    async ({ steps }) => {
      const plan = planFlowSteps(steps);
      return jsonText({
        action: 'flow_steps_planned',
        stepCount: plan.length,
        plan,
        nextSteps: [
          'Create or update the flow with ensure_manual_flow or ensure_scheduled_flow first.',
          'Call each planned ensure_*_flow_step in order, adding flowName or flowId plus table/query/config details.',
          'Use ensure_script_flow_step only for steps where the plan chose script because fixed step types are insufficient.',
          'Use test_flow_step for script/condition/high-risk steps before triggering the full flow.',
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
      permission: z.string().optional().describe('Menu permission JSON object. Omit to preserve existing permissions on update; new menus default to null. Empty objects are normalized to null.'),
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
