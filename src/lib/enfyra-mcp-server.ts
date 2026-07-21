import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { initAuth } from './auth.js';
import { registerDynamicRepositoryBuilder } from './dynamic-repository-builder.js';
import {
  ENFYRA_API_TOKEN,
  ENFYRA_API_URL,
  MCP_DYNAMIC_TOOLS,
  MCP_PROFILE,
  MCP_TOOLSET,
  resolveCatalogToolAvailability,
} from './enfyra-tool-logic.js';
import { registerDiscoveryTools } from './discovery-tools.js';
import { registerIdentityTools } from './identity-tools.js';
import { registerLogTools } from './log-tools.js';
import { buildMcpServerInstructions } from './mcp-instructions.js';
import { startMcpUsageTelemetry } from './mcp-usage-telemetry.js';
import { registerMethodTools } from './method-tools.js';
import { registerOAuthProviderTools } from './oauth-tools.js';
import { registerPackageTools } from './package-tools.js';
import { registerPlatformOperationTools } from './platform-operation-tools.js';
import { registerRecordTools } from './record-tools.js';
import { installColumnarToolFormatter } from './response-format.js';
import { registerRouteTools } from './route-tools.js';
import { startRuntimeCacheSocket } from './runtime-cache-socket.js';
import { registerRuntimeZoneTools } from './runtime-zone-tools.js';
import { registerScriptTools } from './script-tools.js';
import { readSourceArtifactResource } from './source-artifacts.js';
import { registerSystemTools } from './system-tools.js';
import { registerTableTools } from './table-tools.js';
import { registerToolCatalogTools } from './tool-catalog.js';
import { installToolAnnotations } from './tool-contracts.js';
import { installToolOutputContracts } from './tool-output-contracts.js';
import {
  installToolsetFilter,
  summarizeToolsetForInstructions,
} from './toolset-filter.js';
import { registerWorkflowToolPack } from './workflow-tool-packs.js';

export function createEnfyraMcpServer() {
  initAuth(ENFYRA_API_URL, ENFYRA_API_TOKEN);

  const server = new McpServer(
    {
      name: 'enfyra-mcp',
      version: '1.0.0',
    },
    {
      instructions: buildMcpServerInstructions(ENFYRA_API_URL, {
        toolsetSummary: summarizeToolsetForInstructions(MCP_TOOLSET, MCP_PROFILE, MCP_DYNAMIC_TOOLS),
      }),
    },
  );
  installToolOutputContracts(server);
  installColumnarToolFormatter(server);
  const toolsetState = installToolsetFilter(server, MCP_TOOLSET, MCP_PROFILE, { dynamic: MCP_DYNAMIC_TOOLS });
  installToolAnnotations(server);
  startMcpUsageTelemetry(ENFYRA_API_URL, `${MCP_TOOLSET}:${MCP_PROFILE}`);
  server.registerResource(
    'enfyra-source-artifact',
    new ResourceTemplate('enfyra-source://artifact/{artifactId}', { list: undefined }),
    {
      title: 'Enfyra source artifact',
      description: 'Process-scoped source or diff artifact created by an Enfyra MCP inspect or preview tool.',
      mimeType: 'text/plain',
    },
    async (uri) => ({ contents: [readSourceArtifactResource(uri.href)] }),
  );

  registerDiscoveryTools(server, ENFYRA_API_URL);
  registerRecordTools(server, ENFYRA_API_URL);
  registerScriptTools(server, ENFYRA_API_URL);
  registerMethodTools(server, ENFYRA_API_URL);
  registerRouteTools(server, ENFYRA_API_URL);
  registerTableTools(server, ENFYRA_API_URL, { toolset: MCP_TOOLSET });
  registerPlatformOperationTools(server, ENFYRA_API_URL);
  registerRuntimeZoneTools(server, ENFYRA_API_URL);
  registerOAuthProviderTools(server, ENFYRA_API_URL);
  registerDynamicRepositoryBuilder(server);
  registerSystemTools(server, ENFYRA_API_URL);
  registerLogTools(server, ENFYRA_API_URL);
  registerIdentityTools(server, ENFYRA_API_URL);
  registerPackageTools(server, ENFYRA_API_URL);
  registerToolCatalogTools(server, toolsetState, {
    resolveAvailability: resolveCatalogToolAvailability,
  });
  registerWorkflowToolPack(server, toolsetState);

  return server;
}

export async function runEnfyraMcpServer() {
  console.error('Starting Enfyra MCP Server...');
  console.error(`API URL: ${ENFYRA_API_URL}`);
  console.error(`Auth: ${ENFYRA_API_TOKEN ? 'API token configured' : 'Not configured'}`);

  const server = createEnfyraMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  startRuntimeCacheSocket(ENFYRA_API_URL);

  console.error('Enfyra MCP Server running on stdio');
}
