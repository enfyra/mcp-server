import test from 'node:test';
import assert from 'node:assert/strict';

import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { clearRuntimeCache } from '../dist/lib/runtime-cache.js';
import { registerScriptTools } from '../dist/lib/script-tools.js';
import {
  DYNAMIC_CODE_KNOWLEDGE_ACK_KEY,
  GLOBAL_RULES_ACK_KEY,
} from '../dist/lib/required-knowledge.js';

const API_URL = 'https://mcp-script-patch.test/api';
const TABLE_NAME = 'enfyra_route_handler';
const RECORD_ID = '541';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createToolHarness() {
  const tools = new Map();
  return {
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
    get(name) {
      const tool = tools.get(name);
      assert.ok(tool, `Expected tool ${name} to be registered`);
      return tool;
    },
  };
}

function installScriptPatchFetchMock(initialSource = 'return "before";') {
  const originalFetch = globalThis.fetch;
  let source = initialSource;
  const writes = [];

  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.endsWith('/auth/token/exchange')) {
      return jsonResponse({ accessToken: 'access-token', expiresIn: 3600 });
    }
    if (urlText.endsWith('/metadata')) {
      return jsonResponse({ dbType: 'postgresql', enfyraVersion: 'test' });
    }
    if (urlText.includes('/enfyra_table?')) {
      return jsonResponse({ data: [{ id: 41, name: TABLE_NAME, alias: null }] });
    }
    if (urlText.endsWith(`/metadata/${TABLE_NAME}`)) {
      return jsonResponse({
        data: {
          id: 41,
          name: TABLE_NAME,
          columns: [
            { id: 1, name: 'id', isPrimary: true },
            { id: 2, name: 'sourceCode' },
            { id: 3, name: 'scriptLanguage' },
          ],
          relations: [],
        },
      });
    }
    if (urlText.includes(`/${TABLE_NAME}?`)) {
      return jsonResponse({
        data: [{ id: RECORD_ID, sourceCode: source, scriptLanguage: 'javascript' }],
      });
    }
    if (urlText.endsWith('/admin/script/validate') && options.method === 'POST') {
      return jsonResponse({ valid: true });
    }
    if (urlText.endsWith(`/${TABLE_NAME}/${RECORD_ID}`) && options.method === 'PATCH') {
      const payload = JSON.parse(String(options.body));
      source = payload.sourceCode;
      writes.push(payload);
      return jsonResponse({ data: { id: RECORD_ID } });
    }
    return jsonResponse({ message: `Unhandled URL: ${urlText}` }, 404);
  };

  return {
    get source() {
      return source;
    },
    setSource(nextSource) {
      source = nextSource;
    },
    writes,
    restore() {
      globalThis.fetch = originalFetch;
      resetTokens();
    },
  };
}

function createRegisteredPatchTool() {
  const server = createToolHarness();
  initAuth(API_URL, 'api-token');
  resetTokens();
  registerScriptTools(server, API_URL);
  return server.get('patch_script_source');
}

function applyAcknowledgements() {
  return {
    globalRulesAckKey: GLOBAL_RULES_ACK_KEY,
    knowledgeAckKey: DYNAMIC_CODE_KNOWLEDGE_ACK_KEY,
  };
}

test('patch_script_source previews a text patch then applies its artifact with blank serialized replacement fields', async () => {
  const fixture = installScriptPatchFetchMock();
  const tool = createRegisteredPatchTool();

  try {
    assert.equal(tool.schema.oldText.isOptional(), true);
    assert.equal(tool.schema.newText.isOptional(), true);

    const previewResult = await tool.handler({
      tableName: TABLE_NAME,
      id: RECORD_ID,
      oldText: '"before"',
      newText: '"after"',
      occurrence: 'first',
    });
    const preview = JSON.parse(previewResult.content[0].text);

    const appliedResult = await tool.handler({
      tableName: TABLE_NAME,
      id: RECORD_ID,
      sourceFile: preview.sourceArtifact.tmpFile,
      oldText: '',
      newText: '',
      expectedSourceSha256: preview.sourceSha256Before,
      apply: true,
      ...applyAcknowledgements(),
    });
    const applied = JSON.parse(appliedResult.content[0].text);

    assert.equal(fixture.source, 'return "after";');
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.writes[0].sourceCode, fixture.source);
    assert.equal(applied.savedSource.valid, true);
    assert.equal(applied.sourceSha256Before, preview.sourceSha256Before);
    assert.equal(applied.sourceSha256After, preview.sourceSha256After);
  } finally {
    fixture.restore();
  }
});

test('patch_script_source rejects an artifact apply when the reviewed source hash is stale', async () => {
  const fixture = installScriptPatchFetchMock();
  const tool = createRegisteredPatchTool();

  try {
    const preview = JSON.parse((await tool.handler({
      tableName: TABLE_NAME,
      id: RECORD_ID,
      oldText: '"before"',
      newText: '"after"',
    })).content[0].text);
    fixture.setSource('return "changed elsewhere";');
    clearRuntimeCache();

    await assert.rejects(
      () => tool.handler({
        tableName: TABLE_NAME,
        id: RECORD_ID,
        sourceResourceUri: preview.sourceArtifact.resourceUri,
        expectedSourceSha256: preview.sourceSha256Before,
        apply: true,
        ...applyAcknowledgements(),
      }),
      /Source hash mismatch/,
    );
    assert.equal(fixture.writes.length, 0);
  } finally {
    fixture.restore();
  }
});

test('patch_script_source rejects text mode without both exact replacement values', async () => {
  const fixture = installScriptPatchFetchMock();
  const tool = createRegisteredPatchTool();

  try {
    await assert.rejects(
      () => tool.handler({
        tableName: TABLE_NAME,
        id: RECORD_ID,
        oldText: '"before"',
      }),
      /Provide oldText and newText/,
    );
  } finally {
    fixture.restore();
  }
});

test('patch_script_source rejects a real replacement text value alongside an artifact', async () => {
  const fixture = installScriptPatchFetchMock();
  const tool = createRegisteredPatchTool();

  try {
    const preview = JSON.parse((await tool.handler({
      tableName: TABLE_NAME,
      id: RECORD_ID,
      oldText: '"before"',
      newText: '"after"',
    })).content[0].text);

    await assert.rejects(
      () => tool.handler({
        tableName: TABLE_NAME,
        id: RECORD_ID,
        sourceFile: preview.sourceArtifact.tmpFile,
        oldText: '"before"',
      }),
      /not both/,
    );
  } finally {
    fixture.restore();
  }
});
