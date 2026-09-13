import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createScriptWorkspace } from './script-workspace.js';
import { createWorkspaceRemote } from './workspace-remote.js';
import { workspaceArtifactSchema } from './workspace-state.js';
import { jsonContent } from './response-format.js';
import type { ToolsetRegistrationState } from './types.js';

export function registerWorkspaceTools(server: any, state: ToolsetRegistrationState, apiUrl: string, projectRoot?: string) {
  const workspace = createScriptWorkspace({
    apiUrl,
    projectRoot,
    roots: async () => {
      if (!server.server.getClientCapabilities()?.roots) return [];
      const result = await server.server.listRoots();
      return result.roots.map((root: { uri: string }) => fileURLToPath(root.uri));
    },
    ...createWorkspaceRemote(apiUrl, state),
  });
  const scope = {
    projectRoot: z.string().optional().describe('Absolute client project directory. Defaults to the selected workspace, configured ENFYRA_MCP_PROJECT_ROOT or one client-provided root; never guesses cwd.'),
    keys: z.array(z.string()).min(1).max(100).optional().describe('Exact workspace artifact keys. Omit to select the prepared inventory.'),
  };
  server.tool('prepare_enfyra_workspace', 'Prepare an ignored project-local enfyra/ source worktree. Adds /enfyra/ and /.tmp/enfyra/ to Git ignore before any source write. Bootstrap with explicit artifact references from discovery; existing workspaces preserve local edits and target binding. Does not create a Git branch or clone the whole instance.', {
    ...scope,
    artifacts: z.array(workspaceArtifactSchema).max(100).optional().describe('Located live records to add. Optional path is relative to enfyra/. Required for a new workspace; use [] before creating new source, or omit to reopen.'),
  }, async (input) => jsonContent(await workspace.prepare(input), { columnar: false }));
  server.tool('inspect_enfyra_workspace', 'Inspect local, last-synced and freshly read live source hashes. Returns synced/local_changed/remote_changed/conflict or missing states, local file paths and project-local .tmp snapshots. Does not overwrite working sources.', scope,
    async (input) => jsonContent(await workspace.inspect(input), { columnar: false }));
  server.tool('pull_enfyra_sources', 'Refresh missing or unchanged local workspace files from live source. Keeps local edits, conflicts and remotely deleted files intact; never infers server deletion from local deletion. Use inspect_enfyra_workspace to review returned states.', scope,
    async (input) => jsonContent(await workspace.pull(input), { columnar: false }));
  server.tool('push_enfyra_sources', 'Preview and validate edited workspace sources, then apply the reviewed planId. Requires target confirmation and domain knowledge. Rechecks local/live hashes, uses canonical source writers and verifies each saved source. The plan is consumed before writes; partial failure requires fresh inspection and preview. External writers are not atomically locked.', {
    ...scope,
    apply: z.boolean().optional().default(false),
    planId: z.string().uuid().optional().describe('Required with apply=true; use the current reviewed preview plan and omit keys.'),
  }, async (input) => {
    const result = await workspace.push(input);
    const content = jsonContent(result, { columnar: false });
    return input.apply && !result.complete ? { ...content, isError: true } : content;
  });
  return workspace;
}
