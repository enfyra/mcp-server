import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      errorCode: 'INVALID_SCHEMA',
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
    {
      timestamp: '2026-07-04T00:03:00.000Z',
      toolName: 'api_endpoint_workflow',
      status: 'ok',
      inputEstimatedTokens: 0,
      outputEstimatedTokens: 0,
      durationMs: 5,
      contractReview: {
        status: 'review_required',
        errorCodes: [],
        warningCodes: ['trusted_repository_bypass'],
        infoCodes: ['typeorm_partial_body'],
      },
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
  assert.equal(report.tool_call_count, 4);
  assert.equal(report.failed_call_count, 1);
  assert.equal(report.retry_signal_count, 1);
  assert.equal(report.input_token_estimate, 60);
  assert.equal(report.output_token_estimate, 6200);
  assert.equal(report.wasted_token_estimate, 200);
  assert.equal(report.compression_stats.savedTokens, 50);
  assert.equal(report.tool_stats.create_tables.count, 2);
  assert.equal(report.failure_stats['create_tables:ValidationError:INVALID_SCHEMA'].count, 1);
  assert.equal(report.failure_stats['create_tables:ValidationError:INVALID_SCHEMA'].errorCode, 'INVALID_SCHEMA');
  assert.equal(report.retry_stats.create_tables.count, 1);
  assert.equal(report.samples.some((item) => item.kind === 'token_hotspot' && item.toolName === 'query_table'), true);
  assert.equal(report.samples.some((item) => item.kind === 'cache_summary' && item.hitRate === 0.8 && item.warmSuccessRate === 0.5), true);
  assert.equal(report.samples.some((item) => item.kind === 'cache_recovery' && item.warmFailures === 1 && item.events[0].kind === 'warm_failure'), true);
  assert.equal(report.samples.some((item) => (
    item.kind === 'dynamic_contract_review'
    && item.statuses.review_required === 1
    && item.warningCodes.trusted_repository_bypass === 1
  )), true);
  assert.match(report.client_hash, /^[a-f0-9]{32}$/);
  assert.match(report.api_host_hash, /^[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(report).includes('admin.enfyra.io'), false);
});

test('mcp usage telemetry preserves bounded diagnostic error details without secrets', () => {
  const details = __mcpUsageTelemetryForTests.safeErrorDetails(new Error('Request failed https://admin.enfyra.io/api?token=secret-value at /Users/thinhdo/private/file.ts'));
  assert.equal(details.errorName, 'Error');
  assert.equal(details.errorCode, undefined);
  assert.equal(details.errorMessage.includes('secret-value'), false);
  assert.equal(details.errorMessage.includes('admin.enfyra.io'), false);
  assert.equal(details.errorMessage.includes('/Users/thinhdo'), false);
  assert.ok(details.errorMessage.length <= 160);
});

test('mcp usage telemetry sends a pending error report immediately despite the scheduled upload cooldown', async () => {
  const usageDir = mkdtempSync(join(tmpdir(), 'enfyra-mcp-usage-test-'));
  const originalUsageDir = process.env.ENFYRA_MCP_USAGE_DIR;
  const originalReportUrl = process.env.ENFYRA_MCP_USAGE_REPORT_URL;
  const originalFetch = globalThis.fetch;
  const reports = [];
  let responseStatus = 202;

  process.env.ENFYRA_MCP_USAGE_DIR = usageDir;
  process.env.ENFYRA_MCP_USAGE_REPORT_URL = 'https://telemetry.example.test/reports';
  writeFileSync(join(usageDir, 'state.json'), JSON.stringify({
    nextUploadAfter: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }));
  globalThis.fetch = async (url, options) => {
    reports.push({ url, body: JSON.parse(options.body) });
    return new Response(
      responseStatus === 202 ? null : JSON.stringify({ message: 'duplicate telemetry bucket' }),
      { status: responseStatus },
    );
  };

  try {
    const telemetry = await import(`../dist/lib/mcp-usage-telemetry.js?report-now=${Date.now()}`);
    telemetry.recordMcpToolUsage('get_current_user', Date.now() - 10, [{}], { content: [] });
    telemetry.recordMcpToolUsage('query_table', Date.now() - 8, [{}], undefined, new Error('upstream failed'));

    const result = await telemetry.flushMcpErrorReportsNow('https://local.enfyra.test/api', 'guided:all');

    assert.equal(result.status, 'sent');
    assert.equal(result.errorCount, 1);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].url, 'https://telemetry.example.test/reports');
    assert.equal(reports[0].body.tool_call_count, 1);
    assert.equal(reports[0].body.failed_call_count, 1);

    telemetry.recordMcpToolUsage('query_table', Date.now() - 4, [{}], undefined, new Error('duplicate report test'));
    responseStatus = 400;
    const rejected = await telemetry.flushMcpErrorReportsNow('https://local.enfyra.test/api', 'guided:all');

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.retryRecommended, false);
    assert.match(rejected.errorMessage, /duplicate telemetry bucket/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUsageDir === undefined) delete process.env.ENFYRA_MCP_USAGE_DIR;
    else process.env.ENFYRA_MCP_USAGE_DIR = originalUsageDir;
    if (originalReportUrl === undefined) delete process.env.ENFYRA_MCP_USAGE_REPORT_URL;
    else process.env.ENFYRA_MCP_USAGE_REPORT_URL = originalReportUrl;
    rmSync(usageDir, { recursive: true, force: true });
  }
});
