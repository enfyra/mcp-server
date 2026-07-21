export const extensionsExamples = {
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
        h('span', { class: 'text-xs eapp-text-tertiary', 'aria-hidden': 'true' }, '→'),
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
    filter: { readAt: { _is_null: true } },
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
  const rows = Array.isArray(notificationApi.data.value?.data)
    ? notificationApi.data.value.data
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
  globalRulesAckKey: "<globalRulesAckKey from get_enfyra_required_knowledge>",
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
    fields: 'id,status,total,createdAt',
    limit: 10,
    sort: '-createdAt'
  },
  errorContext: 'Fetch orders'
})

const orders = computed(() => data.value?.data ?? [])

onMounted(() => fetchOrders())
</script>

<template>
  <section class="space-y-3">
    <UButton type="button" color="neutral" variant="outline" :loading="pending" @click="fetchOrders">
      Refresh
    </UButton>
    <div class="eapp-surface-card eapp-divide-y">
      <div v-for="order in orders" :key="order.id" class="px-4 py-3">
        <p class="text-sm font-medium eapp-text-primary">{{ order.status }}</p>
        <p class="text-xs eapp-text-tertiary">{{ order.createdAt }}</p>
      </div>
    </div>
  </section>
</template>`,
        notes: [
          'Use app-provided composables in extensions.',
          'useApi does not auto-run; call execute() on mounted or through an action.',
          'useApi returns refs. Read normal Enfyra list rows from data.value?.data, or from response?.data when using the direct execute() return value.',
          'Pass query/body/filter/deep/aggregate as plain objects or computed objects in app/extension code; do not JSON.stringify them for useApi.',
          'The /order path is illustrative; inspect routes and fetch the smallest data shape the extension needs.',
          'Keep extension UI focused; move backend logic into handlers/hooks when needed.',
        ],
      },
      {
        name: 'Builder-reviewed modal and drawer footer actions',
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
      <UInput v-model="version" class="w-full" />
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
          'Use build_extension_ui with kind=modal or kind=drawer to generate this shape after extension acknowledgement instead of hand-writing the component contract.',
          'Use build_extension_ui kind=review before saving snippets with modals, drawers, fields, or native buttons.',
          'Extension validation rejects common field controls without class="w-full" unless marked data-compact or data-inline.',
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
  };
