import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichRoute } from '../dist/lib/tool-route-inspection.js';
import { routeConfiguredMethods } from '../dist/lib/platform-route-operations.js';

const route = {
  id: 1,
  path: '/orders',
  availableMethods: [{ id: 10, name: 'GET' }],
  publicMethods: [{ id: 10, name: 'GET' }],
  methodConfigs: [
    { id: 21, method: { id: 10 }, available: false, isPublic: true, skipRoleGuard: true, timeout: 2000 },
    { id: 22, method: { id: 11 }, available: true, isPublic: true, skipRoleGuard: false, timeout: 7000 },
  ],
};

test('route method projection ignores stale legacy arrays and disabled public flags', () => {
  const state = {
    handlers: [{ id: 42, route: { id: 1 }, method: { id: 11 }, timeout: 9999, sourceCode: 'return 1' }],
    preHooks: [], postHooks: [], routePermissions: [], guards: [], guardRules: [],
    methodIdNameMap: { 10: 'GET', 11: 'POST' },
  };
  const result = enrichRoute(route, state);
  assert.deepEqual(result.availableMethods.map((method) => method.name), ['POST']);
  assert.deepEqual(result.publicMethods.map((method) => method.name), ['POST']);
  assert.deepEqual(result.skipRoleGuardMethods, []);
  assert.equal(result.handlers[0].timeout, 7000);
  assert.deepEqual(routeConfiguredMethods(result, 'available'), ['POST']);
  assert.deepEqual(routeConfiguredMethods(result, 'isPublic'), ['POST']);
});
