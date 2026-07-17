function normalizeRequestedField(field: string) {
  return String(field).trim().replace(/^-/, '').split('.')[0];
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
