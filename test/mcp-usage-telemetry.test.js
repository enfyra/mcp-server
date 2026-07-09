import test from 'node:test';
import assert from 'node:assert/strict';

import { __mcpUsageTelemetryForTests } from '../dist/lib/mcp-usage-telemetry.js';

test('mcp usage telemetry summarizes token, retry, failure, and compression evidence compactly', () => {
  const report = __mcpUsageTelemetryForTests.summarizeUsage([
    {
      timestamp: '2026-07-04T00:00:00.000Z',
      toolName: 'create_tables',
      status: 'error',
      inputEstimatedTokens: 20,
      outputEstimatedTokens: 0,
      durationMs: 10,
      errorName: 'ValidationError',
    },
    {
      timestamp: '2026-07-04T00:01:00.000Z',
      toolName: 'create_tables',
      status: 'ok',
      inputEstimatedTokens: 30,
      outputEstimatedTokens: 200,
      durationMs: 40,
      compressionStats: {
        applied: true,
        savedTokens: 50,
        originalTokens: 250,
        compactTokens: 200,
      },
    },
    {
      timestamp: '2026-07-04T00:02:00.000Z',
      toolName: 'query_table',
      status: 'ok',
      inputEstimatedTokens: 10,
      outputEstimatedTokens: 6000,
      durationMs: 20,
    },
  ], 'https://admin.enfyra.io/api', 'guided', {
    hits: 8,
    misses: 2,
    hitRate: 0.8,
    invalidations: { mutation: 1, auth: 0, reload: 2 },
    warm: { attempted: 2, succeeded: 1, failed: 1 },
    warmSuccessRate: 0.5,
    domains: { metadata: { hits: 8, misses: 2, invalidations: 3, warmFailures: 1 } },
    events: [{ timestamp: '2026-07-04T00:03:00.000Z', kind: 'warm_failure', domains: ['metadata'], entries: 1 }],
  });

  assert.equal(report.schema_version, 'v1');
  assert.equal(report.tool_call_count, 3);
  assert.equal(report.failed_call_count, 1);
  assert.equal(report.retry_signal_count, 1);
  assert.equal(report.input_token_estimate, 60);
  assert.equal(report.output_token_estimate, 6200);
  assert.equal(report.wasted_token_estimate, 200);
  assert.equal(report.compression_stats.savedTokens, 50);
  assert.equal(report.tool_stats.create_tables.count, 2);
  assert.equal(report.failure_stats['create_tables:ValidationError'].count, 1);
  assert.equal(report.retry_stats.create_tables.count, 1);
  assert.equal(report.samples.some((item) => item.kind === 'token_hotspot' && item.toolName === 'query_table'), true);
  assert.equal(report.samples.some((item) => item.kind === 'cache_summary' && item.hitRate === 0.8 && item.warmSuccessRate === 0.5), true);
  assert.equal(report.samples.some((item) => item.kind === 'cache_recovery' && item.warmFailures === 1 && item.events[0].kind === 'warm_failure'), true);
  assert.match(report.client_hash, /^[a-f0-9]{32}$/);
  assert.match(report.api_host_hash, /^[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(report).includes('admin.enfyra.io'), false);
});
