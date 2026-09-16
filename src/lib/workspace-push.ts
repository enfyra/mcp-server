import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { writeSourceArtifact } from './source-artifacts.js';
import { sourceHash, readWorkspaceFile, writeWorkspaceFile } from './workspace-files.js';
import { observeArtifact, observationSummary, saveWorkspace, selectArtifacts } from './workspace-state.js';
import type { WorkspaceDependencies, WorkspaceManifest, WorkspaceObservation, WorkspacePaths, WorkspacePushInput, WorkspacePushPlan } from './workspace-types.js';

const planSchema = z.object({ id: z.string().uuid(), target: z.string(), projectRoot: z.string(), consumed: z.boolean(), items: z.array(z.object({ key: z.string(), localRevision: z.string(), remoteRevision: z.string(), sourceHash: z.string() }).strict()).max(500), signature: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const planSigningKey = randomBytes(32);

function planPayload(plan: Omit<WorkspacePushPlan, 'signature'> | WorkspacePushPlan) {
  return JSON.stringify({ id: plan.id, target: plan.target, projectRoot: plan.projectRoot, consumed: plan.consumed, items: plan.items });
}

function signPlan(plan: Omit<WorkspacePushPlan, 'signature'> | WorkspacePushPlan) {
  return createHmac('sha256', planSigningKey).update(planPayload(plan)).digest('hex');
}

function isAuthenticPlan(plan: WorkspacePushPlan) {
  const expected = Buffer.from(signPlan(plan), 'hex');
  const actual = Buffer.from(plan.signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function savePlan(paths: WorkspacePaths, plan: WorkspacePushPlan) {
  plan.signature = signPlan(plan);
  writeWorkspaceFile(paths.projectRoot, paths.planPath, `${JSON.stringify(plan, null, 2)}\n`);
}

function diffArtifact(observation: WorkspaceObservation) {
  const remote = (observation.remote?.source ?? '').split('\n');
  const local = (observation.localSource ?? '').split('\n');
  const diff = [`--- live/${observation.artifact.path}`, `+++ local/${observation.artifact.path}`, `@@ -1,${remote.length} +1,${local.length} @@`, ...remote.map((line) => `-${line}`), ...local.map((line) => `+${line}`)].join('\n');
  return writeSourceArtifact({ tableName: observation.artifact.tableName, id: observation.artifact.id, fieldName: 'diff', source: diff });
}

export async function pushWorkspace(paths: WorkspacePaths, manifest: WorkspaceManifest, dependencies: WorkspaceDependencies, input: WorkspacePushInput) {
  if (!input.apply) {
    if (input.planId) throw new Error('planId is only accepted when apply=true.');
    const observations: WorkspaceObservation[] = [];
    for (const artifact of selectArtifacts(manifest, input.keys)) observations.push(await observeArtifact(paths, artifact, dependencies));
    const blocked = observations.filter((item) => !['synced', 'local_changed'].includes(item.status));
    if (blocked.length) return { action: 'enfyra_workspace_push_blocked', complete: false, artifacts: observations.map(observationSummary), guidance: 'Pull remote-only or aligned changes first; resolve conflicts without overwriting local edits.' };
    const changes = observations.filter((item) => item.status === 'local_changed');
    const artifacts = [];
    for (const change of changes) {
      const sourceArtifact = writeSourceArtifact({ tableName: change.artifact.tableName, id: change.artifact.id, fieldName: change.artifact.sourceField, source: change.localSource! });
      await dependencies.validate(change.artifact, change.localSource!);
      artifacts.push({ ...observationSummary(change), sourceFile: sourceArtifact.tmpFile, diff: diffArtifact(change) });
    }
    const plan: WorkspacePushPlan = { id: randomUUID(), target: paths.target, projectRoot: paths.projectRoot, consumed: false, items: changes.map((item) => ({ key: item.artifact.key, localRevision: item.localRevision!, remoteRevision: item.remoteRevision!, sourceHash: sourceHash(item.localSource!) })), signature: '' };
    savePlan(paths, plan);
    return { action: 'enfyra_workspace_push_previewed', complete: changes.length === 0, planId: plan.id, artifacts, protection: 'optimistic-source-check', guidance: 'Review the diffs, then call push_enfyra_sources with apply=true and this planId. External writers are not locked; each write rechecks and verifies the live source.' };
  }

  if (!input.planId) throw new Error('A reviewed planId is required when apply=true.');
  if (input.keys) throw new Error('Apply uses the reviewed plan scope; omit keys.');
  const raw = readWorkspaceFile(paths.projectRoot, paths.planPath);
  let plan: WorkspacePushPlan | null = null;
  try {
    plan = raw ? planSchema.parse(JSON.parse(raw)) as WorkspacePushPlan : null;
  } catch {
    throw new Error('Push plan is invalid or stale. Preview again.');
  }
  if (plan && !isAuthenticPlan(plan)) throw new Error('Push plan authenticity check failed. Preview again.');
  if (!plan || plan.id !== input.planId || plan.consumed || plan.target !== paths.target || plan.projectRoot !== paths.projectRoot) throw new Error('Push plan is missing, consumed, stale or belongs to another target. Preview again.');
  const changes: WorkspaceObservation[] = [];
  for (const item of plan.items) {
    const artifact = selectArtifacts(manifest, [item.key])[0];
    const observation = await observeArtifact(paths, artifact, dependencies);
    if (observation.status !== 'local_changed' || observation.localRevision !== item.localRevision || observation.remoteRevision !== item.remoteRevision || sourceHash(observation.localSource!) !== item.sourceHash) throw new Error(`Source changed after preview: ${item.key}. Inspect and preview again.`);
    await dependencies.validate(artifact, observation.localSource!);
    changes.push(observation);
  }
  plan.consumed = true;
  savePlan(paths, plan);
  const results: Array<Record<string, unknown>> = [];
  for (const change of changes) {
    try {
      const current = await observeArtifact(paths, change.artifact, dependencies);
      if (current.localRevision !== change.localRevision || current.remoteRevision !== change.remoteRevision) throw new Error('Source changed before write; preview again.');
      const source = current.localSource!;
      const staged = writeSourceArtifact({ tableName: current.artifact.tableName, id: current.artifact.id, fieldName: current.artifact.sourceField, source });
      await dependencies.write(current.artifact, source, sourceHash(current.remote!.source), staged.tmpFile);
      const saved = await observeArtifact(paths, current.artifact, dependencies);
      if (saved.remoteRevision !== current.localRevision) throw new Error('Saved source does not match the reviewed source. Inspect live state before retrying.');
      current.artifact.baseline = saved.remoteRevision!;
      saveWorkspace(paths, manifest);
      results.push({ key: current.artifact.key, status: 'pushed', sourceSha256: sourceHash(source), verified: true, localChangedDuringPush: saved.localRevision !== current.localRevision });
    } catch (error) {
      results.push({ key: change.artifact.key, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      return { action: 'enfyra_workspace_push_incomplete', complete: false, artifacts: results, remainingKeys: changes.slice(results.length).map((item) => item.artifact.key), guidance: 'Some writes may have completed. Inspect live state and create a fresh preview before retrying.' };
    }
  }
  return { action: 'enfyra_workspace_pushed', complete: true, artifacts: results };
}
