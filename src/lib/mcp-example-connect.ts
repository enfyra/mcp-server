export const connectExamples = {
  title: 'Connect apps to Enfyra using official SDK packages',
  useWhen: 'Use when connecting a Nuxt, Next.js, React, Vue, Angular, or other app to Enfyra. Always prefer the official SDK package for the target framework over manual proxy configuration.',
  examples: [
    {
      name: 'SDK package selection by framework',
      code: `# Nuxt 3/4 (SSR + CSR, auto proxy, auto composables)
yarn add @enfyra/sdk-nuxt @enfyra/sdk-core

# Next.js App Router (SSR + CSR, one-line config preset, providerless hooks)
yarn add @enfyra/sdk-next @enfyra/sdk-core

# React SPA (CSR only, Provider + hooks)
yarn add @enfyra/sdk-react @enfyra/sdk-core zustand

# Vue 3 SPA (CSR only, composables)
yarn add @enfyra/sdk-vue @enfyra/sdk-core

# Any other framework / Node.js scripts (core client only)
yarn add @enfyra/sdk-core`,
      notes: [
        'Always install the framework-specific SDK package. Do not write manual proxy configs, route handlers, or cookie bridges when an SDK exists for the target framework.',
        '@enfyra/sdk-nuxt and @enfyra/sdk-next handle the same-origin proxy, cookie bridge, OAuth redirect, and SSR request isolation automatically.',
        '@enfyra/sdk-react and @enfyra/sdk-vue are CSR-only. The host app still needs a same-origin reverse proxy (dev server proxy or production nginx/Caddy) pointing /enfyra/** to the Enfyra App /api bridge.',
        '@enfyra/sdk-core is the transport layer. Use it directly only for Node.js scripts, unsupported frameworks, or when the framework SDK does not cover the use case.',
      ],
    },
    {
      name: 'Nuxt setup with @enfyra/sdk-nuxt',
      code: `// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@enfyra/sdk-nuxt'],
})

// .env
ENFYRA_APP_URL=https://admin.example.com`,
      notes: [
        'One module entry and one env var. No routeRules, no server middleware, no plugin, no cookie handler.',
        'The module proxies /${routePrefix}/** to ${appUrl}/api/** with manual redirects, creates a request-scoped SSR client, and auto-imports all composables.',
        'Composables: useEnfyra(), useAuth(), useQuery(), useMutation(), useStorage(), useWebSocket().',
        'Optional config: enfyra.appUrl overrides env; enfyra.routePrefix changes the proxy prefix (default /enfyra).',
      ],
    },
    {
      name: 'Next.js setup with @enfyra/sdk-next',
      code: `// next.config.mjs — quick path (one line)
export { default } from '@enfyra/sdk-next'

// .env.local
ENFYRA_APP_URL=http://localhost:3000`,
      notes: [
        'One re-export and one env var. No generated route handler, no middleware, no Provider in layout.',
        'This quick path is for new apps or apps without an existing next.config. If the app already has a next.config with custom settings, use withEnfyra(existingConfig, options) instead to preserve them.',
        'The preset adds beforeFiles rewrites proxying /api/enfyra/** to ${appUrl}/api/** and injects the browser prefix as a build constant.',
        'Client hooks (providerless): import { useAuth, useEnfyra, useQuery, useMutation, useStorage } from "@enfyra/sdk-next/client".',
        'Server Components: import { createServerEnfyra } from "@enfyra/sdk-next/server" — request-scoped, forwards cookies.',
        'Server Actions: import { createServerActionEnfyra } from "@enfyra/sdk-next/server" — applies upstream Set-Cookie rotation.',
        'Existing config: wrap with withEnfyra(nextConfig, options). Configured preset: enfyra({ appUrl, routePrefix }).',
        'Requires Next.js >=14 <17 App Router. Rejects output:"export" at config load time.',
      ],
    },
    {
      name: 'Next.js client hooks usage',
      code: `'use client'

import { useAuth, useEnfyra, useQuery } from '@enfyra/sdk-next/client'

function Dashboard() {
  const { user, isAuthenticated, pending, login, logout } = useAuth()
  const client = useEnfyra()
  const { data, pending: loading } = useQuery(() =>
    client.from('articles').select('id,title').limit(10).execute()
  )

  if (pending) return <p>Checking session…</p>
  if (!isAuthenticated) return <button onClick={() => login({ email, password })}>Login</button>
  return <ul>{data?.map(a => <li key={a.id}>{a.title}</li>)}</ul>
}`,
      notes: [
        'No Provider wrapper needed. Hooks use a module-level singleton that is SSR-safe (server render is always anonymous/idle).',
        'Auth refresh starts automatically after hydration via useEffect.',
        'useEnfyra() returns the original EnfyraClient from @enfyra/sdk-core.',
      ],
    },
    {
      name: 'Next.js Server Component and Server Action',
      code: `// app/page.tsx — Server Component
import { createServerEnfyra } from '@enfyra/sdk-next/server'

export default async function Page() {
  const client = await createServerEnfyra()
  const { data } = await client.from('posts').select('id,title').limit(5).execute()
  return <ul>{data?.map(p => <li key={p.id}>{p.title}</li>)}</ul>
}

// app/actions.ts — Server Action
'use server'
import { createServerActionEnfyra } from '@enfyra/sdk-next/server'

export async function loginAction(formData: FormData) {
  const { client, applySetCookies } = await createServerActionEnfyra()
  const res = await client.post('/auth/login', {
    email: formData.get('email'),
    password: formData.get('password'),
  })
  applySetCookies(res.headers['set-cookie'] ?? [])
}`,
      notes: [
        'createServerEnfyra() reads await headers(), forwards cookie/authorization, creates a fresh client per call.',
        'createServerActionEnfyra() reads await cookies() and returns applySetCookies to write upstream Set-Cookie back to the browser.',
        'Never cache the server client at module or process scope.',
      ],
    },
    {
      name: 'React SPA setup with @enfyra/sdk-react',
      code: `import { EnfyraProvider, useAuth, useQuery, useMutation } from '@enfyra/sdk-react'

function App() {
  return (
    <EnfyraProvider config={{ baseUrl: '/enfyra', auth: { strategy: 'cookie', cookieBridgePrefix: '/enfyra' } }}>
      <Dashboard />
    </EnfyraProvider>
  )
}

function Dashboard() {
  const { user, isAuthenticated, login, logout } = useAuth()
  const { data, pending } = useQuery('articles', { select: ['id', 'title'], limit: 10 })
  const { execute, pending: saving } = useMutation('articles', { operation: 'insert' })
}`,
      notes: [
        'React SPA is CSR-only. The host app must provide a same-origin proxy: Vite dev server proxy, CRA proxy, or production reverse proxy mapping /enfyra/** to the Enfyra App /api bridge.',
        'EnfyraProvider wraps the app once at the root. All hooks read from the shared client/store.',
        'Do not use @enfyra/sdk-react inside Next.js — use @enfyra/sdk-next instead.',
      ],
    },
    {
      name: 'Vue 3 SPA setup with @enfyra/sdk-vue',
      code: `import { createEnfyraClient, useAuth, useApi, useStorage, useWebSocket } from '@enfyra/sdk-vue'

createEnfyraClient({
  baseUrl: '/enfyra',
  auth: { strategy: 'cookie', cookieBridgePrefix: '/enfyra' },
})

// In any component setup():
const { user, login, logout, fetchUser } = useAuth()
const { data, loading, error, refresh } = useApi().get('/articles', { query: { limit: 20 } })
const socket = useWebSocket('chat')`,
      notes: [
        'Vue SPA is CSR-only. The host app must provide a same-origin proxy (Vite proxy, nginx, Caddy) mapping /enfyra/** to the Enfyra App /api bridge.',
        'createEnfyraClient() is called once at app entry. Composables read from the shared instance.',
        'Do not use @enfyra/sdk-vue inside Nuxt — use @enfyra/sdk-nuxt instead.',
      ],
    },
    {
      name: 'Dev proxy for CSR-only apps (React/Vue/Angular)',
      code: `// vite.config.ts (React or Vue)
export default defineConfig({
  server: {
    proxy: {
      '/enfyra': {
        target: 'https://admin.example.com/api',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\\/enfyra/, ''),
      },
      '/socket.io': {
        target: 'https://admin.example.com/api/ws',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})

// Production: nginx/Caddy reverse proxy with the same mapping.
// Angular: use proxy.conf.json with the same target paths.`,
      notes: [
        'CSR-only SDKs (@enfyra/sdk-react, @enfyra/sdk-vue, @enfyra/sdk-core in browser) require a same-origin proxy for HttpOnly cookie auth.',
        'The proxy maps /enfyra/** to the Enfyra App /api bridge. Do not point it at a raw ESV origin.',
        'Socket.IO proxy maps /socket.io/** to the Enfyra App /ws/socket.io/** for same-origin WebSocket cookies.',
        'For Nuxt and Next.js, the SDK handles this proxy automatically — do not add manual proxy config.',
      ],
    },
    {
      name: 'OAuth login flow (all frameworks)',
      code: `// Nuxt — composable handles everything:
const { oauthLogin } = useAuth()
oauthLogin('google')

// Next.js — use the SDK proxy prefix for OAuth start:
const redirect = new URL('/dashboard', window.location.origin)
const url = new URL(window.location.origin + '/api/enfyra/auth/google')
url.searchParams.set('redirect', redirect.toString())
url.searchParams.set('cookieBridgePrefix', '/api/enfyra')
window.location.href = url.toString()

// React/Vue CSR — same pattern with the app proxy prefix:
const oauthUrl = new URL(window.location.origin + '/enfyra/auth/google')
oauthUrl.searchParams.set('redirect', window.location.origin + '/dashboard')
oauthUrl.searchParams.set('cookieBridgePrefix', '/enfyra')
window.location.href = oauthUrl.toString()`,
      notes: [
        'OAuth starts through the same-origin SDK proxy prefix (/api/enfyra/auth/<provider> for Next.js, /enfyra/auth/<provider> for Nuxt/React/Vue). No need to expose the Enfyra App URL to the browser.',
        'cookieBridgePrefix must match the SDK proxy prefix: /enfyra for Nuxt/React/Vue, /api/enfyra for Next.js.',
        'After OAuth return, the SDK session check (/me or useAuth refresh) picks up the HttpOnly cookie automatically.',
        'Do not parse tokens from the URL. Do not create custom callback routes.',
      ],
    },
    {
      name: 'Password login and session check (all frameworks)',
      code: `// Nuxt:
const { login, user, isAuthenticated } = useAuth()
await login({ email, password, remember: true })

// Next.js:
const { login, user, isAuthenticated } = useAuth()
await login({ email, password })

// React:
const { login, user, isAuthenticated } = useAuth()
await login({ email, password, remember: true })

// Vue:
const { login, user, fetchUser } = useAuth()
await login({ email, password, remember: true })
await fetchUser()`,
      notes: [
        'All SDK login methods POST to the same-origin proxy prefix. HttpOnly cookies are set by the Enfyra App bridge.',
        'Session check calls /enfyra/me (Nuxt/React/Vue) or /api/enfyra/me (Next.js) through the SDK proxy. The SDK useAuth/fetchUser methods handle this internally.',
        'Do not read or store JWTs in browser JavaScript when using cookie strategy.',
        'The Enfyra App bridge owns token refresh and Bearer forwarding to ESV internally.',
      ],
    },
    {
      name: 'Realtime with SDK (Nuxt and Vue)',
      code: `// Nuxt — auto-imported composable:
const ws = useWebSocket('chat', { immediate: true })
ws.on('chat:message', (event) => { /* update state */ })

// Vue:
const socket = useWebSocket('chat')
await socket.connect()
socket.on('chat:message', handler)`,
      notes: [
        'Nuxt and Vue SDKs include useWebSocket with automatic same-origin Socket.IO path.',
        'Next.js realtime (useWebSocket) is gated pending E2E verification of WebSocket upgrade through Next rewrites.',
        'For Next.js or unsupported frameworks, use socket.io-client directly with path /socket.io and a same-origin proxy to the Enfyra App /ws/socket.io bridge.',
        'Create one connection per app, not per component. Disconnect when the user logs out.',
      ],
    },
    {
      name: 'Node.js scripts and unsupported frameworks with @enfyra/sdk-core',
      code: `import { EnfyraClient } from '@enfyra/sdk-core'

const client = new EnfyraClient({
  baseUrl: 'https://admin.example.com',
  auth: { strategy: 'token', accessToken: process.env.ENFYRA_API_TOKEN },
})

const { data } = await client.from('orders').select('id,total,status').limit(50).execute()`,
      notes: [
        'Use @enfyra/sdk-core directly for server-side scripts, CLI tools, or frameworks without an SDK adapter.',
        'For server-to-server, use token strategy with an API token from Enfyra admin.',
        'For browser usage without a framework SDK, use cookie strategy with a same-origin proxy.',
      ],
    },
  ],
};
