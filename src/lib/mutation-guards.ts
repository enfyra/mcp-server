const SCRIPT_TABLES = new Set([
  'enfyra_route_handler',
  'enfyra_pre_hook',
  'enfyra_post_hook',
  'enfyra_flow_step',
  'enfyra_websocket_event',
  'enfyra_websocket',
  'enfyra_oauth_config',
  'enfyra_bootstrap_script',
]);

const CODE_ALIAS_FORBIDDEN_TABLES = new Set([
  'enfyra_route_handler',
  'enfyra_pre_hook',
  'enfyra_post_hook',
  'enfyra_flow_step',
  'enfyra_websocket_event',
  'enfyra_websocket',
  'enfyra_oauth_config',
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

const DOMAIN_OWNED_RECORD_MUTATIONS: Record<string, Partial<Record<'create' | 'update' | 'delete', string>>> = {
  enfyra_table: {
    create: 'create_tables',
    update: 'update_tables',
    delete: 'delete_tables',
  },
  enfyra_column: {
    create: 'create_columns',
    update: 'update_columns',
    delete: 'delete_columns',
  },
  enfyra_relation: {
    create: 'create_relations',
    update: 'delete_relations followed by create_relations',
    delete: 'delete_relations',
  },
  enfyra_route: {
    create: 'api_endpoint_workflow',
    update: 'api_endpoint_workflow or the route access/public-method tools (add_route_methods, replace_route_methods, remove_route_methods, enable_route, disable_route, public_route_methods, private_route_methods)',
    delete: 'delete_route',
  },
  enfyra_route_handler: {
    create: 'create_handler or api_endpoint_workflow',
    update: 'patch_script_source / update_script_source for source edits, or api_endpoint_workflow(overwrite=true) for full handler replacement',
    delete: 'delete_route (cascades all handlers) — individual handler removal requires full toolset',
  },
  enfyra_pre_hook: {
    create: 'create_pre_hook',
    update: 'patch_script_source / update_script_source for source edits',
    delete: 'delete_route (cascades all hooks) — individual hook removal requires full toolset',
  },
  enfyra_post_hook: {
    create: 'create_post_hook',
    update: 'patch_script_source / update_script_source for source edits',
    delete: 'delete_route (cascades all hooks) — individual hook removal requires full toolset',
  },
  enfyra_route_permission: {
    create: 'ensure_route_access',
    update: 'ensure_route_access (mode=merge or mode=replace)',
    delete: 'ensure_route_access(mode=replace, methods=[]) to revoke, or delete_route to cascade — individual permission removal requires full toolset',
  },
  enfyra_method: {
    create: 'create_method',
    update: 'update_method',
    delete: 'delete_method',
  },
  enfyra_guard: {
    create: 'ensure_guard or ensure_route_rate_limit',
    update: 'ensure_guard or ensure_route_rate_limit',
    delete: 'ensure_guard(isEnabled=false) to disable — physical removal requires full toolset',
  },
  enfyra_guard_rule: {
    create: 'ensure_guard (rulesMode=replace or rulesMode=append)',
    update: 'ensure_guard (rulesMode=replace)',
    delete: 'ensure_guard (rulesMode=replace with reduced rules) — individual rule removal requires full toolset',
  },
  enfyra_field_permission: {
    create: 'ensure_field_permission',
    update: 'ensure_field_permission',
    delete: 'ensure_field_permission with effect=deny to override — physical removal requires full toolset',
  },
  enfyra_column_rule: {
    create: 'ensure_column_rule',
    update: 'ensure_column_rule',
    delete: 'ensure_column_rule(isEnabled=false) to disable — physical removal requires full toolset',
  },
  enfyra_graphql: {
    create: 'set_table_graphql',
    update: 'set_table_graphql',
    delete: 'set_table_graphql(isEnabled=false) to disable',
  },
  enfyra_flow: {
    create: 'flow_workflow',
    update: 'flow_workflow',
    delete: 'flow_workflow or disable via flow editor — physical removal requires full toolset',
  },
  enfyra_flow_step: {
    create: 'flow_workflow (manages steps within a flow)',
    update: 'flow_workflow or patch_script_source / update_script_source for source edits',
    delete: 'flow_workflow (omit the step to remove it) — individual step removal requires full toolset',
  },
  enfyra_flow_trigger: {
    create: 'ensure_flow_trigger',
    update: 'ensure_flow_trigger or remove_flow_trigger to disable',
    delete: 'remove_flow_trigger to disable — physical removal requires full toolset',
  },
  enfyra_flow_execution: {
    create: 'trigger_flow',
    update: 'read-only runtime table — execution state is system-managed',
    delete: 'read-only runtime table — execution cleanup requires full toolset',
  },
  enfyra_websocket: {
    create: 'ensure_websocket_gateway',
    update: 'ensure_websocket_gateway or patch_script_source / update_script_source for source edits',
    delete: 'physical removal requires full toolset',
  },
  enfyra_websocket_event: {
    create: 'ensure_websocket_event',
    update: 'ensure_websocket_event or patch_script_source / update_script_source for source edits',
    delete: 'physical removal requires full toolset',
  },
  enfyra_extension: {
    create: 'ensure_page_extension / ensure_global_extension / ensure_widget_extension or extension_workflow',
    update: 'patch_extension_code / update_extension_code',
    delete: 'physical removal requires full toolset after verifying menu wiring',
  },
  enfyra_menu: {
    create: 'ensure_menu',
    update: 'ensure_menu or reorder_menus',
    delete: 'physical removal requires full toolset after verifying child/extension dependencies',
  },
  enfyra_package: {
    create: 'install_package',
    update: 'install_package (re-install with new version) — upgrade requires full toolset',
    delete: 'physical removal requires full toolset',
  },
  enfyra_oauth_config: {
    create: 'setup_oauth_provider',
    update: 'setup_oauth_provider',
    delete: 'physical removal requires full toolset',
  },
  enfyra_bootstrap_script: {
    create: 'full toolset only — bootstrap scripts are platform-owned',
    update: 'patch_script_source / update_script_source for source edits',
    delete: 'full toolset only — bootstrap scripts are platform-owned',
  },
  enfyra_user: {
    create: 'full toolset with identity safeguards — inspect enfyra_user schema first',
    update: 'full toolset with identity safeguards',
    delete: 'full toolset with identity safeguards',
  },
  enfyra_role: {
    create: 'full toolset — inspect enfyra_role schema and check system-role protections first',
    update: 'full toolset — check system-role protections first',
    delete: 'full toolset — check role usage impact first',
  },
  enfyra_oauth_account: {
    create: 'identity-owned — OAuth accounts are created through the OAuth login flow',
    update: 'full toolset',
    delete: 'full toolset — unlinking requires identity safeguards',
  },
  enfyra_file_permission: {
    create: 'full toolset — inspect enfyra_file_permission schema first',
    update: 'full toolset',
    delete: 'full toolset',
  },
};

const SYSTEM_TABLE_PREFIX = 'enfyra_';

export function isSystemTable(tableName: string): boolean {
  return String(tableName || '').startsWith(SYSTEM_TABLE_PREFIX);
}

export function getDomainOwner(tableName: string, operation: 'create' | 'update' | 'delete'): string | undefined {
  return DOMAIN_OWNED_RECORD_MUTATIONS[String(tableName || '')]?.[operation];
}

export function assertGenericRecordMutationAllowed(operation, tableName) {
  const owner = DOMAIN_OWNED_RECORD_MUTATIONS[String(tableName || '')]?.[operation];
  if (!owner) return;
  throw new Error(
    `Generic ${operation}_records is blocked for domain-owned metadata table "${tableName}". Use ${owner} so Enfyra applies dependency checks, physical schema/runtime changes, reloads, and destructive previews correctly.`,
  );
}

export function resolveCanonicalTableName(tables: Array<{ name?: string; alias?: string }>, tableName: string): string {
  const match = tables.find((item) => item?.name === tableName || item?.alias === tableName);
  if (!match) throw new Error(
    `Unknown table "${tableName}". Call get_all_metadata({ search: "${tableName}" }) or inspect_table({ tableName }) to discover the canonical table name, then retry.`,
  );
  return match.name || tableName;
}

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
  validateLogsContract(sourceCode);
  validateSocketContract(sourceCode);
  validateAwaitedRepositoryCalls(sourceCode);
  validateNumericThrowDetails(sourceCode);
}

function validateSocketContract(sourceCode) {
  const unsupportedEmit = /(?:@SOCKET|\$ctx\.\$socket)\s*\.\s*emit\s*\(/u.exec(sourceCode);
  if (!unsupportedEmit) return;
  throw new Error(
    '@SOCKET has no generic emit() method. In websocket event/connection scripts use reply, emitToCurrentRoom, or broadcastToRoom; from global HTTP/flow contexts use emitToGateway, emitToRoom, emitToUser, or broadcast.'
  );
}

function validateLogsContract(sourceCode) {
  const methodCall = /@LOGS\s*\.\s*(?:info|warn|error|debug|log)\s*\(/u.exec(sourceCode);
  if (!methodCall) return;
  throw new Error(
    '@LOGS is callable, not a console/logger object. Use @LOGS(message, details?) such as @LOGS("Approval requested", { requestId }); do not use @LOGS.info/@LOGS.warn/@LOGS.error/@LOGS.debug.'
  );
}

function validateAwaitedRepositoryCalls(sourceCode) {
  const repoCallPattern = /(?:#secure\.[A-Za-z_][A-Za-z0-9_]*|#[A-Za-z_][A-Za-z0-9_]*|@REPOS\.secure\.[A-Za-z_][A-Za-z0-9_]*|@REPOS\.(?!secure\b)[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(find|create|update|delete|exists)\s*\(/g;
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

export async function prepareRecordMutation({ fetchAPI, apiUrl, tables, tableName, data, operation }) {
  const payload = parseRecordData(data);
  const table = tables.find((item) => item?.name === tableName || item?.alias === tableName);
  if (!table) throw new Error(
    `Unknown table "${tableName}". Call get_all_metadata({ search: "${tableName}" }) or inspect_table({ tableName }) to discover the canonical table name, then retry.`,
  );
  if (operation) assertGenericRecordMutationAllowed(operation, table.name);

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

export async function prepareRecordBatchMutation({ fetchAPI, apiUrl, tables, tableName, records, operation }) {
  const parsedRecords = parseRecordBatchData(records);
  const table = tables.find((item) => item?.name === tableName || item?.alias === tableName);
  if (!table) throw new Error(
    `Unknown table "${tableName}". Call get_all_metadata({ search: "${tableName}" }) or inspect_table({ tableName }) to discover the canonical table name, then retry.`,
  );
  if (operation) assertGenericRecordMutationAllowed(operation, table.name);

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
