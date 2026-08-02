import type { RateLimitState, RateLimitDelayOptions } from './types.js';

export type { RateLimitState, RateLimitDelayOptions } from './types.js';

const states = new Map<string, RateLimitState>();
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_JITTER_MS = 250;

function stateKey(apiUrl: string, path: string): string {
  const routePath = path.split('?')[0] || '/';
  return `${apiUrl.replace(/\/$/, '')}:${routePath}`;
}

function parseNonNegativeNumber(value: string | null): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseResetAtMs(value: string | null): number | undefined {
  const parsed = parseNonNegativeNumber(value);
  if (parsed === undefined) return undefined;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

export function observeRateLimitHeaders(
  apiUrl: string,
  path: string,
  status: number,
  headers: Headers | undefined,
  nowMs: number = Date.now(),
): RateLimitState | undefined {
  if (!headers || typeof headers.get !== 'function') return undefined;

  const limit = parseNonNegativeNumber(headers.get('x-ratelimit-limit'));
  const remaining = parseNonNegativeNumber(headers.get('x-ratelimit-remaining'));
  const resetAtMs = parseResetAtMs(headers.get('x-ratelimit-reset'));
  const windowSeconds = parseNonNegativeNumber(headers.get('x-ratelimit-window'));
  const used = parseNonNegativeNumber(headers.get('x-ratelimit-used'));
  const scope = headers.get('x-ratelimit-scope') || headers.get('x-enfyra-guard-scope') || undefined;
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'), nowMs);

  if (
    limit === undefined &&
    remaining === undefined &&
    resetAtMs === undefined &&
    windowSeconds === undefined &&
    used === undefined &&
    scope === undefined &&
    retryAfterMs === undefined
  ) {
    return undefined;
  }

  const previous = states.get(stateKey(apiUrl, path));
  const state: RateLimitState = {
    ...previous,
    ...(limit !== undefined && { limit }),
    ...(remaining !== undefined && { remaining }),
    ...(resetAtMs !== undefined && { resetAtMs }),
    ...(windowSeconds !== undefined && { windowSeconds }),
    ...(scope !== undefined && { scope }),
    ...(used !== undefined && { used }),
    retryAfterMs: status === 429 ? retryAfterMs : undefined,
    observedAtMs: nowMs,
  };
  states.set(stateKey(apiUrl, path), state);
  return { ...state };
}

export function getRateLimitState(apiUrl: string, path: string): RateLimitState | undefined {
  const state = states.get(stateKey(apiUrl, path));
  return state ? { ...state } : undefined;
}

export function getRateLimitDelayMs(
  apiUrl: string,
  path: string,
  options: RateLimitDelayOptions = {},
): number {
  const state = states.get(stateKey(apiUrl, path));
  if (!state) return 0;

  const nowMs = options.nowMs ?? Date.now();
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const jitterCapMs = options.jitterMs ?? DEFAULT_JITTER_MS;
  const retryUntilMs = state.retryAfterMs === undefined
    ? undefined
    : state.observedAtMs + state.retryAfterMs;
  const resetRequired = state.remaining === 0 || state.retryAfterMs !== undefined;
  if (!resetRequired) return 0;

  const availableAtMs = Math.max(
    retryUntilMs ?? 0,
    state.resetAtMs ?? 0,
  );
  const remainingWaitMs = Math.max(0, availableAtMs - nowMs);
  if (remainingWaitMs === 0) return 0;

  const baseDelayMs = Math.min(remainingWaitMs, Math.max(0, maxDelayMs));
  const jitterRangeMs = Math.min(
    Math.max(0, jitterCapMs),
    Math.ceil(baseDelayMs * 0.1),
  );
  const jitter = jitterRangeMs > 0
    ? Math.floor(Math.max(0, Math.min(1, random())) * jitterRangeMs)
    : 0;
  return baseDelayMs + jitter;
}

export async function waitForRateLimitBudget(
  apiUrl: string,
  path: string,
  options: RateLimitDelayOptions = {},
): Promise<number> {
  const delayMs = getRateLimitDelayMs(apiUrl, path, options);
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  const key = stateKey(apiUrl, path);
  const state = states.get(key);
  if (state && typeof state.remaining === 'number' && state.remaining > 0) {
    state.remaining -= 1;
    if (typeof state.used === 'number') state.used += 1;
    states.set(key, state);
  }
  return delayMs;
}

export function clearRateLimitState(): void {
  states.clear();
}
