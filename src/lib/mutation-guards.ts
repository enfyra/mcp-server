const SCRIPT_TABLES = new Set([
  'enfyra_route_handler',
  'enfyra_pre_hook',
  'enfyra_post_hook',
  'enfyra_flow_step',
  'enfyra_websocket_event',
  'enfyra_websocket',
  'enfyra_graphql',
  'enfyra_bootstrap_script',
]);

const CODE_ALIAS_FORBIDDEN_TABLES = new Set([
  'enfyra_route_handler',
  'enfyra_pre_hook',
  'enfyra_post_hook',
  'enfyra_flow_step',
  'enfyra_websocket_event',
  'enfyra_websocket',
  'enfyra_graphql',
  'enfyra_bootstrap_script',
]);

const FORBIDDEN_RELATION_DEFINITION_KEYS = new Set([
  'fkCol',
  'fkColumn',
  'foreignKeyColumn',
  'sourceColumn',
  'targetColumn',
  'junctionSourceColumn',
  'junctionTargetColumn',
]);

export function parseRecordData(data) {
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Record data must be a single JSON object string for internal mutation preparation. Public MCP writes use create_records/update_records/delete_records with array inputs, including one-item arrays for single mutations.');
  }
  return parsed;
}

export function parseRecordBatchData(data) {
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  if (!Array.isArray(parsed)) {
    throw new Error('Batch record data must be a JSON array. For one record, pass one object in the array.');
  }
  if (parsed.length === 0) {
    throw new Error('Batch record data must include at least one record.');
  }
  parsed.forEach((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Batch record at index ${index} must be a JSON object.`);
    }
  });
  return parsed;
}

export function getAllowedMutationFields(table) {
  const columns = (table?.columns || []).map((column) => column.name).filter(Boolean);
  const relations = (table?.relations || []).map((relation) => relation.propertyName).filter(Boolean);
  return new Set([...columns, ...relations]);
}

export function validatePayloadFields(table, payload) {
  const allowed = getAllowedMutationFields(table);
  if (allowed.size === 0) return;

  const unknown = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    const relationNames = (table?.relations || []).map((relation) => relation.propertyName).filter(Boolean);
    const relationHints = unknown
      .map((key) => {
        const normalized = key
          .replace(/_?ids?$/i, '')
          .replace(/_id$/i, '')
          .replace(/Id$/i, '')
          .replace(/Ids$/i, '');
        const normalizedLower = normalized.toLowerCase();
        const relation = relationNames.find((name) => String(name).toLowerCase() === normalizedLower);
        return relation ? `${key} -> use relation property "${relation}" in the record body, not a physical FK column` : null;
      })
      .filter(Boolean);
    throw new Error(
      `Payload contains fields not present in metadata for ${table.name}: ${unknown.join(', ')}. ` +
      `This MCP already validated the payload against live metadata before sending it to Enfyra, so do not retry the same shape. ` +
      `Use only these metadata-backed columns and relation propertyName values: ${[...allowed].sort().join(', ')}. ` +
      (relationHints.length
        ? `Relation hint(s): ${relationHints.join('; ')}. `
        : '') +
      `Call inspect_table({ tableName: "${table.name}" }) if you need full column types, enum options, or relation targets. ` +
      'If this value links to another record, create/use an Enfyra relation and mutate the relation propertyName; Enfyra hides derived FK columns from app schema/forms.'
    );
  }
}

export function rejectUnsafeScriptPayload(tableName, payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'compiledCode')) {
    throw new Error('Do not send compiledCode. Save sourceCode/scriptLanguage and let Enfyra compile compiledCode.');
  }
  if (CODE_ALIAS_FORBIDDEN_TABLES.has(tableName) && Object.prototype.hasOwnProperty.call(payload, 'code')) {
    throw new Error(`Do not send code to ${tableName}. Use sourceCode/scriptLanguage, or the dedicated MCP create_* tool for this script surface.`);
  }
}

export function validatePortableScriptSource(sourceCode) {
  if (typeof sourceCode !== 'string') return;
  const secureDotPattern = /@REPOS\.secure\.[A-Za-z_][A-Za-z0-9_]*/;
  const secureBracketPattern = /@REPOS\.secure\s*\[/;
  if (secureDotPattern.test(sourceCode) || secureBracketPattern.test(sourceCode)) {
    throw new Error(
      'Portable dynamic scripts must not use @REPOS.secure.<table> or @REPOS.secure["table"]. ' +
      'That accessor is not callable on all Enfyra runtimes and causes handler/runtime retries. ' +
      'Use @REPOS.main for the route main table when one exists, or use #table_name / @REPOS.table_name with explicit fields, relation filters, authorization checks, and sanitized return data.'
    );
  }

  validateAwaitedRepositoryCalls(sourceCode);
  validateNumericThrowDetails(sourceCode);
}

function validateAwaitedRepositoryCalls(sourceCode) {
  const repoCallPattern = /(?:#[A-Za-z_][A-Za-z0-9_]*|@REPOS\.(?!secure\b)[A-Za-z_][A-Za-z0-9_]*|@REPOS\.main)\s*\.\s*(find|create|update|delete|exists)\s*\(/g;
  let match;
  while ((match = repoCallPattern.exec(sourceCode)) !== null) {
    const lineStart = sourceCode.lastIndexOf('\n', match.index) + 1;
    const beforeOnLine = sourceCode.slice(lineStart, match.index);
    if (/\bawait\s*$/u.test(beforeOnLine) || /\breturn\s+await\s*$/u.test(beforeOnLine)) continue;
    throw new Error(
      `Dynamic repository calls are async. Add await before ${match[0].trim()} and read repository reads from result.data, e.g. const result = await #table.find({ fields: ["id"], limit: 10 }); const rows = result.data || [].`
    );
  }
}

function validateNumericThrowDetails(sourceCode) {
  const macroPattern = /@THROW(?:400|401|403|404|409|422|429|500|503)\s*\(([\s\S]*?)\)/g;
  const ctxPattern = /\$ctx\.\$throw\[['"](?:400|401|403|404|409|422|429|500|503)['"]\]\s*\(([\s\S]*?)\)/g;

  for (const pattern of [macroPattern, ctxPattern]) {
    let match;
    while ((match = pattern.exec(sourceCode)) !== null) {
      const args = splitTopLevelArguments(match[1]);
      if (args.length <= 1) continue;
      const secondArg = args[1]?.trim() || '';
      if (!secondArg || /^[{\[]/.test(secondArg) || /^(null|undefined)$/u.test(secondArg)) continue;
      throw new Error(
        'Numeric @THROW helpers are raw HTTP message helpers. If you pass details, pass an object/array such as @THROW404("Project not found", { id }); for Enfyra-formatted semantic messages use @THROW.notFound(resource, id) or @THROW.duplicate(resource, field, value).'
      );
    }
  }
}

function splitTopLevelArguments(argsSource) {
  const args = [];
  let current = '';
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (const char of argsSource) {
    current += char;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '{' || char === '[') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ',' && depth === 0) {
      args.push(current.slice(0, -1));
      current = '';
    }
  }

  if (current.trim()) args.push(current);
  return args;
}

export function rejectUnsafeRelationDefinitionPayload(tableName, payload) {
  if (tableName !== 'enfyra_relation') return;
  const forbidden = Object.keys(payload).filter((key) => FORBIDDEN_RELATION_DEFINITION_KEYS.has(key));
  if (forbidden.length > 0) {
    throw new Error(
      `Do not send physical FK/junction fields to enfyra_relation: ${forbidden.join(', ')}. ` +
      'Use create_relations with targetTable/type/propertyName; Enfyra derives physical columns.'
    );
  }
}

export async function validateScriptSourceIfPresent(fetchAPI, apiUrl, tableName, payload) {
  if (!SCRIPT_TABLES.has(tableName) || typeof payload.sourceCode !== 'string') {
    return { validated: false, reason: 'no script source' };
  }

  validatePortableScriptSource(payload.sourceCode);

  try {
    const result = await fetchAPI(apiUrl, '/admin/script/validate', {
      method: 'POST',
      body: JSON.stringify({
        sourceCode: payload.sourceCode,
        scriptLanguage: payload.scriptLanguage || 'javascript',
      }),
    });
    if (result?.valid === false || result?.success === false) {
      throw new Error(result?.error?.message || 'Script validation failed.');
    }
    return { validated: true, skipped: false };
  } catch (error) {
    const message = String(error?.message || error);
    throw new Error(`Script validation failed before save: ${message}`);
  }
}

export async function prepareRecordMutation({ fetchAPI, apiUrl, tables, tableName, data }) {
  const payload = parseRecordData(data);
  const table = tables.find((item) => item?.name === tableName || item?.alias === tableName);
  if (!table) throw new Error(`Unknown table "${tableName}"`);

  validatePayloadFields(table, payload);
  rejectUnsafeScriptPayload(table.name, payload);
  rejectUnsafeRelationDefinitionPayload(table.name, payload);
  const scriptValidation = await validateScriptSourceIfPresent(fetchAPI, apiUrl, table.name, payload);

  return {
    table,
    payload,
    scriptValidation,
  };
}

export async function prepareRecordBatchMutation({ fetchAPI, apiUrl, tables, tableName, records }) {
  const parsedRecords = parseRecordBatchData(records);
  const table = tables.find((item) => item?.name === tableName || item?.alias === tableName);
  if (!table) throw new Error(`Unknown table "${tableName}"`);

  const preparedRecords = [];
  for (const [index, payload] of parsedRecords.entries()) {
    try {
      validatePayloadFields(table, payload);
      rejectUnsafeScriptPayload(table.name, payload);
      rejectUnsafeRelationDefinitionPayload(table.name, payload);
      const scriptValidation = await validateScriptSourceIfPresent(fetchAPI, apiUrl, table.name, payload);
      preparedRecords.push({
        index,
        payload,
        scriptValidation,
      });
    } catch (error) {
      throw new Error(`Record batch preflight failed at index ${index}: ${error?.message || String(error)}`);
    }
  }

  return {
    table,
    records: preparedRecords,
  };
}
