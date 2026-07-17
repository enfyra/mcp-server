import { z } from 'zod';
import { fetchAPI } from './fetch.js';
import { assertGlobalRulesAck, globalRulesAckParam } from './required-knowledge.js';
import { jsonContent } from './response-format.js';
import type {
  OAuthProvider,
  OAuthProviderSetupInput,
  OAuthProviderToolDependencies,
} from './types.js';

const PROVIDERS = ['google', 'facebook', 'github'] as const;

const PROVIDER_CONSOLE_FIELDS: Record<OAuthProvider, string> = {
  google: 'Authorized redirect URIs',
  facebook: 'Valid OAuth Redirect URIs',
  github: 'Authorization callback URL',
};

function unwrapData(result: any): any[] {
  const data = result?.data ?? result;
  return Array.isArray(data) ? data : data ? [data] : [];
}

function recordId(record: any): string | number | null {
  return record?.id ?? record?._id ?? null;
}

function providerFilterPath(provider: OAuthProvider) {
  const filter = encodeURIComponent(JSON.stringify({ provider: { _eq: provider } }));
  const fields = 'id,_id,provider,redirectUri,appCallbackUrl,autoSetCookies,isEnabled';
  return `/enfyra_oauth_config?filter=${filter}&fields=${fields}&limit=1`;
}

export function buildOAuthCallbackUri(apiUrl: string, provider: OAuthProvider) {
  return `${apiUrl.replace(/\/$/, '')}/auth/${provider}/callback`;
}

export function registerOAuthProviderTools(
  server: any,
  apiUrl: string,
  dependencies: OAuthProviderToolDependencies = {},
) {
  const fetchApi = dependencies.fetchApi ?? fetchAPI;
  const requireGlobalRulesAck = dependencies.assertGlobalRulesAck ?? assertGlobalRulesAck;

  server.tool(
    'setup_oauth_provider',
    [
      'Create or update one built-in Enfyra OAuth provider only after the third app has been connected to Enfyra and the user has supplied its client credentials.',
      'The required appConnectionVerified=true input confirms that the framework proxy, OAuth start action, and /me session check were inspected or implemented before provider configuration.',
      'Do not ask the user for a callback URI: derive it from the connected Enfyra API target.',
      'The tool enables proxy-cookie mode, verifies the saved non-secret config and active runtime provider, and never returns client credentials.',
      'A successful call only saves the Enfyra side. Present the returned callbackUri for the provider console and stop until the user confirms it was added; setup is not complete before that confirmation and a successful OAuth login through the already connected app.',
    ].join(' '),
    {
      provider: z.enum(PROVIDERS).describe('OAuth provider. Infer it from the request when explicit; otherwise ask the user.'),
      clientId: z.string().min(1).describe('Provider client ID supplied in the current user request. Never infer it, read an old value, or write it into third-app source.'),
      clientSecret: z.string().min(1).describe('Provider client secret supplied in the current user request. Never read an old value, echo it, log it, or write it into third-app source.'),
      appConnectionVerified: z.literal(true).describe('Required proof gate. Set true only after the third app has been inspected and follows the Enfyra connect contract.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ provider, clientId, clientSecret, globalRulesAckKey }: OAuthProviderSetupInput) => {
      requireGlobalRulesAck(globalRulesAckKey);
      const callbackUri = buildOAuthCallbackUri(apiUrl, provider);
      const queryPath = providerFilterPath(provider);
      const existing = unwrapData(await fetchApi(apiUrl, queryPath))[0] ?? null;
      const config = {
        provider,
        clientId,
        clientSecret,
        redirectUri: callbackUri,
        autoSetCookies: true,
        appCallbackUrl: null,
        isEnabled: true,
      };
      const existingId = recordId(existing);
      const operation = existingId === null ? 'created' : 'updated';
      const mutationPath = existingId === null
        ? '/enfyra_oauth_config'
        : `/enfyra_oauth_config/${encodeURIComponent(String(existingId))}`;

      await fetchApi(apiUrl, mutationPath, {
        method: existingId === null ? 'POST' : 'PATCH',
        body: JSON.stringify(config),
      });

      const saved = unwrapData(await fetchApi(apiUrl, queryPath))[0] ?? null;
      const providers = unwrapData(await fetchApi(apiUrl, '/auth/providers'));
      const configPersisted = Boolean(
        saved
        && saved.provider === provider
        && saved.redirectUri === callbackUri
        && saved.autoSetCookies === true
        && saved.isEnabled === true,
      );
      const runtimeProviderActive = providers.some((item) => item?.provider === provider);
      const verified = configPersisted && runtimeProviderActive;
      const consoleField = PROVIDER_CONSOLE_FIELDS[provider];

      return jsonContent({
        action: 'oauth_provider_enfyra_config_saved',
        status: verified
          ? 'provider_console_action_required'
          : configPersisted
            ? 'runtime_verification_required'
            : 'configuration_verification_failed',
        setupComplete: false,
        provider,
        operation,
        config: {
          id: recordId(saved) ?? existingId,
          provider,
          redirectUri: saved?.redirectUri ?? callbackUri,
          autoSetCookies: saved?.autoSetCookies === true,
          appCallbackUrl: saved?.appCallbackUrl ?? null,
          isEnabled: saved?.isEnabled === true,
        },
        callbackUri,
        providerConsole: {
          field: consoleField,
          value: callbackUri,
          instruction: `Add this exact URI to ${consoleField} in the ${provider} developer console. Do not use the third-app return page as the provider callback.`,
          confirmationRequired: true,
        },
        verification: {
          configPersisted,
          runtimeProviderActive,
          providerConsoleConfirmed: false,
          providersEndpoint: '/auth/providers',
          credentialsReturned: false,
        },
        next: verified
          ? {
              instruction: 'Present callbackUri and providerConsole.field to the user, then stop and wait for confirmation that the URI was added in the provider console. Do not report OAuth setup as complete yet.',
              requiresUserConfirmation: true,
              afterConfirmation: 'Use the already connected third app OAuth button to complete a real provider login, then verify /me returns the authenticated user. Only then report OAuth setup as complete.',
            }
          : configPersisted
            ? {
              instruction: 'Verify runtime activation before asking the user to complete the provider console configuration.',
              requiresUserConfirmation: false,
              afterConfirmation: 'Once runtime activation is verified, present callbackUri and stop for provider-console confirmation before the real browser login test.',
              tool: 'test_rest_endpoint',
              input: { path: '/auth/providers', method: 'GET' },
            }
            : {
              instruction: 'Re-read the saved non-secret provider fields and resolve persistence before asking the user to configure the provider console.',
              requiresUserConfirmation: false,
              afterConfirmation: 'Once persistence and runtime activation are verified, present callbackUri and stop for provider-console confirmation before the real browser login test.',
              tool: 'query_table',
              input: {
                tableName: 'enfyra_oauth_config',
                filter: { provider: { _eq: provider } },
                fields: ['id', 'provider', 'redirectUri', 'autoSetCookies', 'appCallbackUrl', 'isEnabled'],
                limit: 1,
              },
            },
      });
    },
  );
}
