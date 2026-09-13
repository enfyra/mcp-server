import { mkdirSync, realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { withSourceArtifactDirectory } from './source-artifacts.js';
import { ensureWorkspaceIgnored, readWorkspaceFile, safeWorkspacePath, withWorkspaceLock, workspacePaths, workspaceTarget, writeWorkspaceFile } from './workspace-files.js';
import { artifactKey, artifactPath, loadWorkspace, observeArtifact, observationSummary, saveWorkspace, selectArtifacts, sourceRevision, updateFromRemote, workspaceArtifactSchema } from './workspace-state.js';
import { pushWorkspace } from './workspace-push.js';
import type { ScriptWorkspace, WorkspaceArtifactRef, WorkspaceDependencies, WorkspaceManifest, WorkspacePaths, WorkspacePrepareInput, WorkspaceRequest } from './workspace-types.js';

export function createScriptWorkspace(dependencies: WorkspaceDependencies): ScriptWorkspace {
  const target = workspaceTarget(dependencies.apiUrl);
  let active: WorkspacePaths | null = null;
  async function resolvePaths(projectRoot?: string) {
    const roots = await dependencies.roots?.() ?? [];
    const configured = projectRoot ?? active?.projectRoot ?? dependencies.projectRoot;
    if (!configured && roots.length !== 1) throw new Error('Provide projectRoot explicitly when the client has no unique project root.');
    const paths = workspacePaths(configured ?? roots[0], target);
    if (roots.length && !roots.some((root) => { const rel = relative(realpathSync(root), paths.projectRoot); return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/')); })) throw new Error('projectRoot is outside the roots provided by this MCP client.');
    return paths;
  }
  function summary(paths: WorkspacePaths) {
    return { projectRoot: paths.projectRoot, workspaceRoot: paths.workspaceRoot, tempRoot: paths.tempRoot, target: paths.target };
  }
  async function run<T>(input: WorkspaceRequest, operation: (paths: WorkspacePaths, manifest: WorkspaceManifest) => Promise<T>) {
    const paths = await resolvePaths(input.projectRoot);
    loadWorkspace(paths);
    ensureWorkspaceIgnored(paths);
    return withWorkspaceLock(paths, () => withSourceArtifactDirectory(paths.tempRoot, async () => {
      const result = await operation(paths, loadWorkspace(paths));
      active = paths;
      return result;
    }));
  }
  async function prepare(input: WorkspacePrepareInput) {
    const paths = await resolvePaths(input.projectRoot);
    const refs = (input.artifacts ?? []).map((item) => workspaceArtifactSchema.parse(item) as WorkspaceArtifactRef);
    if (refs.length > 100 || new Set(refs.map(artifactKey)).size !== refs.length) throw new Error('Prepare accepts at most 100 unique explicit artifact references.');
    for (const ref of refs) {
      if (ref.path) safeWorkspacePath(paths.workspaceRoot, artifactPath(ref, { source: '', sourceField: ref.tableName === 'enfyra_extension' ? 'code' : 'sourceCode', language: 'javascript' }));
    }
    const existing = readWorkspaceFile(paths.projectRoot, paths.manifestPath);
    if (existing) loadWorkspace(paths);
    const config = readWorkspaceFile(paths.projectRoot, 'enfyra/project.json');
    if (config && JSON.parse(config).target !== target) throw new Error('Workspace project target differs from this Enfyra connection.');
    const gitIgnored = ensureWorkspaceIgnored(paths);
    mkdirSync(paths.workspaceRoot, { recursive: true, mode: 0o700 });
    return withWorkspaceLock(paths, () => withSourceArtifactDirectory(paths.tempRoot, async () => {
      const current = readWorkspaceFile(paths.projectRoot, paths.manifestPath);
      const manifest: WorkspaceManifest = current ? loadWorkspace(paths) : { target, artifacts: [] };
      if (!current && input.artifacts === undefined) throw new Error('A new workspace requires explicit artifacts from discovery. Pass tableName and id, or artifacts=[] when creating new source; do not clone the whole instance.');
      const pending = [];
      for (const ref of refs) {
        const key = artifactKey(ref);
        const previous = manifest.artifacts.find((item) => item.key === key);
        if (previous) { if (ref.path && ref.path !== previous.path) throw new Error(`Artifact path is already mapped: ${key}`); continue; }
        const remote = await dependencies.read(ref);
        if (!remote) throw new Error(`Remote artifact was not found: ${key}`);
        const path = artifactPath(ref, remote);
        safeWorkspacePath(paths.workspaceRoot, path);
        if (manifest.artifacts.some((item) => item.path === path) || pending.some((item) => item.path === path)) throw new Error('Artifact paths must be unique.');
        const local = readWorkspaceFile(paths.workspaceRoot, path);
        if (local !== null && local !== remote.source) throw new Error(`Local file already exists without a matching baseline: ${path}`);
        pending.push({ ...ref, key, path, sourceField: remote.sourceField, language: remote.language, baseline: sourceRevision(remote), source: remote.source, local });
      }
      if (manifest.artifacts.length + pending.length > 500) throw new Error('A workspace supports at most 500 explicitly mapped artifacts. Use a narrower project scope.');
      for (const { source, local, ...artifact } of pending) {
        writeWorkspaceFile(paths.projectRoot, `enfyra/${artifact.path}`, source, local);
        manifest.artifacts.push(artifact);
      }
      saveWorkspace(paths, manifest);
      if (!config) writeWorkspaceFile(paths.projectRoot, 'enfyra/project.json', `${JSON.stringify({ target, sourceRoot: 'enfyra', state: '.state/sync.json', guidance: 'Use prepare/inspect/pull/push Enfyra workspace operations. Do not overwrite shared fragments in a separate source tree with these assembled live scripts.' }, null, 2)}\n`, null);
      const artifacts = [];
      for (const artifact of selectArtifacts(manifest, input.keys)) artifacts.push(observationSummary(await observeArtifact(paths, artifact, dependencies)));
      active = paths;
      return { action: 'enfyra_workspace_prepared', ...summary(paths), gitIgnored, artifacts, guidance: 'Edit localFile after checking status. Use push_enfyra_sources to preview and validate, then apply its planId. Pull never overwrites local edits or deletes sources.' };
    }));
  }
  return {
    prepare,
    artifactDirectory: () => active ? safeWorkspacePath(active.projectRoot, relative(active.projectRoot, active.tempRoot)) : null,
    inspect: (input) => run(input, async (paths, manifest) => {
      const artifacts = [];
      for (const artifact of selectArtifacts(manifest, input.keys)) artifacts.push(observationSummary(await observeArtifact(paths, artifact, dependencies)));
      return { action: 'enfyra_workspace_inspected', ...summary(paths), artifacts };
    }),
    pull: (input) => run(input, async (paths, manifest) => {
      const artifacts = [];
      for (const artifact of selectArtifacts(manifest, input.keys)) {
        const observation = await observeArtifact(paths, artifact, dependencies);
        if (['remote_changed', 'local_missing', 'aligned'].includes(observation.status)) { updateFromRemote(paths, observation); saveWorkspace(paths, manifest); }
        artifacts.push(observationSummary(await observeArtifact(paths, artifact, dependencies)));
      }
      return { action: 'enfyra_workspace_pulled', ...summary(paths), artifacts };
    }),
    push: (input) => run(input, (paths, manifest) => pushWorkspace(paths, manifest, dependencies, input)),
  };
}
