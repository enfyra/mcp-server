export function buildDynamicScriptContextTypeContract() {
  return {
    authority: [
      'These are script-visible types that the ESV and isolated executor runtime guarantee for the listed surface.',
      'Do not add typeof, Array.isArray, existence, or callable guards around a documented container, service, method, or result envelope.',
      'Validate user-controlled field values inside @BODY, @QUERY, and @PARAMS when the business contract requires it. Check documented nullable values such as @USER and @UPLOADED_FILE when the selected route can omit them. @DATA remains unknown for a custom handler result.',
    ].join(' '),
    aliases: [
      'type Id = string | number',
      'type RuntimeRecord = Record<string, unknown>',
      'type Filter = Record<string, unknown>',
      'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }',
      'type JsonObject = { [key: string]: JsonValue }',
      'type PackageReadable = AsyncIterable<Uint8Array>',
      'type PackageStreamOptions = { timeoutMs?: number; maxBytes?: number }',
    ],
    values: {
      '@BODY': {
        type: 'JsonValue',
        guarantee: 'The surface payload, defaulting to {} when absent. Use the route, flow, or websocket input contract to access known fields directly; validate only business-level field constraints.',
      },
      '@QUERY': {
        type: 'QueryContext',
        declaration: 'type QueryContext = { filter: Filter; _filter: Filter; deep?: RuntimeRecord; _deep?: RuntimeRecord; fields?: string | string[]; sort?: string | string[]; page?: string | number; limit?: string | number; meta?: string | string[]; debugMode?: string | boolean; [key: string]: unknown }',
        guarantee: 'Always an object. For a valid parsed request, filter and _filter are objects and deep/_deep are parsed objects. Other REST query values normally arrive as strings. Do not guard the @QUERY container; reject malformed serialized query input instead of silently normalizing its framework shape.',
      },
      '@PARAMS': {
        type: 'Record<string, string>',
        guarantee: 'Always an object, defaulting to {}. Declared route parameters are strings.',
      },
      '@USER': {
        type: 'RuntimeRecord | null',
        guarantee: 'The authenticated Enfyra user record, otherwise null. It is non-null after an authenticated route or websocket boundary and in the OAuth lifecycle script, where it is the resolved persisted user. Public routes and anonymously triggered flows must handle null when identity is required.',
      },
      '@DATA': {
        type: 'unknown',
        declaration: 'type OAuthLifecycleData = { oauth: { event: "user_created" | "login"; provider: "google" | "facebook" | "github"; profile: { providerUserId: string; email: string; emailVerified: boolean | null; name: string | null; givenName: string | null; familyName: string | null; username: string | null; avatarUrl: string | null; profileUrl: string | null; locale: string | null }; claims: Record<string, unknown>; accessToken: string; token: { type: string | null; scopes: string[]; expiresAt: string | null } } }',
        guarantee: 'In the OAuth lifecycle script, @DATA is OAuthLifecycleData. In a post-hook this is the handler result. Canonical CRUD results use CollectionResult; custom handlers may return any JSON-serializable value.',
      },
      '@STATUS': {
        type: 'number',
        guarantee: 'Available in post-hooks and set to the current HTTP status, including error status on the handler error path.',
      },
      '@ERROR': {
        type: 'DynamicScriptError | undefined',
        declaration: 'type DynamicScriptError = { message: string; name: string; stack: string; statusCode: number; details: unknown; timestamp: string }',
        guarantee: 'Defined in post-hooks only when the handler path failed.',
      },
      '@ENV': {
        type: 'Record<string, string | undefined>',
        guarantee: 'Always an object. ESV removes DB_URI, DB_REPLICA_URIS, REDIS_URI, SECRET_KEY, and ADMIN_PASSWORD.',
      },
      '@SHARE': {
        type: '{ $logs: unknown[] }',
        guarantee: 'Always an object with a $logs array for the current execution batch.',
      },
      '@REQ': {
        type: 'HttpRequestContext | WebsocketRequestContext',
        declaration: [
          'type HttpRequestContext = { method: string; url: string; headers: Record<string, string | string[] | undefined>; query: QueryContext; params: Record<string, string>; ip: string | null; hostname: string; protocol: string; path: string; originalUrl: string; rawBody?: string }',
          "type WebsocketRequestContext = { method: 'WS_CONNECT' | 'WS_EVENT' | 'WS_CONNECT_TEST' | 'WS_EVENT_TEST'; url: string; headers: RuntimeRecord; ip: string | null; user: RuntimeRecord | null }",
        ],
        guarantee: 'Present in HTTP and websocket contexts; not part of the flow or OAuth lifecycle surface.',
      },
      '@API': {
        type: 'ApiExecutionContext',
        declaration: 'type ApiExecutionContext = { request: { method: string; url: string; timestamp: string; correlationId?: string; userAgent?: string; ip?: string }; response?: { statusCode: number; responseTime: number; timestamp: string }; error?: DynamicScriptError }',
        guarantee: 'Present in HTTP and websocket contexts. response/error are populated for post-hook completion and error handling.',
      },
      '@UPLOADED_FILE': {
        type: 'UploadedFileInfo | undefined',
        declaration: 'type UploadedFileInfo = { originalname: string; mimetype: string; encoding: string; path?: string; size: number; fieldname: string }',
        guarantee: 'Defined only for a multipart request containing a file. It is disk-backed metadata; do not expect a buffer.',
      },
      '@FLOW': {
        type: 'FlowContext',
        declaration: 'type FlowContext = { $payload: JsonValue; $last: unknown; $meta: { flowId: Id; flowName: string; executionId: Id; depth: number; startedAt: string; currentStep?: string }; [stepKey: string]: unknown }',
        guarantee: 'Present in flow steps. Each completed step key is assigned its result and $last is updated to that result.',
      },
      '@FLOW_PAYLOAD': {
        type: 'JsonValue',
        guarantee: 'Alias of @FLOW.$payload.',
      },
      '@FLOW_LAST': {
        type: 'unknown',
        guarantee: 'Alias of @FLOW.$last; null before the first completed step.',
      },
      '@FLOW_META': {
        type: 'FlowContext["$meta"]',
        guarantee: 'Alias of @FLOW.$meta.',
      },
    },
    repositories: {
      declaration: [
        'type CollectionResult<T = RuntimeRecord> = { data: T[]; meta?: { totalCount?: number; filterCount?: number; [key: string]: unknown }; count?: number; [key: string]: unknown }',
        'type RepositoryFindOptions = { filter?: Filter; fields?: string | string[]; limit?: number; sort?: string; meta?: string | string[]; deep?: Record<string, RuntimeRecord> }',
        'type AggregateOptions = { filter?: Filter; dimensions?: Array<{ field: string; bucket?: "hour" | "day" | "week" | "month" | "year"; timezone?: string }>; measures: Record<string, Record<string, string>>; sort?: Array<{ field: string; direction: "asc" | "desc" }>; page?: number; limit?: number }',
        'type UpdatePayload = { data: RuntimeRecord; fields?: string | string[] }',
        'type LockedUpdateOptions = Omit<UpdatePayload, "data"> & { id: Id; data: (current: RuntimeRecord) => RuntimeRecord | Promise<RuntimeRecord> }',
        'type LockedReadOptions = { id: Id; fields?: string | string[]; deep?: Record<string, RuntimeRecord> }',
        'interface DynamicRepository { find(options?: RepositoryFindOptions): Promise<CollectionResult>; findLocked(options: LockedReadOptions): Promise<CollectionResult>; aggregate(options: AggregateOptions): Promise<CollectionResult>; exists(filter?: Filter): Promise<boolean>; create(options: { data: RuntimeRecord; fields?: string | string[] }): Promise<CollectionResult>; createMany(options: { data: RuntimeRecord[]; fields?: string | string[] }): Promise<CollectionResult & { count: number }>; update(options: UpdatePayload & { id: Id }): Promise<CollectionResult>; updateLocked(options: LockedUpdateOptions): Promise<CollectionResult>; updateMany(options: { ids: Id[]; data: RuntimeRecord; fields?: string | string[] }): Promise<CollectionResult & { count: number }>; delete(options: { id: Id }): Promise<{ message: string; statusCode: 200 }>; deleteMany(options: { ids: Id[] }): Promise<{ message: string; statusCode: 200; count: number }> }',
      ].join('\n'),
      guarantee: 'find/create/update/updateLocked and createMany/updateMany return collection-shaped results with data arrays. updateLocked({ id, fields?, data: current => patch }) keeps the same option keys as update, with data accepting a callback in one protected unit of work: PostgreSQL/MySQL lock the root row; Mongo requires native transactions and can rerun the callback on conflict. Mongo standalone is unsupported. Use it only for plain generic tables and keep callbacks limited to computation and patch return, without external side effects or repository calls. Top-level fields selects the response only. Secure callbacks receive readable fields. An outer transaction owns commit and Mongo retry. createMany/updateMany/deleteMany return count. Batch methods reject metadata/schema routes and custom-lifecycle tables; updateMany rejects relations. Never guard result.data with Array.isArray. Use result.data[0] after a proven match, or result.data?.[0] ?? null when zero rows is valid.',
      access: '@REPOS.main is the secure current-route repository. @REPOS.secure.<table> and #secure.<table> are secure explicit repositories. @REPOS.<table> and #<table> are trusted explicit repositories.',
      availability: { findLocked: 'Requires deployed Server/Kernel support for native locked reads. Verify with a non-saving target test before authoring live consumers; a local source contract does not prove the deployed method exists.' },
      lockedReadGuarantee: 'findLocked requires an explicit outer transaction on PostgreSQL/MySQL and follows normal read authorization. Its locking read observes current root state even after an earlier MySQL repeatable-read snapshot. It performs no write and emits no mutation event, retaining the root row lock until outer commit/rollback. MongoDB and SQLite lock-only reads are rejected. Missing roots fail; absent rows, related targets and external publication need separate protection. Keep dependent repository operations inside the outer callback and verify deployed support before use.',
    },
    services: {
      '@HELPERS': [
        '$jwt(payload: RuntimeRecord, expiresIn: string): Promise<string> — HTTP and GraphQL only',
        '$bcrypt.hash(plain: string): Promise<string>',
        '$bcrypt.compare(plain: string, hash: string): Promise<boolean>',
        'autoSlug(text: string): Promise<string>',
        '$fetch(url: string, options?): Promise<unknown | string | ArrayBuffer>',
        '$sleep(ms: number): Promise<void>',
        '$crypto.randomUUID(): Promise<string>',
        "$crypto.randomBytes(size?: number, encoding?: 'hex' | 'base64' | 'base64url'): Promise<string>",
        "$crypto.sha256(value: string, encoding?: 'hex' | 'base64' | 'base64url'): Promise<string>",
        "$crypto.hmacSha256(value: string, secret: string, encoding?: 'hex' | 'base64' | 'base64url'): Promise<string>",
        '$crypto.generateSshKeyPair(comment?: string): Promise<{ publicKey: string; privateKey: string }>',
        '$rateLimit.check/byIp/byUser/byRoute/byIpGlobal/byUserGlobal/status(...): Promise<{ allowed: boolean; remaining: number; resetAt: number; retryAfter: number; limit: number; window: number }> — HTTP dynamic routes only',
        '$rateLimit.reset(key: string): Promise<void> — HTTP dynamic routes only',
      ],
      '@CACHE': [
        'acquire(key: string, value: unknown, ttlMs: number): Promise<boolean>',
        'release(key: string, value: unknown): Promise<boolean>',
        'get(key: string): Promise<unknown>',
        'set(key: string, value: unknown, ttlMs: number): Promise<void>',
        'exists(key: string, value: unknown): Promise<boolean>',
        'deleteKey(key: string): Promise<void>',
        'setNoExpire(key: string, value: unknown): Promise<void>',
      ],
      '@STORAGE': [
        '$upload(options: { file?: UploadedFileInfo; originalname?: string; filename?: string; mimetype?: string; buffer?: ArrayBuffer; size?: number; encoding?: string; folder?: Id | { id: Id }; storageConfig?: Id; title?: string; description?: string }): Promise<RuntimeRecord>',
        '$update(fileId: Id, options: RuntimeRecord): Promise<RuntimeRecord>',
        '$delete(fileId: Id): Promise<RuntimeRecord>',
        '$registerFile(options: RuntimeRecord & { mimetype: string; location: string; storageConfig: Id | { id: Id } }): Promise<RuntimeRecord>',
      ],
      '@SOCKET': {
        global: 'HTTP/flow global socket: emitToUser(userId, event, data), emitToRoom(path, room, event, data), emitToGateway(path, event, data), broadcast(event, data) return Promise<void>; roomSize(room) returns Promise<number>.',
        bound: 'The bound websocket socket also exposes reply(event, data), join(room), leave(room), emitToCurrentRoom(room, event, data), broadcastToRoom(room, event, data), and disconnect(), all returning Promise<void>.',
      },
      '$ctx.$streams': 'Kernel-managed package-readable helpers. preflight(readable: PackageReadable, options?: { timeoutMs?: number }): Promise<{ stream: PackageReadable; firstChunk: Uint8Array }> pulls the first non-empty raw chunk before the public response starts and returns a single-consumer replay stream. readBytes(readable, options?: PackageStreamOptions): Promise<Uint8Array> and readText(readable, options?: PackageStreamOptions): Promise<string> consume without starting a response; both default maxBytes to 8 MiB, enforce it on raw bytes, and readText decodes UTF-8 incrementally. A preflight/read timeout is stream-scoped and throws ERR_PACKAGE_STREAM_TIMEOUT, leaving the executor task available for application-owned retry with a new upstream request. Empty-before-byte throws ERR_PACKAGE_STREAM_EMPTY. Each package readable has one consumer; duplicate or concurrent consumption throws a deterministic ERR_PACKAGE_STREAM_* error. Helper timeoutMs is capped by the enclosing handler or flow-step deadline, and task cancellation cleans up every owned stream session.',
      '@RES': 'HTTP handler only. json(value, { statusCode?, headers? }): Promise<void> owns a complete success JSON body, status (200-399), and headers; use return await @RES.json(...) as the terminal statement for custom success responses. Custom errors use @THROW.json instead. bytes(value, { statusCode?, mimetype?, filename?, headers? }): Promise<void> owns an exact binary response. stream(readable, options?): Promise<void> relays a readable and is also a terminal response boundary. The readable may be package-backed, the replay stream returned by $ctx.$streams.preflight, or another approved server-side readable. Direct @RES.stream(upstream.body, ...) starts the public response before consuming the body; use preflight first when the application must retry an upstream that produces no bytes. Stream options may include statusCode, mimetype, filename, headers, observer?: (chunkText: string, kind: "chunk" | "end" | "error") => unknown | Promise<unknown>, and transform?: (chunkText: string, kind: "chunk" | "end") => string | null | undefined | Promise<string | null | undefined>. transform receives UTF-8-decoded fragments before relay: one decoder spans the full stream, so a Unicode code point split across byte chunks is intact. A fragment may still end inside an SSE line or event, so SSE transforms keep a per-request buffer and parse only complete blank-line-delimited events. Return a string to replace output, null to suppress it, or undefined to preserve it; transform failures fail the stream. observer remains best-effort and is not a pre-response readiness primitive. Await the response method and do not start or return another response afterward. Direct relay remains bounded by the selected method timeout; client abort/response close cancels the task.',
      '@TRIGGER': 'Callable macro: @TRIGGER(flowIdOrName: Id, payload?: JsonValue): Promise<{ jobId: string; flowId: Id } | { triggered: true; flowId: Id; flowName: string }>. Do not use @TRIGGER.trigger(...).',
      '@TRANSACTION': 'Maps to $ctx.$transaction. Use await @TRANSACTION.run<T>(async () => { ... }) for an atomic repository mutation scope. The OAuth lifecycle script already runs inside a server-owned transaction, and a nested @TRANSACTION.run joins it. Repository cache invalidations and mutation events flush after commit; direct external effects such as fetch, storage, cache, socket, and flow triggers do not roll back.',
      '@LOGS': 'Synchronous callable: (...values: unknown[]) => void. Prefer @LOGS(message, details?).',
      '@THROW': [
        'Error-only contract. Every method returns never synchronously; do not await throw helpers.',
        'http(statusCode: number, message?: string): never creates the generic Enfyra error envelope.',
        'json(body: JsonObject & { success?: never; statusCode?: never; error?: JsonObject & { statusCode?: never } }, options?: { statusCode?: number; headers?: Record<string, string | number | readonly string[]> }): never preserves non-reserved custom root/error fields and owns a 400-599 HTTP status (default 500) plus headers. ESV always writes root success=false and root statusCode equal to the HTTP status, removes error.statusCode, and merges server-owned timestamp, pathname-only path, method, and correlationId into error.',
        'Readable aliases @THROW400/@THROW401/@THROW403/@THROW404/@THROW409/@THROW422/@THROW429/@THROW500/@THROW503 each require exactly one message and compile to http(theFixedStatusCode, message).',
        'No .error, semantic throw methods, details argument, or numeric property calls exist in the source contract. @RES.json is success-only.',
      ],
      '@PKGS': 'Record<string, package module>. Package calls may be async or thenable according to the installed package; await operations that produce values. A package-backed readable is a single-consumer AsyncIterable<Uint8Array>: pull it with for await...of, preflight it through $ctx.$streams, consume it through readBytes/readText, or relay it once through @RES.stream.',
    },
    bridge: {
      async: 'In script code, calls through @REPOS, @HELPERS, @CACHE, @STORAGE, @SOCKET, $ctx.$streams, @RES, and @TRIGGER cross the executor bridge and return promises. Await them.',
      sync: '@LOGS and @THROW execute synchronously. Do not await them.',
    },
  };
}
