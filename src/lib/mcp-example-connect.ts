export const connectExamples = {
    title: 'Connect SSR and browser apps to Enfyra',
    useWhen: 'Use when connecting Nuxt, Next, Angular, or another browser app to Enfyra for REST, login, OAuth, refresh, files, GraphQL, or Socket.IO; adapt the framework wrapper while preserving the app-origin proxy and cookie boundary.',
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
          'Browser code calls app-origin routes such as /enfyra/login, /enfyra/me, /enfyra/logout, and /enfyra/<table>.',
          'Keep redirects manual so OAuth and the set-cookie bridge return their redirect response to the browser.',
          'Proxy to the Enfyra app /api bridge, not the raw Enfyra server. The Enfyra app bridge reads and refreshes cookies, then injects Authorization for protected ESV requests.',
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
          'Use rewrites for browser traffic, including the OAuth cookie bridge.',
          'The destination is the Enfyra app /api bridge. Do not point the browser rewrite at a raw ESV origin.',
          'For server components, forward the incoming Cookie header when fetching through the third app origin.',
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
          'The third app proxy maps /enfyra/login to the Enfyra app /api/login cookie endpoint; use /login, not raw /auth/login, in browser cookie mode.',
          'The Enfyra app bridge owns refresh and Bearer forwarding to ESV while HttpOnly cookies stay outside browser JavaScript.',
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
    const url = new URL("/api/auth/google", "https://demo.enfyra.io")
    url.searchParams.set("redirect", redirect.toString())
    url.searchParams.set("cookieBridgePrefix", "/enfyra")
    window.location.href = url.toString()
  }
}`,
        notes: [
          'Use HttpClient with a credentials interceptor for /enfyra/* calls so cookies are sent consistently.',
          'The guard is only for user experience; Enfyra route permissions and server-side owner checks remain authoritative.',
          'Keep the current user in an Angular service or store; do not read JWTs from cookies or URLs.',
          'OAuth starts at the Enfyra app /api/auth/google URL, not the local /enfyra path. It returns through the local cookie bridge before Angular loads /enfyra/me.',
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
        name: 'Google OAuth button',
        code: `const redirect = new URL("/chat", window.location.origin)
const url = new URL("/api/auth/google", "https://demo.enfyra.io")
url.searchParams.set("redirect", redirect.toString())
url.searchParams.set("cookieBridgePrefix", "/enfyra")
window.location.href = url.toString()`,
        notes: [
          'redirect must be absolute and must include the app origin.',
          'Start OAuth on the Enfyra app URL. Do not start it at the third app /enfyra proxy path.',
          'cookieBridgePrefix is the app proxy prefix that forwards to Enfyra API routes.',
          'Enfyra redirects through {redirect.origin}{cookieBridgePrefix}/auth/set-cookies before returning to redirect.',
          'After returning, call /enfyra/me to load the authenticated user; do not parse tokens from the URL in proxy-cookie mode.',
        ],
      },
    ],
  };
