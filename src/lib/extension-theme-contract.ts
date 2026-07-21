import { z } from 'zod';
import { createHash } from 'node:crypto';
import { fetchAPI } from './fetch.js';
import { fetchTableCatalog, fetchTableMetadata, fetchTableMetadataByRef, resolveTableCatalogEntry } from './metadata-client.js';
import {
  assertCustomEndpointRoute,
  assertDynamicEndpointContract,
  extractExplicitRepositoryTableNames,
  reviewDynamicEndpointContract,
} from './dynamic-endpoint-contract.js';
import { validatePortableScriptSource, validateScriptSourceIfPresent } from './mutation-guards.js';
import { writeSourceArtifact } from './source-artifacts.js';
import {
  normalizeEscapedVueSource,
  normalizeStrictBoolean,
} from './tool-input-normalization.js';
import {
  analyzeExtensionSfc,
  extensionElementAttributeValue,
  extensionElementHasAttribute,
} from './extension-sfc-analyzer.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAck,
  assertGlobalRulesAck,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';
import {
  escapeRegExp,
  readTemplateBlocks,
} from './platform-extension-source.js';
import {
  AnyRecord,
} from './platform-shared-operations.js';
import {
  buildExtensionAccountPanelSnippet,
  buildExtensionDrawerSnippet,
  buildExtensionEmptyStateSnippet,
  buildExtensionFormEditorSnippet,
  buildExtensionMenuNotificationSnippet,
  buildExtensionModalSnippet,
  buildExtensionPageShellSnippet,
  buildExtensionPermissionGateSnippet,
  buildExtensionResourceGridSnippet,
  buildExtensionResourceListSnippet,
  buildExtensionTabsSnippet,
  buildExtensionUploadModalSnippet,
  buildExtensionWidgetSnippet,
} from './extension-component-builders.js';
import {
  buildExtensionApiUsageSnippet,
  buildExtensionConfirmSnippet,
  buildExtensionNotifySnippet,
} from './extension-api-builders.js';
import {
  reviewExtensionRuntimeContract,
  reviewExtensionUiContract,
} from './extension-contract-review.js';

const THEME_CLASS_INTENTS = {
  neutral_surface: {
    classes: 'eapp-surface-card eapp-radius-panel border eapp-divider',
    use: 'Ordinary cards, panels, KPI containers, list containers, detail blocks, and status blocks that should stay neutral.',
  },
  muted_surface: {
    classes: 'eapp-surface-muted eapp-radius-panel',
    use: 'Recessed areas, tracks, secondary panels, or subdued containers.',
  },
  flat_surface: {
    classes: 'eapp-surface-flat',
    use: 'Flush content areas that should follow the app surface without card chrome.',
  },
  hover_row: {
    classes: 'eapp-surface-hover eapp-divider',
    use: 'Clickable rows inside lists or tables.',
  },
  primary_identity: {
    classes: 'eapp-primary-surface eapp-radius-panel border',
    use: 'A selected/current entity, active plan, active package, or the single larger block representing current identity.',
  },
  primary_soft_icon_tile: {
    classes: 'eapp-primary-soft eapp-icon-tile',
    childClasses: 'eapp-primary-text',
    use: 'Compact runtime-primary icon tiles, selected chips, and small identity accents.',
  },
  primary_progress: {
    trackClasses: 'eapp-surface-muted eapp-radius-pill',
    fillClasses: 'eapp-primary-solid',
    use: 'Progress or meter fill controlled by the runtime primary color.',
  },
  status_success: {
    classes: 'eapp-status-success-soft eapp-status-success-text eapp-status-success-border',
    nuxtUi: { color: 'success', variant: 'soft' },
    use: 'Small success/healthy badges, chips, or icons only.',
  },
  status_warning: {
    classes: 'eapp-status-warning-soft eapp-status-warning-text eapp-status-warning-border',
    nuxtUi: { color: 'warning', variant: 'soft' },
    use: 'Small warning/attention badges, chips, or icons only.',
  },
  status_danger: {
    classes: 'eapp-status-danger-soft eapp-status-danger-text eapp-status-danger-border',
    nuxtUi: { color: 'error', variant: 'soft' },
    use: 'Small danger/error/destructive badges, chips, or icons only.',
  },
  status_info: {
    classes: 'eapp-status-info-soft eapp-status-info-text eapp-status-info-border',
    nuxtUi: { color: 'info', variant: 'soft' },
    use: 'Small informational badges, chips, or icons only.',
  },
  primary_action: {
    nuxtUi: { color: 'primary', variant: 'solid' },
    use: 'The single main action for the current scope.',
  },
  secondary_action: {
    nuxtUi: { color: 'neutral', variant: 'outline' },
    use: 'Visible secondary actions, refresh, filters, cancel, and navigation alternatives.',
  },
  ghost_navigation_action: {
    nuxtUi: { color: 'neutral', variant: 'ghost' },
    use: 'Back/navigation/icon actions that should not compete with the primary action.',
  },
  danger_action: {
    nuxtUi: { color: 'error', variant: 'solid' },
    use: 'Final destructive actions such as Delete or Remove.',
  },
  divider: {
    classes: 'eapp-divider',
    listClasses: 'eapp-divide-y',
    use: 'Borders and row separators in extension UI.',
  },
  text: {
    primary: 'eapp-text-primary',
    secondary: 'eapp-text-secondary',
    tertiary: 'eapp-text-tertiary',
    quaternary: 'eapp-text-quaternary',
    use: 'Copy hierarchy in extension UI.',
  },
} as const;

function buildExtensionThemeClasses(input: AnyRecord = {}) {
  const intent = String(input.intent || '').trim();
  if (!intent || !(intent in THEME_CLASS_INTENTS)) {
    return {
      action: 'extension_theme_classes_listed',
      validIntents: Object.keys(THEME_CLASS_INTENTS),
      note: 'Call again with one intent to get the exact classes/props for that theme contract.',
    };
  }
  const contract = THEME_CLASS_INTENTS[intent];
  return {
    action: 'extension_theme_classes_built',
    intent,
    contract,
    hardRules: [
      'Do not use raw CSS variable utilities such as text-[var(...)], bg-[var(...)], or border-[var(...)] in extension templates.',
      'Do not use hardcoded Tailwind palettes such as bg-violet-*, text-cyan-*, bg-green-*, dark:bg-zinc-*, or hex/rgb/hsl colors.',
      'Use status classes only for compact badges/icons/short text; keep large panels neutral.',
    ],
  };
}

function collectExtensionThemeIssues(code) {
  const source = String(code || '');
  const issues: Array<{ severity: 'error' | 'warning'; rule: string; message: string; suggestion: string }> = [];
  const push = (severity, rule, message, suggestion) => issues.push({ severity, rule, message, suggestion });
  const concretePalettes = [
    'slate', 'gray', 'zinc', 'neutral', 'stone',
    'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo',
    'violet', 'purple', 'fuchsia', 'pink', 'rose',
  ].join('|');
  const paletteClassPattern = new RegExp(`(?:^|[\\s"'])(?:dark:)?(?:bg|text|border|ring|divide|from|via|to)-(${concretePalettes})-(?:\\d{2,3}|950)(?:\\/\\d+)?`, 'i');
  const rawCssVarPattern = /\b(?:bg|text|border|ring|divide|from|via|to)-\[\s*var\(--/i;
  const neutralSemanticClassPattern = /\b(?:bg-default|bg-muted|border-default|divide-default|text-muted|text-dimmed)\b/;
  const concreteNuxtUiColors = [
    'slate', 'gray', 'zinc', 'stone',
    'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo',
    'violet', 'purple', 'fuchsia', 'pink', 'rose',
  ].join('|');
  const concreteNuxtColorPattern = new RegExp(`\\bcolor\\s*=\\s*["'](${concreteNuxtUiColors})["']`, 'i');

  if (rawCssVarPattern.test(source)) {
    push('error', 'raw-css-var-utility', 'Raw CSS variable utility classes are not allowed in generated extension templates.', 'Use eapp-* class tokens or Nuxt UI semantic color props by intent.');
  }
  if (paletteClassPattern.test(source)) {
    push('error', 'hardcoded-tailwind-palette', 'Hardcoded Tailwind palette classes are not allowed in themeable extension UI.', 'Use eapp-surface-*, eapp-primary-*, eapp-status-*, or Nuxt UI semantic colors.');
  }
  if (neutralSemanticClassPattern.test(source)) {
    push('error', 'nuxt-neutral-class', 'Nuxt UI neutral shortcut classes are not part of the extension theme contract.', 'Use eapp-surface-* and eapp-text-* classes instead.');
  }
  if (concreteNuxtColorPattern.test(source)) {
    push('error', 'concrete-nuxt-color', 'Concrete Nuxt UI palette colors are not allowed in generated extension UI.', 'Use color="primary|neutral|success|warning|error|info" by semantic intent.');
  }
  if (/#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i.test(source) || /\b(?:rgba?|hsla?|oklch|lab|lch)\s*\(/i.test(source)) {
    push('error', 'hardcoded-color-value', 'Hardcoded color values are not allowed in extension UI.', 'Use the Enfyra theme class contract instead of hex/rgb/hsl/oklch/lab/lch values.');
  }
  if (/\bstyle\s*=\s*["'][^"']*(?:color|background(?:-color)?|border-color)\s*:/i.test(source)) {
    push('error', 'inline-color-style', 'Inline color styles bypass the app theme contract.', 'Use eapp-* classes or Nuxt UI semantic props instead of inline color/background/border-color.');
  }
  if (/\bgradient\s*:\s*['"](?!none['"])[^'"]+['"]/.test(source) || /\bgradient\s*=\s*['"](?!none['"])[^'"]+['"]/.test(source)) {
    push('error', 'page-header-gradient', 'Generated operational extension pages must use PageHeader gradient "none" unless the user explicitly requests decoration.', 'Set gradient: "none" in usePageHeaderRegistry or omit decorative gradients.');
  }
  if (/<(?:article|section|div)\b[^>]*class=["'][^"']*(?:eapp-status-(?:success|warning|danger|info)-soft|bg-(?:success|warning|error|info)(?:\b|\/))/i.test(source)) {
    push('warning', 'large-status-surface', 'Status color appears on a large container.', 'Keep large panels neutral and put status color on a compact UBadge/icon/short text inside.');
  }
  const primaryActionCount = (source.match(/\bcolor\s*=\s*["']primary["']/g) || []).length;
  if (primaryActionCount > 2) {
    push('warning', 'primary-overuse', 'Many primary-colored controls were found.', 'Use primary only for the main action or identity accent; use neutral variants for secondary actions.');
  }
  const primarySurfaceCount = (source.match(/\beapp-primary-surface\b/g) || []).length;
  if (primarySurfaceCount > 3) {
    push('warning', 'primary-surface-overuse', 'eapp-primary-surface appears many times.', 'Use eapp-primary-surface only for selected/current identity blocks, not every card in a list/grid.');
  }
  if (/<(?:article|section|div)\b[^>]*class=["'][^"']*\bborder\b(?![^"']*\beapp-divider\b)/i.test(source)) {
    push('warning', 'bare-border-token', 'A bordered panel is missing eapp-divider.', 'Pair intentional borders with eapp-divider so borders follow the app theme contract.');
  }
  return issues;
}

export function reviewExtensionThemeContract(code) {
  const issues = collectExtensionThemeIssues(code);
  return {
    action: 'extension_theme_contract_reviewed',
    valid: issues.every((issue) => issue.severity !== 'error'),
    issueCount: issues.length,
    issues,
    nextSteps: issues.length
      ? ['Use build_extension_ui kind=theme_classes to choose classes/props by intent, then patch/update the extension.']
      : ['Snippet matches the checked theme contract rules. Still validate the final SFC before saving.'],
  };
}

export function buildExtensionUiSnippet(kind: string, input: AnyRecord = {}) {
  let result;
  switch (kind) {
    case 'drawer':
      result = buildExtensionDrawerSnippet(input);
      break;
    case 'modal':
      result = buildExtensionModalSnippet(input);
      break;
    case 'page_shell':
      result = buildExtensionPageShellSnippet(input);
      break;
    case 'permission_gate':
      result = buildExtensionPermissionGateSnippet(input);
      break;
    case 'empty_state':
      result = buildExtensionEmptyStateSnippet(input);
      break;
    case 'resource_list':
      result = buildExtensionResourceListSnippet(input);
      break;
    case 'resource_grid':
      result = buildExtensionResourceGridSnippet(input);
      break;
    case 'form_editor':
      result = buildExtensionFormEditorSnippet(input);
      break;
    case 'widget':
      result = buildExtensionWidgetSnippet(input);
      break;
    case 'menu_notification':
      result = buildExtensionMenuNotificationSnippet(input);
      break;
    case 'account_panel_item':
      result = buildExtensionAccountPanelSnippet(input);
      break;
    case 'tabs':
      result = buildExtensionTabsSnippet(input);
      break;
    case 'upload_modal':
      result = buildExtensionUploadModalSnippet(input);
      break;
    case 'api_usage':
      result = buildExtensionApiUsageSnippet(input);
      break;
    case 'notify':
      result = buildExtensionNotifySnippet(input);
      break;
    case 'confirm':
      result = buildExtensionConfirmSnippet(input);
      break;
    case 'runtime_review':
      if (!input?.code) {
        throw new Error('build_extension_ui kind=runtime_review requires input.code.');
      }
      result = reviewExtensionRuntimeContract(input.code);
      break;
    case 'theme_classes':
      result = buildExtensionThemeClasses(input);
      break;
    case 'theme_review':
      if (!input?.code) {
        throw new Error('build_extension_ui kind=theme_review requires input.code.');
      }
      result = reviewExtensionThemeContract(input.code);
      break;
    case 'review':
      if (!input?.code) {
        throw new Error('build_extension_ui kind=review requires input.code.');
      }
      const uiReview = reviewExtensionUiContract(input.code, { pattern: input.pattern });
      const themeReview = reviewExtensionThemeContract(input.code);
      const runtimeReview = reviewExtensionRuntimeContract(input.code);
      result = {
        action: 'extension_ui_theme_runtime_contract_reviewed',
        valid: uiReview.valid && themeReview.valid && runtimeReview.valid,
        issueCount: uiReview.issueCount + themeReview.issueCount + runtimeReview.issueCount,
        ui: uiReview,
        theme: themeReview,
        runtime: runtimeReview,
      };
      break;
    default:
      throw new Error(`Unsupported extension UI builder kind: ${kind}`);
  }
  return {
    gateway: 'build_extension_ui',
    kind,
    ...result,
  };
}

export function getExtensionThemeContract() {
  return {
    action: 'extension_theme_contract',
    useBefore: [
      'Call this before writing or reviewing Enfyra admin page, widget, or global extension UI.',
      'Then call validate_extension_code or an ensure_*_extension tool before saving.',
    ],
    layout: [
      'The extension is already mounted inside the Enfyra app shell. Do not add a duplicate page header, centered page wrapper, or root-level page padding.',
      'Page extensions should be full-bleed, responsive, and split large operations into focused pages or UTabs.',
      'Use usePageHeaderRegistry for the shell title and useHeaderActionRegistry/useSubHeaderActionRegistry for page actions.',
      'Register dynamic extension header actions inside onMounted after setup refs and handlers exist; build_extension_ui kind=page_shell generates this lifecycle shape.',
      'Use build_extension_ui kind=menu_notification for sidebar menu notification registration snippets.',
      'For shell menu notifications, first decide the signal source. Use a count only when the source already owns an exact count, such as a notification summary endpoint or bounded unread-notification query. Use a dot when a realtime event only proves that something new exists. Do not poll a domain list such as messages, tickets, orders, or jobs solely to decorate the menu; the destination page owns domain fetching.',
      'Use build_extension_ui kind=account_panel_item for account panel row registration snippets.',
      'For detail/form workflows that should stay left-aligned with empty space on the right, wrap the body in eapp-page-constrained; use eapp-page-constrained-wide only when the workflow genuinely needs more width.',
      'Card/list grids inside the default shell must account for the 280px desktop sidebar. Do not switch general card grids to three columns at lg; use md:grid-cols-2 xl:grid-cols-3 unless a local container proves three columns have enough width.',
    ],
    theme: [
      'Do not choose theme classes from memory. Decide the UI intent, then call build_extension_ui kind=theme_classes with that intent to receive the exact class/prop contract.',
      'Call build_extension_ui kind=theme_review or kind=review before saving extension UI; validate_extension_code and extension write tools also reject hard theme violations.',
      'Never fix one extension by injecting global CSS, redefining the app palette, or adding theme guards.',
      'Use get_theme_class_reference only when debugging theme internals or when the user explicitly asks for the full theme/class map.',
    ],
    themeIntents: [
      'neutral_surface',
      'muted_surface',
      'flat_surface',
      'hover_row',
      'primary_identity',
      'primary_soft_icon_tile',
      'primary_progress',
      'status_success',
      'status_warning',
      'status_danger',
      'status_info',
      'primary_action',
      'secondary_action',
      'ghost_navigation_action',
      'danger_action',
      'divider',
      'text',
    ],
    components: [
      'Use Nuxt UI/eApp components for normal controls: UButton, UInput, UTextarea, USelectMenu/USelect, USwitch, UCheckbox, UTabs, UBadge, UModal, and CommonDrawer when available.',
      'Use auto-injected components directly in the template with PascalCase names. Do not call resolveComponent() to manually resolve Nuxt UI/eApp components inside extension SFCs; it can compile but render unresolved lowercase DOM tags such as <ubutton>.',
      'Buttons should have stable geometry: hover may change color, border, or shadow but must not move the button or resize its content. Disabled buttons keep disabled cursor/visual state.',
      'Inputs and textareas should not add hover movement or decorative hover states; focus, invalid, disabled, and loading states must be explicit.',
      'For drawers, modals, page shell headers/actions, permission gates, empty states, resource lists, resource grids, form editors, widgets, menu/account panel registries, tabs, upload modals, api_usage, notify, and runtime/theming reviews, call build_extension_ui with the matching kind after extension acknowledgement before patching raw Vue.',
      'Use build_extension_ui kind=theme_classes for theme classes by intent, and kind=runtime_review, theme_review, or review before saving generated snippets that include composables, theme classes, high-contract UI, or native buttons.',
      'Use build_extension_ui kind=resource_grid for workboards, dashboards, catalogs, and responsive card collections instead of placing UCard children directly into a full-width list frame.',
      'Use the EmptyState runtime alias returned by build_extension_ui kind=empty_state; CommonEmptyState is not registered as a dynamic extension tag.',
      'Extension validation rejects UInput, UTextarea, USelect, USelectMenu, UInputMenu, UInputNumber, UInputTags, UInputTime, and UInputDate without class="w-full" unless marked data-compact or data-inline.',
      'Use UBadge or token-backed badge spans for status. Keep badges legible in both themes with tokenized background, text, and border.',
    ],
    appComposables: [
      'Call useApi() as a top-level setup composable. It returns data/error/pending/status refs plus execute/refresh; call or await execute()/refresh() from onMounted, watchers, or user actions when the request should run.',
      'Do not write useNotify shapes from memory. Use build_extension_ui kind=notify for known-good notification snippets. Use build_extension_ui kind=api_usage only when a generated fetch/mutation scaffold is useful.',
      'Use build_extension_ui kind=runtime_review or kind=review before saving extension code that includes useApi, useNotify, getPackages, or package loading.',
      'validate_extension_code and extension write tools reject static imports, useToast/useNotify.add misuse, and JSON.stringify useApi options.',
    ],
    shellComponentContracts: {
      CommonDrawer: [
        'Use build_extension_ui kind=drawer for generated drawer/editing snippets.',
        'The builder owns slots, managed footer actions, full-width fields, native button types, and loading/error/body structure. CommonDrawer disables drag dismissal globally; do not add handle-only, drag handlers, or swipe-to-close behavior.',
      ],
      CommonModal: [
        'Use build_extension_ui kind=modal for generated modal/confirmation snippets.',
        'The builder owns UModal/CommonModal aliasing, slots, managed footer actions, full-width fields, native button types, and modal surface constraints.',
      ],
      PermissionGate: [
        'Use build_extension_ui kind=permission_gate for generated permission wrapper snippets.',
        'UI gates are operator UX only; backend route permissions and handler/hook owner checks remain authoritative.',
      ],
      Widget: [
        'Use build_extension_ui kind=widget for generated widget include snippets.',
        'The builder owns numeric id usage, reactive prop/event wiring, and page/widget ownership warnings.',
      ],
      actionButtons: [
        'Use build_extension_ui kind=review for generated snippets with native buttons or theme classes.',
        'Validation/review catches missing type="button" and high-contract component mistakes before saving.',
      ],
    },
    loadingAndLists: [
      'For first load of card/list pages, render calm skeleton cards with a slow pulse. Use USkeleton or shared loading components so the app-owned skeleton theme controls contrast and accent matching. For subsequent pagination/filter refreshes, keep the card shells mounted and skeletonize card content until the new list is ready.',
      'Keep pagination inside the same transition/loading branch as the list. Do not show pagination before the list content has left loading.',
      'Use bounded pagination for operational lists. Do not replace pagination with arbitrary fixed caps such as 30 or 50.',
      'Empty states should use an app-matched card surface with compact icon tile, title, and description; do not use huge blank white panels or naked UEmpty chrome on page surfaces.',
    ],
    interaction: [
      'Every mutating button needs pending/disabled state, success/error feedback, and must close or update its modal when the operation completes.',
      'Do not refetch broad lists after selecting one row. Keep local selection state and fetch only the detail or mutation result needed.',
      'Customer-facing toasts must describe the operation. Do not surface raw job ids, flow ids, or worker ids.',
    ],
    security: [
      'Decide route permission, owner scope, and field exposure before writing UI or backend logic.',
      'UI checks are only guidance; handlers/hooks must independently enforce owner/root-admin authorization.',
      'Use the most specific business route or MCP tool. Do not write directly to raw tables when a domain route exists.',
    ],
    shellNotificationContract: {
      menu: 'useMenuNotificationRegistry().register({ id, target: { id?, path?, route? }, value?, color?, title?, order? }). value renders a count/chip; omitting value renders a dot. Parent menus sum numeric child values.',
      accountPanel: 'useAccountPanelRegistry().register({ id, label, description, icon, count?, badge?, badgeColor?, expanded?, onToggle?, contentComponent? }). count is preferred over badge and the account trigger sums numeric visible item counts, capped at 99+.',
      lifecycle: 'Register from global extensions for app-wide notification state; stable ids replace previous registrations and component-owned registrations are removed on unmount.',
      reasoning: 'Counts and dots are different promises. A count says the shell knows an exact or bounded number from an appropriate notification/summary source. A dot says the shell only knows that new attention exists. Avoid fetching the destination domain list just to make a menu badge more precise.',
    },
  };
}

export function getThemeClassReference() {
  return {
    action: 'theme_class_reference',
    authority: 'Authoritative Enfyra theme & color contract. Source of truth: documents/app/theme-color-contract.md. App owns color via theme.css + main.css + app.config.ts only; pages/extensions consume classes and Nuxt UI props.',
    baseLayers: {
      material: '--md-* (runtime primary picker, HCT/Material You). Drives identity/brand. Never read directly in templates.',
      status: '--st-success/--st-warning/--st-error/--st-info. Fixed semantic palette. Never read directly in templates.',
    },
    nuxtUiColors: {
      primary: 'runtime --md-primary (main brand action/identity). NEVER substitute a concrete palette.',
      secondary: 'runtime --md-tertiary (intentional secondary accent only).',
      success: '--st-success (healthy/success).',
      warning: '--st-warning (pending/attention).',
      error: 'single --danger-* lane from Material error roles (destructive/error). Ghost danger text uses --danger-on-surface; danger fills use --danger-surface.',
      info: '--st-info (informational).',
      neutral: 'neutral surfaces (secondary chrome, non-actions).',
    },
    classes: [
      { group: 'Surfaces (large ordinary - keep neutral)', classes: 'eapp-surface-card, eapp-surface-muted, eapp-surface-flat, eapp-surface-hover' },
      { group: 'Text', classes: 'eapp-text-primary, eapp-text-secondary, eapp-text-tertiary, eapp-text-quaternary' },
      { group: 'Runtime primary identity', classes: 'eapp-primary-solid, eapp-primary-text, eapp-primary-soft(+hover), eapp-primary-subtle, eapp-primary-surface(+hover), eapp-primary-border, eapp-primary-ring' },
      { group: 'Status (badges/small icons/short text only)', classes: 'eapp-status-{success|warning|danger|info|neutral}-{soft|text|border}' },
      { group: 'Radius', classes: 'eapp-radius-card, eapp-radius-panel, eapp-radius-control, eapp-radius-subcontrol, eapp-radius-pill' },
      { group: 'Icon tile geometry', classes: 'eapp-icon-tile, eapp-icon-tile-sm, eapp-icon-tile-lg' },
      { group: 'Dividers', classes: 'eapp-divider, eapp-divide-y' },
      { group: 'Modal', classes: 'eapp-modal-surface (never surface-card as modal ui.content)' },
    ],
    forbidden: [
      'Raw CSS variables in templates: text-[var(--*)], bg-[var(--*)], border-[var(--*)].',
      'Tailwind palette accents: from-cyan-*, text-violet-*, bg-green-*, bg-emerald-*, text-gray-*, bg-slate-*, dark:bg-zinc-950.',
      'Concrete palette substitution (color="violet"/"cyan"/..., from-cyan-*, text-violet-*, bg-green-*, bg-emerald-*, dark:bg-zinc-950).',
      'Hardcoded hex colors or inline style="color:#..." for theme-driven surfaces.',
      'Reading --md-* / --st-* / --badge-* base variables directly from extension templates.',
    ],
    allowedShortUtilities: [
      'Tailwind v4 short utilities ARE canonical and preferred: bg-primary, text-primary, border-primary, ring-primary, bg-success, text-error, bg-warning, text-info, bg-secondary.',
      'Opacity modifiers work natively via v4 color-mix: bg-primary/10, ring-primary/20, text-primary/70, bg-success/15.',
      'Use eapp-* classes only for intent surfaces with no Tailwind equivalent (eapp-primary-surface/solid/soft/subtle, eapp-surface-card/muted/flat/hover, eapp-divider/divide-y, eapp-radius-*, eapp-modal-surface).',
    ],
    chooseByIntent: [
      'Normal accent / active tab / progress / primary CTA -> primary (eapp-primary-* or color="primary").',
      'True semantic state -> status (eapp-status-* or color="success|warning|error|info").',
      'Large ordinary surface -> eapp-surface-*; put a small status badge inside.',
      'Whole block is active identity -> eapp-primary-surface (+hover), subtle only.',
    ],
  };
}
