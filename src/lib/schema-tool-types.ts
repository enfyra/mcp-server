export type AnyRecord = Record<string, any>;

export type ConstraintGroup = string[];

export type ColumnPatch = AnyRecord & {
  id?: unknown;
  _id?: unknown;
  name?: string;
  type?: string;
  isNullable?: boolean;
  isPrimary?: boolean;
  isGenerated?: boolean;
  isSystem?: boolean;
  isPublished?: boolean;
  isUpdatable?: boolean;
  isEncrypted?: boolean;
  isUnique?: boolean;
  defaultValue?: unknown;
  description?: string;
  options?: unknown;
};

export type RelationPatch = AnyRecord & {
  id?: unknown;
  _id?: unknown;
  targetTable?: unknown;
  type?: string;
  propertyName?: string;
  inversePropertyName?: string | null;
  mappedBy?: unknown;
  isNullable?: boolean;
  onDelete?: string;
  description?: string;
};

export type CascadeVerifyOptions = {
  action: 'create' | 'update' | 'delete';
  columnId?: unknown;
  columnName?: string;
  relationId?: unknown;
  propertyName?: string;
};
