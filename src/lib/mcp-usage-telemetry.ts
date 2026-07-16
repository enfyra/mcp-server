import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getRuntimeCacheTelemetry } from './runtime-cache.js';

type UnknownRecord = Record<string, any>;

const REPORT_URL = process.env.ENFYRA_MCP_USAGE_REPORT_URL || 'https://admin.enfyra.io/api/enfyra_mcp_usage_reports';
const USAGE_DIR = process.env.ENFYRA_MCP_USAGE_DIR || '/tmp/enfyra-mcp-usage';
const FLUSH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MAX_TOOL_STATS = 80;
const MAX_BUCKETS = 40;
const MAX_SAMPLES = 20;
const MAX_REPORT_LINES = 10000;
const MAX_LOCAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let currentDay = dayKey();
let writeSequence = 0;
let started = false;
let flushing = false;
let exitFlushInstalled = false;
let packageVersionCache: string | null = null;

function isTelemetryDisabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.ENFYRA_MCP_USAGE_DISABLE || '').toLowerCase());
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function currentFile() {
  return join(USAGE_DIR, `usage-${currentDay}.jsonl`);
}

function uploadFile(day = currentDay) {
  return join(USAGE_DIR, `upload-${day}-${Date.now()}.jsonl`);
}

function stateFile() {
  return join(USAGE_DIR, 'state.json');
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function packageVersion() {
  if (packageVersionCache) return packageVersionCache;
  try {
    const packageJsonPath = new URL('../../package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    packageVersionCache = String(parsed.version || 'unknown');
  } catch {
    packageVersionCache = process.env.npm_package_version || 'unknown';
  }
  return packageVersionCache;
}

function estimateTokens(text: string) {
  return text ? Math.ceil(text.length / 4) : 0;
}

function safeJson(value: unknown) {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      if (seen.has(entry)) return '[Circular]';
      seen.add(entry);
      return entry;
    }) || '';
  } catch {
    return '[Unserializable]';
  }
}

function tryParseJson(text: string | undefined) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/u.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function compactInputStats(args: unknown[]) {
  const input = args[0] ?? {};
  const text = safeJson(input);
  return {
    inputType: Array.isArray(input) ? 'array' : typeof input,
    inputKeys: input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).sort().slice(0, 40) : undefined,
    inputChars: text.length,
    inputEstimatedTokens: estimateTokens(text),
  };
}

function compactOutputStats(result: any) {
  const texts = Array.isArray(result?.content)
    ? result.content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text as string)
    : [];
  const text = texts.join('\n');
  const parsed = tryParseJson(texts[0]);
  const compressionStats = parsed && typeof parsed === 'object' && parsed.compressionStats && typeof parsed.compressionStats === 'object'
    ? parsed.compressionStats
    : undefined;
  const review = parsed && typeof parsed === 'object' && parsed.contractReview && typeof parsed.contractReview === 'object'
    ? parsed.contractReview
    : undefined;
  const contractReview = review
    ? {
      status: String(review.status || 'unknown').slice(0, 40),
      errorCodes: Array.isArray(review.errorCodes) ? review.errorCodes.map(String).slice(0, 20) : [],
      warningCodes: Array.isArray(review.warningCodes) ? review.warningCodes.map(String).slice(0, 20) : [],
      infoCodes: Array.isArray(review.infoCodes) ? review.infoCodes.map(String).slice(0, 20) : [],
    }
    : undefined;
  return {
    contentItems: Array.isArray(result?.content) ? result.content.length : 0,
    textItems: texts.length,
    outputChars: text.length,
    outputEstimatedTokens: estimateTokens(text),
    responseFormat: parsed && typeof parsed === 'object' ? parsed.responseFormat : undefined,
    compressionStats,
    contractReview,
  };
}

function ensureCurrentFile() {
  const nextDay = dayKey();
  if (nextDay !== currentDay) {
    currentDay = nextDay;
  }
  mkdirSync(USAGE_DIR, { recursive: true });
}

function cleanupOldUsageFiles() {
  mkdirSync(USAGE_DIR, { recursive: true });
  const cutoff = Date.now() - MAX_LOCAL_RETENTION_MS;
  for (const file of readdirSync(USAGE_DIR)) {
    if (!isUsageSpoolFile(file)) continue;
    try {
      const stats = statSync(join(USAGE_DIR, file));
      if (stats.mtimeMs < cutoff) {
        rmSync(join(USAGE_DIR, file), { force: true });
      }
    } catch {
      rmSync(join(USAGE_DIR, file), { force: true });
    }
  }
}

function isUsageSpoolFile(file: string) {
  return /^(usage|upload)-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(file);
}

function readState() {
  try {
    if (!existsSync(stateFile())) return {};
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state: UnknownRecord) {
  try {
    mkdirSync(USAGE_DIR, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state), 'utf8');
  } catch {
    // Telemetry state must never affect MCP behavior.
  }
}

function canFlushByLocalState(now = Date.now()) {
  const state = readState();
  const nextUploadAfter = Date.parse(String(state.nextUploadAfter || ''));
  if (nextUploadAfter && now < nextUploadAfter) return false;
  const lastUploadAt = Date.parse(String(state.lastUploadAt || ''));
  return !lastUploadAt || now - lastUploadAt >= FLUSH_INTERVAL_MS;
}

function markUploadSuccess(now = new Date()) {
  const state = readState();
  writeState({
    ...state,
    lastUploadAt: now.toISOString(),
    nextUploadAfter: new Date(now.getTime() + FLUSH_INTERVAL_MS).toISOString(),
  });
}

function markRetryAfter(response: Response, now = new Date()) {
  const retryAfter = Number(response.headers.get('retry-after') || 0);
  const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : FLUSH_INTERVAL_MS;
  const state = readState();
  writeState({
    ...state,
    nextUploadAfter: new Date(now.getTime() + waitMs).toISOString(),
    lastRejectedAt: now.toISOString(),
    lastRejectedStatus: response.status,
  });
}

function appendUsage(entry: UnknownRecord) {
  if (isTelemetryDisabled()) return;
  ensureCurrentFile();
  appendFileSync(currentFile(), `${JSON.stringify({ sequence: ++writeSequence, ...entry })}\n`, 'utf8');
}

export function recordMcpToolUsage(toolName: string, startedAt: number, args: unknown[], result: any, error?: unknown) {
  if (isTelemetryDisabled()) return;
  const base = {
    timestamp: new Date(startedAt).toISOString(),
    toolName,
    status: error ? 'error' : 'ok',
    durationMs: Date.now() - startedAt,
    ...compactInputStats(args),
  };
  if (error) {
    appendUsage({
      ...base,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return;
  }
  appendUsage({
    ...base,
    ...compactOutputStats(result),
  });
}

function apiHostHash(apiUrl: string) {
  try {
    const url = new URL(apiUrl);
    return hash(url.origin).slice(0, 32);
  } catch {
    return hash(apiUrl || 'unknown').slice(0, 32);
  }
}

function clientHash(apiUrl: string) {
  const seed = [
    'enfyra-mcp-usage-v1',
    apiUrl || 'unknown-api',
    homedir() || 'unknown-home',
    process.env.USER || process.env.USERNAME || 'unknown-user',
  ].join('|');
  return hash(seed).slice(0, 32);
}

function currentBucket(now = new Date()) {
  const hour = now.getUTCHours() < 12 ? 0 : 12;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  const end = new Date(start.getTime() + FLUSH_INTERVAL_MS);
  return { start, end };
}

function incrementBucket(target: UnknownRecord, key: string, delta: UnknownRecord) {
  const bucket = target[key] || { count: 0 };
  bucket.count += delta.count || 1;
  for (const [field, value] of Object.entries(delta)) {
    if (field === 'count') continue;
    if (typeof value === 'number') bucket[field] = (bucket[field] || 0) + value;
    else if (value !== undefined && bucket[field] === undefined) bucket[field] = value;
  }
  target[key] = bucket;
}

function topEntries(value: UnknownRecord, limit: number) {
  return Object.fromEntries(
    Object.entries(value)
      .sort((left, right) => {
        const leftTokens = Number((left[1] as UnknownRecord)?.outputTokens || (left[1] as UnknownRecord)?.count || 0);
        const rightTokens = Number((right[1] as UnknownRecord)?.outputTokens || (right[1] as UnknownRecord)?.count || 0);
        return rightTokens - leftTokens;
      })
      .slice(0, limit),
  );
}

function summarizeUsage(lines: UnknownRecord[], apiUrl: string, toolset: string, cacheStats = getRuntimeCacheTelemetry()) {
  const toolStats: UnknownRecord = {};
  const failureStats: UnknownRecord = {};
  const retryStats: UnknownRecord = {};
  const compressionStats: UnknownRecord = { appliedCount: 0, savedTokens: 0, originalTokens: 0, compactTokens: 0 };
  const contractReviewStats: UnknownRecord = {
    statuses: {},
    errorCodes: {},
    warningCodes: {},
    infoCodes: {},
  };
  const samples: UnknownRecord[] = [];
  let previousErrorTool = '';
  let previousErrorAt = 0;
  let retrySignalCount = 0;
  let failedCallCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let wastedTokens = 0;
  let totalDurationMs = 0;

  for (const line of lines) {
    const toolName = String(line.toolName || 'unknown');
    const inTokens = Number(line.inputEstimatedTokens || 0);
    const outTokens = Number(line.outputEstimatedTokens || 0);
    const durationMs = Number(line.durationMs || 0);
    inputTokens += inTokens;
    outputTokens += outTokens;
    totalDurationMs += durationMs;
    const failed = line.status === 'error';
    if (failed) failedCallCount += 1;
    incrementBucket(toolStats, toolName, {
      count: 1,
      failures: failed ? 1 : 0,
      inputTokens: inTokens,
      outputTokens: outTokens,
      durationMs,
    });
    if (failed) {
      const errorName = String(line.errorName || 'Error').slice(0, 80);
      incrementBucket(failureStats, `${toolName}:${errorName}`, { count: 1, toolName, errorName });
      previousErrorTool = toolName;
      previousErrorAt = Date.parse(String(line.timestamp || '')) || 0;
    } else if (previousErrorTool === toolName && previousErrorAt) {
      const callAt = Date.parse(String(line.timestamp || '')) || 0;
      if (callAt && callAt - previousErrorAt <= 10 * 60 * 1000) {
        retrySignalCount += 1;
        wastedTokens += outTokens;
        incrementBucket(retryStats, toolName, { count: 1, wastedTokens: outTokens });
      }
      previousErrorTool = '';
      previousErrorAt = 0;
    }
    const stats = line.compressionStats;
    if (stats && typeof stats === 'object') {
      if (stats.applied) compressionStats.appliedCount += 1;
      compressionStats.savedTokens += Number(stats.savedTokens || 0);
      compressionStats.originalTokens += Number(stats.originalTokens || 0);
      compressionStats.compactTokens += Number(stats.compactTokens || 0);
    }
    const contractReview = line.contractReview;
    if (contractReview && typeof contractReview === 'object') {
      incrementBucket(contractReviewStats.statuses, String(contractReview.status || 'unknown').slice(0, 40), { count: 1 });
      for (const field of ['errorCodes', 'warningCodes', 'infoCodes']) {
        const codes = Array.isArray(contractReview[field]) ? contractReview[field] : [];
        for (const code of codes) {
          incrementBucket(contractReviewStats[field], String(code).slice(0, 80), { count: 1 });
        }
      }
    }
  }

  for (const [toolName, stats] of Object.entries(toolStats)) {
    const item = stats as UnknownRecord;
    if (Number(item.failures || 0) > 0 || Number(item.outputTokens || 0) >= 5000) {
      samples.push({
        kind: Number(item.failures || 0) > 0 ? 'failure_hotspot' : 'token_hotspot',
        toolName,
        calls: item.count,
        failures: item.failures || 0,
        outputTokens: item.outputTokens || 0,
      });
    }
  }

  samples.push({
    kind: 'cache_summary',
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    hitRate: cacheStats.hitRate,
    invalidations: cacheStats.invalidations,
    warm: cacheStats.warm,
    warmSuccessRate: cacheStats.warmSuccessRate,
    domains: cacheStats.domains,
    events: cacheStats.events,
  });
  if (Number(cacheStats.invalidations.auth || 0) > 0 || Number(cacheStats.warm.failed || 0) > 0) {
    samples.push({
      kind: 'cache_recovery',
      authInvalidations: cacheStats.invalidations.auth || 0,
      warmFailures: cacheStats.warm.failed || 0,
      events: cacheStats.events,
    });
  }
  if (Object.keys(contractReviewStats.statuses).length > 0) {
    const counts = (value: UnknownRecord) => Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, Number((item as UnknownRecord).count || 0)]),
    );
    samples.push({
      kind: 'dynamic_contract_review',
      statuses: counts(contractReviewStats.statuses),
      errorCodes: counts(contractReviewStats.errorCodes),
      warningCodes: counts(contractReviewStats.warningCodes),
      infoCodes: counts(contractReviewStats.infoCodes),
    });
  }

  const bucket = currentBucket();
  return {
    client_hash: clientHash(apiUrl),
    report_day: currentDay,
    bucket_start: bucket.start.toISOString(),
    bucket_end: bucket.end.toISOString(),
    mcp_version: packageVersion(),
    toolset,
    api_host_hash: apiHostHash(apiUrl),
    session_count: 1,
    tool_call_count: lines.length,
    failed_call_count: failedCallCount,
    retry_signal_count: retrySignalCount,
    input_token_estimate: Math.floor(inputTokens),
    output_token_estimate: Math.floor(outputTokens),
    wasted_token_estimate: Math.floor(wastedTokens),
    total_duration_ms: Math.floor(totalDurationMs),
    tool_stats: topEntries(toolStats, MAX_TOOL_STATS),
    failure_stats: topEntries(failureStats, MAX_BUCKETS),
    retry_stats: topEntries(retryStats, MAX_BUCKETS),
    compression_stats: compressionStats,
    samples: samples.slice(0, MAX_SAMPLES),
    schema_version: 'v1',
  };
}

function usageSpoolFiles() {
  ensureCurrentFile();
  return readdirSync(USAGE_DIR)
    .filter(isUsageSpoolFile)
    .sort()
    .map((file) => join(USAGE_DIR, file));
}

function rotateCurrentFileForUpload() {
  ensureCurrentFile();
  const file = currentFile();
  if (!existsSync(file)) return;
  try {
    if (statSync(file).size === 0) return;
    renameSync(file, uploadFile(currentDay));
  } catch {
    // If rotation races with process exit, the current file remains as a future spool file.
  }
}

function readUsageLinesFromFiles(files: string[]) {
  const rawLines: string[] = [];
  for (const file of files) {
    try {
      rawLines.push(...readFileSync(file, 'utf8').split('\n').filter(Boolean));
    } catch {
      // Ignore broken spool files; retention cleanup will eventually remove them.
    }
  }
  return rawLines
    .slice(-MAX_REPORT_LINES)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function flushUsage(apiUrl: string, toolset: string) {
  if (isTelemetryDisabled() || flushing) return;
  if (!canFlushByLocalState()) return;
  flushing = true;
  try {
    cleanupOldUsageFiles();
    rotateCurrentFileForUpload();
    const files = usageSpoolFiles();
    const lines = readUsageLinesFromFiles(files);
    if (lines.length === 0) return;
    const report = summarizeUsage(lines, apiUrl, toolset);
    const response = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    if (response.ok) {
      markUploadSuccess();
      for (const file of files) rmSync(file, { force: true });
    } else if (response.status === 429 || response.status === 409) {
      markRetryAfter(response);
    }
  } catch {
    // Telemetry must never affect MCP behavior.
  } finally {
    flushing = false;
  }
}

function installExitFlush(apiUrl: string, toolset: string) {
  if (exitFlushInstalled) return;
  exitFlushInstalled = true;
  process.once('beforeExit', () => {
    void flushUsage(apiUrl, toolset);
  });
}

export function startMcpUsageTelemetry(apiUrl: string, toolset: string) {
  if (started || isTelemetryDisabled()) return;
  started = true;
  ensureCurrentFile();
  cleanupOldUsageFiles();
  installExitFlush(apiUrl, toolset);
  setTimeout(() => flushUsage(apiUrl, toolset), 30000).unref();
  setInterval(() => {
    cleanupOldUsageFiles();
    flushUsage(apiUrl, toolset);
  }, FLUSH_INTERVAL_MS).unref();
}

export const __mcpUsageTelemetryForTests = {
  summarizeUsage,
  dayKey,
  currentBucket,
};
