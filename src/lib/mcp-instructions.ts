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
    '- Call `get_enfyra_api_context` before the first mutation; writes are rejected until this MCP process has confirmed its target, and inspect only the table, route, extension, or runtime artifact being changed.',
    '- For a known non-destructive task, load the narrow `get_enfyra_required_knowledge` scope once, then use the most specific operation tool in the same turn. Session acknowledgement removes repeated ack-key boilerplate.',
    '- Call `discover_enfyra_workflows` only when the path is ambiguous. Load examples, metadata, script contexts, builders, and theme contracts lazily; never preload broad context.',
    '- Keep authorization and data exposure explicit. Use deterministic builders and reviewers for dynamic repository or extension contracts instead of composing fragile shapes from memory.',
    '- Destructive operations require a successful matching preview in this MCP process before confirmation. Prefer atomic validation and saved-state verification; browser rendering is separate when a verifier reports it was not run.',
  ].join('\n');
}
