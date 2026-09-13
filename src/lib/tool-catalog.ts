import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { paginateResults } from './pagination.js';
import { jsonContent } from './response-format.js';
import { withSourceArtifactDirectory } from './source-artifacts.js';
import { executeToolDefinition } from './tool-execution.js';
import { getToolContract, isCatalogExecutable } from './tool-contracts.js';
import { getToolOutputSchema } from './tool-output-contracts.js';
import { discoverWorkflowRoutes, listWorkflowSurfaces } from './tool-routing.js';
import type { RegisteredToolDefinition, ToolAvailability, ToolCatalogOptions, ToolsetRegistrationState } from './types.js';

function inputJsonSchema(tool: RegisteredToolDefinition) {
  return zodToJsonSchema(z.object(tool.inputSchema as z.ZodRawShape), { target: 'jsonSchema7', $refStrategy: 'none' });
}

export function scoreToolSearch(tool: Pick<RegisteredToolDefinition, 'name' | 'description'>, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 1;
  if (tool.name.toLowerCase() === normalizedQuery) return 1000;
  const text = `${tool.name} ${tool.description}`.toLowerCase();
  const normalizedName = tool.name.toLowerCase().replace(/_/g, ' ');
  let score = text.includes(normalizedQuery) ? 100 : 0;
  const terms = [...new Set(normalizedQuery.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3))];
  for (const term of terms) {
    if (normalizedName.includes(term)) score += 4;
    else if (text.includes(term)) score += 1;
  }
  return score;
}

function invocationFor(name: string) {
  return { tool: 'enfyra', arguments: { action: 'execute', name } };
}

function defaultAvailability(toolNames: string[]): Record<string, ToolAvailability> {
  return Object.fromEntries(toolNames.map((name) => [name, {
    status: 'unknown',
    reason: 'Enfyra PAT/RBAC remains authoritative at execution time.',
  } satisfies ToolAvailability]));
}

const discoveryInput = {
  query: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(5).optional().default(3),
  cursor: z.string().optional(),
};
const executionInput = {
  name: z.string().min(1),
  arguments: z.record(z.unknown()).optional().default({}),
};
const gatewayInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('discover'), ...discoveryInput }).strict(),
  z.object({ action: z.literal('execute'), ...executionInput }).strict(),
]);

export function registerToolCatalogTools(server: any, state: ToolsetRegistrationState, { resolveAvailability, sourceDirectory }: ToolCatalogOptions = {}) {
  const availabilityFor = async (names: string[]) => {
    const remote = names.filter((name) => name !== 'get_enfyra_api_context' && getToolContract(name).annotations.openWorldHint);
    const availability = defaultAvailability(names);
    if (remote.length && resolveAvailability) Object.assign(availability, await resolveAvailability(remote));
    return availability;
  };
  return server.tool(
    'enfyra',
    'Manage Enfyra APIs, data/schema, admin UI, scripts, flows, permissions and infrastructure. Use discover with an intent or exact operation name for a bounded workflow and exact schemas; omit query for the capability index. Use execute with name and arguments from discovery. Target confirmation, knowledge and destructive previews remain required. Discovery never adds public tools.',
    {
      action: z.enum(['discover', 'execute']),
      query: discoveryInput.query.describe('discover only: intent or exact internal operation name.'),
      limit: z.number().int().min(1).max(5).optional().describe('discover only: schemas per page, default 3.'),
      cursor: discoveryInput.cursor.describe('discover only: nextCursor, with the same query and limit.'),
      name: executionInput.name.optional().describe('execute only: exact internal operation name.'),
      arguments: z.record(z.unknown()).optional().describe('execute only: JSON object matching the discovered inputSchema.'),
    },
    async (input: unknown, extra: any) => {
      const request = gatewayInput.parse(input);
      if (request.action === 'discover') {
        const query = request.query ?? '';
        const registry = state.listTools().filter((tool) => isCatalogExecutable(tool.name));
        const exact = registry.find((tool) => tool.name === query);
        const routing = discoverWorkflowRoutes({ intent: query, detail: query ? 'plan' : 'summary', limit: query ? 1 : 10 }, state.profile);
        const workflows = exact || !query ? [] : routing.workflows;
        const routedNames = new Set(workflows.flatMap((workflow) => 'primaryPath' in workflow && Array.isArray(workflow.primaryPath)
          ? workflow.primaryPath.map((step) => step.tool)
          : []));
        const candidates = query ? registry
          .map((tool) => ({ tool, score: scoreToolSearch(tool, query) + (routedNames.has(tool.name) ? 2 : 0) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
          .map(({ tool }) => tool) : [];
        const page = paginateResults(candidates, {
          limit: request.limit,
          cursor: request.cursor,
          fingerprint: { query, limit: request.limit, profile: state.profile },
        });
        const availability = await availabilityFor(page.items.map((tool) => tool.name));
        return jsonContent({
          action: 'enfyra_tools_discovered',
          profile: state.profile,
          query: query || null,
          resultCount: candidates.length,
          page: page.page,
          ...(!query ? { capabilities: listWorkflowSurfaces().map(({ key, title }) => ({ key, title })) } : {}),
          workflows,
          tools: page.items.map((tool) => {
            const outputSchema = getToolOutputSchema(tool.name);
            return {
              name: tool.name,
              description: tool.description,
              annotations: tool.annotations ?? getToolContract(tool.name).annotations,
              availability: availability[tool.name] ?? defaultAvailability([tool.name])[tool.name],
              invocation: invocationFor(tool.name),
              inputSchema: inputJsonSchema(tool),
              ...(outputSchema ? { outputSchema: zodToJsonSchema(z.object(outputSchema).passthrough(), { $refStrategy: 'none' }) } : {}),
            };
          }),
          prerequisites: [
            { ...invocationFor('get_enfyra_api_context'), when: 'Before the first write, execute and verify the target API.' },
            { ...invocationFor('prepare_enfyra_workspace'), when: 'Before inspecting or editing live source, prepare its ignored project workspace with explicit artifact references.' },
            { ...invocationFor('get_enfyra_required_knowledge'), when: 'Discover its schema and execute with the workflow domain before writing.' },
          ],
          guidance: [
            'All operation names in workflows and results are internal. Discover their exact name, then execute through enfyra.',
            'Follow the workflow prerequisites and verification path. Discovery itself does not confirm a target or acknowledge knowledge.',
            'PAT capability hints do not grant authority; backend authorization and operation safety gates apply at execution.',
          ],
        }, { columnar: false });
      }

      const tool = state.getTool(request.name);
      if (!tool || !isCatalogExecutable(request.name)) {
        throw new Error(`Operation "${request.name}" is unavailable through enfyra. Use action=discover to find its guided workflow.`);
      }
      const execute = () => executeToolDefinition(tool, request.arguments, extra, availabilityFor);
      const formatted = await (sourceDirectory ? withSourceArtifactDirectory(sourceDirectory(), execute) : execute());
      const text = formatted?.content?.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n') ?? '';
      const envelope = jsonContent({ action: 'enfyra_catalog_tool_executed', tool: tool.name, result: formatted?.structuredContent ?? text }, { columnar: false });
      return {
        ...envelope,
        ...(formatted?.isError === true ? { isError: true } : {}),
        ...(formatted?._meta ? { _meta: { ...envelope._meta, ...formatted._meta } } : {}),
        content: [...envelope.content, ...(formatted?.content?.filter((item: any) => item.type !== 'text') ?? [])],
      };
    },
  );
}
