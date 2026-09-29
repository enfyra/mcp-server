import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequiredKnowledgePayload } from '../dist/lib/required-knowledge.js';
import { buildExtensionUiSnippet, reviewExtensionUiContract, validateExtensionCodeLocally } from '../dist/lib/platform-operation-tools.js';

function asExtension(template) {
  return `<template><section class="eapp-page-constrained-wide">${template}</section></template>`;
}

test('extension knowledge requires DataTable for information lists and describes its current footer contract', () => {
  const knowledge = JSON.stringify(buildRequiredKnowledgePayload('extension'));
  assert.match(knowledge, /must use DataTable/);
  assert.match(knowledge, /#footer/);
  assert.match(knowledge, /showColumnVisibility/);
  assert.match(knowledge, /10\/20\/50\/100/);
  assert.doesNotMatch(knowledge, /Reserve build_extension_ui kind=resource_list and CommonResourceListFrame\/Item/);
});

test('resource_list builder generates DataTable with server pagination inside its footer', () => {
  const result = buildExtensionUiSnippet('resource_list', {
    itemsExpression: 'orders',
    columnsExpression: 'orderColumns',
    loadingExpression: 'pending',
    pageExpression: 'currentPage',
    totalExpression: 'filteredTotal',
    itemsPerPageExpression: 'pageSize',
  });
  assert.match(result.snippet, /<DataTable/);
  assert.match(result.snippet, /:data="orders"/);
  assert.match(result.snippet, /:columns="orderColumns"/);
  assert.match(result.snippet, /:loading="pending"/);
  assert.match(result.snippet, /<template #footer>/);
  assert.match(result.snippet, /<USelect[^>]*v-model="pageSize"/);
  assert.match(result.snippet, /v-model:page="currentPage"/);
  assert.match(result.snippet, /:total="filteredTotal"/);
  assert.match(result.snippet, /:items-per-page="pageSize"/);
  assert.doesNotMatch(result.snippet, /CommonResourceList(?:Frame|Item)|<UTable/);
  assert.equal(reviewExtensionUiContract(asExtension(result.snippet), { pattern: 'resource_list' }).valid, true);
  assert.doesNotThrow(() => validateExtensionCodeLocally(asExtension(result.snippet), { uiPattern: 'resource_list' }));
});

test('resource_list rejects record rows even when they use the shared non-tabular frame', () => {
  const code = asExtension('<CommonResourceListFrame :loading="pending" :has-items="orders.length > 0" empty-title="No orders"><CommonResourceListItem v-for="order in orders" :key="order.id" :title="order.name" /></CommonResourceListFrame>');
  const review = reviewExtensionUiContract(code, { pattern: 'resource_list' });
  assert.equal(review.valid, false);
  assert.ok(review.issues.some((issue) => issue.rule === 'resource-list-table-required'));
  assert.throws(() => validateExtensionCodeLocally(code, { uiPattern: 'resource_list' }), /resource-list-table-required/);
});

test('DataTable list validation requires data, columns and loading bindings', () => {
  for (const prop of ['data', 'columns', 'loading']) {
    const template = '<DataTable :data="orders" :columns="columns" :loading="pending" />';
    const code = asExtension(template.replace(new RegExp(` :${prop}="[^"]*"`), ''));
    assert.equal(reviewExtensionUiContract(code, { pattern: 'resource_list' }).valid, false);
  }
});

test('bounded non-paginated lists still use DataTable without a pagination footer', () => {
  const result = buildExtensionUiSnippet('resource_list', { itemsPerPageExpression: '0' });
  assert.match(result.snippet, /<DataTable/);
  assert.doesNotMatch(result.snippet, /<template #footer>|<UPagination/);
});
