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
