/**
 * Enfyra MCP — stdio server (loaded by index.mjs).
 */

import { config } from 'dotenv';
config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Configuration
const ENFYRA_API_URL = process.env.ENFYRA_API_URL || 'http://localhost:3000/api';
const ENFYRA_EMAIL = process.env.ENFYRA_EMAIL || '';
const ENFYRA_PASSWORD = process.env.ENFYRA_PASSWORD || '';

// Import modules
import { login, refreshAccessToken, getValidToken, resetTokens, getTokenExpiry, initAuth } from './lib/auth.js';
import { fetchAPI, validateFilter, validateTableName } from './lib/fetch.js';
import { buildMcpServerInstructions, buildGraphqlUrls } from './lib/mcp-instructions.js';
import { registerTableTools } from './lib/table-tools.js';

// Initialize auth module
initAuth(ENFYRA_API_URL, ENFYRA_EMAIL, ENFYRA_PASSWORD);

// Create MCP server — `instructions` is sent to the host (e.g. Claude Code) for the LLM; not README
const server = new McpServer(
  {
    name: 'enfyra-mcp',
    version: '1.0.0',
  },
  {
    instructions: buildMcpServerInstructions(ENFYRA_API_URL),
  },
);

// ============================================================================
// METADATA TOOLS
// ============================================================================

server.tool('get_all_metadata', 'Get all metadata (tables, columns, relations, routes, hooks, etc.) from Enfyra', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/metadata');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('get_table_metadata', 'Get metadata for a specific table by name', {
  tableName: z.string().describe('Table name (e.g., "user_definition", "route_definition")'),
}, async ({ tableName }) => {
  const result = await fetchAPI(ENFYRA_API_URL, `/metadata/${tableName}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

// ============================================================================
// QUERY TOOLS
// ============================================================================

server.tool(
  'get_enfyra_api_context',
  [
    'Returns the resolved API base URL for this MCP session (env ENFYRA_API_URL).',
    'Use when the user asks which HTTP endpoint or full URL applies: combine enfyraApiUrl with paths from server instructions (GET/POST /{table}, PATCH/DELETE /{table}/{id}, no GET /{table}/{id}).',
    'Auth: publishedMethods on a route can allow a method without Bearer; otherwise JWT + routePermissions — see server instructions.',
    'If path might differ from table name, use get_all_routes before asserting a URL.',
    'Same mapping as MCP tool → HTTP: query_table=GET /table?..., create_record=POST /table, update_record=PATCH /table/id, delete_record=DELETE /table/id.',
    'GraphQL: see graphqlHttpUrl / graphqlSchemaUrl in response; GQL_QUERY vs GQL_MUTATION in publishedMethods — server instructions.',
  ].join(' '),
  {},
  async () => {
    const base = ENFYRA_API_URL.replace(/\/$/, '');
    const gql = buildGraphqlUrls(ENFYRA_API_URL);
    const payload = {
      enfyraApiUrl: base,
      graphqlHttpUrl: gql.graphqlHttpUrl,
      graphqlSchemaUrl: gql.graphqlSchemaUrl,
      examples: {
        listOrCreate: `${base}/<table_name>`,
        updateOrDelete: `${base}/<table_name>/<id>`,
        oneRowById: `${base}/<table_name>?filter={"id":{"_eq":"<id>"}}&limit=1`,
      },
      auth: {
        publishedMethods: 'If the HTTP method is published for that route, no Bearer required; else Bearer JWT and routePermissions apply.',
        mcp: 'This server uses admin credentials from env for tools (fetchAPI).',
      },
      pathResolution: 'Confirm route path with get_all_routes or metadata — path may not equal table name.',
      note: 'Full tool→HTTP mapping is in MCP server instructions (shown to the model at connect).',
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.tool('query_table', 'Query any table in Enfyra with filters, sorting, and pagination', {
  tableName: z.string().describe('Table name to query'),
  filter: z.string().optional().describe('Filter object as JSON string. Examples: \'{"status": {"_eq": "active"}}\''),
  sort: z.string().optional().describe('Sort field. Prefix with - for descending (e.g., "createdAt", "-id")'),
  page: z.number().optional().describe('Page number (default: 1)'),
  limit: z.number().optional().describe('Items per page (default: 50, max: 500)'),
  fields: z.array(z.string()).optional().describe('Fields to select'),
}, async ({ tableName, filter, sort, page, limit, fields }) => {
  validateTableName(tableName);
  validateFilter(filter);

  const queryParams = new URLSearchParams();
  if (filter) queryParams.set('filter', filter);
  if (sort) queryParams.set('sort', sort);
  if (page) queryParams.set('page', String(page));
  if (limit) queryParams.set('limit', String(limit));
  if (fields) queryParams.set('fields', fields.join(','));

  const query = queryParams.toString();
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}${query ? `?${query}` : ''}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool(
  'find_one_record',
  'Find a single record by ID or filter. By ID uses GET with filter (Enfyra has no GET /table/:id route).',
  {
    tableName: z.string().describe('Table name'),
    id: z.string().optional().describe('Record ID'),
    filter: z.string().optional().describe('Filter as JSON string to find by'),
  },
  async ({ tableName, id, filter }) => {
    validateTableName(tableName);
    if (id) {
      // Enfyra route engine does not register GET /<table>/:id (only PATCH/DELETE use /:id). Use list + filter.
      const filterObj = JSON.stringify({ id: { _eq: id } });
      const result = await fetchAPI(
        ENFYRA_API_URL,
        `/${tableName}?filter=${encodeURIComponent(filterObj)}&limit=1`,
      );
      const one = result.data?.[0] ?? null;
      return { content: [{ type: 'text', text: JSON.stringify(one, null, 2) }] };
    }
    if (!filter) throw new Error('Provide id or filter');
    validateFilter(filter);
    const result = await fetchAPI(
      ENFYRA_API_URL,
      `/${tableName}?filter=${encodeURIComponent(filter)}&limit=1`,
    );
    return { content: [{ type: 'text', text: JSON.stringify(result.data?.[0] || null, null, 2) }] };
  },
);

// ============================================================================
// CRUD TOOLS
// ============================================================================

server.tool('create_record', 'Create a new record in any table', {
  tableName: z.string().describe('Table name to insert into'),
  data: z.string().describe('Record data as JSON string'),
}, async ({ tableName, data }) => {
  validateTableName(tableName);
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}`, { method: 'POST', body: data });
  return { content: [{ type: 'text', text: `Record created:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('update_record', 'Update an existing record by ID using PATCH', {
  tableName: z.string().describe('Table name'),
  id: z.string().describe('Record ID to update'),
  data: z.string().describe('Fields to update as JSON string'),
}, async ({ tableName, id, data }) => {
  validateTableName(tableName);
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}/${id}`, { method: 'PATCH', body: data });
  return { content: [{ type: 'text', text: `Record updated:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('delete_record', 'Delete a record by ID', {
  tableName: z.string().describe('Table name'),
  id: z.string().describe('Record ID to delete'),
}, async ({ tableName, id }) => {
  validateTableName(tableName);
  const result = await fetchAPI(ENFYRA_API_URL, `/${tableName}/${id}`, { method: 'DELETE' });
  return { content: [{ type: 'text', text: `Record deleted:\n${JSON.stringify(result, null, 2)}` }] };
});

// ============================================================================
// ROUTE & HANDLER TOOLS
// ============================================================================

server.tool('get_all_routes', 'Get all route definitions with handlers, hooks, and permissions', {
  includeDisabled: z.boolean().optional().default(false).describe('Include disabled routes'),
}, async ({ includeDisabled }) => {
  const filter = includeDisabled ? {} : { isEnabled: { _eq: true } };
  const result = await fetchAPI(ENFYRA_API_URL, `/route_definition?filter=${encodeURIComponent(JSON.stringify(filter))}&limit=500`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('create_route', 'Create a new route definition', {
  path: z.string().describe('Route path (e.g., "/api/users")'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'REST', 'GQL_QUERY', 'GQL_MUTATION']).describe('HTTP method'),
  tableId: z.string().describe('Main table ID for this route'),
  isEnabled: z.boolean().optional().default(true).describe('Enable route'),
  description: z.string().optional().describe('Route description'),
}, async ({ path, method, tableId, isEnabled, description }) => {
  const result = await fetchAPI(ENFYRA_API_URL, '/route_definition', {
    method: 'POST',
    body: JSON.stringify({ path, method, tableId, isEnabled, description }),
  });
  return { content: [{ type: 'text', text: `Route created (ID: ${result.id}):\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('create_handler', 'Create a handler for a route. Use template syntax: @BODY, @USER, #table_name, @THROW404', {
  routeId: z.string().describe('Route definition ID'),
  logic: z.string().describe('Handler logic (JavaScript code)'),
  timeout: z.number().optional().describe('Handler timeout in ms (default: 30000)'),
}, async ({ routeId, logic, timeout }) => {
  const result = await fetchAPI(ENFYRA_API_URL, '/route_handler_definition', {
    method: 'POST',
    body: JSON.stringify({ routeId, logic, timeout: timeout || 30000 }),
  });
  return { content: [{ type: 'text', text: `Handler created (ID: ${result.id}):\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('create_pre_hook', 'Create a pre-hook for a route. Use template syntax: @BODY, @QUERY, @USER', {
  routeId: z.string().describe('Route definition ID'),
  code: z.string().describe('Hook code (JavaScript)'),
  methods: z.array(z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])).optional().describe('Methods this hook applies to'),
  order: z.number().optional().default(0).describe('Hook execution order'),
}, async ({ routeId, code, methods, order }) => {
  const result = await fetchAPI(ENFYRA_API_URL, '/pre_hook_definition', {
    method: 'POST',
    body: JSON.stringify({ routeId, code, methods: methods || ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], order }),
  });
  return { content: [{ type: 'text', text: `Pre-hook created (ID: ${result.id}):\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('create_post_hook', 'Create a post-hook for a route. Use template syntax: @DATA, @STATUS', {
  routeId: z.string().describe('Route definition ID'),
  code: z.string().describe('Hook code (JavaScript)'),
  methods: z.array(z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])).optional().describe('Methods this hook applies to'),
  order: z.number().optional().default(0).describe('Hook execution order'),
}, async ({ routeId, code, methods, order }) => {
  const result = await fetchAPI(ENFYRA_API_URL, '/post_hook_definition', {
    method: 'POST',
    body: JSON.stringify({ routeId, code, methods: methods || ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], order }),
  });
  return { content: [{ type: 'text', text: `Post-hook created (ID: ${result.id}):\n${JSON.stringify(result, null, 2)}` }] };
});

// Register table tools
registerTableTools(server, ENFYRA_API_URL);

// ============================================================================
// CACHE & SYSTEM TOOLS
// ============================================================================

server.tool('reload_all', 'Reload all caches (metadata, routes, swagger, GraphQL)', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload', { method: 'POST' });
  return { content: [{ type: 'text', text: `System reloaded:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('reload_metadata', 'Reload metadata cache only', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/metadata', { method: 'POST' });
  return { content: [{ type: 'text', text: `Metadata reloaded:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('reload_routes', 'Reload routes cache only', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/routes', { method: 'POST' });
  return { content: [{ type: 'text', text: `Routes reloaded:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('reload_swagger', 'Reload Swagger/OpenAPI spec', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/swagger', { method: 'POST' });
  return { content: [{ type: 'text', text: `Swagger reloaded:\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool('reload_graphql', 'Reload GraphQL schema', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/admin/reload/graphql', { method: 'POST' });
  return { content: [{ type: 'text', text: `GraphQL reloaded:\n${JSON.stringify(result, null, 2)}` }] };
});

// ============================================================================
// LOGS TOOLS
// ============================================================================

server.tool('get_log_files', 'List available log files and stats', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/logs');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('get_log_content', 'Get content of a specific log file', {
  filename: z.string().describe('Log file name'),
  page: z.number().optional().default(1).describe('Page number'),
  pageSize: z.number().optional().default(100).describe('Lines per page'),
  filter: z.string().optional().describe('Text filter'),
  level: z.string().optional().describe('Log level filter (INFO, WARN, ERROR)'),
}, async ({ filename, page, pageSize, filter, level }) => {
  const queryParams = new URLSearchParams();
  if (page) queryParams.set('page', String(page));
  if (pageSize) queryParams.set('pageSize', String(pageSize));
  if (filter) queryParams.set('filter', filter);
  if (level) queryParams.set('level', level);
  const result = await fetchAPI(ENFYRA_API_URL, `/logs/${filename}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('tail_log', 'Get last N lines from a log file', {
  filename: z.string().describe('Log file name'),
  lines: z.number().optional().default(50).describe('Number of lines to retrieve'),
}, async ({ filename, lines }) => {
  const result = await fetchAPI(ENFYRA_API_URL, `/logs/${filename}/tail?lines=${lines}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('search_logs', 'Search for ERROR or WARN logs across recent log files', {
  level: z.enum(['ERROR', 'WARN', 'INFO']).optional().default('ERROR').describe('Log level'),
  keyword: z.string().optional().describe('Keyword to filter logs'),
  limit: z.number().optional().default(50).describe('Max results per level'),
}, async ({ level, keyword, limit }) => {
  const logFilesResult = await fetchAPI(ENFYRA_API_URL, '/logs');
  const logFiles = logFilesResult.files || [];
  const recentFiles = logFiles.filter(f => f.name.includes('app-') || f.name.includes('error-'));
  const results = [];
  for (const file of recentFiles.slice(0, 3)) {
    try {
      const contentResult = await fetchAPI(ENFYRA_API_URL, `/logs/${file.name}?level=${level}&pageSize=${limit}`);
      const lines = contentResult.lines || contentResult.data || [];
      const filteredLines = keyword ? lines.filter(l => JSON.stringify(l).toLowerCase().includes(keyword.toLowerCase())) : lines;
      if (filteredLines.length > 0) results.push({ file: file.name, level, logs: filteredLines });
    } catch (e) { /* skip */ }
  }
  return { content: [{ type: 'text', text: `Found ${results.length} files:\n${JSON.stringify(results, null, 2)}` }] };
});

// ============================================================================
// AUTH & USER TOOLS
// ============================================================================

server.tool('get_current_user', 'Get current authenticated user info', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/me');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('get_all_roles', 'Get all role definitions', {}, async () => {
  const result = await fetchAPI(ENFYRA_API_URL, '/role_definition?limit=100');
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('login', 'Force login to Enfyra and get new tokens', {
  email: z.string().email().optional().describe('Admin email'),
  password: z.string().optional().describe('Password'),
}, async ({ email, password }) => {
  const loginEmail = email || ENFYRA_EMAIL;
  const loginPassword = password || ENFYRA_PASSWORD;
  if (!loginEmail || !loginPassword) throw new Error('Email and password required');
  await login(ENFYRA_API_URL, loginEmail, loginPassword);
  return { content: [{ type: 'text', text: `Logged in successfully!\nToken expires: ${new Date(getTokenExpiry()).toISOString()}` }] };
});

// ============================================================================
// PACKAGE TOOLS
// ============================================================================

server.tool(
  'search_npm',
  'Search NPM registry for packages. Returns name, version, description for installation.',
  {
    query: z.string().describe('Package name or search term (e.g., "axios", "node-ssh", "dayjs")'),
    limit: z.number().optional().default(5).describe('Max results (default: 5)'),
  },
  async ({ query, limit }) => {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`NPM search failed: ${response.statusText}`);
    const data = await response.json();

    const packages = data.objects.map((obj) => ({
      name: obj.package.name,
      version: obj.package.version,
      description: obj.package.description || '',
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ packages, total: data.total }, null, 2),
      }],
    };
  },
);

server.tool(
  'install_package',
  [
    'Install an NPM package on Enfyra. Searches NPM registry for exact version, then creates package_definition record.',
    'Enfyra handles the actual yarn add internally based on type.',
    'Type "Server" = available in handlers/hooks as $ctx.$pkgs.packageName.',
    'Type "App" = available in extensions via getPackages().',
  ].join(' '),
  {
    name: z.string().describe('Exact NPM package name (e.g., "node-ssh", "axios")'),
    type: z.enum(['Server', 'App']).default('Server').describe('Where to install: Server (handlers/hooks) or App (extensions)'),
    version: z.string().optional().describe('Specific version. If omitted, fetches latest from NPM.'),
  },
  async ({ name, type, version }) => {
    // Step 1: Get package info from NPM if version not specified
    let pkgVersion = version;
    let pkgDescription = '';

    if (!pkgVersion) {
      const npmUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=5`;
      const npmResponse = await fetch(npmUrl);
      if (!npmResponse.ok) throw new Error(`NPM search failed: ${npmResponse.statusText}`);
      const npmData = await npmResponse.json();

      const exactMatch = npmData.objects.find((obj) => obj.package.name === name);
      if (!exactMatch) throw new Error(`Package "${name}" not found on NPM`);

      pkgVersion = exactMatch.package.version;
      pkgDescription = exactMatch.package.description || '';
    }

    // Step 2: Check if already installed
    const checkFilter = JSON.stringify({ name: { _eq: name } });
    const existing = await fetchAPI(ENFYRA_API_URL, `/package_definition?filter=${encodeURIComponent(checkFilter)}&limit=1`);
    if (existing.data && existing.data.length > 0) {
      return {
        content: [{
          type: 'text',
          text: `Package "${name}" is already installed (version: ${existing.data[0].version}, type: ${existing.data[0].type}).\n${JSON.stringify(existing.data[0], null, 2)}`,
        }],
      };
    }

    // Step 3: Get current user for installedBy
    const me = await fetchAPI(ENFYRA_API_URL, '/me');
    const userId = me.data?.[0]?.id || me.data?.[0]?._id;
    if (!userId) throw new Error('Cannot get current user ID');

    // Step 4: Install via package_definition
    const body = {
      name,
      version: pkgVersion,
      description: pkgDescription,
      type,
      installedBy: { id: userId },
    };

    const result = await fetchAPI(ENFYRA_API_URL, '/package_definition', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      content: [{
        type: 'text',
        text: `Package "${name}@${pkgVersion}" installed successfully (type: ${type}).\n${JSON.stringify(result, null, 2)}`,
      }],
    };
  },
);

// ============================================================================
// MENU & EXTENSION TOOLS
// ============================================================================

server.tool('create_menu', 'Create a menu item in the navigation', {
  label: z.string().describe('Menu label'),
  type: z.enum(['separator', 'link', 'route', 'dropdown', 'widget', 'extension']).describe('Menu type'),
  icon: z.string().optional().describe('Lucide icon name'),
  path: z.string().optional().describe('Route path for type=route'),
  externalUrl: z.string().optional().describe('External URL for type=link'),
  order: z.number().optional().default(0).describe('Display order'),
  isEnabled: z.boolean().optional().default(true).describe('Enable menu'),
  description: z.string().optional().describe('Menu description'),
}, async (data) => {
  const result = await fetchAPI(ENFYRA_API_URL, '/menu_definition', { method: 'POST', body: JSON.stringify(data) });
  return { content: [{ type: 'text', text: `Menu created (ID: ${result.id}):\n${JSON.stringify(result, null, 2)}` }] };
});

server.tool(
  'create_extension',
  [
    'Create an extension (Vue SFC page or widget). Code must be Vue SFC: <template>...</template> + <script setup>...</script> — NO imports, use globals (ref, useToast, useApi, UButton, etc).',
    'For type=page: create menu first (create_menu), get id, then pass menuId. For type=widget no menu needed. Server auto-compiles; tell user to refresh (F5) after create. See extension rules in MCP instructions.',
  ].join(' '),
  {
    name: z.string().describe('Extension name (unique)'),
    type: z.enum(['page', 'widget']).describe('Extension type: page = full page linked to menu; widget = embed via Widget component'),
    code: z.string().describe('Vue SFC string — <template> + <script setup>, NO import statements'),
    menuId: z.string().optional().describe('Required for type=page — menu_definition id from create_menu. Omit for widget'),
    isEnabled: z.boolean().optional().default(true).describe('Enable extension'),
    description: z.string().optional().describe('Extension description'),
  },
  async (data) => {
    const body = { ...data };
    if (body.menuId) {
      body.menu = { id: body.menuId };
      delete body.menuId;
    }
    const result = await fetchAPI(ENFYRA_API_URL, '/extension_definition', { method: 'POST', body: JSON.stringify(body) });
    return { content: [{ type: 'text', text: `Extension created (ID: ${result.id}). Tell user to refresh (F5) to see it.\n${JSON.stringify(result, null, 2)}` }] };
  },
);

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.error('Starting Enfyra MCP Server...');
  console.error(`API URL: ${ENFYRA_API_URL}`);
  console.error(`Auth: ${ENFYRA_EMAIL ? `Configured (${ENFYRA_EMAIL})` : 'Not configured'}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Enfyra MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
