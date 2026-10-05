import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtensionUiSnippet, reviewExtensionUiContract, validateExtensionCodeLocally } from '../dist/lib/platform-operation-tools.js';
import { analyzeExtensionSfc } from '../dist/lib/extension-sfc-analyzer.js';
import { getExtensionThemeContract } from '../dist/lib/extension-theme-contract.js';

test('framed legacy surfaces are rejected because shell flattening erases their border and gutters', () => {
  const code = '<template><section><div class="eapp-surface-card border eapp-divider p-5">Requests</div></section></template>';
  assert.equal(reviewExtensionUiContract(code).issues.some(issue => issue.rule === 'flattened-surface-frame'), true);
  assert.throws(() => validateExtensionCodeLocally(code), /flattened-surface-frame/);
  assert.equal(reviewExtensionUiContract('<template><div class="eapp-bordered-region p-5">Requests</div></template>').valid, true);
});

test('top-level tabs require the shared header while secondary and overlay tabs remain supported', () => {
  const bare = '<template><section><UTabs :items="tabs" /></section></template>';
  assert.equal(reviewExtensionUiContract(bare).issues.some(issue => issue.rule === 'tabs-panel-header'), true);
  const owned = '<template><Panel :sections="tabs"><template #requests-header><UTabs :items="tabs" :content="false" /></template></Panel></template>';
  assert.equal(reviewExtensionUiContract(owned).valid, true);
  const secondary = '<template><UTabs variant="pill" data-secondary-navigation :items="tabs" /></template>';
  assert.equal(reviewExtensionUiContract(secondary).valid, true);
  assert.equal(reviewExtensionUiContract('<template><CommonModal><UTabs :items="tabs" /></CommonModal></template>').valid, true);
});

test('table-owned frames reject redundant wrappers without rejecting tab content', () => {
  const wrapped = '<template><div class="eapp-bordered-region p-5"><DataTable :data="rows" :columns="columns" :loading="pending" /></div></template>';
  assert.equal(reviewExtensionUiContract(wrapped).issues.some(issue => issue.rule === 'duplicate-data-frame'), true);
  const owned = '<template><Panel :sections="sections"><template #requests><DataTable :data="rows" :columns="columns" :loading="pending" /></template></Panel></template>';
  assert.equal(reviewExtensionUiContract(owned).valid, true);
});

test('action and field ownership distinguish page controls from managed overlays', () => {
  const page = '<template><section><UButton @click="send">Send notification</UButton></section></template>';
  assert.equal(reviewExtensionUiContract(page).issues.some(issue => issue.rule === 'page-action-header'), true);
  const compact = '<template><UInput data-compact /><CommonModal><UInput class="w-full" /><UButton>Save</UButton></CommonModal></template>';
  assert.equal(reviewExtensionUiContract(compact).issues.some(issue => issue.rule === 'page-action-header'), false);
  assert.equal(reviewExtensionUiContract(compact).issues.some(issue => issue.rule === 'modal-drawer-field-width'), false);
});

test('ancestor analysis ignores fake tags and guidance explains the actual neutral boundary', () => {
  const code = '<template><!-- <Panel> --><section><UTabs :items="tabs" /></section></template>';
  assert.deepEqual(analyzeExtensionSfc(code).elements.find(element => element.tag === 'UTabs').ancestors.map(item => item.tag), ['section']);
  assert.match(JSON.stringify(getExtensionThemeContract()), /eapp-surface-card.*flatten|flatten.*eapp-surface-card/);
  assert.doesNotMatch(JSON.stringify(getExtensionThemeContract()), /transparent background.*standalone forms/);
});

test('header builder keeps expression-based loading and disabled state reactive', () => {
  const built = buildExtensionUiSnippet('page_shell', { headerActions: [{ id: 'save', label: 'Save', loading: 'saving.value', disabled: '!dirty.value', onClick: 'save' }] });
  assert.match(built.snippet, /get loading\(\) \{ return saving\.value;/);
  assert.match(built.snippet, /get disabled\(\) \{ return !dirty\.value;/);
});

test('search toolbar has one bounded native control group and does not duplicate page or Columns chrome', () => {
  const built = buildExtensionUiSnippet('resource_list', { searchExpression: 'email', searchSubmitExpression: 'searchMembers', searchPlaceholder: 'Search by email', searchLabel: 'Member email' });
  assert.match(built.snippet, /<template #toolbar>/);
  assert.match(built.snippet, /@submit.prevent="searchMembers"/);
  assert.match(built.snippet, /<UFieldGroup class="w-full">/);
  assert.match(built.snippet, /<UInput[^>]*size="sm"/);
  assert.match(built.snippet, /:ui="\{ base: 'h-7 py-1' \}"/);
  assert.match(built.snippet, /<UButton[^>]*size="sm"/);
  assert.doesNotMatch(built.snippet, /<h[1-3]|Choose visible columns|>Columns</);
  assert.doesNotThrow(() => validateExtensionCodeLocally(`<template>${built.snippet}</template>`));
});

test('secondary tabs use native pills with theme active roles and no header underline', () => {
  const built = buildExtensionUiSnippet('tabs', { placement: 'secondary', model: 'usageTab', itemsExpression: 'usageTabs', content: false });
  assert.equal(built.component, 'UTabs');
  assert.match(built.snippet, /variant="pill" color="primary" data-secondary-navigation/);
  assert.match(built.snippet, /:content="false"/);
  assert.doesNotMatch(built.snippet, /:ui=|style=|var\(--|data-\[state=active\]/);
  assert.match(built.contract.join(' '), /eApp owns pill chrome globally/);
  assert.doesNotMatch(built.snippet, /<Panel|border-b(?!-0)/);
  assert.doesNotThrow(() => validateExtensionCodeLocally(`<template>${built.snippet}</template>`));
});

test('secondary tab chrome belongs to eApp rather than extension slot overrides', () => {
  const code = '<template><UTabs variant="pill" color="primary" data-secondary-navigation :items="tabs" :ui="{ indicator: \'bg-primary\' }" /></template>';
  assert.equal(reviewExtensionUiContract(code).issues.some(issue => issue.rule === 'tabs-chrome-ownership'), true);
});
