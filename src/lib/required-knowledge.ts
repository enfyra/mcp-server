export const GLOBAL_RULES_ACK_KEY = 'EFYRA::GLOBAL-RULES::UNIQUE-FIELDS-ARE-INDEXED::2bW-20260701B';
export const DYNAMIC_CODE_KNOWLEDGE_ACK_KEY = 'EFYRA::SECURE-REPO-CONTRACT::R9x-kelp-42Q::NO-RAW-TRUSTED';
export const EXTENSION_KNOWLEDGE_ACK_KEY = 'EFYRA::EXTENSION-THEME-CONTRACT::VIOLET-IS-NOT-A-PLAN::7mQ';

const REQUIRED_KNOWLEDGE_VERSION = '2026-07-01.global-rules-v2';

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

export function buildRequiredKnowledgePayload() {
  return {
    version: REQUIRED_KNOWLEDGE_VERSION,
    purpose: 'Read this before mutating Enfyra metadata, schema, routes, permissions, menus, packages, cache state, dynamic server code, or extension UI through MCP.',
    globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    dynamicCodeAckKey: DYNAMIC_CODE_KNOWLEDGE_ACK_KEY,
    extensionAckKey: EXTENSION_KNOWLEDGE_ACK_KEY,
    usage: [
      'Pass globalRulesAckKey exactly as globalRulesAckKey when calling MCP tools that mutate Enfyra metadata, schema, routes, permissions, menus, packages, cache state, dynamic code, or extension UI.',
      'Pass dynamicCodeAckKey exactly as knowledgeAckKey when calling MCP tools that create or update dynamic server code.',
      'Pass extensionAckKey exactly as extensionKnowledgeAckKey when calling MCP tools that create or update Enfyra extension code.',
    ],
    globalRules: [
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
          'Read sourceCode, not compiledCode, for editable dynamic scripts.',
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
          'For table schema, a field that appears in any uniques group must not appear in indexes.',
          'A unique constraint already creates the indexed unique lookup for its fields.',
          'Use uniques for data integrity and indexes only for non-unique query-performance fields that are not already unique.',
          'Before create_table or update_table with indexes/uniques, inspect the current table and remove indexes that reference unique fields.',
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
    ],
    dynamicServerCode: [
      {
        id: 'secure-vs-trusted-repositories',
        rules: [
          '@REPOS.main is the secure repository for the current route main table and preserves normal route query behavior.',
          '@REPOS.secure.<table> is the secure explicit-table repository. Use it for public/user-facing custom handlers, hooks, websocket scripts, flows that return data, and third-party app integrations.',
          '@REPOS.<table> is the trusted internal repository. It may read/write hidden fields and is only for server-owned maintenance/admin logic that intentionally needs that access.',
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
          'Repository reads use filter, not where.',
          'Create/update repository calls return collection-shaped data arrays; read result.data?.[0] for a single row.',
        ],
      },
    ],
    extensions: [
      {
        id: 'theme-contract-first',
        rules: [
          'Call get_extension_theme_contract before writing or reviewing page, widget, or global extension UI.',
          'Call get_theme_class_reference when an exact eapp-* class or Nuxt UI color mapping is needed.',
          'Use eapp-surface-*, eapp-text-*, eapp-divide-y, and eapp-divider for neutral app-shell surfaces.',
          'Use eapp-primary-* or Nuxt UI primary only for runtime-primary identity/accent intent controlled by the app color picker.',
          'Use semantic state colors only for true status/error/warning/success/info indicators, not for large KPI/list containers.',
          'Do not use raw CSS variable utilities such as text-[var(...)], bg-[var(...)], or border-[var(...)] when class tokens exist.',
          'Do not hard-code concrete palettes such as color="violet" or Tailwind palette accents for themeable UI.',
        ],
      },
      {
        id: 'extension-shell-boundary',
        rules: [
          'Extension roots render inside the Enfyra admin app shell. Do not add root-level page padding such as p-4 sm:p-6 xl:p-8.',
          'Page extensions should be full-bleed by default and responsive from the first version.',
          'Do not wrap whole pages in decorative cards; use cards only for repeated items, modals, or genuinely framed tools.',
          'Use NuxtLink or Nuxt UI components with :to for visible navigation links; reserve navigateTo for imperative side effects.',
          'Admin extension links for record management should point to /data/<table>, not public website paths stored on records.',
        ],
      },
      {
        id: 'extension-runtime-contract',
        rules: [
          'Save extensions as enfyra_extension Vue SFC records; no static import statements in extension code.',
          'Do not call resolveComponent() in extension SFCs. Use auto-injected components such as <UButton>, <UBadge>, <PermissionGate>, and <Widget> directly in the template so the app/compiler resolves them correctly.',
          'Load app packages with getPackages(["package-name"]) inside extension runtime code.',
          'Prefer FormEditor/FormEditorLazy for direct table-backed forms when the form maps to metadata fields.',
          'For long admin setup workflows, open CommonDrawer immediately and show loading/error/content inside it.',
          'Use Widget with numeric enfyra_extension widget ids; pass safe reactive props/events and keep page-level mutation ownership in the page unless the widget intentionally owns the workflow.',
          'Use useMenuNotificationRegistry for sidebar menu counts/dots and useAccountPanelRegistry count/badge fields for account panel notifications; register these from global extensions when they should update across the shell.',
        ],
      },
    ],
  };
}
