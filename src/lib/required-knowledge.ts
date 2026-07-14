export const GLOBAL_RULES_ACK_KEY = 'EFYRA::GLOBAL-RULES::RUNTIME-ZONES::SCHEMA-DESIGN-CONTEXT::RECORD-BATCH::20260704H';
export const DYNAMIC_CODE_KNOWLEDGE_ACK_KEY = 'EFYRA::DYNAMIC-REPOSITORY-CONTRACT::SECURE-EXPLICIT::20260714A';
export const EXTENSION_KNOWLEDGE_ACK_KEY = 'EFYRA::EXTENSION-APP-COMPOSABLE-CONTRACT::20260708A';

const REQUIRED_KNOWLEDGE_VERSION = '2026-07-14.secure-repositories-graphql-metadata';

export function globalRulesAckParam(z) {
  return z.string().describe('Required global-rules acknowledgement key from get_enfyra_required_knowledge. Call that tool, read the global Enfyra MCP rules, then pass globalRulesAckKey exactly.');
}

export function dynamicCodeKnowledgeAckParam(z) {
  return z.string().describe('Required dynamic-code acknowledgement key from get_enfyra_required_knowledge. Call that tool, read the dynamic server code knowledge, then pass dynamicCodeAckKey exactly.');
}

export function extensionKnowledgeAckParam(z) {
  return z.string().describe('Required extension acknowledgement key from get_enfyra_required_knowledge. Call that tool, read the extension/theme knowledge, then pass extensionAckKey exactly.');
}

export function assertGlobalRulesAck(key) {
  if (key !== GLOBAL_RULES_ACK_KEY) {
    throw new Error('Missing or invalid global-rules acknowledgement. Call get_enfyra_required_knowledge, read the global Enfyra MCP rules, then pass globalRulesAckKey as globalRulesAckKey.');
  }
}

export function assertGlobalRulesAckIf(condition, key) {
  if (condition) assertGlobalRulesAck(key);
}

export function assertDynamicCodeKnowledgeAck(key) {
  if (key !== DYNAMIC_CODE_KNOWLEDGE_ACK_KEY) {
    throw new Error('Missing or invalid dynamic-code knowledge acknowledgement. Call get_enfyra_required_knowledge, read the dynamic server code contracts, then pass dynamicCodeAckKey as knowledgeAckKey.');
  }
}

export function assertDynamicCodeKnowledgeAckIf(condition, key) {
  if (condition) assertDynamicCodeKnowledgeAck(key);
}

export function assertExtensionKnowledgeAck(key) {
  if (key !== EXTENSION_KNOWLEDGE_ACK_KEY) {
    throw new Error('Missing or invalid extension knowledge acknowledgement. Call get_enfyra_required_knowledge, read the extension/theme contracts, then pass extensionAckKey as extensionKnowledgeAckKey.');
  }
}

export function assertExtensionKnowledgeAckIf(condition, key) {
  if (condition) assertExtensionKnowledgeAck(key);
}

export const KNOWLEDGE_SCOPES = ['full', 'schema', 'dynamic-code', 'extension', 'flow'] as const;
export type KnowledgeScope = typeof KNOWLEDGE_SCOPES[number];

function requireScope(scope: string): KnowledgeScope {
  const s = (scope || '').trim().toLowerCase();
  if ((KNOWLEDGE_SCOPES as readonly string[]).includes(s)) return s as KnowledgeScope;
  return 'full';
}

const GLOBAL_RULES_SECTIONS = [
  {
    id: 'examples-are-reasoning-anchors',
    rules: [
      'Examples explain transferable decisions, not copy-paste mandates.',
      'Preserve platform contracts and safety boundaries, then adapt names, routes, fields, menus, labels, and lifecycle to live metadata and the user goal.',
      'When examples use chat, order, report, cloud, email, or support domains, treat those as analogies unless the current task is exactly that domain.',
    ],
  },
  {
    id: 'discover-before-changing',
    rules: [
      'Inspect live metadata/routes/features before schema, route, permission, extension, flow, or handler changes.',
      'Use narrow inspection tools for the table, route, feature, or script being changed instead of broad discovery after the target is known.',
      'When the thing to find lives in DB-backed runtime state rather than repo files, use search_admin_extensions for admin UI or search_runtime_zone for other runtime zones before raw query_table or broad trace tools.',
      'Read sourceCode, not compiledCode, for editable dynamic scripts.',
      'Read code, not sourceCode, for editable enfyra_extension Vue SFC records. sourceCode is for dynamic server scripts; extension UI should be located with search_admin_extensions and edited with patch_extension_code/update_extension_code.',
    ],
  },
  {
    id: 'runtime-zone-locators',
    rules: [
      'Use search_admin_extensions for menu + extension UI: page extensions, widget extensions, global shell extensions, menu chips, account panel entries, visible buttons, labels, icons, tabs, and blocks.',
      'Use search_runtime_zone as the zone search/inspect tool for non-admin-UI DB-backed artifacts.',
      'Search first, then inspect with nextInspect.input before editing.',
      'Use search_runtime_zone with zone=api_runtime for routes, handlers, pre-hooks, post-hooks, guards, guard rules, and route permissions.',
      'Use search_runtime_zone with zone=flow_runtime for flows and flow steps.',
      'Use search_runtime_zone with zone=websocket_runtime for websocket gateways and events.',
      'Use search_runtime_zone with zone=graphql_runtime for table GraphQL exposure metadata.',
      'Use search_runtime_zone with zone=schema_data for tables, columns, relations, field permissions, and column rules.',
      'Use search_runtime_zone with zone=package_runtime for installed app/server packages.',
      'Use search_runtime_zone with zone=storage_file for storage configs, folders, files, public asset state, and file permissions.',
      'Use search_runtime_zone with zone=auth_security for users, roles, route/field permissions, guards, OAuth configs, linked OAuth accounts, and access surfaces.',
      'After search_runtime_zone mode=search, call search_runtime_zone mode=inspect with the returned nextInspect.input before editing source or metadata.',
      'Use zone-specific write tools after inspection; do not mutate DB-backed runtime artifacts with generic CRUD when a business operation tool exists.',
    ],
  },
  {
    id: 'mutations-are-intentional',
    rules: [
      'Prefer business operation tools over generic CRUD when a specific tool exists.',
      'Destructive operations are preview-first; pass confirm=true only after explicit user approval.',
      'Do not manually reload caches unless natural partial reload is proven stale or a concrete reload error requires it.',
      'Never fabricate ids, field names, relation names, paths, package names, or permission scopes.',
    ],
  },
  {
    id: 'schema-constraints',
    rules: [
      'Before creating a multi-table app, call get_schema_design_context first. Use its liveColumnTypes, createTableInput, columnDefinitionInput, relationDefinitionInput, and recommendedSequence instead of guessing metadata attributes.',
      'Then call get_enfyra_examples with category=schema-relations only for reasoning patterns, not for domain-specific table names.',
      'Use plural mutation tools for writes: create_tables/update_tables/delete_tables, create_columns/update_columns/delete_columns, create_relations/delete_relations, and create_records/update_records/delete_records. Pass native JSON arrays; use one item in the array for a single mutation.',
      'Create entity tables with scalar columns first, then add relations once target tables exist. create_tables defers relation creation until all tables in the same batch exist.',
      'Do not declare id, _id, createdAt, or updatedAt columns; Enfyra manages them automatically.',
      'For one-pass relation-based unique/index constraints, declare the owning relations in the same create_tables item as the constraints. If relations already exist or will be created separately, add those constraints afterward with update_tables.',
      'Use live Enfyra column types, not SQL dialect names. Common safe choices: varchar for short text, text/richtext for long prose, float for price/amount/rating/decimal-like values, int/bigint for counts, boolean, date/datetime/timestamp, enum, simple-json for structured objects/arrays when listed by live metadata, and code for source fields.',
      'Do not use json/jsonb/longtext/decimal unless the live enfyra_column.type enum lists them. The MCP schema tools normalize common aliases where possible and return schemaNormalization.',
      'Use Enfyra relations instead of scalar FK/id columns for normalized links. Do not create fields such as userId, course_id, categoryIds, authorId, or JSON arrays of related ids unless the user explicitly asks for denormalized snapshots.',
      'If the app must deep-read a parent with child collections, create the child owning relation with inversePropertyName from the start; otherwise parent.deepChild queries will fail until an inverse relation is added.',
      'When inserting/updating records with relations, use relation propertyName values in the body, not hidden physical FK columns. Inspect the table to learn propertyName values.',
      'For record writes, always use create_records/update_records/delete_records with native array inputs; these tools validate every item against live metadata before posting/patching/deleting sequentially.',
      'For reads, query_table accepts native object filter/deep/aggregate values. Deep keys are relation names; query_table auto-adds missing top-level deep relation keys to fields so nested records can appear. Inside deep, use fields/filter/sort/limit/page/deep; never use _fields.',
      'Filters use Enfyra operators, not SQL operators. Use _contains, _starts_with, or _ends_with for text matching; do not use _like.',
      'This auto-add behavior is MCP query_table only. Inside dynamic server scripts, repository find({ deep }) requires the relation property to also be present in top-level fields, otherwise row.<relation> may be undefined.',
      'For table schema, a field that appears in any uniques group, including composite unique groups such as ["event","attendee"], must not appear in indexes.',
      'A unique constraint already creates the indexed unique lookup for its fields, so do not add separate indexes for those same fields.',
      'Use uniques for data integrity and indexes only for non-unique query-performance fields that are not already unique.',
      'create_tables preflights all items before posting tables and rejects unique/index overlap for the whole batch; update_tables applies the same guard before patching constraints.',
      'Before update_tables with indexes/uniques, inspect the current table and remove indexes that reference unique fields.',
      'query_table always requires limit or all=true. Use meta=filterCount/totalCount or count_records for counts. Do not guess aggregate operators such as _sum/_count; call discover_query_capabilities first when an aggregate object is needed.',
      'Run schema mutation calls through the plural tools; they serialize work internally. Do not parallelize schema mutation tool calls.',
    ],
  },
  {
    id: 'security-first',
    rules: [
      'Treat permission and owner/tenant scope as the first design step for any route, handler, hook, flow, extension, websocket, or data surface.',
      'Route permission only lets authenticated users reach a route after RoleGuard; handlers, hooks, RLS, and scripts still enforce record ownership and tenant/project scope.',
      'Do not expose unpublished fields, private relation facts, secret values, token hashes, stack traces, SQL, provider payloads, or generated passwords to user-facing clients.',
    ],
  },
  {
    id: 'shell-signals',
    rules: [
      'For app shell menu/account-panel notifications, decide the signal source before choosing count or dot.',
      'Use a count only when the shell receives an exact or bounded count from a notification/summary source.',
      'Use a dot when realtime only proves new attention exists.',
      'Do not fetch destination domain lists such as messages, tickets, orders, or jobs solely to decorate the menu; the destination page owns domain fetching.',
    ],
  },
];

const DYNAMIC_CODE_SECTIONS = [
  {
    id: 'secure-vs-trusted-repositories',
    rules: [
      '@REPOS.main is the secure repository for the current route main table and preserves normal route query behavior.',
      'For an explicit table in user-facing dynamic code, use #secure.table_name or @REPOS.secure.table_name so field-permission enforcement remains enabled.',
      'Use #table_name or @REPOS.table_name only for trusted internal operations that intentionally need to bypass field permissions.',
      'Trusted repositories may read/write hidden fields, so require explicit fields, relation filters, authorization checks, and shaped/sanitized output.',
      'Never return raw trusted-repository records to users. Project or sanitize output before returning it.',
    ],
  },
  {
    id: 'authorization-is-separate',
    rules: [
      'Secure repository selection does not prove the user is allowed to access a record.',
      'Handlers and hooks still need route access, owner/tenant filters, membership checks, and explicit mutation authorization.',
      'For canonical table reads and RLS, merge security filters into @QUERY.filter and preserve @QUERY.fields, @QUERY.deep, @QUERY.sort, @QUERY.limit, @QUERY.page, @QUERY.meta, @QUERY.aggregate, and debugMode.',
    ],
  },
  {
    id: 'hidden-field-query-surfaces',
    rules: [
      'Unpublished fields and private relations are sensitive even when the field is not selected.',
      'Do not expose filter predicate-oracle behavior over hidden fields in user-facing endpoints.',
      'Do not expose aggregate, _max, _min, _count, sort helpers, or counts over unpublished fields/private relations unless the endpoint intentionally exposes that fact.',
      'If a normal REST read returns an isPublished=false field through fields/deep/dotted projection, treat it as an Enfyra core bug and verify the minimal REST repro.',
    ],
  },
  {
    id: 'dynamic-script-shape',
    rules: [
      'Use sourceCode and scriptLanguage; never send compiledCode.',
      'Prefer macros such as @BODY, @QUERY, @PARAMS, @USER, @REQ, @RES, @REPOS, @HELPERS, @STORAGE, @SOCKET, and @THROW* when available.',
      'Call build_dynamic_repository_usage for list, find-one, create, update, or delete code instead of composing secure/trusted repository syntax and result shapes from memory.',
      'An enfyra_oauth_config sourceCode script runs before a new OAuth user insert, has no authenticated @USER, and must return a plain object of additional user fields. Provider identity fields are merged afterward and take precedence.',
      'Repository reads use filter, not where.',
      'For dynamic file upload progress, clients send x-enfyra-upload-id on authenticated multipart requests and listen for $system:upload:progress; @STORAGE.$upload and blob-replacing @STORAGE.$update do not accept onProgress.',
      'Inside user-facing dynamic scripts, prefer #secure.table_name.find with limit:1 and explicit fields for one-record lookups. If a primary-key id filter fails in a runtime, fetch a small bounded candidate set by a unique business field or use the canonical route/main-table context; do not keep retrying repository id filter shapes.',
      'Relation filters use relation propertyName values, not physical FK-shaped names. Use { incident: { id: { _eq: id } } }, not { incidentId: { _eq: id } }.',
      'Use @REPOS.main for the route main table and #secure.table_name or @REPOS.secure.table_name for explicit user-facing table access. Reserve #table_name/@REPOS.table_name for trusted internal work that intentionally bypasses field permissions.',
      'When using repository find({ deep }) in handlers/hooks/flows, include each deep relation name in top-level fields, then choose nested fields under deep.<relation>.fields.',
      'Repository calls are async. Always await secure and trusted repository find/create/update/delete/exists calls; reads return { data: [...], meta? }.',
      'Create/update repository calls return collection-shaped data arrays; read result.data?.[0] for a single row.',
      'For intentional HTTP errors, numeric helpers are raw HTTP message helpers: @THROW400(message), @THROW404(message), @THROW409(message), @THROW422(message, detailsObject?), @THROW500(message).',
      'When numeric helpers include details, pass an object or array such as @THROW404("Project not found", { id }); do not use @THROW404("Project", id) as a semantic shortcut.',
      'Use @THROW.http(status, message, details?) for dynamic status codes. Use @THROW.notFound(resource, id?) and @THROW.duplicate(resource, field, value) only when you intentionally want Enfyra-formatted semantic messages.',
    ],
  },
];

const EXTENSION_SECTIONS = [
  {
    id: 'theme-contract-first',
    rules: [
      'Call get_extension_theme_contract before writing or reviewing page, widget, or global extension UI.',
      'Do not choose theme classes from memory. Decide the UI intent, then call build_extension_ui kind=theme_classes with that intent.',
      'Call build_extension_ui kind=theme_review or kind=review before saving themeable extension UI.',
      'Call get_theme_class_reference only when debugging theme internals or when the user explicitly asks for the full theme/class map.',
    ],
  },
  {
    id: 'extension-shell-boundary',
    rules: [
      'Extension roots render inside the Enfyra admin app shell. Do not add root-level page padding such as p-4 sm:p-6 xl:p-8.',
      'Page extensions should be full-bleed by default and responsive from the first version.',
      'Do not wrap whole pages in decorative cards; use cards only for repeated items, modals, or genuinely framed tools.',
      'Register dynamic page header actions inside onMounted after setup refs and handlers exist. Use the page_shell builder instead of writing immediate registry callbacks from memory.',
      'Use NuxtLink or Nuxt UI components with :to for visible navigation links; reserve navigateTo for imperative side effects.',
      'Admin extension links for record management should point to /data/<table>, not public website paths stored on records.',
    ],
  },
  {
    id: 'extension-runtime-contract',
    rules: [
      'Save extensions as enfyra_extension Vue SFC records; no static import statements in extension code.',
      'Editable extension source is enfyra_extension.code. Do not request or write enfyra_extension.sourceCode.',
      'Do not call resolveComponent() in extension SFCs. Use auto-injected components such as <UButton>, <UBadge>, <PermissionGate>, and <Widget> directly in the template so the app/compiler resolves them correctly.',
      'Load app packages with getPackages(["package-name"]) inside extension runtime code.',
      'For generated high-contract UI in guided mode, call build_extension_ui with the matching kind after reading this acknowledgement; it lazy-dispatches drawer, modal, page shell, permission gate, empty state, resource list, resource grid, form editor, widget, menu notification, account panel item, tabs, upload modal, notify, confirm, runtime review, theme classes, theme review, or full review contracts without loading every builder tool at startup.',
      'For extension useApi code, call build_extension_api_usage with operation=list, find_one, create, update, delete, batch_update, or batch_delete. Do not write useApi path/id/body shapes from memory.',
      'For an ordinary destructive action, call build_extension_ui kind=confirm. It generates useConfirm() -> accepted mutation -> refresh; do not use window.confirm, window.alert, alert, or prompt. Use CommonModal directly only for richer confirmation content or form fields.',
      'CommonResourceListFrame is supported in extension runtime and renders its default slot when loading is false and hasItems is true. Do not remove it to speculate about swallowed slots; inspect the source artifact, hasItems/items expressions, and API response shape first.',
      'Use build_extension_ui kind=resource_grid for workboards, catalogs, dashboards, and card collections. It owns eapp-page-constrained-wide, CommonResourceListFrame variant="plain", one/two/three-column responsive breakpoints, semantic card surfaces, and list loading/empty behavior; use resource_list for dense operational rows.',
      'Dynamic extension templates expose the app empty-state component as <EmptyState>, not <CommonEmptyState>. Prefer the empty_state, resource_list, or resource_grid builder instead of writing either tag from memory.',
      'For theme choices, call build_extension_ui kind=theme_classes with an intent such as neutral_surface, primary_identity, primary_soft_icon_tile, status_success, primary_action, secondary_action, divider, or text instead of inventing classes from memory.',
      'Use build_extension_ui kind=runtime_review, theme_review, or review before saving generated snippets that include useApi, useNotify, theme classes, drawers, modals, fields, lists, tabs, upload modals, shell registry code, or native buttons.',
      'For same-version edits to an existing extension, inspect the extension first and use the generated /tmp/enfyra-mcp-sources artifact when snippets are not enough. Edit that artifact and apply its contents with update_extension_code, or use patch_extension_code for a focused exact patch. Do not regenerate the full Vue SFC for a small bug fix, styling adjustment, or contract correction unless the user explicitly asks for a rewrite or version-changing redesign.',
      'Extension validation rejects UInput/UTextarea/USelect/USelectMenu/UInputMenu/UInputNumber/UInputTags/UInputTime/UInputDate without class="w-full" unless the field is explicitly marked data-compact or data-inline.',
      'PermissionGate is operator UX only; backend route permissions and owner checks remain authoritative.',
    ],
  },
  {
    id: 'extension-app-composables',
    rules: [
      'Call useApi() as a top-level setup composable. It returns data/error/pending/status refs plus execute/refresh; call or await execute()/refresh() from onMounted, watchers, or user actions when the request should run.',
      'Do not write useApi shapes from memory. Call build_extension_api_usage for known-good list/find_one/create/update/delete/batch snippets.',
      'Do not write useNotify shapes from memory. Call build_extension_ui kind=notify for known-good notification snippets.',
      'Call build_extension_ui kind=runtime_review or kind=review before saving extension code that includes useApi, useNotify, getPackages, or package loading.',
      'Extension validation rejects static imports, useToast/useNotify.add misuse, JSON.stringify useApi options, unused execute aliases, incorrect modal v-model bindings, unavailable runtime aliases, and script-block callbacks that reassign const refs instead of mutating ref.value. Template expressions remain Vue-auto-unwrapped.',
    ],
  },
];

const SCOPED_PURPOSES: Record<KnowledgeScope, string> = {
  full: 'Read this before mutating Enfyra metadata, schema, routes, permissions, menus, packages, cache state, dynamic server code, or extension UI through MCP.',
  schema: 'Read this before mutating Enfyra metadata, schema, table data, routes, permissions, guards, or cache state through MCP.',
  'dynamic-code': 'Read this before writing or mutating dynamic server code (handlers, hooks, flow steps, websocket events, OAuth user provisioning, bootstrap scripts) through MCP.',
  extension: 'Read this before writing or mutating Enfyra admin extension UI, menus, or shell registrations through MCP.',
  flow: 'Read this before creating or mutating Enfyra flows and flow steps through MCP.',
};

export function buildRequiredKnowledgePayload(scope: string = 'full') {
  const resolvedScope = requireScope(scope);
  const includeGlobal = true;
  const includeDynamic = resolvedScope === 'full' || resolvedScope === 'dynamic-code' || resolvedScope === 'flow';
  const includeExtensions = resolvedScope === 'full' || resolvedScope === 'extension';

  const payload: any = {
    version: REQUIRED_KNOWLEDGE_VERSION,
    scope: resolvedScope,
    purpose: SCOPED_PURPOSES[resolvedScope],
    includedDomains: ['globalRules', ...(includeDynamic ? ['dynamicServerCode'] : []), ...(includeExtensions ? ['extensions'] : [])],
    excludedDomains: [...(!includeDynamic ? ['dynamicServerCode'] : []), ...(!includeExtensions ? ['extensions'] : [])],
    note: 'Ack keys (globalRulesAckKey, dynamicCodeAckKey, extensionAckKey) are always returned so you can use them when needed. Only domains listed in includedDomains have rules loaded. Domains in excludedDomains have NO rules in this response.',
    globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    dynamicCodeAckKey: DYNAMIC_CODE_KNOWLEDGE_ACK_KEY,
    extensionAckKey: EXTENSION_KNOWLEDGE_ACK_KEY,
    usage: [
      'Pass globalRulesAckKey exactly as globalRulesAckKey when calling MCP tools that mutate Enfyra metadata, schema, routes, permissions, menus, packages, cache state, dynamic code, or extension UI.',
    ],
    globalRules: includeGlobal ? GLOBAL_RULES_SECTIONS : undefined,
    dynamicServerCode: includeDynamic ? DYNAMIC_CODE_SECTIONS : undefined,
    extensions: includeExtensions ? EXTENSION_SECTIONS : undefined,
  };

  if (includeDynamic) {
    payload.usage.push('Pass dynamicCodeAckKey exactly as knowledgeAckKey when calling MCP tools that create or update dynamic server code.');
  }
  if (includeExtensions) {
    payload.usage.push('Pass extensionAckKey exactly as extensionKnowledgeAckKey when calling MCP tools that create or update Enfyra extension code.');
  }

  // Strip undefined keys
  Object.keys(payload).forEach((k) => {
    if (payload[k] === undefined) delete payload[k];
  });

  return payload;
}
