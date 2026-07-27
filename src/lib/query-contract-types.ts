import type { UnknownRecord } from './types.js';

export interface QueryContractRelationReceipt {
  path: string;
  sourceTable: string;
  targetTable: string;
  type: string | null;
}

export interface QueryContractPathReceipt {
  path: string;
  tableName: string;
  fieldName: string;
  kind: 'column' | 'relation' | 'wildcard';
  isPublished: boolean | null;
  isEncrypted: boolean | null;
}

export interface QueryContractReceipt {
  tableName: string | null;
  primaryKey: string | null;
  metadataChecked: true;
  requestedFieldsValidated: true;
  deepValidated: true;
  requestedTopLevelFields: string[];
  validatedPaths: string[];
  pathMetadata: QueryContractPathReceipt[];
  resolvedRelations: QueryContractRelationReceipt[];
  metadataTablesChecked: string[];
}

export interface ValidateQueryContractOptions {
  rootTable: UnknownRecord;
  fields: string[];
  deep?: unknown;
  loadTable: (tableName: string) => Promise<UnknownRecord>;
}
