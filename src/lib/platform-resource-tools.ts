import { z } from 'zod';
import {
  ensureExtension,
  ensureMenu,
  jsonText,
  reorderMenus,
} from './platform-operation-logic.js';
import {
  extensionKnowledgeAckParam,
  globalRulesAckParam
} from './required-knowledge.js';
import {
  normalizeEscapedVueSource
} from './tool-input-normalization.js';

export function registerPlatformResourceTools(server, ENFYRA_API_URL) {
  server.tool(
      'ensure_menu',
      'Business operation: create or update one admin menu item. Use this instead of raw enfyra_menu CRUD.',
      {
        label: z.string().describe('Menu label.'),
        path: z.string().optional().describe('Admin app route path for leaf menu items, e.g. /reports.'),
        icon: z.string().optional().describe('Menu icon name.'),
        type: z.enum(['Menu', 'Dropdown Menu']).optional().default('Menu').describe('Menu type.'),
        order: z.number().optional().default(0).describe('Display order.'),
        permission: z.string().optional().describe([
          'Menu permission JSON controlling sidebar visibility (not API authority). Use { or: [{ route: "/<path>", methods: ["GET"] }] } to show the menu only to operators who can use the page; { allowAll: true } for globally visible; { rootAdmin: true } for root-only; null for unrestricted public menus. An empty object is normalized to null (unrestricted).',
          'For a page extension, set this to the same route+method set the page calls so the menu is hidden from operators who would 403. Backend route permission is a separate layer: grant it via ensure_route_access for the target role, not here.',
        ].join(' ')),
        description: z.string().optional().describe('Admin note.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable menu.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText({
        action: 'menu_ensured',
        menu: await ensureMenu(ENFYRA_API_URL, input),
      }),
    );

  server.tool(
      'reorder_menus',
      [
        'Business operation: reorder Enfyra admin menus and optionally move menus under a new parent.',
        'Uses the server /admin/menu/reorder route introduced in Enfyra 2.2.6 instead of PATCHing each enfyra_menu record.',
        'The server validates duplicate ids, non-negative integer order, dropdown-only parents, /data child restrictions, system menu parent locks, cycle prevention, persistence, and menu cache invalidation.',
      ].join(' '),
      {
        updates: z.array(z.object({
          id: z.union([z.string(), z.number()]).describe('Menu id to reorder.'),
          order: z.number().int().nonnegative().describe('Sibling order index. Must be a non-negative integer.'),
          parent: z.union([z.string(), z.number(), z.null()]).optional().describe('New parent menu id, or null for a root menu. Parent must be a Dropdown Menu.'),
        })).min(1).describe('Menu order/parent updates, usually the changed siblings from drag-and-drop.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async (input) => jsonText(await reorderMenus(ENFYRA_API_URL, input)),
    );

  server.tool(
      'ensure_page_extension',
      'Business operation: create or update one page extension attached to an existing menu. Validates before save, then re-reads and verifies the exact saved source and menu wiring. Pass sourceFile/sourceResourceUri from an inspected artifact to avoid sending the full SFC through the model call. Call get_extension_theme_contract first for UI work.',
      {
        name: z.string().describe('Extension unique name.'),
        code: z.preprocess(normalizeEscapedVueSource, z.string()).optional().describe('Vue SFC extension code. Raw source is preferred; use sourceFile/sourceResourceUri for a previously inspected artifact.'),
        sourceFile: z.string().optional().describe('Previously returned extension source artifact tmpFile. Arbitrary paths are rejected.'),
        sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for the extension source.'),
        menuId: z.union([z.string(), z.number()]).describe('Existing menu id for this page extension.'),
        description: z.string().optional().describe('Extension description.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
        version: z.string().optional().default('1.0.0').describe('Extension version.'),
        globalRulesAckKey: globalRulesAckParam(z),
        extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
      },
      async (input) => jsonText({
        action: 'page_extension_ensured',
        extension: await ensureExtension(ENFYRA_API_URL, { ...input, type: 'page' }),
      }),
    );

  server.tool(
      'ensure_global_extension',
      'Business operation: create or update one global shell extension. Validates before save, rejects menu coupling, then re-reads and verifies the exact saved source. Pass sourceFile/sourceResourceUri from an inspected artifact to avoid sending the full SFC through the model call. Call get_extension_theme_contract first for UI work.',
      {
        name: z.string().describe('Extension unique name.'),
        code: z.preprocess(normalizeEscapedVueSource, z.string()).optional().describe('Vue SFC extension code. Raw source is preferred; use sourceFile/sourceResourceUri for a previously inspected artifact.'),
        sourceFile: z.string().optional().describe('Previously returned extension source artifact tmpFile. Arbitrary paths are rejected.'),
        sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for the extension source.'),
        description: z.string().optional().describe('Extension description.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
        version: z.string().optional().default('1.0.0').describe('Extension version.'),
        globalRulesAckKey: globalRulesAckParam(z),
        extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
      },
      async (input) => jsonText({
        action: 'global_extension_ensured',
        extension: await ensureExtension(ENFYRA_API_URL, { ...input, type: 'global' }),
      }),
    );

  server.tool(
      'ensure_widget_extension',
      'Business operation: create or update one widget extension. Validates before save, rejects menu coupling, then re-reads and verifies the exact saved source. Pass sourceFile/sourceResourceUri from an inspected artifact to avoid sending the full SFC through the model call. Call get_extension_theme_contract first for UI work.',
      {
        name: z.string().describe('Extension unique name.'),
        code: z.preprocess(normalizeEscapedVueSource, z.string()).optional().describe('Vue SFC extension code. Raw source is preferred; use sourceFile/sourceResourceUri for a previously inspected artifact.'),
        sourceFile: z.string().optional().describe('Previously returned extension source artifact tmpFile. Arbitrary paths are rejected.'),
        sourceResourceUri: z.string().optional().describe('Previously returned enfyra-source artifact URI for the extension source.'),
        description: z.string().optional().describe('Extension description.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable extension.'),
        version: z.string().optional().default('1.0.0').describe('Extension version.'),
        globalRulesAckKey: globalRulesAckParam(z),
        extensionKnowledgeAckKey: extensionKnowledgeAckParam(z),
      },
      async (input) => jsonText({
        action: 'widget_extension_ensured',
        extension: await ensureExtension(ENFYRA_API_URL, { ...input, type: 'widget' }),
      }),
    );
}
