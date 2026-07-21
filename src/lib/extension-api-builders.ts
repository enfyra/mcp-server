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
  escapeRegExp,
  readTemplateBlocks,
} from './platform-extension-source.js';
import {
  AnyRecord,
} from './platform-shared-operations.js';
import {
  quoteJsString,
} from './extension-component-builders.js';

function toPascalIdentifier(value, fallback = 'Items') {
  const raw = String(value || fallback)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
  return raw || fallback;
}

function buildExtensionSort(sort: unknown): string | undefined {
  if (!Array.isArray(sort) || sort.length === 0) return undefined;
  const fields = sort.map((entry) => {
    const field = String((entry as AnyRecord)?.field || '').trim();
    if (!field) throw new Error('Each extension sort entry requires a field.');
    return String((entry as AnyRecord)?.direction || 'asc').toLowerCase() === 'desc'
      ? `-${field}`
      : field;
  });
  return fields.join(',');
}

export function buildExtensionApiUsageSnippet(input: AnyRecord = {}) {
  const resource = String(input.resource || input.name || 'items');
  const pascal = toPascalIdentifier(resource, 'Items');
  const operation = String(input.operation || input.mode || input.intent || '').toLowerCase() || String(input.method || 'GET').toLowerCase();
  const normalizedOperation = ({
    get: 'list',
    read: 'list',
    load: 'list',
    post: 'create',
    patch: 'update',
    put: 'update',
    del: 'delete',
    remove: 'delete',
    destroy: 'delete',
  } as Record<string, string>)[operation] || operation;
  const defaultMethodByOperation: Record<string, string> = {
    list: 'GET',
    find_one: 'GET',
    create: 'POST',
    update: 'PATCH',
    delete: 'DELETE',
    batch_update: 'PATCH',
    batch_delete: 'DELETE',
  };
  const method = String(input.method || defaultMethodByOperation[normalizedOperation] || 'GET').toUpperCase();
  const rawPath = String(input.path || `/${resource}`);
  const path = rawPath.replace(/\/:id\/?$/, '');
  const responseName = input.responseName || `${resource}Response`;
  const pendingName = input.pendingName || `${resource}Pending`;
  const errorName = input.errorName || `${resource}Error`;
  const executeName = input.executeName || (method === 'GET' ? `load${pascal}` : `${normalizedOperation.replace(/(^|_)([a-z])/g, (_m, _p, ch) => ch.toUpperCase()).replace(/^./, (ch) => ch.toLowerCase())}${pascal}Api`);
  const refreshName = input.refreshName || `refresh${pascal}`;
  const sort = buildExtensionSort(input.sort);
  const rawQuery = input.query && typeof input.query === 'object' && !Array.isArray(input.query)
    ? input.query
    : null;
  if (rawQuery?.sort !== undefined && !sort) {
    throw new Error('Pass extension sort through the structured sort input, not query.sort.');
  }
  const structuredQuery = rawQuery || sort
    ? { ...(rawQuery || {}), ...(sort ? { sort } : {}) }
    : null;
  if (structuredQuery && input.queryExpression) {
    throw new Error('Pass either query or queryExpression to build_extension_api_usage, not both. Use structured query plus sort for Enfyra REST ordering.');
  }
  const queryName = input.queryName || `${resource}Query`;
  const queryExpression = structuredQuery ? queryName : input.queryExpression;
  const options: string[] = [];
  if (method !== 'GET') options.push(`method: ${quoteJsString(method)}`);
  if (queryExpression) options.push(`query: ${queryExpression}`);
  if (input.bodyExpression) options.push(`body: ${input.bodyExpression}`);
  if (input.errorContext) options.push(`errorContext: ${quoteJsString(input.errorContext)}`);
  if (input.onErrorExpression) options.push(`onError: ${input.onErrorExpression}`);
  const optionsLiteral = options.length ? `, {\n  ${options.join(',\n  ')}\n}` : '';
  const lines = [
    ...(structuredQuery ? [`const ${queryName} = computed(() => (${JSON.stringify(structuredQuery, null, 2)}));`, ''] : []),
    `const { data: ${responseName}, pending: ${pendingName}, error: ${errorName}, execute: ${executeName}, refresh: ${refreshName} } = useApi(${quoteJsString(path)}${optionsLiteral});`,
  ];
  if (method === 'GET') {
    const rowsName = input.rowsName || resource;
    lines.push(`const ${rowsName} = computed(() => ${responseName}.value?.data || []);`);
    if (input.autoLoad !== false) {
      lines.push(`onMounted(() => { ${executeName}(); });`);
    }
  } else if (normalizedOperation === 'create') {
    const handlerName = input.handlerName || `create${pascal.replace(/s$/, '')}`;
    const payloadName = input.payloadName || 'payload';
    lines.push(...[
      '',
      `async function ${handlerName}(${payloadName}) {`,
      `  const response = await ${executeName}({ body: ${payloadName} });`,
      '  if (!response) return null;',
      '  return response;',
      '}',
    ]);
  } else if (normalizedOperation === 'update') {
    const handlerName = input.handlerName || `update${pascal.replace(/s$/, '')}`;
    const recordName = input.recordName || 'record';
    const bodyName = input.bodyName || 'body';
    const idExpression = input.idExpression || `${recordName}.id`;
    const bodyArg = bodyName === 'body' ? 'body' : `body: ${bodyName}`;
    lines.push(...[
      '',
      `async function ${handlerName}(${recordName}, ${bodyName}) {`,
      `  const response = await ${executeName}({ id: ${idExpression}, ${bodyArg} });`,
      '  if (!response) return null;',
      '  return response;',
      '}',
    ]);
  } else if (normalizedOperation === 'delete') {
    const handlerName = input.handlerName || `delete${pascal.replace(/s$/, '')}`;
    const recordName = input.recordName || 'record';
    const idExpression = input.idExpression || `${recordName}.id`;
    lines.push(...[
      '',
      `async function ${handlerName}(${recordName}) {`,
      `  const response = await ${executeName}({ id: ${idExpression} });`,
      '  if (!response) return null;',
      '  return response;',
      '}',
    ]);
  } else if (normalizedOperation === 'batch_update' || normalizedOperation === 'batch_delete') {
    const handlerName = input.handlerName || `${normalizedOperation === 'batch_update' ? 'update' : 'delete'}${pascal}Batch`;
    const idsName = input.idsName || 'ids';
    const bodyName = input.bodyName || 'body';
    const args = normalizedOperation === 'batch_update' ? `{ ids: ${idsName}, body: ${bodyName} }` : `{ ids: ${idsName} }`;
    lines.push(...[
      '',
      `async function ${handlerName}(${normalizedOperation === 'batch_update' ? `${idsName}, ${bodyName}` : idsName}) {`,
      `  const response = await ${executeName}(${args});`,
      '  if (!response) return null;',
      '  return response;',
      '}',
    ]);
  } else {
    const handlerName = input.handlerName || `${method.toLowerCase()}${pascal}Record`;
    lines.push(...[
      '',
      `async function ${handlerName}(payload) {`,
      `  const response = await ${executeName}({ body: payload });`,
      '  if (!response) return null;',
      '  return response;',
      '}',
    ]);
  }
  return {
    action: 'extension_api_usage_built',
    operation: normalizedOperation,
    snippet: lines.join('\n'),
    contract: [
      'useApi returns refs plus execute/refresh; it does not auto-run.',
      'The useApi path is the base route string or a () => string getter; do not pass computed refs and do not put :id placeholders in the path.',
      'Pass query/body as objects or computed objects, not JSON.stringify strings.',
      'For Enfyra REST ordering, use structured sort entries with field and direction; the generated query always emits one comma-separated sort string such as "-isPinned,-updatedAt", never sort arrays or field:DESC tokens.',
      'Read normal list rows from data.value?.data or from the direct execute() response.',
      'For mutations, call execute({ body }), execute({ id, body }), execute({ id }), or execute({ ids }) from a user action.',
    ],
  };
}

export function buildExtensionNotifySnippet(input: AnyRecord = {}) {
  const kind = ['success', 'error', 'warning', 'info'].includes(input.kind) ? input.kind : 'success';
  const title = input.title || (kind === 'success' ? 'Saved' : 'Notice');
  const description = input.description || '';
  const args = description ? `${quoteJsString(title)}, ${quoteJsString(description)}` : quoteJsString(title);
  return {
    action: 'extension_notify_usage_built',
    snippet: [
      'const notify = useNotify();',
      `await notify.${kind}(${args});`,
    ].join('\n'),
    contract: [
      'useNotify exposes success/error/warning/info(title, description?) helpers.',
      'Do not pass Nuxt toast object payloads and do not call notify.add().',
      'The helpers are async; await them inside submit/mutation handlers when ordering matters.',
    ],
  };
}

export function buildExtensionConfirmSnippet(input: AnyRecord = {}) {
  const resource = String(input.resource || 'items');
  const singular = resource.replace(/s$/i, '') || 'item';
  const pascal = toPascalIdentifier(resource, 'Items');
  const recordName = input.recordName || singular;
  const handlerName = input.handlerName || `confirmDelete${toPascalIdentifier(singular, 'Item')}`;
  const executeName = input.executeName || `delete${pascal}Api`;
  const refreshName = input.refreshName || `refresh${pascal}`;
  const idExpression = input.idExpression || `${recordName}.id`;
  const title = input.title || `Delete ${singular}`;
  const contentExpression = input.contentExpression || `\`Delete "\${${recordName}.title || 'this ${singular}'}"?\``;
  const confirmText = input.confirmText || 'Delete';
  const cancelText = input.cancelText || 'Cancel';
  const mutationExpression = input.mutationExpression || `${executeName}({ id: ${idExpression} })`;
  const refresh = input.refresh === false ? null : input.refreshExpression || refreshName;

  return {
    action: 'extension_confirm_workflow_built',
    snippet: [
      'const { confirm } = useConfirm();',
      '',
      `async function ${handlerName}(${recordName}) {`,
      '  const confirmed = await confirm({',
      `    title: ${quoteJsString(title)},`,
      `    content: ${contentExpression},`,
      `    confirmText: ${quoteJsString(confirmText)},`,
      `    cancelText: ${quoteJsString(cancelText)},`,
      '  });',
      '  if (!confirmed) return null;',
      '',
      `  const response = await ${mutationExpression};`,
      '  if (!response) return null;',
      ...(refresh ? ['', `  await ${refresh}();`] : []),
      '  return response;',
      '}',
    ].join('\n'),
    contract: [
      'useConfirm() opens the eApp GlobalConfirm/CommonModal and resolves true only after the user accepts.',
      'Run the destructive mutation only after confirmed is true, then refresh the affected resource list when needed.',
      'Never use window.confirm, window.alert, alert, or prompt in an extension.',
      'Use CommonModal directly only when the confirmation needs form fields, richer detail, or a custom destructive workflow that useConfirm cannot express.',
    ],
  };
}
