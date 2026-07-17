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

export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpToolContract {
  name: string;
  annotations: McpToolAnnotations;
  catalogExecutable: boolean;
}

export interface RegisteredToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  handler: (...args: any[]) => any;
  visible: boolean;
  registration?: {
    enabled: boolean;
  };
}

export interface ToolsetRegistrationState {
  toolset: string;
  profile: string;
  dynamic: boolean;
  hiddenTools: string[];
  getTool(name: string): RegisteredToolDefinition | undefined;
  listTools(): RegisteredToolDefinition[];
  listVisibleToolNames(): string[];
  setActiveTools(toolNames: Iterable<string>): {
    changed: boolean;
    visibleToolNames: string[];
    hiddenToolCount: number;
  };
}

export type ToolAvailabilityStatus = 'allowed' | 'denied' | 'unknown';

export interface ToolAvailability {
  status: ToolAvailabilityStatus;
  reason: string;
}

export interface ModelEvalTraceEvent {
  tool: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

export interface ModelEvalRun {
  scenarioId: string;
  model: string;
  events: ModelEvalTraceEvent[];
}

export interface ModelEvalScenario {
  id: string;
  prompt: string;
  surface: string;
  requiredToolGroups: string[][];
  verificationTools: string[];
  maxToolCalls: number;
  mutationExpected: boolean;
  destructiveExpected?: boolean;
}

export interface ModelEvalCheck {
  key: string;
  passed: boolean;
  detail: string;
  blocking?: boolean;
}

export interface ModelEvalScore {
  scenarioId: string;
  model: string;
  score: number;
  optimizationScore: number;
  recommended: boolean;
  checks: ModelEvalCheck[];
}

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

export interface ExtensionSfcAttributeAnalysis {
  name: string;
  directive: string | null;
  value: string | null;
  dynamicArgument: boolean;
  modifiers: string[];
}

export interface ExtensionSfcElementAnalysis {
  tag: string;
  attributes: ExtensionSfcAttributeAnalysis[];
  classes: string[];
  source: string;
  text: string;
}

export interface ExtensionSfcAnalysis {
  valid: boolean;
  hasTemplate: boolean;
  errors: string[];
  elements: ExtensionSfcElementAnalysis[];
}

export type OAuthProvider = 'google' | 'facebook' | 'github';

export interface OAuthProviderSetupInput {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  appConnectionVerified: true;
  globalRulesAckKey?: string;
}

export type OAuthToolFetch = (
  apiUrl: string,
  path: string,
  options?: RequestInit,
) => Promise<any>;

export interface OAuthProviderToolDependencies {
  fetchApi?: OAuthToolFetch;
  assertGlobalRulesAck?: (key: unknown) => void;
}
