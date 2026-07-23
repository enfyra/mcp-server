import { z, type ZodRawShape } from 'zod';

const dataBoundarySchema = z.object({
  trust: z.literal('untrusted'),
  instruction: z.string(),
}).passthrough();

const baseOutputSchema = {
  responseFormat: z.string(),
  dataBoundary: dataBoundarySchema.optional(),
} satisfies ZodRawShape;

const actionOutputSchema = {
  ...baseOutputSchema,
  action: z.string(),
} satisfies ZodRawShape;

const recordArrayOutputSchema = z.union([
  z.array(z.record(z.unknown())),
  z.object({
    format: z.literal('columnar-v1'),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
    rowCount: z.number().int().nonnegative(),
  }).passthrough(),
]);

const workflowDiscoveryOutputSchema = {
  ...baseOutputSchema,
  action: z.literal('enfyra_workflows_discovered'),
  profile: z.string(),
  workflows: recordArrayOutputSchema,
  guidance: z.array(z.string()),
} satisfies ZodRawShape;

const workflowSelectionOutputSchema = {
  ...baseOutputSchema,
  action: z.literal('enfyra_workflow_selected'),
  mode: z.enum(['replace', 'add', 'reset']),
  activeSurfaces: z.array(z.string()),
  visibleToolCount: z.number().int().nonnegative(),
  visibleTools: z.array(z.string()),
  hiddenToolCount: z.number().int().nonnegative(),
  changed: z.boolean(),
} satisfies ZodRawShape;

const catalogSearchOutputSchema = {
  ...baseOutputSchema,
  action: z.literal('enfyra_tools_searched'),
  resultCount: z.number().int().nonnegative(),
  page: z.record(z.unknown()),
  tools: recordArrayOutputSchema,
  guidance: z.array(z.string()),
} satisfies ZodRawShape;

const catalogExecuteOutputSchema = {
  ...baseOutputSchema,
  action: z.literal('enfyra_catalog_tool_executed'),
  tool: z.string(),
  result: z.unknown(),
} satisfies ZodRawShape;

const apiContextOutputSchema = {
  ...baseOutputSchema,
  targetInstance: z.object({
    apiBase: z.string(),
    source: z.string(),
  }).passthrough(),
  enfyraApiUrl: z.string(),
  graphqlHttpUrl: z.string(),
  graphqlSchemaUrl: z.string(),
  auth: z.record(z.unknown()),
} satisfies ZodRawShape;

const queryTableOutputSchema = {
  ...baseOutputSchema,
  schemaReceipt: z.object({
    tableName: z.string(),
    primaryKey: z.string().nullable(),
    metadataChecked: z.literal(true),
    requestedFieldsValidated: z.literal(true),
    requestedTopLevelFields: z.array(z.string()),
  }).passthrough(),
} satisfies ZodRawShape;

const deleteRecordsOutputSchema = {
  ...actionOutputSchema,
  postcondition: z.object({
    verificationMethod: z.string(),
    requestedIds: z.array(z.unknown()),
    remainingIds: z.array(z.unknown()),
    confirmedAbsent: z.boolean(),
  }).passthrough(),
} satisfies ZodRawShape;

const destructiveOutputSchema = {
  ...actionOutputSchema,
  previewReceipt: z.object({
    version: z.literal(1),
    valid: z.literal(true),
    toolName: z.string(),
    action: z.string(),
    targetCount: z.number().int().positive(),
  }).passthrough().optional(),
  postcondition: z.object({
    verificationMethod: z.string(),
    confirmedAbsent: z.boolean(),
  }).passthrough(),
} satisfies ZodRawShape;

const oauthProviderOutputSchema = {
  ...actionOutputSchema,
  action: z.literal('oauth_provider_enfyra_config_saved'),
  status: z.enum([
    'provider_console_action_required',
    'runtime_verification_required',
    'configuration_verification_failed',
  ]),
  setupComplete: z.literal(false),
  provider: z.enum(['google', 'facebook', 'github']),
  operation: z.enum(['created', 'updated']),
  callbackUri: z.string().url(),
  providerConsole: z.object({
    field: z.string(),
    value: z.string().url(),
    instruction: z.string(),
    confirmationRequired: z.literal(true),
  }).passthrough(),
  verification: z.object({
    configPersisted: z.boolean(),
    runtimeProviderActive: z.boolean(),
    providerConsoleConfirmed: z.literal(false),
  }).passthrough(),
  next: z.object({
    instruction: z.string(),
    requiresUserConfirmation: z.boolean(),
    afterConfirmation: z.string(),
    tool: z.string().optional(),
    input: z.record(z.unknown()).optional(),
  }).passthrough(),
} satisfies ZodRawShape;

const CORE_ACTION_OUTPUT_TOOLS = new Set([
  'search_runtime_zone',
  'search_admin_extensions',
  'api_endpoint_workflow',
  'extension_workflow',
  'flow_workflow',
  'verify_extension_runtime',
  'create_tables',
  'update_tables',
  'delete_tables',
  'create_columns',
  'update_columns',
  'delete_columns',
  'create_relations',
  'delete_relations',
  'create_records',
  'update_records',
  'delete_records',
  'patch_script_source',
  'update_script_source',
  'patch_extension_code',
  'update_extension_code',
]);

const BASE_OUTPUT_TOOLS = new Set([
  'get_enfyra_required_knowledge',
  'get_enfyra_examples',
  'discover_enfyra_system',
  'discover_runtime_context',
  'discover_query_capabilities',
  'discover_script_contexts',
  'get_permission_profile',
  'get_current_user',
  'inspect_table',
  'inspect_route',
  'test_rest_endpoint',
  'run_admin_test',
  'test_flow_step',
  'test_graphql',
  'query_table',
  'find_one_record',
  'count_records',
]);

export function getToolOutputSchema(toolName: string): ZodRawShape | undefined {
  if (toolName === 'discover_enfyra_workflows') return workflowDiscoveryOutputSchema;
  if (toolName === 'select_enfyra_workflow') return workflowSelectionOutputSchema;
  if (toolName === 'search_enfyra_tools') return catalogSearchOutputSchema;
  if (toolName === 'execute_enfyra_tool') return catalogExecuteOutputSchema;
  if (toolName === 'get_enfyra_api_context') return apiContextOutputSchema;
  if (toolName === 'query_table') return queryTableOutputSchema;
  if (toolName === 'delete_records') return deleteRecordsOutputSchema;
  if (['delete_tables', 'delete_columns', 'delete_relations', 'delete_method', 'delete_route'].includes(toolName)) {
    return destructiveOutputSchema;
  }
  if (toolName === 'setup_oauth_provider') return oauthProviderOutputSchema;
  if (CORE_ACTION_OUTPUT_TOOLS.has(toolName)) return actionOutputSchema;
  if (BASE_OUTPUT_TOOLS.has(toolName)) return baseOutputSchema;
  return undefined;
}

export function validateStructuredToolOutput(toolName: string, output: unknown) {
  const schema = getToolOutputSchema(toolName);
  if (!schema) return { success: true, data: output } as const;
  return z.object(schema).passthrough().safeParse(output);
}

export function installToolOutputContracts(server: any) {
  const registerLegacyTool = server.tool.bind(server);
  const registerModernTool = server.registerTool?.bind(server);
  server.tool = (...args: any[]) => {
    const name = String(args[0]);
    const outputSchema = getToolOutputSchema(name);
    if (!outputSchema || !registerModernTool) return registerLegacyTool(...args);
    const handler = args.at(-1);
    const configArgs = args.slice(1, -1);
    const description = typeof configArgs[0] === 'string' ? configArgs.shift() : undefined;
    const inputSchema = configArgs.shift() || {};
    const annotations = configArgs.shift();
    return registerModernTool(name, {
      title: annotations?.title,
      description,
      inputSchema,
      outputSchema: z.object(outputSchema).passthrough(),
      annotations,
    }, handler);
  };
}
