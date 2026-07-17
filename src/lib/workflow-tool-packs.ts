import { z } from 'zod';
import { jsonContent } from './response-format.js';
import { WORKFLOW_SURFACES, workflowToolNames, type WorkflowSurface } from './tool-routing.js';
import type { ToolsetRegistrationState } from './types.js';

const MAX_ACTIVE_WORKFLOWS = 2;

export function registerWorkflowToolPack(server: any, state: ToolsetRegistrationState) {
  const activeSurfaces = new Set<WorkflowSurface>();

  return server.tool(
    'select_enfyra_workflow',
    [
      'Select a workflow surface and expose its exact direct MCP tools for this stdio session.',
      'Use replace for normal tasks, add only when one task genuinely spans two surfaces, and reset to return to the compact routing surface.',
      'This changes tool visibility only; it does not grant permissions or bypass Enfyra PAT/RBAC.',
    ].join(' '),
    {
      surface: z.enum(WORKFLOW_SURFACES).optional().describe('Required for replace/add. Omit only with mode=reset.'),
      mode: z.enum(['replace', 'add', 'reset']).optional().default('replace'),
    },
    async ({ surface, mode }: { surface?: WorkflowSurface; mode: 'replace' | 'add' | 'reset' }) => {
      if (mode !== 'reset' && !surface) throw new Error('surface is required when mode is replace or add.');
      if (mode === 'reset') {
        activeSurfaces.clear();
      } else if (mode === 'replace') {
        activeSurfaces.clear();
        activeSurfaces.add(surface!);
      } else {
        activeSurfaces.add(surface!);
        if (activeSurfaces.size > MAX_ACTIVE_WORKFLOWS) {
          activeSurfaces.delete(surface!);
          throw new Error(`At most ${MAX_ACTIVE_WORKFLOWS} workflow surfaces may be active. Use mode=replace or reset first.`);
        }
      }

      const packTools = [...activeSurfaces].flatMap(workflowToolNames);
      const result = state.setActiveTools(packTools);
      return jsonContent({
        action: 'enfyra_workflow_selected',
        mode,
        dynamic: state.dynamic,
        activeSurfaces: [...activeSurfaces],
        visibleToolCount: result.visibleToolNames.length,
        visibleTools: result.visibleToolNames,
        hiddenToolCount: result.hiddenToolCount,
        changed: result.changed,
        guidance: state.dynamic
          ? [
              'Refresh tools/list after this response if the host has not already processed notifications/tools/list_changed.',
              'Call the newly visible workflow tools directly so their exact schemas, annotations, and safety gates remain active.',
              'Use search_enfyra_tools only for hidden read-only long-tail helpers.',
            ]
          : [
              'Dynamic packs are disabled for this static profile/toolset; the configured profile remains visible.',
              'Use ENFYRA_MCP_DYNAMIC_TOOLS=on with guided/all on hosts that support tools/list_changed.',
            ],
      });
    },
  );
}
