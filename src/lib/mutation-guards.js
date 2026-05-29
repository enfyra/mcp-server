const SCRIPT_TABLES = new Set([
  'route_handler_definition',
  'pre_hook_definition',
  'post_hook_definition',
  'flow_step_definition',
  'websocket_event_definition',
  'websocket_definition',
  'gql_definition',
  'bootstrap_script_definition',
]);

const CODE_ALIAS_FORBIDDEN_TABLES = new Set([
  'route_handler_definition',
  'pre_hook_definition',
  'post_hook_definition',
  'flow_step_definition',
  'websocket_event_definition',
  'websocket_definition',
  'gql_definition',
  'bootstrap_script_definition',
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
    throw new Error('Record data must be a JSON object string.');
  }
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
    throw new Error(
      `Payload contains fields not present in metadata for ${table.name}: ${unknown.join(', ')}. ` +
      `Use metadata-backed fields only, or create the field through schema tools first. Known fields: ${[...allowed].sort().join(', ')}`
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

export function rejectUnsafeRelationDefinitionPayload(tableName, payload) {
  if (tableName !== 'relation_definition') return;
  const forbidden = Object.keys(payload).filter((key) => FORBIDDEN_RELATION_DEFINITION_KEYS.has(key));
  if (forbidden.length > 0) {
    throw new Error(
      `Do not send physical FK/junction fields to relation_definition: ${forbidden.join(', ')}. ` +
      'Use create_relation/add_relation with targetTable/type/propertyName; Enfyra derives physical columns.'
    );
  }
}

export async function validateScriptSourceIfPresent(fetchAPI, apiUrl, tableName, payload) {
  if (!SCRIPT_TABLES.has(tableName) || typeof payload.sourceCode !== 'string') {
    return { validated: false, reason: 'no script source' };
  }

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
