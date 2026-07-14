/** GraphQL SDL + HTTP endpoint are under the same base as REST. */
export function buildGraphqlUrls(apiBaseUrl) {
  const base = String(apiBaseUrl || '').replace(/\/$/, '');
  return {
    graphqlHttpUrl: `${base}/graphql`,
    graphqlSchemaUrl: `${base}/graphql-schema`,
  };
}

type McpInstructionOptions = {
  toolsetSummary?: string | null;
};

export function buildMcpServerInstructions(apiBaseUrl, options: McpInstructionOptions = {}) {
  const base = String(apiBaseUrl || '').replace(/\/$/, '');
  const { graphqlHttpUrl, graphqlSchemaUrl } = buildGraphqlUrls(apiBaseUrl);
  const toolsetSummary = options?.toolsetSummary || null;

  return [
    '## Enfyra MCP',
    '',
    `API base for this session: \`${base}\`.`,
    `GraphQL endpoints: \`${graphqlHttpUrl}\` and \`${graphqlSchemaUrl}\`.`,
    ...(toolsetSummary ? ['', toolsetSummary] : []),
    '',
    '### Operating Model',
    '- Primary success criterion: one-shot done. A capable baseline model (GLM-5-Turbo or stronger) should finish a fully specified, non-destructive task in one task turn, using the smallest necessary sequence of MCP calls and without asking the user to relay intermediate plans or retry avoidable failures.',
    '- Primary efficiency criterion: lazy-load by domain. Startup instructions are only a router; load required knowledge, examples, live metadata, script contexts, and theme contracts only when that exact task needs them. Never load broad discovery, full knowledge, or a full reference merely as a precaution.',
    '- For target sanity checks, call `get_enfyra_api_context`; do not load broad metadata only to confirm the API base.',
    '- Metadata is lazy: `GET /metadata` is runtime context only, while table schema comes from `GET /metadata/:name`. Use `get_all_tables` for a lightweight catalog and `get_table_metadata` or `inspect_table` for one schema; do not preload all table schemas.',
    '- When the goal or tool path is ambiguous, call `discover_enfyra_workflows` with intent/risk/surface; follow its `primaryPath` and `avoidTools`. Skip it when the exact focused operation is already clear.',
    '- Inspect only the target: use `inspect_table`, `inspect_route`, `inspect_feature`, `search_admin_extensions`, or `search_runtime_zone`. Do not run broad discovery after the target is known.',
    '- Load examples with `get_enfyra_examples` only for an unfamiliar pattern. For extension UI, load `get_extension_theme_contract`; call build_extension_ui only when the requested UI needs those contracts.',
    '- Prefer the most specific business operation tool over raw metadata CRUD.',
    '- Before a write, call `get_enfyra_required_knowledge` with the narrowest scope: `schema`, `dynamic-code`, `extension`, or `flow`; pass its ack keys to the mutation. Omit scope only for a genuinely multi-domain write.',
    '- For a fully specified, non-destructive request, do not add a plan-only pass: after the required narrow reads and acknowledgement, call the operation/workflow tool once with its atomic or `applyAll` path. Use plan-only/apply-one-step only for ambiguity, external approval, or meaningful production risk.',
    '- Destructive operations remain preview-first and require explicit approval. Verify through the narrow verifier only when the write tool did not already validate or smoke-test atomically.',
    '- Keep security decisions explicit: route access is not owner/tenant authorization. For sensitive reads, preserve the client query shape and merge row scope only into `@QUERY.filter`.',
    '- For dynamic repository code, call `build_dynamic_repository_usage` to choose secure-main, secure-explicit, or intentional trusted-explicit access instead of composing repository macros from memory.',
    '- For a domain-specific rule, use `get_enfyra_required_knowledge`, `discover_script_contexts`, `discover_query_capabilities`, `get_schema_design_context`, `get_extension_theme_contract`, or a single example category—not this startup message.',
  ].join('\n');
}
