export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: TextContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export type UnknownRecord = Record<string, unknown>;

export interface MetadataContext {
  dbType: "postgres" | "mysql" | "mongodb" | "mariadb" | "sqlite" | null;
  enfyraVersion: string | null;
}

export interface MetadataTableCatalogEntry {
  id?: unknown;
  _id?: unknown;
  name: string;
  alias?: string | null;
  description?: string | null;
  isSingleRecord?: boolean | null;
}

export type DynamicEndpointReviewStatus = "ready" | "review_required" | "blocked";

export interface DynamicEndpointReviewFinding {
  code: string;
  message: string;
}

export interface DynamicEndpointMetadataSummary {
  primaryFields: string[];
  publishedUpdatableFields: string[];
  unpublishedFields: string[];
  nonUpdatableFields: string[];
  encryptedFields: string[];
  publishedRelations: string[];
  unpublishedRelations: string[];
}

export interface DynamicEndpointContractReview {
  status: DynamicEndpointReviewStatus;
  errors: DynamicEndpointReviewFinding[];
  warnings: DynamicEndpointReviewFinding[];
  info: DynamicEndpointReviewFinding[];
  errorCodes: string[];
  warningCodes: string[];
  infoCodes: string[];
  signals: {
    usesMainRepository: boolean;
    usesSecureExplicitRepository: boolean;
    usesTrustedExplicitRepository: boolean;
    usesRawBody: boolean;
    usesMutation: boolean;
    returnsRepositoryDataDirectly: boolean;
  };
  repositoryTables: string[];
  metadata: Record<string, DynamicEndpointMetadataSummary>;
  verification: string[];
}

export interface DynamicEndpointReviewInput {
  routeKind: "custom" | "canonical";
  method?: string;
  sourceCode: string;
  tableMetadata?: Record<string, UnknownRecord>;
  metadataUnavailable?: string[];
  metadataTruncated?: boolean;
}
