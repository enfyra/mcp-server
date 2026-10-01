import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequiredKnowledgePayload } from '../dist/lib/required-knowledge.js';
import { getExtensionThemeContract } from '../dist/lib/extension-theme-contract.js';
import { buildExtensionUiSnippet, reviewExtensionUiContract, validateExtensionCodeLocally } from '../dist/lib/platform-operation-tools.js';

test('extension guidance follows centered native shell layout and native table loading', () => {
  const guidance = JSON.stringify([buildRequiredKnowledgePayload('extension'), getExtensionThemeContract()]);
  assert.match(guidance, /80rem/);
  assert.match(guidance, /centered/);
  assert.match(guidance, /native UTable loading/);
  assert.match(guidance, /TabbedPanel/);
  assert.doesNotMatch(guidance, /full-bleed by default|stay left-aligned|280px|owns initial skeletons/);
});

test('tabs builder uses the registered shared panel without duplicating its border or tab chrome', () => {
  const built = buildExtensionUiSnippet('tabs', { model: 'selectedTab', itemsExpression: 'sections', body: '<p>{{ item.label }}</p>' });
  assert.equal(built.component, 'TabbedPanel');
  assert.match(built.snippet, /<TabbedPanel v-model="selectedTab" :items="sections"/);
  assert.match(built.snippet, /<template #content="\{ item \}">/);
  assert.doesNotMatch(built.snippet, /<UCard|<UTabs|border-b|rounded-/);
  assert.doesNotThrow(() => validateExtensionCodeLocally(`<template>${built.snippet}</template>`));
});

test('information-list guidance uses the shared footer and all request states', () => {
  const built = buildExtensionUiSnippet('resource_list', {});
  assert.match(JSON.stringify(built.contract), /native UTable loading/);
  assert.doesNotMatch(JSON.stringify(built.contract), /first-load skeletons/);
  const review = reviewExtensionUiContract('<template><UTable :data="records" /></template>', { pattern: 'resource_list' });
  assert.match(JSON.stringify(review.issues), /paginationConfig/);
  assert.doesNotMatch(JSON.stringify(review.issues), /inside #footer/);
});

test('visual grids inherit transparent native card chrome instead of duplicating its frame', () => {
  const built = buildExtensionUiSnippet('resource_grid', {});
  assert.match(built.snippet, /<UCard[^>]*class="h-full">/);
  assert.doesNotMatch(built.snippet, /eapp-surface-card|eapp-radius-panel|border eapp-divider/);
});
