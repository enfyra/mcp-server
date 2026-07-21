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
    ],
    values: {
      '@BODY': {
        type: 'JsonValue',
        guarantee: 'The surface payload, defaulting to {} when absent. Use the route, flow, or websocket input contract to access known fields directly; validate only business-level field constraints.',
      },
      '@QUERY': {
        type: 'QueryContext',
        declaration: 'type QueryContext = { filter: Filter; _filter: Filter; deep?: RuntimeRecord; _deep?: RuntimeRecord; aggregate?: RuntimeRecord; fields?: string | string[]; sort?: string | string[]; page?: string | number; limit?: string | number; meta?: string | string[]; debugMode?: string | boolean; [key: string]: unknown }',
        guarantee: 'Always an object. For a valid parsed request, filter and _filter are objects and deep/_deep/aggregate are parsed objects. Other REST query values normally arrive as strings. Do not guard the @QUERY container; reject malformed serialized query input instead of silently normalizing its framework shape.',
      },
      '@PARAMS': {
        type: 'Record<string, string>',
        guarantee: 'Always an object, defaulting to {}. Declared route parameters are strings.',
      },
      '@USER': {
        type: 'RuntimeRecord | null',
        guarantee: 'The authenticated Enfyra user record, otherwise null. It is non-null after an authenticated route or websocket boundary; public routes and anonymously triggered flows must handle null when identity is required.',
      },
      '@DATA': {
        type: 'unknown',
        guarantee: 'In a post-hook this is the handler result. Canonical CRUD results use CollectionResult; custom handlers may return any JSON-serializable value.',
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
        guarantee: 'Present in HTTP and websocket contexts; not part of the flow or OAuth provisioning surface.',
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
        'type CollectionResult<T = RuntimeRecord> = { data: T[]; meta?: { totalCount?: number; filterCount?: number; aggregate?: unknown; [key: string]: unknown }; count?: number; [key: string]: unknown }',
        'type RepositoryFindOptions = { filter?: Filter; fields?: string | string[]; limit?: number; sort?: string; meta?: string | string[]; aggregate?: RuntimeRecord; deep?: Record<string, RuntimeRecord> }',
        'interface DynamicRepository { find(options?: RepositoryFindOptions): Promise<CollectionResult>; exists(filter?: Filter): Promise<boolean>; create(options: { data: RuntimeRecord | RuntimeRecord[]; fields?: string | string[]; batch?: boolean }): Promise<CollectionResult | { accepted: true; batch: true; count: number }>; update(options: { id: Id; data: RuntimeRecord; fields?: string | string[] }): Promise<CollectionResult>; delete(options: { id: Id }): Promise<{ message: string; statusCode: 200 }> }',
      ].join('\n'),
      guarantee: 'find/create/update return CollectionResult in normal non-batch use and data is always an array. Never guard result.data with Array.isArray. Use result.data[0] after a proven match, or result.data?.[0] ?? null when zero rows is valid.',
      access: '@REPOS.main is the secure current-route repository. @REPOS.secure.<table> and #secure.<table> are secure explicit repositories. @REPOS.<table> and #<table> are trusted explicit repositories.',
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
      '@RES': 'HTTP handler only: stream(readable, options?): Promise<void>. The response stream starts asynchronously; return after awaiting it.',
      '@TRIGGER': 'trigger(flowIdOrName: Id, payload?: JsonValue): Promise<{ jobId: string; flowId: Id } | { triggered: true; flowId: Id; flowName: string }>.',
      '$ctx.$transaction': 'Raw-only $ctx.$transaction.run<T>(callback: () => Promise<T>): Promise<T>. Only repository operations participate in rollback.',
      '@LOGS': 'Synchronous callable: (...values: unknown[]) => void. Prefer @LOGS(message, details?).',
      '@THROW': [
        'Every method returns never synchronously; do not await throw helpers.',
        'http(statusCode: number, message: string, details?: unknown): never',
        'businessLogic/validation/database/dbQuery/schema/fileUpload(message: string, details?: unknown): never',
        'config(message: string, configKey?: string): never',
        'notFound(resource: string, identifier?: string): never',
        'duplicate(resource: string, field: string, value: string): never',
        'unauthorized/forbidden(message?: string): never',
        'tokenExpired/invalidToken(): never',
        'externalService(service: string, message: string, details?: unknown): never',
        'serviceUnavailable(service: string): never',
        'rateLimit(limit: number, window: string): never',
        'scriptError(message: string, scriptId?: string, details?: unknown): never',
        'scriptTimeout(timeoutMs: number, scriptId?: string): never',
        'fileNotFound(filePath: string): never',
        'fileSizeExceeded(maxSize: string, actualSize: string): never',
        "'400'/'404'/'409'/'422'/'429'/'500'/'503'(message: string, details?: unknown): never; '401'/'403'(message?: string): never",
      ],
      '@PKGS': 'Record<string, package module>. Package calls may be async or thenable according to the installed package; await operations that produce values.',
    },
    bridge: {
      async: 'In script code, calls through @REPOS, @HELPERS, @CACHE, @STORAGE, @SOCKET, @RES, and @TRIGGER cross the executor bridge and return promises. Await them.',
      sync: '@LOGS and @THROW execute synchronously. Do not await them.',
    },
  };
}
