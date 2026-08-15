import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDynamicScriptContextTypeContract } from '../dist/lib/dynamic-script-context-contract.js';

test('dynamic script context contract exposes trusted script-visible runtime types', () => {
  const contract = buildDynamicScriptContextTypeContract();
  const text = JSON.stringify(contract);

  assert.match(contract.authority, /ESV and isolated executor runtime guarantee/i);
  assert.match(contract.authority, /Do not add typeof, Array\.isArray, existence, or callable guards/i);
  assert.match(contract.authority, /Validate user-controlled field values/i);

  assert.equal(contract.values['@PARAMS'].type, 'Record<string, string>');
  assert.equal(contract.values['@USER'].type, 'RuntimeRecord | null');
  assert.equal(contract.values['@ENV'].type, 'Record<string, string | undefined>');
  assert.equal(contract.values['@SHARE'].type, '{ $logs: unknown[] }');
  assert.match(contract.values['@QUERY'].guarantee, /filter and _filter are objects/i);

  assert.match(contract.repositories.declaration, /data: T\[\]/);
  assert.match(contract.repositories.declaration, /find\(options\?: RepositoryFindOptions\): Promise<CollectionResult>/);
  assert.match(contract.repositories.guarantee, /never guard result\.data with Array\.isArray/i);

  assert.match(contract.bridge.async, /@REPOS.*@HELPERS.*@CACHE.*@STORAGE.*@SOCKET.*@RES.*@TRIGGER/);
  assert.match(contract.bridge.sync, /@LOGS.*@THROW/);
  assert.match(text, /@FLOW_META/);
  assert.match(text, /@UPLOADED_FILE/);
  assert.match(text, /HTTP\/flow global socket/);
  assert.match(text, /bound websocket socket/);
  assert.match(text, /observer\?: \(chunkText: string, kind:.*chunk.*end.*error/);
  assert.match(text, /transform\?: \(chunkText: string, kind:.*chunk.*end/);
  assert.match(text, /return a string to replace output, null to suppress it, or undefined to preserve it/i);
  assert.match(text, /one decoder spans the full stream/i);
  assert.match(text, /blank-line-delimited events/i);
  assert.match(text, /single deadline for observer, transform, and stream relay/);
  assert.match(text, /client abort\/response close cancels the task/);
});
