import { relative } from 'node:path';
import { z } from 'zod';
import { readWorkspaceFile, safeWorkspacePath, sourceHash, writeWorkspaceFile } from './workspace-files.js';
import { writeSourceArtifact } from './source-artifacts.js';
import type { WorkspaceArtifact, WorkspaceArtifactRef, WorkspaceDependencies, WorkspaceManifest, WorkspaceObservation, WorkspacePaths, WorkspaceRemoteSource, WorkspaceSourceStatus } from './workspace-types.js';

export const WORKSPACE_TABLES = ['enfyra_route_handler', 'enfyra_pre_hook', 'enfyra_post_hook', 'enfyra_flow_step', 'enfyra_websocket_event', 'enfyra_websocket', 'enfyra_oauth_config', 'enfyra_bootstrap_script', 'enfyra_extension'] as const;
export const workspaceArtifactSchema = z.object({ tableName: z.enum(WORKSPACE_TABLES), id: z.string().min(1).max(200), path: z.string().optional() }).strict();
const savedArtifactSchema = workspaceArtifactSchema.extend({ key: z.string(), path: z.string(), sourceField: z.string(), language: z.string(), baseline: z.string() });
const manifestSchema = z.object({ target: z.string(), artifacts: z.array(savedArtifactSchema).max(500) }).strict();

export function sourceRevision(remote: WorkspaceRemoteSource) {
  return sourceHash(JSON.stringify([remote.source, remote.sourceField, remote.language]));
}

export function artifactKey(ref: WorkspaceArtifactRef) {
  return `${ref.tableName}:${ref.id}`;
}

export function artifactPath(ref: WorkspaceArtifactRef, source: WorkspaceRemoteSource) {
  const kind = ref.tableName.replace(/^enfyra_/, '').replace(/_/g, '-');
  const id = ref.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
  const extension = source.sourceField === 'code' ? 'vue' : source.language === 'typescript' ? 'ts' : 'js';
  const path = ref.path ?? `${kind}/${id}-${sourceHash(ref.id).slice(0, 8)}.${extension}`;
  if (path.startsWith('.') || path === 'project.json' || path.split('/').some((part) => part.startsWith('.'))) throw new Error('Artifact path cannot use workspace configuration or state directories.');
  return path;
}

export function loadWorkspace(paths: WorkspacePaths): WorkspaceManifest {
  const raw = readWorkspaceFile(paths.projectRoot, paths.manifestPath);
  if (!raw) throw new Error('Workspace is not prepared. Call prepare_enfyra_workspace with projectRoot and exact artifact references.');
  const manifest = manifestSchema.parse(JSON.parse(raw)) as WorkspaceManifest;
  if (manifest.target !== paths.target) throw new Error('Workspace target differs from the connected Enfyra instance. Use a separate project workspace.');
  const keys = new Set<string>();
  const files = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (artifact.key !== artifactKey(artifact) || keys.has(artifact.key) || files.has(artifact.path)) throw new Error('Workspace manifest has invalid or duplicate artifact mappings.');
    artifactPath(artifact, { source: '', sourceField: artifact.sourceField, language: artifact.language });
    safeWorkspacePath(paths.workspaceRoot, artifact.path);
    keys.add(artifact.key);
    files.add(artifact.path);
  }
  return manifest;
}

export function saveWorkspace(paths: WorkspacePaths, manifest: WorkspaceManifest) {
  writeWorkspaceFile(paths.projectRoot, paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function selectArtifacts(manifest: WorkspaceManifest, keys?: string[]) {
  if (!keys) return manifest.artifacts;
  if (!keys.length || new Set(keys).size !== keys.length) throw new Error('Select a non-empty list of unique artifact keys.');
  return keys.map((key) => {
    const artifact = manifest.artifacts.find((item) => item.key === key);
    if (!artifact) throw new Error(`Artifact is not in this workspace: ${key}`);
    return artifact;
  });
}

export async function observeArtifact(paths: WorkspacePaths, artifact: WorkspaceArtifact, dependencies: WorkspaceDependencies): Promise<WorkspaceObservation> {
  const localFile = safeWorkspacePath(paths.workspaceRoot, artifact.path);
  const localSource = readWorkspaceFile(paths.workspaceRoot, artifact.path);
  const remote = await dependencies.read(artifact);
  const remoteRevision = remote ? sourceRevision(remote) : null;
  const localRevision = localSource === null ? null : sourceRevision({ source: localSource, sourceField: artifact.sourceField, language: artifact.language });
  let status: WorkspaceSourceStatus;
  if (!remote) status = 'remote_missing';
  else if (localSource === null) status = 'local_missing';
  else if (localRevision === remoteRevision) status = remoteRevision === artifact.baseline ? 'synced' : 'aligned';
  else if (localRevision === artifact.baseline) status = 'remote_changed';
  else if (remoteRevision === artifact.baseline) status = 'local_changed';
  else status = 'conflict';
  const remoteFile = remote ? writeSourceArtifact({ tableName: artifact.tableName, id: artifact.id, fieldName: remote.sourceField, source: remote.source }).tmpFile : null;
  return { artifact, localSource, remote, localRevision, remoteRevision, status, localFile, remoteFile };
}

export function observationSummary(observation: WorkspaceObservation) {
  return { key: observation.artifact.key, status: observation.status, language: observation.artifact.language, sourceField: observation.artifact.sourceField, localFile: observation.localFile, remoteFile: observation.remoteFile, localHash: observation.localRevision, remoteHash: observation.remoteRevision, baselineHash: observation.artifact.baseline };
}

export function updateFromRemote(paths: WorkspacePaths, observation: WorkspaceObservation) {
  if (!observation.remote) throw new Error('Cannot pull a deleted remote artifact.');
  writeWorkspaceFile(paths.projectRoot, relative(paths.projectRoot, observation.localFile), observation.remote.source, observation.localSource);
  Object.assign(observation.artifact, { baseline: observation.remoteRevision!, language: observation.remote.language, sourceField: observation.remote.sourceField });
}
