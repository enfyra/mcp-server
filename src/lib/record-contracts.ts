function normalizeRequestedField(field: string) {
  return String(field).trim().replace(/^-/, '').split('.')[0];
}

const WRITE_ONLY_RECORD_FIELDS: Record<string, Set<string>> = {
  enfyra_oauth_config: new Set(['clientId', 'clientSecret']),
};

export function assertRecordFieldsReadable(tableName: string, fields?: string[]) {
  const writeOnlyFields = WRITE_ONLY_RECORD_FIELDS[tableName];
  if (!writeOnlyFields || !fields?.length) return;
  const requestedFields = fields
    .flatMap((field) => String(field).split(','))
    .map(normalizeRequestedField)
    .filter(Boolean);
  if (requestedFields.includes('*')) {
    throw new Error(`Wildcard reads are blocked for "${tableName}" because it contains credential fields. Request only explicit non-secret fields.`);
  }
  const blocked = [...new Set(requestedFields.filter((field) => writeOnlyFields.has(field)))];
  if (!blocked.length) return;
  throw new Error([
    `Credential field(s) ${blocked.join(', ')} on "${tableName}" are write-only through setup_oauth_provider and cannot be read by MCP.`,
    'Connect the third app first, then ask the user to supply clientId and clientSecret for the setup operation.',
    'Never inspect or reuse stored OAuth credential values.',
  ].join(' '));
}

export function buildQuerySchemaReceipt(table: any, requestedFields: string[]) {
  const validFields = new Set([
    ...(table?.columns ?? []).map((column: any) => String(column.name)),
    ...(table?.relations ?? []).map((relation: any) => String(relation.propertyName)),
  ].filter(Boolean));
  const requestedTopLevelFields = [...new Set(
    requestedFields
      .flatMap((field) => String(field).split(','))
      .map(normalizeRequestedField)
      .filter((field) => field && field !== '*'),
  )];
  const unknownFields = requestedTopLevelFields.filter((field) => !validFields.has(field));
  if (unknownFields.length) {
    throw new Error(`Unknown query_table field(s) for "${table?.name}": ${unknownFields.join(', ')}. Valid top-level fields: ${[...validFields].sort().join(', ')}.`);
  }
  return {
    tableName: table?.name ?? null,
    primaryKey: table?.primaryKey ?? null,
    metadataChecked: true,
    requestedFieldsValidated: true,
    requestedTopLevelFields,
  };
}

export function buildDeletePostcondition(requestedIds: unknown[], remainingRecords: any[], primaryKey = 'id') {
  return {
    verificationMethod: 'route_read_by_primary_keys',
    requestedIds,
    remainingIds: remainingRecords.map((record) => record?.[primaryKey] ?? record?.id ?? record?._id).filter((id) => id != null),
    confirmedAbsent: remainingRecords.length === 0,
  };
}
