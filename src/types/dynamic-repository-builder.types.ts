export interface DynamicRepositoryUsageInput {
  access: 'secure_main' | 'secure_explicit' | 'trusted_explicit';
  operation: 'list' | 'find_one' | 'find_locked' | 'create' | 'create_many' | 'update' | 'update_locked' | 'update_many' | 'delete' | 'delete_many';
  tableName?: string;
  fields?: string[];
  idField?: string;
  idSource?: 'params' | 'body';
  counterField?: string;
}

export interface DynamicRepositoryRuntimeRequirements {
  databases: Array<'postgres' | 'mysql'>;
  requiresOuterTransaction: true;
  verification: string;
}
