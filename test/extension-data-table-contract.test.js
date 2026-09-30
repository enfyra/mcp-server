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
  assert.match(knowledge, /paginationConfig/);
  assert.match(knowledge, /@load-more/);
  assert.match(knowledge, /mobile-only border-top/);
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
  assert.match(result.snippet, /:pagination-config="\{ total: filteredTotal, itemsPerPage: pageSize, showPageSize: true, loading: pending \}"/);
  assert.match(result.snippet, /@page-size-change="pageSize = \$event; currentPage = 1"/);
  assert.match(result.snippet, /v-model:page="currentPage"/);
  assert.doesNotMatch(result.snippet, /<USelect|<UPagination|border-t|max-md:!hidden/);
  assert.doesNotMatch(result.snippet, /CommonResourceList(?:Frame|Item)|<UTable/);
  assert.equal(reviewExtensionUiContract(asExtension(result.snippet), { pattern: 'resource_list' }).valid, true);
  assert.doesNotThrow(() => validateExtensionCodeLocally(asExtension(result.snippet), { uiPattern: 'resource_list' }));
});

test('resource_list cursor mode keeps page size and emits only Load more pagination actions', () => {
  const result = buildExtensionUiSnippet('resource_list', { paginationMode: 'cursor', itemsExpression: 'orders', hasMoreExpression: 'canLoadMore', loadMoreExpression: 'fetchNext', pageSizeChangeExpression: 'resetCursorSize' });
  assert.match(result.snippet, /mode: 'cursor'/);
  assert.match(result.snippet, /hasMore: canLoadMore/);
  assert.match(result.snippet, /@load-more="fetchNext"/);
  assert.match(result.snippet, /@page-size-change="resetCursorSize"/);
  assert.doesNotMatch(result.snippet, /v-model:page|<UPagination|<USelect/);
  assert.equal(reviewExtensionUiContract(asExtension(result.snippet), { pattern: 'resource_list' }).valid, true);
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
