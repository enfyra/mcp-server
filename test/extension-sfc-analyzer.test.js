import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeExtensionSfc } from '../dist/lib/extension-sfc-analyzer.js';
import { reviewExtensionRuntimeContract, reviewExtensionUiContract, validateExtensionCodeLocally } from '../dist/lib/platform-operation-tools.js';

test('Vue SFC analyzer ignores fake tags in comments and reads multiline bound attributes', () => {
  const code = `<template>
  <!-- <UCard v-for="item in fakeItems"><button>Fake</button></UCard> -->
  <main class="eapp-page-constrained-wide">
    <CommonResourceListFrame
      :loading="pending && count > 0"
      :has-items="items.length > 0"
      empty-title="No items"
      :items-per-page="25"
      v-model:page="page"
    >
      <CommonResourceListItem v-for="item in items" :key="item.id" />
    </CommonResourceListFrame>
  </main>
</template>`;

  const analysis = analyzeExtensionSfc(code);
  assert.equal(analysis.valid, true);
  assert.equal(analysis.elements.filter((element) => element.tag === 'UCard').length, 0);
  const frame = analysis.elements.find((element) => element.tag === 'CommonResourceListFrame');
  assert.ok(frame);
  assert.equal(frame.attributes.some((attribute) => attribute.name === 'loading' && attribute.directive === 'bind'), true);
  assert.equal(frame.attributes.some((attribute) => attribute.name === 'page' && attribute.directive === 'model'), true);

  const review = reviewExtensionUiContract(code, { pattern: 'resource_list' });
  assert.equal(review.valid, true);
  assert.equal(review.issues.some((issue) => issue.rule === 'resource-list-ad-hoc-cards'), false);
  assert.equal(review.issues.some((issue) => issue.rule === 'native-button-type'), false);
});

test('Vue SFC analyzer detects semantic UI violations independent of attribute formatting', () => {
  const code = `<template>
  <section class="eapp-page-constrained-wide">
    <CommonModal
      v-model="open"
      :title="title + (count > 0 ? ' active' : '')"
    >
      <button @click="open = false">Close</button>
    </CommonModal>
  </section>
</template>`;

  const analysis = analyzeExtensionSfc(code);
  assert.equal(analysis.valid, true);
  const review = reviewExtensionUiContract(code);
  assert.equal(review.issues.some((issue) => issue.rule === 'common-modal-slots'), true);
  assert.equal(review.issues.some((issue) => issue.rule === 'native-button-type'), true);
  assert.equal(reviewExtensionRuntimeContract(code).issues.some((issue) => issue.rule === 'modal-open-model'), true);
  assert.throws(() => validateExtensionCodeLocally(code), /common-modal-slots/);
});

test('local extension validation fails closed on malformed SFC templates', () => {
  const code = '<template><section><UButton>Broken</section></template>';
  const analysis = analyzeExtensionSfc(code);
  assert.equal(analysis.valid, false);
  assert.ok(analysis.errors.length > 0);
  assert.throws(() => validateExtensionCodeLocally(code), /Invalid Vue SFC/);
});
