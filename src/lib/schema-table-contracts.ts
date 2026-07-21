/**
 * Table & Column tools for Enfyra MCP Server
 */
import { z } from 'zod';
import { fetchAPI } from './fetch.js';
import {
  fetchMetadataContext,
  fetchTableCatalog,
  fetchTableMetadata,
  resolveTableCatalogEntry,
} from './metadata-client.js';
import { jsonContent } from './response-format.js';
import { assertGlobalRulesAck, globalRulesAckParam } from './required-knowledge.js';
import { normalizeTableName } from './tool-input-normalization.js';
import {
  AUTO_MANAGED_COLUMN_NAMES,
  AnyRecord,
  ConstraintGroup,
} from './schema-mutation-coordinator.js';

export function parseJsonArrayParam(name, value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array.`);
  }
  return parsed;
}

export function parseBulkItemsParam(name, value) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${name} must be a native JSON array. Pass one object in the array for a single mutation.`);
  }
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array. Pass one object in the array for a single mutation.`);
  }
  if (parsed.length === 0) {
    throw new Error(`${name} must include at least one item.`);
  }
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${name}[${index}] must be an object.`);
    }
  });
  return parsed;
}

export function assertBulkLimit(name, items, maxItems) {
  if (items.length > maxItems) {
    throw new Error(`${name} received ${items.length} items, above maxItems=${maxItems}. Split the batch deliberately.`);
  }
}

function normalizeConstraintGroups(name, groups) {
  return groups.map((group, index) => {
    const value = Array.isArray(group) ? group : group?.value;
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error(`${name}[${index}] must be a non-empty string array or { "value": [...] }.`);
    }
    return value;
  });
}

function parseConstraintGroupsParam(name, value) {
  return normalizeConstraintGroups(name, parseJsonArrayParam(name, value));
}

export function normalizeConstraintGroupsValue(name, value): ConstraintGroup[] {
  if (value == null) return [];
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array.`);
  }
  return normalizeConstraintGroups(name, parsed);
}

export function stripAutoManagedColumns(columns: AnyRecord[]) {
  const skippedAutoColumns: Array<{ name: string; reason: string }> = [];
  const filtered = columns.filter((column) => {
    const name = String(column?.name ?? '');
    if (!AUTO_MANAGED_COLUMN_NAMES.has(name)) return true;
    skippedAutoColumns.push({
      name,
      reason: 'Enfyra manages id/createdAt/updatedAt automatically during table creation.',
    });
    return false;
  });
  return { columns: filtered, skippedAutoColumns };
}

export function assertColumnNameCanBeCreated(name: unknown, context: string) {
  const columnName = String(name ?? '');
  if (AUTO_MANAGED_COLUMN_NAMES.has(columnName)) {
    throw new Error(`${context} "${columnName}" is auto-managed by Enfyra. Do not create id, _id, createdAt, or updatedAt columns manually.`);
  }
}

function assertNoDuplicateFieldNames(fieldNames: string[], context: string) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of fieldNames.filter(Boolean)) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  if (duplicates.size > 0) {
    throw new Error(`${context} has duplicate field name(s): ${[...duplicates].join(', ')}. Column names and relation propertyName values share one namespace.`);
  }
}

export function assertNoColumnRelationNameCollision(columnNames: string[], relationNames: string[], context: string) {
  const relationNameSet = new Set(relationNames.filter(Boolean));
  const collisions = columnNames.filter((name) => relationNameSet.has(name));
  if (collisions.length > 0) {
    throw new Error(
      `${context} has column/relation namespace collision(s): ${[...new Set(collisions)].join(', ')}. ` +
      `Column names and relation propertyName values share one namespace; remove the scalar column(s) and keep the relation propertyName(s) ${[...new Set(collisions)].join(', ')}. Do not create physical FK columns.`,
    );
  }
  assertNoDuplicateFieldNames([...columnNames, ...relationNames], context);
}

function formatConstraintFieldHints(fields: string[], relationNames: string[], logicalFieldNames: string[]) {
  const relationNameSet = new Set(relationNames);
  const logicalNameSet = new Set(logicalFieldNames);
  const normalizeName = (value: string) => value.replace(/[_\-\s]/gu, '').toLowerCase();
  return fields
    .map((field) => {
      const normalized = String(field)
        .replace(/_?ids?$/iu, '')
        .replace(/_id$/iu, '')
        .replace(/Id$/u, '')
        .replace(/Ids$/u, '');
      const match = [...relationNameSet].find((name) => name.toLowerCase() === normalized.toLowerCase());
      if (match) return `${field} -> use relation propertyName "${match}" in indexes/uniques, not physical FK "${field}"`;
      const logicalMatch = [...logicalNameSet].find((name) => normalizeName(name) === normalizeName(String(field)));
      return logicalMatch ? `${field} -> did you mean "${logicalMatch}"? Constraint fields must match column/relation names exactly.` : null;
    })
    .filter(Boolean);
}

export function preflightCreateTableDefinitions(items: AnyRecord[]) {
  items.forEach((item, index) => {
    const columns = Array.isArray(item.columns) ? item.columns : parseJsonArrayParam(`items[${index}].columns`, item.columns || '[]');
    const relations = Array.isArray(item.relations) ? item.relations : parseJsonArrayParam(`items[${index}].relations`, item.relations || '[]');
    const { columns: userColumns } = stripAutoManagedColumns(columns);
    const columnNames = userColumns.map((column) => String(column?.name ?? '')).filter(Boolean);
    const relationNames = relations.map((relation) => String(relation?.propertyName ?? '')).filter(Boolean);
    assertNoColumnRelationNameCollision(columnNames, relationNames, `create_tables items[${index}] (${item.name || '<unnamed>'})`);

    const logicalFields = new Set([...AUTO_MANAGED_COLUMN_NAMES, ...columnNames, ...relationNames]);
    const indexes = normalizeConstraintGroupsValue(`items[${index}].indexes`, item.indexes ?? []);
    const uniques = normalizeConstraintGroupsValue(`items[${index}].uniques`, item.uniques ?? []);
    assertIndexesDoNotReferenceUniqueFields(indexes, uniques);
    const unknownConstraintFields = [...indexes, ...uniques]
      .flat()
      .filter((field) => !logicalFields.has(field));
    if (unknownConstraintFields.length > 0) {
      const uniqueUnknownFields = [...new Set(unknownConstraintFields)];
      const hints = formatConstraintFieldHints(uniqueUnknownFields, relationNames, [...logicalFields]);
      throw new Error(
        `create_tables items[${index}] (${item.name || '<unnamed>'}) has indexes/uniques referencing undeclared field(s): ${uniqueUnknownFields.join(', ')}. ` +
        'Declare each field as a column or relation propertyName in the same table item. ' +
        (hints.length ? `Hint(s): ${hints.join('; ')}. ` : '') +
        'For relation-based unique pairs added after create, first create the relations, then call update_tables with the unique group.',
      );
    }
  });
}

export function normalizeCreateTableDefinitions(items: AnyRecord[]) {
  const batchNameMap = new Map(
    items
      .map((item) => String(item?.name ?? ''))
      .filter(Boolean)
      .map((name) => [name.toLowerCase(), normalizeTableName(name)]),
  );
  return items.map((item) => {
    const originalName = String(item?.name ?? '');
    const name = normalizeTableName(originalName);
    const relations = Array.isArray(item?.relations)
      ? item.relations.map((relation) => {
        const target = relation?.targetTable ?? relation?.targetTableId;
        if (typeof target !== 'string') return relation;
        const normalizedTarget = batchNameMap.get(target.toLowerCase());
        if (!normalizedTarget || normalizedTarget === target) return relation;
        return relation?.targetTable !== undefined
          ? { ...relation, targetTable: normalizedTarget }
          : { ...relation, targetTableId: normalizedTarget };
      })
      : item?.relations;
    return {
      ...item,
      name,
      ...(relations !== undefined ? { relations } : {}),
      ...(name !== originalName ? { _requestedTableName: originalName } : {}),
    };
  });
}

function relationTargetName(relation: AnyRecord) {
  const target = relation?.targetTable ?? relation?.targetTableId;
  if (target && typeof target === 'object') return target.name ?? target.alias ?? target.id ?? target._id;
  return target;
}

export function computeBatchCleanupOrder(items: AnyRecord[]) {
  const tableNames = items.map((item) => String(item?.name || '')).filter(Boolean);
  const tableSet = new Set(tableNames);
  const edges: Array<[string, string]> = [];
  for (const item of items) {
    const source = String(item?.name || '');
    if (!source) continue;
    const relations = Array.isArray(item.relations) ? item.relations : parseJsonArrayParam(`${source}.relations`, item.relations || '[]');
    for (const relation of relations) {
      const target = String(relationTargetName(relation) || '');
      if (target && tableSet.has(target) && target !== source) edges.push([source, target]);
    }
  }
  const remaining = new Set(tableNames);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const leaves = [...remaining]
      .filter((name) => !edges.some(([source, target]) => target === name && remaining.has(source) && remaining.has(target)))
      .sort();
    const batch = leaves.length ? leaves : [[...remaining].sort()[0]];
    for (const name of batch) {
      remaining.delete(name);
      ordered.push(name);
    }
  }
  return ordered;
}

export function splitRelationConstraintGroups(groups: ConstraintGroup[], relationNames: Set<string>) {
  const immediate: ConstraintGroup[] = [];
  const deferred: ConstraintGroup[] = [];
  for (const group of groups) {
    if (group.some((field) => relationNames.has(field))) deferred.push(group);
    else immediate.push(group);
  }
  return { immediate, deferred };
}

export function mergeConstraintGroups(existing: ConstraintGroup[], additions: ConstraintGroup[]) {
  const seen = new Set(existing.map((group) => JSON.stringify(group)));
  const merged = [...existing];
  for (const group of additions) {
    const key = JSON.stringify(group);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(group);
    }
  }
  return merged;
}

export function resolveRelationConstraintGroups(table: AnyRecord, groups: ConstraintGroup[], groupName: string) {
  const relationByProperty = new Map<string, AnyRecord>((table.relations || [])
    .filter((relation) => relation?.propertyName)
    .map((relation) => [relation.propertyName, relation]));
  return groups.map((group) => group.map((field) => {
    const relation = relationByProperty.get(field);
    if (!relation) return field;
    const physicalColumn = relation.foreignKeyColumn || relation.fkColumn || relation.fkCol;
    if (!physicalColumn) {
      throw new Error(
        `${groupName} uses relation propertyName "${field}", but the created relation did not expose a physical FK column for indexing. ` +
        'This usually means the relation is not a direct many-to-one/one-to-one relation. Keep relation indexes/uniques only on direct owning relations.',
      );
    }
    return physicalColumn;
  }));
}

export function assertIndexesDoNotReferenceUniqueFields(indexes: ConstraintGroup[], uniques: ConstraintGroup[]) {
  const conflicts = indexes
    .map((indexGroup) => ({
      indexGroup,
      uniqueGroups: uniques
        .map((uniqueGroup) => ({
          uniqueGroup,
          overlappingFields: indexGroup.filter((field) => uniqueGroup.includes(field)),
        }))
        .filter((conflict) => conflict.overlappingFields.length > 0),
    }))
    .filter((conflict) => conflict.uniqueGroups.length > 0);
  if (conflicts.length > 0) {
    const groups = conflicts
      .map((conflict) => `${JSON.stringify(conflict.indexGroup)} overlaps unique group(s) ${conflict.uniqueGroups.map((item) => `${JSON.stringify(item.uniqueGroup)} via ${JSON.stringify(item.overlappingFields)}`).join(', ')}`)
      .join('; ');
    throw new Error(
      `Invalid schema constraints: indexes must not include fields that appear in uniques, including composite unique groups. Conflict(s): ${groups}. Unique constraints already create indexed lookups for their fields; remove those fields from indexes and keep them only in uniques.`,
    );
  }
}
