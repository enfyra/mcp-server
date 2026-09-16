export interface WorkspaceArtifactRef {
  tableName: string;
  id: string;
  path?: string;
}

export interface WorkspaceRemoteSource {
  source: string;
  sourceField: string;
  language: string;
}

export interface WorkspaceArtifact extends WorkspaceArtifactRef {
  key: string;
  path: string;
  sourceField: string;
  language: string;
  baseline: string;
}

export interface WorkspaceManifest {
  target: string;
  artifacts: WorkspaceArtifact[];
}

export interface WorkspaceRequest {
  projectRoot?: string;
  keys?: string[];
}

export interface WorkspacePrepareInput extends WorkspaceRequest {
  artifacts?: WorkspaceArtifactRef[];
}

export interface WorkspacePushInput extends WorkspaceRequest {
  apply?: boolean;
  planId?: string;
}

export interface WorkspaceDependencies {
  apiUrl: string;
  projectRoot?: string;
  roots?: () => Promise<string[]>;
  read: (artifact: WorkspaceArtifactRef) => Promise<WorkspaceRemoteSource | null>;
  validate: (artifact: WorkspaceArtifact, source: string) => Promise<unknown>;
  write: (artifact: WorkspaceArtifact, source: string, expectedSourceHash: string, sourceFile: string) => Promise<unknown>;
}

export interface WorkspacePaths {
  projectRoot: string;
  workspaceRoot: string;
  tempRoot: string;
  target: string;
  manifestPath: string;
  planPath: string;
}

export type WorkspaceSourceStatus = 'synced' | 'aligned' | 'local_changed' | 'remote_changed' | 'conflict' | 'local_missing' | 'remote_missing';

export interface WorkspaceObservation {
  artifact: WorkspaceArtifact;
  localSource: string | null;
  remote: WorkspaceRemoteSource | null;
  localRevision: string | null;
  remoteRevision: string | null;
  status: WorkspaceSourceStatus;
  localFile: string;
  remoteFile: string | null;
}

export interface WorkspacePushPlan {
  id: string;
  target: string;
  projectRoot: string;
  consumed: boolean;
  items: Array<{ key: string; localRevision: string; remoteRevision: string; sourceHash: string }>;
  signature: string;
}

export interface WorkspaceOperationResult {
  action: string;
  complete?: boolean;
  [key: string]: unknown;
}

export interface ScriptWorkspace {
  prepare(input: WorkspacePrepareInput): Promise<WorkspaceOperationResult>;
  inspect(input: WorkspaceRequest): Promise<WorkspaceOperationResult>;
  pull(input: WorkspaceRequest): Promise<WorkspaceOperationResult>;
  push(input: WorkspacePushInput): Promise<WorkspaceOperationResult>;
  artifactDirectory(): string | null;
}
