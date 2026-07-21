export const permissionsRlsExamples = {
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
  description: "Authenticated users can list and create their own orders.",
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>"
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
  methods: ["GET"],
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>"
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
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>"
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
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>"
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
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
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
  message: "Please enter a valid email address",
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>"
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
  }),
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>"
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
  };
