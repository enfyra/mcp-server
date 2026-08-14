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
import { destructivePreviewContent } from './destructive-preview.js';
import { jsonContent } from './response-format.js';

function packageFilter(id: string | number) {
  return encodeURIComponent(JSON.stringify({ id: { _eq: id } }));
}

async function findPackage(ENFYRA_API_URL: string, id: string | number) {
  const result = await fetchAPI(
    ENFYRA_API_URL,
    `/enfyra_package?filter=${packageFilter(id)}&limit=1`,
  );
  const packageRecord = result.data?.[0];
  if (!packageRecord) throw new Error(`Package with ID ${id} was not found`);
  return packageRecord;
}

function packageSummary(packageRecord: Record<string, unknown>) {
  return {
    id: packageRecord.id ?? packageRecord._id,
    name: packageRecord.name,
    version: packageRecord.version,
    type: packageRecord.type,
    isEnabled: packageRecord.isEnabled === true,
    status: packageRecord.status ?? null,
  };
}

async function setPackageEnabled(
  ENFYRA_API_URL: string,
  id: string | number,
  isEnabled: boolean,
) {
  const current = await findPackage(ENFYRA_API_URL, id);
  if (current.isSystem === true) {
    throw new Error('Cannot change system-owned package state');
  }

  const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_package/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ isEnabled }),
  });
  const saved = await findPackage(ENFYRA_API_URL, id);
  if ((saved.isEnabled === true) !== isEnabled) {
    throw new Error(`Package ${id} did not persist isEnabled=${isEnabled}`);
  }

  return { current, saved, result };
}

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

  server.tool(
    'enable_package',
    'Business operation: enable one non-system Enfyra package and verify its persisted runtime metadata state.',
    {
      id: z.union([z.string(), z.number()]).describe('Package record id from package_runtime inspection.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ id, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      const operation = await setPackageEnabled(ENFYRA_API_URL, id, true);
      return jsonContent({
        action: 'package_enabled',
        package: packageSummary(operation.saved),
        previousPackage: packageSummary(operation.current),
        result: operation.result,
        postcondition: { isEnabled: true, verified: true },
      });
    },
  );

  server.tool(
    'disable_package',
    'Business operation: disable one non-system Enfyra package and verify its persisted runtime metadata state.',
    {
      id: z.union([z.string(), z.number()]).describe('Package record id from package_runtime inspection.'),
      globalRulesAckKey: globalRulesAckParam(z),
    },
    async ({ id, globalRulesAckKey }) => {
      assertGlobalRulesAck(globalRulesAckKey);
      const operation = await setPackageEnabled(ENFYRA_API_URL, id, false);
      return jsonContent({
        action: 'package_disabled',
        package: packageSummary(operation.saved),
        previousPackage: packageSummary(operation.current),
        result: operation.result,
        postcondition: { isEnabled: false, verified: true },
      });
    },
  );

  server.tool(
    'uninstall_package',
    'Business operation: preview-first uninstall for one non-system Enfyra package. Confirmation requires the exact package id from the preview and verifies that the package metadata is absent afterward.',
    {
      id: z.union([z.string(), z.number()]).describe('Package record id from package_runtime inspection.'),
      expectedId: z.union([z.string(), z.number()]).optional().describe('Required when confirm=true. Pass the exact package id returned by the preview.'),
      confirm: z.boolean().optional().default(false).describe('false returns a package uninstall preview only; true deletes the package metadata and invalidates its runtime cache.'),
      globalRulesAckKey: globalRulesAckParam(z).optional().describe('Required when confirm=true. Use globalRulesAckKey from get_enfyra_required_knowledge.'),
    },
    async ({ id, expectedId, confirm, globalRulesAckKey }) => {
      const packageRecord = await findPackage(ENFYRA_API_URL, id);
      if (packageRecord.isSystem === true) {
        throw new Error('Cannot uninstall system-owned packages');
      }

      if (!confirm) {
        return destructivePreviewContent('uninstall_package', {
          action: 'package_uninstall_preview',
          package: packageSummary(packageRecord),
          next: 'Call uninstall_package again with confirm=true and expectedId set to this package id.',
        }, 1);
      }

      assertGlobalRulesAck(globalRulesAckKey);
      if (expectedId === undefined) throw new Error('expectedId is required when confirm=true');
      if (String(expectedId) !== String(packageRecord.id ?? packageRecord._id)) {
        throw new Error('expectedId does not match the current package');
      }

      const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_package/${id}`, {
        method: 'DELETE',
      });
      const verification = await fetchAPI(
        ENFYRA_API_URL,
        `/enfyra_package?filter=${packageFilter(id)}&limit=1`,
      );
      const remainingPackages = verification.data ?? [];
      const postcondition = {
        verificationMethod: 'package_read_by_id',
        confirmedAbsent: remainingPackages.length === 0,
        remainingPackages: remainingPackages.map(packageSummary),
      };
      const content = jsonContent({
        action: 'package_uninstalled',
        package: packageSummary(packageRecord),
        result,
        postcondition,
      });
      return postcondition.confirmedAbsent ? content : { ...content, isError: true };
    },
  );
}
