import { buildQuerySchemaReceipt } from './record-contracts.js';
import type {
  QueryContractPathReceipt,
  QueryContractReceipt,
  QueryContractRelationReceipt,
  ValidateQueryContractOptions,
} from './query-contract-types.js';
import type { UnknownRecord } from './types.js';

const ALLOWED_DEEP_ENTRY_KEYS = new Set(['fields', 'filter', 'sort', 'limit', 'page', 'deep']);

function asRecords(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is UnknownRecord => Boolean(item && typeof item === 'object'))
    : [];
}

function tableName(table: UnknownRecord) {
  return String(table.name ?? 'unknown');
}

function tableFields(table: UnknownRecord) {
  return [
    ...asRecords(table.columns).map((column) => String(column.name ?? '')).filter(Boolean),
    ...asRecords(table.relations).map((relation) => String(relation.propertyName ?? '')).filter(Boolean),
  ];
}

function relationByName(table: UnknownRecord, propertyName: string) {
  return asRecords(table.relations).find((relation) => relation.propertyName === propertyName) ?? null;
}

function relationTargetTableName(relation: UnknownRecord) {
  const targetTable = relation.targetTable;
  if (targetTable && typeof targetTable === 'object' && !Array.isArray(targetTable)) {
    const name = (targetTable as UnknownRecord).name;
    if (name) return String(name);
  }
  if (typeof targetTable === 'string' && targetTable) return targetTable;
  if (relation.targetTableName) return String(relation.targetTableName);
  const relatedTable = relation.relatedTable;
  if (relatedTable && typeof relatedTable === 'object' && !Array.isArray(relatedTable)) {
    const name = (relatedTable as UnknownRecord).name;
    if (name) return String(name);
  }
  return typeof relatedTable === 'string' && relatedTable ? relatedTable : null;
}

function normalizeFieldSelections(fields: unknown): string[] {
  const values = Array.isArray(fields) ? fields : fields == null ? [] : [fields];
  return values
    .flatMap((field) => String(field).split(','))
    .map((field) => field.trim())
    .filter(Boolean);
}

function normalizedFieldPath(field: string) {
  return field.replace(/^-/, '').trim();
}

function unknownFieldError(path: string, table: UnknownRecord) {
  const validFields = tableFields(table).sort();
  return new Error(`Unknown query_table field "${path}" on "${tableName(table)}". Valid fields: ${validFields.join(', ')}.`);
}

export async function validateQueryContract(options: ValidateQueryContractOptions): Promise<QueryContractReceipt> {
  const { rootTable, fields, deep, loadTable } = options;
  const rootReceipt = buildQuerySchemaReceipt(rootTable, fields);
  const tableCache = new Map<string, UnknownRecord>();
  const metadataTablesChecked: string[] = [];
  const validatedPaths = new Set<string>();
  const pathMetadata = new Map<string, QueryContractPathReceipt>();
  const resolvedRelations = new Map<string, QueryContractRelationReceipt>();

  function rememberTable(table: UnknownRecord) {
    const name = tableName(table);
    if (!tableCache.has(name)) {
      tableCache.set(name, table);
      metadataTablesChecked.push(name);
    }
    return table;
  }

  async function resolveTarget(relation: UnknownRecord, relationPath: string, sourceTable: UnknownRecord) {
    const targetName = relationTargetTableName(relation);
    if (!targetName) {
      throw new Error(`Relation "${relationPath}" on "${tableName(sourceTable)}" does not expose a target table in metadata.`);
    }
    const receipt = {
      path: relationPath,
      sourceTable: tableName(sourceTable),
      targetTable: targetName,
      type: relation.type ? String(relation.type) : null,
    };
    if (!resolvedRelations.has(relationPath)) resolvedRelations.set(relationPath, receipt);
    const cached = tableCache.get(targetName);
    if (cached) return cached;
    return rememberTable(await loadTable(targetName));
  }

  async function validateFieldPath(table: UnknownRecord, rawPath: string, prefix = '') {
    const path = normalizedFieldPath(rawPath);
    if (!path) return;
    const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
    if (!segments.length) return;
    const fullPath = [prefix, ...segments].filter(Boolean).join('.');
    if (segments[0] === '*') {
      if (segments.length > 1) throw unknownFieldError(fullPath, table);
      validatedPaths.add(fullPath);
      pathMetadata.set(fullPath, {
        path: fullPath,
        tableName: tableName(table),
        fieldName: '*',
        kind: 'wildcard',
        isPublished: null,
        isEncrypted: null,
      });
      return;
    }

    const [head, ...rest] = segments;
    const column = asRecords(table.columns).find((item) => item.name === head);
    const relation = relationByName(table, head);
    if (!column && !relation) throw unknownFieldError(fullPath, table);
    if (!rest.length) {
      validatedPaths.add(fullPath);
      const field = column ?? relation!;
      pathMetadata.set(fullPath, {
        path: fullPath,
        tableName: tableName(table),
        fieldName: head,
        kind: column ? 'column' : 'relation',
        isPublished: typeof field.isPublished === 'boolean' ? field.isPublished : null,
        isEncrypted: typeof field.isEncrypted === 'boolean' ? field.isEncrypted : null,
      });
      return;
    }
    if (!relation) throw unknownFieldError(fullPath, table);
    const relationPath = [prefix, head].filter(Boolean).join('.');
    const target = await resolveTarget(relation, relationPath, table);
    await validateFieldPath(target, rest.join('.'), relationPath);
  }

  async function validateDeep(table: UnknownRecord, value: unknown, prefix = ''): Promise<void> {
    if (value == null) return;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`deep for "${prefix || tableName(table)}" must be an object keyed by relation propertyName.`);
    }

    for (const [relationName, rawEntry] of Object.entries(value as UnknownRecord)) {
      const relationPath = [prefix, relationName].filter(Boolean).join('.');
      const relation = relationByName(table, relationName);
      if (!relation) {
        throw new Error(`Unknown deep relation "${relationPath}" on "${tableName(table)}". Valid relations: ${asRecords(table.relations).map((item) => item.propertyName).filter(Boolean).sort().join(', ')}.`);
      }
      const target = await resolveTarget(relation, relationPath, table);
      if (rawEntry == null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as UnknownRecord;
      for (const key of Object.keys(entry)) {
        if (!ALLOWED_DEEP_ENTRY_KEYS.has(key)) {
          throw new Error(`Unknown deep option key '${key}' for relation '${relationPath}'. Allowed: ${[...ALLOWED_DEEP_ENTRY_KEYS].join(', ')}.`);
        }
      }
      const relationType = relation.type ? String(relation.type) : '';
      if (entry.limit !== undefined && (relationType === 'many-to-one' || relationType === 'one-to-one')) {
        throw new Error(`'limit' not supported for relation '${relationPath}' with type '${relationType}'.`);
      }
      if (entry.page !== undefined && entry.limit === undefined) {
        throw new Error(`'page' requires 'limit' for relation '${relationPath}'.`);
      }
      for (const field of normalizeFieldSelections(entry.fields)) {
        await validateFieldPath(target, field, relationPath);
      }
      if (entry.deep !== undefined) await validateDeep(target, entry.deep, relationPath);
    }
  }

  rememberTable(rootTable);
  for (const field of normalizeFieldSelections(fields)) await validateFieldPath(rootTable, field);
  await validateDeep(rootTable, deep);

  return {
    ...rootReceipt,
    metadataChecked: true,
    requestedFieldsValidated: true,
    deepValidated: true,
    validatedPaths: [...validatedPaths],
    pathMetadata: [...pathMetadata.values()],
    resolvedRelations: [...resolvedRelations.values()],
    metadataTablesChecked,
  };
}
