import test from 'node:test';
import assert from 'node:assert/strict';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { fetchAPI, RateLimitEncounteredError } from '../dist/lib/fetch.js';
import {
  clearRateLimitState,
  getRateLimitDelayMs,
  getRateLimitState,
  observeRateLimitHeaders,
  waitForRateLimitBudget,
} from '../dist/lib/rate-limit-state.js';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('rate-limit state parses successful response quota headers for proactive pacing', () => {
  clearRateLimitState();
  const nowMs = 1_785_690_473_000;
  observeRateLimitHeaders(
    'https://example.test/api',
    '/orders?limit=10',
    200,
    new Headers({
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Remaining': '80',
      'X-RateLimit-Reset': '1785690533000',
      'X-RateLimit-Window': '60',
      'X-RateLimit-Scope': 'ip',
      'X-RateLimit-Used': '20',
    }),
    nowMs,
  );

  assert.deepEqual(
    getRateLimitState('https://example.test/api', '/orders?limit=20'),
    {
      limit: 100,
      remaining: 80,
      resetAtMs: 1_785_690_533_000,
      windowSeconds: 60,
      scope: 'ip',
      used: 20,
      retryAfterMs: undefined,
      observedAtMs: nowMs,
    },
  );
  assert.equal(
    getRateLimitDelayMs('https://example.test/api', '/orders?limit=10', {
      nowMs,
      random: () => 0.5,
    }),
    0,
  );
});

test('rate-limit state reserves known remaining quota before concurrent request send', async () => {
  clearRateLimitState();
  const nowMs = 1_785_690_473_000;
  observeRateLimitHeaders(
    'https://example.test/api',
    '/orders',
    200,
    new Headers({
      'X-RateLimit-Limit': '5',
      'X-RateLimit-Remaining': '2',
      'X-RateLimit-Reset': String(nowMs + 60_000),
      'X-RateLimit-Used': '3',
    }),
    nowMs,
  );

  await waitForRateLimitBudget('https://example.test/api', '/orders', { nowMs });

  assert.equal(getRateLimitState('https://example.test/api', '/orders')?.remaining, 1);
  assert.equal(getRateLimitState('https://example.test/api', '/orders')?.used, 4);
});

test('rate-limit state returns bounded jittered delay when remaining quota is zero', () => {
  clearRateLimitState();
  const nowMs = 1_785_690_473_000;
  observeRateLimitHeaders(
    'https://example.test/api',
    '/orders',
    429,
    new Headers({
      'Retry-After': '4',
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(nowMs + 4_000),
    }),
    nowMs,
  );

  assert.equal(
    getRateLimitDelayMs('https://example.test/api', '/orders', {
      nowMs,
      maxDelayMs: 5_000,
      jitterMs: 250,
      random: () => 0.5,
    }),
    4_125,
  );
});

test('rate-limit wait repeats bounded sleeps until the advertised retry window has elapsed', async () => {
  clearRateLimitState();
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let nowMs = 1_785_690_473_000;
  const sleeps = [];

  Date.now = () => nowMs;
  globalThis.setTimeout = (callback, delay) => {
    sleeps.push(delay);
    nowMs += delay;
    callback();
    return 0;
  };

  try {
    observeRateLimitHeaders(
      'https://example.test/api',
      '/orders',
      429,
      new Headers({
        'Retry-After': '12',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(nowMs + 12_000),
      }),
      nowMs,
    );

    const waitedMs = await waitForRateLimitBudget(
      'https://example.test/api',
      '/orders',
      { maxDelayMs: 5_000, jitterMs: 0 },
    );

    assert.deepEqual(sleeps, [5_000, 5_000, 2_000]);
    assert.equal(waitedMs, 12_000);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    clearRateLimitState();
  }
});

test('fetchAPI reads 429 headers, retries once, and updates cached quota from success', async () => {
  const originalFetch = globalThis.fetch;
  let routeCalls = 0;

  globalThis.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'jwt-rate-limit', expTime: Date.now() + 60_000 });
    }
    if (urlText.endsWith('/orders')) {
      routeCalls += 1;
      if (routeCalls === 1) {
        return jsonResponse(
          { error: { code: 'RATE_LIMIT_EXCEEDED' } },
          429,
          {
            'Retry-After': '0',
            'X-RateLimit-Limit': '5',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Date.now()),
            'X-RateLimit-Window': '60',
            'X-RateLimit-Scope': 'ip',
            'X-RateLimit-Used': '5',
          },
        );
      }
      return jsonResponse(
        { data: [{ id: 1 }] },
        200,
        {
          'X-RateLimit-Limit': '5',
          'X-RateLimit-Remaining': '4',
          'X-RateLimit-Reset': String(Date.now() + 60_000),
          'X-RateLimit-Window': '60',
          'X-RateLimit-Scope': 'ip',
          'X-RateLimit-Used': '1',
        },
      );
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    clearRateLimitState();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');

    const result = await fetchAPI('https://example.test/api', '/orders');

    assert.deepEqual(result, { data: [{ id: 1 }] });
    assert.equal(routeCalls, 2);
    const state = getRateLimitState('https://example.test/api', '/orders');
    assert.equal(state?.limit, 5);
    assert.equal(state?.remaining, 4);
    assert.equal(state?.windowSeconds, 60);
    assert.equal(state?.scope, 'ip');
    assert.equal(state?.used, 1);
    assert.equal(state?.retryAfterMs, undefined);
    assert.equal(typeof state?.resetAtMs, 'number');
    assert.equal(typeof state?.observedAtMs, 'number');
  } finally {
    clearRateLimitState();
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});

test('fetchAPI throws RateLimitEncounteredError with machine-readable quota after retry remains blocked', async () => {
  const originalFetch = globalThis.fetch;
  let routeCalls = 0;

  globalThis.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'jwt-rate-limit', expTime: Date.now() + 60_000 });
    }
    if (urlText.endsWith('/orders')) {
      routeCalls += 1;
      return jsonResponse(
        { error: { code: 'RATE_LIMIT_EXCEEDED' } },
        429,
        {
          'Retry-After': '0',
          'X-RateLimit-Limit': '5',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Date.now()),
          'X-RateLimit-Window': '60',
          'X-RateLimit-Scope': 'ip',
          'X-RateLimit-Used': '5',
        },
      );
    }
    return jsonResponse({ message: 'not found' }, 404);
  };

  try {
    clearRateLimitState();
    resetTokens();
    initAuth('https://example.test/api', 'efy_pat_test');

    await assert.rejects(
      () => fetchAPI('https://example.test/api', '/orders'),
      (error) => {
        assert.ok(error instanceof RateLimitEncounteredError);
        assert.equal(error.statusCode, 429);
        assert.equal(error.limit, 5);
        assert.equal(error.remaining, 0);
        assert.equal(error.retryAfterMs, 0);
        assert.equal(error.windowSeconds, 60);
        assert.equal(error.scope, 'ip');
        assert.equal(error.used, 5);
        assert.match(error.responseBody, /RATE_LIMIT_EXCEEDED/);
        return true;
      },
    );
    assert.equal(routeCalls, 2);
  } finally {
    clearRateLimitState();
    resetTokens();
    globalThis.fetch = originalFetch;
  }
});
