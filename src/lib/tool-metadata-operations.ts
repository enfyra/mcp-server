/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

// Import modules

export function getPrimaryColumn(table) {
  return (table?.columns || []).find((column) => column.isPrimary) || null;
}

export function getMetadataDatabaseContext(metadata) {
  const dbType = metadata?.dbType || metadata?.data?.dbType || null;
  return {
    dbType,
    backendFamily: dbType === 'mongodb' ? 'mongodb' : dbType ? 'sql' : 'unknown',
    primaryKeyConvention: dbType === 'mongodb' ? '_id' : dbType ? 'id' : null,
    source: dbType ? 'GET /metadata' : 'unavailable',
  };
}

export function summarizeTable(table) {
  if (!table) return null;
  const relationFkColumnNames = new Set((table.relations || []).flatMap((relation) => {
    const propertyName = relation.propertyName;
    return propertyName
      ? [
          `${propertyName}Id`,
          `${propertyName}_id`,
          relation.fkCol,
          relation.fkColumn,
          relation.foreignKeyColumn,
        ].filter(Boolean).map((name) => String(name).toLowerCase())
      : [];
  }));
  const modelFacingColumns = (table.columns || []).filter((column) => (
    column.isPrimary || !relationFkColumnNames.has(String(column.name || '').toLowerCase())
  ));
  return {
    id: table.id ?? table._id,
    name: table.name,
    alias: table.alias,
    primaryKey: getPrimaryColumn(table)?.name || null,
    validateBody: table.validateBody,
    graphqlEnabled: table.graphqlEnabled,
    columns: modelFacingColumns.map((column) => ({
      id: column.id ?? column._id,
      name: column.name,
      type: column.type,
      isPrimary: !!column.isPrimary,
      isNullable: column.isNullable,
      isPublished: column.isPublished,
      isUpdatable: column.isUpdatable !== false,
      isEncrypted: column.isEncrypted === true,
    })),
    hiddenRelationColumnCount: (table.columns || []).length - modelFacingColumns.length,
    relations: (table.relations || []).map((relation) => ({
      id: relation.id ?? relation._id,
      propertyName: relation.propertyName,
      type: relation.type,
      targetTable: relation.targetTable?.name || relation.targetTableName || relation.targetTable,
      inversePropertyName: relation.inversePropertyName,
      mappedBy: relation.mappedBy?.propertyName || relation.mappedBy,
      isNullable: relation.isNullable,
      onDelete: relation.onDelete,
      isPublished: relation.isPublished,
    })),
  };
}

export function summarizeRoutes(routesResult) {
  return (routesResult?.data || []).map((route) => ({
    id: route.id ?? route._id,
    path: route.path,
    mainTable: route.mainTable?.name || route.mainTableName || null,
    availableMethods: (route.availableMethods || []).map((method) => method.name).filter(Boolean),
    publicMethods: (route.publicMethods || []).map((method) => method.name).filter(Boolean),
    isEnabled: route.isEnabled,
  }));
}

export function unwrapData(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

export function getId(record) {
  return record?.id ?? record?._id ?? null;
}

export function sameId(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

export function refId(value) {
  return typeof value === 'object' && value !== null ? getId(value) : value;
}

export function firstDataRecord(result) {
  return Array.isArray(result?.data) ? result.data[0] : result;
}
