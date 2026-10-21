export interface CodeHistoryEntry {
  tableName: string;
  recordId: string;
  action: 'create' | 'update' | 'delete' | 'revert';
  fromVersion?: string | null;
  toVersion?: string | null;
  restoredFrom?: string | null;
  previous?: Record<string, unknown> | null;
}
