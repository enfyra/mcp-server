import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const BENCHMARK_DIR = process.env.ENFYRA_MCP_BENCHMARK_DIR || '/tmp/enfyra-mcp-benchmark';
const BENCHMARK_FILE = process.env.ENFYRA_MCP_BENCHMARK_FILE || 'benchmark.jsonl';

let enabled = false;
let operationId: string | null = null;
let operationStart: number = 0;
let toolCallSeq = 0;

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

function safeJsonPreview(value: unknown, maxChars = 300): string {
  try {
    const s = JSON.stringify(value);
    return s.length > maxChars ? s.slice(0, maxChars) + '...' : s;
  } catch {
    return '[unserializable]';
  }
}

export function enableBenchmark() {
  enabled = true;
  mkdirSync(BENCHMARK_DIR, { recursive: true });
}

export function disableBenchmark() {
  enabled = false;
}

export function startBenchmarkOperation(opId: string) {
  if (!enabled) return;
  operationId = opId;
  operationStart = Date.now();
  toolCallSeq = 0;
  appendEntry({
    _type: 'operation_start',
    operationId,
    timestamp: new Date().toISOString(),
  });
}

export function endBenchmarkOperation(success: boolean, error?: string) {
  if (!enabled || !operationId) return;
  appendEntry({
    _type: 'operation_end',
    operationId,
    durationMs: Date.now() - operationStart,
    toolCalls: toolCallSeq,
    success,
    ...(error ? { error } : {}),
  });
  operationId = null;
  operationStart = 0;
  toolCallSeq = 0;
}

export function recordBenchmarkToolCall(
  toolName: string,
  startedAt: number,
  args: unknown[],
  result: unknown,
  error?: unknown,
) {
  if (!enabled) return;
  toolCallSeq++;
  const durationMs = Date.now() - startedAt;
  const inputText = safeJsonPreview(args[0]);
  const outputText = typeof result === 'string' ? result : safeJsonPreview(result, 1000);
  appendEntry({
    _type: 'tool_call',
    operationId,
    seq: toolCallSeq,
    toolName,
    durationMs,
    inputChars: inputText.length,
    inputEstimatedTokens: estimateTokens(inputText),
    outputChars: outputText.length,
    outputEstimatedTokens: estimateTokens(outputText),
    status: error ? 'error' : 'ok',
    ...(error ? { error: String((error as any)?.message || error).slice(0, 200) } : {}),
  });
}

function appendEntry(entry: Record<string, unknown>) {
  try {
    appendFileSync(join(BENCHMARK_DIR, BENCHMARK_FILE), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Benchmark telemetry must never affect MCP behavior.
  }
}

export function getBenchmarkStats() {
  return {
    enabled,
    operationId,
    dir: BENCHMARK_DIR,
    file: BENCHMARK_FILE,
  };
}