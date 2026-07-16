import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCreateHandlerRouteBoundary,
  assertCustomEndpointRoute,
  extractExplicitRepositoryTableNames,
  reviewDynamicEndpointContract,
} from '../dist/lib/dynamic-endpoint-contract.js';

test('low-level create_handler cannot bypass canonical route boundaries', () => {
  assert.doesNotThrow(() => assertCreateHandlerRouteBoundary(
    { path: '/integrations/orders', mainTable: null },
    'return await #secure.orders.find({ limit: 1 })',
  ));
  assert.throws(() => assertCreateHandlerRouteBoundary(
    { path: '/orders', mainTable: { name: 'orders' } },
    'return await #secure.orders.find({ limit: 1 })',
  ), /allowCanonicalRoute=true/i);
  assert.throws(() => assertCreateHandlerRouteBoundary(
    { path: '/orders', mainTable: { name: 'orders' } },
    'return await #secure.orders.find({ limit: 1 })',
    true,
  ), /must use @REPOS\.main/i);
  assert.doesNotThrow(() => assertCreateHandlerRouteBoundary(
    { path: '/orders', mainTable: { name: 'orders' } },
    'return await @REPOS.main.find({ limit: 1 })',
    true,
  ));
});

test('custom endpoint review blocks @REPOS.main because custom routes have no main table', () => {
  const review = reviewDynamicEndpointContract({
    routeKind: 'custom',
    method: 'POST',
    sourceCode: 'return await @REPOS.main.create({ data: @BODY })',
  });

  assert.equal(review.status, 'blocked');
  assert.deepEqual(review.errorCodes, ['custom_route_main_repository']);
  assert.throws(() => assertCustomEndpointRoute({ path: '/orders/submit', mainTable: { name: 'orders' } }), /canonical table route/i);
});

test('custom endpoint review preserves TypeORM-style raw body with a secure explicit repository', () => {
  const review = reviewDynamicEndpointContract({
    routeKind: 'custom',
    method: 'POST',
    sourceCode: `return await #secure.orders.create({
  data: {
    ...@BODY,
    owner: @USER.id
  }
})`,
  });

  assert.equal(review.status, 'ready');
  assert.equal(review.signals.usesRawBody, true);
  assert.equal(review.signals.usesSecureExplicitRepository, true);
  assert.ok(review.infoCodes.includes('typeorm_partial_body'));
  assert.ok(review.infoCodes.includes('custom_body_validation_boundary'));
});

test('custom endpoint review flags trusted repositories and raw trusted output without blocking internal use', () => {
  const review = reviewDynamicEndpointContract({
    routeKind: 'custom',
    method: 'POST',
    sourceCode: `const result = await #enfyra_user.create({ data: @BODY })
return result.data?.[0] ?? null`,
    tableMetadata: {
      enfyra_user: {
        columns: [
          { name: 'id', isPrimary: true, isUpdatable: false },
          { name: 'status', isUpdatable: false },
        ],
      },
    },
  });

  assert.equal(review.status, 'review_required');
  assert.ok(review.warningCodes.includes('trusted_repository_bypass'));
  assert.ok(review.warningCodes.includes('raw_trusted_repository_output'));
  assert.match(review.verification.join(' '), /Do not change isUpdatable/i);
});

test('custom endpoint review summarizes exact metadata properties without inferring business ownership', () => {
  const review = reviewDynamicEndpointContract({
    routeKind: 'custom',
    method: 'PATCH',
    sourceCode: 'return await #secure.orders.update({ id: @PARAMS.id, data: @BODY })',
    tableMetadata: {
      orders: {
        name: 'orders',
        columns: [
          { name: 'id', isPrimary: true, isPublished: true, isUpdatable: false },
          { name: 'title', isPublished: true, isUpdatable: true },
          { name: 'secret', isPublished: false, isUpdatable: true, isEncrypted: true },
        ],
        relations: [
          { propertyName: 'owner', isPublished: true },
          { propertyName: 'auditEntries', isPublished: false },
        ],
      },
    },
  });

  assert.deepEqual(review.metadata.orders, {
    primaryFields: ['id'],
    publishedUpdatableFields: ['title'],
    unpublishedFields: ['secret'],
    nonUpdatableFields: ['id'],
    encryptedFields: ['secret'],
    publishedRelations: ['owner'],
    unpublishedRelations: ['auditEntries'],
  });
  assert.doesNotMatch(JSON.stringify(review), /owner.*must|tenant.*must/i);
});

test('repository table extraction is bounded to explicit secure and trusted repositories', () => {
  assert.deepEqual(
    extractExplicitRepositoryTableNames(`
      await #secure.orders.find({ limit: 1 })
      await @REPOS.secure.customers.find({ limit: 1 })
      await #audit_log.create({ data: {} })
      await @REPOS.main.find({ limit: 1 })
      await #secure.orders.update({ id: 1, data: {} })
    `),
    ['orders', 'customers', 'audit_log'],
  );
});
