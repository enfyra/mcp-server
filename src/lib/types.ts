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
