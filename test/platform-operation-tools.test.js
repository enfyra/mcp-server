import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readEntrySource,
  readExamplesSource,
  readPlatformSource,
  readRoutingSource,
  readRuntimeZoneSource,
  readSchemaSource,
  readSourceFiles,
  readSourceTree,
} from '../test-support/source-tree.js';
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
  assert.ok(flowSourcePatch.primaryPath.some((step) => step.tool === 'search_runtime_zone'));
  assert.equal(flowSourcePatch.primaryPath.some((step) => step.tool === 'get_script_source'), false);
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
