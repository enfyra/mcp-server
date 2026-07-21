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
  buildExtensionAccountPanelSnippet,
  buildExtensionApiUsageSnippet,
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
  buildExtensionUiSnippet,
  buildExtensionUploadModalSnippet,
  buildExtensionWidgetSnippet,
  getExtensionThemeContract,
  getThemeClassReference,
  jsonText,
  patchExtensionCode,
  reviewExtensionUiContract,
  runExtensionWorkflow,
  updateExtensionCode,
  validateDynamicScript,
  validateExtensionCode,
  verifyExtensionRuntime,
} from './platform-operation-logic.js';

export function registerPlatformExtensionTools(server, ENFYRA_API_URL) {
  const extensionFooterActionSchema = z.object({
    label: z.string().optional().describe('Static action label. Use labelExpression instead for dynamic labels.'),
    labelExpression: z.string().optional().describe('Raw Vue expression for a dynamic label, e.g. mode === "create" ? "Create" : "Save".'),
    icon: z.string().optional().describe('Optional icon name such as lucide:save or lucide:trash-2.'),
    loading: z.string().optional().describe('Raw Vue expression/ref name for loading state, e.g. saving.'),
    disabled: z.string().optional().describe('Raw Vue expression/ref name for disabled state, e.g. saving || !canSubmit.'),
    color: z.string().optional().describe('Optional component-supported color. Usually omit and let the managed action choose intent.'),
    variant: z.string().optional().describe('Optional component-supported variant. Usually omit and let the managed action choose intent.'),
    tone: z.string().optional().describe('Optional action tone when supported by the shell component.'),
    onClick: z.string().describe('Raw Vue expression or function reference for the click handler, e.g. saveNote or () => (open = false).'),
  });
  const extensionHeaderActionSchema = z.object({
    id: z.string().describe('Stable action id.'),
    label: z.string().optional().describe('Action label.'),
    icon: z.string().optional().describe('Icon name such as lucide:plus or lucide:refresh-cw.'),
    color: z.string().optional().default('neutral').describe('Nuxt UI color. Use primary only for the single main scope action; otherwise neutral.'),
    variant: z.string().optional().default('outline').describe('Nuxt UI variant. Use solid for the main scope action; otherwise outline/ghost.'),
    loading: z.string().optional().describe('Raw Vue expression/ref name for loading state.'),
    disabled: z.string().optional().describe('Raw Vue expression/ref name for disabled state.'),
    to: z.string().optional().describe('Route path for visible navigation actions.'),
    onClick: z.string().optional().describe('Script callback expression or handler reference. Prefer a handler name; bare ref assignments must use ref.value, e.g. () => (modalOpen.value = true).'),
    order: z.number().optional().describe('Sort order in the shell header action area.'),
    side: z.enum(['left', 'right']).optional().describe('Optional shell side.'),
  });
  server.tool(
      'validate_dynamic_script',
      [
        'Validate Enfyra dynamic script code before saving it to any script-backed metadata record.',
        'Use this before create/update of handlers, hooks, flow steps, websocket scripts, OAuth provisioning scripts, or bootstrap scripts when the user is iterating on code.',
        'This calls the same server compiler contract used by Enfyra, but does not save anything.',
      ].join(' '),
      {
        sourceCode: z.string().describe('Raw dynamic script sourceCode.'),
        scriptLanguage: z.enum(['javascript', 'typescript']).optional().default('javascript').describe('Script language to validate.'),
      },
      async ({ sourceCode, scriptLanguage }) => jsonText({
        action: 'dynamic_script_validated',
        validation: await validateDynamicScript(ENFYRA_API_URL, sourceCode, scriptLanguage),
      }),
    );

  server.tool(
      'validate_extension_code',
      [
        'Validate Enfyra admin extension code before saving it to enfyra_extension.',
        'Use this only when the user explicitly wants a validation-only check. For normal edits, use update_extension_code or ensure_*_extension so successful validation saves in the same tool call.',
        'This calls /enfyra_extension/preview and does not save anything.',
        'Call get_extension_theme_contract first when generating or reviewing UI.',
      ].join(' '),
      {
        code: z.preprocess(normalizeEscapedVueSource, z.string()).describe('Vue SFC or compiled extension bundle code. Raw source is preferred; a fully JSON-escaped one-line SFC is normalized for weak clients.'),
        name: z.string().optional().describe('Optional extension name/id used by the preview compiler.'),
        uiPattern: z.enum(['resource_list', 'resource_grid', 'master_detail', 'form', 'custom']).optional().describe('Optional intended UI pattern. resource_list/resource_grid enable deterministic layout policy checks.'),
      },
      async ({ code, name, uiPattern }) => jsonText({
        action: 'extension_code_validated',
        validation: await validateExtensionCode(ENFYRA_API_URL, code, name, { uiPattern }),
      }),
    );

  server.tool(
      'verify_extension_runtime',
      [
        'Verify one saved Enfyra extension through the strongest checks available inside MCP.',
        'It checks the saved record and expected hash, runs local UI/theme/runtime policy review, calls the server Vue compiler, and verifies page menu wiring.',
        'It explicitly reports browserRender=not_run because signed-in component execution, real API data shape, console errors, and responsive layout require browser automation outside this MCP server.',
      ].join(' '),
      {
        id: z.union([z.string(), z.number()]).optional().describe('Saved extension id. Provide id or name.'),
        name: z.string().optional().describe('Saved extension unique name. Provide id or name.'),
        expectedSha256: z.string().optional().describe('Optional expected saved source hash from inspect/update/patch output.'),
        uiPattern: z.enum(['resource_list', 'resource_grid', 'master_detail', 'form', 'custom']).optional().describe('Optional intended UI pattern for deterministic layout policy checks.'),
      },
      async (input) => jsonText(await verifyExtensionRuntime(ENFYRA_API_URL, input)),
    );

  server.tool(
      'update_extension_code',
      [
        'Business operation: update an existing Enfyra admin extension code by id or name.',
        'It runs local extension guards and /enfyra_extension/preview first, saves only when validation succeeds, then re-reads and verifies the exact saved source in the same call.',
        'Use this instead of validate_extension_code followed by update_record when editing an existing page/widget/global extension.',
        'Call get_extension_theme_contract first when generating or reviewing UI.',
      ].join(' '),
      {
        id: z.union([z.string(), z.number()]).optional().describe('Existing extension id. Provide id or name.'),
        name: z.string().optional().describe('Existing extension unique name. Provide id or name.'),
        code: z.preprocess(normalizeEscapedVueSource, z.string()).describe('Vue SFC extension code. Raw source is preferred; a fully JSON-escaped one-line SFC is normalized for weak clients.'),
        description: z.string().optional().describe('Optional replacement extension description. Omit to preserve.'),
        isEnabled: z.boolean().optional().describe('Optional enabled state. Omit to preserve.'),
        version: z.string().optional().describe('Optional extension version. Omit to preserve.'),
        expectedSha256: z.string().optional().describe('Optional SHA-256 of current extension code. Rejects stale full replacements.'),
        uiPattern: z.enum(['resource_list', 'resource_grid', 'master_detail', 'form', 'custom']).optional().describe('Optional intended UI pattern. Enforces deterministic layout policy before saving.'),
        globalRulesAckKey: globalRulesAckParam(z),
        extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
      },
      async (input) => jsonText(await updateExtensionCode(ENFYRA_API_URL, input)),
    );

  server.tool(
      'patch_extension_code',
      [
        'Focused operation: patch an existing Enfyra admin extension code by exact search/replace.',
        'Use this for small UI fixes instead of rewriting the whole Vue SFC.',
        'For edits that temporarily unbalance Vue tags or slots, pass patches=[{search,replace},...] so all patches are applied in memory, then the final SFC is validated and saved atomically when apply=true.',
        'Default searchMode="exact"; use searchMode="whitespace" only when indentation/newline variation is the problem.',
        'Default replaceAll=false requires exactly one match; set replaceAll=true only after preview confirms the match count.',
        'It hash-checks the current code, validates with /enfyra_extension/preview, saves only when apply=true, then re-reads and verifies the exact saved source.',
        'Default apply=false returns a preview and nextStep input.',
      ].join(' '),
      {
        id: z.union([z.string(), z.number()]).optional().describe('Existing extension id. Provide id or name.'),
        name: z.string().optional().describe('Existing extension unique name. Provide id or name.'),
        search: z.string().optional().describe('Single-patch search fragment. Exact by default; JSON strings can contain \\n for multiline fragments. Omit when using patches.'),
        replace: z.string().optional().describe('Single-patch replacement code fragment. Required when search is provided. Omit when using patches.'),
        searchMode: z.enum(['exact', 'whitespace']).optional().default('exact').describe('Single-patch matching mode. exact is safest. whitespace treats each run of whitespace in search as flexible whitespace.'),
        replaceAll: z.boolean().optional().default(false).describe('Single-patch replace-all mode. false requires exactly one match; true replaces every match after previewing the count.'),
        patches: z.array(z.object({
          search: z.string().describe('Patch search fragment. JSON strings can contain \\n for multiline fragments.'),
          replace: z.string().describe('Patch replacement fragment.'),
          searchMode: z.enum(['exact', 'whitespace']).optional().default('exact').describe('Patch matching mode. Use whitespace only for indentation/newline variation.'),
          replaceAll: z.boolean().optional().default(false).describe('Patch replace-all mode. false requires exactly one match for this patch.'),
        })).optional().describe('Atomic multi-patch list. Patches apply sequentially in memory and only the final SFC is validated/saved when apply=true. Use this for slot/tag pairs that would be invalid as intermediate states.'),
        expectedSha256: z.string().optional().describe('SHA-256 of current extension code from preview/inspect. Required when apply=true and rejects stale patches.'),
        apply: z.boolean().optional().default(false).describe('Preview by default. Set true to validate and save.'),
        description: z.string().optional().describe('Optional replacement extension description. Omit to preserve.'),
        isEnabled: z.boolean().optional().describe('Optional enabled state. Omit to preserve.'),
        version: z.string().optional().describe('Optional extension version. Omit to preserve.'),
        uiPattern: z.enum(['resource_list', 'resource_grid', 'master_detail', 'form', 'custom']).optional().describe('Optional intended UI pattern. Enforces deterministic layout policy before saving.'),
        globalRulesAckKey: globalRulesAckParam(z),
        extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
      },
      async (input) => jsonText(await patchExtensionCode(ENFYRA_API_URL, input)),
    );

  server.tool(
      'get_extension_theme_contract',
      'Return the concise Enfyra admin extension UI/theme/security contract. Call before writing or reviewing extension UI.',
      {},
      async () => jsonText(getExtensionThemeContract()),
    );

  server.tool(
      'get_theme_class_reference',
      [
        'Return the authoritative Enfyra theme & color class reference: class -> CSS variable -> Nuxt UI semantic color -> intent.',
        'Call this whenever you need the exact eapp-* class name or the Nuxt UI color mapping for shell, system page, or dynamic extension UI.',
        'Source of truth: documents/app/theme-color-contract.md.',
      ].join(' '),
      {},
      async () => jsonText(getThemeClassReference()),
    );

  server.tool(
      'build_extension_ui',
      [
        'Lazy gateway for Enfyra admin extension UI builders.',
        'Use this after get_enfyra_required_knowledge(scope="extension") when a high-contract extension UI snippet is needed.',
        'It keeps guided startup small by dispatching drawer, modal, page_shell, permission_gate, empty_state, resource_list, resource_grid, form_editor, widget, menu_notification, account_panel_item, tabs, upload_modal, api_usage, notify, confirm, runtime_review, theme_classes, theme_review, or review internally instead of exposing every builder tool up front.',
      ].join(' '),
      {
        kind: z.enum([
          'drawer',
          'modal',
          'page_shell',
          'permission_gate',
          'empty_state',
          'resource_list',
          'resource_grid',
          'form_editor',
          'widget',
          'menu_notification',
          'account_panel_item',
          'tabs',
          'upload_modal',
          'api_usage',
          'notify',
          'confirm',
          'runtime_review',
          'theme_classes',
          'theme_review',
          'review',
        ]).describe('Which extension UI contract builder/reviewer to run.'),
        input: z.record(z.any()).optional().default({}).describe('Builder input object. For kind=api_usage, pass { path, resource, method? }; for kind=confirm, pass { resource, executeName?, refreshName?, recordName?, idExpression? }; for kind=notify, pass { kind, title, description? }. For kind=theme_classes, pass { intent }. For kind=runtime_review/theme_review/review, pass { code, pattern? }, where pattern may be resource_list or resource_grid for deterministic layout policy.'),
        extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
      },
      async ({ kind, input, extensionKnowledgeAckKey }) => {
        assertExtensionKnowledgeAck(extensionKnowledgeAckKey);
        return jsonText(buildExtensionUiSnippet(kind, input));
      },
    );

  server.tool(
      'build_extension_api_usage',
      [
        'Generate a contract-safe useApi snippet for Enfyra admin extensions.',
        'Use this instead of writing useApi calls from memory so route paths, execute({ id, body }), query/body objects, and mutation handlers follow the app composable contract.',
        'The tool returns code only; apply it with patch_extension_code or update_extension_code and then validate/save normally.',
      ].join(' '),
      {
        operation: z.enum(['list', 'find_one', 'create', 'update', 'delete', 'batch_update', 'batch_delete']).default('list').describe('API usage pattern to generate. Reads use the base route with query objects; mutations append ids through execute options.'),
        resource: z.string().default('items').describe('Resource variable base name, e.g. notes, projects, messages.'),
        path: z.string().optional().describe('Base API route path such as /notes. Do not include /:id; the builder strips a trailing /:id if provided.'),
        query: z.record(z.any()).optional().describe('Static Enfyra query object. Use this with sort for filter/page/limit reads; do not JSON.stringify it or put sort arrays inside it.'),
        queryExpression: z.string().optional().describe('Raw Vue expression for reactive query state. Do not JSON.stringify and do not use it to construct sort values; use structured sort instead.'),
        queryName: z.string().optional().describe('Variable name for the generated computed query when query is provided.'),
        sort: z.array(z.object({
          field: z.string().min(1).describe('Metadata field or supported aggregate sort expression.'),
          direction: z.enum(['asc', 'desc']).default('asc').describe('Enfyra sort direction.'),
        })).optional().describe('Structured sort order. The builder emits one Enfyra REST sort string, for example [{ field: "isPinned", direction: "desc" }, { field: "updatedAt", direction: "desc" }] becomes "-isPinned,-updatedAt".'),
        bodyExpression: z.string().optional().describe('Raw Vue expression for default body object/computed when useful. Do not JSON.stringify.'),
        errorContext: z.string().optional().describe('Safe error context label for useApi error reporting.'),
        responseName: z.string().optional().describe('Optional data ref variable name.'),
        pendingName: z.string().optional().describe('Optional pending ref variable name.'),
        errorName: z.string().optional().describe('Optional error ref variable name.'),
        executeName: z.string().optional().describe('Optional execute alias name.'),
        refreshName: z.string().optional().describe('Optional refresh alias name.'),
        rowsName: z.string().optional().describe('Optional computed rows variable for list/find_one operations.'),
        handlerName: z.string().optional().describe('Optional generated handler function name for mutations.'),
        recordName: z.string().optional().describe('Record parameter name for update/delete handlers.'),
        payloadName: z.string().optional().describe('Payload parameter name for create handlers.'),
        bodyName: z.string().optional().describe('Body parameter name for update/batch_update handlers.'),
        idsName: z.string().optional().describe('Ids parameter name for batch handlers.'),
        idExpression: z.string().optional().describe('Raw id expression for update/delete handlers. Defaults to record.id.'),
        autoLoad: z.boolean().optional().default(true).describe('For reads, generate onMounted(() => execute()).'),
        onErrorExpression: z.string().optional().describe('Raw onError handler expression when custom handling is needed.'),
        extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
      },
      async ({ extensionKnowledgeAckKey, ...input }) => {
        assertExtensionKnowledgeAck(extensionKnowledgeAckKey);
        return jsonText(buildExtensionApiUsageSnippet(input));
      },
    );

  server.tool(
      'build_extension_drawer',
      [
        'Generate a contract-safe CommonDrawer Vue snippet for Enfyra admin extensions.',
        'Use this before writing or patching drawer/editing workflows so the model does not have to remember CommonDrawer slots, footer action props, full-width fields, or button type rules.',
        'The tool returns code only; apply it with patch_extension_code or update_extension_code and then validate/save normally.',
      ].join(' '),
      {
        model: z.string().optional().default('drawerOpen').describe('Vue state variable used with v-model.'),
        title: z.string().optional().describe('Static drawer title.'),
        titleExpression: z.string().optional().describe('Raw Vue expression for a dynamic title.'),
        direction: z.enum(['right', 'left', 'top', 'bottom']).optional().default('right').describe('Drawer direction.'),
        nested: z.boolean().optional().default(false).describe('Set true when rendering a drawer inside another modal/drawer.'),
        body: z.string().describe('Vue template body content for #body. UInput/UTextarea/select controls are normalized to w-full; native buttons get type="button".'),
        cancelAction: z.union([extensionFooterActionSchema, z.literal(false)]).optional().describe('Cancel action object. Omit for a default Cancel that closes the model; false disables cancelAction.'),
        primaryAction: extensionFooterActionSchema.optional().describe('Primary action. Editing/create drawers should wire Save/Create here.'),
        dangerAction: extensionFooterActionSchema.optional().describe('Danger action. Destructive edit drawers should wire Delete here.'),
        footerHint: z.string().optional().describe('Optional footer hint text when supported by CommonDrawer.'),
      },
      async (input) => jsonText(buildExtensionDrawerSnippet(input)),
    );

  server.tool(
      'build_extension_modal',
      [
        'Generate a contract-safe CommonModal/UModal Vue snippet for Enfyra admin extensions.',
        'Use this before writing or patching confirmation/edit modals so the model does not have to remember v-model:open, slots, final action props, full-width fields, or button type rules.',
        'The tool returns code only; apply it with patch_extension_code or update_extension_code and then validate/save normally.',
      ].join(' '),
      {
        model: z.string().optional().default('modalOpen').describe('Vue state variable used with v-model:open.'),
        title: z.string().optional().describe('Static modal title.'),
        titleExpression: z.string().optional().describe('Raw Vue expression for a dynamic title.'),
        alias: z.enum(['CommonModal', 'UModal']).optional().default('CommonModal').describe('Use UModal only when preserving an existing UModal tag is useful; dynamic extensions resolve it to CommonModal.'),
        body: z.string().describe('Vue template body content for #body. UInput/UTextarea/select controls are normalized to w-full; native buttons get type="button".'),
        cancelAction: z.union([extensionFooterActionSchema, z.literal(false)]).optional().describe('Cancel action object. Omit for a default Cancel that closes the model; false disables cancelAction.'),
        primaryAction: extensionFooterActionSchema.optional().describe('Primary final action for non-destructive submit/confirm flows.'),
        dangerAction: extensionFooterActionSchema.optional().describe('Danger final action for destructive confirmation flows.'),
        footerHint: z.string().optional().describe('Optional footer hint text when supported by CommonModal.'),
      },
      async (input) => jsonText(buildExtensionModalSnippet(input)),
    );

  server.tool(
      'review_extension_ui_contract',
      [
        'Review an Enfyra extension Vue snippet for common modal/drawer contract mistakes.',
        'Use this before patching or saving generated extension UI when CommonDrawer, CommonModal, UModal, UInput, UTextarea, USelect, or native buttons are involved.',
        'This is a static contract review, not a compiler validation; still validate the final SFC before saving.',
      ].join(' '),
      {
        code: z.preprocess(normalizeEscapedVueSource, z.string()).describe('Vue SFC or template snippet to review.'),
      },
      async ({ code }) => jsonText(reviewExtensionUiContract(code)),
    );

  server.tool(
      'build_extension_page_shell',
      [
        'Generate page-header and shell-header-action script setup code for Enfyra page extensions.',
        'Use this so generated page extensions register shell chrome through usePageHeaderRegistry/useHeaderActionRegistry instead of rendering duplicate local headers.',
      ].join(' '),
      {
        title: z.string().optional().describe('Static page title.'),
        titleExpression: z.string().optional().describe('Raw Vue expression for a dynamic title.'),
        description: z.string().optional().describe('Optional page description.'),
        leadingIcon: z.string().optional().describe('Optional page header icon.'),
        gradient: z.enum(['none', 'purple', 'blue', 'cyan']).optional().default('none').describe('Generated operational extensions should usually use none.'),
        variant: z.enum(['default', 'minimal', 'stats-focus']).optional().default('minimal').describe('Page header variant.'),
        headerActions: z.array(extensionHeaderActionSchema).optional().describe('Optional shell header actions registered through useHeaderActionRegistry.'),
      },
      async (input) => jsonText(buildExtensionPageShellSnippet(input)),
    );

  server.tool(
      'build_extension_permission_gate',
      [
        'Generate a PermissionGate wrapper snippet for Enfyra admin extension UI.',
        'Use this when a visible button/block/list needs operator UX gating; backend route permissions and owner checks still remain authoritative.',
      ].join(' '),
      {
        route: z.string().optional().describe('API route path to gate against, e.g. /notes.'),
        methods: z.array(z.string()).optional().describe('HTTP methods for the route condition. Defaults to GET when route is provided.'),
        condition: z.string().optional().describe('Raw Vue permission condition expression. Overrides route/methods when provided.'),
        body: z.string().describe('Vue template content to render inside PermissionGate. Field controls are normalized to w-full.'),
      },
      async (input) => jsonText(buildExtensionPermissionGateSnippet(input)),
    );

  server.tool(
      'build_extension_empty_state',
      [
        'Generate an EmptyState snippet for Enfyra admin extensions.',
        'Use this for app-matched empty/error/no-results states instead of hand-rolled blank panels.',
      ].join(' '),
      {
        title: z.string().optional().describe('Empty state title.'),
        description: z.string().optional().describe('Empty state description.'),
        icon: z.string().optional().describe('Icon name. Defaults to lucide:inbox.'),
        size: z.enum(['sm', 'md', 'lg']).optional().default('sm').describe('Empty state size.'),
        variant: z.enum(['outline', 'naked', 'soft', 'subtle', 'solid']).optional().default('naked').describe('Use naked inside existing panels/lists.'),
        action: extensionFooterActionSchema.optional().describe('Optional primary empty-state action.'),
      },
      async (input) => jsonText(buildExtensionEmptyStateSnippet(input)),
    );

  server.tool(
      'build_extension_resource_list',
      [
        'Generate a CommonResourceListFrame/CommonResourceListItem snippet for Enfyra admin extensions.',
        'Use this for operational list pages so loading, empty state, pagination placement, row chrome, icons, stats, and row actions follow the app contract.',
      ].join(' '),
      {
        itemsExpression: z.string().optional().default('items').describe('Vue expression for the row array, e.g. notes.'),
        itemName: z.string().optional().default('item').describe('Loop variable name.'),
        keyExpression: z.string().optional().describe('Vue expression for :key. Defaults to item.id.'),
        titleExpression: z.string().optional().describe('Vue expression for item title. Defaults to item.title || "Untitled".'),
        descriptionExpression: z.string().optional().describe('Vue expression for item description. Defaults to item.description.'),
        icon: z.string().optional().describe('Static row icon when iconExpression is omitted.'),
        iconExpression: z.string().optional().describe('Vue expression for row icon.'),
        loadingExpression: z.string().optional().default('pending').describe('Vue expression for frame loading.'),
        totalExpression: z.string().optional().describe('Vue expression for total rows.'),
        itemsPerPageExpression: z.string().optional().describe('Vue expression for items per page; use 0 to hide pagination.'),
        statsExpression: z.string().optional().describe('Vue expression returning ResourceListStat[] for each row.'),
        actionsExpression: z.string().optional().describe('Vue expression returning ResourceListAction[] for each row.'),
        topBadgeExpression: z.string().optional().describe('Vue expression returning a ResourceListTopBadge for each row.'),
        onClick: z.string().optional().describe('Raw Vue expression called for row click, e.g. openEdit(item).'),
        emptyTitle: z.string().optional().describe('Empty title.'),
        emptyDescription: z.string().optional().describe('Empty description.'),
        emptyIcon: z.string().optional().describe('Empty icon.'),
      },
      async (input) => jsonText(buildExtensionResourceListSnippet(input)),
    );

  server.tool(
      'build_extension_resource_grid',
      [
        'Generate a constrained responsive CommonResourceListFrame card grid for Enfyra admin extensions.',
        'Use this for workboards, catalogs, dashboards, and other card collections so generated pages do not become full-width horizontal strips.',
        'The tool owns the page constraint, plain list-frame chrome, md/two-column and xl/three-column breakpoints, semantic card surface, loading/empty frame, and stable card height.',
      ].join(' '),
      {
        itemsExpression: z.string().optional().default('items').describe('Vue expression for the card array, e.g. notes.'),
        itemName: z.string().optional().default('item').describe('Loop variable name.'),
        keyExpression: z.string().optional().describe('Vue expression for :key. Defaults to item.id.'),
        cardBody: z.string().optional().describe('Card body Vue template. Defaults to semantic title/description. Fields and native buttons are normalized.'),
        loadingExpression: z.string().optional().default('pending').describe('Vue expression for frame loading.'),
        totalExpression: z.string().optional().describe('Vue expression for total cards.'),
        itemsPerPageExpression: z.string().optional().describe('Vue expression for items per page; use 0 to hide pagination.'),
        emptyTitle: z.string().optional().describe('Empty state title.'),
        emptyDescription: z.string().optional().describe('Empty state description.'),
        emptyIcon: z.string().optional().describe('Empty state icon.'),
        constrained: z.boolean().optional().default(true).describe('Wrap in eapp-page-constrained-wide. Disable only for intentional full-bleed surfaces.'),
      },
      async (input) => jsonText(buildExtensionResourceGridSnippet(input)),
    );

  server.tool(
      'build_extension_form_editor',
      [
        'Generate a FormEditor/FormEditorLazy snippet for Enfyra table-backed extension forms.',
        'Use this instead of hand-writing UInput/UTextarea fields when the form maps directly to a table record.',
      ].join(' '),
      {
        tableName: z.string().optional().describe('Static table name.'),
        tableNameExpression: z.string().optional().describe('Raw Vue expression for dynamic table name.'),
        model: z.string().optional().default('form').describe('Record state variable for v-model.'),
        errors: z.string().optional().default('errors').describe('Errors state variable for v-model:errors.'),
        mode: z.enum(['create', 'update']).optional().describe('Optional fixed form mode.'),
        loadingExpression: z.string().optional().describe('Raw Vue expression/ref for loading.'),
        layout: z.enum(['stack', 'grid']).optional().describe('Form layout.'),
        includes: z.array(z.string()).optional().describe('Fields to include. Prefer explicit includes for focused generated forms.'),
        excluded: z.array(z.string()).optional().describe('Fields to exclude. compiledCode is always excluded by FormEditor.'),
        sectionsExpression: z.string().optional().describe('Raw Vue expression for FormEditorSection[].'),
        fieldMapExpression: z.string().optional().describe('Raw Vue expression for fieldMap overrides.'),
        virtualFieldsExpression: z.string().optional().describe('Raw Vue expression for virtual fields.'),
        currentRecordIdExpression: z.string().optional().describe('Raw Vue expression for current record id.'),
        hasChangedHandler: z.string().optional().describe('Handler expression for @has-changed.'),
        virtualFieldEmitHandler: z.string().optional().describe('Handler expression for @virtual-field-emit.'),
        lazy: z.boolean().optional().default(true).describe('Use FormEditorLazy by default.'),
      },
      async (input) => jsonText(buildExtensionFormEditorSnippet(input)),
    );

  server.tool(
      'build_extension_widget',
      [
        'Generate a Widget snippet for reusing a widget extension inside an Enfyra page extension.',
        'Use this so agents pass numeric widget ids and keep prop/event ownership explicit.',
      ].join(' '),
      {
        id: z.union([z.number(), z.string()]).describe('Numeric enfyra_extension widget id. Strings are allowed but return a warning because names/extensionId are wrong for Widget.'),
        props: z.record(z.string()).optional().describe('Map of prop name to raw Vue expression.'),
        events: z.record(z.string()).optional().describe('Map of event name to handler expression.'),
      },
      async (input) => jsonText(buildExtensionWidgetSnippet(input)),
    );

  server.tool(
      'build_extension_menu_notification',
      [
        'Generate useMenuNotificationRegistry registration code for a global extension.',
        'Use this for sidebar menu count chips or dot notifications without mutating enfyra_menu records.',
      ].join(' '),
      {
        id: z.string().optional().describe('Stable notification id.'),
        targetId: z.union([z.string(), z.number()]).optional().describe('Target menu id.'),
        path: z.string().optional().describe('Target menu path.'),
        route: z.string().optional().describe('Target route path.'),
        value: z.union([z.string(), z.number()]).optional().describe('Static count/chip value. Omit with valueExpression for a dot.'),
        valueExpression: z.string().optional().describe('Raw Vue expression for count/chip value. Omit value for a dot-only notification.'),
        color: z.enum(['primary', 'success', 'warning', 'error', 'info', 'neutral']).optional().default('primary').describe('Chip/dot color intent.'),
        title: z.string().optional().describe('Optional tooltip/title.'),
        order: z.number().optional().describe('Sort order when multiple notifications target the same menu.'),
      },
      async (input) => jsonText(buildExtensionMenuNotificationSnippet(input)),
    );

  server.tool(
      'build_extension_account_panel_item',
      [
        'Generate useAccountPanelRegistry registration code for a global extension.',
        'Use this for data-driven account panel rows instead of drawing full custom sidebar/account UI.',
      ].join(' '),
      {
        id: z.string().optional().describe('Stable account panel item id.'),
        order: z.number().optional().describe('Display order.'),
        label: z.string().optional().describe('Row label.'),
        description: z.string().optional().describe('Row description.'),
        icon: z.string().optional().describe('Leading icon.'),
        count: z.union([z.string(), z.number()]).optional().describe('Static notification chip value.'),
        countExpression: z.string().optional().describe('Raw Vue expression for notification chip value.'),
        badge: z.union([z.string(), z.number()]).optional().describe('Legacy static badge value. Prefer count.'),
        badgeExpression: z.string().optional().describe('Raw Vue expression for badge. Prefer countExpression.'),
        badgeColor: z.enum(['primary', 'neutral', 'info', 'error', 'warning', 'success']).optional().describe('Chip color.'),
        trailingIcon: z.string().optional().describe('Trailing icon.'),
        expandedExpression: z.string().optional().describe('Raw Vue expression controlling expanded state.'),
        contentComponent: z.string().optional().describe('Raw component reference for inline expanded content.'),
        contentPropsExpression: z.string().optional().describe('Raw Vue expression for content props.'),
        onClick: z.string().optional().describe('Direct action handler expression.'),
        onToggle: z.string().optional().describe('Expandable row toggle handler expression.'),
      },
      async (input) => jsonText(buildExtensionAccountPanelSnippet(input)),
    );

  server.tool(
      'build_extension_tabs',
      [
        'Generate a UTabs snippet for Enfyra extension page sections.',
        'Use this instead of custom tab bars so app-wide tab chrome owns active indicators, focus rings, spacing, and theme contrast.',
      ].join(' '),
      {
        model: z.string().optional().default('activeTab').describe('Active tab model variable.'),
        itemsExpression: z.string().optional().default('tabs').describe('Raw Vue expression for tab items.'),
        body: z.string().optional().describe('Vue template body for #content="{ item }".'),
      },
      async (input) => jsonText(buildExtensionTabsSnippet(input)),
    );

  server.tool(
      'build_extension_upload_modal',
      [
        'Generate a CommonUploadModal snippet and upload-progress companion snippet for Enfyra extensions.',
        'Use this for file upload UI so progress, selected-file rows, and x-enfyra-upload-id wiring follow the app contract.',
      ].join(' '),
      {
        model: z.string().optional().default('showUploadModal').describe('Modal open state variable.'),
        title: z.string().optional().describe('Upload modal title.'),
        accept: z.string().optional().default('*/*').describe('Accepted mime/extensions.'),
        multiple: z.boolean().optional().default(true).describe('Allow multiple files.'),
        maxSizeExpression: z.string().optional().describe('Raw Vue expression for max file size.'),
        loadingExpression: z.string().optional().describe('Raw Vue expression/ref for upload pending state.'),
        uploadProgressExpression: z.string().optional().describe('Raw Vue expression/ref for aggregate upload progress.'),
        fileProgressExpression: z.string().optional().describe('Raw Vue expression for per-row progress map.'),
        dragText: z.string().optional().describe('Drag/drop text.'),
        acceptText: z.string().optional().describe('Accept/help text.'),
        uploadText: z.string().optional().describe('Upload action text.'),
        uploadingText: z.string().optional().describe('Uploading action text.'),
        uploadHandler: z.string().optional().default('handleUpload').describe('@upload handler expression.'),
        errorHandler: z.string().optional().describe('@error handler expression.'),
        headerContent: z.string().optional().describe('Optional #header-content template, e.g. storage selector. Fields are normalized to w-full.'),
      },
      async (input) => jsonText(buildExtensionUploadModalSnippet(input)),
    );

  server.tool(
      'extension_workflow',
      [
        'Step-by-step workflow for creating or updating Enfyra admin page, global, or widget extensions.',
        'Use this when an LLM is building extension UI, menu shell notifications, account panel entries, or page/menu wiring and should follow live nextSteps instead of guessing raw enfyra_extension mutations.',
        'With apply=false it validates code, reads live menu/extension state, and returns pending steps.',
        'With apply=true it applies exactly the next pending step. With applyAll=true it advances all currently safe pending steps.',
        'Call get_extension_theme_contract before generating or reviewing UI.',
      ].join(' '),
      {
        name: z.string().describe('Extension unique name.'),
        type: z.enum(['page', 'global', 'widget']).optional().default('page').describe('Extension type. Page extensions need a menu. Global extensions are for shell-wide registration.'),
        code: z.preprocess(normalizeEscapedVueSource, z.string()).describe('Vue SFC extension code. Raw source is preferred; a fully JSON-escaped one-line SFC is normalized for weak clients.'),
        menuId: z.union([z.string(), z.number()]).optional().describe('Existing menu id for a page extension. Provide this or menuLabel/menuPath.'),
        menuLabel: z.string().optional().describe('Menu label to create or update for a page extension when menuId is not provided.'),
        menuPath: z.string().optional().describe('Admin app route path for the page menu, e.g. /cloud/support.'),
        menuIcon: z.string().optional().describe('Optional menu icon name.'),
        menuType: z.enum(['Menu', 'Dropdown Menu']).optional().describe('Menu type. Omit to preserve an existing menu value or use the platform default for a new menu.'),
        menuOrder: z.number().optional().describe('Menu display order. Omit to preserve an existing menu value or use the platform default for a new menu.'),
        menuPermission: z.string().optional().describe('Optional menu permission JSON object. Omit for unrestricted menus; empty objects are normalized to null.'),
        menuDescription: z.string().optional().describe('Optional menu admin note.'),
        menuIsEnabled: z.boolean().optional().describe('Enable the menu. Omit to preserve an existing menu value or use the platform default for a new menu.'),
        description: z.string().optional().describe('Extension description.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
        version: z.string().optional().default('1.0.0').describe('Extension version.'),
        apply: z.boolean().optional().default(false).describe('false returns plan only; true applies exactly the next pending step. When true, always pass globalRulesAckKey; also pass knowledgeAckKey when saving handler sourceCode.'),
        applyAll: z.boolean().optional().default(false).describe('true applies all safe pending steps in order. Prefer apply=true for production changes. When true, always pass globalRulesAckKey and pass knowledgeAckKey if handler sourceCode may be saved.'),
        stepId: z.string().optional().describe('Optional pending step id to apply. Omit to apply the next pending step.'),
        globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when apply/applyAll mutates metadata. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
        extensionKnowledgeAckKey: extensionKnowledgeAckParam(z).optional().describe('Required when apply/applyAll saves extension code. Use extensionAckKey from get_enfyra_required_knowledge.'),
      },
      async (input) => jsonText(await runExtensionWorkflow(ENFYRA_API_URL, input)),
    );
}
