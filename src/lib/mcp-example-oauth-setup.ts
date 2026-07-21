export const oauthSetupExamples = {
    title: 'OAuth provider setup',
    useWhen: 'Use only after the third app follows the connect contract and the user is ready to supply Google, Facebook, or GitHub client credentials.',
    examples: [
      {
        name: 'Configure the provider and hand off its callback',
        code: `setup_oauth_provider({
  provider: "google",
  clientId: "<user-supplied-client-id>",
  clientSecret: "<user-supplied-client-secret>",
  appConnectionVerified: true,
  globalRulesAckKey: "<globalRulesAckKey>",
})`,
        notes: [
          'Connect the third app before asking for provider credentials. Load category=connect, inspect its framework, and verify the proxy, OAuth start action, cookieBridgePrefix, and /me flow first.',
          'After the connection is verified, stop and ask the user to supply provider, clientId, and clientSecret. Never read or reuse stored credential values, never infer credentials, and never ask the user for a callback URI.',
          'Do not present callbackUri or ask the user to configure the provider console before setup_oauth_provider returns its receipt. If credentials are missing, ask only for clientId and clientSecret and stop.',
          'appConnectionVerified=true is required and may be sent only after that app connection check.',
          'setup_oauth_provider derives callbackUri from the connected Enfyra API target, upserts enfyra_oauth_config, enables autoSetCookies, verifies runtime activation, and returns no credentials.',
          'The receipt has setupComplete=false. Present providerConsole.value exactly as returned, ask the user to add it to providerConsole.field, then stop and wait for confirmation.',
          'After confirmation, use the OAuth button in the already connected app and verify /me before reporting setup success.',
        ],
      },
      {
        name: 'Provider console handoff',
        code: `// Use the successful setup_oauth_provider receipt.
const callback = result.callbackUri

// Google: Authorized redirect URIs
// Facebook: Valid OAuth Redirect URIs
// GitHub: Authorization callback URL`,
        notes: [
          'The provider callback is an Enfyra API URL, not the third-app return page.',
          'If runtimeProviderActive is false, resolve verification before sending the user to the provider console.',
          'Neither /auth/providers nor an existing linked OAuth account proves the provider console callback or current credentials work; complete a real browser login after confirmation.',
          'Never echo clientId or clientSecret in the handoff.',
        ],
      },
    ],
  };
