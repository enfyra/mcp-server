export const EXAMPLE_CATEGORIES = {
  'ssr-app-auth': {
    title: 'SSR app auth, OAuth, refresh, and proxy setup',
    useWhen: 'Use when building Nuxt, Next, or another browser app that should rely on Enfyra cookies through an app-origin proxy.',
    examples: [
      {
        name: 'Nuxt routeRules for REST and Socket.IO',
        code: `export default defineNuxtConfig({
  routeRules: {
    "/enfyra/**": {
      proxy: {
        to: \`\${process.env.ENFYRA_API_URL}/**\`,
        fetchOptions: { redirect: "manual" }
      }
    },
    "/socket.io/**": {
      proxy: \`\${process.env.ENFYRA_APP_URL}/ws/socket.io/**\`
    }
  }
})`,
        notes: [
          'Browser code calls /enfyra/login, /enfyra/me, /enfyra/logout, and /enfyra/<table>.',
          'Keep redirects manual so OAuth set-cookie redirects reach the browser.',
          'Do not add custom token cookies when the proxy is enough.',
        ],
      },
      {
        name: 'Next rewrites for REST and Socket.IO',
        code: `const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/enfyra/:path*",
        destination: \`\${process.env.ENFYRA_API_URL}/:path*\`
      },
      {
        source: "/socket.io/",
        destination: \`\${process.env.ENFYRA_APP_URL}/ws/socket.io/\`
      }
    ]
  }
}

export default nextConfig`,
        notes: [
          'Use rewrites for browser traffic.',
          'If you add Next middleware/proxy for auth gating, server-side checks may call the Enfyra API origin directly while forwarding the incoming Cookie header.',
        ],
      },
      {
        name: 'Password login and current user fetch',
        code: `await fetch("/enfyra/login", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, remember: true })
})

const me = await fetch("/enfyra/me", {
  credentials: "include"
}).then((res) => res.ok ? res.json() : null)`,
        notes: [
          'Use /login, not /auth/login, for app/browser cookie login.',
          'Do not read or store JWTs in browser JavaScript in proxy-cookie mode.',
        ],
      },
      {
        name: 'Google OAuth button',
        code: `const redirect = new URL("/chat", window.location.origin)
const url = new URL("/enfyra/auth/google", window.location.origin)
url.searchParams.set("redirect", redirect.toString())
url.searchParams.set("cookieBridgePrefix", "/enfyra")
window.location.href = url.toString()`,
        notes: [
          'redirect must be absolute and must include the app origin.',
          'cookieBridgePrefix is the app proxy prefix that forwards to Enfyra API routes.',
          'Enfyra redirects through {redirect.origin}{cookieBridgePrefix}/auth/set-cookies before returning to redirect.',
        ],
      },
    ],
  },
  'schema-relations': {
    title: 'Tables, columns, relations, cascade, and indexes',
    useWhen: 'Use when creating or changing persisted data models.',
    examples: [
      {
        name: 'Create a chat conversation table',
        code: `create_table({
  name: "chat_conversation",
  columns: JSON.stringify([
    { name: "kind", type: "varchar", isNullable: false, defaultValue: "dm" },
    { name: "title", type: "varchar", isNullable: true },
    { name: "description", type: "text", isNullable: true }
  ])
})`,
        notes: [
          'create_table creates the default route for /chat_conversation.',
          'Keep the latest message as a relation named lastMessage after chat_message exists; do not duplicate last message text/date columns.',
          'Do not create tables just to get custom paths; use create_route for that.',
        ],
      },
      {
        name: 'Create relations directly to user_definition',
        code: `create_table({
  name: "chat_message",
  columns: JSON.stringify([
    { name: "text", type: "text", isNullable: false },
    { name: "persistStatus", type: "varchar", defaultValue: "persisted" }
  ]),
  relations: JSON.stringify([
    {
      propertyName: "conversation",
      type: "many-to-one",
      targetTable: { id: "<chat_conversation_id>" },
      isNullable: false,
      onDelete: "CASCADE"
    },
    {
      propertyName: "sender",
      type: "many-to-one",
      targetTable: { id: "<user_definition_id>" },
      isNullable: false,
      onDelete: "CASCADE"
    }
  ]),
  indexes: JSON.stringify([
    ["conversation", "createdAt"],
    ["sender", "createdAt"]
  ])
})`,
        notes: [
          'Use user_definition as the user table.',
          'Do not add inverse relations on user_definition unless the user explicitly asks.',
          'Do not provide physical FK column names; Enfyra derives them.',
        ],
      },
      {
        name: 'Add chat_conversation.lastMessage after chat_message exists',
        code: `update_table({
  tableId: "<chat_conversation_id>",
  relations: JSON.stringify([
    {
      propertyName: "createdBy",
      type: "many-to-one",
      targetTable: { id: "<user_definition_id>" },
      isNullable: true,
      onDelete: "CASCADE"
    },
    {
      propertyName: "lastMessage",
      type: "many-to-one",
      targetTable: { id: "<chat_message_id>" },
      isNullable: true,
      onDelete: "SET NULL"
    }
  ])
})`,
        notes: [
          'Use relation fields such as lastMessage.id,lastMessage.text,lastMessage.createdAt when loading conversation lists.',
          'When deleting the current last message, a post-hook should set lastMessage to the newest remaining message or null.',
        ],
      },
      {
        name: 'Unread/read table with unique and indexes',
        code: `create_table({
  name: "chat_message_read",
  columns: JSON.stringify([
    { name: "isRead", type: "boolean", defaultValue: false },
    { name: "readAt", type: "datetime", isNullable: true }
  ]),
  relations: JSON.stringify([
    { propertyName: "message", type: "many-to-one", targetTable: { id: "<chat_message_id>" }, onDelete: "CASCADE" },
    { propertyName: "conversation", type: "many-to-one", targetTable: { id: "<chat_conversation_id>" }, onDelete: "CASCADE" },
    { propertyName: "member", type: "many-to-one", targetTable: { id: "<user_definition_id>" }, onDelete: "CASCADE" }
  ]),
  uniques: JSON.stringify([["message", "member"]]),
  indexes: JSON.stringify([
    ["member", "isRead", "conversation"],
    ["conversation", "member", "isRead"]
  ])
})`,
        notes: [
          'Unread is per user and per message; do not put global read state on conversation.',
          'For chat-list UX, default to a boolean unread dot instead of exact counts.',
        ],
      },
      {
        name: 'Add server-owned user verification fields',
        code: `create_column({
  tableId: "<user_definition_table_id>",
  name: "emailVerifiedAt",
  type: "datetime",
  isNullable: true,
  isPublished: true,
  description: "When the user's email address was verified."
})

create_column({
  tableId: "<user_definition_table_id>",
  name: "emailVerificationStatus",
  type: "varchar",
  isNullable: false,
  defaultValue: "pending",
  isPublished: true,
  description: "Email verification state controlled by server hooks."
})`,
        notes: [
          'Run schema-changing calls sequentially. Do not parallelize create_column calls.',
          'create_column fetches table_definition and patches only real persisted columns with id/_id; generated metadata projections such as createdAt, updatedAt, or relation FK display fields are skipped.',
          'Use hooks or field permissions to prevent clients from updating server-owned fields.',
        ],
      },
    ],
  },
  'queries-deep': {
    title: 'REST queries, filters, meta counts, and deep relation fetches',
    useWhen: 'Use when fetching records, filtering by relations, loading nested data, or counting efficiently.',
    examples: [
      {
        name: 'List current user conversations through RLS',
        code: `GET /enfyra/chat_conversation?fields=id,kind,title,lastMessage.id,lastMessage.text,lastMessage.createdAt&limit=0`,
        notes: [
          'Use a conversation read pre-hook/RLS boundary so the route only returns conversations visible to @USER.',
          'lastMessage is a relation to chat_message; do not duplicate preview fields on chat_conversation.',
          'limit=0 means load all matching conversation rows.',
          'Do not fetch messages for every conversation on initial list load; load messages after selecting a conversation.',
        ],
      },
      {
        name: 'Fetch one record by id',
        code: `GET /enfyra/post?filter={"id":{"_eq":123}}&limit=1`,
        notes: [
          'There is no dynamic GET /<table>/<id> route.',
          'Use filter + limit=1 or MCP find_one_record.',
        ],
      },
      {
        name: 'Count without loading all rows',
        code: `GET /enfyra/chat_message_read?fields=id&limit=1&meta=filterCount&filter={
  "member": { "id": { "_eq": "<currentUserId>" } },
  "isRead": { "_eq": false }
}`,
        notes: [
          'Use meta=totalCount with no filter and meta=filterCount with a filter.',
          'Do not fetch all rows only to count them.',
        ],
      },
      {
        name: 'Deep relation query',
        code: `GET /enfyra/order?fields=id,total,customer&deep={
  "customer": { "fields": "id,email,displayName" },
  "items": {
    "fields": "id,quantity,product",
    "limit": 20,
    "deep": {
      "product": { "fields": "id,name,price" }
    }
  }
}`,
        notes: [
          'deep keys must be relation property names.',
          'Allowed deep options are fields, filter, sort, limit, page, and deep.',
          'Do not invent deep keys like members unless members is a relation on that table.',
        ],
      },
    ],
  },
  'handlers-hooks': {
    title: 'Custom handlers, pre-hooks, post-hooks, and script macros',
    useWhen: 'Use when writing Enfyra dynamic JavaScript for REST behavior.',
    examples: [
      {
        name: 'Custom register handler',
        code: `const email = @BODY.email
const password = @BODY.password

if (!email || !password) @THROW400("Email and password are required")

const existing = await #user_definition.find({
  filter: { email: { _eq: email } },
  limit: 1
})
if (existing.data[0]) @THROW409("Email is already registered")

const result = await #user_definition.create({
  data: {
    email,
    password: await @HELPERS.$bcrypt.hash(password)
  }
})

return result.data?.[0] ?? null`,
        notes: [
          'create/update return { data: [...] }, not a bare row.',
          'Use @THROW helpers for HTTP errors.',
          'Prefer macros over raw $ctx when a macro exists.',
        ],
      },
      {
        name: 'Pre-hook RLS filter merge',
        code: `const incoming = @QUERY.filter || {}
const scope = {
  memberships: {
    member: { id: { _eq: @USER.id } }
  }
}

@QUERY.filter = Object.keys(incoming).length
  ? { _and: [incoming, scope] }
  : scope`,
        notes: [
          '@QUERY.filter is initialized as an object for REST pre-hooks.',
          'Mutate @QUERY.filter before canonical CRUD runs.',
        ],
      },
      {
        name: 'Pre-hook encrypted field normalization',
        code: `create_pre_hook({
  routeId: "<route_id>",
  name: "encrypt_api_token",
  methods: ["POST", "PATCH"],
  priority: 0,
  code: \`const value = @BODY.api_token_encrypted
if (value && value.slice(0, 7) !== "enc:v1:") {
  @BODY.api_token_encrypted = @HELPERS.$encrypt.encrypt(value)
}\`
})`,
        notes: [
          'MCP create_pre_hook accepts code as the tool argument, then persists it to Enfyra as sourceCode with scriptLanguage.',
          'Do not call raw create_record with a code field for pre_hook_definition or post_hook_definition; backend CRUD rejects code.',
          'Use Enfyra pre-hooks for request-body normalization before canonical CRUD persists the record.',
          'Do not implement encrypted field normalization as a Knex/database hook.',
          'Use $encrypt for encryption and $ssh.generateKeyPair for SSH key generation; do not use $secrets.',
        ],
      },
      {
        name: 'Pre-hook strips protected body fields silently',
        code: `create_pre_hook({
  routeId: "<user_definition_patch_route_id>",
  name: "strip_email_verification_fields",
  methods: ["PATCH"],
  priority: -10,
  code: \`delete @BODY.emailVerifiedAt
delete @BODY.emailVerificationStatus
delete @BODY.emailVerificationSentAt\`
})`,
        notes: [
          'Use this pattern when clients may send protected user fields through /me or user_definition PATCH.',
          'Strip fields instead of throwing when the product wants a permissive client contract with server-owned fields.',
          'Use native macros such as @BODY instead of raw $ctx when a macro exists.',
        ],
      },
      {
        name: 'Post-hook response shaping',
        code: `create_post_hook({
  routeId: "<route_id>",
  name: "shape_display_title",
  methods: ["GET"],
  priority: 0,
  code: \`if (@ERROR) {
  @LOGS("Request failed", @ERROR.message)
  return
}

const row = Array.isArray(@DATA?.data) ? @DATA.data[0] : @DATA
if (row) {
  row.displayTitle = row.title || row.email || String(row.id)
}

return @DATA\`
})`,
        notes: [
          'MCP create_post_hook accepts code as the tool argument, then persists sourceCode/scriptLanguage to Enfyra.',
          'Post-hooks run after success and error paths.',
          'Return non-undefined only when replacing the response body.',
        ],
      },
    ],
  },
  'permissions-rls': {
    title: 'Route permissions, guards, field permissions, column rules, and RLS',
    useWhen: 'Use when securing routes or shaping what fields a user can read/write.',
    examples: [
      {
        name: 'Publish read-only route',
        code: `update_record({
  tableName: "route_definition",
  id: "<route_id>",
  data: {
    publishedMethods: [{ id: 1 }]
  }
})`,
        notes: [
          'Method id 1 is GET. Use method_definition if you need to confirm method ids.',
          'publishedMethods controls anonymous route access. Route permissions are not for public access.',
          'Route permissions apply when the method is not public.',
        ],
      },
      {
        name: 'Column rule for email format',
        code: `create_column_rule({
  tableName: "user_definition",
  columnName: "email",
  ruleType: "format",
  ruleConfig: JSON.stringify({ format: "email" }),
  message: "Please enter a valid email address"
})`,
        notes: [
          'Column rules validate canonical POST/PATCH body payloads.',
          'Use column rules before writing custom validation code when the rule is simple.',
        ],
      },
      {
        name: 'Field permission condition',
        code: `create_field_permission({
  tableName: "project",
  fieldName: "internal_notes",
  action: "read",
  condition: JSON.stringify({
    owner: { id: { _eq: "@USER.id" } }
  })
})`,
        notes: [
          'Field permissions are for field-level access.',
          'Use route/pre-hook filters for row-level access.',
        ],
      },
      {
        name: 'Admin menu and extension permission gates',
        code: `<template>
  <section class="space-y-4">
    <PermissionGate :condition="canReadCloudProjects">
      <template #default>
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-lg font-semibold">Cloud projects</h2>

          <PermissionGate :condition="canCreateCloudProject">
            <UButton icon="i-lucide-plus" label="Create project" @click="openCreate = true" />
          </PermissionGate>
        </div>

        <div v-for="project in projects" :key="project.id" class="rounded-lg border p-4">
          <NuxtLink :to="\`/cloud/projects/\${project.id}\`" class="font-medium">
            {{ project.name }}
          </NuxtLink>

          <div class="mt-3 flex gap-2">
            <PermissionGate :condition="canUpdateCloudProject">
              <UButton icon="i-lucide-pause" variant="soft" label="Disable" @click="openDisable(project)" />
            </PermissionGate>

            <PermissionGate :condition="canDeleteCloudProject">
              <UButton icon="i-lucide-trash-2" color="error" variant="soft" label="Delete" @click="openDelete(project)" />
            </PermissionGate>
          </div>
        </div>
      </template>

      <template #fallback>
        <EmptyState title="No access" description="You do not have permission to view Cloud projects." />
      </template>
    </PermissionGate>
  </section>
</template>

<script setup>
const { checkPermissionCondition } = usePermissions()

const canReadCloudProjects = computed(() => checkPermissionCondition({
  or: [
    { route: '/cloud/projects', methods: ['GET'] },
    { route: '/cloud_projects', methods: ['GET'] }
  ]
}))

const canCreateCloudProject = computed(() => checkPermissionCondition({
  or: [{ route: '/cloud_projects', methods: ['POST'] }]
}))

const canUpdateCloudProject = computed(() => checkPermissionCondition({
  or: [{ route: '/cloud_projects', methods: ['PATCH'] }]
}))

const canDeleteCloudProject = computed(() => checkPermissionCondition({
  or: [{ route: '/cloud_projects', methods: ['DELETE'] }]
}))
</script>`,
        notes: [
          'This is menu/extension visibility, not row-level RLS.',
          'Set menu_definition.permission on every sensitive admin menu. Example for /cloud/hosts: { or: [{ route: "/cloud/admin/hosts", methods: ["GET"] }, { route: "/cloud_servers", methods: ["GET"] }] }.',
          'Admin pages are sensitive. Use permission gates by default, not as an optional polish step.',
          'Menus should only be visible when the user has at least GET permission for the page route or backing data route.',
          'Inside the extension, gate each action by its own route/method: GET for page visibility, POST for create/flow-trigger buttons, PATCH for normal record edits, DELETE for native delete routes.',
          'Server route permissions remain mandatory; UI gates are for clear operator UX and least-privilege surfaces.',
        ],
      },
    ],
  },
  websocket: {
    title: 'Socket.IO gateways, events, rooms, and browser connection',
    useWhen: 'Use when creating realtime features.',
    examples: [
      {
        name: 'Browser client connection through app bridge',
        code: `import { io } from "socket.io-client"

const socket = io("/chat", {
  path: "/socket.io",
  withCredentials: true,
  transports: ["polling", "websocket"]
})`,
        notes: [
          '/chat is the Socket.IO namespace.',
          '/socket.io is the app-origin transport path proxied to Enfyra app /ws/socket.io.',
          'Do not connect browser code directly to the hidden backend.',
        ],
      },
      {
        name: 'Connection script joins user presence room',
        code: `if (!@USER?.id) {
  @SOCKET.disconnect()
  return
}

@SOCKET.join(\`user_\${@USER.id}\`)
@SOCKET.reply("chat:ready", { userId: @USER.id })`,
        notes: [
          'Authenticated Enfyra sockets already load @USER.',
          'Enfyra also joins user_<userId> for emitToUser delivery after connection succeeds.',
        ],
      },
      {
        name: 'Chat join event',
        code: `const conversationId = @BODY.conversationId
if (!conversationId) @THROW400("conversationId is required")

const membership = await @REPOS.chat_conversation_member.find({
  filter: {
    conversation: { id: { _eq: conversationId } },
    member: { id: { _eq: @USER.id } }
  },
  limit: 1
})

if (!membership.data[0]) @THROW403("Not a conversation member")

@SOCKET.join(\`conversation:\${conversationId}\`)
@SOCKET.reply("chat:joined", { conversationId })`,
        notes: [
          'Join conversation rooms, not member-id rooms.',
          'Check membership server-side; do not trust the client.',
        ],
      },
      {
        name: 'Chat message event with room broadcast and persistence',
        code: `const { conversationId, text, clientId } = @BODY
if (!conversationId || !text) @THROW400("conversationId and text are required")

const membership = await @REPOS.chat_conversation_member.find({
  filter: {
    conversation: { id: { _eq: conversationId } },
    member: { id: { _eq: @USER.id } }
  },
  limit: 1
})
if (!membership.data[0]) @THROW403("Not a conversation member")

const created = await @REPOS.chat_message.create({
  data: {
    conversation: { id: conversationId },
    sender: { id: @USER.id },
    text,
    persistStatus: "persisted"
  }
})

const message = created.data?.[0] ?? null
if (message?.id) {
  await @REPOS.chat_conversation.update({
    id: conversationId,
    data: { lastMessage: { id: message.id }, updatedAt: message.createdAt || new Date().toISOString() }
  })
}
@SOCKET.emitToRoom(\`conversation:\${conversationId}\`, "chat:message", {
  clientId,
  message
})

return { ok: true, message }`,
        notes: [
          'Do not ask the client for senderId; use @USER.id.',
          'Event scripts should explicitly emit replies/broadcasts.',
        ],
      },
    ],
  },
  flows: {
    title: 'Flows and step scripts',
    useWhen: 'Use when automating background work or chaining steps.',
    examples: [
      {
        name: 'Manual flow trigger from a post-hook',
        code: `if (!@ERROR && @DATA?.data?.[0]) {
  await @TRIGGER("send-welcome-email", {
    userId: @DATA.data[0].id,
    email: @DATA.data[0].email
  })
}`,
        notes: [
          'Use flows for workflow semantics, retries, and history.',
          'Do not use a flow just to persist a normal chat message.',
        ],
      },
      {
        name: 'Flow condition step',
        code: `const order = @FLOW_PAYLOAD.order
return order && order.total > 1000`,
        notes: [
          'Condition steps use JavaScript truthy/falsy.',
          'Children run according to branch true/false.',
        ],
      },
      {
        name: 'Flow query step config',
        code: `{
  "table": "user_definition",
  "filter": { "email": { "_contains": "@example.com" } },
  "limit": 50
}`,
        notes: [
          'Step configs are JSON; script steps use code strings.',
          'Use public-safe URLs for HTTP steps.',
        ],
      },
    ],
  },
  files: {
    title: 'Files, folders, upload metadata, and assets',
    useWhen: 'Use when handling uploads or returning uploaded files.',
    examples: [
      {
        name: 'Upload a file from browser',
        code: `const form = new FormData()
form.append("file", file)
form.append("folder", folderId)
form.append("title", "Invoice")

const uploaded = await fetch("/enfyra/files/upload", {
  method: "POST",
  credentials: "include",
  body: form
}).then((res) => res.json())`,
        notes: [
          'Do not set Content-Type manually for FormData.',
          'Use file routes/helpers instead of writing binary data into normal tables.',
        ],
      },
      {
        name: 'Use uploaded file in handler',
        code: `const file = $ctx.$uploadedFile
if (!file) @THROW400("File is required")

return {
  filename: file.originalname,
  mimetype: file.mimetype,
  size: file.size
}`,
        notes: [
          'Use file-specific context only in upload-capable routes.',
        ],
      },
    ],
  },
  extensions: {
    title: 'Dynamic app extensions and menus',
    useWhen: 'Use when adding custom UI pages to the Enfyra app.',
    examples: [
      {
        name: 'Create menu then extension',
        code: `create_menu({
  label: "Reports",
  type: "Menu",
  path: "/reports",
  icon: "lucide:bar-chart-3",
  order: 20,
  isEnabled: true
})

// Read the created menu id from the tool response, then:
create_extension({
  type: "page",
  name: "ReportsPage",
  description: "Reports dashboard",
  menuId: "<created-menu-id>",
  code: "<template><section class=\\"min-h-full w-full space-y-4\\"><div class=\\"grid gap-4 md:grid-cols-3\\"><UCard><p class=\\"text-sm text-muted\\">Total</p><p class=\\"mt-2 text-2xl font-semibold\\">0</p></UCard></div></section></template><script setup>const { registerPageHeader } = usePageHeaderRegistry(); registerPageHeader({ title: 'Reports', description: 'Operational report overview.', leadingIcon: 'lucide:bar-chart-3', gradient: 'cyan', variant: 'minimal' }); useHeaderActionRegistry({ id: 'refresh-reports', label: 'Refresh', icon: 'lucide:refresh-cw', onClick: () => {}, order: 0 })</script>",
  isEnabled: true
})`,
        notes: [
          'Menu provides navigation; extension provides content.',
          'Use menu_definition.label, not title.',
          'For page extensions, create the menu first and pass menuId to create_extension.',
          'Page extensions must register the app-shell PageHeader with usePageHeaderRegistry instead of rendering a custom top header.',
          'Use variant: "minimal" for operational pages unless a larger header is intentionally needed.',
          'Do not put ordinary KPI cards in PageHeader.stats; render metrics in the extension body.',
          'Put page-level actions in useHeaderActionRegistry or useSubHeaderActionRegistry.',
          'Page extensions should be full-bleed by default and responsive from the first version.',
          'The extension root is already inside eApp main; do not add root-level page padding.',
          'After saving, open eApp tabs should update through the server/eApp realtime reload contract; do not tell the user to refresh unless that contract is proven broken.',
        ],
      },
      {
        name: 'Page header and action button variants',
        code: `<script setup>
const { registerPageHeader } = usePageHeaderRegistry()

registerPageHeader({
  title: 'Host detail',
  description: 'Provider state, capacity, projects, and reconciliation status.',
  leadingIcon: 'lucide:server',
  gradient: 'cyan',
  variant: 'minimal'
})

useHeaderActionRegistry([
  {
    id: 'back-to-hosts',
    label: 'Hosts',
    icon: 'lucide:arrow-left',
    color: 'neutral',
    variant: 'ghost',
    order: 0,
    onClick: () => navigateTo('/cloud/hosts')
  },
  {
    id: 'run-host-check',
    label: 'Run check',
    icon: 'lucide:scan-search',
    color: 'neutral',
    variant: 'outline',
    order: 1,
    permission: { or: [{ route: '/cloud/admin/hosts/reconcile', methods: ['POST'] }] },
    onClick: runCheck
  },
  {
    id: 'refresh-host',
    label: 'Refresh',
    icon: 'lucide:refresh-cw',
    color: 'primary',
    variant: 'solid',
    order: 2,
    onClick: refresh
  }
])
</script>`,
        notes: [
          'Use PageHeader for the title strip; do not render a duplicate header inside extension body.',
          'Back/navigation actions should be neutral ghost so they read as navigation, not a primary operation.',
          'Visible secondary operations should be neutral outline; soft is only for low-emphasis chrome actions.',
          'The main page action should be primary solid.',
          'Do not choose soft only because it looks acceptable in dark mode; light mode must remain clear too.',
        ],
      },
      {
        name: 'Debug menu or extension changes that do not appear in open eApp tabs',
        code: `// Server side: menu_definition and extension_definition are runtime UI definitions.
// They must participate in partial reload, just like metadata/routes.
// Expected server contract:
// - cache orchestrator maps menu_definition -> menu reload
// - cache orchestrator maps extension_definition -> extension reload
// - successful writes emit $system:reload to the admin Socket.IO namespace

// eApp side expected listener behavior:
// if reload target is metadata/menu:
//   await fetch menus
//   rebuild menu registry with reset: true
//   invalidate dynamic extension cache too, because route-to-extension mapping may change
// if reload target is extension/menu or extension/global:
//   clear dynamic extension component/meta cache

// Verification pattern:
// 1. Save the menu or extension record.
// 2. Watch the open eApp tab for the $system:reload event.
// 3. Confirm sidebar/menu registry or extension component cache changed.
// 4. Only use manual reload endpoints or browser refresh after the natural event path is proven stale.`,
        notes: [
          'Do not treat menu and extension writes as plain CRUD when debugging live admin UI.',
          'Check both halves: ASV/ESV emits the reload event, and eApp consumes it.',
          'Menu reload should also invalidate extension cache because menu records attach page extensions to routes.',
          'Manual reload is a fallback, not the default fix.',
        ],
      },
      {
        name: 'Plan a Cloud admin dashboard as multiple pages',
        code: `// Recommended menu shape for an operations surface:
create_menu({
  type: "Dropdown Menu",
  label: "Cloud",
  path: "/cloud",
  icon: "lucide:cloud",
  order: 2,
  isEnabled: true
})

// Child page extensions should be focused:
// /dashboard            compact summary/routing hub: KPIs, current signal, attention queue, navigation cards
// /cloud/projects      project status and drill-downs
// /cloud/provisioning  project/run grouped provisioning status, current step, meaning, next action
// /cloud/billing       orders/subscriptions/refunds
// /cloud/infrastructure hosts/capacity/plans/system credential readiness
// /cloud/readiness     legal/Paddle/landing launch checklist
// Use UTabs inside large pages instead of placing every section in one dashboard.
// For admin record management, link to /data/<table>, e.g. /data/landing_terms, not public landing paths.`,
        notes: [
          'Design the menu/page split before generating dashboard code.',
          'Keep /dashboard as a summary and distribution page, not a detailed operations table.',
          'Use focused pages for operational domains.',
          'Each page extension must use usePageHeaderRegistry for the app-shell title strip and should not render a duplicate top header in the body.',
          'PageHeader.stats is reserved for deliberate overview headers; operational KPIs belong in body cards/tables.',
          'Provisioning pages should not show raw history rows as the primary UI; group by project/run and translate step keys into operator-facing labels.',
          'Operational lists should use pagination plus search/filter controls; do not rely on arbitrary fixed limits such as limit=50.',
          'UTabs is available in eApp extension runtime for page-level sections.',
          'Admin links for editing or inspecting records should point to /data/<table> routes.',
        ],
      },
      {
        name: 'Extension fetches Enfyra data',
        code: `<script setup>
const { data, pending, execute: fetchOrders } = useApi('/order_definition', {
  query: {
    limit: 10,
    sort: '-createdAt'
  }
})

onMounted(() => fetchOrders())
</script>

<template>
  <UButton :loading="pending" @click="fetchOrders">Refresh</UButton>
  <pre>{{ data }}</pre>
</template>`,
        notes: [
          'Use app-provided composables in extensions.',
          'useApi does not auto-run; call execute() on mounted or through an action.',
          'Keep extension UI focused; move backend logic into handlers/hooks when needed.',
        ],
      },
      {
        name: 'Extension can use modern browser APIs',
        code: `<script setup lang="ts">
const statuses = ['active', 'ready']
const ok = statuses.includes('active')
const requiredTerms = new Set(['cloud-terms', 'privacy-policy', 'refund-policy'])
const loaded = await Promise.all([Promise.resolve(1), Promise.resolve(2)])
const label = String('pending_payment').replace(/_/g, ' ')
const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date())
console.log(ok, requiredTerms.has('cloud-terms'), loaded, label, date)
</script>`,
        notes: [
          'Do not rewrite extension code to ES5 when tooling rejects modern APIs.',
          'If diagnostics complain about these APIs, fix eApp extension TypeScript lib/runtime contract.',
        ],
      },
      {
        name: 'Dashboard aggregate stats with a time range',
        code: `<script setup>
const range = ref('7d')
const now = () => new Date()
const rangeStart = computed(() => {
  const d = now()
  if (range.value === '24h') d.setHours(d.getHours() - 24)
  else if (range.value === '30d') d.setDate(d.getDate() - 30)
  else d.setDate(d.getDate() - 7)
  return d.toISOString()
})

const flowStats = useApi('/flow_execution_definition', {
  query: computed(() => ({
    fields: 'id',
    limit: 1,
    meta: 'filterCount',
    filter: { startedAt: { _gte: rangeStart.value } },
    aggregate: {
      id: { count: true },
      status: { count: { _eq: 'failed' } }
    }
  }))
})

const orderStats = useApi('/cloud_payment_orders', {
  query: computed(() => ({
    fields: 'id',
    limit: 1,
    meta: 'filterCount',
    filter: { createdAt: { _gte: rangeStart.value } },
    aggregate: {
      id: { count: true },
      status: { count: { _eq: 'applied' } },
      amount_usd: { sum: true }
    }
  }))
})

watch(range, () => Promise.all([flowStats.execute(), orderStats.execute()]))
onMounted(() => Promise.all([flowStats.execute(), orderStats.execute()]))
</script>`,
        notes: [
          'Aggregate keys must be real fields or relations.',
          'Read results from response.meta.aggregate.',
          'Use top-level filter for time windows and cross-field conditions.',
          'sum/avg require numeric fields; amount_usd must be a real float/numeric SQL column, not metadata-only float over a varchar physical column.',
        ],
      },
    ],
  },
};

export function listExampleCategories() {
  return Object.entries(EXAMPLE_CATEGORIES).map(([key, value]) => ({
    key,
    title: value.title,
    useWhen: value.useWhen,
  }));
}

export function getExamples(category) {
  if (!category) {
    return {
      categories: listExampleCategories(),
      hint: 'Call get_enfyra_examples with one category key to retrieve concrete examples for that area.',
    };
  }

  const entry = EXAMPLE_CATEGORIES[category];
  if (!entry) {
    return {
      error: `Unknown example category "${category}"`,
      categories: listExampleCategories(),
    };
  }

  return {
    category,
    ...entry,
  };
}
