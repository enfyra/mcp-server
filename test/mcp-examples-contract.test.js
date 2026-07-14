import test from 'node:test';
import assert from 'node:assert/strict';

import { EXAMPLE_CATEGORIES } from '../dist/lib/mcp-examples.js';
import { validateExtensionCodeLocally } from '../dist/lib/platform-operation-tools.js';

const WRITE_TOOLS = [
  'ensure_route_access',
  'public_route_methods',
  'private_route_methods',
  'ensure_route_rate_limit',
  'ensure_guard',
  'ensure_column_rule',
  'ensure_field_permission',
  'set_table_graphql',
  'create_records',
  'update_records',
  'delete_records',
  'create_tables',
  'update_tables',
  'create_columns',
  'update_columns',
  'create_relations',
  'delete_relations',
  'create_pre_hook',
  'create_post_hook',
  'ensure_menu',
  'ensure_page_extension',
  'ensure_global_extension',
  'ensure_widget_extension',
  'install_package',
];

function allExamples() {
  return Object.entries(EXAMPLE_CATEGORIES).flatMap(([category, value]) => (
    value.examples.map((example) => ({ category, ...example }))
  ));
}

function embeddedVueBlocks(source) {
  const blocks = [];
  const tick = String.fromCharCode(96);
  let index = 0;
  while ((index = source.indexOf(tick, index)) >= 0) {
    const end = source.indexOf(tick, index + 1);
    if (end < 0) break;
    const block = source.slice(index + 1, end);
    if (block.includes('<template') || block.includes('<script setup')) blocks.push(block);
    index = end + 1;
  }
  return blocks;
}

test('mutation examples include the required global acknowledgement', () => {
  for (const example of allExamples()) {
    const used = WRITE_TOOLS.filter((tool) => example.code.includes(`${tool}(`));
    if (!used.length) continue;
    assert.match(
      example.code,
      /globalRulesAckKey/,
      `${example.category}/${example.name} calls ${used.join(', ')} without globalRulesAckKey`,
    );
  }
});

test('embedded extension examples pass the local extension validator', () => {
  for (const example of EXAMPLE_CATEGORIES.extensions.examples) {
    const direct = example.code.trim();
    const blocks = [
      ...(direct.startsWith('<template') || direct.startsWith('<script') ? [direct] : []),
      ...embeddedVueBlocks(example.code),
    ];
    for (const block of blocks) {
      assert.doesNotThrow(
        () => validateExtensionCodeLocally(block),
        `${example.name} contains invalid extension code`,
      );
    }
  }
});

test('file and websocket examples use current runtime routes and lifecycle', () => {
  const fileExamples = JSON.stringify(EXAMPLE_CATEGORIES.files);
  const websocketExamples = JSON.stringify(EXAMPLE_CATEGORIES.websocket);
  assert.match(fileExamples, /\/enfyra\/enfyra_file/);
  assert.doesNotMatch(fileExamples, /\/enfyra\/files\/upload/);
  assert.doesNotMatch(websocketExamples, /@SOCKET\.join\(`user_/);
});

test('GraphQL has focused enablement and execution examples', () => {
  assert.ok(EXAMPLE_CATEGORIES.graphql);
  const content = JSON.stringify(EXAMPLE_CATEGORIES.graphql);
  assert.match(content, /set_table_graphql/);
  assert.match(content, /isEnabled/);
  assert.doesNotMatch(content, /set_table_graphql\(\{[^}]*\benabled:/s);
  assert.match(content, /test_graphql/);
});
