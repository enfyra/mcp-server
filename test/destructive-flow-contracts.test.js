import test from 'node:test';
import assert from 'node:assert/strict';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { deleteFlow, deleteFlowStep } from '../dist/lib/platform-flow-operations.js';
import { GLOBAL_RULES_ACK_KEY } from '../dist/lib/required-knowledge.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function flowFetchFixture({ isEnabled = false, nested = false } = {}) {
  const deleted = new Set();
  const requests = [];
  const fetch = async (url, options = {}) => {
    const urlText = String(url);
    const parsed = new URL(urlText);
    requests.push({ url: urlText, method: options.method || 'GET' });
    if (parsed.pathname.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    const match = parsed.pathname.match(/\/enfyra_(flow|flow_trigger|flow_step)(?:\/(\d+))?$/);
    if (match && options.method === 'DELETE') {
      deleted.add(`${match[1]}:${match[2]}`);
      return jsonResponse({ success: true, statusCode: 200 });
    }
    if (match?.[1] === 'flow') {
      return jsonResponse({ data: deleted.has('flow:7') ? [] : [{ id: 7, name: 'Usage flow', isEnabled }] });
    }
    if (match?.[1] === 'flow_trigger') {
      return jsonResponse({ data: deleted.has('flow_trigger:8') ? [] : [{ id: 8, type: 'schedule', isEnabled: false }] });
    }
    if (match?.[1] === 'flow_step') {
      const rows = [
        { id: 71, key: 'record_usage', type: 'script', stepOrder: 10, isEnabled: true, flow: { id: 7, name: 'Usage flow' } },
        ...(nested ? [{ id: 72, key: 'child_step', type: 'log', stepOrder: 20, isEnabled: true, flow: { id: 7, name: 'Usage flow' }, parent: { id: 71 } }] : []),
      ];
      return jsonResponse({ data: rows.filter((row) => !deleted.has(`flow_step:${row.id}`)) });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };
  return { fetch, requests };
}

test('delete_flow refuses confirmation while the flow is enabled', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = flowFetchFixture({ isEnabled: true });
  globalThis.fetch = fixture.fetch;
  resetTokens();
  initAuth('https://example.test/api', 'api-token');

  try {
    const preview = await deleteFlow('https://example.test/api', {
      flowId: 7,
      confirm: false,
    });
    assert.equal(preview.action, 'delete_flow_blocked_enabled');
    assert.match(preview.next, /Disable the flow/);
    await assert.rejects(
      () => deleteFlow('https://example.test/api', {
        flowId: 7,
        expectedFlowId: 7,
        confirm: true,
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /Cannot delete enabled flow/,
    );
    assert.equal(fixture.requests.some((request) => request.method === 'DELETE'), false);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('delete_flow removes disabled flow dependencies sequentially and verifies absence', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = flowFetchFixture({ isEnabled: false });
  globalThis.fetch = fixture.fetch;
  resetTokens();
  initAuth('https://example.test/api', 'api-token');

  try {
    const preview = await deleteFlow('https://example.test/api', {
      flowId: 7,
      confirm: false,
    });
    assert.equal(preview.action, 'delete_flow_preview');
    assert.equal(preview.flow.isEnabled, false);
    assert.deepEqual(preview.dependencies.triggers.map((trigger) => trigger.id), [8]);
    assert.deepEqual(preview.dependencies.steps.map((step) => step.id), [71]);

    const result = await deleteFlow('https://example.test/api', {
      flowId: 7,
      expectedFlowId: 7,
      expectedFlowName: 'Usage flow',
      confirm: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    assert.equal(result.action, 'flow_deleted');
    assert.equal(result.postcondition.confirmedAbsent, true);
    assert.deepEqual(
      fixture.requests.filter((request) => request.method === 'DELETE').map((request) => new URL(request.url).pathname),
      ['/api/enfyra_flow_trigger/8', '/api/enfyra_flow_step/71', '/api/enfyra_flow/7'],
    );
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('delete_flow_step requires the previewed id before physical deletion', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = flowFetchFixture({ isEnabled: true });
  globalThis.fetch = fixture.fetch;
  resetTokens();
  initAuth('https://example.test/api', 'api-token');

  try {
    const preview = await deleteFlowStep('https://example.test/api', {
      flowId: 7,
      stepId: 71,
      confirm: false,
    });
    assert.equal(preview.action, 'delete_flow_step_preview');
    await assert.rejects(
      () => deleteFlowStep('https://example.test/api', {
        flowId: 7,
        stepId: 71,
        confirm: true,
        globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
      }),
      /expectedStepId is required/,
    );
    assert.equal(fixture.requests.some((request) => request.method === 'DELETE'), false);
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('delete_flow_step deletes nested children before their parent', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = flowFetchFixture({ isEnabled: true, nested: true });
  globalThis.fetch = fixture.fetch;
  resetTokens();
  initAuth('https://example.test/api', 'api-token');

  try {
    const preview = await deleteFlowStep('https://example.test/api', {
      flowId: 7,
      stepId: 71,
      confirm: false,
    });
    assert.deepEqual(preview.dependencies.childSteps.map((step) => step.id), [72]);
    const result = await deleteFlowStep('https://example.test/api', {
      flowId: 7,
      stepId: 71,
      expectedFlowId: 7,
      expectedStepId: 71,
      confirm: true,
      globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    });
    assert.equal(result.action, 'flow_step_deleted');
    assert.deepEqual(
      fixture.requests.filter((request) => request.method === 'DELETE').map((request) => new URL(request.url).pathname),
      ['/api/enfyra_flow_step/72', '/api/enfyra_flow_step/71'],
    );
  } finally {
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});
