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
        name: 'Post-hook response shaping',
        code: `if (@ERROR) {
  @LOGS("Request failed", @ERROR.message)
  return
}

const row = Array.isArray(@DATA?.data) ? @DATA.data[0] : @DATA
if (row) {
  row.displayTitle = row.title || row.email || String(row.id)
}

return @DATA`,
        notes: [
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
  title: "Reports",
  path: "/reports",
  icon: "i-lucide-bar-chart-3",
  order: 20
})

create_extension({
  name: "ReportsPage",
  route: "/reports",
  component: "<template><div>Reports</div></template>"
})`,
        notes: [
          'Menu provides navigation; extension provides content.',
          'Extensions are Vue SFC records.',
        ],
      },
      {
        name: 'Extension fetches Enfyra data',
        code: `<script setup>
const { data, pending, refresh } = await useApi('/order_definition', {
  query: {
    limit: 10,
    sort: '-createdAt'
  }
})
</script>

<template>
  <UButton :loading="pending" @click="refresh">Refresh</UButton>
  <pre>{{ data }}</pre>
</template>`,
        notes: [
          'Use app-provided composables in extensions.',
          'Keep extension UI focused; move backend logic into handlers/hooks when needed.',
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
