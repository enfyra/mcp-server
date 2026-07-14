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
  const idField = requireIdentifier(input.idField || 'id', 'idField');
  const idExpression = input.idSource === 'body' ? '@BODY.id' : '@PARAMS.id';
  let code: string;

  if (input.operation === 'list') {
    code = `const result = await ${repository}.find({
  fields: @QUERY.fields?.length ? @QUERY.fields : ${fields},
  filter: @QUERY.filter || {},
  deep: @QUERY.deep,
  sort: @QUERY.sort,
  page: @QUERY.page,
  limit: Math.min(Number(@QUERY.limit) || 50, 100),
  meta: @QUERY.meta,
  aggregate: @QUERY.aggregate,
  debugMode: @QUERY.debugMode
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
  return {
    access: input.access,
    operation: input.operation,
    tableName,
    repository,
    fieldPermissionsEnforced,
    securityBoundary: fieldPermissionsEnforced
      ? 'Field permissions are enforced by the selected secure repository. Owner, tenant, membership, and route authorization remain separate checks.'
      : 'This trusted repository bypasses field permissions. Use it only for intentional internal work, request exact fields, enforce authorization explicitly, and never return raw trusted rows.',
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
