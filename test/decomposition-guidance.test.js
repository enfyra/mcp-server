import assert from 'node:assert/strict';
import test from 'node:test';

import { registerPlatformExtensionTools } from '../dist/lib/platform-extension-tools.js';
import { registerPlatformFlowTools } from '../dist/lib/platform-flow-tools.js';
import { registerPlatformResourceTools } from '../dist/lib/platform-resource-tools.js';
import { registerPlatformRouteTools } from '../dist/lib/platform-route-tools.js';
import { registerPlatformWebsocketTools } from '../dist/lib/platform-websocket-tools.js';
import { buildRequiredKnowledgePayload } from '../dist/lib/required-knowledge.js';
import { registerRouteDefinitionTools } from '../dist/lib/route-definition-tools.js';
import { registerScriptTools } from '../dist/lib/script-tools.js';

function createToolHarness() {
  const tools = new Map();
  return {
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
    description(name) {
      const tool = tools.get(name);
      assert.ok(tool, `Expected tool ${name} to be registered`);
      return tool.description;
    },
  };
}

test('required knowledge tells models how to decompose large dynamic code and extensions', () => {
  const dynamicKnowledge = buildRequiredKnowledgePayload('dynamic-code');
  const dynamicSection = dynamicKnowledge.dynamicServerCode.find((section) => section.id === 'dynamic-code-decomposition');
  assert.ok(dynamicSection);
  const dynamicRules = dynamicSection.rules.join('\n');
  assert.match(dynamicRules, /cohesion/i);
  assert.match(dynamicRules, /named pre-hooks.*named post-hooks/is);
  assert.match(dynamicRules, /flow steps/i);
  assert.match(dynamicRules, /websocket/i);
  assert.match(dynamicRules, /OAuth/i);
  assert.match(dynamicRules, /bootstrap/i);

  const extensionKnowledge = buildRequiredKnowledgePayload('extension');
  const extensionSection = extensionKnowledge.extensions.find((section) => section.id === 'extension-composition');
  assert.ok(extensionSection);
  const extensionRules = extensionSection.rules.join('\n');
  assert.match(extensionRules, /widget extensions/i);
  assert.match(extensionRules, /explicit props and events/i);
  assert.match(extensionRules, /page extension/i);
  assert.match(extensionRules, /global extension/i);
});

test('dynamic-code write tools surface decomposition guidance at the point of use', () => {
  const server = createToolHarness();
  registerPlatformRouteTools(server, 'https://example.test');
  registerRouteDefinitionTools(server, 'https://example.test');
  registerPlatformFlowTools(server, 'https://example.test');
  registerPlatformWebsocketTools(server, 'https://example.test');
  registerScriptTools(server, 'https://example.test');

  assert.match(server.description('api_endpoint_workflow'), /decompose/i);
  assert.match(server.description('create_handler'), /pre-hooks.*post-hooks.*flows/i);
  assert.match(server.description('create_pre_hook'), /one responsibility/i);
  assert.match(server.description('create_post_hook'), /one responsibility/i);
  assert.match(server.description('flow_workflow'), /one business operation per step/i);
  assert.match(server.description('ensure_script_flow_step'), /split/i);
  assert.match(server.description('ensure_websocket_gateway'), /connection lifecycle/i);
  assert.match(server.description('ensure_websocket_event'), /one event contract/i);
  assert.match(server.description('update_script_source'), /decompose/i);
});

test('extension write and builder tools surface widget composition guidance', () => {
  const server = createToolHarness();
  registerPlatformExtensionTools(server, 'https://example.test');
  registerPlatformResourceTools(server, 'https://example.test');

  assert.match(server.description('extension_workflow'), /split.*widget extensions/i);
  assert.match(server.description('update_extension_code'), /split.*widget extensions/i);
  assert.match(server.description('build_extension_widget'), /decompos/i);
  assert.match(server.description('ensure_page_extension'), /independent.*widget extensions/i);
  assert.match(server.description('ensure_widget_extension'), /focused.*widget/i);
});
