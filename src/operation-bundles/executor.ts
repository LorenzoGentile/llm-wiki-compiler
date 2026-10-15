/**
 * @file src/operation-bundles/executor.ts
 * @description The durable operation-bundle executor. It approves under recomputed
 * authority, revalidates before the first effect, then drives the manifest-order
 * mutation protocol (durable started -> revalidate -> preflight -> observe ->
 * skip-or-apply -> verify -> evidence -> durable outcome), runs projections only
 * after every authoritative mutation verifies, and settles to a terminal state.
 * Every persisted transition routes through the Foundation writer
 * appendOperationTransitionLocked; this module computes the next step only. A
 * conflict, unavailable read, or authority drift parks the run at
 * recovery-required and never fabricates false success.
 *
 * ONE BODY. {@link approveAndApplyOperationBundleWith} owns the whole
 * application ladder over the session's `OperationRunStores` (`run-session.ts`):
 * every transition, evidence blob, cancellation-advisory read and removal and
 * pending-embedding marker read and write goes through them, none taking a
 * project root. {@link approveAndApplyOperationBundleLocked} keeps its signature
 * and passes the disk stores, which call the incumbent root forms when asked.
 * The injected runtime (authority provider, adapters, clock, faults) is the
 * host's; it still receives `session.root` as its compatibility handle.
 */

import { requireOperationAdapter, type OperationRuntime } from "./adapter-registry.js";
import type { AdapterContext } from "./adapter-types.js";
import { operationAuditBinding } from "./audit-binding.js";
import { currentApplyOwner } from "./apply-owner.js";
import type { AuthoritySnapshotRequest, OperationAuthoritySnapshot } from "./authority.js";
import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import type { OperationProblemCode } from "./problems.js";
import { mergeFreshAttempts } from "../utils/pending-embeddings.js";
import type { OperationEvidenceReference, OperationRun } from "./run-types.js";
import {
  appendRunStep, diskOperationRunStores, loadApprovedActionWith, runResult,
  type ApproveOperationBundleRequest, type OperationActionResult, type OperationRunStores, type RunSession,
} from "./run-session.js";
import type { EffectOutcomeStatus, OperationTransitionStep } from "./transitions.js";
import type { OperationDigest, OperationMutation, ProjectionOperationMutation } from "./types.js";

export type { ApproveOperationBundleRequest, OperationActionResult } from "./run-session.js";

/** One settlement step's resulting run and whether it parked at recovery-required. */
interface StepResult { run: OperationRun; parked: boolean }

/** The adapter-capability identity folded into the recomputed authority snapshot. */
function adapterCapabilityDigest(runtime: OperationRuntime): OperationDigest {
  return canonicalDigest([...runtime.adapters.keys()].sort()) as OperationDigest;
}

/** Recompute the exact authority snapshot for this bundle under the current lock. */
export async function computeAuthoritySnapshot(session: RunSession): Promise<{ status: "ok"; snapshot: OperationAuthoritySnapshot; digest: OperationDigest } | { status: "unavailable"; reason: string }> {
  const request: AuthoritySnapshotRequest = {
    root: session.root, workspaceId: session.manifest.workspaceId, manifest: session.manifest,
    manifestDigest: session.binding.manifestDigest, principal: session.request.principal,
    adapterCapabilityDigest: adapterCapabilityDigest(session.request.runtime), keyEpochId: session.binding.keyEpochId,
  };
  return session.request.runtime.authority.computeSnapshot(request);
}

/** Assemble the adapter context for one mutation under the apply-time snapshot. */
export function buildAdapterContext(session: RunSession, snapshot: OperationAuthoritySnapshot, mutation: OperationMutation): AdapterContext {
  return {
    root: session.root, workspaceId: session.manifest.workspaceId, manifest: session.manifest, mutation,
    authority: snapshot, auditBinding: operationAuditBinding(session.binding, mutation.mutationId),
    clock: session.request.runtime.clock, fault: session.request.runtime.fault,
  };
}

/**
 * Persist the bounded evidence every terminal outcome transition must name.
 * When an adapter produced apply bytes they are captured; otherwise a small
 * canonical outcome descriptor is written. Recovery re-observes the authoritative
 * target, so this is an audit trail, not the source of truth.
 */
async function outcomeEvidence(session: RunSession, mutation: OperationMutation, status: EffectOutcomeStatus, adapterEvidence?: Buffer): Promise<OperationEvidenceReference> {
  await session.request.runtime.fault?.beforeEvidenceWrite?.(mutation.mutationId);
  const bytes = adapterEvidence ?? canonicalBytes({ mutationId: mutation.mutationId, kind: mutation.kind, status });
  return session.stores.writeEvidence({
    workspaceId: session.manifest.workspaceId, runId: session.binding.runId, type: mutation.kind, provenance: "apply",
  }, Buffer.from(bytes));
}

/** Record the failed outcome (with evidence) then park at recovery-required. */
async function park(session: RunSession, run: OperationRun, mutation: OperationMutation, code: OperationProblemCode): Promise<StepResult> {
  const evidence = await outcomeEvidence(session, mutation, "failed");
  const failed: OperationTransitionStep = mutation.kind === "projection"
    ? { kind: "projection-outcome", mutationId: mutation.mutationId, criticality: (mutation as ProjectionOperationMutation).target.criticality, status: "failed", evidence }
    : { kind: "mutation-outcome", mutationId: mutation.mutationId, status: "failed", evidence };
  run = await appendRunStep(session, run, failed);
  run = await appendRunStep(session, run, { kind: "recovery-required", code });
  return { run, parked: true };
}

/**
 * The qualified page id a page mutation targets — entity pages as
 * `<entityType>/<slug>`, raw pages as `<directory>/<slug>` — the same id the
 * embedding store keys on. Null for every other mutation kind.
 */
function pageIdOf(mutation: OperationMutation): string | null {
  if (mutation.kind !== "page") return null;
  return mutation.target.kind === "entity"
    ? `${mutation.target.entityType}/${mutation.target.slug}` : `${mutation.target.directory}/${mutation.target.slug}`;
}

/**
 * Durably enqueue one page mutation's id for embedding: the pending marker is the
 * write-ahead record `compile` drains, so a page a bundle created or updated is
 * never silently absent from retrieval, and a deleted page (a TOMBSTONE the drain
 * prunes) never lingers in the store. It runs at BOTH seams a page effect can
 * land through — BEFORE the store seam is even invoked (so nothing that happens
 * after the commit can lose it) and when an outcome is recorded (recovery's
 * observe path) — and the merge is idempotent. Runs under the project lock the
 * apply holds.
 */
async function enqueuePageForEmbedding(session: RunSession, mutation: OperationMutation): Promise<boolean> {
  const pageId = pageIdOf(mutation);
  if (pageId === null) return true;
  // STRICT read: an existing marker that cannot be read (or parsed) is NOT an
  // empty one — merging over it would replace every older pending refresh with
  // this single entry. Only an absent or readable marker is merged into.
  const existing = await session.stores.readPendingMarker();
  if (existing.status === "unavailable") return false;
  try {
    await session.stores.writePendingMarker(mergeFreshAttempts(existing.entries, [pageId]));
    return true;
  } catch {
    return false;
  }
}

/** Record a completed authoritative outcome (applied or skipped) with evidence. */
async function recordAuthoritativeOutcome(session: RunSession, run: OperationRun, mutation: OperationMutation, status: EffectOutcomeStatus, adapterEvidence?: Buffer, detail?: string): Promise<StepResult> {
  if ((status === "applied" || status === "skipped-idempotent") && !(await enqueuePageForEmbedding(session, mutation))) {
    return park(session, run, mutation, "bundle-recovery-required");
  }
  const evidence = await outcomeEvidence(session, mutation, status, adapterEvidence);
  run = await appendRunStep(session, run, { kind: "mutation-outcome", mutationId: mutation.mutationId, status, evidence, ...(detail === undefined ? {} : { detail }) });
  return { run, parked: false };
}

/** The current terminal/started status of one mutation identity, if any. */
function currentMutationOutcome(run: OperationRun, mutationId: OperationMutation["mutationId"]): "started" | "applied" | "skipped-idempotent" | "failed" | undefined {
  return run.mutationOutcomes.find((outcome) => outcome.mutationId === mutationId)?.status;
}

/**
 * Settle one authoritative mutation from its current on-disk state: preflight,
 * observe, then skip an exact post-state or apply an exact pre-state, verify, and
 * record the durable outcome. Reused by forward apply (after a durable started,
 * `recovering=false`) and by crash recovery (a started-without-outcome mutation
 * re-observed, `recovering=true`). Recovering a started mutation whose effect
 * already landed records `applied` (INV-22: the effect is this run's, so it stays
 * in the compensation applied-set); a fresh forward skip of a pre-existing
 * post-state records `skipped-idempotent`.
 */
async function settleAuthoritativeMutation(session: RunSession, snapshot: OperationAuthoritySnapshot, run: OperationRun, mutation: OperationMutation, recovering: boolean): Promise<StepResult> {
  const adapter = requireOperationAdapter(session.request.runtime.adapters, mutation.kind);
  const ctx = buildAdapterContext(session, snapshot, mutation);
  await session.request.runtime.fault?.beforePreflight?.(mutation.mutationId);
  const preflight = await adapter.preflight(ctx);
  if (preflight.status !== "ready") return park(session, run, mutation, preflight.status === "park" ? preflight.code : "bundle-recovery-required");
  await session.request.runtime.fault?.beforeObserve?.(mutation.mutationId);
  return settleFromObservation(session, run, adapter, ctx, mutation, recovering);
}

/** Dispatch the observed state: skip an exact post-state, park a conflict, or apply. */
async function settleFromObservation(session: RunSession, run: OperationRun, adapter: ReturnType<typeof requireOperationAdapter>, ctx: AdapterContext, mutation: OperationMutation, recovering: boolean): Promise<StepResult> {
  const observation = await adapter.observe(ctx);
  if (observation.outcome === "conflict") return park(session, run, mutation, "bundle-precondition-conflict");
  if (observation.outcome === "unavailable") return park(session, run, mutation, "bundle-recovery-required");
  if (observation.outcome === "applied") return recordAuthoritativeOutcome(session, run, mutation, recovering && observation.boundToMutation === true ? "applied" : "skipped-idempotent", undefined, observation.detail);
  return applyMutationEffect(session, run, adapter, ctx, mutation, recovering);
}

/** Apply one not-yet-started authoritative mutation (durable started, then settle). */
async function applyOneMutation(session: RunSession, snapshot: OperationAuthoritySnapshot, run: OperationRun, mutation: OperationMutation): Promise<StepResult> {
  run = await appendRunStep(session, run, { kind: "mutation-started", mutationId: mutation.mutationId });
  return settleAuthoritativeMutation(session, snapshot, run, mutation, false);
}

/** Invoke the store seam for a not-applied or partially-applied mutation, then finalize. */
async function applyMutationEffect(session: RunSession, run: OperationRun, adapter: ReturnType<typeof requireOperationAdapter>, ctx: AdapterContext, mutation: OperationMutation, recovering: boolean): Promise<StepResult> {
  // WRITE-AHEAD: the marker entry lands BEFORE the page effect, so no crash, park,
  // or failed verify after the store seam commits can leave a landed write or
  // delete without its embedding record. An effect that never commits leaves a
  // harmless entry the drain settles (unchanged page re-embedded, or absent). If
  // the marker cannot be persisted the effect is NOT attempted: the run parks.
  if (!(await enqueuePageForEmbedding(session, mutation))) return park(session, run, mutation, "bundle-recovery-required");
  await session.request.runtime.fault?.beforeApply?.(mutation.mutationId);
  const applied = await adapter.apply(ctx);
  await session.request.runtime.fault?.afterApply?.(mutation.mutationId);
  return settleAppliedStatus(session, run, adapter, ctx, mutation, recovering, applied);
}

/** Route the store seam's apply status: park on conflict/outage, record a skip, or verify a fresh apply. */
async function settleAppliedStatus(
  session: RunSession, run: OperationRun, adapter: ReturnType<typeof requireOperationAdapter>, ctx: AdapterContext,
  mutation: OperationMutation, recovering: boolean, applied: Awaited<ReturnType<typeof adapter.apply>>,
): Promise<StepResult> {
  if (applied.status === "conflict") return park(session, run, mutation, "bundle-precondition-conflict");
  if (applied.status === "unavailable") return park(session, run, mutation, "bundle-recovery-required");
  // Recovering a started mutation whose authority record is bound to THIS mutation
  // records applied; a present-but-unbound (pre-existing) target stays a skip so it
  // never enters the compensation applied-set.
  if (applied.status === "skipped-idempotent") return recordAuthoritativeOutcome(session, run, mutation, recovering && applied.boundToMutation ? "applied" : "skipped-idempotent", undefined, applied.detail);
  return verifyAndRecordApplied(
    session, run, adapter, ctx, mutation,
    applied.status === "applied-absent" ? undefined : applied.evidence);
}

/** Verify the postcondition after a fresh apply and record the applied outcome. */
async function verifyAndRecordApplied(session: RunSession, run: OperationRun, adapter: ReturnType<typeof requireOperationAdapter>, ctx: AdapterContext, mutation: OperationMutation, evidence?: Buffer): Promise<StepResult> {
  await session.request.runtime.fault?.beforeVerify?.(mutation.mutationId);
  const verified = await adapter.verify(ctx);
  // BOTH verified shapes are success. `verified-absent` is a delete's proof that
  // the target is gone; treating it as a mismatch would park every successful
  // delete, and treating an unavailable read as either would claim a proof the
  // adapter never gave.
  if (verified.status !== "verified" && verified.status !== "verified-absent") {
    return park(session, run, mutation, verified.status === "unavailable" ? "bundle-recovery-required" : "bundle-precondition-conflict");
  }
  return recordAuthoritativeOutcome(session, run, mutation, "applied", evidence);
}

/**
 * Drive every authoritative mutation in manifest order, resumable from a crash: an
 * already-settled mutation is skipped, a started-without-outcome mutation is
 * re-observed and settled, and a not-yet-started mutation is applied fresh. A
 * terminally-failed mutation, or any conflict/unavailable, parks the run. The
 * cancel-safe poll runs between mutations.
 */
/**
 * Poll the cancellation advisory between mutations. When present (pending or
 * unreadable), park at recovery-required — mid-apply can never go straight to
 * cancelled — and remove the non-authoritative advisory (deliver-once, so a resume
 * does not re-read a stale request). Returns the parked run, or null when absent.
 */
async function pollCancellation(session: RunSession, run: OperationRun): Promise<OperationRun | null> {
  const cancel = await session.stores.readCancel(session.manifest.workspaceId, session.binding.runId);
  if (cancel.status === "absent") return null;
  const parked = await appendRunStep(session, run, { kind: "recovery-required", code: "bundle-recovery-required" });
  await session.stores.removeCancel(session.manifest.workspaceId, session.binding.runId);
  return parked;
}

/** Fire the cancel-safe fault seam, then poll the advisory — shared by both phases. */
async function cancelSafePoll(session: RunSession, run: OperationRun, mutationId: OperationMutation["mutationId"]): Promise<OperationRun | null> {
  await session.request.runtime.fault?.atCancelSafePoint?.(mutationId);
  return pollCancellation(session, run);
}

/**
 * Handle a cancellation observed BEFORE the first apply. A readable pending request
 * settles the run to terminal `cancelled` with no effects and removes the consumed
 * advisory (deliver-once). An UNREADABLE advisory (forged/oversize/symlinked, or a
 * transient read fault) is never trusted to cancel and never applied over, but it
 * must not burn a durable transition on the unapproved run: a null-authority
 * `recovery-required` park is both unresumable AND blocks the lock gate workspace-
 * wide. Nor may it be left in place — an inventory-scan problem on a planted symlink
 * would wedge the lock gate all the same, a cheap DoS via the lock-free, attacker-
 * plantable `.cancel` path. So the untrusted advisory is REMOVED and a TRANSIENT
 * refusal is returned (park-vs-deny: "couldn't read" on a pre-effect run is a
 * transient deny, not a durable park): the run stays `awaiting-approval` and a retry
 * proceeds. This does not weaken deliver-once — a deliverable cancel is always a
 * readable canonical file (the present branch); an unreadable advisory never
 * delivered a cancel, and no effects are applied on this pass. Returns the
 * settled/refusal result, or null when no advisory is present and apply may proceed.
 */
async function settlePreApplyCancellation(session: RunSession, run: OperationRun): Promise<OperationActionResult | null> {
  const cancel = await session.stores.readCancel(session.manifest.workspaceId, session.binding.runId);
  if (cancel.status === "absent") return null;
  if (cancel.status !== "present") {
    await session.stores.removeCancel(session.manifest.workspaceId, session.binding.runId);
    return runResult(run, "review-store-unavailable");
  }
  const cancelled = await appendRunStep(session, run, { kind: "cancelled" });
  await session.stores.removeCancel(session.manifest.workspaceId, session.binding.runId);
  return runResult(cancelled);
}

/** Advance one authoritative mutation from its current outcome (null = already settled). */
async function advanceAuthoritative(session: RunSession, snapshot: OperationAuthoritySnapshot, run: OperationRun, mutation: OperationMutation): Promise<StepResult | null> {
  const outcome = currentMutationOutcome(run, mutation.mutationId);
  if (outcome === "applied" || outcome === "skipped-idempotent") return null;
  if (outcome === "failed") {
    // Complete a park whose recovery-required write was lost to a crash (no wedge).
    return { run: await appendRunStep(session, run, { kind: "recovery-required", code: "bundle-recovery-required" }), parked: true };
  }
  return outcome === "started"
    ? settleAuthoritativeMutation(session, snapshot, run, mutation, true)
    : applyOneMutation(session, snapshot, run, mutation);
}

async function applyAuthoritativeMutations(session: RunSession, snapshot: OperationAuthoritySnapshot, run: OperationRun): Promise<StepResult> {
  for (const mutation of session.manifest.mutations) {
    if (mutation.kind === "projection") continue;
    const cancelled = await cancelSafePoll(session, run, mutation.mutationId);
    if (cancelled !== null) return { run: cancelled, parked: true };
    const advanced = await advanceAuthoritative(session, snapshot, run, mutation);
    if (advanced === null) continue;
    run = advanced.run;
    if (advanced.parked) return { run, parked: true };
  }
  return { run, parked: false };
}

/** Settle the authoritative mutations, then projections, then the terminal state. */
export async function settleToTerminal(session: RunSession, snapshot: OperationAuthoritySnapshot, run: OperationRun): Promise<OperationActionResult> {
  const authoritative = await applyAuthoritativeMutations(session, snapshot, run);
  if (authoritative.parked) return runResult(authoritative.run, "bundle-recovery-required");
  const projected = await applyProjections(session, snapshot, authoritative.run);
  if (projected.parked) return runResult(projected.run, "bundle-recovery-required");
  return runResult(await finish(session, projected.run));
}

/** The current terminal/started status of one projection identity, if any. */
function currentProjectionOutcome(run: OperationRun, mutationId: OperationMutation["mutationId"]): "started" | "applied" | "skipped-idempotent" | "failed" | undefined {
  return run.projectionOutcomes.find((outcome) => outcome.mutationId === mutationId)?.status;
}

/** The fixed warning code marking one incomplete optional projection. */
const OPTIONAL_PROJECTION_WARNING = "projection-optional-incomplete";

/** Count failed optional projections vs. their incompleteness warnings so far. */
function optionalWarningDeficit(run: OperationRun): number {
  const failedOptional = run.projectionOutcomes.filter((outcome) => outcome.status === "failed" && outcome.criticality === "optional").length;
  const warnings = run.completionWarnings.filter((warning) => warning.code === OPTIONAL_PROJECTION_WARNING).length;
  return failedOptional - warnings;
}

/** Settle one projection from its current state; required failure parks, optional warns. */
async function settleProjection(session: RunSession, snapshot: OperationAuthoritySnapshot, run: OperationRun, mutation: ProjectionOperationMutation): Promise<StepResult> {
  const adapter = requireOperationAdapter(session.request.runtime.adapters, "projection");
  const ctx = buildAdapterContext(session, snapshot, mutation);
  const criticality = mutation.target.criticality;
  await session.request.runtime.fault?.beforeProjectionWrite?.(mutation.mutationId);
  const applied = await adapter.apply(ctx);
  if (applied.status === "applied" || applied.status === "skipped-idempotent") {
    const evidence = await outcomeEvidence(session, mutation, applied.status, applied.status === "applied" ? applied.evidence : undefined);
    run = await appendRunStep(session, run, { kind: "projection-outcome", mutationId: mutation.mutationId, criticality, status: applied.status, evidence });
    return { run, parked: false };
  }
  if (criticality === "required") return park(session, run, mutation, "bundle-recovery-required");
  const evidence = await outcomeEvidence(session, mutation, "failed");
  run = await appendRunStep(session, run, { kind: "projection-outcome", mutationId: mutation.mutationId, criticality, status: "failed", evidence });
  run = await appendRunStep(session, run, { kind: "warning", code: OPTIONAL_PROJECTION_WARNING, attempted: 1, completed: 0, skipped: 0, failed: 1 });
  return { run, parked: false };
}

/**
 * Drive every projection after the authoritative mutations verify, resumable
 * from a crash: an already-settled projection is skipped, a started-without-
 * outcome projection is regenerated, and a not-yet-started projection is rendered
 * fresh. A terminally-failed required projection leaves the run parked.
 */
/**
 * Reconcile a projection already recorded `failed`: a required failure completes
 * the park; an optional failure re-appends its dropped incompleteness warning (or
 * is already reconciled, returning null to continue).
 */
async function reconcileFailedProjection(session: RunSession, run: OperationRun, mutation: ProjectionOperationMutation): Promise<StepResult | null> {
  if (mutation.target.criticality === "required") {
    return { run: await appendRunStep(session, run, { kind: "recovery-required", code: "bundle-recovery-required" }), parked: true };
  }
  if (optionalWarningDeficit(run) > 0) {
    return { run: await appendRunStep(session, run, { kind: "warning", code: OPTIONAL_PROJECTION_WARNING, attempted: 1, completed: 0, skipped: 0, failed: 1 }), parked: false };
  }
  return null;
}

/** Advance one projection from its current outcome (null = already settled). */
async function advanceProjection(session: RunSession, snapshot: OperationAuthoritySnapshot, run: OperationRun, mutation: ProjectionOperationMutation): Promise<StepResult | null> {
  const outcome = currentProjectionOutcome(run, mutation.mutationId);
  if (outcome === "applied" || outcome === "skipped-idempotent") return null;
  if (outcome === "failed") return reconcileFailedProjection(session, run, mutation);
  if (outcome !== "started") run = await appendRunStep(session, run, { kind: "projection-started", mutationId: mutation.mutationId, criticality: mutation.target.criticality });
  return settleProjection(session, snapshot, run, mutation);
}

async function applyProjections(session: RunSession, snapshot: OperationAuthoritySnapshot, run: OperationRun): Promise<StepResult> {
  for (const mutation of session.manifest.mutations) {
    if (mutation.kind !== "projection") continue;
    const cancelled = await cancelSafePoll(session, run, mutation.mutationId);
    if (cancelled !== null) return { run: cancelled, parked: true };
    const advanced = await advanceProjection(session, snapshot, run, mutation);
    if (advanced === null) continue;
    run = advanced.run;
    if (advanced.parked) return { run, parked: true };
  }
  return { run, parked: false };
}

/** Record the terminal success transition (with-warnings when any warning landed). */
async function finish(session: RunSession, run: OperationRun): Promise<OperationRun> {
  await session.request.runtime.fault?.beforeTerminalWrite?.();
  const step: OperationTransitionStep = run.completionWarnings.length > 0 ? { kind: "succeeded-with-warnings" } : { kind: "succeeded" };
  const settled = await appendRunStep(session, run, step);
  // Remove a late-arriving advisory so a stale request can never re-trigger.
  await session.stores.removeCancel(session.manifest.workspaceId, session.binding.runId);
  return settled;
}

/** Approve, revalidate, and apply one staged bundle under the held project lock. */
export async function approveAndApplyOperationBundleLocked(root: string, request: ApproveOperationBundleRequest): Promise<OperationActionResult> {
  return approveAndApplyOperationBundleWith(diskOperationRunStores(root), request);
}

/** {@link approveAndApplyOperationBundleLocked} over {@link OperationRunStores}: THE ONE BODY. The caller holds the project lock. */
export async function approveAndApplyOperationBundleWith(stores: OperationRunStores, request: ApproveOperationBundleRequest): Promise<OperationActionResult> {
  const loaded = await loadApprovedActionWith(stores, request, "awaiting-approval");
  if (loaded.status === "stop") return loaded.result;
  const { session } = loaded;
  let run = loaded.run;
  const preApplyCancel = await settlePreApplyCancellation(session, run);
  if (preApplyCancel !== null) return preApplyCancel;
  const approval = await computeAuthoritySnapshot(session);
  if (approval.status !== "ok") return runResult(run, "review-store-unavailable");
  run = await appendRunStep(session, run, { kind: "approved", authoritySnapshotDigest: approval.digest });
  const apply = await computeAuthoritySnapshot(session);
  if (apply.status !== "ok") return runResult(await appendRunStep(session, run, { kind: "recovery-required", code: "bundle-recovery-required" }), "bundle-recovery-required");
  if (apply.digest !== approval.digest) return runResult(await appendRunStep(session, run, { kind: "approval-invalidated" }), "approval-invalidated");
  run = await appendRunStep(session, run, { kind: "apply-started", authoritySnapshotDigest: apply.digest, applyOwner: currentApplyOwner() });
  return settleToTerminal(session, apply.snapshot, run);
}
