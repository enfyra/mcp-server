import test from 'node:test';
import assert from 'node:assert/strict';

import { assessPermissionExposure } from '../dist/lib/permission-exposure.js';

test('hidden UI with server authority is blocked and severity is assessed', () => {
  const result = assessPermissionExposure({
    uiVisible: false,
    serverAllowed: true,
    dataClassification: 'internal',
  });

  assert.equal(result.finding, 'hidden_server_authority');
  assert.equal(result.risk, 'high');
  assert.equal(result.blocked, true);
  assert.equal(result.requiresExplicitReview, true);
});

test('public server authority for sensitive data is critical even when UI is visible', () => {
  const result = assessPermissionExposure({
    uiVisible: true,
    serverAllowed: true,
    serverPublic: true,
    dataClassification: 'sensitive',
  });

  assert.equal(result.finding, 'public_sensitive_authority');
  assert.equal(result.risk, 'critical');
  assert.equal(result.blocked, true);
});

test('visible UI with a backend 403 remains an allowed low-risk boundary', () => {
  const result = assessPermissionExposure({
    uiVisible: true,
    serverAllowed: false,
  });

  assert.equal(result.finding, 'visible_server_denied');
  assert.equal(result.risk, 'low');
  assert.equal(result.blocked, false);
});

test('hidden UI with denied server access is aligned', () => {
  const result = assessPermissionExposure({
    uiVisible: false,
    serverAllowed: false,
  });

  assert.equal(result.finding, 'aligned');
  assert.equal(result.risk, 'none');
  assert.equal(result.blocked, false);
});
