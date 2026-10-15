/** @file Internal host-authorized record preparation. Uses the existing project
 * lock, trust planner, reserved-ID staging and authenticated observer. Never
 * approves or applies. SDK request/options capture belongs to the facade.
 *
 * ONE BODY. {@link prepareRecordEffectWith} owns the sequence (capture before any
 * wait, the authority and lock body, reuse of an existing effect only through a
 * verified run, profile/lifecycle/preimage/planner validation, reservation,
 * staging) over `RecordEffectSteps` (`record-effect-steps.ts`), none of which
 * takes a project root. {@link prepareRecordEffect} keeps its signature and
 * passes the disk steps. */
import type { LifecycleDef } from "../profile/types.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { withRecordPreparationLockWith } from "./record-authority.js";
import { digestBytes } from "./adapters/shared.js";
import { compileRecordDraft, recordEffectKeyBytes, recordPageMutation } from "./record-draft.js";
import { diskRecordEffectSteps, type RecordEffectSteps } from "./record-effect-steps.js";
import { captureRecordIntent, recordIntentDigest, type RecordIntentV1 } from "./record-intent.js";
import { operationManifestDigest } from "./manifest-parse.js";
import type { OperationPrincipal } from "./principal.js";
import type { OperationBundleManifest, OperationDigest, PageOperationMutation } from "./types.js";

/** Exact prepared identity; neither this reference nor caller origin conveys approval. */
export type PreparedEffectRefV1 = { workspaceId: string; effectId: string; intentDigest: OperationDigest;
  bundleId: string; operationRunId: string; manifestDigest: OperationDigest };

/** Locate a previously materialized effect even if its allocation index disappeared. */
async function existingEffect(steps: RecordEffectSteps, principal: OperationPrincipal, intent: RecordIntentV1) {
  const inventory = await steps.scanInventory();
  if (inventory.problems.length) throw new Error("record-preparation-unavailable");
  const keyDigest = digestBytes(recordEffectKeyBytes(intent, principal.id));
  const matching = inventory.manifests.filter(manifest => manifest.workspaceId === intent.workspaceId &&
    manifest.createdBy === principal.id && manifest.preparationEvidence.some(item => item.type === "record-effect-key-v1" && item.digest === keyDigest));
  if (matching.length > 1) throw new Error("record-preparation-unavailable");
  const existing = matching[0];
  if (existing && !existing.preparationEvidence.some(item => item.type === "record-intent-v1" && item.digest === digestBytes(canonicalBytes(intent)))) {
    throw new Error("effect-intent-conflict");
  }
  return existing;
}

/** Reuse requires a verified run, not just a manifest left by interrupted staging. */
async function preparedReference(steps: RecordEffectSteps, intent: RecordIntentV1, manifest: OperationBundleManifest): Promise<PreparedEffectRefV1> {
  const manifestDigest = operationManifestDigest(manifest) as OperationDigest;
  const observation = await steps.observe(manifestDigest);
  if (observation.status !== "observed") throw new Error("record-preparation-unavailable");
  return { workspaceId: intent.workspaceId, effectId: intent.effectId, intentDigest: recordIntentDigest(intent),
    bundleId: manifest.bundleId, operationRunId: manifest.runId, manifestDigest };
}

/** Validate current domain state; preparation cannot publish or bypass profile checks. */
async function validateRecord(steps: RecordEffectSteps, intent: RecordIntentV1): Promise<string> {
  const loaded = await steps.loadProfile();
  if (!loaded || `sha256:${loaded.digest}` !== intent.profileDigest) throw new Error("record-profile-drift");
  const entity = loaded.profile.entities[intent.target.entityType];
  if (!entity) throw new Error("record-target-invalid");
  if (entity.lifecycle) await validateInitialLifecycle(steps, intent, entity.lifecycle);
  await validatePreimage(steps, intent);
  const plan = await steps.planPage({ target: { kind: "entity", ...intent.target }, body: intent.proposedBody,
    origin: "operation", reviewRouted: false, allowOverwrite: intent.precondition.kind === "digest" });
  if (!["allow", "allow-with-warning"].includes(plan.decision) || plan.planned.length !== 1) throw new Error("record-target-refused");
  return loaded.profile.profileId;
}

/** Compare the exact declared preimage without treating unreadable bytes as absence. */
async function validatePreimage(steps: RecordEffectSteps, intent: RecordIntentV1): Promise<void> {
  const mutation = recordPageMutation(intent) as PageOperationMutation;
  const current = await steps.readPageDigest(mutation);
  if (current.kind === "unavailable") throw new Error("record-preimage-unavailable");
  if (intent.precondition.kind === "absent" ? current.kind !== "absent"
    : current.kind !== "ok" || current.digest !== intent.precondition.digest) throw new Error("record-preimage-drift");
}

/** The primitive edits initial-state records only; it cannot publish or reset a lifecycle. */
async function validateInitialLifecycle(steps: RecordEffectSteps, intent: RecordIntentV1, lifecycle: LifecycleDef): Promise<void> {
  if (parseFrontmatter(intent.proposedBody).meta[lifecycle.field] !== lifecycle.initial) {
    throw new Error("record-lifecycle-transition-unsupported");
  }
  if (intent.precondition.kind === "absent") return;
  const read = await steps.readEntityLeaf(intent.target.entityType, intent.target.slug);
  if (read.kind !== "ok" || digestBytes(read.body) !== intent.precondition.digest) throw new Error("record-preimage-drift");
  if (parseFrontmatter(read.body.toString("utf8")).meta[lifecycle.field] !== lifecycle.initial) {
    throw new Error("record-lifecycle-transition-unsupported");
  }
}

/** Capture before IO, require explicit prepare authority, and serialize with operator apply. */
export async function prepareRecordEffect(root: string, principal: OperationPrincipal, input: unknown): Promise<PreparedEffectRefV1> {
  return prepareRecordEffectWith(diskRecordEffectSteps(root), principal, input);
}

/** {@link prepareRecordEffect} over `RecordEffectSteps`: THE ONE BODY. The intent is captured before the first await. */
export async function prepareRecordEffectWith(steps: RecordEffectSteps, principal: OperationPrincipal, input: unknown): Promise<PreparedEffectRefV1> {
  const intent = captureRecordIntent(input);
  return withRecordPreparationLockWith(steps.lock, principal, async actor => {
    const existing = await existingEffect(steps, actor, intent);
    if (existing) return await preparedReference(steps, intent, existing);
    const profileId = await validateRecord(steps, intent);
    const reservation = await steps.reserve(actor.id, intent);
    const compiled = compileRecordDraft(intent, actor, profileId);
    const staged = await steps.stage({ ...compiled,
      reservedIds: { bundleId: reservation.bundleId, runId: reservation.runId }, clock: { now: () => new Date(reservation.createdAt) } });
    return await preparedReference(steps, intent, staged.manifest);
  });
}
