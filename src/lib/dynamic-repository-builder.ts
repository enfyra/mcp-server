import { z } from 'zod';
import { jsonContent } from './response-format.js';
import type { DynamicRepositoryUsageInput, DynamicRepositoryRuntimeRequirements } from '../types/dynamic-repository-builder.types.js';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireIdentifier(value: string | undefined, label: string) {
  if (!value || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid Enfyra identifier using letters, digits, and underscores.`);
  }
  return value;
}

function fieldList(fields?: string[]) {
  const values = fields?.length ? fields : ['id'];
  for (const field of values) requireIdentifier(field, 'Each field');
  return `[${values.map((field) => JSON.stringify(field)).join(', ')}]`;
}

export function buildDynamicRepositoryUsage(input: DynamicRepositoryUsageInput) {
  const tableName = input.access === 'secure_main'
    ? input.tableName || null
    : requireIdentifier(input.tableName, 'tableName');
  const repository = input.access === 'secure_main'
    ? '@REPOS.main'
    : input.access === 'secure_explicit'
      ? `#secure.${tableName}`
      : `#${tableName}`;
  const fields = fieldList(input.fields);
  const selectedFields = input.access === 'trusted_explicit'
    ? fields
    : 'requestedFields?.length ? requestedFields : ' + fields;
  const outputExpansion = input.access === 'trusted_explicit'
    ? {
      deep: 'undefined',
      meta: 'undefined',
      debugMode: 'undefined',
    }
    : {
      deep: '@QUERY.deep',
      meta: '@QUERY.meta',
      debugMode: '@QUERY.debugMode',
    };
  const idField = requireIdentifier(input.idField || 'id', 'idField');
  const idExpression = input.idSource === 'body' ? '@BODY.id' : '@PARAMS.id';
  let code: string;
  let runtimeRequirements: DynamicRepositoryRuntimeRequirements | undefined;

  if (input.operation === 'list') {
    const fieldNormalization = input.access === 'trusted_explicit'
      ? ''
      : `const requestedFields = (() => {
  const rawFields = @QUERY.fields
  if (Array.isArray(rawFields)) return rawFields
  if (typeof rawFields !== 'string') return undefined
  try {
    const parsedFields = JSON.parse(rawFields)
    if (Array.isArray(parsedFields)) return parsedFields
  } catch {}
  return rawFields.split(',').map((field) => field.trim()).filter(Boolean)
})()

`;
    code = `${fieldNormalization}const result = await ${repository}.find({
  fields: ${selectedFields},
  filter: @QUERY.filter || {},
  deep: ${outputExpansion.deep},
  sort: @QUERY.sort,
  page: @QUERY.page,
  limit: Math.min(Number(@QUERY.limit) || 50, 100),
  meta: ${outputExpansion.meta},
  debugMode: ${outputExpansion.debugMode}
})

return result`;
  } else if (input.operation === 'find_one') {
    code = `const result = await ${repository}.find({
  filter: { ${idField}: { _eq: ${idExpression} } },
  fields: ${fields},
  limit: 1
})

const record = result.data?.[0] ?? null
if (!record) @THROW404("Record not found")
return record`;
  } else if (input.operation === 'find_locked') {
    if (idField !== 'id') throw new Error('find_locked requires a PostgreSQL/MySQL primary-key id. MongoDB lock-only reads are unsupported.');
    runtimeRequirements = {
      databases: ['postgres', 'mysql'],
      requiresOuterTransaction: true,
      verification: 'Verify findLocked through a non-saving test on the deployed Server/Kernel before using this generated source. Keep dependent repository work inside the same outer transaction callback.',
    };
    code = `return await @TRANSACTION.run(async () => {
  const result = await ${repository}.findLocked({
    id: ${idExpression},
    fields: ${fields}
  })
  const record = result.data?.[0] ?? null
  if (!record) @THROW404("Record not found")
  return record
})`;
  } else if (input.operation === 'create') {
    code = `const result = await ${repository}.create({
  data: @BODY,
  fields: ${fields}
})

const record = result.data?.[0] ?? null
return record`;
  } else if (input.operation === 'create_many') {
    code = `const rows = @BODY.records
if (!Array.isArray(rows) || rows.length === 0) @THROW400("records must be a non-empty array")

const result = await ${repository}.createMany({
  data: rows,
  fields: ${fields}
})

return { data: result.data, count: result.count }`;
  } else if (input.operation === 'update') {
    code = `const result = await ${repository}.update({
  id: ${idExpression},
  data: @BODY,
  fields: ${fields}
})

const record = result.data?.[0] ?? null
return record`;
  } else if (input.operation === 'update_locked') {
    const counterField = requireIdentifier(input.counterField, 'counterField');
    code = `const amount = Number(@BODY.amount)
if (!Number.isFinite(amount) || amount <= 0) @THROW400("amount must be positive")

const result = await ${repository}.updateLocked({
  id: ${idExpression},
  fields: ${fields},
  data: (current) => {
    if (current.${counterField} < amount) @THROW400("Insufficient ${counterField}")
    return { ${counterField}: current.${counterField} - amount }
  }
})

return result.data?.[0] ?? null`;
  } else if (input.operation === 'update_many') {
    code = `const ids = @BODY.ids
if (!Array.isArray(ids) || ids.length === 0) @THROW400("ids must be a non-empty array")
if (!@BODY.data || typeof @BODY.data !== "object" || Array.isArray(@BODY.data)) @THROW400("data must be an object")

const result = await ${repository}.updateMany({
  ids,
  data: @BODY.data,
  fields: ${fields}
})

return { data: result.data, count: result.count }`;
  } else if (input.operation === 'delete_many') {
    code = `const ids = @BODY.ids
if (!Array.isArray(ids) || ids.length === 0) @THROW400("ids must be a non-empty array")

const result = await ${repository}.deleteMany({ ids })
return { ok: true, count: result.count }`;
  } else if (input.operation === 'delete') {
    code = `await ${repository}.delete({ id: ${idExpression} })
return { ok: true, id: ${idExpression} }`;
  } else {
    throw new Error('Unsupported repository operation');
  }

  const fieldPermissionsEnforced = input.access !== 'trusted_explicit';
  const typeOrmPartialBody = input.operation === 'create' || input.operation === 'create_many' || input.operation === 'update' || input.operation === 'update_locked' || input.operation === 'update_many';
  return {
    access: input.access,
    operation: input.operation,
    tableName,
    repository,
    fieldPermissionsEnforced,
    securityBoundary: fieldPermissionsEnforced
      ? 'Field permissions are enforced by the selected secure repository. Owner, tenant, membership, and route authorization remain separate checks.'
      : 'This trusted repository bypasses field permissions. Use it only for intentional internal work, request exact fields, enforce authorization explicitly, and never return raw trusted rows.',
    typeOrmPartialBody,
    ...(runtimeRequirements ? { runtimeRequirements } : {}),
    adaptationRecipes: {
      serverOwnedField: 'When the live metadata identifies a server-owned field, adapt the mutation to data: { ...@BODY, <server_owned_field>: @USER.id } so caller input cannot override it.',
      scopedMutation: 'For endpoint-specific owner/tenant policy, load the target with both id and the owner/tenant filter before update/delete, then perform the repository mutation.',
      nonUpdatableServerAction: 'Do not change canonical metadata isUpdatable merely so a custom action can write a server-owned field. Prove row scope with a secure lookup, then use a trusted explicit repository for an exact server-controlled write with no raw @BODY and return a shaped response.',
      customValidation: 'Custom handlers do not inherit canonical column-rule/Zod body middleware. Validate extra business semantics in the handler when required.',
      lockedUpdate: 'updateLocked({ id, fields?, data: current => patch }) takes one object with the same keys as update. data is a callback returning the partial record; fields selects the response. PostgreSQL/MySQL lock the root row; Mongo requires native transactions and may rerun the data callback on conflict. Only plain generic tables are supported. Keep callbacks free of external side effects and repository calls. Set literals and computed values together in the returned patch. Existing outer transactions own commit and Mongo retry. Secure callbacks only receive readable fields. Owner/tenant checks that depend on current state belong inside the data callback.',
      lockedRead: 'findLocked({ id, fields?, deep? }) requires an explicit outer @TRANSACTION.run on PostgreSQL/MySQL. It performs an authorized read with no write or mutation event, retaining the root row lock until outer commit/rollback. Put owner/tenant checks and all dependent repository reads/writes inside that outer callback. A persisted identity can coordinate bootstrap before a balance exists. Related rows, absent rows and post-commit cache/socket publication are separate boundaries; every competing writer must participate. Do not acquire locks by dummy updates. MongoDB/SQLite lock-only reads are unsupported. Verify deployed runtime support before use.',
    },
    code,
    next: 'Adapt only live field, filter, owner/tenant, and domain error details; keep the repository access class, await, result.data shape, and bounded query contract.',
  };
}

export function registerDynamicRepositoryBuilder(server: any) {
  server.tool(
    'build_dynamic_repository_usage',
    [
      'Generate validated Enfyra dynamic repository code for list, find-one, findLocked inside an outer transaction, single or batch create/update/delete, and protected updateLocked.',
      'Use secure_main for a canonical route main table, secure_explicit for user-facing explicit-table access, and trusted_explicit only for intentional internal field-permission bypass.',
    ].join(' '),
    {
      access: z.enum(['secure_main', 'secure_explicit', 'trusted_explicit']).describe('Repository security class. Prefer secure_main or secure_explicit for user-facing code.'),
      operation: z.enum(['list', 'find_one', 'find_locked', 'create', 'create_many', 'update', 'update_locked', 'update_many', 'delete', 'delete_many']).describe('Repository operation. find_locked requires deployed PostgreSQL/MySQL support and generates an outer transaction. update_locked generates a guarded decrement callback and requires counterField.'),
      counterField: z.string().optional().describe('Exact readable/updatable numeric field from live metadata; required for update_locked.'),
      tableName: z.string().optional().describe('Required for explicit access. Omit for secure_main when the route main table is already known.'),
      fields: z.array(z.string()).optional().describe('Exact metadata-backed fields to select or return. Defaults to id.'),
      idField: z.string().optional().default('id').describe('Primary key field used by find_one. Defaults to id; use _id for Mongo metadata when applicable.'),
      idSource: z.enum(['params', 'body']).optional().default('params').describe('Read record id from @PARAMS.id or @BODY.id.'),
    },
    async (input) => jsonContent(buildDynamicRepositoryUsage(input)),
  );
}
