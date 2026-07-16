import { z } from 'zod';
import { jsonContent } from './response-format.js';

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

export function buildDynamicRepositoryUsage(input: {
  access: 'secure_main' | 'secure_explicit' | 'trusted_explicit';
  operation: 'list' | 'find_one' | 'create' | 'update' | 'delete';
  tableName?: string;
  fields?: string[];
  idField?: string;
  idSource?: 'params' | 'body';
}) {
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
      aggregate: 'undefined',
      debugMode: 'undefined',
    }
    : {
      deep: '@QUERY.deep',
      meta: '@QUERY.meta',
      aggregate: '@QUERY.aggregate',
      debugMode: '@QUERY.debugMode',
    };
  const idField = requireIdentifier(input.idField || 'id', 'idField');
  const idExpression = input.idSource === 'body' ? '@BODY.id' : '@PARAMS.id';
  let code: string;

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
  aggregate: ${outputExpansion.aggregate},
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
if (!record) @THROW404("Record not found", { ${idField}: ${idExpression} })
return record`;
  } else if (input.operation === 'create') {
    code = `const result = await ${repository}.create({
  data: @BODY,
  fields: ${fields}
})

const record = result.data?.[0] ?? null
return record`;
  } else if (input.operation === 'update') {
    code = `const result = await ${repository}.update({
  id: ${idExpression},
  data: @BODY,
  fields: ${fields}
})

const record = result.data?.[0] ?? null
return record`;
  } else {
    code = `await ${repository}.delete({ id: ${idExpression} })
return { ok: true, id: ${idExpression} }`;
  }

  const fieldPermissionsEnforced = input.access !== 'trusted_explicit';
  const typeOrmPartialBody = input.operation === 'create' || input.operation === 'update';
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
    adaptationRecipes: {
      serverOwnedField: 'When the live metadata identifies a server-owned field, adapt the mutation to data: { ...@BODY, <server_owned_field>: @USER.id } so caller input cannot override it.',
      scopedMutation: 'For endpoint-specific owner/tenant policy, load the target with both id and the owner/tenant filter before update/delete, then perform the repository mutation.',
      nonUpdatableServerAction: 'Do not change canonical metadata isUpdatable merely so a custom action can write a server-owned field. Prove row scope with a secure lookup, then use a trusted explicit repository for an exact server-controlled write with no raw @BODY and return a shaped response.',
      customValidation: 'Custom handlers do not inherit canonical column-rule/Zod body middleware. Validate extra business semantics in the handler when required.',
    },
    code,
    next: 'Adapt only live field, filter, owner/tenant, and domain error details; keep the repository access class, await, result.data shape, and bounded query contract.',
  };
}

export function registerDynamicRepositoryBuilder(server: any) {
  server.tool(
    'build_dynamic_repository_usage',
    [
      'Generate validated Enfyra dynamic repository code for list, find-one, create, update, or delete.',
      'Use secure_main for a canonical route main table, secure_explicit for user-facing explicit-table access, and trusted_explicit only for intentional internal field-permission bypass.',
    ].join(' '),
    {
      access: z.enum(['secure_main', 'secure_explicit', 'trusted_explicit']).describe('Repository security class. Prefer secure_main or secure_explicit for user-facing code.'),
      operation: z.enum(['list', 'find_one', 'create', 'update', 'delete']).describe('Repository operation pattern to generate.'),
      tableName: z.string().optional().describe('Required for explicit access. Omit for secure_main when the route main table is already known.'),
      fields: z.array(z.string()).optional().describe('Exact metadata-backed fields to select or return. Defaults to id.'),
      idField: z.string().optional().default('id').describe('Primary key field used by find_one. Defaults to id; use _id for Mongo metadata when applicable.'),
      idSource: z.enum(['params', 'body']).optional().default('params').describe('Read record id from @PARAMS.id or @BODY.id.'),
    },
    async (input) => jsonContent(buildDynamicRepositoryUsage(input)),
  );
}
