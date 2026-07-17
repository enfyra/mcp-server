import type {
  DynamicEndpointContractReview,
  DynamicEndpointMetadataSummary,
  DynamicEndpointReviewFinding,
  DynamicEndpointReviewInput,
  UnknownRecord,
} from './types.js';

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
const SECURE_EXPLICIT_PATTERN = new RegExp(`(?:#secure\\.|@REPOS\\.secure\\.)(${IDENTIFIER})\\s*\\.`, 'g');
const TRUSTED_EXPLICIT_PATTERN = new RegExp(`(?:#(?!secure\\.)|@REPOS\\.(?!main\\b|secure\\b))(${IDENTIFIER})\\s*\\.`, 'g');
const MAIN_REPOSITORY_PATTERN = /@REPOS\.main\s*\./u;
const RAW_BODY_PATTERN = /\bdata\s*:\s*@BODY\b|\.\.\.\s*@BODY\b/u;
const MUTATION_PATTERN = /\.(?:create|update|delete)\s*\(/u;
const DIRECT_REPOSITORY_DATA_RETURN_PATTERN = /\breturn\s+[^;\n]*(?:\.data\b|\.data\?\.\[|\.data\s*\[)/u;

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function matches(pattern: RegExp, sourceCode: string) {
  pattern.lastIndex = 0;
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sourceCode)) !== null) {
    if (match[1]) values.push(match[1]);
  }
  return values;
}

export function extractExplicitRepositoryTableNames(sourceCode: string) {
  return unique([
    ...matches(SECURE_EXPLICIT_PATTERN, sourceCode),
    ...matches(TRUSTED_EXPLICIT_PATTERN, sourceCode),
  ]);
}

function names(records: unknown, key: string, predicate: (record: UnknownRecord) => boolean) {
  if (!Array.isArray(records)) return [];
  return records
    .filter((record): record is UnknownRecord => Boolean(record && typeof record === 'object'))
    .filter(predicate)
    .map((record) => String(record[key] || ''))
    .filter(Boolean)
    .sort();
}

function summarizeMetadata(table: UnknownRecord): DynamicEndpointMetadataSummary {
  const columns = table.columns;
  const relations = table.relations;
  return {
    primaryFields: names(columns, 'name', (column) => column.isPrimary === true),
    publishedUpdatableFields: names(columns, 'name', (column) => (
      column.isPrimary !== true
      && column.isPublished !== false
      && column.isUpdatable !== false
    )),
    unpublishedFields: names(columns, 'name', (column) => column.isPublished === false),
    nonUpdatableFields: names(columns, 'name', (column) => column.isUpdatable === false),
    encryptedFields: names(columns, 'name', (column) => column.isEncrypted === true),
    publishedRelations: names(relations, 'propertyName', (relation) => relation.isPublished !== false),
    unpublishedRelations: names(relations, 'propertyName', (relation) => relation.isPublished === false),
  };
}

function finding(code: string, message: string): DynamicEndpointReviewFinding {
  return { code, message };
}

export function reviewDynamicEndpointContract(input: DynamicEndpointReviewInput): DynamicEndpointContractReview {
  const sourceCode = String(input.sourceCode || '');
  const method = String(input.method || '').toUpperCase();
  const usesMainRepository = MAIN_REPOSITORY_PATTERN.test(sourceCode);
  const secureTables = unique(matches(SECURE_EXPLICIT_PATTERN, sourceCode));
  const trustedTables = unique(matches(TRUSTED_EXPLICIT_PATTERN, sourceCode));
  const usesRawBody = RAW_BODY_PATTERN.test(sourceCode);
  const usesMutation = MUTATION_PATTERN.test(sourceCode);
  const returnsRepositoryDataDirectly = DIRECT_REPOSITORY_DATA_RETURN_PATTERN.test(sourceCode);
  const errors: DynamicEndpointReviewFinding[] = [];
  const warnings: DynamicEndpointReviewFinding[] = [];
  const info: DynamicEndpointReviewFinding[] = [];

  if (/\bexport\s+default\b|\bmodule\.exports\b|\bexports\s*\./u.test(sourceCode)) {
    errors.push(finding(
      'module_wrapper_not_supported',
      'Dynamic endpoint sourceCode is the handler body. Remove export default, module.exports, or exports.* wrappers before saving.',
    ));
  }

  if (input.routeKind === 'custom' && usesMainRepository) {
    errors.push(finding(
      'custom_route_main_repository',
      'Custom routes have no main table. Use #secure.<table> or @REPOS.secure.<table> for user-facing explicit-table access.',
    ));
  }
  if (trustedTables.length > 0) {
    warnings.push(finding(
      'trusted_repository_bypass',
      `Trusted repositories bypass field permissions: ${trustedTables.join(', ')}. Keep them only for intentional internal work.`,
    ));
    if (returnsRepositoryDataDirectly) {
      warnings.push(finding(
        'raw_trusted_repository_output',
        'The handler appears to return repository data directly while using trusted access. Shape the user-facing response explicitly.',
      ));
    }
  }
  if (input.metadataUnavailable?.length) {
    warnings.push(finding(
      'repository_metadata_unavailable',
      `Live metadata could not be loaded for: ${unique(input.metadataUnavailable).join(', ')}. Confirm table names before saving.`,
    ));
  }
  if (input.metadataTruncated) {
    warnings.push(finding(
      'repository_metadata_review_truncated',
      'The handler references more than five explicit repositories. Review the remaining tables separately before saving.',
    ));
  }
  if (usesRawBody && usesMutation) {
    info.push(finding(
      'typeorm_partial_body',
      'Passing @BODY as repository data is the supported TypeORM-style partial-entity contract. Repository sanitation does not infer owner, tenant, or business invariants.',
    ));
  }
  if (input.routeKind === 'custom' && usesMutation && (method === 'POST' || method === 'PATCH' || !method)) {
    info.push(finding(
      'custom_body_validation_boundary',
      'Custom repository writes do not pass through canonical route column-rule/Zod body middleware. Validate endpoint-specific business semantics in the handler when required.',
    ));
  }

  const metadata = Object.fromEntries(
    Object.entries(input.tableMetadata || {}).map(([tableName, table]) => [tableName, summarizeMetadata(table)]),
  );
  const hasNonUpdatableDomainFields = Object.values(metadata).some((summary) => (
    summary.nonUpdatableFields.some((field) => !['id', '_id', 'createdAt', 'updatedAt'].includes(field))
  ));
  const verification = [
    'Smoke-test the saved route through test_rest_endpoint.',
    ...(usesMutation ? ['Test an invalid business payload because custom handlers do not inherit canonical body validation.'] : []),
    ...(trustedTables.length > 0 ? ['Verify the response contains only explicitly shaped public fields.'] : []),
    ...(usesMutation && hasNonUpdatableDomainFields ? ['Re-inspect live metadata after E2E setup. Do not change isUpdatable merely to seed fixtures or let this custom action write a server-owned field.'] : []),
    ...(sourceCode.includes('@USER') ? ['Test a second caller or spoofed ownership value against the endpoint-specific row policy.'] : []),
  ];
  const status = errors.length > 0
    ? 'blocked'
    : warnings.length > 0
      ? 'review_required'
      : 'ready';

  return {
    status,
    errors,
    warnings,
    info,
    errorCodes: errors.map((item) => item.code),
    warningCodes: warnings.map((item) => item.code),
    infoCodes: info.map((item) => item.code),
    signals: {
      usesMainRepository,
      usesSecureExplicitRepository: secureTables.length > 0,
      usesTrustedExplicitRepository: trustedTables.length > 0,
      usesRawBody,
      usesMutation,
      returnsRepositoryDataDirectly,
    },
    repositoryTables: unique([...secureTables, ...trustedTables]),
    metadata,
    verification,
  };
}

export function assertDynamicEndpointContract(review: DynamicEndpointContractReview) {
  if (review.status !== 'blocked') return;
  throw new Error(review.errors.map((item) => item.message).join(' '));
}

export function assertCustomEndpointRoute(route: { path?: unknown; mainTable?: unknown } | null | undefined) {
  if (!route?.mainTable) return;
  const path = String(route.path || 'unknown');
  throw new Error(
    `Custom endpoint workflow cannot modify canonical table route "${path}". Use canonical CRUD hooks/permissions for shared table behavior or choose a separate custom path.`,
  );
}

export function assertCreateHandlerRouteBoundary(
  route: { path?: unknown; mainTable?: unknown } | null | undefined,
  sourceCode: string,
  allowCanonicalRoute = false,
) {
  if (!route?.mainTable) return;
  const path = String(route.path || 'unknown');
  if (!allowCanonicalRoute) {
    throw new Error(
      `create_handler cannot add a handler to canonical table route "${path}" without allowCanonicalRoute=true. Third-party or endpoint-specific behavior belongs on a separate custom route. Use canonical hooks only when behavior is intentionally shared with eApp/admin CRUD.`,
    );
  }
  if (!/(?:@REPOS\.main|\$ctx\.\$repos\.main)\s*\./u.test(String(sourceCode || ''))) {
    throw new Error(
      `A new handler on canonical table route "${path}" must use @REPOS.main or $ctx.$repos.main. Explicit-table third-party handlers belong on a separate custom route.`,
    );
  }
}
