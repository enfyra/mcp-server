import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getToolContract,
  installToolAnnotations,
  isCatalogExecutable,
} from '../dist/lib/tool-contracts.js';

test('tool contracts distinguish reads, mutations, destructive operations, and local builders', () => {
  assert.deepEqual(getToolContract('query_table').annotations, {
    title: 'Query Table',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(getToolContract('delete_records').annotations.readOnlyHint, false);
  assert.equal(getToolContract('delete_records').annotations.destructiveHint, true);
  assert.equal(getToolContract('create_handler').annotations.idempotentHint, false);
  assert.equal(getToolContract('build_extension_drawer').annotations.openWorldHint, false);
  assert.equal(getToolContract('build_extension_drawer').annotations.readOnlyHint, true);
  assert.equal(getToolContract('validate_dynamic_script').annotations.openWorldHint, true);
  assert.equal(getToolContract('validate_extension_code').annotations.openWorldHint, true);
});

test('only hidden read-only non-destructive tools can execute through the catalog gateway', () => {
  assert.equal(isCatalogExecutable('build_extension_drawer'), true);
  assert.equal(isCatalogExecutable('review_extension_ui_contract'), true);
  assert.equal(isCatalogExecutable('create_route'), false);
  assert.equal(isCatalogExecutable('reload_all'), false);
  assert.equal(isCatalogExecutable('delete_route'), false);
});

test('annotation installer adds a complete annotation contract to legacy tool registrations', () => {
  const registrations = [];
  const server = {
    tool(...args) {
      registrations.push(args);
      return { name: args[0] };
    },
  };
  installToolAnnotations(server);
  server.tool('query_table', 'Query', {}, async () => null);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].length, 5);
  assert.deepEqual(registrations[0][3], getToolContract('query_table').annotations);
});
