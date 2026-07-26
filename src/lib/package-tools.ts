/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { z } from 'zod';
// Import modules
import { fetchAPI } from './fetch.js';
import {
  assertGlobalRulesAck,
  globalRulesAckParam
} from './required-knowledge.js';
import { jsonContent } from './response-format.js';
export function registerPackageTools(server, ENFYRA_API_URL) {
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
      'Install an NPM package on Enfyra. Searches NPM registry for exact version, then creates enfyra_package record.',
      'Enfyra handles the actual yarn add internally based on type.',
      'Type "Server" = available in handlers/hooks as $ctx.$pkgs.packageName.',
      'Type "App" = available in extensions via getPackages().',
    ].join(' '),
    {
      name: z.string().describe('Exact NPM package name (e.g., "node-ssh", "axios")'),
      type: z.enum(['Server', 'App']).default('Server').describe('Where to install: Server (handlers/hooks) or App (extensions)'),
      version: z.string().optional().describe('Specific version. If omitted, fetches latest from NPM.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ name, type, version, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
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
  
      // Step 2: Check if already installed (same name AND type)
      const checkFilter = JSON.stringify({ name: { _eq: name }, type: { _eq: type } });
      const existing = await fetchAPI(ENFYRA_API_URL, `/enfyra_package?filter=${encodeURIComponent(checkFilter)}&limit=1`);
      if (existing.data && existing.data.length > 0) {
        return jsonContent({
          action: 'package_already_installed',
          package: {
            name,
            version: existing.data[0].version,
            type: existing.data[0].type,
          },
          record: existing.data[0],
        });
      }
  
      // Step 3: Get current user for installedBy
      const me = await fetchAPI(ENFYRA_API_URL, '/me');
      const userId = me.data?.[0]?.id || me.data?.[0]?._id;
      if (!userId) throw new Error('Cannot get current user ID');
  
      // Step 4: Install via enfyra_package
      const body = {
        name,
        version: pkgVersion,
        description: pkgDescription,
        type,
        installedBy: { id: userId },
      };
  
      const result = await fetchAPI(ENFYRA_API_URL, '/enfyra_package', {
        method: 'POST',
        body: JSON.stringify(body),
      });
  
      return jsonContent({
        action: 'package_installed',
        package: { name, version: pkgVersion, type },
        result,
      });
    },
  );
}
