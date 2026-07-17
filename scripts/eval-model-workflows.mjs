import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_EVAL_SCENARIOS, scoreModelEvalRuns } from '../dist/lib/model-eval.js';

const tracePath = process.env.ENFYRA_MCP_MODEL_EVAL_TRACES;
const reportPath = '/tmp/enfyra-mcp-model-eval.json';

const report = tracePath
  ? (() => {
      const input = JSON.parse(readFileSync(tracePath, 'utf8'));
      const runs = Array.isArray(input) ? input : input.runs;
      if (!Array.isArray(runs) || runs.length === 0) throw new Error('Model eval trace file must contain a non-empty runs array.');
      const scores = scoreModelEvalRuns(runs);
      return {
        generatedAt: new Date().toISOString(),
        mode: 'scored-traces',
        tracePath,
        taskSafetyThreshold: 100,
        optimizationSignals: ['workflow_selection', 'bounded_tool_calls', 'tool_errors'],
        scores,
        allRecommended: scores.every((score) => score.recommended),
      };
    })()
  : {
      generatedAt: new Date().toISOString(),
      mode: 'suite-contract',
      taskSafetyThreshold: 100,
      optimizationSignals: ['workflow_selection', 'bounded_tool_calls', 'tool_errors'],
      scenarioCount: MODEL_EVAL_SCENARIOS.length,
      scenarios: MODEL_EVAL_SCENARIOS,
      guidance: 'Set ENFYRA_MCP_MODEL_EVAL_TRACES to a JSON trace file produced by a real model runner to score model-in-loop behavior.',
    };

writeFileSync(reportPath, JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Report: ${reportPath}\n`);
