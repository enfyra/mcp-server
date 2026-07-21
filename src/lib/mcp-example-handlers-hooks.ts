export const handlersHooksExamples = {
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
        name: 'Third-party create endpoint with server-owned identity',
        code: `api_endpoint_workflow({
  path: "/integrations/orders",
  method: "POST",
  anonymousAccess: "private",
  roleName: "user",
  applyAll: true,
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
  knowledgeAckKey: "<dynamicCodeAckKey from get_enfyra_required_knowledge>",
  sourceCode: \`const title = @BODY.title
if (!title) @THROW400("title is required")

const result = await #secure.orders.create({
  data: {
    ...@BODY,
    owner: @USER.id
  },
  fields: ["id", "title", "owner"]
})

const order = result.data?.[0] ?? null
if (!order) @THROW500("Order was not returned after create")
return {
  id: order.id,
  title: order.title,
  owner: order.owner?.id || order.owner
}\`
})`,
        notes: [
          'Custom routes have no main table, so explicit user-facing access uses #secure.orders rather than @REPOS.main.',
          'data: @BODY is valid TypeORM-style repository usage. Put ...@BODY first and server-owned fields afterward so caller input cannot override them.',
          'Custom handlers do not inherit canonical column-rule/Zod middleware; validate the endpoint-specific business payload in the handler.',
          'Replace orders, owner, fields, role, and path only after inspecting live metadata and the intended external contract.',
        ],
      },
      {
        name: 'Third-party scoped update endpoint',
        code: `const found = await #secure.orders.find({
  filter: {
    _and: [
      { id: { _eq: @PARAMS.id } },
      { owner: { id: { _eq: @USER.id } } }
    ]
  },
  fields: ["id", "title", "owner"],
  limit: 1
})

const order = found.data?.[0]
if (!order) @THROW404("Order not found")

const result = await #secure.orders.update({
  id: order.id,
  data: {
    ...@BODY,
    owner: @USER.id
  },
  fields: ["id", "title", "owner"]
})

const updated = result.data?.[0] ?? null
return updated
  ? { id: updated.id, title: updated.title, owner: updated.owner?.id || updated.owner }
  : null`,
        notes: [
          'The scoped lookup proves the current row belongs to the caller before mutation; route permission and secure repository selection do not prove ownership.',
          'The update keeps owner server-controlled instead of allowing @BODY to reassign it.',
          'If ownership can change concurrently, make it immutable or use the transaction/business invariant appropriate to the application.',
        ],
      },
      {
        name: 'Third-party action updates a non-updatable server field',
        code: `const found = await #secure.orders.find({
  filter: {
    _and: [
      { id: { _eq: @PARAMS.id } },
      { owner: { id: { _eq: @USER.id } } }
    ]
  },
  fields: ["id", "status", "owner"],
  limit: 1
})

const order = found.data?.[0]
if (!order) @THROW404("Order not found")
if (order.status !== "pending") @THROW409("Order is not pending")

const result = await #orders.update({
  id: order.id,
  data: { status: "cancelled" },
  fields: ["id", "status"]
})

const updated = result.data?.[0] ?? null
return updated ? { id: updated.id, status: updated.status } : null`,
        notes: [
          'The secure lookup proves caller scope before the privileged mutation.',
          'The trusted write is intentional because status is server-owned and non-updatable through normal CRUD. It writes an exact literal object, never raw @BODY.',
          'Do not change status.isUpdatable to make this action work; that would broaden canonical CRUD for eApp and every other consumer.',
          'Return an explicit response shape and never the raw trusted row.',
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

const user = result.data?.[0] ?? null
if (!user) @THROW500("User was not returned after create")
return { id: user.id, email: user.email }`,
        notes: [
          'create/update return { data: [...] }, not a bare row.',
          'The trusted user repository is intentional for registration internals. Shape the response explicitly and never return the raw trusted row.',
          'Use numeric @THROW helpers for raw HTTP messages. If you pass details, pass an object/array such as @THROW404("Request not found", { requestId }). Use @THROW.notFound(resource, id?) or @THROW.duplicate(resource, field, value) only when you want Enfyra-formatted semantic messages.',
          'Prefer macros over raw $ctx when a macro exists.',
        ],
      },
      {
        name: 'Workflow handler with relation read and side effects',
        code: `const requestId = @BODY.requestId
if (!requestId) @THROW400("requestId is required")

const found = await #secure.app_requests.find({
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

await #secure.app_requests.update({
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
          'Use #secure.table for user-facing reads and writes so field permissions stay enabled. The audit/notification writes above are trusted internal side effects and must return only the shaped response.',
          'Create/update return { data: [...] }; use result.data?.[0] when the script needs the saved object.',
        ],
      },
      {
        name: 'Find one record by id in a handler',
        code: `const reportId = @BODY.reportId
if (!reportId) @THROW400("reportId is required")

const found = await #secure.app_reports.find({
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
          'Use #secure.table_name with explicit fields and limit:1 for user-facing dynamic-script lookups.',
          'Use id filters when they work in the live runtime, but do not keep retrying @REPOS.<table>.find id filter shapes if a runtime reports undefined SQL bindings.',
          'If primary-key filtering fails in a runtime, pivot to a unique business field, the route main-table context, or a bounded query that you can verify, then update the contract/example for that runtime.',
          'Never return raw trusted repository rows; shape the response explicitly.',
        ],
      },
      {
        name: 'Canonical route pre-hook RLS filter merge',
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
          'This policy affects every consumer of the canonical route, including eApp. Use a separate custom endpoint handler when the scope is third-party-only.',
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
  };
