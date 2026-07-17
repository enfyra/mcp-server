import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOAuthCallbackUri,
  registerOAuthProviderTools,
} from '../dist/lib/oauth-tools.js';

function createHarness({ existing = null, runtimeProviders = ['google'], persisted = true } = {}) {
  let handler;
  let inputSchema;
  const calls = [];
  const server = {
    tool(name, _description, schema, registeredHandler) {
      if (name === 'setup_oauth_provider') {
        handler = registeredHandler;
        inputSchema = schema;
      }
      return { enabled: true };
    },
  };
  const saved = {
    id: existing?.id ?? 41,
    provider: 'google',
    redirectUri: 'https://demo.enfyra.io/api/auth/google/callback',
    appCallbackUrl: null,
    autoSetCookies: persisted,
    isEnabled: persisted,
  };
  const fetchApi = async (_baseUrl, path, init = {}) => {
    calls.push({ path, init });
    if (path === '/auth/providers') {
      return { data: runtimeProviders.map((provider) => ({ provider })) };
    }
    if (path.startsWith('/enfyra_oauth_config?')) {
      const queryCount = calls.filter((call) => call.path.startsWith('/enfyra_oauth_config?')).length;
      return { data: queryCount === 1 && existing ? [existing] : queryCount === 1 ? [] : [saved] };
    }
    if (path === '/enfyra_oauth_config' && init.method === 'POST') return { data: [saved] };
    if (path === `/enfyra_oauth_config/${saved.id}` && init.method === 'PATCH') return { data: [saved] };
    throw new Error(`Unexpected request ${init.method || 'GET'} ${path}`);
  };

  registerOAuthProviderTools(server, 'https://demo.enfyra.io/api', {
    fetchApi,
    assertGlobalRulesAck: () => {},
  });
  return { calls, inputSchema, invoke: (input) => handler(input) };
}

test('buildOAuthCallbackUri derives the provider callback from the Enfyra API target', () => {
  assert.equal(
    buildOAuthCallbackUri('https://demo.enfyra.io/api/', 'google'),
    'https://demo.enfyra.io/api/auth/google/callback',
  );
});

test('setup_oauth_provider seeds Google config and returns a secret-free provider handoff', async () => {
  const { calls, inputSchema, invoke } = createHarness();
  assert.equal(inputSchema.appConnectionVerified.safeParse(true).success, true);
  assert.equal(inputSchema.appConnectionVerified.safeParse(false).success, false);
  const result = await invoke({
    provider: 'google',
    clientId: 'google-client-id',
    clientSecret: 'google-client-secret',
    appConnectionVerified: true,
    globalRulesAckKey: 'ack',
  });
  const payload = JSON.parse(result.content[0].text);

  const createCall = calls.find((call) => call.init.method === 'POST');
  assert.deepEqual(JSON.parse(createCall.init.body), {
    provider: 'google',
    clientId: 'google-client-id',
    clientSecret: 'google-client-secret',
    redirectUri: 'https://demo.enfyra.io/api/auth/google/callback',
    autoSetCookies: true,
    appCallbackUrl: null,
    isEnabled: true,
  });
  assert.equal(payload.action, 'oauth_provider_enfyra_config_saved');
  assert.equal(payload.status, 'provider_console_action_required');
  assert.equal(payload.setupComplete, false);
  assert.equal(payload.operation, 'created');
  assert.equal(payload.callbackUri, 'https://demo.enfyra.io/api/auth/google/callback');
  assert.equal(payload.providerConsole.field, 'Authorized redirect URIs');
  assert.equal(payload.providerConsole.confirmationRequired, true);
  assert.equal(payload.verification.configPersisted, true);
  assert.equal(payload.verification.runtimeProviderActive, true);
  assert.equal(payload.verification.providerConsoleConfirmed, false);
  assert.equal(payload.next.requiresUserConfirmation, true);
  assert.match(payload.next.instruction, /present.*callbackUri.*stop.*wait/i);
  assert.match(payload.next.afterConfirmation, /oauth button.*\/me/i);
  assert.equal(payload.next.tool, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /google-client-secret|google-client-id/);
});

test('setup_oauth_provider updates the existing provider instead of creating a duplicate', async () => {
  const { calls, invoke } = createHarness({
    existing: { id: 9, provider: 'google', redirectUri: 'https://old.example/callback' },
  });
  const result = await invoke({
    provider: 'google',
    clientId: 'new-client-id',
    clientSecret: 'new-client-secret',
    appConnectionVerified: true,
    globalRulesAckKey: 'ack',
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.operation, 'updated');
  assert.ok(calls.some((call) => call.path === '/enfyra_oauth_config/9' && call.init.method === 'PATCH'));
  assert.equal(calls.some((call) => call.init.method === 'POST'), false);
});

test('setup_oauth_provider reports when persisted config is not active in runtime yet', async () => {
  const { invoke } = createHarness({ runtimeProviders: [] });
  const result = await invoke({
    provider: 'google',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    appConnectionVerified: true,
    globalRulesAckKey: 'ack',
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.status, 'runtime_verification_required');
  assert.equal(payload.setupComplete, false);
  assert.equal(payload.verification.configPersisted, true);
  assert.equal(payload.verification.runtimeProviderActive, false);
  assert.match(payload.next.instruction, /verify runtime activation/i);
  assert.equal(payload.next.tool, 'test_rest_endpoint');
  assert.deepEqual(payload.next.input, { path: '/auth/providers', method: 'GET' });
  assert.notEqual(payload.next.tool, 'setup_oauth_provider');
});

test('setup_oauth_provider returns a non-secret read path when persistence verification fails', async () => {
  const { invoke } = createHarness({ persisted: false });
  const result = await invoke({
    provider: 'google',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    appConnectionVerified: true,
    globalRulesAckKey: 'ack',
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.status, 'configuration_verification_failed');
  assert.equal(payload.verification.configPersisted, false);
  assert.equal(payload.next.tool, 'query_table');
  assert.deepEqual(payload.next.input.fields, [
    'id',
    'provider',
    'redirectUri',
    'autoSetCookies',
    'appCallbackUrl',
    'isEnabled',
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /client-id|client-secret/);
});
