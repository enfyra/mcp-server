export const EXAMPLE_REASONING_GUIDE = [
  'Examples are reasoning anchors, not templates to copy blindly. Preserve the platform contract, then adapt table names, route paths, relation names, fields, UI labels, and lifecycle triggers to the live app.',
  'First identify the invariant being demonstrated: security boundary, query shape, shell registry contract, schema relation direction, runtime lifecycle, or browser proxy pattern.',
  'Then identify what is illustrative: chat/order/report/cloud paths, sample field names, icons, labels, menu order, and specific notification kinds.',
  'When a note says do not, treat it as a contract or safety boundary unless live metadata proves a different supported contract. When a note says for example, map the idea to the current domain instead of copying the literal names.',
  'Before applying an example, inspect live metadata/routes/features and choose the closest supported tool. Use the smallest example that proves the decision, then compose with other examples only when the task truly needs multiple contracts.',
];

export const EXAMPLE_CATEGORIES = {
  'ssr-app-auth': {
    title: 'SSR app auth, OAuth, refresh, and proxy setup',
    useWhen: 'Use when building Nuxt, Next, or another browser app that should rely on Enfyra cookies through an app-origin proxy; adapt the framework-specific wrapper while preserving the same-origin proxy and cookie boundary.',
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
        name: 'Angular dev proxy for REST and Socket.IO',
        code: `// src/proxy.conf.json
{
  "/enfyra/**": {
    "target": "https://demo.enfyra.io/api",
    "secure": true,
    "changeOrigin": true,
    "pathRewrite": {
      "^/enfyra": ""
    }
  },
  "/socket.io/**": {
    "target": "https://demo.enfyra.io/api/ws",
    "secure": true,
    "changeOrigin": true,
    "ws": true
  }
}

// angular.json
{
  "projects": {
    "app": {
      "architect": {
        "serve": {
          "options": {
            "proxyConfig": "src/proxy.conf.json"
          }
        }
      }
    }
  }
}`,
        notes: [
          'Browser code still calls /enfyra/login, /enfyra/me, /enfyra/logout, and /enfyra/<table>.',
          'The /enfyra proxy strips the prefix before forwarding to the Enfyra API origin.',
          'The /socket.io proxy forwards to the Enfyra app bridge /ws/socket.io while keeping the browser transport path as /socket.io.',
          'Restart ng serve after changing proxy.conf.json.',
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
        name: 'Nuxt client plugin for authenticated realtime',
        code: `// composables/useRealtime.ts
import { io, type Socket } from "socket.io-client"
import { readonly, ref, shallowRef } from "vue"

const socket = shallowRef<Socket | null>(null)
const isConnected = ref(false)

export function useRealtime() {
  function connect() {
    if (import.meta.server) return null
    if (socket.value) return socket.value

    const nextSocket = io("/chat", {
      path: "/socket.io",
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000
    })

    nextSocket.on("connect", () => {
      isConnected.value = true
    })
    nextSocket.on("disconnect", () => {
      isConnected.value = false
    })

    socket.value = nextSocket
    return nextSocket
  }

  function disconnect() {
    if (!socket.value) return
    socket.value.disconnect()
    socket.value = null
    isConnected.value = false
  }

  function onMessage(handler) {
    const activeSocket = socket.value ?? connect()
    if (!activeSocket) return () => {}
    activeSocket.on("chat:message", handler)
    return () => activeSocket.off("chat:message", handler)
  }

  return { socket, isConnected: readonly(isConnected), connect, disconnect, onMessage }
}

// plugins/realtime.client.ts
import { watch } from "vue"

export default defineNuxtPlugin(() => {
  const { me } = useAuth()
  const realtime = useRealtime()

  watch(
    me,
    user => {
      if (user) realtime.connect()
      else realtime.disconnect()
    },
    { immediate: true }
  )
})

// pages/chat.vue
const realtime = useRealtime()
let stopRealtime = () => {}

onMounted(() => {
  stopRealtime = realtime.onMessage(event => {
    // Update local UI state, then debounce REST refresh if full state is needed.
  })
})

onUnmounted(() => {
  stopRealtime()
})`,
        notes: [
          'Create the socket once in a client-only plugin after auth has resolved; pages should not own the initial connection lifecycle.',
          'Use the websocket namespace path from live metadata, such as /chat, and keep the transport path as /socket.io.',
          'Proxy /socket.io/** to the Enfyra app bridge /ws/socket.io/** so cookies are same-origin.',
          'Route components add event listeners and remove them on unmount; they can optimistically update local state and debounce REST refreshes.',
          'Disconnect the singleton socket when the current user/session clears.',
        ],
      },
      {
        name: 'Angular HttpClient auth service and route guard',
        code: `// app.config.ts
import { ApplicationConfig, inject } from "@angular/core"
import { provideRouter, CanActivateFn, Router } from "@angular/router"
import { HttpInterceptorFn, provideHttpClient, withInterceptors } from "@angular/common/http"
import { catchError, map, of } from "rxjs"

import { routes } from "./app.routes"
import { EnfyraAuthService } from "./enfyra-auth.service"

export const enfyraCredentialsInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith("/enfyra/")) return next(req)
  return next(req.clone({ withCredentials: true }))
}

export const requireUserGuard: CanActivateFn = () => {
  const auth = inject(EnfyraAuthService)
  const router = inject(Router)

  return auth.loadMe().pipe(
    map(user => user ? true : router.createUrlTree(["/login"])),
    catchError(() => of(router.createUrlTree(["/login"])))
  )
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([enfyraCredentialsInterceptor])),
    provideRouter(routes)
  ]
}

// enfyra-auth.service.ts
import { Injectable, signal } from "@angular/core"
import { HttpClient } from "@angular/common/http"
import { Observable, tap } from "rxjs"

type EnfyraUser = { id: string | number; email?: string }

@Injectable({ providedIn: "root" })
export class EnfyraAuthService {
  readonly user = signal<EnfyraUser | null>(null)

  constructor(private readonly http: HttpClient) {}

  login(email: string, password: string): Observable<unknown> {
    return this.http.post("/enfyra/login", { email, password, remember: true }).pipe(
      tap(() => this.loadMe().subscribe())
    )
  }

  loadMe(): Observable<EnfyraUser | null> {
    return this.http.get<EnfyraUser | null>("/enfyra/me").pipe(
      tap(user => this.user.set(user))
    )
  }

  logout(): Observable<unknown> {
    return this.http.post("/enfyra/logout", {}).pipe(
      tap(() => this.user.set(null))
    )
  }

  startGoogleOAuth(returnPath = "/") {
    const redirect = new URL(returnPath, window.location.origin)
    const url = new URL("/enfyra/auth/google", window.location.origin)
    url.searchParams.set("redirect", redirect.toString())
    url.searchParams.set("cookieBridgePrefix", "/enfyra")
    window.location.href = url.toString()
  }
}`,
        notes: [
          'Use HttpClient with a credentials interceptor for /enfyra/* calls so cookies are sent consistently.',
          'The guard is only for user experience; Enfyra route permissions and server-side owner checks remain authoritative.',
          'Keep the current user in an Angular service or store; do not read JWTs from cookies or URLs.',
          'OAuth starts at the app proxy path and returns through the cookie bridge before the Angular route loads /enfyra/me.',
        ],
      },
      {
        name: 'Next client provider for authenticated realtime',
        code: `"use client"

// app/realtime-provider.tsx
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import { io, type Socket } from "socket.io-client"

type RealtimeContextValue = {
  socket: Socket | null
  isConnected: boolean
}

const RealtimeContext = createContext<RealtimeContextValue>({
  socket: null,
  isConnected: false
})

export function RealtimeProvider({
  user,
  children
}: {
  user: { id: string | number } | null
  children: React.ReactNode
}) {
  const socketRef = useRef<Socket | null>(null)
  const [isConnected, setConnected] = useState(false)

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect()
      socketRef.current = null
      setConnected(false)
      return
    }

    if (socketRef.current) return

    const socket = io("/chat", {
      path: "/socket.io",
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000
    })

    socket.on("connect", () => setConnected(true))
    socket.on("disconnect", () => setConnected(false))
    socketRef.current = socket

    return () => {
      socket.off("connect")
      socket.off("disconnect")
      socket.disconnect()
      socketRef.current = null
      setConnected(false)
    }
  }, [user])

  const value = useMemo(
    () => ({ socket: socketRef.current, isConnected }),
    [isConnected]
  )

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

export function useRealtime() {
  return useContext(RealtimeContext)
}

// app/chat/page.tsx
// const { socket } = useRealtime()
// useEffect(() => {
//   if (!socket) return
//   const onMessage = event => {
//     // Update local UI state, then debounce REST refresh if full state is needed.
//   }
//   socket.on("chat:message", onMessage)
//   return () => socket.off("chat:message", onMessage)
// }, [socket])`,
        notes: [
          'Create the Socket.IO client once in a top-level client provider after the current user is known.',
          'Use the websocket namespace path from live metadata, such as /chat, and keep the transport path as /socket.io.',
          'Proxy /socket.io through Next rewrites to the Enfyra app bridge /ws/socket.io so cookies remain same-origin.',
          'Pages/components should only subscribe/unsubscribe listeners; they should not create independent socket connections.',
          'Disconnect the singleton socket when the current user/session clears.',
        ],
      },
      {
        name: 'Angular singleton Socket.IO realtime service',
        code: `// enfyra-realtime.service.ts
import { Injectable, computed, effect, signal } from "@angular/core"
import { io, Socket } from "socket.io-client"

import { EnfyraAuthService } from "./enfyra-auth.service"

@Injectable({ providedIn: "root" })
export class EnfyraRealtimeService {
  private socket: Socket | null = null
  private readonly connected = signal(false)
  readonly isConnected = computed(() => this.connected())

  constructor(private readonly auth: EnfyraAuthService) {
    effect(() => {
      const user = this.auth.user()
      if (user) this.connect()
      else this.disconnect()
    })
  }

  connect() {
    if (this.socket) return this.socket

    this.socket = io("/chat", {
      path: "/socket.io",
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000
    })

    this.socket.on("connect", () => this.connected.set(true))
    this.socket.on("disconnect", () => this.connected.set(false))
    return this.socket
  }

  disconnect() {
    this.socket?.disconnect()
    this.socket = null
    this.connected.set(false)
  }

  onMessage(handler: (event: unknown) => void) {
    const activeSocket = this.connect()
    activeSocket.on("chat:message", handler)
    return () => activeSocket.off("chat:message", handler)
  }
}`,
        notes: [
          'Create one app-level Socket.IO connection after auth is known.',
          'Use the websocket namespace path from live metadata, such as /chat, and keep the transport path as /socket.io.',
          'Components subscribe with onMessage and call the returned cleanup function in ngOnDestroy.',
          'Do not create a new socket per routed component.',
        ],
      },
      {
        name: 'OAuth provider setup values',
        code: `// Enfyra OAuth config row, stored in enfyra_oauth_config.
{
  "provider": "google",
  "clientId": "<google-client-id>",
  "clientSecret": "<google-client-secret>",
  "redirectUri": "http://localhost:3000/api/auth/google/callback",
  "isEnabled": true
}

// Google Cloud Console -> Authorized redirect URIs:
// http://localhost:3000/api/auth/google/callback`,
        notes: [
          'redirectUri is the Enfyra callback URL: {ENFYRA_API_URL}/auth/google/callback.',
          'The provider console callback URL and enfyra_oauth_config.redirectUri must match exactly.',
          'This callback URL is not the app return page; the app return page is sent as the redirect query when starting OAuth.',
          'Use appCallbackUrl only for manual-token apps that intentionally read token query parameters.',
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
          'After returning, call /enfyra/me to load the authenticated user; do not parse tokens from the URL in proxy-cookie mode.',
        ],
      },
    ],
  },
  'oauth-setup': {
    title: 'OAuth provider setup',
    useWhen: 'Use when configuring Google or another OAuth provider for an Enfyra-backed app.',
    examples: [
      {
        name: 'Google OAuth setup workflow',
        code: `// 1. Ask for the public app/admin URL, not the API URL.
// Example input from the user:
const appUrl = "https://demo.enfyra.io"

// 2. Derive the Enfyra API base and provider callback.
const apiBase = appUrl.replace(/\\/$/, "") + "/api"
const googleCallbackUrl = apiBase + "/auth/google/callback"

// 3. Tell the user to paste this exact value into Google Cloud Console:
// APIs & Services -> Credentials -> OAuth 2.0 Client -> Authorized redirect URIs
// https://demo.enfyra.io/api/auth/google/callback

// 4. After the user provides Google client id/secret, save Enfyra config:
create_records({
  tableName: "enfyra_oauth_config",
  globalRulesAckKey: "<globalRulesAckKey>",
  records: [
    {
      provider: "google",
      clientId: "<google-client-id>",
      clientSecret: "<google-client-secret>",
      redirectUri: googleCallbackUrl,
      isEnabled: true
    }
  ]
})`,
        notes: [
          'Ask for the app/admin URL such as https://demo.enfyra.io; derive the API base by appending /api.',
          'The provider callback is {appUrl}/api/auth/{provider}/callback and must exactly match the Authorized redirect URI in Google Cloud Console.',
          'Do not ask the user to choose or type the callback URL manually once the app URL is known; compute it and show the exact value to paste.',
          'The OAuth callback is the Enfyra provider callback, not the final app page.',
          'When starting OAuth from a browser app, use the same-origin proxy route with redirect and cookieBridgePrefix as shown in ssr-app-auth examples.',
        ],
      },
      {
        name: 'Browser OAuth start URL after setup',
        code: `const returnUrl = new URL("/dashboard", window.location.origin)
const oauthUrl = new URL("/enfyra/auth/google", window.location.origin)
oauthUrl.searchParams.set("redirect", returnUrl.toString())
oauthUrl.searchParams.set("cookieBridgePrefix", "/enfyra")
window.location.href = oauthUrl.toString()`,
        notes: [
          'This is the browser start URL through the app proxy; it is different from the Google Authorized redirect URI.',
          'After Enfyra finishes the Google callback, it bridges cookies through /enfyra/auth/set-cookies and returns to the absolute redirect URL.',
          'After return, call /enfyra/me to load the user.',
        ],
      },
      {
        name: 'Update an existing Google OAuth config',
        code: `const existing = await query_table({
  tableName: "enfyra_oauth_config",
  filter: JSON.stringify({ provider: { _eq: "google" } }),
  fields: ["id", "provider", "redirectUri", "isEnabled"],
  limit: 1
})

// If a row exists, update it instead of creating a duplicate.
update_records({
  tableName: "enfyra_oauth_config",
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [
    {
      id: "<existing-config-id>",
      data: {
        clientId: "<google-client-id>",
        clientSecret: "<google-client-secret>",
        redirectUri: "https://demo.enfyra.io/api/auth/google/callback",
        isEnabled: true
      }
    }
  ]
})`,
        notes: [
          'Inspect first so setup is idempotent.',
          'Use the current system table name enfyra_oauth_config.',
          'Never expose the client secret back in app code or documentation.',
        ],
      },
    ],
  },
  'schema-relations': {
    title: 'Tables, columns, relations, cascade, and indexes',
    useWhen: 'Use when creating or changing persisted data models.',
    examples: [
      {
        name: 'Bulk schema creation with one-item-or-many arrays',
        code: `// 0. First call get_schema_design_context and get_enfyra_required_knowledge.
// 1. create_tables is always native-array-shaped. One table = one item.
create_tables({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [
    {
      name: "app_lookup",
      columns: [
        { name: "name", type: "varchar", isNullable: false },
        { name: "slug", type: "varchar", isNullable: false },
        { name: "description", type: "text", isNullable: true }
      ],
      uniques: [["slug"]]
    },
    {
      name: "app_primary_record",
      columns: [
        { name: "title", type: "varchar", isNullable: false },
        { name: "summary", type: "text", isNullable: true },
        { name: "amount", type: "float", isNullable: false, defaultValue: "0" },
        { name: "status", type: "varchar", isNullable: false, defaultValue: "draft" },
        { name: "metadata", type: "simple-json", isNullable: true }
      ],
      relations: [
        { propertyName: "lookup", type: "many-to-one", targetTable: "app_lookup", isNullable: true, onDelete: "SET NULL" },
        { propertyName: "owner", type: "many-to-one", targetTable: "enfyra_user", isNullable: false, onDelete: "CASCADE" }
      ],
      indexes: [["status", "createdAt"], ["lookup", "status"]]
    },
    {
      name: "app_participation",
      columns: [
        { name: "status", type: "varchar", isNullable: false, defaultValue: "active" },
        { name: "score", type: "float", isNullable: false, defaultValue: "0" }
      ],
      relations: [
        { propertyName: "record", type: "many-to-one", targetTable: "app_primary_record", isNullable: false, onDelete: "CASCADE" },
        { propertyName: "actor", type: "many-to-one", targetTable: "enfyra_user", isNullable: false, onDelete: "CASCADE" }
      ],
      uniques: [["record", "actor"]],
      indexes: [["status", "createdAt"]]
    }
  ]
})

// 2. create_records is also native-array-shaped. One row = one item.
create_records({
  tableName: "app_primary_record",
  globalRulesAckKey: "<globalRulesAckKey>",
  records: [
    {
      title: "<display title>",
      amount: 29.99,
      status: "active",
      lookup: "<app_lookup_id>",
      owner: "<enfyra_user_id>"
    }
  ]
})`,
        notes: [
          'All mutation tools are plural envelopes. Pass native arrays, with one item in the array for a single mutation.',
          'create_tables creates tables/columns first, then creates requested relations after all batch tables exist, so target table ordering is handled by the tool.',
          'Do not declare id, _id, createdAt, or updatedAt columns; Enfyra manages them automatically.',
          'When a unique/index group uses relation propertyName values, declare those relations in the same table item or add the constraint later with update_tables after the relations exist.',
          'Use live column types from get_schema_design_context. Prefer float for decimal-like money/ratings unless live metadata explicitly supports decimal.',
          'Do not create lookupId, owner_id, actorId, or recordIds scalar fields for normalized relationships. Use relations and write relation propertyName values.',
          'A unique pair such as record+actor already creates the indexed unique lookup; keep those fields out of indexes.',
        ],
      },
      {
        name: 'Bulk add columns and relations after initial schema',
        code: `create_columns({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [
    {
      tableId: "<enfyra_user_table_id>",
      name: "emailVerifiedAt",
      type: "datetime",
      isNullable: true,
      isPublished: true
    },
    {
      tableId: "<integration_secret_table_id>",
      name: "value",
      type: "text",
      isNullable: false,
      isPublished: false,
      isEncrypted: true
    }
  ]
})

create_relations({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [
    {
      sourceTableId: "chat_conversation",
      targetTableId: "chat_message",
      propertyName: "lastMessage",
      type: "many-to-one",
      isNullable: true,
      onDelete: "SET NULL"
    }
  ]
})`,
        notes: [
          'create_columns/create_relations run items sequentially through the schema queue.',
          'Use relation property names only. Never provide fkCol, sourceColumn, targetColumn, or junction column names.',
          'Use inversePropertyName only when a concrete parent detail/deep/count/sort use case needs the reverse traversal.',
          'Use isEncrypted=true for encryption at rest. Add isUpdatable=false separately only when the field should be immutable.',
        ],
      },
      {
        name: 'Bulk update and destructive preview',
        code: `update_tables({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [
    { tableId: "<table_id>", graphqlEnabled: true },
    { tableId: "<settings_table_id>", isSingleRecord: true }
  ]
})

// Destructive tools preview first.
delete_columns({
  items: [{ tableId: "<table_id>", columnId: "<column_id>" }]
})

// Apply only after explicit user approval.
delete_columns({
  globalRulesAckKey: "<globalRulesAckKey>",
  confirm: true,
  items: [{ tableId: "<table_id>", columnId: "<column_id>" }]
})`,
        notes: [
          'update_tables/update_columns/update_records reject ambiguous duplicate ids where applicable and run sequentially.',
          'delete_tables/delete_columns/delete_relations/delete_records return previews unless confirm=true.',
          'Schema tools serialize internally; do not parallelize schema mutation tool calls.',
        ],
      },
    ],
  },
  'queries-deep': {
    title: 'REST queries, filters, meta counts, and deep relation fetches',
    useWhen: 'Use when fetching records, filtering by relations, loading nested relation data in the same request, or counting efficiently.',
    examples: [
      {
        name: 'Minimal MCP query then explicit detail query',
        code: `query_table({
  tableName: "enfyra_user",
  fields: ["id", "email"],
  filter: { email: { _contains: "@example.com" } },
  limit: 10
})`,
        notes: [
          'Always pass fields when you need more than ids; query_table without fields intentionally returns only the primary key.',
          'Use inspect_table first when you do not know valid column names or relation propertyName values.',
          'Use count_records when only the count is needed.',
          'When the user asks for all matching rows, pass all: true instead of choosing an arbitrary page size such as 30 or 50.',
        ],
      },
      {
        name: 'List current user conversations through RLS',
        code: `query_table({
  tableName: "chat_conversation",
  fields: ["id", "kind", "title", "lastMessage.id", "lastMessage.text", "lastMessage.createdAt"],
  all: true
})`,
        notes: [
          'Use a conversation read pre-hook/RLS boundary so the route only returns conversations visible to @USER.',
          'lastMessage is a relation to chat_message; do not duplicate preview fields on chat_conversation.',
          'all: true tells MCP to send REST limit=0 and load all matching conversation rows.',
          'This is a small bounded user inbox example. For larger inventories, prefer pagination even when RLS scopes the records.',
          'Do not fetch messages for every conversation on initial list load; load messages after selecting a conversation.',
        ],
      },
      {
        name: 'Fetch one record by id',
        code: `find_one_record({
  tableName: "post",
  id: "123",
  fields: ["id", "title", "createdAt"]
})

// REST equivalent after inspecting metadata primary key:
GET /enfyra/post?filter={"<primaryKeyFromMetadata>":{"_eq":123}}&limit=1`,
        notes: [
          'There is no dynamic GET /<table>/<id> route.',
          'Prefer MCP find_one_record because it resolves the primary key from live metadata.',
          'If writing raw REST, inspect metadata first and use the real primary key field; do not assume id on every backend.',
        ],
      },
      {
        name: 'Count without loading all rows',
        code: `query_table({
  tableName: "chat_message_read",
  fields: ["id"],
  limit: 1,
  meta: "filterCount",
  filter: {
    member: { id: { _eq: "<currentUserId>" } },
    isRead: { _eq: false }
  }
})`,
        notes: [
          'Use meta=totalCount with no filter and meta=filterCount with a filter.',
          'MCP count_records wraps this pattern for simple counts.',
          'Do not fetch all rows only to count them.',
        ],
      },
      {
        name: 'Relation fields without deep',
        code: `query_table({
  tableName: "order",
  fields: [
    "id",
    "total",
    "customer.id",
    "customer.email",
    "customer.displayName"
  ],
  limit: 20
})`,
        notes: [
          'Use fields with dotted relation paths when you only need scalar fields from related records.',
          'This is enough for simple many-to-one or one-to-one relation display such as owner.email, customer.name, or lastMessage.text.',
          'Treat order/customer as placeholders; the transferable idea is "show parent rows with a few scalar relation fields".',
          'Do not add deep when fields alone can express the relation data you need.',
        ],
      },
      {
        name: 'Exclude large generated fields',
        code: `query_table({
  tableName: "enfyra_route_handler",
  fields: ["-compiledCode"],
  limit: 20
})

query_table({
  tableName: "post",
  fields: ["id", "-author.avatar"],
  deep: {
    comments: {
      fields: "-compiledCode,-author.avatar",
      limit: 10,
      deep: {
        author: { fields: "-avatar" }
      }
    }
  }
})`,
        notes: [
          'Use fields=-compiledCode when reading script-backed records; sourceCode is the editable contract and compiledCode is generated by the server.',
          'Any -field token switches that fields scope to exclude mode, so fields=id,-compiledCode returns all readable fields except compiledCode.',
          'Dotted exclusions and deep relation fields use the same exclude-mode rule.',
          'Excluded fields and relations must exist in metadata; typos should fail instead of silently returning large or sensitive fields.',
        ],
      },
      {
        name: 'Deep relation query options',
        code: `query_table({
  tableName: "order",
  fields: ["id", "total"],
  deep: {
    items: {
      fields: "id,quantity,product",
      sort: "-createdAt",
      limit: 20,
      deep: {
        product: { fields: "id,name,price" }
      }
    }
  }
})`,
        notes: [
          'Use deep when relation loading needs query options such as filter, sort, limit, page, or nested deep.',
          'Deep is mainly useful for controlled child collections or nested relation fetches, not for basic related-field display.',
          'Do not use deep just to filter by a relation id; use a normal relation filter instead.',
          'Do not use deep for counts; use count_records or meta=filterCount/totalCount.',
          'Do not deep-load large child collections without an explicit limit/page. For heavy screens, fetch the parent list first, then load the selected child collection separately with pagination.',
          'Use query_table deep for normal MCP reads; use test_rest_endpoint only when you need a custom raw URL or route behavior test.',
          'deep keys must be relation property names.',
          'Allowed deep options are fields, filter, sort, limit, page, and deep.',
          'Use fields, never _fields, inside deep relation options.',
          'Do not invent deep keys like members unless members is a relation on that table.',
        ],
      },
      {
        name: 'Sort parent rows by child relation aggregates',
        code: `query_table({
  tableName: "cloud_support_tickets",
  fields: [
    "id",
    "subject",
    "status",
    "project.id",
    "project.name"
  ],
  sort: "-_max(messages.createdAt),-createdAt",
  limit: 25,
  deep: JSON.stringify({
    messages: {
      fields: "id,authorKind,body,createdAt",
      sort: "-createdAt",
      limit: 3
    }
  })
})

// Other parent aggregate sorts:
// sort=-_count(messages)
// sort=_min(messages.createdAt)`,
        notes: [
          'Use _max(relation.field) for latest-child ordering, _min(relation.field) for earliest-child ordering, and _count(relation) for child-count ordering.',
          'Aggregate sort helpers only work on direct one-to-many or many-to-many list relations.',
          'Support tickets and messages are illustrative. Apply this when a parent list must be ordered by child recency or child volume.',
          'The aggregate field must be a real published, non-encrypted scalar field on the related table for user-facing APIs.',
          'Do not use _max, _min, or _count on private relations or unpublished fields unless the endpoint intentionally exposes that fact.',
          'Do not use raw sort=-messages.createdAt for parent ordering; it is ambiguous and rejected.',
          'deep.messages.sort only orders the loaded message rows inside each ticket, so keep parent sort and child pagination as separate concerns.',
        ],
      },
      {
        name: 'Encrypted fields are not lookup fields',
        code: `// Bad: api_token is isEncrypted=true, so filter/sort cannot use it.
GET /enfyra/integrations?filter={"api_token":{"_eq":"plaintext-token"}}

// Good: store a separate non-secret lookup hash if lookup is needed.
create_columns({
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  items: [
    {
      tableId: "<integrations_table_id>",
      name: "api_token_lookup_sha256",
      type: "varchar",
      isNullable: false,
      isPublished: false
    }
  ]
})

// In the create/update handler or pre-hook, hash plaintext before it is encrypted.
if (@BODY.api_token) {
  @BODY.api_token_lookup_sha256 = @HELPERS.$crypto.sha256(@BODY.api_token)
}

// Lookup by the hash, never by the encrypted field.
const lookup = @HELPERS.$crypto.sha256(@BODY.api_token)
const found = await #integrations.find({
  filter: { api_token_lookup_sha256: { _eq: lookup } },
  limit: 1
})`,
        notes: [
          'isEncrypted values are encrypted at rest and decrypted after select.',
          'Do not filter, sort, or deep-filter by encrypted fields.',
          'Use a separate deterministic non-secret hash/lookup column when the product needs secret-derived lookup.',
          'Do not ask clients to submit enc:v1: ciphertext.',
        ],
      },
    ],
  },
  'handlers-hooks': {
    title: 'Custom handlers, pre-hooks, post-hooks, and script macros',
    useWhen: 'Use when writing Enfyra dynamic JavaScript for REST behavior.',
    examples: [
      {
        name: 'Create a route handler with current script fields',
        code: `create_handler({
  routeId: "<route_id>",
  method: "POST",
  scriptLanguage: "javascript",
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  knowledgeAckKey: "<dynamicCodeAckKey from get_enfyra_required_knowledge>",
  sourceCode: \`const email = @BODY.email
if (!email) @THROW400("Email is required")

return { ok: true, email }\`
})`,
        notes: [
          'Use sourceCode, not logic. The server generates compiledCode.',
          'Call get_enfyra_required_knowledge before saving dynamic code, pass globalRulesAckKey as globalRulesAckKey, and pass dynamicCodeAckKey as knowledgeAckKey.',
          'Use method for one handler, or methods only when the same sourceCode should be saved for multiple methods.',
          'Do not pass name to enfyra_route_handler; one handler is identified by route + method.',
        ],
      },
      {
        name: 'Custom register handler',
        code: `const email = @BODY.email
const password = @BODY.password

if (!email || !password) @THROW400("Email and password are required")

const existing = await #enfyra_user.find({
  filter: { email: { _eq: email } },
  limit: 1
})
if (existing.data[0]) @THROW409("Email is already registered")

const result = await #enfyra_user.create({
  data: {
    email,
    password: await @HELPERS.$bcrypt.hash(password)
  }
})

return result.data?.[0] ?? null`,
        notes: [
          'create/update return { data: [...] }, not a bare row.',
          'Use numeric @THROW helpers for raw HTTP messages. If you pass details, pass an object/array such as @THROW404("Request not found", { requestId }). Use @THROW.notFound(resource, id?) or @THROW.duplicate(resource, field, value) only when you want Enfyra-formatted semantic messages.',
          'Prefer macros over raw $ctx when a macro exists.',
        ],
      },
      {
        name: 'Workflow handler with relation read and side effects',
        code: `const requestId = @BODY.requestId
if (!requestId) @THROW400("requestId is required")

const found = await #app_requests.find({
  filter: { id: { _eq: requestId } },
  fields: ["id", "title", "status", "requester"],
  deep: {
    requester: { fields: ["id", "email"] }
  },
  limit: 1
})

const request = found.data?.[0]
if (!request) @THROW404("Request not found")
if (request.status !== "pending") @THROW409("Request is not pending")

await #app_requests.update({
  id: request.id,
  data: { status: "approved" }
})

await #app_audit_log.create({
  data: {
    action: "request_approved",
    request: request.id,
    actor: @USER?.id || undefined
  }
})

await #app_notifications.create({
  data: {
    kind: "request_approved",
    recipient: request.requester?.id || request.requester,
    request: request.id,
    isRead: false
  }
})

return { ok: true, id: request.id, status: "approved" }`,
        notes: [
          'This is a shape example, not a table template: replace app_requests/app_audit_log/app_notifications and relation names with live metadata.',
          'In dynamic scripts, top-level fields controls which parent properties appear. When using deep requester, also include requester in top-level fields.',
          'Inside deep.requester.fields, choose fields from the related requester row.',
          'Use #table.find/#table.update/#table.create macro repositories in generated scripts after calling discover_script_contexts.',
          'Create/update return { data: [...] }; use result.data?.[0] when the script needs the saved object.',
        ],
      },
      {
        name: 'Find one record by id in a handler',
        code: `const reportId = @BODY.reportId
if (!reportId) @THROW400("reportId is required")

const found = await #app_reports.find({
  filter: { id: { _eq: reportId } },
  fields: ["id", "status", "owner"],
  limit: 1
})

const report = found.data?.[0]
if (!report) @THROW404("Report not found", { reportId })

return {
  id: report.id,
  status: report.status
}`,
        notes: [
          'Use #table_name macros with explicit fields and limit:1 for one-record dynamic-script lookups.',
          'Use id filters when they work in the live runtime, but do not keep retrying @REPOS.<table>.find id filter shapes if a runtime reports undefined SQL bindings.',
          'If primary-key filtering fails in a runtime, pivot to a unique business field, the route main-table context, or a bounded query that you can verify, then update the contract/example for that runtime.',
          'Never return raw trusted repository rows; shape the response explicitly.',
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
          'Do not override @QUERY.fields, @QUERY.deep, @QUERY.sort, @QUERY.limit, @QUERY.page, @QUERY.meta, @QUERY.aggregate, or debugMode in RLS; keep projection and pagination client-owned.',
        ],
      },
      {
        name: 'Encrypted field table definition',
        code: `create_tables({
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  items: [
    {
      name: "integrations",
      columns: [
        { name: "name", type: "varchar", isNullable: false },
        {
          name: "api_token",
          type: "varchar",
          isNullable: false,
          isPublished: false,
          isEncrypted: true
        }
      ]
    }
  ]
})`,
        notes: [
          'Use isEncrypted=true for values that must be encrypted at rest.',
          'Scripts and REST callers read and write plaintext values; Enfyra encrypts on write and decrypts after select.',
          'Set isPublished=false for secret fields that should not be exposed by default.',
          'isEncrypted does not imply immutability; add isUpdatable=false separately only when the value must not change.',
          'Do not generate manual $encrypt hooks or accept caller-supplied enc:v1: ciphertext for normal app data.',
          'Encrypted fields cannot be filtered or sorted.',
        ],
      },
      {
        name: 'Pre-hook strips protected body fields silently',
        code: `create_pre_hook({
  routeId: "<enfyra_user_patch_route_id>",
  name: "strip_email_verification_fields",
  methods: ["PATCH"],
  priority: -10,
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  knowledgeAckKey: "<dynamicCodeAckKey from get_enfyra_required_knowledge>",
  code: \`delete @BODY.emailVerifiedAt
delete @BODY.emailVerificationStatus
delete @BODY.emailVerificationSentAt\`
})`,
        notes: [
          'Use this pattern when clients may send protected user fields through /me or enfyra_user PATCH.',
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
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  knowledgeAckKey: "<dynamicCodeAckKey from get_enfyra_required_knowledge>",
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
        name: 'Audit and grant authenticated route access',
        code: `audit_route_access({
  path: "/orders",
  roleName: "user",
  methods: ["GET", "POST"]
})

ensure_route_access({
  path: "/orders",
  roleName: "user",
  methods: ["GET", "POST"],
  description: "Authenticated users can list and create their own orders."
})`,
        notes: [
          'Start with the security boundary: choose public/private methods, role or user route access, owner/tenant scope, and field exposure before writing handler or UI logic.',
          'Use route permissions for authenticated access. The tool resolves role and method ids, validates the route available methods, merges existing methods, and reloads routes.',
          'Handlers or pre-hooks must still enforce owner or tenant scope; route permission only lets the request pass RoleGuard.',
          'Use publicMethods only for anonymous public access.',
        ],
      },
      {
        name: 'Make a read-only route public',
        code: `public_route_methods({
  path: "/articles",
  methods: ["GET"]
})`,
        notes: [
          'Use public_route_methods instead of raw enfyra_route updates; the tool resolves method ids and validates that GET is available.',
          'publicMethods controls anonymous route access. Route permissions are not for public access.',
          'Route permissions apply when the method is not public.',
        ],
      },
      {
        name: 'Rate limit anonymous requests by IP',
        code: `ensure_route_rate_limit({
  path: "/newsletter_signup",
  methods: ["POST"],
  scope: "ip",
  maxRequests: 10,
  perSeconds: 60,
  description: "Limit anonymous signup attempts by client IP.",
})

inspect_route({ path: "/newsletter_signup" })

test_rest_endpoint({
  method: "POST",
  path: "/newsletter_signup",
  body: { email: "test@example.com" }
})`,
        notes: [
          'Use ensure_route_rate_limit for request throttling so the built-in guard engine enforces the limit.',
          'Use scope "ip" for anonymous/public route protection because no user is available yet.',
          'Inspect and test after creation so the final behavior is verified through the actual REST route.',
        ],
      },
      {
        name: 'Rate limit authenticated users',
        code: `ensure_route_rate_limit({
  path: "/projects",
  methods: ["POST"],
  scope: "user",
  maxRequests: 3,
  perSeconds: 3600,
  description: "Authenticated users can create at most 3 projects per hour.",
})`,
        notes: [
          'User-scoped limits automatically use post_auth because the server only has user id after auth and RoleGuard.',
          'This does not grant access; users still need route permissions or a public method to reach the route.',
          'Use ensure_guard only for advanced guard trees such as IP allowlists/blacklists or composed AND/OR guard rules.',
        ],
      },
      {
        name: 'Restrict an admin-only route to office IPs',
        code: `ensure_guard({
  name: "Admin reports office allowlist",
  path: "/admin/reports",
  methods: ["GET", "POST"],
  position: "pre_auth",
  isEnabled: false,
  description: "Only office network IPs can reach admin reports.",
  rules: JSON.stringify([
    {
      type: "ip_whitelist",
      config: { ips: ["203.0.113.10", "198.51.100.0/24"] }
    }
  ])
})`,
        notes: [
          'Create risky allowlists disabled first, then inspect the saved guard before enabling it.',
          'IP list configs use ips; exact IPv4 addresses and IPv4 CIDR ranges are supported.',
          'An allowlist is an additional gate, not a replacement for route permissions.',
        ],
      },
      {
        name: 'Column rule for email format',
        code: `ensure_column_rule({
  tableName: "enfyra_user",
  columnName: "email",
  ruleType: "format",
  value: JSON.stringify({ v: "email" }),
  message: "Please enter a valid email address"
})`,
        notes: [
          'Column rules validate canonical POST/PATCH body payloads.',
          'The rule value payload uses the { v: ... } shape; do not pass ruleConfig.',
          'Use column rules before writing custom validation code when the rule is simple.',
        ],
      },
      {
        name: 'Field permission condition',
        code: `ensure_field_permission({
  tableName: "project",
  columnName: "internal_notes",
  action: "read",
  effect: "allow",
  roleName: "user",
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
    <PermissionGate :condition="canReadReports">
      <template #default>
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-lg font-semibold">Reports</h2>

          <PermissionGate :condition="canCreateReport">
            <UButton icon="i-lucide-plus" label="Create report" @click="openCreate = true" />
          </PermissionGate>
        </div>

        <div v-for="report in reports" :key="report.id" class="rounded-lg border p-4">
          <NuxtLink :to="\`/reports/\${report.id}\`" class="font-medium">
            {{ report.title }}
          </NuxtLink>

          <div class="mt-3 flex gap-2">
            <PermissionGate :condition="canUpdateReport">
              <UButton icon="i-lucide-pencil" variant="outline" label="Edit" @click="openEdit(report)" />
            </PermissionGate>

            <PermissionGate :condition="canDeleteReport">
              <UButton icon="i-lucide-trash-2" color="error" variant="outline" label="Delete" @click="openDelete(report)" />
            </PermissionGate>
          </div>
        </div>
      </template>

      <template #fallback>
        <EmptyState title="No access" description="You do not have permission to view reports." />
      </template>
    </PermissionGate>
  </section>
</template>

<script setup>
const { checkPermissionCondition } = usePermissions()

const canReadReports = computed(() => checkPermissionCondition({
  or: [
    { route: '/reports', methods: ['GET'] },
    { route: '/report', methods: ['GET'] }
  ]
}))

const canCreateReport = computed(() => checkPermissionCondition({
  or: [{ route: '/report', methods: ['POST'] }]
}))

const canUpdateReport = computed(() => checkPermissionCondition({
  or: [{ route: '/report', methods: ['PATCH'] }]
}))

const canDeleteReport = computed(() => checkPermissionCondition({
  or: [{ route: '/report', methods: ['DELETE'] }]
}))
</script>`,
        notes: [
          'This is menu/extension visibility, not row-level RLS.',
          'Set enfyra_menu.permission on every sensitive admin menu. Example for /reports: { or: [{ route: "/reports", methods: ["GET"] }, { route: "/report", methods: ["GET"] }] }.',
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

const membership = await #chat_conversation_member.find({
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
          'conversationId is a request/room identifier; DB filters still use the relation property conversation.',
          'Check membership server-side; do not trust the client.',
          'Use #table_name for explicit table access in generated scripts; select exact fields and sanitize any returned data.',
        ],
      },
      {
        name: 'Chat message event with room broadcast and persistence',
        code: `const { conversationId, text, clientId } = @BODY
if (!conversationId || !text) @THROW400("conversationId and text are required")

const membership = await #chat_conversation_member.find({
  filter: {
    conversation: { id: { _eq: conversationId } },
    member: { id: { _eq: @USER.id } }
  },
  limit: 1
})
if (!membership.data[0]) @THROW403("Not a conversation member")

const created = await #chat_message.create({
  data: {
    conversation: { id: conversationId },
    sender: { id: @USER.id },
    text,
    persistStatus: "persisted"
  }
})

const message = created.data?.[0] ?? null
if (message?.id) {
  await #chat_conversation.update({
    id: conversationId,
    data: { lastMessage: { id: message.id }, updatedAt: message.createdAt || new Date().toISOString() }
  })
}
@SOCKET.emitToCurrentRoom(\`conversation:\${conversationId}\`, "chat:message", {
  clientId,
  message
})

return { ok: true, message }`,
        notes: [
          'Do not ask the client for senderId. The sender relation is derived from @USER.id.',
          'conversationId is accepted only as the room/business identifier; persistence uses relation properties conversation and sender, not physical FK fields.',
          'Event scripts should explicitly emit replies/broadcasts.',
          'Use #table_name for explicit table access in generated scripts; select exact fields, enforce membership checks, and return shaped payloads.',
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
        name: 'Split a provisioning workflow into focused steps',
        code: `[
  { "key": "load_project", "stepOrder": 10, "type": "query" },
  { "key": "reserve_capacity", "stepOrder": 20, "type": "script" },
  { "key": "create_database_user", "stepOrder": 30, "type": "http" },
  { "key": "apply_database_guardrails", "stepOrder": 40, "type": "script" },
  { "key": "start_container", "stepOrder": 50, "type": "http" },
  { "key": "check_health", "stepOrder": 60, "type": "http" },
  { "key": "finalize_project", "stepOrder": 70, "type": "update" },
  { "key": "write_audit_log", "stepOrder": 80, "type": "log" }
]`,
        notes: [
          'Prefer flow_workflow for creating/updating a flow plus steps; it plans fixed step types before saving.',
          'Use plan_flow_steps only as a lightweight dry-run when the flow itself is not being changed.',
          'Each step should return only ids, booleans, status keys, or small counters that later steps need.',
          'When refactoring an existing flow, add or extract adjacent focused enfyra_flow_step rows instead of making an oversized sourceCode block longer.',
        ],
      },
      {
        name: 'Flow query step config',
        code: `{
  "table": "enfyra_user",
  "filter": { "email": { "_contains": "@example.com" } },
  "limit": 50
}`,
        notes: [
          'Step configs are JSON; script steps use code strings.',
          'Use public-safe URLs for HTTP steps.',
        ],
      },
      {
        name: 'Flow create/update/delete step configs',
        code: `// ensure_create_flow_step
{ "table": "todo", "data": { "title": "Review", "status": "open" } }

// ensure_update_flow_step
{ "table": "todo", "id": "@FLOW_PAYLOAD.todoId", "data": { "status": "done" } }

// ensure_delete_flow_step
{ "table": "todo", "id": "@FLOW_PAYLOAD.todoId" }`,
        notes: [
          'Use fixed CRUD flow step tools for single-record writes.',
          'Use script only when a step must coordinate multiple records, compute complex data, or call packages.',
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
        code: `const file = @UPLOADED_FILE
if (!file) @THROW400("File is required")

const saved = await @STORAGE.$upload({
  file,
  storageConfig: @BODY.storageConfig,
  folder: @BODY.folder,
  title: @BODY.title,
  description: @BODY.description
})

return saved`,
        notes: [
          'Use file-specific context only in upload-capable routes.',
          'For request uploads, pass file: @UPLOADED_FILE to @STORAGE.$upload/@STORAGE.$update so Enfyra streams from the temp file path.',
          'For upload progress, the client should send x-enfyra-upload-id and listen for the authenticated $system:upload:progress event.',
          'Use @STORAGE.$registerFile when an external process already uploaded the object and the script only needs to create the enfyra_file record.',
          'Do not read @UPLOADED_FILE.path into a Buffer and do not generate examples using @UPLOADED_FILE.buffer.',
          'Use buffer only for small generated or transformed files, such as image thumbnails.',
        ],
      },
    ],
  },
  extensions: {
    title: 'Dynamic app extensions and menus',
    useWhen: 'Use when adding custom Enfyra admin UI pages, widgets, global shell integrations, menu entries, account-panel rows, or shell attention signals.',
    examples: [
      {
        name: 'Create or update HTTP method colors',
        code: `list_methods()

create_method({
  method: "PUT",
  buttonColor: "#e0e7ff",
  textColor: "#4338ca"
})

update_method({
  method: "PATCH",
  buttonColor: "#fef3c7",
  textColor: "#b45309"
})`,
        notes: [
          'Use dedicated method tools instead of generic CRUD on enfyra_method.',
          'The backend stores the method label in enfyra_method.name; do not send or filter a `method` field on `enfyra_method`.',
          'buttonColor is the badge background and textColor is the badge text color.',
          'The Enfyra admin UI is /settings/methods.',
          'delete_method is preview-first and should only be used for unused custom methods.',
        ],
      },
      {
        name: 'Create menu then extension',
        code: `ensure_menu({
  label: "Reports",
  type: "Menu",
  path: "/reports",
  icon: "lucide:bar-chart-3",
  order: 20,
  isEnabled: true,
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  permission: JSON.stringify({
    or: [
      { route: "/reports", methods: ["GET"] },
      { route: "/report", methods: ["GET"] }
    ]
  })
})

// Read the created menu id from the tool response, then:
ensure_page_extension({
  name: "ReportsPage",
  description: "Reports dashboard",
  menuId: "<created-menu-id>",
  code: "<template><section class=\\"min-h-full w-full space-y-4\\"><div class=\\"grid gap-4 md:grid-cols-2 xl:grid-cols-3\\"><article class=\\"eapp-surface-card p-4\\"><div class=\\"flex items-start justify-between gap-3\\"><div><p class=\\"text-sm font-medium eapp-text-tertiary\\">Total</p><p class=\\"mt-2 text-2xl font-semibold eapp-text-primary\\">0</p></div><span class=\\"eapp-primary-soft eapp-icon-tile\\"><span class=\\"eapp-primary-text\\">◆</span></span></div><div class=\\"mt-3 h-1.5 overflow-hidden eapp-radius-pill eapp-surface-muted\\"><div class=\\"eapp-primary-solid h-full w-1/2\\"></div></div></article><article class=\\"eapp-primary-surface eapp-radius-panel border p-4\\"><p class=\\"text-sm font-semibold eapp-text-primary\\">Selected report</p><p class=\\"mt-1 text-sm eapp-text-tertiary\\">Only selected/current identity blocks use identity surface.</p></article></div></section></template><script setup>const { registerPageHeader } = usePageHeaderRegistry(); const { register: registerHeaderActions } = useHeaderActionRegistry(); registerPageHeader({ title: 'Reports', description: 'Operational report overview.', leadingIcon: 'lucide:bar-chart-3', gradient: 'none', variant: 'minimal' }); registerHeaderActions([{ id: 'refresh-reports', label: 'Refresh', icon: 'lucide:refresh-cw', color: 'neutral', variant: 'outline', onClick: () => {}, order: 80 }])</script>",
  isEnabled: true,
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  extensionKnowledgeAckKey: "<extensionAckKey from get_enfyra_required_knowledge>"
})`,
        notes: [
          'Reports is an illustrative page. Keep the shell/page contracts, but choose the real route, menu label, icon, permissions, and body layout from the operator workflow.',
          'Menu provides navigation; extension provides content.',
          'Use enfyra_menu.label, not title.',
          'Sensitive admin menus should include a permission condition at creation time.',
          'For page extensions, create the menu first with ensure_menu and pass its id to ensure_page_extension.',
          'When editing an existing extension by id or name, use update_extension_code so local guards plus /enfyra_extension/preview and the save happen in one atomic call. Do not spend a second LLM step on validate_extension_code followed by update_records unless the user requested validation-only output.',
          'Call get_extension_theme_contract before writing or reviewing page/widget/global extension UI; that tool is the authority for theme, color, layout, modal, drawer, and shell registry details.',
          'Call get_enfyra_required_knowledge before saving extension code, pass globalRulesAckKey as globalRulesAckKey, and pass extensionAckKey as extensionKnowledgeAckKey.',
          'Page extensions must register the app-shell PageHeader with usePageHeaderRegistry instead of rendering a custom top header.',
          'Put page-level actions in useHeaderActionRegistry or useSubHeaderActionRegistry, destructure register first, then call it with one action or an array.',
          'Page extensions should be full-bleed and responsive from the first version; the extension root is already inside the Enfyra admin page main.',
          'Render ordinary metrics and lists in the body, not PageHeader.stats, unless the user explicitly wants a compact overview header.',
          'Use app theme tokens and Nuxt UI semantic colors by intent; do not hard-code concrete palettes or redefine the app palette inside extension code.',
          'Use app-owned primitives such as UTabs, CommonModal, CommonDrawer, Widget, useMenuNotificationRegistry, and useAccountPanelRegistry when the workflow matches them.',
          'Keep list selection local and fetch detail rows only; do not refetch the whole list after a row click unless the list data changed.',
          'Page extension paths are admin app UI routes. Do not verify them with test_rest_endpoint against ENFYRA_API_URL unless inspect_route shows an API route with the same path.',
          'After saving, open Enfyra admin tabs should update through the server/Enfyra admin UI realtime reload contract; do not tell the user to refresh unless that contract is proven broken.',
        ],
      },
      {
        name: 'Compose page extensions from widgets',
        code: `// Create reusable/bulky sections as widget extension records first.
const reportStatusWidgetCode = \`
<template>
  <section class="eapp-surface-card p-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="text-sm font-medium eapp-text-tertiary">Total reports</p>
        <p class="mt-2 text-2xl font-semibold eapp-text-primary">{{ total }}</p>
        <p class="mt-1 text-xs eapp-text-tertiary">{{ latestLabel }}</p>
      </div>
      <UButton type="button" color="neutral" variant="outline" @click.stop.prevent="emit('refresh')">Refresh</UButton>
    </div>
    <div class="mt-3 h-1.5 overflow-hidden eapp-radius-pill eapp-surface-muted">
      <div class="eapp-primary-solid h-full" :style="{ width: progressWidth }"></div>
    </div>
    <UButton v-if="hasLatest" type="button" class="mt-3" color="primary" variant="solid" @click.stop.prevent="openLatest">Open latest</UButton>
  </section>
</template>

<script setup>
const props = defineProps({
  total: { type: Number, default: 0 },
  rows: { type: Array, default: () => [] },
  openDetails: { type: Function, default: null }
})
const emit = defineEmits(['refresh'])
const hasLatest = computed(() => props.rows.length > 0)
const latestLabel = computed(() => hasLatest.value ? 'Latest: ' + (props.rows[0]?.title || props.rows[0]?.id || 'Untitled') : 'No reports yet')
const progressWidth = computed(() => hasLatest.value ? '100%' : '0%')
function openLatest() {
  if (typeof props.openDetails === 'function' && props.rows[0]) props.openDetails(props.rows[0])
}
</script>
\`

ensure_widget_extension({
  name: "ReportStatusWidget",
  description: "Report status summary cards",
  code: reportStatusWidgetCode,
  isEnabled: true,
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  extensionKnowledgeAckKey: "<extensionAckKey from get_enfyra_required_knowledge>"
})

// Read the created widget record id, then embed it from the page extension.
ensure_page_extension({
  name: "ReportsPage",
  menuId: "<reports-menu-id>",
  code: "<template><section class=\\"min-h-full w-full space-y-4\\"><Widget :id=\\"<report-status-widget-id>\\" :total=\\"totalReports\\" :rows=\\"reportRows\\" :open-details=\\"openReportDetails\\" @refresh=\\"refresh\\" /><Widget :id=\\"<report-table-widget-id>\\" :rows=\\"reportRows\\" @refresh=\\"refresh\\" /></section></template><script setup>const { registerPageHeader } = usePageHeaderRegistry(); registerPageHeader({ title: 'Reports', description: 'Operational report overview.', leadingIcon: 'lucide:bar-chart-3', gradient: 'none', variant: 'minimal' }); const totalReports = ref(0); const reportRows = ref([]); function refresh() {} function openReportDetails(row) { navigateTo('/data/report?filter=' + encodeURIComponent(JSON.stringify({ id: { _eq: row.id } }))) }</script>",
  isEnabled: true,
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  extensionKnowledgeAckKey: "<extensionAckKey from get_enfyra_required_knowledge>"
})`,
        notes: [
          'This shows composition mechanics. Replace reports/status/table with domain sections that are independently reusable or complex enough to deserve widgets.',
          'Use widgets for bulky or reusable sections such as operation panels, timelines, tables, sidebars, and status cards.',
          'Embed widgets by their numeric enfyra_extension id, not by extensionId/name.',
          'Props and listeners pass through the Widget wrapper. Widget defineProps values update reactively when the parent refs/computed values change.',
          'Use kebab-case in the parent template for camelCase widget props, for example :open-details maps to openDetails.',
          'Do not mutate widget props. Use computed for derived display state, and use watch only when mirroring a prop into local editable draft state.',
          'Prefer defineEmits for child-to-parent requests such as refresh. Use callback props only for parent-owned modal/drawer openers or imperative navigation.',
          'Keep PermissionGate and type="button" plus @click.stop.prevent inside action widgets; server permissions still enforce the real boundary.',
          'the Enfyra admin UI batch-fetches widget metadata requested in the same tick and caches loaded widgets, so render Widget components directly instead of manually fetching widget code.',
        ],
      },
      {
        name: 'Create a global shell extension for app-wide notifications',
        code: `const notificationBellCode = \`
<template></template>

<script setup>
const unread = ref(0)
const expanded = ref(false)

const notificationDescription = computed(() => {
  if (unread.value > 0) return unread.value === 1 ? '1 unread' : unread.value + ' unread'
  return 'All caught up'
})
const notificationBadge = computed(() => unread.value > 0 ? (unread.value > 99 ? '99+' : unread.value) : null)
const notificationIcon = computed(() => unread.value > 0 ? 'lucide:bell-ring' : 'lucide:bell')

const NotificationList = defineComponent({
  name: 'NotificationList',
  setup() {
    return () => h('div', { class: 'p-2 text-sm' }, [
      h('button', {
        type: 'button',
        class: 'flex w-full items-center justify-between rounded px-2 py-2 text-left eapp-surface-hover',
        onClick: () => navigateTo('/notifications'),
      }, [
        h('span', 'Open notification center'),
        h(resolveComponent('UIcon'), { name: 'lucide:arrow-right', class: 'h-4 w-4' }),
      ]),
    ])
  },
})

const { register } = useAccountPanelRegistry()
register({
  id: 'notifications',
  order: 20,
  label: 'Notifications',
  icon: notificationIcon,
  description: notificationDescription,
  count: notificationBadge,
  badgeColor: 'error',
  expanded,
  onToggle: () => {
    expanded.value = !expanded.value
  },
  contentComponent: NotificationList,
})

const { register: registerMenuNotification, unregister: unregisterMenuNotification } = useMenuNotificationRegistry()
watchEffect(() => {
  if (notificationBadge.value) {
    registerMenuNotification({
      id: 'notifications-menu-unread',
      target: { path: '/notifications' },
      value: notificationBadge.value,
      color: 'error',
      title: notificationDescription.value,
    })
  } else {
    unregisterMenuNotification('notifications-menu-unread')
  }
})

const { adminSocket } = useAdminSocket()
const handleNotification = (payload) => {
  if (payload?.unread != null) unread.value = payload.unread
}
adminSocket.on('notification:summary', handleNotification)
onUnmounted(() => {
  adminSocket.off('notification:summary', handleNotification)
  unregisterMenuNotification('notifications-menu-unread')
})
</script>
\`

ensure_global_extension({
  name: "NotificationBellGlobal",
  description: "Registers the app-wide notification bell in the account panel",
  code: notificationBellCode,
  isEnabled: true,
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  extensionKnowledgeAckKey: "<extensionAckKey from get_enfyra_required_knowledge>"
})`,
        notes: [
          'Global extensions are mounted invisibly by Enfyra admin UI during layout init; do not create a menu and do not embed them with Widget.',
          'Use them for shell-level registrations, realtime listeners, notification counters, account panel rows, and background refresh bridges.',
          'The notification center is only one possible shell integration. The transferable shape is invisible global extension -> shell registry -> cleanup on unmount.',
          'Use useMenuNotificationRegistry for sidebar menu counts/dots when notification state should be visible in the menu as well as the notification center.',
          'Choose value only when the signal source already owns an exact count. Omit value for a dot when realtime only proves that something new exists.',
          'Do not fetch the destination domain list just to decorate a menu. A mail page fetches mail; a support page fetches tickets; the shell should use notification or summary signals.',
          'Keep the global extension template empty or hidden; visible UI should be registered into an existing shell registry or component slot.',
          'For account-panel UI, register data-driven row fields so Enfyra admin UI owns icon size, row spacing, badge placement, hover state, and expanded chrome.',
          'Use contentComponent only for expanded inner content; use raw component only as an escape hatch when the row cannot fit the shell contract.',
          'Destructure registry functions and register stable ids so reloads replace the same shell item predictably.',
          'Remove socket or DOM listeners in onUnmounted; The Enfyra admin UI unmounts old global components when extension cache reloads or the extension is disabled.',
        ],
      },
      {
        name: 'Signal menu attention without polling destination lists',
        code: `const signalBridgeCode = \`
<template></template>

<script setup>
const attentionRows = ref([])
const notificationSignal = ref(false)
const route = useRoute()

const notificationApi = useApi('/cloud_admin_notifications', {
  query: {
    filter: JSON.stringify({ readAt: { _is_null: true } }),
    fields: 'id,kind,targetPath,readAt',
    sort: '-createdAt,-id',
    limit: 10,
  },
})

const hasNewEmail = computed(() =>
  attentionRows.value.some((row) => row.kind === 'email_inbound' && !row.readAt)
)
const hasNewSupport = computed(() =>
  attentionRows.value.some((row) => row.kind === 'support' && !row.readAt)
)
const accountBadge = computed(() => notificationSignal.value ? 'New' : null)
const accountDescription = computed(() => notificationSignal.value ? 'New admin attention' : 'All caught up')

function syncFromNotificationRows() {
  const value = notificationApi.data?.value
  const rows = Array.isArray(value?.data)
    ? value.data
    : Array.isArray(value?.data?.data)
      ? value.data.data
      : []
  attentionRows.value = rows
  notificationSignal.value = rows.some((row) => !row.readAt)
}

async function refreshNotificationSignals() {
  await notificationApi.execute()
  syncFromNotificationRows()
}

const { register: registerAccountPanel } = useAccountPanelRegistry()
registerAccountPanel({
  id: 'admin-attention',
  order: 20,
  label: 'Notifications',
  icon: computed(() => notificationSignal.value ? 'lucide:bell-ring' : 'lucide:bell'),
  description: accountDescription,
  count: accountBadge,
  badgeColor: 'info',
  onClick: () => navigateTo('/data/cloud_admin_notifications'),
})

const { register: registerMenuNotification, unregister: unregisterMenuNotification } = useMenuNotificationRegistry()
watchEffect(() => {
  if (hasNewEmail.value) {
    registerMenuNotification({
      id: 'attention-email',
      target: { path: '/email/messages' },
      color: 'info',
      title: 'New inbound email',
    })
  } else {
    unregisterMenuNotification('attention-email')
  }

  if (hasNewSupport.value) {
    registerMenuNotification({
      id: 'attention-support',
      target: { path: '/cloud/support' },
      color: 'info',
      title: 'New support activity',
    })
  } else {
    unregisterMenuNotification('attention-support')
  }
})

watch(() => route.path, (path) => {
  if (path.startsWith('/email/messages')) {
    attentionRows.value = attentionRows.value.filter((row) => row.kind !== 'email_inbound')
  }
  if (path.startsWith('/cloud/support')) {
    attentionRows.value = attentionRows.value.filter((row) => row.kind !== 'support')
  }
  notificationSignal.value = attentionRows.value.some((row) => !row.readAt)
})

const { adminSocket } = useAdminSocket()
function handleAdminNotification(payload) {
  refreshNotificationSignals()
  if (payload?.kind === 'email_inbound') {
    registerMenuNotification({ id: 'attention-email', target: { path: '/email/messages' }, color: 'info', title: 'New inbound email' })
  }
  if (payload?.kind === 'support') {
    registerMenuNotification({ id: 'attention-support', target: { path: '/cloud/support' }, color: 'info', title: 'New support activity' })
  }
}

function getAdminSocket() {
  return adminSocket && adminSocket.value !== undefined ? adminSocket.value : adminSocket
}

function bindAdminSocket(socket) {
  if (socket && typeof socket.on === 'function') {
    socket.on('admin:notification-created', handleAdminNotification)
  }
}

function unbindAdminSocket(socket) {
  if (socket && typeof socket.off === 'function') {
    socket.off('admin:notification-created', handleAdminNotification)
  }
}

if (adminSocket && adminSocket.value !== undefined) {
  watch(adminSocket, (nextSocket, previousSocket) => {
    unbindAdminSocket(previousSocket)
    bindAdminSocket(nextSocket)
  })
}

onMounted(() => {
  refreshNotificationSignals()
  bindAdminSocket(getAdminSocket())
})
onUnmounted(() => {
  unbindAdminSocket(getAdminSocket())
  unregisterMenuNotification('attention-email')
  unregisterMenuNotification('attention-support')
})
</script>
\`

ensure_global_extension({
  name: "AdminAttentionSignalBridge",
  description: "Routes notification signals into account-panel and sidebar menu attention markers without polling destination lists",
  code: signalBridgeCode,
  isEnabled: true,
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  extensionKnowledgeAckKey: "<extensionAckKey from get_enfyra_required_knowledge>"
})`,
        notes: [
          'Use this reasoning pattern when the shell should show attention but the destination page owns the expensive or domain-specific list fetch.',
          'This example fetches only the notification source of truth, not the email, support, order, or job tables. Substitute your own notification or summary endpoint when available.',
          'Omitting value on registerMenuNotification renders a dot. That is the right promise when the shell knows "new work exists" but not an exact count.',
          'If a backend summary event already includes an exact unread count, use value for a count chip. If the event only says one record changed, use a dot and let the page fetch details.',
          'Map notification kinds to menu targets by product meaning, not by copying these paths. For example, approval_required could target /reviews, failed_job could target /operations/jobs, and quota_warning could target /billing.',
          'Generalize the lifecycle: seed from a bounded signal source, react to realtime events, clear local attention when the user reaches the owning page, and avoid duplicating that page\'s data fetch.',
          'Clear local dot signals when the user enters the destination route or when the notification center marks the underlying notification as read.',
        ],
      },
      {
        name: 'Register a data-driven account-panel item',
        code: `<script setup>
const unread = ref(3)
const expanded = ref(false)

const label = 'Notifications'
const icon = computed(() => unread.value > 0 ? 'lucide:bell-ring' : 'lucide:bell')
const count = computed(() => unread.value > 0 ? String(unread.value) : null)
const description = computed(() => unread.value > 0 ? 'Needs review' : 'All caught up')

const NotificationPanelContent = defineComponent({
  name: 'NotificationPanelContent',
  setup() {
    return () => h('div', { class: 'px-2 py-1 text-xs eapp-text-tertiary' }, 'Recent unread notifications can render here.')
  },
})

const { register } = useAccountPanelRegistry()
register({
  id: 'notifications',
  order: 20,
  label,
  icon,
  description,
  count,
  badgeColor: 'error',
  expanded,
  onToggle: () => {
    expanded.value = !expanded.value
  },
  contentComponent: NotificationPanelContent,
})
</script>`,
        notes: [
          'Prefer this contract for shell/account-panel items: data fields for the row, optional contentComponent for the expanded body.',
          'Notifications is illustrative. Account-panel rows can represent any account-scoped attention or shortcut, such as approvals, billing, deployments, or personal tasks.',
          'Use count for the primary visible badge value. badge remains supported as a legacy alias, but count is what the account trigger aggregates.',
          'Do not draw a custom full row with page-scale cards, hero headings, large whitespace, or nested buttons unless the shell contract cannot express the UI.',
          'Let the Enfyra admin UI handle the row button, icon container, label, microcopy, badge, chevron, hover state, spacing, and expanded wrapper.',
          'Keep contentComponent compact; it is rendered inside account-panel chrome and should not create another large card around itself.',
          'Register the component from a `type="global"` extension, not from a page extension, when it must appear everywhere.',
        ],
      },
      {
        name: 'Page header and action button variants',
        code: `<script setup>
const { registerPageHeader } = usePageHeaderRegistry()
const { register: registerHeaderActions } = useHeaderActionRegistry()

registerPageHeader({
  title: 'Report detail',
  description: 'Review status, schedule, and delivery history.',
  leadingIcon: 'lucide:file-text',
  gradient: 'none',
  variant: 'minimal'
})

registerHeaderActions([
  {
    id: 'back-to-reports',
    label: 'Reports',
    icon: 'lucide:arrow-left',
    color: 'neutral',
    variant: 'ghost',
    order: 0,
    onClick: () => navigateTo('/reports')
  },
  {
    id: 'send-test-report',
    label: 'Send test',
    icon: 'lucide:send',
    color: 'neutral',
    variant: 'outline',
    order: 1,
    permission: { or: [{ route: '/reports/send-test', methods: ['POST'] }] },
    onClick: sendTest
  },
  {
    id: 'refresh-report',
    label: 'Refresh',
    icon: 'lucide:refresh-cw',
    color: 'neutral',
    variant: 'outline',
    order: 2,
    onClick: refresh
  }
])
</script>`,
        notes: [
          'Use PageHeader for the title strip; do not render a duplicate header inside extension body.',
          'The exact actions are illustrative. Choose action prominence from user intent: navigation, secondary utility, primary mutation, or destructive confirmation.',
          'Use gradient: "none" for generated operational pages; hardcoded named gradients are decorative and should be explicit user intent.',
          'Back/navigation actions should be neutral ghost so they read as navigation, not a primary operation.',
          'Visible secondary operations should be neutral outline; soft is only for low-emphasis chrome actions.',
          'The main page mutation action should be primary solid; refresh is neutral outline unless refresh is the actual primary workflow.',
          'Do not choose soft only because it looks acceptable in dark mode; light mode must remain clear too.',
        ],
      },
      {
        name: 'Debug menu or extension changes that do not appear in open Enfyra admin tabs',
        code: `// Server side: enfyra_menu and enfyra_extension are runtime UI definitions.
// They must participate in partial reload, just like metadata/routes.
// Expected server contract:
// - cache orchestrator maps enfyra_menu -> menu reload
// - cache orchestrator maps enfyra_extension -> extension reload
// - successful writes emit $system:reload to the admin Socket.IO namespace

// Enfyra admin UI side expected listener behavior:
// if reload target is metadata/menu:
//   await fetch menus
//   rebuild menu registry with reset: true
//   invalidate dynamic extension cache too, because route-to-extension mapping may change
// if reload target is extension or menu:
//   clear dynamic extension component/meta cache
//   reload enabled type="global" shell extensions

// Verification pattern:
// 1. Save the menu or extension record.
// 2. Watch the open Enfyra admin UI tab for the $system:reload event.
// 3. Confirm sidebar/menu registry or extension component cache changed.
// 4. Only use manual reload endpoints or browser refresh after the natural event path is proven stale.`,
        notes: [
          'Do not treat menu and extension writes as plain CRUD when debugging live admin UI.',
          'Check both halves: Enfyra Server emits the reload event, and Enfyra admin UI consumes it.',
          'Menu reload should also invalidate extension cache because menu records attach page extensions to routes.',
          'Manual reload is a fallback, not the default fix.',
        ],
      },
      {
        name: 'Plan an admin dashboard as multiple pages',
        code: `// Illustrative menu shape for an operations surface:
ensure_menu({
  type: "Dropdown Menu",
  label: "Operations",
  path: "/operations",
  icon: "lucide:layout-dashboard",
  order: 2,
  isEnabled: true,
  permission: JSON.stringify({
    or: [
      { route: "/operations/jobs", methods: ["GET"] },
      { route: "/enfyra_flow_execution", methods: ["GET"] }
    ]
  })
})

// Child page extensions should be focused:
// /dashboard            compact summary/routing hub: KPIs, current signal, attention queue, navigation cards
// /operations/jobs      background jobs, current step, meaning, next action
// /operations/orders    order/payment status and drill-downs
// /operations/reports   report configuration and delivery history
// /operations/settings  system readiness and configuration
// Use UTabs inside large pages instead of placing every section in one dashboard.
// For admin record management, link to /data/<table>, e.g. /data/report, not public website paths.`,
        notes: [
          'Design the menu/page split before generating dashboard code.',
          'Operations/jobs/orders/reports/settings are examples of separating mental models. Replace them with the real domains users navigate between.',
          'Permission-gate sensitive parent dropdown menus too, using any child page route or backing route that represents read access.',
          'Keep /dashboard as a summary and distribution page, not a detailed operations table.',
          'Use focused pages for operational domains.',
          'Each page extension must use usePageHeaderRegistry for the app-shell title strip and should not render a duplicate top header in the body.',
          'PageHeader.stats is reserved for deliberate overview headers; operational KPIs belong in body cards/tables.',
          'Operational history pages should not show raw event rows as the primary UI; group by entity/run and translate step keys into operator-facing labels.',
          'Operational lists should use pagination plus search/filter controls; do not rely on arbitrary fixed limits such as limit=50.',
          'UTabs is available in the Enfyra admin UI extension runtime for page-level sections.',
          'Admin links for editing or inspecting records should point to /data/<table> routes.',
        ],
      },
      {
        name: 'Extension fetches Enfyra data',
        code: `<script setup>
const { data, pending, execute: fetchOrders } = useApi('/order', {
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
          'The /order path is illustrative; inspect routes and fetch the smallest data shape the extension needs.',
          'Keep extension UI focused; move backend logic into handlers/hooks when needed.',
        ],
      },
      {
        name: 'Managed modal and drawer footer actions',
        code: `<template>
  <CommonModal
    v-model:open="open"
    :cancel-action="{ label: 'Cancel', onClick: () => (open = false) }"
    :primary-action="{ label: 'Update version', loading: saving, disabled: !canSubmit, onClick: submit }"
  >
    <template #header>
      <h3 class="text-lg font-semibold">Update version</h3>
    </template>

    <template #body>
      <UInput v-model="version" />
      <UButton
        type="button"
        icon="i-lucide-refresh-cw"
        label="Check version"
        @click.stop.prevent="checkVersion"
      />
    </template>
  </CommonModal>
</template>`,
        notes: [
          'For action-only footers, use CommonModal/CommonDrawer footer props: cancelAction, primaryAction, dangerAction, leadingActions, and footerHint.',
          'cancelAction defaults to neutral outline. Use dangerAction for irreversible destructive work and tone: "primary" for Keep editing in discard dialogs.',
          'Every trigger/body action button inside CommonModal, CommonDrawer, or UModal should use type="button" unless it intentionally submits a form.',
          'Use @click.stop.prevent on body action buttons so clicks do not bubble to row/page triggers.',
          'Open modal/drawer shells immediately, then load content inside them; do not close and reopen after an API call.',
          'Keep destructive final actions disabled until all confirmation inputs are valid.',
        ],
      },
      {
        name: 'Extension can use modern browser APIs',
        code: `<script setup lang="ts">
const statuses = ['active', 'ready']
const ok = statuses.includes('active')
const requiredTerms = new Set(['terms', 'privacy'])
const loaded = await Promise.all([Promise.resolve(1), Promise.resolve(2)])
const label = String('pending_payment').replace(/_/g, ' ')
const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date())
console.log(ok, requiredTerms.has('terms'), loaded, label, date)
</script>`,
        notes: [
          'Do not rewrite extension code to ES5 when tooling rejects modern APIs.',
          'If diagnostics complain about these APIs, fix Enfyra admin extension TypeScript lib/runtime contract.',
        ],
      },
      {
        name: 'Install and use an app package in an extension',
        code: `install_package({
  name: "dayjs",
  type: "App",
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>"
})

// Then in extension code:
<script setup>
const formatted = ref('')

onMounted(async () => {
  const pkgs = await getPackages(['dayjs'])
  const dayjs = pkgs.dayjs
  formatted.value = dayjs().format('YYYY-MM-DD')
})
</script>

<template>
  <span>{{ formatted }}</span>
</template>`,
        notes: [
          'Install browser-side extension dependencies as type: "App".',
          'Do not use static import statements in enfyra_extension.code.',
          'Load app packages with getPackages([...]) inside the extension runtime.',
          'Use onMounted or an explicit action for package loading when the UI can render a loading state.',
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

const flowStats = useApi('/enfyra_flow_execution', {
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

const orderStats = useApi('/order', {
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
          'The flow/order pair is illustrative. Choose aggregates that answer the page question, such as failed work, pending approvals, unread support, quota pressure, or revenue.',
          'Only aggregate fields and relations that the dashboard is allowed to expose; aggregate values can reveal hidden data even when rows omit that field.',
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
      reasoningGuide: EXAMPLE_REASONING_GUIDE,
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
    reasoningGuide: EXAMPLE_REASONING_GUIDE,
    ...entry,
  };
}
