import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { fetchAPI } from '../dist/lib/fetch.js';
import {
  buildColumnDefinition,
  assertColumnContractBroadening,
  assertIndexesDoNotReferenceUniqueFields,
  buildPrimaryColumnForDbType,
  computeBatchCleanupOrder,
  fetchTableWithDetails,
  getSupportedColumnTypesFromMetadata,
  normalizeColumnsForLiveMetadata,
  normalizeColumnTypeForLiveMetadata,
  normalizeRelationForTablePatch,
  normalizeRelationType,
  registerTableTools,
  resolveTableIdentifierFromMetadata,
  resolveRelationTargetsFromMetadata,
  resolveTableFromMetadata,
  resolveTableFromMetadataByName,
  sanitizeExistingRelationForTablePatch,
} from '../dist/lib/table-tools.js';

import { prepareRecordBatchMutation, prepareRecordMutation, validatePortableScriptSource } from '../dist/lib/mutation-guards.js';
import { validateMainTableRoutePath } from '../dist/lib/route-guards.js';
import {
  DYNAMIC_CODE_KNOWLEDGE_ACK_KEY,
  GLOBAL_RULES_ACK_KEY,
  buildRequiredKnowledgePayload,
} from '../dist/lib/required-knowledge.js';
import { WORKFLOW_SURFACES, discoverWorkflowRoutes, listWorkflowSurfaces } from '../dist/lib/tool-routing.js';
import {
  findRoutePermission,
  mergeMethodNames,
  resolveRoleByNameOrId,
  routePermissionMatchesScope,
  summarizeRouteAccess,
  validateMethodsForRoute,
} from '../dist/lib/route-permission-tools.js';

test('column contract broadening requires explicit acknowledgement', () => {
  assert.throws(
    () => assertColumnContractBroadening(
      { isUpdatable: false, isPublished: false },
      { isUpdatable: true },
    ),
    /blocked in the guided toolset/,
  );
  assert.throws(
    () => assertColumnContractBroadening(
      { isUpdatable: false, isPublished: false },
      { isUpdatable: true, isPublished: true, allowContractBroadening: true },
    ),
    /blocked in the guided toolset/,
  );
  assert.deepEqual(
    assertColumnContractBroadening(
      { isUpdatable: false, isPublished: false },
      { isUpdatable: true, isPublished: true, allowContractBroadening: true },
      'full',
    ),
    ['isUpdatable false→true', 'isPublished false→true'],
  );
  assert.deepEqual(
    assertColumnContractBroadening(
      { isUpdatable: true, isPublished: true },
      { isUpdatable: false, isPublished: false },
    ),
    [],
  );
});

test('platform operation module imports cleanly', async () => {
  const module = await import('../dist/lib/platform-operation-tools.js');
  assert.equal(typeof module.registerPlatformOperationTools, 'function');
});

test('extension local validation rejects manual component resolution mistakes', async () => {
  const { validateExtensionCodeLocally } = await import('../dist/lib/platform-operation-tools.js');

  assert.deepEqual(
    validateExtensionCodeLocally('<template><UButton>Save</UButton></template>'),
    { vueSfcAst: 'passed', componentCasing: 'passed', fieldWidth: 'passed', themeContract: 'passed', runtimeContract: 'passed' },
  );
  assert.throws(
    () => validateExtensionCodeLocally('<template><UInput v-model="name" /></template>'),
    /must include class="w-full"/,
  );
  assert.deepEqual(
    validateExtensionCodeLocally('<template><UInput v-model="name" class="w-full" /></template>'),
    { vueSfcAst: 'passed', componentCasing: 'passed', fieldWidth: 'passed', themeContract: 'passed', runtimeContract: 'passed' },
  );
  assert.deepEqual(
    validateExtensionCodeLocally('<template><UInput v-model="name" data-compact /></template>'),
    { vueSfcAst: 'passed', componentCasing: 'passed', fieldWidth: 'passed', themeContract: 'passed', runtimeContract: 'passed' },
  );
  assert.throws(
    () => validateExtensionCodeLocally('<script setup>const query = { sort: ["isPinned:DESC", "updatedAt:DESC"] }</script>'),
    /Invalid extension sort contract/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<script setup>const query = { sort: "isPinned:DESC" }</script>'),
    /Invalid extension sort contract/,
  );
  assert.throws(
    () => validateExtensionCodeLocally([
      '<template><div /></template>',
      '<script setup>',
      "const UButton = resolveComponent('UButton')",
      '</script>',
    ].join('\n')),
    /do not call resolveComponent/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<template><ubutton>Save</ubutton></template>'),
    /use <UButton> instead of <ubutton>/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<template><section class="bg-violet-500">Bad</section></template>'),
    /Invalid extension theme contract/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<template><section class="text-[var(--text-primary)]">Bad</section></template>'),
    /Invalid extension theme contract/,
  );
  assert.deepEqual(
    validateExtensionCodeLocally('<template><section class="eapp-surface-card eapp-divider border"><p class="eapp-text-primary">Ok</p></section></template>'),
    { vueSfcAst: 'passed', componentCasing: 'passed', fieldWidth: 'passed', themeContract: 'passed', runtimeContract: 'passed' },
  );
  assert.throws(
    () => validateExtensionCodeLocally('<script setup>import { debounce } from "lodash-es"</script><template><div /></template>'),
    /Invalid extension runtime contract/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<script setup>const toast = useToast()</script><template><div /></template>'),
    /Invalid extension runtime contract/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<script setup>const notify = useNotify(); notify.add({ title: "Saved" })</script><template><div /></template>'),
    /Invalid extension runtime contract/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<script setup>const api = useApi("/notes", { query: JSON.stringify({ filter: { id: { _eq: 1 } } }) })</script><template><div /></template>'),
    /Invalid extension runtime contract/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<script setup>const { execute: loadNotes } = useApi("/notes")</script><template><div /></template>'),
    /execute alias loadNotes is never used/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<template><UModal v-model="open"><template #body>Body</template></UModal></template>'),
    /must bind v-model:open/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<template><CommonEmptyState title="No notes" /></template>'),
    /not registered in the dynamic extension runtime/,
  );
  assert.throws(
    () => validateExtensionCodeLocally('<script setup>const modalOpen = ref(false); const action = { onClick: () => (modalOpen = true) }</script><template><div /></template>'),
    /Assign modalOpen\.value/,
  );
  assert.deepEqual(
    validateExtensionCodeLocally('<script setup>const modalOpen = ref(false); const action = { onClick: () => (modalOpen.value = true) }; const { execute: loadNotes } = useApi("/notes"); onMounted(() => loadNotes())</script><template><CommonModal v-model:open="modalOpen" :cancel-action="{ label: \'Cancel\', onClick: () => (modalOpen = false) }"><template #body><EmptyState title="No notes" /></template></CommonModal></template>'),
    { vueSfcAst: 'passed', componentCasing: 'passed', fieldWidth: 'passed', themeContract: 'passed', runtimeContract: 'passed' },
  );
  assert.deepEqual(
    validateExtensionCodeLocally('<script setup>const notes = await useApi("/notes")</script><template><div /></template>'),
    { vueSfcAst: 'passed', componentCasing: 'passed', fieldWidth: 'passed', themeContract: 'passed', runtimeContract: 'passed' },
  );
});

test('extension patch helper supports atomic patches replaceAll and whitespace-flex search', async () => {
  const { applyExtensionCodePatches } = await import('../dist/lib/platform-operation-tools.js');

  const source = [
    '<template>',
    '  <CommonDrawer v-model="open">',
    '    <p>Loading</p>',
    '  </CommonDrawer>',
    '  <span class="chip">One</span>',
    '  <span class="chip">Two</span>',
    '</template>',
  ].join('\n');

  const atomic = applyExtensionCodePatches(source, {
    patches: [
      {
        search: '<CommonDrawer v-model="open">',
        replace: '<CommonDrawer v-model="open">\n    <template #body>',
      },
      {
        search: '    <p>Loading</p>',
        replace: '      <p>Loading</p>',
      },
      {
        search: '  </CommonDrawer>',
        replace: '    </template>\n  </CommonDrawer>',
      },
    ],
  });

  assert.match(atomic.code, /<template #body>/);
  assert.match(atomic.code, /<\/template>\n  <\/CommonDrawer>/);
  assert.equal(atomic.results.length, 3);

  const replaceAll = applyExtensionCodePatches(source, {
    search: 'class="chip"',
    replace: 'class="chip eapp-primary-soft"',
    replaceAll: true,
  });
  assert.equal(replaceAll.results[0].occurrences, 2);
  assert.equal((replaceAll.code.match(/eapp-primary-soft/g) || []).length, 2);

  const whitespace = applyExtensionCodePatches(source, {
    search: '<CommonDrawer v-model="open"> <p>Loading</p>',
    replace: '<CommonDrawer v-model="open">\n    <template #body>\n      <p>Loading</p>\n    </template>',
    searchMode: 'whitespace',
  });
  assert.match(whitespace.code, /<template #body>/);

  assert.throws(
    () => applyExtensionCodePatches(source, {
      search: 'class="chip"',
      replace: 'class="chip eapp-primary-soft"',
    }),
    /replaceAll=true/,
  );
});

test('extension component builders enforce drawer and modal contracts', async () => {
  const {
    buildExtensionDrawerSnippet,
    buildExtensionEmptyStateSnippet,
    buildExtensionApiUsageSnippet,
    buildExtensionConfirmSnippet,
    buildExtensionFormEditorSnippet,
    buildExtensionNotifySnippet,
    buildExtensionUiSnippet,
    buildExtensionAccountPanelSnippet,
    buildExtensionMenuNotificationSnippet,
    buildExtensionModalSnippet,
    buildExtensionPageShellSnippet,
    buildExtensionPermissionGateSnippet,
    buildExtensionResourceGridSnippet,
    buildExtensionResourceListSnippet,
    buildExtensionTabsSnippet,
    buildExtensionUploadModalSnippet,
    buildExtensionWidgetSnippet,
    reviewExtensionRuntimeContract,
    reviewExtensionThemeContract,
    reviewExtensionUiContract,
  } = await import('../dist/lib/platform-operation-tools.js');

  const drawer = buildExtensionDrawerSnippet({
    model: 'drawerOpen',
    titleExpression: "mode === 'create' ? 'New Note' : 'Edit Note'",
    body: [
      '<div>',
      '  <UInput v-model="form.title" placeholder="Title" />',
      '  <UTextarea v-model="form.content" :rows="6" />',
      '  <button @click="pickColor">Pick</button>',
      '</div>',
    ].join('\n'),
    primaryAction: {
      labelExpression: "mode === 'create' ? 'Create note' : 'Save note'",
      icon: 'lucide:save',
      loading: 'saving',
      disabled: 'saving',
      onClick: 'saveNote',
    },
    dangerAction: {
      label: 'Delete',
      icon: 'lucide:trash-2',
      loading: 'deleting',
      disabled: 'deleting',
      onClick: 'confirmDelete',
    },
    handleOnly: true,
  });

  assert.match(drawer.snippet, /<CommonDrawer/);
  assert.doesNotMatch(drawer.snippet, /handle-only/);
  assert.match(drawer.snippet, /<template #header>/);
  assert.match(drawer.snippet, /:primary-action="\{ label: mode === 'create' \? 'Create note' : 'Save note'/);
  assert.match(drawer.snippet, /:danger-action="\{ label: 'Delete'/);
  assert.match(drawer.snippet, /<UInput class="w-full" v-model="form\.title"/);
  assert.match(drawer.snippet, /<UTextarea class="w-full" v-model="form\.content"/);
  assert.match(drawer.snippet, /<button type="button" @click="pickColor">/);

  const lazyDrawer = buildExtensionUiSnippet('drawer', {
    model: 'drawerOpen',
    title: 'New Note',
    body: '<UInput v-model="form.title" />',
  });
  assert.equal(lazyDrawer.gateway, 'build_extension_ui');
  assert.equal(lazyDrawer.kind, 'drawer');
  assert.match(lazyDrawer.snippet, /<CommonDrawer/);
  assert.match(lazyDrawer.snippet, /<UInput class="w-full" v-model="form\.title"/);

  const modal = buildExtensionModalSnippet({
    model: 'deleteModalOpen',
    title: 'Delete Note',
    body: '<p>Are you sure? This cannot be undone.</p>',
    dangerAction: {
      label: 'Delete note',
      icon: 'lucide:trash-2',
      loading: 'deleting',
      disabled: 'deleting',
      onClick: 'deleteNote',
    },
  });
  assert.match(modal.snippet, /<CommonModal/);
  assert.match(modal.snippet, /v-model:open="deleteModalOpen"/);
  assert.match(modal.snippet, /:danger-action="\{ label: 'Delete note'/);

  const review = reviewExtensionUiContract([
    '<CommonDrawer v-model="open" :title="title">',
    '  <template #body>',
    '    <UInput v-model="name" />',
    '    <button @click="save">Save</button>',
    '  </template>',
    '</CommonDrawer>',
  ].join('\n'));
  assert.equal(review.valid, false);
  assert.match(JSON.stringify(review.issues), /common-drawer-slots/);
  assert.match(JSON.stringify(review.issues), /modal-drawer-field-width/);
  assert.match(JSON.stringify(review.issues), /native-button-type/);

  const lazyReview = buildExtensionUiSnippet('review', {
    code: '<template><CommonModal title="Bad"><UInput v-model="name" /></CommonModal></template>',
  });
  assert.equal(lazyReview.gateway, 'build_extension_ui');
  assert.equal(lazyReview.kind, 'review');
  assert.equal(lazyReview.valid, false);
  assert.equal(lazyReview.ui.valid, false);
  assert.equal(lazyReview.theme.valid, true);
  assert.equal(lazyReview.runtime.valid, true);

  const apiUsage = buildExtensionApiUsageSnippet({
    resource: 'notes',
    path: '/notes',
    queryExpression: 'notesQuery',
    errorContext: 'Load notes',
  });
  assert.match(apiUsage.snippet, /execute: loadNotes/);
  assert.match(apiUsage.snippet, /query: notesQuery/);
  assert.match(apiUsage.snippet, /onMounted\(\(\) => \{ loadNotes\(\); \}\)/);

  const sortedApiUsage = buildExtensionApiUsageSnippet({
    resource: 'notes',
    path: '/notes',
    query: {
      filter: { isArchived: { _eq: false } },
      limit: 100,
    },
    sort: [
      { field: 'isPinned', direction: 'desc' },
      { field: 'updatedAt', direction: 'desc' },
    ],
  });
  assert.match(sortedApiUsage.snippet, /const notesQuery = computed/);
  assert.match(sortedApiUsage.snippet, /"sort": "-isPinned,-updatedAt"/);
  assert.doesNotMatch(sortedApiUsage.snippet, /isPinned:DESC|sort: \[/);

  const updateApiUsage = buildExtensionApiUsageSnippet({
    operation: 'update',
    resource: 'notes',
    path: '/notes/:id',
    recordName: 'note',
  });
  assert.match(updateApiUsage.snippet, /useApi\('\/notes', \{/);
  assert.match(updateApiUsage.snippet, /method: 'PATCH'/);
  assert.match(updateApiUsage.snippet, /await updateNotesApi\(\{ id: note\.id, body \}\)/);
  assert.doesNotMatch(updateApiUsage.snippet, /:id/);

  const deleteApiUsage = buildExtensionApiUsageSnippet({
    operation: 'delete',
    resource: 'notes',
    path: '/notes',
    recordName: 'note',
  });
  assert.match(deleteApiUsage.snippet, /method: 'DELETE'/);
  assert.match(deleteApiUsage.snippet, /await deleteNotesApi\(\{ id: note\.id \}\)/);

  const notifyUsage = buildExtensionNotifySnippet({
    kind: 'success',
    title: 'Saved',
    description: 'Changes were applied.',
  });
  assert.match(notifyUsage.snippet, /const notify = useNotify\(\)/);
  assert.match(notifyUsage.snippet, /await notify\.success\('Saved', 'Changes were applied\.'\)/);

  const confirmUsage = buildExtensionConfirmSnippet({
    resource: 'notes',
    executeName: 'deleteNoteApi',
    refreshName: 'refreshNotes',
    recordName: 'note',
  });
  assert.match(confirmUsage.snippet, /const \{ confirm \} = useConfirm\(\)/);
  assert.match(confirmUsage.snippet, /const confirmed = await confirm/);
  assert.match(confirmUsage.snippet, /await deleteNoteApi\(\{ id: note\.id \}\)/);
  assert.match(confirmUsage.snippet, /await refreshNotes\(\)/);

  const runtimeReview = reviewExtensionRuntimeContract('<script setup>const notify = useNotify(); notify.add({ title: "Saved" })</script><template><div /></template>');
  assert.equal(runtimeReview.valid, false);
  assert.match(JSON.stringify(runtimeReview.issues), /use-notify-add/);

  const browserDialogReview = reviewExtensionRuntimeContract('<script setup>window.confirm("Delete?")</script><template><div /></template>');
  assert.equal(browserDialogReview.valid, false);
  assert.match(JSON.stringify(browserDialogReview.issues), /browser-dialog/);

  const lazyApiUsage = buildExtensionUiSnippet('api_usage', {
    resource: 'notes',
    path: '/notes',
  });
  assert.equal(lazyApiUsage.gateway, 'build_extension_ui');
  assert.equal(lazyApiUsage.kind, 'api_usage');
  assert.match(lazyApiUsage.snippet, /useApi\('\/notes'\)/);

  const lazyNotify = buildExtensionUiSnippet('notify', {
    kind: 'error',
    title: 'Save failed',
  });
  assert.equal(lazyNotify.gateway, 'build_extension_ui');
  assert.equal(lazyNotify.kind, 'notify');
  assert.match(lazyNotify.snippet, /await notify\.error\('Save failed'\)/);

  const lazyConfirm = buildExtensionUiSnippet('confirm', {
    resource: 'notes',
    executeName: 'deleteNoteApi',
  });
  assert.equal(lazyConfirm.gateway, 'build_extension_ui');
  assert.equal(lazyConfirm.kind, 'confirm');
  assert.match(lazyConfirm.snippet, /useConfirm\(\)/);

  const lazyRuntimeReview = buildExtensionUiSnippet('runtime_review', {
    code: '<script setup>const api = useApi("/notes", { query: JSON.stringify({ page: 1 }) })</script><template><div /></template>',
  });
  assert.equal(lazyRuntimeReview.gateway, 'build_extension_ui');
  assert.equal(lazyRuntimeReview.kind, 'runtime_review');
  assert.equal(lazyRuntimeReview.valid, false);
  assert.match(JSON.stringify(lazyRuntimeReview.issues), /use-api-json-stringify-options/);

  const themeClasses = buildExtensionUiSnippet('theme_classes', {
    intent: 'primary_identity',
  });
  assert.equal(themeClasses.gateway, 'build_extension_ui');
  assert.equal(themeClasses.kind, 'theme_classes');
  assert.match(themeClasses.contract.classes, /eapp-primary-surface/);

  const themeReview = reviewExtensionThemeContract('<template><section class="bg-violet-500">Bad</section></template>');
  assert.equal(themeReview.valid, false);
  assert.match(JSON.stringify(themeReview.issues), /hardcoded-tailwind-palette/);

  const lazyThemeReview = buildExtensionUiSnippet('theme_review', {
    code: '<template><section class="text-[var(--text-primary)]">Bad</section></template>',
  });
  assert.equal(lazyThemeReview.gateway, 'build_extension_ui');
  assert.equal(lazyThemeReview.kind, 'theme_review');
  assert.equal(lazyThemeReview.valid, false);
  assert.match(JSON.stringify(lazyThemeReview.issues), /raw-css-var-utility/);

  const pageShell = buildExtensionPageShellSnippet({
    title: 'Notes',
    description: 'Capture ideas',
    leadingIcon: 'lucide:sticky-note',
    headerActions: [{
      id: 'new-note',
      label: 'New Note',
      icon: 'lucide:plus',
      color: 'primary',
      variant: 'solid',
      onClick: 'openCreate',
      order: 10,
    }],
  });
  assert.match(pageShell.snippet, /usePageHeaderRegistry/);
  assert.match(pageShell.snippet, /useHeaderActionRegistry/);
  assert.match(pageShell.snippet, /registerHeaderActions/);
  assert.match(pageShell.snippet, /onMounted\(\(\) => \{\n  registerHeaderActions\(/);
  assert.throws(
    () => buildExtensionPageShellSnippet({
      title: 'Bad action',
      headerActions: [{ id: 'open', label: 'Open', onClick: '() => (modalOpen = true)' }],
    }),
    /modalOpen\.value/,
  );

  const gate = buildExtensionPermissionGateSnippet({
    route: '/notes',
    methods: ['POST'],
    body: '<UInput v-model="name" />',
  });
  assert.match(gate.snippet, /<PermissionGate :condition="\{ or: \[\{ route: '\/notes', methods: \['POST'\] \}\] \}">/);
  assert.match(gate.snippet, /<UInput class="w-full" v-model="name"/);

  const empty = buildExtensionEmptyStateSnippet({
    title: 'No notes',
    description: 'Create the first note.',
    icon: 'lucide:sticky-note',
  });
  assert.equal(empty.component, 'EmptyState');
  assert.match(empty.snippet, /<EmptyState/);
  assert.match(empty.snippet, /variant="naked"/);

  const list = buildExtensionResourceListSnippet({
    itemsExpression: 'notes',
    itemName: 'note',
    titleExpression: "note.title || 'Untitled'",
    descriptionExpression: 'note.content',
    onClick: 'openEdit(note)',
    emptyTitle: 'No notes yet',
  });
  assert.match(list.snippet, /<CommonResourceListFrame/);
  assert.match(list.snippet, /<CommonResourceListItem/);
  assert.match(list.snippet, /v-for="note in notes"/);

  const grid = buildExtensionResourceGridSnippet({
    itemsExpression: 'notes',
    itemName: 'note',
    cardBody: '<h2>{{ note.title }}</h2><UButton @click="openEdit(note)">Edit</UButton>',
    emptyTitle: 'No notes yet',
  });
  assert.equal(grid.component, 'CommonResourceListFrame');
  assert.match(grid.snippet, /eapp-page-constrained-wide/);
  assert.match(grid.snippet, /variant="plain"/);
  assert.match(grid.snippet, /grid gap-4 md:grid-cols-2 xl:grid-cols-3/);
  assert.match(grid.snippet, /v-for="note in notes"/);
  assert.match(grid.snippet, /<UButton @click="openEdit\(note\)">/);

  const formEditor = buildExtensionFormEditorSnippet({
    tableName: 'notes',
    model: 'form',
    errors: 'errors',
    includes: ['title', 'content', 'color'],
    fieldMapExpression: 'noteFieldMap',
    hasChangedHandler: '(changed) => (hasFormChanges = changed)',
  });
  assert.match(formEditor.snippet, /<FormEditorLazy/);
  assert.match(formEditor.snippet, /v-model="form"/);
  assert.match(formEditor.snippet, /v-model:errors="errors"/);
  assert.match(formEditor.snippet, /:includes="\['title', 'content', 'color'\]"/);

  const widget = buildExtensionWidgetSnippet({
    id: 42,
    props: { rows: 'noteRows' },
    events: { refresh: 'loadNotes' },
  });
  assert.match(widget.snippet, /<Widget :id="42" :rows="noteRows" @refresh="loadNotes" \/>/);

  const menuNotification = buildExtensionMenuNotificationSnippet({
    id: 'notes-attention',
    path: '/notes',
    valueExpression: 'unreadCount',
    color: 'primary',
  });
  assert.match(menuNotification.snippet, /useMenuNotificationRegistry/);
  assert.match(menuNotification.snippet, /value: unreadCount/);

  const accountPanel = buildExtensionAccountPanelSnippet({
    id: 'notes-account',
    label: 'Notes',
    icon: 'lucide:sticky-note',
    countExpression: 'draftCount',
    onClick: "() => navigateTo('/notes')",
  });
  assert.match(accountPanel.snippet, /useAccountPanelRegistry/);
  assert.match(accountPanel.snippet, /count: draftCount/);

  const tabs = buildExtensionTabsSnippet({
    model: 'activeTab',
    itemsExpression: 'tabs',
    body: '<div>{{ item.label }}</div>',
  });
  assert.match(tabs.snippet, /<UTabs v-model="activeTab" :items="tabs" class="w-full">/);
  assert.match(tabs.snippet, /<template #content="\{ item \}">/);

  const upload = buildExtensionUploadModalSnippet({
    model: 'showUploadModal',
    loadingExpression: 'uploadPending',
    uploadProgressExpression: 'uploadProgress',
    fileProgressExpression: 'fileProgressByIndex',
    headerContent: '<USelectMenu v-model="selectedStorage" :items="storageOptions" />',
  });
  assert.match(upload.snippet, /<CommonUploadModal/);
  assert.match(upload.snippet, /:upload-progress="uploadProgress"/);
  assert.match(upload.snippet, /<USelectMenu class="w-full" v-model="selectedStorage"/);
  assert.match(upload.companionSnippet, /useFileUploadProgress/);
});

test('dynamic script guard accepts secure explicit-table repositories', () => {
  assert.doesNotThrow(
    () => validatePortableScriptSource('const row = await @REPOS.secure.orders.find({ fields: ["id"], filter: {} })'),
  );
  assert.doesNotThrow(
    () => validatePortableScriptSource('const row = await #secure.orders.find({ fields: ["id"], filter: {} })'),
  );
  assert.doesNotThrow(
    () => validatePortableScriptSource('const row = await #orders.find({ fields: ["id"], filter: {} })'),
  );
});

test('dynamic script guard requires awaiting repository calls', () => {
  assert.throws(
    () => validatePortableScriptSource('const result = #orders.find({ fields: ["id"], limit: 10 })'),
    /Dynamic repository calls are async/,
  );
  assert.throws(
    () => validatePortableScriptSource('const created = @REPOS.orders.create({ data: @BODY })'),
    /Dynamic repository calls are async/,
  );
  assert.doesNotThrow(
    () => validatePortableScriptSource('const result = await #orders.find({ fields: ["id"], limit: 10 })\nreturn result.data || []'),
  );
});

test('dynamic script guard locks numeric throw helper details contract', () => {
  assert.doesNotThrow(
    () => validatePortableScriptSource('if (!request) @THROW404("Request not found")'),
  );
  assert.doesNotThrow(
    () => validatePortableScriptSource('if (!request) @THROW404("Request not found", { requestId })'),
  );
  assert.doesNotThrow(
    () => validatePortableScriptSource('if (!request) $ctx.$throw["404"]("Request not found", { requestId })'),
  );
  assert.doesNotThrow(
    () => validatePortableScriptSource('if (!request) @THROW.notFound("Request", requestId)'),
  );
  assert.doesNotThrow(
    () => validatePortableScriptSource('if (exists) @THROW.duplicate("User", "email", email)'),
  );

  for (const source of [
    'if (!project) @THROW404("Project", projectId)',
    'if (!project) @THROW404("Project", "p_123")',
    'if (exists) @THROW409("User", email)',
    'if (!project) $ctx.$throw["404"]("Project", projectId)',
    'if (!valid) $ctx.$throw[\'422\']("Invalid value", "email")',
  ]) {
    assert.throws(
      () => validatePortableScriptSource(source),
      /Numeric @THROW helpers are raw HTTP message helpers/,
    );
  }
});

test('workflow routing gives progressive tool plans and negative boundaries', () => {
  assert.ok(WORKFLOW_SURFACES.includes('extension'));
  assert.ok(WORKFLOW_SURFACES.includes('api-endpoint'));
  assert.ok(WORKFLOW_SURFACES.includes('storage-file'));
  assert.ok(WORKFLOW_SURFACES.includes('identity-access'));
  assert.ok(WORKFLOW_SURFACES.includes('platform-config'));
  assert.ok(listWorkflowSurfaces().length >= 10);

  const extension = discoverWorkflowRoutes({
    intent: 'support ticket menu chip should notify without fetching the ticket list',
    surface: 'extension',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(extension.key, 'extension');
  assert.ok(extension.primaryPath.some((step) => step.tool === 'get_extension_theme_contract'));
  assert.ok(extension.primaryPath.some((step) => step.tool === 'search_admin_extensions'));
  assert.ok(extension.requiredAck.includes('extensionAckKey when saving extension code'));
  assert.ok(extension.primaryPath.some((step) => step.tool === 'extension_workflow or patch_extension_code/update_extension_code'));
  assert.ok(extension.advancedTools.includes('reorder_menus'));
  assert.ok(extension.advancedTools.includes('ensure_global_extension'));
  assert.ok(extension.verifyPath.some((step) => step.tool === 'verify_extension_runtime'));
  assert.match(JSON.stringify(extension.avoidTools), /destination domain lists/);
  assert.match(JSON.stringify(extension.avoidTools), /destination-page fetch on click/);

  const endpoint = discoverWorkflowRoutes({
    intent: 'create authenticated REST endpoint with a handler and route permission',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(endpoint.key, 'api-endpoint');
  assert.ok(endpoint.primaryPath.some((step) => step.tool === 'api_endpoint_workflow'));
  assert.match(JSON.stringify(endpoint.avoidTools), /create_route/);

  const thirdPartyPolicy = discoverWorkflowRoutes({
    intent: 'expose orders to a third-party app with endpoint-specific owner policy',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(thirdPartyPolicy.key, 'api-endpoint');
  assert.match(JSON.stringify(thirdPartyPolicy.primaryPath), /api_endpoint_workflow/);

  const canonicalPolicy = discoverWorkflowRoutes({
    intent: 'add owner tenant RLS to canonical orders CRUD',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(canonicalPolicy.key, 'guards-permissions-rules');
  assert.match(JSON.stringify(canonicalPolicy.primaryPath), /create_pre_hook/);

  const flow = discoverWorkflowRoutes({
    intent: 'add a provisioning flow step that queries then updates a record',
    surface: 'flow',
    risk: 'write',
    detail: 'plan',
	  }).workflows[0];
	  assert.equal(flow.key, 'flow');
	  assert.ok(flow.primaryPath.some((step) => step.tool === 'flow_workflow'));
	  assert.match(JSON.stringify(flow.avoidTools), /ensure_script_flow_step/);

  const flowSourcePatch = discoverWorkflowRoutes({
    intent: 'patch existing flow step source and avoid compiledCode',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(flowSourcePatch.key, 'dynamic-script');
  assert.ok(flowSourcePatch.primaryPath.some((step) => step.tool === 'get_script_source'));
  assert.ok(flowSourcePatch.primaryPath.some((step) => step.tool === 'patch_script_source or update_script_source'));

  const schema = discoverWorkflowRoutes({
    intent: 'create a multi table app schema with columns relations and sample records',
    surface: 'schema',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(schema.key, 'schema');
  assert.ok(schema.primaryPath.some((step) => step.tool === 'get_schema_design_context'));
  assert.match(JSON.stringify(schema.primaryPath), /live column types/);
  assert.ok(schema.escapeHatches.includes('get_table_metadata'));

  const cache = discoverWorkflowRoutes({
    intent: 'metadata looks stale after a table change',
    surface: 'cache',
    risk: 'write',
    detail: 'plan',
  }).workflows[0];
  assert.equal(cache.key, 'cache');
  assert.match(JSON.stringify(cache.avoidTools), /Manual reloads should be evidence-driven/);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createToolHarness() {
  const tools = new Map();
  return {
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
    get(name) {
      const tool = tools.get(name);
      assert.ok(tool, `Expected tool ${name} to be registered`);
      return tool;
    },
  };
}

test('fetchTableWithDetails reads full columns from metadata instead of enfyra_table nested fields', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const metadataColumns = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    name: `field_${index + 1}`,
    type: 'varchar',
  }));

  global.fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).includes('/enfyra_table?')) {
      return jsonResponse({
        data: [{
          id: 79,
          name: 'cloud_projects',
        }],
      });
    }
    if (String(url).endsWith('/metadata/cloud_projects')) {
      return jsonResponse({
        data: {
          id: 79,
          name: 'cloud_projects',
          columns: metadataColumns,
          relations: [{ id: 5, propertyName: 'owner' }],
        },
      });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    const table = await fetchTableWithDetails('https://example.test/api', 79);

    assert.equal(table.columns.length, 12);
    assert.equal(table.relations.length, 1);
    assert.equal(table.columns[11].name, 'field_12');
    assert.equal(calls.some((url) => url.includes('columns.*')), false);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('resolveTableFromMetadata supports array and keyed metadata shapes', () => {
  assert.equal(resolveTableFromMetadata({ data: { tables: [{ id: 1, name: 'a' }] } }, '1')?.name, 'a');
  assert.equal(resolveTableFromMetadata({ tables: { b: { id: 2, name: 'b' } } }, 2)?.name, 'b');
});

test('fetchTableWithDetails falls back to metadata table name when metadata id is malformed', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).includes('/enfyra_table?')) {
      return jsonResponse({
        data: [{
          id: 1,
          name: 'enfyra_column',
        }],
      });
    }
    if (String(url).endsWith('/metadata/enfyra_column')) {
      return jsonResponse({
        data: {
          id: true,
          name: 'enfyra_column',
          columns: [{ id: 3, name: 'type', type: 'enum' }],
          relations: [],
        },
      });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    const table = await fetchTableWithDetails('https://example.test/api', 1);

    assert.equal(table.name, 'enfyra_column');
    assert.equal(table.columns[0].name, 'type');
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('resolveTableFromMetadataByName supports table name and alias', () => {
  const metadata = { data: { tables: [{ id: true, name: 'enfyra_column' }, { id: 2, alias: 'Posts' }] } };
  assert.equal(resolveTableFromMetadataByName(metadata, 'enfyra_column')?.id, true);
  assert.equal(resolveTableFromMetadataByName(metadata, 'Posts')?.id, 2);
});

test('resolveTableIdentifierFromMetadata supports ids, names, and aliases', () => {
  const metadata = { data: { tables: [{ id: 4, name: 'enfyra_user' }, { id: 9, name: 'post', alias: 'Posts' }] } };

  assert.equal(resolveTableIdentifierFromMetadata(metadata, 4), 4);
  assert.equal(resolveTableIdentifierFromMetadata(metadata, 'post'), 9);
  assert.equal(resolveTableIdentifierFromMetadata(metadata, 'Posts'), 9);
  assert.throws(
    () => resolveTableIdentifierFromMetadata(metadata, 'missing_table', 'targetTableId'),
    /targetTableId "missing_table" was not found/
  );
});

test('schema constraint validation rejects indexes that include unique fields', () => {
  assert.throws(
    () =>
      assertIndexesDoNotReferenceUniqueFields(
        [['is_active', 'version']],
        [['version'], ['docker_image']],
      ),
    /indexes must not include fields that appear in uniques, including composite unique groups/,
  );
  assert.throws(
    () =>
      assertIndexesDoNotReferenceUniqueFields(
        [['status', 'scheduled_start']],
        [['patient', 'scheduled_start']],
      ),
    /\["status","scheduled_start"\] overlaps unique group\(s\) \["patient","scheduled_start"\] via \["scheduled_start"\]/,
  );

  assert.doesNotThrow(() =>
    assertIndexesDoNotReferenceUniqueFields(
      [['is_active', 'sort_order']],
      [['version'], ['docker_image']],
    ),
  );
});

test('column type guidance uses live metadata and normalizes common SQL aliases', () => {
  const metadata = {
    data: {
      tables: [{
        name: 'enfyra_column',
        columns: [{ name: 'type', type: 'enum', options: '{"int","varchar","text","boolean","datetime","simple-json","float"}' }],
      }],
    },
  };
  const supportedTypes = getSupportedColumnTypesFromMetadata(metadata);

  assert.deepEqual(supportedTypes, ['int', 'varchar', 'text', 'boolean', 'datetime', 'simple-json', 'float']);
  assert.deepEqual(
    normalizeColumnTypeForLiveMetadata('decimal', supportedTypes),
    { type: 'float', changed: true, originalType: 'decimal' },
  );
  assert.deepEqual(
    normalizeColumnTypeForLiveMetadata('longtext', supportedTypes),
    { type: 'text', changed: true, originalType: 'longtext' },
  );
  assert.deepEqual(
    normalizeColumnTypeForLiveMetadata('json', supportedTypes),
    { type: 'simple-json', changed: true, originalType: 'json' },
  );
  assert.deepEqual(
    normalizeColumnsForLiveMetadata([
      { name: 'price', type: 'decimal' },
      { name: 'metadata', type: 'jsonb' },
    ], supportedTypes),
    {
      columns: [
        { name: 'price', type: 'float' },
        { name: 'metadata', type: 'simple-json' },
      ],
      normalizations: [
        { column: 'price', from: 'decimal', to: 'float' },
        { column: 'metadata', from: 'jsonb', to: 'simple-json' },
      ],
    },
  );
  assert.throws(
    () => normalizeColumnTypeForLiveMetadata('geometry', supportedTypes),
    /Valid live types: int, varchar, text, boolean, datetime, simple-json, float/,
  );
});

test('resolveRelationTargetsFromMetadata converts table names to ids before schema mutation', () => {
  const metadata = { data: { tables: [{ id: 4, name: 'enfyra_user' }, { id: 9, name: 'post' }] } };
  assert.deepEqual(
    resolveRelationTargetsFromMetadata(metadata, [
      { propertyName: 'owner', type: 'many-to-one', targetTable: 'enfyra_user' },
      { propertyName: 'post', type: 'many-to-one', targetTable: { id: 9 } },
      { propertyName: 'external', type: 'many-to-one', targetTable: '64f011111111111111111111' },
    ]),
    [
      { propertyName: 'owner', type: 'many-to-one', targetTable: 4 },
      { propertyName: 'post', type: 'many-to-one', targetTable: { id: 9 } },
      { propertyName: 'external', type: 'many-to-one', targetTable: '64f011111111111111111111' },
    ]
  );
});

test('encrypted column definitions preserve explicit updatable contract', () => {
  assert.deepEqual(
    buildColumnDefinition({
      name: 'api_key',
      type: 'varchar',
      isEncrypted: true,
      isUpdatable: true,
      isPublished: false,
    }),
    {
      name: 'api_key',
      type: 'varchar',
      isNullable: true,
      isPrimary: false,
      isGenerated: false,
      isSystem: false,
      isPublished: false,
      isUpdatable: true,
      isEncrypted: true,
    }
  );

  assert.deepEqual(
    buildColumnDefinition({
      name: 'secret_key',
      type: 'varchar',
      isEncrypted: true,
      isUpdatable: false,
    }),
    {
      name: 'secret_key',
      type: 'varchar',
      isNullable: true,
      isPrimary: false,
      isGenerated: false,
      isSystem: false,
      isPublished: true,
      isEncrypted: true,
      isUpdatable: false,
    }
  );
});

test('new column definitions include system-table validation defaults', () => {
  assert.deepEqual(
    buildColumnDefinition({
      name: 'tenant_cpu_shares',
      type: 'int',
    }),
    {
      name: 'tenant_cpu_shares',
      type: 'int',
      isNullable: true,
      isPrimary: false,
      isGenerated: false,
      isSystem: false,
      isPublished: true,
      isUpdatable: true,
      isEncrypted: false,
    }
  );
});

test('primary column definition follows metadata dbType without pkField', () => {
  assert.deepEqual(buildPrimaryColumnForDbType('postgres'), {
    name: 'id',
    type: 'int',
    isPrimary: true,
    isGenerated: true,
    isNullable: false,
  });
  assert.deepEqual(buildPrimaryColumnForDbType('mongodb'), {
    name: '_id',
    type: 'ObjectId',
    isPrimary: true,
    isGenerated: true,
    isNullable: false,
  });
});

test('fetchAPI exchanges ENFYRA_API_TOKEN before authenticated requests', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || [] });
    if (String(url).endsWith('/auth/token/exchange')) {
      assert.equal(JSON.parse(init.body).apiToken, 'efy_pat_test');
      return jsonResponse({ accessToken: 'jwt-access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).endsWith('/me')) {
      const authHeader = Array.isArray(init.headers)
        ? init.headers.find(([key]) => key === 'Authorization')?.[1]
        : init.headers?.Authorization;
      assert.equal(authHeader, 'Bearer jwt-access-token');
      assert.notEqual(authHeader, 'Bearer efy_pat_test');
      return jsonResponse({ data: [{ id: 1 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const result = await fetchAPI('https://example.test/api', '/me');

    assert.deepEqual(result, { data: [{ id: 1 }] });
    assert.equal(calls[0].url, 'https://example.test/api/auth/token/exchange');
    assert.equal(calls[1].url, 'https://example.test/api/me');
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('fetchAPI caches reloadable control-plane GET responses and clears their domain after a mutation', async () => {
  const { clearRuntimeCache } = await import('../dist/lib/runtime-cache.js');
  const originalFetch = global.fetch;
  let metadataReads = 0;

  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'jwt-cache', expTime: Date.now() + 60_000 });
    }
    if (String(url).includes('/enfyra_flow') && String(init.method || 'GET').toUpperCase() === 'GET') {
      metadataReads += 1;
      return jsonResponse({ data: [{ name: 'cloud_projects' }] });
    }
    if (String(url).endsWith('/enfyra_flow')) return jsonResponse({ success: true });
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    clearRuntimeCache();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');

    await fetchAPI('https://example.test/api', '/enfyra_flow?limit=1');
    await fetchAPI('https://example.test/api', '/enfyra_flow?limit=1');
    assert.equal(metadataReads, 1);

    await fetchAPI('https://example.test/api', '/enfyra_flow', { method: 'POST', body: '{}' });
    await fetchAPI('https://example.test/api', '/enfyra_flow?limit=1');
    assert.equal(metadataReads, 2);
  } finally {
    clearRuntimeCache();
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('fetchAPI retries once after stale exchanged token is rejected', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let exchangeCount = 0;

  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || [] });
    if (String(url).endsWith('/auth/token/exchange')) {
      exchangeCount += 1;
      return jsonResponse({ accessToken: `jwt-${exchangeCount}`, expTime: Date.now() + 60_000 });
    }
    if (String(url).endsWith('/me')) {
      const authHeader = Array.isArray(init.headers)
        ? init.headers.find(([key]) => key === 'Authorization')?.[1]
        : init.headers?.Authorization;
      if (authHeader === 'Bearer jwt-1') {
        return jsonResponse({ message: 'expired' }, 401);
      }
      assert.equal(authHeader, 'Bearer jwt-2');
      return jsonResponse({ data: [{ id: 1 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');
    const result = await fetchAPI('https://example.test/api', '/me');

    assert.deepEqual(result, { data: [{ id: 1 }] });
    assert.equal(exchangeCount, 2);
    assert.equal(calls.filter((call) => call.url.endsWith('/me')).length, 2);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('fetchAPI refreshes short-lived exchanged tokens before expiry', async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const calls = [];
  let now = Date.parse('2026-06-22T12:00:00.000Z');
  let exchangeCount = 0;

  Date.now = () => now;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || [] });
    if (String(url).endsWith('/auth/token/exchange')) {
      exchangeCount += 1;
      return jsonResponse({ accessToken: `jwt-${exchangeCount}`, expTime: now + 60_000 });
    }
    if (String(url).endsWith('/me')) {
      const authHeader = Array.isArray(init.headers)
        ? init.headers.find(([key]) => key === 'Authorization')?.[1]
        : init.headers?.Authorization;
      return jsonResponse({ authHeader });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');

    assert.deepEqual(await fetchAPI('https://example.test/api', '/me'), { authHeader: 'Bearer jwt-1' });
    now = Date.parse('2026-06-22T12:00:39.000Z');
    assert.deepEqual(await fetchAPI('https://example.test/api', '/me'), { authHeader: 'Bearer jwt-1' });
    now = Date.parse('2026-06-22T12:00:41.000Z');
    assert.deepEqual(await fetchAPI('https://example.test/api', '/me'), { authHeader: 'Bearer jwt-2' });

    assert.equal(exchangeCount, 2);
    assert.equal(calls.filter((call) => call.url.endsWith('/auth/token/exchange')).length, 2);
  } finally {
    resetTokens();
    Date.now = originalNow;
    global.fetch = originalFetch;
  }
});

test('get_all_tables applies search and explicit all contract', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();

  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (String(url).endsWith('/metadata')) {
      return jsonResponse({ dbType: 'postgres', enfyraVersion: '2.2.11' });
    }
    if (String(url).includes('/enfyra_table?')) {
      return jsonResponse({
        data: [
          { id: 1, name: 'enfyra_user', alias: 'Users', description: 'System users' },
          { id: 10, name: 'enfyra_column' },
          { id: 11, name: 'enfyra_relation' },
          { id: 12, name: 'enfyra_table' },
          { id: 2, name: 'mcp_project', description: 'Test project' },
          { id: 3, name: 'mcp_issue', description: 'Test issue' },
        ],
      });
    }
    if (String(url).endsWith('/metadata/enfyra_column')) return jsonResponse({ data: {
      id: 10,
      name: 'enfyra_column',
      columns: [{ name: 'type', type: 'enum', options: '{"int","varchar","text","boolean","simple-json","float"}' }],
      relations: [],
    } });
    if (String(url).endsWith('/metadata/enfyra_relation')) return jsonResponse({ data: {
      id: 11,
      name: 'enfyra_relation',
      columns: [
        { name: 'type', type: 'enum', options: '{"many-to-one","one-to-many","one-to-one","many-to-many"}' },
        { name: 'onDelete', type: 'enum', options: '{"CASCADE","SET NULL","RESTRICT"}' },
      ],
      relations: [],
    } });
    if (String(url).endsWith('/metadata/enfyra_table')) return jsonResponse({ data: {
      id: 12,
      name: 'enfyra_table',
      columns: [{ name: 'name', type: 'varchar' }],
      relations: [],
    } });
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    await assert.rejects(
      () => server.get('get_all_tables').handler({}),
      /requires either limit or all=true/
    );

    const result = await server.get('get_all_tables').handler({ search: 'mcp_' });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.matchedTableCount, 2);
    assert.equal(payload.returnedTableCount, 2);
    assert.equal(payload.implicitSearchLimit, true);
    assert.match(result.content[0].text, /mcp_project/);
    assert.doesNotMatch(result.content[0].text, /enfyra_user/);

    const designResult = await server.get('get_schema_design_context').handler({});
    const designPayload = JSON.parse(designResult.content[0].text);
    assert.deepEqual(designPayload.liveColumnTypes, ['int', 'varchar', 'text', 'boolean', 'simple-json', 'float']);
    assert.match(designPayload.primaryKeyContext.createTableDefault, /SQL id\/int primary key/);
    assert.match(JSON.stringify(designPayload.recommendedSequence), /Create independent lookup\/base tables first/);
    assert.match(JSON.stringify(designPayload.relationDefinitionInput.forbiddenPhysicalFields), /foreignKeyColumn/);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_relations resolves table names before schema patch', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  let patchedBody = null;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expTime: Date.now() + 60_000 });
    }
    if (urlText.includes('/enfyra_table?')) {
      return jsonResponse({
        data: [
          { id: 9, name: 'mcp_issue' },
          { id: 4, name: 'enfyra_user', alias: 'Users' },
        ],
      });
    }
    if (urlText.endsWith('/metadata/mcp_issue')) {
      return jsonResponse({ data: {
          id: 9,
          name: 'mcp_issue',
          columns: [{ id: 1, name: 'title', type: 'varchar' }],
          relations: patchedBody?.relations || [],
      } });
    }
    if (urlText.endsWith('/enfyra_table/9') && init.method === 'PATCH') {
      patchedBody = JSON.parse(init.body);
      patchedBody.relations = patchedBody.relations.map((relation, index) => ({ id: index + 20, ...relation }));
      return jsonResponse({ data: [{ id: 9, name: 'mcp_issue', relations: patchedBody.relations }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    await server.get('create_relations').handler({
      items: [{
        sourceTableId: 'mcp_issue',
        targetTable: 'enfyra_user',
        type: 'many-to-one',
        propertyName: 'owner',
        onDelete: 'SET NULL',
      }],
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });

    assert.equal(patchedBody.relations[0].targetTable, 4);
    assert.equal(patchedBody.relations[0].propertyName, 'owner');
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_tables accepts tables alias and defers relation constraints until FK columns exist', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  const createdTables = new Map();
  let nextRelationId = 30;
  let constraintPatch = null;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (urlText.endsWith('/metadata')) {
      return jsonResponse({ dbType: 'postgres', enfyraVersion: '2.2.11' });
    }
    if (urlText.endsWith('/metadata/enfyra_column')) {
      return jsonResponse({ data: {
        id: 1,
        name: 'enfyra_column',
        columns: [{ name: 'type', options: JSON.stringify(['int', 'varchar', 'date']) }],
        relations: [],
      } });
    }
    if (urlText.includes('/metadata/event_registration')) {
      return jsonResponse({ data: createdTables.get(99) });
    }
    if (urlText.endsWith('/enfyra_table') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.uniques, []);
      assert.deepEqual(body.indexes, [['status']]);
      assert.equal(body.columns.some((column) => column.name === 'createdAt'), false);
      const table = {
        id: 99,
        name: body.name,
        indexes: [...body.indexes, ['scheduledDate']],
        uniques: body.uniques,
        columns: body.columns.map((column, index) => ({ id: index + 1, ...column })),
        relations: [],
      };
      createdTables.set(99, table);
      return jsonResponse({ data: [table] });
    }
    if (urlText.includes('/enfyra_table?')) {
      return jsonResponse({ data: [
        { id: 1, name: 'enfyra_column' },
        { id: 4, name: 'enfyra_user' },
        { id: 10, name: 'community_event' },
        ...[...createdTables.values()].map((table) => ({ id: table.id, name: table.name })),
      ] });
    }
    if (urlText.endsWith('/enfyra_table/99') && init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      const table = createdTables.get(99);
      if (body.relations) {
        table.relations = body.relations.map((relation) => ({
          id: relation.id || nextRelationId++,
          ...relation,
          foreignKeyColumn: relation.foreignKeyColumn || `${relation.propertyName}Id`,
        }));
        createdTables.set(99, table);
        return jsonResponse({ data: [table] });
      }
      if (body.indexes || body.uniques) {
        constraintPatch = body;
        table.indexes = body.indexes;
        table.uniques = body.uniques;
        createdTables.set(99, table);
        return jsonResponse({ data: [table] });
      }
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    const result = await server.get('create_tables').handler({
      tables: [{
        name: 'event_registration',
        columns: [
          { name: 'status', type: 'varchar', isNullable: false },
          { name: 'scheduledDate', type: 'date', isNullable: false },
          { name: 'createdAt', type: 'datetime' },
        ],
        relations: [
          { targetTable: 'community_event', type: 'many-to-one', propertyName: 'event', isNullable: false },
          { targetTable: 'enfyra_user', type: 'many-to-one', propertyName: 'attendee', isNullable: false },
        ],
        indexes: [['status']],
        uniques: [['event', 'scheduledDate']],
      }],
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.deferredConstraintCount, 1);
    assert.deepEqual(payload.created[0].skippedAutoColumns, [{
      name: 'createdAt',
      reason: 'Enfyra manages id/createdAt/updatedAt automatically during table creation.',
    }]);
    assert.deepEqual(constraintPatch.uniques, [['eventId', 'scheduledDate']]);
    assert.deepEqual(constraintPatch.indexes, [['status']]);
    assert.deepEqual(payload.appliedDeferredConstraints[0].prunedExistingIndexes, [['scheduledDate']]);
    assert.deepEqual(payload.cleanupHints.recordCreateOrder, ['event_registration']);
    assert.match(payload.cleanupHints.recordCreateRule, /parent\/target rows/);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_tables cleanup order puts child/source tables before parent/target tables', () => {
  const order = computeBatchCleanupOrder([
    { name: 'zz_accounts' },
    { name: 'zz_products' },
    { name: 'zz_plans', relations: [{ targetTable: 'zz_products', propertyName: 'product' }] },
    {
      name: 'zz_subscriptions',
      relations: [
        { targetTable: 'zz_accounts', propertyName: 'account' },
        { targetTable: 'zz_plans', propertyName: 'plan' },
      ],
    },
    { name: 'zz_invoices', relations: [{ targetTable: 'zz_subscriptions', propertyName: 'subscription' }] },
    { name: 'zz_usage_events', relations: [{ targetTable: 'zz_subscriptions', propertyName: 'subscription' }] },
  ]);

  assert.ok(order.indexOf('zz_invoices') < order.indexOf('zz_subscriptions'));
  assert.ok(order.indexOf('zz_usage_events') < order.indexOf('zz_subscriptions'));
  assert.ok(order.indexOf('zz_subscriptions') < order.indexOf('zz_accounts'));
  assert.ok(order.indexOf('zz_subscriptions') < order.indexOf('zz_plans'));
  assert.ok(order.indexOf('zz_plans') < order.indexOf('zz_products'));
  assert.deepEqual([...order].reverse()[0], 'zz_products');
});

test('create_tables rejects constraints referencing undeclared fields before partial create', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  let postCount = 0;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (urlText.endsWith('/enfyra_table') && init.method === 'POST') {
      postCount += 1;
      return jsonResponse({ data: [{ id: 100 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    await assert.rejects(
      () => server.get('create_tables').handler({
        items: [
          {
            name: 'event_registration',
            columns: [{ name: 'status', type: 'varchar' }],
            uniques: [['attendee', 'event']],
          },
        ],
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /undeclared field\(s\): attendee, event/,
    );
    assert.equal(postCount, 0);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_tables explains FK-shaped constraint fields and column relation collisions', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  let postCount = 0;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (urlText.endsWith('/enfyra_table') && init.method === 'POST') {
      postCount += 1;
      return jsonResponse({ data: [{ id: 100 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    await assert.rejects(
      () => server.get('create_tables').handler({
        items: [
          {
            name: 'event_hall',
            columns: [{ name: 'name', type: 'varchar' }],
            relations: [{ targetTable: 'event_venue', type: 'many-to-one', propertyName: 'venue' }],
            indexes: [['venueId']],
          },
        ],
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /venueId -> use relation propertyName "venue"/,
    );
    await assert.rejects(
      () => server.get('create_tables').handler({
        items: [
          {
            name: 'crew_assignment',
            columns: [{ name: 'start_date', type: 'date' }],
            relations: [{ targetTable: 'crew', type: 'many-to-one', propertyName: 'crew' }],
            uniques: [['crew', 'startDate']],
          },
        ],
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /startDate -> did you mean "start_date"/,
    );
    await assert.rejects(
      () => server.get('create_tables').handler({
        items: [
          {
            name: 'event_hall',
            columns: [{ name: 'venue', type: 'int' }],
            relations: [{ targetTable: 'event_venue', type: 'many-to-one', propertyName: 'venue' }],
          },
        ],
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /remove the scalar column\(s\) and keep the relation propertyName\(s\) venue/,
    );
    assert.equal(postCount, 0);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('create_tables rejects unique/index overlap before partial create', async () => {
  const originalFetch = global.fetch;
  const server = createToolHarness();
  let postCount = 0;

  global.fetch = async (url, init = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (urlText.endsWith('/enfyra_table') && init.method === 'POST') {
      postCount += 1;
      return jsonResponse({ data: [{ id: 100 }] });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    resetTokens();
    initAuth('https://example.test/api', 'api-token');
    registerTableTools(server, 'https://example.test/api');
    await assert.rejects(
      () => server.get('create_tables').handler({
        items: [
          {
            name: 'ok_table',
            columns: [{ name: 'status', type: 'varchar' }],
          },
          {
            name: 'reserve_table',
            columns: [
              { name: 'claim', type: 'varchar' },
              { name: 'reserveType', type: 'varchar' },
            ],
            uniques: [['claim', 'reserveType']],
            indexes: [['reserveType']],
          },
        ],
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /indexes must not include fields that appear in uniques/,
    );
    assert.equal(postCount, 0);
  } finally {
    resetTokens();
    global.fetch = originalFetch;
  }
});

test('route permission helpers resolve role names and validate available methods', () => {
  const roles = [{ id: 2, name: 'user' }, { id: 1, name: 'Admin' }];
  const route = {
    id: 10,
    path: '/cloud_projects',
    availableMethods: [{ id: 1 }, { id: 2 }],
  };
  const methodMap = { GET: 1, POST: 2, PATCH: 3 };
  const methodIdNameMap = { 1: 'GET', 2: 'POST', 3: 'PATCH' };

  assert.deepEqual(resolveRoleByNameOrId(roles, { roleName: 'USER' }), roles[0]);
  assert.deepEqual(validateMethodsForRoute(route, ['get', 'POST'], methodMap, methodIdNameMap), ['GET', 'POST']);
  assert.throws(
    () => validateMethodsForRoute(route, ['PATCH'], methodMap, methodIdNameMap),
    /does not list methods as available/
  );
});

test('route permission helpers match scopes and merge methods predictably', () => {
  const permission = {
    id: 18,
    route: { id: 10, path: '/cloud_projects' },
    role: { id: 2, name: 'user' },
    allowedUsers: [],
    methods: [{ id: 1 }, { id: 2 }],
    isEnabled: true,
  };
  const methodIdNameMap = { 1: 'GET', 2: 'POST', 3: 'PATCH' };

  assert.equal(routePermissionMatchesScope(permission, { roleId: 2, allowedUserIds: [] }), true);
  assert.equal(routePermissionMatchesScope(permission, { roleId: 2, allowedUserIds: [5] }), false);
  assert.equal(findRoutePermission([permission], 10, { roleId: 2, allowedUserIds: [] })?.id, 18);
  assert.deepEqual(mergeMethodNames(['GET'], ['get', 'POST'], 'merge'), ['GET', 'POST']);
  assert.deepEqual(mergeMethodNames(['GET'], ['POST'], 'replace'), ['POST']);

  const access = summarizeRouteAccess(
    { id: 10, path: '/cloud_projects', availableMethods: [{ id: 1 }, { id: 2 }] },
    [permission],
    methodIdNameMap,
    { roleId: 2, methods: ['GET', 'PATCH'] }
  );
  assert.deepEqual(access.expected.missingMethods, ['PATCH']);

  const narrowedPermission = {
    ...permission,
    id: 19,
    allowedUsers: [{ id: 5 }],
  };
  const roleWideAccess = summarizeRouteAccess(
    { id: 10, path: '/cloud_projects', availableMethods: [{ id: 1 }] },
    [narrowedPermission],
    methodIdNameMap,
    { roleId: 2, allowedUserIds: [], methods: ['GET'] }
  );
  assert.deepEqual(roleWideAccess.expected.missingMethods, ['GET']);
});

test('prepareRecordMutation rejects fields that are not in table metadata', async () => {
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'cloud_projects',
        columns: [{ name: 'name' }],
        relations: [{ propertyName: 'owner' }],
      }],
      tableName: 'cloud_projects',
      data: JSON.stringify({ name: 'Project', expiredAt: '2026-01-01' }),
    }),
    /expiredAt/
  );
});

test('prepareRecordMutation directs array payloads to create_records', async () => {
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'app_team',
        columns: [{ name: 'name' }],
        relations: [],
      }],
      tableName: 'app_team',
      data: JSON.stringify([{ name: 'Platform' }]),
    }),
    /use create_records/
  );
});

test('prepareRecordBatchMutation preflights every record and reports the failing index', async () => {
  await assert.rejects(
    () => prepareRecordBatchMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'app_team',
        columns: [{ name: 'name' }],
        relations: [],
      }],
      tableName: 'app_team',
      records: JSON.stringify([
        { name: 'Platform' },
        { name: 'Product', is_active: true },
      ]),
    }),
    /index 1[\s\S]*is_active[\s\S]*name/
  );

  const prepared = await prepareRecordBatchMutation({
    fetchAPI: async () => ({ success: true, valid: true }),
    apiUrl: 'https://example.test/api',
    tables: [{
      name: 'app_team',
      columns: [{ name: 'name' }],
      relations: [{ propertyName: 'owner' }],
    }],
    tableName: 'app_team',
    records: [{ name: 'Platform', owner: 1 }],
  });
  assert.equal(prepared.records.length, 1);
  assert.equal(prepared.records[0].payload.owner, 1);
});

test('prepareRecordMutation explains relation property names when FK-shaped fields are sent', async () => {
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'app_primary_record',
        columns: [{ name: 'title' }],
        relations: [{ propertyName: 'lookup' }, { propertyName: 'owner' }],
      }],
      tableName: 'app_primary_record',
      data: JSON.stringify({ title: 'Intro', lookupId: 9, owner_id: 4 }),
    }),
    /lookupId -> use relation property "lookup".*owner_id -> use relation property "owner"/,
  );
});

test('prepareRecordMutation validates sourceCode and rejects compiledCode/code alias', async () => {
  const calls = [];
  const fetchMock = async (apiUrl, path, options) => {
    calls.push({ apiUrl, path, body: JSON.parse(options.body) });
    return { success: true, valid: true };
  };

  const prepared = await prepareRecordMutation({
    fetchAPI: fetchMock,
    apiUrl: 'https://example.test/api',
    tables: [{
      name: 'enfyra_route_handler',
      columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }],
      relations: [{ propertyName: 'route' }, { propertyName: 'method' }],
    }],
    tableName: 'enfyra_route_handler',
    data: JSON.stringify({ sourceCode: 'return true;', scriptLanguage: 'javascript' }),
  });

  assert.equal(prepared.scriptValidation.validated, true);
  assert.equal(calls[0].path, '/admin/script/validate');
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: fetchMock,
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'enfyra_route_handler',
        columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }, { name: 'compiledCode' }],
        relations: [],
      }],
      tableName: 'enfyra_route_handler',
      data: JSON.stringify({ sourceCode: 'return true;', compiledCode: 'stale' }),
    }),
    /compiledCode/
  );
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: fetchMock,
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'enfyra_pre_hook',
        columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }, { name: 'code' }],
        relations: [],
      }],
      tableName: 'enfyra_pre_hook',
      data: JSON.stringify({ code: 'return true;' }),
    }),
    /sourceCode/
  );
});

test('prepareRecordMutation fails closed when script validation endpoint is unavailable', async () => {
  const fetchMock = async () => {
    throw new Error('API error (404): {"message":"not found"}');
  };

  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: fetchMock,
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'enfyra_route_handler',
        columns: [{ name: 'sourceCode' }, { name: 'scriptLanguage' }],
        relations: [],
      }],
      tableName: 'enfyra_route_handler',
      data: JSON.stringify({ sourceCode: 'return true;', scriptLanguage: 'javascript' }),
    }),
    /Script validation failed before save/
  );
});

test('mcp server exposes update_script_source for raw source updates', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /server\.tool\(\s*['"]update_script_source['"]/);
  assert.match(entry, /JSON\.stringify\(\{ sourceCode, scriptLanguage \}\)/);
  assert.match(entry, /updated_script_source/);
});

test('mcp server exposes script source inspection and patch tools', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /server\.tool\(\s*['"]get_script_source['"]/);
  assert.match(entry, /server\.tool\(\s*['"]patch_script_source['"]/);
  assert.match(entry, /expectedSourceSha256/);
  assert.match(entry, /patch_script_source_preview/);
});

test('mcp server exposes metadata usage tracing for production script edits', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /server\.tool\(\s*['"]trace_metadata_usage['"]/);
  assert.match(entry, /scriptReadErrors/);
  assert.match(entry, /get_script_source/);
  assert.match(entry, /route\.path/);
  assert.match(entry, /flow\.name/);
  assert.match(entry, /gateway\.path/);
});

test('code-writing tools require session or explicit required-knowledge acknowledgement without blocking discovery or validation', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const platformTools = readFileSync(new URL('../src/lib/platform-operation-tools.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');

  assert.match(entry, /server\.tool\(\s*['"]get_enfyra_required_knowledge['"]/);
  assert.match(entry, /server\.tool\(\s*['"]discover_enfyra_workflows['"]/);
  assert.match(entry, /discoverWorkflowRoutes/);
  assert.match(entry, /detail: z\.enum\(\['summary', 'plan', 'full'\]/);
  assert.match(entry, /avoidTools negative-routing boundaries/);
  assert.match(requiredKnowledge, /GLOBAL_RULES_ACK_KEY/);
  assert.match(requiredKnowledge, /globalRulesAckKey/);
  assert.match(requiredKnowledge, /Call get_enfyra_required_knowledge/);
  assert.match(requiredKnowledge, /DYNAMIC_CODE_KNOWLEDGE_ACK_KEY/);
  assert.match(requiredKnowledge, /EXTENSION_KNOWLEDGE_ACK_KEY/);
  assert.match(requiredKnowledge, /secure-vs-trusted-repositories/);
  assert.match(requiredKnowledge, /theme-contract-first/);
  assert.match(instructions, /get_enfyra_required_knowledge/);
  assert.match(instructions, /discover_enfyra_workflows/);
  assert.match(instructions, /known non-destructive task/);
  assert.match(instructions, /Session acknowledgement removes repeated ack-key boilerplate/);

  assert.match(entry, /server\.tool\(\s*['"]create_records['"]/);
  assert.match(entry, /server\.tool\(\s*['"]update_records['"]/);
  assert.match(entry, /server\.tool\(\s*['"]delete_records['"]/);
  assert.match(entry, /create_records[\s\S]*prepareGenericBatchMutation/);
  assert.match(entry, /create_records[\s\S]*sequential/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_record['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]update_record['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]delete_record['"]/);
  assert.match(entry, /create_records[\s\S]*knowledgeAckKey/);
  assert.match(entry, /update_records[\s\S]*extensionKnowledgeAckKey/);
  assert.match(entry, /delete_records[\s\S]*globalRulesAckKey/);
  assert.match(entry, /SCRIPT_BACKED_TABLE_SET\.has\(tableName\)/);
  assert.match(entry, /patch_script_source[\s\S]*apply[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /update_script_source[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /create_handler[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /create_pre_hook[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /create_post_hook[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);

  assert.match(platformTools, /set_table_graphql[\s\S]*globalRulesAckKey/);
  assert.match(platformTools, /api_endpoint_workflow[\s\S]*knowledgeAckKey/);
  assert.match(platformTools, /api_endpoint_workflow[\s\S]*globalRulesAckKey/);
  assert.match(platformTools, /apply \|\| opts\.applyAll[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /applyAll[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(platformTools, /create_api_endpoint[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(platformTools, /ensure_websocket_gateway[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAckIf/);
  assert.match(platformTools, /ensure_websocket_event[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(platformTools, /ensure_script_flow_step[\s\S]*knowledgeAckKey/);
  assert.match(platformTools, /ensure_condition_flow_step[\s\S]*knowledgeAckKey/);
  assert.match(platformTools, /ensure_page_extension[\s\S]*globalRulesAckKey[\s\S]*extensionKnowledgeAckKey/);
  assert.match(platformTools, /ensure_global_extension[\s\S]*globalRulesAckKey[\s\S]*extensionKnowledgeAckKey/);
  assert.match(platformTools, /ensure_widget_extension[\s\S]*globalRulesAckKey[\s\S]*extensionKnowledgeAckKey/);

  assert.match(platformTools, /validate_dynamic_script[\s\S]*sourceCode: z\.string/);
  assert.doesNotMatch(platformTools, /validate_dynamic_script[\s\S]{0,500}knowledgeAckKey/);
  assert.match(platformTools, /validate_extension_code[\s\S]*code: z\.preprocess\(normalizeEscapedVueSource, z\.string\(\)\)/);
  assert.doesNotMatch(platformTools, /validate_extension_code[\s\S]{0,500}extensionKnowledgeAckKey/);
});

test('mcp server exposes route platform operation tools', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const tableTools = readFileSync(new URL('../src/lib/table-tools.ts', import.meta.url), 'utf8');
  const platformTools = readFileSync(new URL('../src/lib/platform-operation-tools.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');
  const routing = readFileSync(new URL('../src/lib/tool-routing.ts', import.meta.url), 'utf8');
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const extensionThemeContractBlock = platformTools.slice(
    platformTools.indexOf('function getExtensionThemeContract()'),
    platformTools.indexOf('function getThemeClassReference()'),
  );

  assert.match(entry, /registerPlatformOperationTools\(server, ENFYRA_API_URL\)/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]add_column['"]/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]remove_column['"]/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]add_relation['"]/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]remove_relation['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]add_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]replace_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]remove_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]enable_route['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]disable_route['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]delete_route['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]set_route_public_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]public_route_methods['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]set_public_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]private_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]api_endpoint_workflow['"]/);
  assert.match(platformTools, /nextSteps/);
  assert.match(platformTools, /applyAll/);
  assert.match(platformTools, /delete_route\(\{ routeId:/);
  assert.doesNotMatch(platformTools, /delete_record\(\{ tableName: "enfyra_route_handler"/);
  assert.match(platformTools, /server\.tool\(\s*['"]create_api_endpoint['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]validate_dynamic_script['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]validate_extension_code['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_ui['"]/);
  assert.match(platformTools, /Lazy gateway for Enfyra admin extension UI builders/);
  assert.match(platformTools, /extensionKnowledgeAckKey/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_drawer['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_modal['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_page_shell['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_permission_gate['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_empty_state['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_resource_list['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_resource_grid['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_form_editor['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_widget['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_menu_notification['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_account_panel_item['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_tabs['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_upload_modal['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]review_extension_ui_contract['"]/);
  assert.match(entry, /server\.tool\(\s*['"]get_permission_profile['"]/);
  assert.match(entry, /MCP_PERMISSION_REQUIREMENTS/);
  assert.match(entry, /\/admin\/script\/validate/);
  assert.match(entry, /\/admin\/test\/run/);
  assert.match(entry, /\/admin\/flow\/trigger\/:id/);
  assert.match(entry, /\/admin\/menu\/reorder/);
  assert.match(entry, /tools: \['reorder_menus'\]/);
  assert.match(platformTools, /server\.tool\(\s*['"]set_table_graphql['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_column_rule['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_field_permission['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_route_rate_limit['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_guard['"]/);
  assert.match(platformTools, /ensure_column_rule[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /ensure_field_permission[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /ensure_route_rate_limit[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /ensure_guard[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_column_rule['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_field_permission['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_route_permission['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_guard['"]/);
	  assert.match(platformTools, /server\.tool\(\s*['"]ensure_websocket_gateway['"]/);
	  assert.match(platformTools, /server\.tool\(\s*['"]ensure_websocket_event['"]/);
	  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_flow['"]/);
	  assert.match(platformTools, /server\.tool\(\s*['"]flow_workflow['"]/);
	  assert.match(platformTools, /server\.tool\(\s*['"]ensure_manual_flow['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_scheduled_flow['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]choose_flow_step_tool['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_script_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_condition_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_query_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_create_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_update_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_delete_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_http_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_sleep_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_trigger_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_log_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_menu['"]/);
  assert.match(platformTools, /normalizeMenuPermissionArg/);
  assert.match(platformTools, /new menus default to null/);
  assert.match(platformTools, /Empty objects are normalized to null/);
  assert.match(platformTools, /server\.tool\(\s*['"]reorder_menus['"]/);
  assert.match(platformTools, /\/admin\/menu\/reorder/);
  assert.match(platformTools, /Duplicate menu id in reorder payload/);
  assert.match(platformTools, /emits enfyra_menu cache invalidation/);
  assert.match(platformTools, /server\.tool\(\s*['"]extension_workflow['"]/);
  assert.match(platformTools, /runExtensionWorkflow/);
  assert.match(platformTools, /extension_workflow_planned/);
  assert.match(platformTools, /extension_workflow_advanced/);
  assert.match(platformTools, /assertExtensionKnowledgeAck/);
  assert.match(platformTools, /get_extension_theme_contract before generating or reviewing extension UI/);
  assert.match(platformTools, /kind=api_usage/);
  assert.match(platformTools, /For high-contract UI\/runtime code, call build_extension_ui/);
  assert.match(platformTools, /Generate a contract-safe CommonDrawer Vue snippet/);
  assert.match(platformTools, /Generate a contract-safe CommonModal\/UModal Vue snippet/);
  assert.match(platformTools, /Generate page-header and shell-header-action script setup code/);
  assert.match(platformTools, /Generate a PermissionGate wrapper snippet/);
  assert.match(platformTools, /Generate an EmptyState snippet/);
  assert.match(platformTools, /Generate a CommonResourceListFrame\/CommonResourceListItem snippet/);
  assert.match(platformTools, /Generate a constrained responsive CommonResourceListFrame card grid/);
  assert.match(platformTools, /Generate a FormEditor\/FormEditorLazy snippet/);
  assert.match(platformTools, /Generate a Widget snippet/);
  assert.match(platformTools, /Generate useMenuNotificationRegistry registration code/);
  assert.match(platformTools, /Generate useAccountPanelRegistry registration code/);
  assert.match(platformTools, /Generate a UTabs snippet/);
  assert.match(platformTools, /Generate a CommonUploadModal snippet/);
  assert.match(platformTools, /extension_api_usage_built/);
  assert.match(platformTools, /extension_notify_usage_built/);
  assert.match(platformTools, /extension_runtime_contract_reviewed/);
  assert.match(platformTools, /Invalid extension runtime contract/);
  assert.match(platformTools, /api_usage/);
  assert.match(platformTools, /runtime_review/);
  assert.match(platformTools, /theme_classes/);
  assert.match(platformTools, /theme_review/);
  assert.match(platformTools, /extension_theme_contract_reviewed/);
  assert.match(platformTools, /Invalid extension theme contract/);
  assert.match(platformTools, /Review an Enfyra extension Vue snippet/);
  assert.match(platformTools, /kind=review/);
  assert.match(platformTools, /field controls without class="w-full"/);
  assert.match(platformTools, /Extension validation rejects UInput, UTextarea/);
  assert.match(routing, /build_extension_ui/);
  assert.match(routing, /FormEditor, Widget, shell registries, tabs, upload modal, api usage, notify, runtime review, theme classes, theme review, or full review/);
  assert.match(routing, /kind: drawer, modal, page shell/);
  assert.match(platformTools, /Use build_extension_ui kind=drawer for generated drawer\/editing snippets/);
  assert.match(platformTools, /Use build_extension_ui kind=modal for generated modal\/confirmation snippets/);
  assert.match(platformTools, /Unrestricted menu permission is null/);
  assert.match(platformTools, /patches=\[\{search,replace\}/);
  assert.match(platformTools, /searchMode="whitespace"/);
  assert.match(platformTools, /replaceAll=true/);
  assert.match(platformTools, /Atomic multi-patch list/);
  assert.match(platformTools, /shellComponentContracts/);
  assert.match(platformTools, /Use build_extension_ui kind=permission_gate for generated permission wrapper snippets/);
  assert.match(platformTools, /PermissionGate renders the permitted slot directly/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_page_extension['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_global_extension['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_widget_extension['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_menu_extension_page['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_menu['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_extension['"]/);
  assert.match(platformTools, /sourceCode/);
  assert.match(platformTools, /stepOrder/);
  assert.match(platformTools, /triggerType/);
  assert.doesNotMatch(platformTools, /connectionHandlerScript/);
  assert.doesNotMatch(platformTools, /handlerScript/);
  assert.doesNotMatch(platformTools, /\/admin\/reload\/flows/);
  assert.doesNotMatch(platformTools, /\/admin\/reload\/websockets/);
  assert.match(platformTools, /validateScriptSourceIfPresent/);
  assert.match(platformTools, /get_extension_theme_contract/);
  assert.match(platformTools, /Never fix one extension by injecting global CSS/);
  assert.match(platformTools, /theme guards/);
  assert.match(extensionThemeContractBlock, /Do not choose theme classes from memory/);
  assert.match(extensionThemeContractBlock, /themeIntents/);
  assert.match(extensionThemeContractBlock, /neutral_surface/);
  assert.match(extensionThemeContractBlock, /primary_identity/);
  assert.match(extensionThemeContractBlock, /theme_review/);
  assert.doesNotMatch(extensionThemeContractBlock, /decisionCases/);
  assert.doesNotMatch(extensionThemeContractBlock, /patternExamples/);
  assert.doesNotMatch(extensionThemeContractBlock, /compactExample/);
  assert.doesNotMatch(extensionThemeContractBlock, /classReference/);
  assert.doesNotMatch(extensionThemeContractBlock, /eapp-primary-surface/);
  assert.doesNotMatch(extensionThemeContractBlock, /bg-primary\/10/);
  assert.match(platformTools, /Use build_extension_ui kind=modal for generated modal\/confirmation snippets/);
  assert.match(platformTools, /md:grid-cols-2 xl:grid-cols-3/);
  assert.match(examples, /eapp-surface-card p-4/);
  assert.match(examples, /eapp-primary-surface/);
  assert.match(examples, /eapp-primary-soft/);
  assert.match(examples, /eapp-primary-solid/);
  assert.match(examples, /gradient: 'none'/);
  assert.match(examples, /color: 'neutral'/);
  assert.match(examples, /Call get_extension_theme_contract before writing or reviewing page\/widget\/global extension UI/);
  assert.match(examples, /authority for theme, color, layout, modal, drawer, and shell registry details/);
  assert.doesNotMatch(examples, /gradient: 'cyan'/);
  assert.doesNotMatch(examples, /<p class=\\["']text-sm text-muted/);
  assert.doesNotMatch(examples, /grid gap-4 md:grid-cols-3/);
  assert.doesNotMatch(examples, /bg-\[var\(--eapp-surface-muted\)\]/);
  assert.doesNotMatch(examples, /hover:eapp-surface-muted/);
  assert.match(instructions, /most specific operation tool/);
  assert.match(instructions, /lazily/);
  assert.match(instructions, /discover_enfyra_workflows/);
  assert.match(routing, /ensure_websocket_event/);
  assert.match(routing, /extension_workflow/);
  assert.match(routing, /reorder_menus/);
  assert.match(routing, /PATCH enfyra_menu for order or parent changes/);
  assert.match(routing, /api_endpoint_workflow/);
  assert.match(routing, /create_api_endpoint/);
  assert.match(routing, /public_route_methods/);
  assert.match(routing, /add_route_methods/);
  assert.match(routing, /enable_route/);
  assert.match(routing, /ensure_page_extension/);
});

test('test_flow_step uses unified admin test runner', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /'test_flow_step'/);
  assert.match(entry, /'\/admin\/test\/run'/);
  assert.match(entry, /kind:\s*'flow_step'/);
  assert.doesNotMatch(entry, /fetchAPI\(ENFYRA_API_URL,\s*'\/admin\/flow\/test-step'/);
});

test('GraphQL uses generated resolvers instead of script-backed source records', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const runtimeZones = readFileSync(new URL('../src/lib/runtime-zone-tools.ts', import.meta.url), 'utf8');
  const mutationGuards = readFileSync(new URL('../src/lib/mutation-guards.ts', import.meta.url), 'utf8');

  const scriptTableBlock = entry.slice(
    entry.indexOf('const SCRIPT_BACKED_TABLES'),
    entry.indexOf('const SCRIPT_SOURCE_FIELDS'),
  );
  assert.doesNotMatch(scriptTableBlock, /enfyra_graphql/);
  assert.doesNotMatch(mutationGuards.slice(0, mutationGuards.indexOf('export function parseRecordData')), /enfyra_graphql/);
  assert.match(runtimeZones, /enfyra_graphql[^\n]+metadata/);
  assert.doesNotMatch(runtimeZones, /enfyra_graphql[^\n]+sourceCode/);
  assert.match(entry, /server\.tool\(\s*['"]test_graphql['"]/);
});

test('OAuth provider provisioning source is treated as a script-backed identity surface', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const guards = readFileSync(new URL('../src/lib/mutation-guards.ts', import.meta.url), 'utf8');
  const zones = readFileSync(new URL('../src/lib/runtime-zone-tools.ts', import.meta.url), 'utf8');

  assert.match(entry, /SCRIPT_BACKED_TABLES[\s\S]*'enfyra_oauth_config'/);
  assert.match(guards, /SCRIPT_TABLES[\s\S]*'enfyra_oauth_config'/);
  assert.match(entry, /oauthUserProvisioning/);
  assert.match(zones, /enfyra_oauth_config[^\n]*sourceCode[^\n]*appCallbackUrl/);
  assert.match(zones, /enfyra_user/);
  assert.match(zones, /enfyra_oauth_account/);
});

test('run_admin_test exposes the backend generic script test kind', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /kind: z\.enum\(\['script', 'flow_step', 'websocket_event', 'websocket_connection'\]/);
});

test('mcp log search matches dashed and dotted app log filenames', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /\^app\[\.-\]/);
  assert.match(entry, /\^error\[\.-\]/);
});

test('server instructions stay compact and route details to tools', () => {
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');
  const routing = readFileSync(new URL('../src/lib/tool-routing.ts', import.meta.url), 'utf8');

  assert.ok(Buffer.byteLength(instructions, 'utf8') < 4000);
  assert.match(instructions, /path is ambiguous/);
  assert.match(instructions, /get_enfyra_api_context/);
  assert.match(instructions, /inspect only the table, route, extension, or runtime artifact/);
  assert.match(instructions, /never preload broad context/);
  assert.match(instructions, /Session acknowledgement/);
  assert.match(routing, /progressive disclosure/);
  assert.match(routing, /query_table on destination domain lists/);
	  assert.match(routing, /notification summary\/realtime shell signal plus destination-page fetch on click/);
	  assert.match(routing, /api_endpoint_workflow/);
	  assert.match(routing, /flow_workflow/);
  assert.doesNotMatch(instructions, /#### Injected Vue API functions/);
  assert.doesNotMatch(instructions, /Tables confirmed to have REST routes/);
});

test('discovery tools report target instance and avoid unbounded broad searches', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');

  assert.match(entry, /function targetInstance\(\)/);
  assert.match(entry, /source: 'ENFYRA_API_URL environment variable used by this MCP server process'/);
  assert.match(entry, /targetInstance: targetInstance\(\)/);
  assert.match(entry, /Use this as the cheap first target sanity check/);
  assert.match(entry, /Do not use this only to confirm the API base/);
  assert.match(entry, /installColumnarToolFormatter\(server\)/);
  assert.match(entry, /routeSamples: sample\(routes, 25\)/);
  assert.match(entry, /tableSamples: sample\(tableNames, 40\)/);
  assert.match(entry, /adminRoutes: sample\(adminRoutes/);
  assert.match(entry, /publicRoutes: sample\(publicRoutes/);
  assert.match(entry, /relationFkColumnNames/);
  assert.match(entry, /hiddenRelationColumnCount/);
  assert.match(entry, /discoveryFetch\(`\/metadata\/\$\{encodeURIComponent\(tableName\)\}`\)/);
  assert.doesNotMatch(entry, /\n\s+tableNames,\n\s+routes,\n/);
  assert.match(entry, /DISCOVERY_FETCH_TIMEOUT_MS = 12000/);
  assert.match(entry, /partialErrors: collectPartialErrors/);
  assert.match(entry, /async function collectFeatureSearchState\(\)/);
  assert.match(entry, /const state = await collectFeatureSearchState\(\)/);
  assert.doesNotMatch(entry, /const state = await collectRestDefinitionState\(\);\n\s+const q = rawQuery\.toLowerCase\(\)/);
  assert.match(entry, /Run broad discovery tools sequentially; do not call multiple broad discovery tools in parallel/);
  assert.match(entry, /limit: z\.number\(\)\.int\(\)\.positive\(\)\.max\(25\)\.optional\(\)\.default\(8\)/);
  assert.match(entry, /inspect_feature query must be at least 2 characters/);
  assert.match(entry, /For a specific match, call inspect_table, inspect_route, trace_metadata_usage, or get_script_source/);
});

test('query_table supports deep meta and aggregate query options', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /meta: z\.string\(\)\.optional\(\)/);
  assert.match(entry, /deep: jsonObjectParam\(z, 'Deep relation fetch object'\)\.optional\(\)/);
  assert.match(entry, /aggregate: jsonObjectParam\(z, 'Aggregate object'\)\.optional\(\)/);
  assert.match(entry, /call discover_query_capabilities before using aggregate objects instead of guessing _sum\/_count operators/);
  assert.match(entry, /queryParams\.set\('deep', deepParam\)/);
  assert.match(entry, /queryParams\.set\('aggregate', aggregateParam\)/);
  assert.match(entry, /function applyDeepFieldSelections/);
  assert.match(entry, /autoAddedDeepFields/);
  assert.match(entry, /query_table auto-adds missing top-level deep relation names to fields/);
});

test('generic read tools reject enfyra_extension sourceCode confusion', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');
  const runtimeZoneTools = readFileSync(new URL('../src/lib/runtime-zone-tools.ts', import.meta.url), 'utf8');

  assert.match(entry, /function assertExtensionReadFields/);
  assert.match(entry, /enfyra_extension stores editable Vue SFC extension source in `code`, not `sourceCode`/);
  assert.match(entry, /assertExtensionReadFields\(tableName, fields\)/);
  assert.match(requiredKnowledge, /Read code, not sourceCode, for editable enfyra_extension Vue SFC records/);
  assert.match(requiredKnowledge, /Editable extension source is enfyra_extension\.code/);
  assert.match(runtimeZoneTools, /editable source artifact is enfyra_extension\.code/);
  assert.match(runtimeZoneTools, /do not query sourceCode on enfyra_extension/);
});

test('dynamic script guidance documents repository deep projection contract', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const routing = readFileSync(new URL('../src/lib/tool-routing.ts', import.meta.url), 'utf8');
  const platformTools = readFileSync(new URL('../src/lib/platform-operation-tools.ts', import.meta.url), 'utf8');

  assert.match(entry, /For repository find\(\{ deep \}\) in scripts, include relation property names in top-level fields/);
  assert.match(requiredKnowledge, /Inside dynamic server scripts, repository find\(\{ deep \}\) requires the relation property to also be present in top-level fields/);
  assert.match(examples, /Workflow handler with relation read and side effects/);
  assert.match(examples, /fields: \["id", "title", "status", "requester"\]/);
  assert.match(examples, /Find one record by id in a handler/);
  assert.match(examples, /do not keep retrying @REPOS\.<table>\.find id filter shapes/);
  assert.match(examples, /top-level fields controls which parent properties appear/);
  assert.match(routing, /fields\+deep projection contract for script repository reads/);
  assert.match(entry, /#secure\.table_name or @REPOS\.secure\.table_name/);
  assert.match(platformTools, /#secure\.table_name or @REPOS\.secure\.table_name/);
  assert.match(requiredKnowledge, /Reserve #table_name\/@REPOS\.table_name for trusted internal work/);
});

test('dynamic endpoint guidance distinguishes canonical policy from custom endpoint policy', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');
  const routing = readFileSync(new URL('../src/lib/tool-routing.ts', import.meta.url), 'utf8');
  const platformTools = readFileSync(new URL('../src/lib/platform-operation-tools.ts', import.meta.url), 'utf8');

  assert.match(requiredKnowledge, /Custom routes have no main table/);
  assert.match(requiredKnowledge, /canonical route pre-hook/);
  assert.match(requiredKnowledge, /data: @BODY/);
  assert.match(requiredKnowledge, /column-rule\/Zod/);
  assert.match(routing, /third-party-only owner\/tenant\/business policy/);
  assert.match(routing, /canonical route pre-hook/);
  assert.doesNotMatch(platformTools, /sourceCode: z\.string\(\)\.describe\('[^']*@REPOS\.main/);
  assert.match(platformTools, /assertCustomEndpointRoute\(route\)/);
  assert.match(entry, /#secure\.orders/);
  assert.doesNotMatch(entry, /explicit repos such as `\$ctx\.\$repos\.orders`/);
});

test('guidance rejects sql-like filter operators', () => {
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');
  assert.match(requiredKnowledge, /do not use _like/);
});

test('schema design context warns about column relation namespace clashes', () => {
  const tableTools = readFileSync(new URL('../src/lib/table-tools.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');
  assert.match(tableTools, /Column names and relation propertyName values share one table namespace/);
  assert.match(tableTools, /Relation propertyName must be unique among both relation names and scalar column names/);
  assert.match(tableTools, /parent detail\/read must deep-load a child collection/);
  assert.match(requiredKnowledge, /deep-read a parent with child collections/);
});

test('dynamic script guidance rejects physical relation filter names', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/lib/mcp-instructions.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');
  assert.match(entry, /not \{ incidentId: \{ _eq: incident\.id \} \}/);
  assert.match(instructions, /get_enfyra_required_knowledge/);
  assert.match(requiredKnowledge, /not \{ incidentId: \{ _eq: id \} \}/);
});

test('list query tools require explicit limit or all intent except bounded locator search', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const schemaSkill = readFileSync(new URL('../.codex/skills/enfyra-mcp-schema-data/SKILL.md', import.meta.url), 'utf8');

  assert.match(entry, /query_table requires either limit or all=true/);
  assert.match(entry, /get_all_routes requires either limit or all=true/);
  assert.match(entry, /If search is provided without limit, the tool returns a bounded lookup window of 10 matches/);
  assert.match(entry, /query_table accepts either all=true or limit, not both/);
  assert.match(entry, /get_all_routes accepts either all=true or limit, not both/);
  assert.match(entry, /all: z\.boolean\(\)\.optional\(\)\.default\(false\)\.describe\('Return all matching rows by sending REST limit=0/);
  assert.match(examples, /pass all: true instead of choosing an arbitrary page size such as 30 or 50/);
  assert.match(schemaSkill, /Locator searches on `get_all_routes` and `get_all_tables` may omit `limit`/);
});

test('delete_tables accepts tableName or tableId and schema rules mention full-batch preflight', () => {
  const tableTools = readFileSync(new URL('../src/lib/table-tools.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');

  assert.match(tableTools, /Native JSON array of delete items: \[\{ tableId \}\] or \[\{ tableName \}\]/);
  assert.match(tableTools, /items\[\$\{index\}\] requires tableId or tableName/);
  assert.match(requiredKnowledge, /create_tables preflights all items before posting tables/);
});

test('websocket script context documents roomSize helper', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');

  assert.match(entry, /roomSize\(room\) counts sockets in that room across registered gateways/);
  assert.match(entry, /@SOCKET reply\/join\/leave\/disconnect\/emit helpers\/roomSize/);
});

test('script context discovery documents runtime macro and helper surface', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');

  for (const macro of [
    '@BODY',
    '@QUERY',
    '@PARAMS',
    '@USER',
    '@REQ',
    '@RES',
    '@REPOS',
    '@CACHE',
    '@HELPERS',
    '@FETCH',
    '@STORAGE',
    '@UPLOADED_FILE',
    '@SOCKET',
    '@TRIGGER',
    '@DATA',
    '@ERROR',
    '@STATUS',
    '@ENV',
    '@PKGS',
    '@LOGS',
    '@SHARE',
    '@API',
    '@THROW',
    '@THROW400',
    '@THROW503',
  ]) {
    assert.match(entry, new RegExp(`'${macro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  assert.match(entry, /@FETCH maps to \$ctx\.\$helpers\.\$fetch/);
  assert.match(entry, /\$ctx\.\$helpers includes \$bcrypt\.hash\/compare, autoSlug\(text\), \$fetch, \$sleep\(ms\)/);
  assert.match(entry, /@REQ websocket request metadata/);
  assert.match(entry, /@RES when response streaming is available/);
});

test('dynamic throw contract is consistently documented and ack-versioned', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const payload = buildRequiredKnowledgePayload();
  const payloadText = JSON.stringify(payload);

  assert.match(GLOBAL_RULES_ACK_KEY, /20260704H$/);
  assert.match(DYNAMIC_CODE_KNOWLEDGE_ACK_KEY, /DYNAMIC-REPOSITORY-CONTRACT/);
  assert.equal(payload.version, '2026-07-17.async-helper-contract');

  for (const text of [entry, requiredKnowledge, examples, payloadText]) {
    assert.match(text, /numeric helpers? (are|is) raw HTTP message|use numeric @THROW helpers for raw HTTP messages/i);
    assert.match(text, /details.*object\/array|object or array/i);
    assert.match(text, /notFound\(resource, id\?\)|notFound\(\.\.\.\)|notFound\(resource, identifier\)/);
    assert.match(text, /duplicate\(resource, field, value\)|duplicate\(\.\.\.\)/);
  }

  assert.match(entry, /do not use @THROW404\("Project", id\) as a semantic shortcut/);
  assert.ok(payloadText.includes('do not use @THROW404(\\"Project\\", id) as a semantic shortcut'));
});

test('SSR app examples include Nuxt Next and Angular connection patterns', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');

  assert.match(examples, /Nuxt routeRules for REST and Socket\.IO/);
  assert.match(examples, /Next rewrites for REST and Socket\.IO/);
  assert.match(examples, /Next client provider for authenticated realtime/);
  assert.match(examples, /Create the Socket\.IO client once in a top-level client provider/);
  assert.match(examples, /Proxy \/socket\.io through Next rewrites to the Enfyra app bridge \/ws\/socket\.io/);
  assert.match(examples, /Angular dev proxy for REST and Socket\.IO/);
  assert.match(examples, /"pathRewrite": \{/);
  assert.match(examples, /provideHttpClient\(withInterceptors\(\[enfyraCredentialsInterceptor\]\)\)/);
  assert.match(examples, /req\.clone\(\{ withCredentials: true \}\)/);
  assert.match(examples, /Angular HttpClient auth service and route guard/);
  assert.match(examples, /Angular singleton Socket\.IO realtime service/);
  assert.match(examples, /Do not create a new socket per routed component/);
});

test('OAuth setup examples guide provider console callback configuration', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');

  assert.match(examples, /'oauth-setup'/);
  assert.match(examples, /Google OAuth setup workflow/);
  assert.match(examples, /Ask for the app\/admin URL/);
  assert.match(examples, /Authorized redirect URIs/);
  assert.match(examples, /\/api\/auth\/google\/callback/);
  assert.match(examples, /enfyra_oauth_config/);
  assert.match(examples, /Do not ask the user to choose or type the callback URL manually/);
});

test('route creation tools report real route reload status instead of a hardcoded success flag', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /async function reloadRoutesResult\(\)/);
  assert.match(entry, /routeReload/);
  assert.doesNotMatch(entry, /routesReloaded:\s*true/);
});

test('column rule examples use the current value contract', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  assert.match(examples, /value: JSON\.stringify\(\{ v: "email" \}\)/);
  assert.doesNotMatch(examples, /ruleConfig: JSON\.stringify/);
});

test('query examples distinguish relation fields from deep relation query options', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  assert.match(examples, /Use fields with dotted relation paths when you only need scalar fields from related records/);
  assert.match(examples, /Use deep when relation loading needs query options such as filter, sort, limit, page, or nested deep/);
  assert.match(examples, /Do not use deep just to filter by a relation id/);
});

test('query guidance documents fields exclusion mode', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const schemaSkill = readFileSync(new URL('../.codex/skills/enfyra-mcp-schema-data/SKILL.md', import.meta.url), 'utf8');
  assert.match(examples, /fields=-compiledCode/);
  assert.match(examples, /fields=id,-compiledCode returns all readable fields except compiledCode/);
  assert.match(examples, /Dotted exclusions and deep relation fields use the same exclude-mode rule/);
  assert.match(schemaSkill, /`fields=-compiledCode` excludes that field/);
  assert.match(schemaSkill, /`fields=-owner\.avatar`/);
});

test('operator guidance avoids speculative warnings and physical FK generated code', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const dynamicSkill = readFileSync(new URL('../.codex/skills/enfyra-mcp-dynamic-code/SKILL.md', import.meta.url), 'utf8');
  const schemaSkill = readFileSync(new URL('../.codex/skills/enfyra-mcp-schema-data/SKILL.md', import.meta.url), 'utf8');
  assert.match(examples, /conversationId is accepted only as the room\/business identifier; persistence uses relation properties conversation and sender/);
  assert.match(examples, /Do not ask the client for senderId\. The sender relation is derived from @USER\.id/);
  assert.match(dynamicSkill, /`compiledCode` is generated from source and may differ textually/);
  assert.match(schemaSkill, /relation property names, not `relationId` fields/);
});

test('schema examples guide live types and relation mutation without stale update_table relation payloads', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');

  assert.match(examples, /Bulk schema creation with one-item-or-many arrays/);
  assert.match(examples, /amount.*type: "float"/s);
  assert.match(examples, /lookup: "<app_lookup_id>"/);
  assert.doesNotMatch(examples, /learning_/);
  assert.match(requiredKnowledge, /call get_schema_design_context first/);
  assert.match(examples, /create_tables creates tables\/columns first, then creates requested relations after all batch tables exist/);
  assert.doesNotMatch(examples, /update_tables\(\{[\s\S]*relations: JSON\.stringify/);
});

test('RLS guidance preserves caller projection and pagination', () => {
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');
  const requiredKnowledge = readFileSync(new URL('../src/lib/required-knowledge.ts', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(requiredKnowledge, /merge security filters into @QUERY\.filter/);
  assert.match(examples, /keep projection and pagination client-owned/);
  assert.match(entry, /preserve client-controlled query shape/);
  assert.match(entry, /pass through client fields\/deep\/sort\/page\/limit\/meta\/aggregate\/debugMode/);
});

test('normalizeRelationForTablePatch rejects physical FK column inputs', () => {
  assert.throws(
    () => normalizeRelationForTablePatch({
      targetTable: 1,
      type: 'many-to-one',
      propertyName: 'owner',
      foreignKeyColumn: 'owner_id',
    }),
    /foreignKeyColumn/
  );
});

test('relation normalization accepts common aliases and removes invalid one-to-many inverse payloads', () => {
  assert.equal(normalizeRelationType('many_to_one'), 'many-to-one');
  assert.equal(normalizeRelationType('oneToMany'), 'one-to-many');
  assert.throws(() => normalizeRelationType('belongs_to'), /Invalid relation type/);

  assert.deepEqual(
    normalizeRelationForTablePatch({
      targetTable: 'app_tasks',
      type: 'one_to_many',
      propertyName: 'tasks',
      mappedBy: 'project',
      inversePropertyName: 'project',
    }),
    {
      targetTable: 'app_tasks',
      type: 'one-to-many',
      propertyName: 'tasks',
      mappedBy: 'project',
    },
  );
});

test('delete_records defaults to cascade-tolerant not-found cleanup', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /skipNotFound: z\.boolean\(\)\.optional\(\)\.default\(true\)/);
  assert.match(entry, /skippedNotFoundCount/);
  assert.match(entry, /isNotFoundDeleteError/);
});

test('query_table normalizes quoted sort fields from weak clients', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /function normalizeSortParam/);
  assert.match(entry, /\.replace\(\/\^\(\['"\]\)\(\.\*\)\\1\$\/u, '\$2'\)/);
  assert.match(entry, /queryParams\.set\('sort', normalizedSort\)/);
});

test('sanitizeExistingRelationForTablePatch strips physical fields from metadata relations', () => {
  const relation = sanitizeExistingRelationForTablePatch({
    id: 159,
    targetTable: { id: 76, name: 'cloud_servers' },
    type: 'many-to-one',
    propertyName: 'host',
    mappedBy: null,
    isNullable: true,
    onDelete: 'SET NULL',
    foreignKeyColumn: 'hostId',
    referencedColumn: 'id',
    constraintName: 'fk_cloud_projects_hostId',
    junctionTableName: null,
    junctionSourceColumn: null,
    junctionTargetColumn: null,
  });

  assert.deepEqual(relation, {
    id: 159,
    targetTable: 76,
    type: 'many-to-one',
    propertyName: 'host',
    isNullable: true,
    onDelete: 'SET NULL',
  });
});

test('prepareRecordMutation rejects direct enfyra_relation physical FK inputs', async () => {
  await assert.rejects(
    () => prepareRecordMutation({
      fetchAPI: async () => ({ success: true, valid: true }),
      apiUrl: 'https://example.test/api',
      tables: [{
        name: 'enfyra_relation',
        columns: [
          { name: 'propertyName' },
          { name: 'type' },
          { name: 'foreignKeyColumn' },
        ],
        relations: [{ propertyName: 'targetTable' }],
      }],
      tableName: 'enfyra_relation',
      data: JSON.stringify({
        propertyName: 'owner',
        type: 'many-to-one',
        targetTable: { id: 1 },
        foreignKeyColumn: 'owner_id',
      }),
    }),
    /physical FK/
  );
});

test('validateMainTableRoutePath only allows mainTableId for canonical table routes', () => {
  const tables = [{ id: 12, name: 'orders' }];

  assert.equal(validateMainTableRoutePath(tables, '12', '/orders')?.name, 'orders');
  assert.throws(
    () => validateMainTableRoutePath(tables, '12', '/orders/stats'),
    /Omit mainTableId/
  );
  assert.throws(
    () => validateMainTableRoutePath(tables, '99', '/orders'),
    /Unknown table/
  );
});
