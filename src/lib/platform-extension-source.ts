import { z } from 'zod';
import { createHash } from 'node:crypto';
import { fetchAPI } from './fetch.js';
import { fetchTableCatalog, fetchTableMetadata, fetchTableMetadataByRef, resolveTableCatalogEntry } from './metadata-client.js';
import {
  assertCustomEndpointRoute,
  assertDynamicEndpointContract,
  extractExplicitRepositoryTableNames,
  reviewDynamicEndpointContract,
} from './dynamic-endpoint-contract.js';
import { validatePortableScriptSource, validateScriptSourceIfPresent } from './mutation-guards.js';
import { writeSourceArtifact } from './source-artifacts.js';
import {
  normalizeEscapedVueSource,
  normalizeStrictBoolean,
} from './tool-input-normalization.js';
import {
  analyzeExtensionSfc,
  extensionElementAttributeValue,
  extensionElementHasAttribute,
} from './extension-sfc-analyzer.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAck,
  assertGlobalRulesAck,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';
import {
  AnyRecord,
} from './platform-shared-operations.js';
import {
  AUTO_INJECTED_EXTENSION_COMPONENT_BY_LOWERCASE,
  FULL_WIDTH_EXTENSION_FIELD_TAGS,
  buildExtensionUiSnippet,
  reviewExtensionRuntimeContract,
  reviewExtensionThemeContract,
  reviewExtensionUiContract,
} from './platform-extension-ui.js';
import {
  getId,
  unwrapData,
} from './platform-route-operations.js';
import {
  findRecord,
} from './platform-data-operations.js';

export function parseJsonObjectArg(name, value, fallback = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return parsed;
}

export function normalizeMenuPermissionArg(permission) {
  const parsed = parseJsonObjectArg('permission', permission, null);
  if (!parsed) return null;
  if (Object.keys(parsed).length === 0) return null;
  return parsed;
}

export function parseJsonArrayArg(name, value, fallback = []) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array.`);
  }
  return parsed;
}

export function filterQuery(filter) {
  return encodeURIComponent(JSON.stringify(filter));
}

export async function reloadBestEffort(apiUrl, path) {
  try {
    const result = await fetchAPI(apiUrl, path, { method: 'POST' });
    return { attempted: true, succeeded: true, result };
  } catch (error) {
    return { attempted: true, succeeded: false, error: error?.message || String(error) };
  }
}

export function naturalPartialReload(reason) {
  return { attempted: false, succeeded: true, reason };
}

export async function validateDynamicScript(apiUrl, sourceCode, scriptLanguage = 'javascript') {
  validatePortableScriptSource(sourceCode);
  const result = await fetchAPI(apiUrl, '/admin/script/validate', {
    method: 'POST',
    body: JSON.stringify({ sourceCode, scriptLanguage }),
  });
  if (result?.valid === false || result?.success === false) {
    throw new Error(result?.error?.message || 'Dynamic script validation failed.');
  }
  return {
    valid: true,
    scriptLanguage,
    compiledLength: typeof result?.data?.compiledCode === 'string' ? result.data.compiledCode.length : undefined,
  };
}

export function readTemplateBlocks(code) {
  const blocks = [];
  const lower = String(code || '').toLowerCase();
  let index = 0;
  while (index < lower.length) {
    const openStart = lower.indexOf('<template', index);
    if (openStart === -1) break;
    const boundary = lower[openStart + '<template'.length];
    if (boundary && !/\s|>/.test(boundary)) {
      index = openStart + 1;
      continue;
    }
    const openEnd = lower.indexOf('>', openStart + '<template'.length);
    if (openEnd === -1) break;
    const closeStart = lower.indexOf('</template', openEnd + 1);
    if (closeStart === -1) break;
    blocks.push(String(code).slice(openEnd + 1, closeStart));
    index = closeStart + '</template'.length;
  }
  return blocks;
}

function readTemplateTagName(template, start) {
  const next = template[start + 1];
  if (!next || next === '!' || next === '?') return null;
  let index = start + (next === '/' ? 2 : 1);
  while (/\s/.test(template[index] || '')) index += 1;
  const nameStart = index;
  while (/[\w.-]/.test(template[index] || '')) index += 1;
  return index > nameStart ? template.slice(nameStart, index) : null;
}

function findInvalidExtensionSortSyntax(code) {
  const source = String(code || '');
  if (/\bsort\s*:\s*\[[\s\S]*?\]/u.test(source)) {
    return 'sort arrays create repeated query parameters.';
  }
  if (/\bsort\s*:\s*(['"`])[^'"`]*:\s*(?:asc|desc)\1/iu.test(source)) {
    return 'SQL-style field:ASC/field:DESC tokens are not valid Enfyra REST sort syntax.';
  }
  return null;
}

export function validateExtensionCodeLocally(code, options: AnyRecord = {}) {
  const analysis = analyzeExtensionSfc(code);
  if (!analysis.valid) {
    throw new Error(`Invalid Vue SFC: ${analysis.errors[0] || 'template parsing failed.'}`);
  }
  if (/\bresolveComponent\s*\(/.test(String(code || ''))) {
    throw new Error('Invalid extension component resolution: do not call resolveComponent() in Enfyra extensions. Use auto-injected components such as <UButton> directly in the template so the app/compiler resolves them correctly.');
  }

  const invalidSortSyntax = findInvalidExtensionSortSyntax(code);
  if (invalidSortSyntax) {
    throw new Error(`Invalid extension sort contract: ${invalidSortSyntax} Use build_extension_ui kind=api_usage with structured sort entries; Enfyra REST requires one comma-separated string such as "-isPinned,-updatedAt".`);
  }

  const violations = analysis.elements.flatMap((element) => {
    const tagName = element.tag;
    if (tagName !== tagName.toLowerCase() || tagName.includes('-')) return [];
    const expected = AUTO_INJECTED_EXTENSION_COMPONENT_BY_LOWERCASE.get(tagName);
    return expected ? [{ tag: tagName, expected }] : [];
  });
  if (violations.length) {
    const first = violations[0];
    throw new Error(`Invalid extension component casing: use <${first.expected}> instead of <${first.tag}>. Enfyra/Nuxt UI auto-injected components must keep PascalCase in extension templates; lowercase tags render as unresolved DOM elements.`);
  }

  const missingFullWidthFields = analysis.elements
    .filter((element) => FULL_WIDTH_EXTENSION_FIELD_TAGS.includes(element.tag))
    .filter((element) => !extensionElementHasAttribute(element, 'data-compact', null))
    .filter((element) => !extensionElementHasAttribute(element, 'data-inline', null))
    .filter((element) => !element.classes.includes('w-full'))
    .map((element) => ({ tag: element.tag, snippet: element.source }));
  if (missingFullWidthFields.length) {
    const first = missingFullWidthFields[0];
    throw new Error(`Invalid extension field width: <${first.tag}> must include class="w-full" in Enfyra extensions unless it is intentionally compact with data-compact or data-inline. First offending snippet: ${first.snippet}`);
  }

  const uiReview = reviewExtensionUiContract(code, { pattern: options.uiPattern });
  const firstUiError = uiReview.issues.find((issue) => issue.severity === 'error');
  if (firstUiError) {
    throw new Error(`Invalid extension UI contract: ${firstUiError.message} Rule: ${firstUiError.rule}. ${firstUiError.suggestion}`);
  }

  const themeReview = reviewExtensionThemeContract(code);
  const firstThemeError = themeReview.issues.find((issue) => issue.severity === 'error');
  if (firstThemeError) {
    throw new Error(`Invalid extension theme contract: ${firstThemeError.message} Rule: ${firstThemeError.rule}. ${firstThemeError.suggestion}`);
  }

  const runtimeReview = reviewExtensionRuntimeContract(code);
  const firstRuntimeError = runtimeReview.issues.find((issue) => issue.severity === 'error');
  if (firstRuntimeError) {
    throw new Error(`Invalid extension runtime contract: ${firstRuntimeError.message} Rule: ${firstRuntimeError.rule}. ${firstRuntimeError.suggestion}`);
  }

  return { vueSfcAst: 'passed', componentCasing: 'passed', fieldWidth: 'passed', themeContract: 'passed', runtimeContract: 'passed' };
}

export async function validateExtensionCode(apiUrl, code, name, options: AnyRecord = {}) {
  const localChecks = validateExtensionCodeLocally(code, options);
  const result = await fetchAPI(apiUrl, '/enfyra_extension/preview', {
    method: 'POST',
    body: JSON.stringify({ code, name }),
  });
  if (result?.success === false) {
    throw new Error(result?.error?.message || 'Extension validation failed.');
  }
  return {
    valid: true,
    localChecks,
    extensionId: result?.extensionId || name || null,
    compiledLength: typeof result?.compiledCode === 'string' ? result.compiledCode.length : undefined,
  };
}

function summarizeExtensionSaveResult(result, fallback: AnyRecord = {}) {
  const record = unwrapData(result)[0] || (result?.data && !Array.isArray(result.data) ? result.data : null) || {};
  return {
    id: getId(record) ?? fallback.id ?? null,
    name: record.name ?? fallback.name ?? null,
    type: record.type ?? fallback.type ?? null,
    isEnabled: record.isEnabled ?? fallback.isEnabled ?? null,
    version: record.version ?? fallback.version ?? null,
    updatedAt: record.updatedAt ?? null,
  };
}

export function buildExtensionRuntimeVerification({ extension, code, validation, uiPattern, expectedSha256 }) {
  const source = String(code || '');
  const currentSha256 = sha256Text(source);
  const review = buildExtensionUiSnippet('review', { code: source, pattern: uiPattern });
  const rawMenu = Array.isArray(extension?.menu) ? extension.menu[0] : extension?.menu;
  const isPage = String(extension?.type || '').toLowerCase() === 'page';
  const savedRecordPassed = getId(extension) !== null;
  const menuWiringPassed = !isPage || Boolean(getId(rawMenu) !== null && rawMenu?.path);
  const hashMatches = !expectedSha256 || expectedSha256 === currentSha256;
  const compilerPassed = validation?.valid === true;
  const valid = savedRecordPassed && compilerPassed && review.valid && menuWiringPassed && hashMatches;

  return {
    action: 'extension_runtime_verified',
    valid,
    extension: {
      id: getId(extension),
      name: extension?.name || null,
      type: extension?.type || null,
      isEnabled: extension?.isEnabled ?? null,
      version: extension?.version ?? null,
      sha256: currentSha256,
      length: source.length,
    },
    checks: {
      savedRecord: { status: savedRecordPassed ? 'passed' : 'failed' },
      expectedHash: { status: hashMatches ? 'passed' : 'failed', expectedSha256: expectedSha256 || null, currentSha256 },
      serverCompile: { status: compilerPassed ? 'passed' : 'failed', compiledLength: validation?.compiledLength ?? null },
      uiContract: { status: review.ui.valid ? 'passed' : 'failed', issueCount: review.ui.issueCount, pattern: review.ui.pattern },
      themeContract: { status: review.theme.valid ? 'passed' : 'failed', issueCount: review.theme.issueCount },
      runtimeContract: { status: review.runtime.valid ? 'passed' : 'failed', issueCount: review.runtime.issueCount },
      menuWiring: {
        status: menuWiringPassed ? 'passed' : 'failed',
        applicable: isPage,
        menu: rawMenu ? { id: getId(rawMenu), label: rawMenu.label || null, path: rawMenu.path || null } : null,
      },
      browserRender: {
        status: 'not_run',
        reason: 'MCP can verify saved metadata, server compilation, static runtime/UI/theme contracts, and page menu wiring. A signed-in browser is still required to prove component execution, API data shape, console errors, and responsive layout.',
      },
    },
    contractReview: review.valid
      ? { valid: true, issueCount: 0, pattern: review.ui.pattern }
      : review,
    coverage: {
      verified: ['saved metadata', 'expected source hash', 'server Vue compilation', 'static UI/theme/runtime contracts', ...(isPage ? ['page menu wiring'] : [])],
      browserRequiredForFullRuntimeProof: true,
    },
  };
}

export async function verifyExtensionRuntime(apiUrl, { id, name, uiPattern, expectedSha256 }) {
  if (!id && !name) throw new Error('Provide id or name to verify an existing extension.');
  const existing = id
    ? await findRecord(apiUrl, 'enfyra_extension', { id: { _eq: id } }, 'id,_id,name,type,isEnabled,version,updatedAt,menu.id,menu.label,menu.path,code')
    : await findRecord(apiUrl, 'enfyra_extension', { name: { _eq: name } }, 'id,_id,name,type,isEnabled,version,updatedAt,menu.id,menu.label,menu.path,code');
  if (!existing) throw new Error(`Extension not found: ${id || name}`);
  const code = String(existing.code || '');
  const validation = await validateExtensionCode(apiUrl, code, existing.name || String(id || name), { uiPattern });
  return buildExtensionRuntimeVerification({ extension: existing, code, validation, uiPattern, expectedSha256 });
}

export async function updateExtensionCode(apiUrl, {
  id,
  name,
  code,
  description,
  isEnabled,
  version,
  expectedSha256,
  uiPattern,
  globalRulesAckKey,
  extensionKnowledgeAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  assertExtensionKnowledgeAck(extensionKnowledgeAckKey);
  if (!id && !name) throw new Error('Provide id or name to update an existing extension.');
  const existing = id
    ? await findRecord(apiUrl, 'enfyra_extension', { id: { _eq: id } }, 'id,_id,name,type,isEnabled,version,menu.id,code')
    : await findRecord(apiUrl, 'enfyra_extension', { name: { _eq: name } }, 'id,_id,name,type,isEnabled,version,menu.id,code');
  if (!existing) throw new Error(`Extension not found: ${id || name}`);
  const extensionId = getId(existing);
  const currentSha256 = sha256Text(existing.code || '');
  if (expectedSha256 && expectedSha256 !== currentSha256) {
    throw new Error(`Extension code hash mismatch. Expected ${expectedSha256}, got ${currentSha256}. Re-read the extension before replacing it.`);
  }
  const validation = await validateExtensionCode(apiUrl, code, name || existing.name || extensionId, { uiPattern });
  const contractReview = buildExtensionUiSnippet('review', { code, pattern: uiPattern });
  const body: AnyRecord = {
    code,
    ...(description !== undefined ? { description } : {}),
    ...(isEnabled !== undefined ? { isEnabled } : {}),
    ...(version !== undefined ? { version } : {}),
  };
  const result = await fetchAPI(apiUrl, `/enfyra_extension/${encodeURIComponent(String(extensionId))}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const nextSha256 = sha256Text(code);
  const verification = await verifyExtensionRuntime(apiUrl, {
    id: extensionId,
    name: undefined,
    uiPattern,
    expectedSha256: nextSha256,
  });
  return {
    action: 'extension_code_updated',
    id: extensionId,
    name: existing.name || name || null,
    type: existing.type || null,
    previousSha256: currentSha256,
    sha256: nextSha256,
    saved: summarizeExtensionSaveResult(result, {
      id: extensionId,
      name: existing.name || name,
      type: existing.type,
      isEnabled: isEnabled ?? existing.isEnabled,
      version: version ?? existing.version,
    }),
    validation,
    contractReview: {
      valid: contractReview.valid,
      issueCount: contractReview.issueCount,
      pattern: contractReview.ui?.pattern,
    },
    verification,
  };
}

export function sha256Text(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function whitespaceFlexiblePattern(search) {
  const parts = String(search ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error('search must contain at least one non-whitespace token.');
  return new RegExp(parts.map(escapeRegExp).join('\\s+'), 'g');
}

function regexMatches(code, regex) {
  const matches = [];
  regex.lastIndex = 0;
  let match = regex.exec(code);
  while (match) {
    matches.push(match);
    if (match[0] === '') regex.lastIndex += 1;
    match = regex.exec(code);
  }
  regex.lastIndex = 0;
  return matches;
}

function replaceFirstExact(code, search, replace) {
  const index = code.indexOf(search);
  if (index === -1) return code;
  return `${code.slice(0, index)}${replace}${code.slice(index + search.length)}`;
}

function normalizeExtensionPatch(input, index) {
  const search = input?.search;
  if (typeof search !== 'string' || search.length === 0) {
    throw new Error(`patches[${index}].search must be a non-empty string.`);
  }
  if (input?.replace === undefined) {
    throw new Error(`patches[${index}].replace is required.`);
  }
  const searchMode = input?.searchMode || 'exact';
  if (!['exact', 'whitespace'].includes(searchMode)) {
    throw new Error(`patches[${index}].searchMode must be "exact" or "whitespace".`);
  }
  return {
    search,
    replace: String(input.replace),
    searchMode,
    replaceAll: Boolean(input?.replaceAll),
  };
}

function normalizeExtensionPatchInputs({ search, replace, searchMode, replaceAll, patches }) {
  if (Array.isArray(patches) && patches.length > 0) {
    return patches.map(normalizeExtensionPatch);
  }
  return [normalizeExtensionPatch({ search, replace, searchMode, replaceAll }, 0)];
}

function applyOneExtensionPatch(code, patch, index) {
  const beforeLength = code.length;
  let occurrences = 0;
  let nextCode = code;

  if (patch.searchMode === 'whitespace') {
    const regex = whitespaceFlexiblePattern(patch.search);
    occurrences = regexMatches(code, regex).length;
    if (occurrences === 0) {
      throw new Error(`Patch ${index} search fragment was not found with whitespace-flex matching.`);
    }
    if (!patch.replaceAll && occurrences !== 1) {
      throw new Error(`Patch ${index} expected search fragment to occur exactly once; found ${occurrences}. Use replaceAll=true, a more specific fragment, or update_extension_code for a full replacement.`);
    }
    let replaced = false;
    nextCode = code.replace(regex, (match) => {
      if (patch.replaceAll) return patch.replace;
      if (replaced) return match;
      replaced = true;
      return patch.replace;
    });
  } else {
    occurrences = code.split(patch.search).length - 1;
    if (occurrences === 0) {
      throw new Error(`Patch ${index} search fragment was not found.`);
    }
    if (!patch.replaceAll && occurrences !== 1) {
      throw new Error(`Patch ${index} expected search fragment to occur exactly once; found ${occurrences}. Use replaceAll=true, a more specific fragment, or update_extension_code for a full replacement.`);
    }
    nextCode = patch.replaceAll
      ? code.split(patch.search).join(patch.replace)
      : replaceFirstExact(code, patch.search, patch.replace);
  }

  return {
    code: nextCode,
    result: {
      index,
      searchMode: patch.searchMode,
      replaceAll: patch.replaceAll,
      occurrences,
      beforeLength,
      afterLength: nextCode.length,
    },
  };
}

export function applyExtensionCodePatches(code, patches) {
  const normalizedPatches = normalizeExtensionPatchInputs(patches);
  let nextCode = String(code ?? '');
  const results = [];
  normalizedPatches.forEach((patch, index) => {
    const applied = applyOneExtensionPatch(nextCode, patch, index);
    nextCode = applied.code;
    results.push(applied.result);
  });
  return { code: nextCode, patches: normalizedPatches, results };
}

function patchDiffLines(value, prefix) {
  const lines = String(value ?? '').split('\n');
  return lines.map((line) => `${prefix}${line}`).join('\n');
}

export function buildExtensionPatchDiffArtifact({ id, name, currentSha256, nextSha256, patches }) {
  const hunks = (patches || []).map((patch, index) => [
    `@@ patch ${index + 1} (${patch.searchMode || 'exact'}${patch.replaceAll ? ', all matches' : ''}) @@`,
    patchDiffLines(patch.search, '-'),
    patchDiffLines(patch.replace, '+'),
  ].join('\n'));
  const content = [
    `--- ${name || id || 'extension'}@${currentSha256 || 'unknown'}`,
    `+++ ${name || id || 'extension'}@${nextSha256 || 'unknown'}`,
    ...hunks,
    '',
  ].join('\n');
  return writeSourceArtifact({
    tableName: 'enfyra_extension',
    id: id || name || 'extension',
    fieldName: 'patch.diff',
    source: content,
  });
}

export async function patchExtensionCode(apiUrl, {
  id,
  name,
  search,
  replace,
  searchMode,
  replaceAll,
  patches,
  expectedSha256,
  apply,
  description,
  isEnabled,
  version,
  uiPattern,
  globalRulesAckKey,
  extensionKnowledgeAckKey,
}) {
  assertGlobalRulesAck(globalRulesAckKey);
  assertExtensionKnowledgeAck(extensionKnowledgeAckKey);
  if (!id && !name) throw new Error('Provide id or name to patch an existing extension.');
  const existing = id
    ? await findRecord(apiUrl, 'enfyra_extension', { id: { _eq: id } }, 'id,_id,name,type,menu.id,code')
    : await findRecord(apiUrl, 'enfyra_extension', { name: { _eq: name } }, 'id,_id,name,type,menu.id,code');
  if (!existing) throw new Error(`Extension not found: ${id || name}`);
  const extensionId = getId(existing);
  const currentCode = String(existing.code ?? '');
  const currentSha256 = sha256Text(currentCode);
  if (apply && !expectedSha256) {
    throw new Error('expectedSha256 is required when apply=true. Preview the patch or inspect the extension first, then retry with the current code hash.');
  }
  if (expectedSha256 && expectedSha256 !== currentSha256) {
    throw new Error(`Extension code hash mismatch. Expected ${expectedSha256}, got ${currentSha256}. Re-read the extension before patching.`);
  }
  const patchResult = applyExtensionCodePatches(currentCode, { search, replace, searchMode, replaceAll, patches });
  const nextCode = patchResult.code;
  const nextSha256 = sha256Text(nextCode);
  const occurrences = patchResult.results.reduce((total, item) => total + item.occurrences, 0);
  const diff = buildExtensionPatchDiffArtifact({
    id: extensionId,
    name: existing.name || name,
    currentSha256,
    nextSha256,
    patches: patchResult.patches,
  });
  const nextStepPatchInput = patchResult.patches.length === 1
    ? {
      search: patchResult.patches[0].search,
      replace: patchResult.patches[0].replace,
      searchMode: patchResult.patches[0].searchMode,
      replaceAll: patchResult.patches[0].replaceAll,
    }
    : { patches: patchResult.patches };
  const preview = {
    action: apply ? 'extension_code_patch_applied' : 'extension_code_patch_previewed',
    id: extensionId,
    name: existing.name || name || null,
    type: existing.type || null,
    currentSha256,
    nextSha256,
    currentLength: currentCode.length,
    nextLength: nextCode.length,
    occurrences,
    patchResults: patchResult.results,
    diff,
    atomic: patchResult.patches.length > 1,
    apply: Boolean(apply),
  };
  if (!apply) {
    return {
      ...preview,
      nextStep: {
        tool: 'patch_extension_code',
        input: { id: extensionId, expectedSha256: currentSha256, ...nextStepPatchInput, apply: true },
      },
    };
  }
  const result = await updateExtensionCode(apiUrl, {
    id: extensionId,
    name: undefined,
    code: nextCode,
    description,
    isEnabled,
    version,
    expectedSha256: currentSha256,
    uiPattern,
    globalRulesAckKey,
    extensionKnowledgeAckKey,
  });
  return {
    ...preview,
    result,
    validation: result.validation,
  };
}
