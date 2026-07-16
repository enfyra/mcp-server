import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { assertFixedFlowStepConfigIsStatic } from '../dist/lib/platform-operation-tools.js';
import { validatePortableScriptSource } from '../dist/lib/mutation-guards.js';

test('fixed flow step configs reject runtime flow macros that ESV does not interpolate', () => {
  assert.throws(
    () => assertFixedFlowStepConfigIsStatic('create', {
      table: 'audit_log',
      data: { requestId: '@FLOW_PAYLOAD.requestId' },
    }, 0),
    /fixed flow step configs are static/i,
  );

  assert.doesNotThrow(() => assertFixedFlowStepConfigIsStatic('create', {
    table: 'audit_log',
    data: { requestId: 'fixed-request-id' },
  }, 0));
});

test('dynamic scripts reject method-style log calls and accept the callable log contract', () => {
  assert.throws(
    () => validatePortableScriptSource('@LOGS.info("started")'),
    /@LOGS is callable/i,
  );
  assert.doesNotThrow(() => validatePortableScriptSource('@LOGS("started", { requestId })'));
  assert.throws(
    () => validatePortableScriptSource('@SOCKET.emit("done", payload)'),
    /no generic emit\(\) method/i,
  );
  assert.doesNotThrow(() => validatePortableScriptSource('@SOCKET.emitToGateway("/jobs", "done", payload)'));
});

test('runtime guidance distinguishes admin-test capture and executable storage limits', () => {
  const entry = readFileSync(new URL('../src/mcp-server-entry.ts', import.meta.url), 'utf8');
  const routing = readFileSync(new URL('../src/lib/tool-routing.ts', import.meta.url), 'utf8');
  const examples = readFileSync(new URL('../src/lib/mcp-examples.ts', import.meta.url), 'utf8');

  assert.match(entry, /@LOGS is a callable function/);
  assert.match(entry, /kind=script captures logs but not socket emitted calls/);
  assert.match(routing, /does not expose a binary\/multipart upload input tool/);
  assert.match(routing, /does not prove a real Socket\.IO client transport\/handshake/);
  assert.doesNotMatch(examples, /"id": "@FLOW_PAYLOAD\.todoId"/);
});
