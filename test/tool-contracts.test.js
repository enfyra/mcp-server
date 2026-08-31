import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getToolContract,
  installToolAnnotations,
  isCatalogExecutable,
} from '../dist/lib/tool-contracts.js';
import { destructiveToolInputsMatch } from '../dist/lib/session-safety.js';

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
  assert.equal(getToolContract('delete_flow').annotations.destructiveHint, true);
  assert.equal(getToolContract('delete_flow_step').annotations.destructiveHint, true);
  assert.equal(getToolContract('delete_route_hook').annotations.destructiveHint, true);
  assert.equal(getToolContract('delete_route_permission').annotations.destructiveHint, true);
  assert.equal(getToolContract('delete_extension').annotations.destructiveHint, true);
  assert.equal(getToolContract('delete_menu').annotations.destructiveHint, true);
  assert.equal(getToolContract('create_handler').annotations.idempotentHint, false);
  assert.equal(getToolContract('build_extension_drawer').annotations.openWorldHint, false);
  assert.equal(getToolContract('build_extension_drawer').annotations.readOnlyHint, true);
  assert.equal(getToolContract('validate_dynamic_script').annotations.openWorldHint, true);
  assert.equal(getToolContract('validate_extension_code').annotations.openWorldHint, true);
});

test('the catalog gateway executes curated guided tools but keeps low-level escape hatches hidden', () => {
  assert.equal(isCatalogExecutable('create_tables'), true);
  assert.equal(isCatalogExecutable('delete_tables'), true);
  assert.equal(isCatalogExecutable('query_table'), true);
  assert.equal(isCatalogExecutable('build_extension_drawer'), false);
  assert.equal(isCatalogExecutable('review_extension_ui_contract'), false);
  assert.equal(isCatalogExecutable('create_route'), false);
  assert.equal(isCatalogExecutable('reload_all'), false);
  assert.equal(getToolContract('execute_enfyra_tool').annotations.readOnlyHint, false);
  assert.equal(getToolContract('execute_enfyra_tool').annotations.destructiveHint, true);
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

test('flow destructive confirmation fingerprints ignore preview-only expected ids and names', () => {
  assert.equal(destructiveToolInputsMatch(
    { flowId: 7, confirm: false },
    { flowId: 7, expectedFlowId: 7, expectedFlowName: 'Usage flow', confirm: true },
  ), true);
  assert.equal(destructiveToolInputsMatch(
    { flowId: 7, stepId: 71, confirm: false },
    { flowId: 7, stepId: 71, expectedFlowId: 7, expectedStepId: 71, confirm: true },
  ), true);
  assert.equal(destructiveToolInputsMatch(
    { id: 16, confirm: false },
    { id: 16, expectedExtensionId: 16, confirm: true },
  ), true);
  assert.equal(destructiveToolInputsMatch(
    { menuId: 24, confirm: false },
    { menuId: 24, expectedMenuId: 24, confirm: true },
  ), true);
});
