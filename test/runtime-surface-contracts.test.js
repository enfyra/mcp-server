import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSourceTree } from '../test-support/source-tree.js';

import { assertFlowStepTypeIsSupported } from '../dist/lib/platform-operation-tools.js';
import { validatePortableScriptSource } from '../dist/lib/mutation-guards.js';

test('flow steps accept only script and condition types', () => {
  assert.throws(
    () => assertFlowStepTypeIsSupported('create'),
    /script-only/i,
  );
  assert.throws(
    () => assertFlowStepTypeIsSupported('sleep'),
    /script-only/i,
  );
  assert.doesNotThrow(() => assertFlowStepTypeIsSupported('script'));
  assert.doesNotThrow(() => assertFlowStepTypeIsSupported('condition'));
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
  assert.throws(
    () => validatePortableScriptSource('await @TRIGGER.trigger("send-email", payload)'),
    /@TRIGGER is callable/i,
  );
  assert.doesNotThrow(() => validatePortableScriptSource('await @TRIGGER("send-email", payload)'));
});

test('runtime guidance distinguishes admin-test capture and executable storage limits', () => {
  const entry = readSourceTree();
  const routing = entry;
  const examples = entry;

  assert.match(entry, /@LOGS is a callable function/);
  assert.match(entry, /kind=script captures logs but not socket emitted calls/);
  assert.match(routing, /does not expose a binary\/multipart upload input tool/);
  assert.match(routing, /does not prove a real Socket\.IO client transport\/handshake/);
  assert.doesNotMatch(examples, /"id": "@FLOW_PAYLOAD\.todoId"/);
});
