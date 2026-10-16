import { fetchTableWithDetails } from './schema-mutation-coordinator.js';
import { normalizeConstraintGroupsValue, normalizeLogicalConstraintGroups } from './schema-table-contracts.js';
import type { AnyRecord, ConstraintGroup } from './schema-tool-types.js';

function isAutomaticIndex(table: AnyRecord, group: ConstraintGroup): boolean {
  if (group.length !== 1) return false;
  const field = group[0];
  return field === 'createdAt' || field === 'updatedAt'
    || (table.columns || []).some((column: AnyRecord) => column.name === field && ['date', 'datetime', 'timestamp'].includes(column.type))
    || (table.relations || []).some((relation: AnyRecord) => relation.propertyName === field && !relation.mappedBy && !relation.mappedById && ['many-to-one', 'one-to-one'].includes(relation.type));
}

export async function verifyTableConstraints(apiUrl: string, tableId: string | number, requested: AnyRecord): Promise<void> {
  const saved = await fetchTableWithDetails(apiUrl, tableId);
  const uniques = normalizeLogicalConstraintGroups(saved, normalizeConstraintGroupsValue('uniques', saved.uniques));
  for (const field of ['indexes', 'uniques']) {
    if (requested[field] === undefined) continue;
    const expected = normalizeLogicalConstraintGroups(saved, requested[field]).map(group => JSON.stringify(group));
    const actualGroups = normalizeLogicalConstraintGroups(saved, normalizeConstraintGroupsValue(field, saved[field]));
    const actual = actualGroups.map(group => JSON.stringify(group));
    const missing = expected.some(group => !actual.includes(group));
    const unexpected = actualGroups.some(group => !expected.includes(JSON.stringify(group)) && !(field === 'indexes'
      && isAutomaticIndex(saved, group)
      && !uniques.some(unique => unique.length >= group.length && group.every((name, position) => unique[position] === name))));
    if (missing || unexpected) {
      throw new Error(`Table ${tableId} ${field} read-back verification failed: requested constraints were not persisted.`);
    }
  }
}
