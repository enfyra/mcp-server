import { clearRuntimeCache } from './runtime-cache.js';

export const ENFYRA_PAT_HEADER = 'x-enfyra-pat';

let API_TOKEN = '';

export function initAuth(_apiUrl: string, apiToken: string = ''): void {
  API_TOKEN = apiToken;
  clearRuntimeCache();
}

export function getApiToken(): string {
  if (!API_TOKEN) throw new Error('ENFYRA_API_TOKEN required');
  return API_TOKEN;
}

export function getApiTokenHeaders(): Record<string, string> {
  return { [ENFYRA_PAT_HEADER]: getApiToken() };
}

export function resetTokens(): void {
  clearRuntimeCache('auth');
}
