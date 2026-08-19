import test from 'node:test';
import assert from 'node:assert/strict';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { registerRouteInspectionTools } from '../dist/lib/route-inspection-tools.js';

const API_URL = 'https://mcp-rest-test.test/api';

function createToolHarness() {
  const tools = new Map();
  return {
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
    get(name) {
      const tool = tools.get(name);
      assert.ok(tool, `Expected tool ${name} to be registered`);
      return tool;
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('test_rest_endpoint forwards an exact JSON body for POST gateway verification', async () => {
  const originalFetch = globalThis.fetch;
  const server = createToolHarness();
  const requests = [];

  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    requests.push({
      url: urlText,
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    return jsonResponse({ received: JSON.parse(String(options.body)) });
  };

  initAuth(API_URL, 'api-token');
  resetTokens();
  registerRouteInspectionTools(server, API_URL);

  const requestBody = JSON.stringify({
    model: 'gpt-5.6-terra',
    messages: [{ role: 'user', content: 'hello' }],
    service_tier: 'priority',
  });

  try {
    const result = await server.get('test_rest_endpoint').handler({
      method: 'POST',
      path: '/v1/chat/completions',
      body: requestBody,
    });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${API_URL}/v1/chat/completions`);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].body, requestBody);
    assert.equal(requests[0].headers['Content-Type'], 'application/json');
    assert.equal(payload.response.status, 200);
    assert.deepEqual(payload.response.body.received, JSON.parse(requestBody));
  } finally {
    globalThis.fetch = originalFetch;
    resetTokens();
  }
});

test('test_rest_endpoint omits request bodies for HEAD', async () => {
  const originalFetch = globalThis.fetch;
  const server = createToolHarness();
  let request;

  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    request = { method: options.method, body: options.body };
    return jsonResponse({ ok: true });
  };

  initAuth(API_URL, 'api-token');
  resetTokens();
  registerRouteInspectionTools(server, API_URL);

  try {
    await server.get('test_rest_endpoint').handler({
      method: 'HEAD',
      path: '/v1/chat/completions',
      body: '{"ignored":true}',
    });
    assert.deepEqual(request, { method: 'HEAD', body: undefined });
  } finally {
    globalThis.fetch = originalFetch;
    resetTokens();
  }
});
