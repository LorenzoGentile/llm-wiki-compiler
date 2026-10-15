/**
 * @file src/preparations/prune-delete.ts
 * @description The two-phase verified-delete engine, owned by the driver.
 *
 * This is the terminal engine for `verified-delete` plans, the sibling of
 * `runTwoPhaseQuarantine`. It lived in `retention.ts` as `runTwoPhaseDelete`,
 * where it was a SECOND complete plan/apply/verify/complete protocol driven by
 * the operation itself — which is what PLA-INV-07 forbids and Task 9E exists to
 * end.
 *
 * It is reached only from the driver's engine switch, never from an adapter, and
 * every mutation it performs carries the driver's permit. Before this, the prune
 * receipt writes and the leaf deletes took no permit at all: the most destructive
 * mutations in the package were reachable by any caller that imported them, so
 * "prune routes through the driver" would have moved the call sequence and
 * changed nothing about who may touch the bytes.
 *
 * ONE ENGINE BODY over {@link PruneUnitLeaves}. `runTwoPhaseVerifiedDeleteWith`
 * owns the completed-receipt short-circuit, signed-plan reuse on resume, signing,
 * the receipt verdict (`verifiedPruneReceipt`), the signed-plan index order of the
 * deletes and the phase order with the same crash seams. Confinement, namespaces,
 * receipt I/O and the staged verified delete stay in `lifecycle-fs/prune-protocol`
 * behind the local-disk leaves; every mutation still carries the driver's permit.
 */

import { createHash } from "node:crypto";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import {
  assertConfinedPruneUnit, deletePlannedPruneObject, readPruneReceiptLeaf,
  verifiedPruneReceipt, writePruneReceiptBytes,
} from "./lifecycle-fs/prune-protocol.js";
import type { CappedLeafReadBuffer } from "../utils/confined-read.js";
import type { LifecycleMutationPermitV1 } from "./lifecycle-mutation-permit.js";
import type { ScopedQuarantineObject } from "./quarantine-move.js";
import { signPruneReceipt, type PruneReceiptContentV1, type PruneReceiptV1 } from "./receipts.js";
import type { PreparationPrincipalV1 } from "./run-types.js";

/** Deterministic crash seams placed at each durable prune/sweep boundary. */
export interface DeleteFaultsForTest {
  afterPlanned?: () => Promise<void>;
  afterStaged?: () => Promise<void>;
  afterDeletes?: () => Promise<void>;
  beforeCompleted?: () => Promise<void>;
}

/** Everything the engine needs, assembled field by field by the driver. */
export interface VerifiedDeleteEngineInput {
  readonly permit: LifecycleMutationPermitV1;
  readonly root: string;
  readonly unitId: string;
  readonly operation: PruneReceiptContentV1["operation"];
  readonly runId?: string;
  readonly key: Buffer;
  readonly keyEpochId: string;
  readonly actor: PreparationPrincipalV1;
  readonly at: string;
  readonly objects: readonly ScopedQuarantineObject[];
  readonly faults?: DeleteFaultsForTest;
}

type PruneAuthority = Omit<PruneReceiptContentV1, "kind">;

/** The unit id for one run's prune, derived from the run id alone. */
export function pruneUnitIdFor(runId: string): string {
  return `prn-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
}

/**
 * The unit id for one sweep, derived from the VISIBLE object paths.
 *
 * Load-bearing, not cosmetic: once the first object is staged it leaves the
 * inventory, so a later pass would derive a DIFFERENT id and strand the original
 * unit with staged bytes and no completed receipt, where nothing else enumerates
 * it. This is why an unfinished sweep must be resumed before a new one is derived.
 */
export function sweepUnitIdFor(objects: readonly ScopedQuarantineObject[]): string {
  const paths = objects.map((object) => object.logicalPath).sort().join("\0");
  return `swp-${createHash("sha256").update(paths).digest("hex").slice(0, 32)}`;
}

/** What the verified-delete engine asks of one prune unit's storage. No member takes a project root. */
export interface PruneUnitLeaves {
  /** Prove the unit is absent or a real confined directory; rejects otherwise. */
  assertConfinedUnit(unitId: string): Promise<void>;
  /** One receipt leaf's bytes, read inside a current lifecycle namespace. */
  readReceiptLeaf(unitId: string, kind: PruneReceiptContentV1["kind"]): Promise<CappedLeafReadBuffer>;
  /** Create-only durable publication of one signed receipt, under the permit. */
  publishReceipt(permit: LifecycleMutationPermitV1, unitId: string, kind: PruneReceiptContentV1["kind"], bytes: Buffer): Promise<void>;
  /** Stage-then-delete one planned leaf by its signed-plan index, idempotently, under the permit. */
  deleteObject(
    permit: LifecycleMutationPermitV1, unitId: string, index: number,
    object: PruneReceiptContentV1["objects"][number], afterStaged?: () => Promise<void>,
  ): Promise<void>;
}

/** The local-disk prune unit leaves for one root, built per call. In no package index. */
export function diskPruneUnitLeaves(root: string): PruneUnitLeaves {
  return {
    assertConfinedUnit: (unitId) => assertConfinedPruneUnit(root, unitId),
    readReceiptLeaf: (unitId, kind) => readPruneReceiptLeaf(root, unitId, kind),
    publishReceipt: (permit, unitId, kind, bytes) => writePruneReceiptBytes(permit, root, unitId, kind, bytes),
    deleteObject: (permit, unitId, index, object, afterStaged) => deletePlannedPruneObject(permit, root, unitId, index, object, afterStaged),
  };
}

/** One verified receipt of `kind` for this unit and operation, or null when absent. */
async function readVerifiedReceipt(
  leaves: PruneUnitLeaves, input: VerifiedDeleteEngineInput, kind: PruneReceiptContentV1["kind"],
): Promise<PruneReceiptV1 | null> {
  return verifiedPruneReceipt(await leaves.readReceiptLeaf(input.unitId, kind), input.key, kind, input.unitId, input.operation);
}

/** Build one signed prune/sweep receipt content minus its integrity field. */
function pruneReceiptContent(
  kind: PruneReceiptContentV1["kind"], authority: PruneAuthority,
): PruneReceiptContentV1 {
  return { ...authority, kind };
}

/** Capture the immutable authority shared by a planned/completed receipt pair. */
function pruneAuthority(
  input: VerifiedDeleteEngineInput,
  objects: readonly PruneReceiptContentV1["objects"][number][],
): PruneAuthority {
  return {
    schemaVersion: 1, operation: input.operation, unitId: input.unitId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    keyEpochId: input.keyEpochId, objects,
    actor: { id: input.actor.id, surface: input.actor.surface }, at: input.at,
  };
}

/** Durably publish one signed prune receipt create-only with its parent fsync. */
async function writePruneReceipt(
  leaves: PruneUnitLeaves,
  input: VerifiedDeleteEngineInput,
  kind: PruneReceiptContentV1["kind"],
  authority: PruneAuthority,
): Promise<void> {
  const receipt = signPruneReceipt(input.key, pruneReceiptContent(kind, authority));
  await leaves.publishReceipt(input.permit, input.unitId, kind, canonicalBytes(receipt));
}

/** Phase one: reuse the signed plan on resume, else create/fsync the planned receipt. */
async function planDelete(
  leaves: PruneUnitLeaves,
  input: VerifiedDeleteEngineInput,
): Promise<{ authority: PruneAuthority }> {
  const existing = await readVerifiedReceipt(leaves, input, "prune-planned");
  if (existing !== null) {
    const { kind: _kind, integrity: _integrity, ...authority } = existing;
    return { authority };
  }
  const objects = [...input.objects]
    .map((object) => ({
      logicalPath: object.logicalPath, byteCount: object.byteCount, digest: object.digest,
    }))
    .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  const authority = pruneAuthority(input, objects);
  await writePruneReceipt(leaves, input, "prune-planned", authority);
  return { authority };
}

/**
 * Delete only the exact planned leaves, idempotently, and fsync their parents.
 *
 * The index is the SIGNED plan's array position, and the staging slot name is
 * derived from it — so a resumed unit finds its staged bytes only because the
 * signed receipt's order is stable. Re-sorting or re-indexing here would make a
 * resume look in the wrong slot, see both ends absent, and complete with bytes
 * stranded: a false success, not a visible failure.
 */
async function deletePhase(
  leaves: PruneUnitLeaves,
  input: VerifiedDeleteEngineInput,
  objects: readonly PruneReceiptContentV1["objects"][number][],
): Promise<void> {
  for (const [index, object] of objects.entries()) {
    await leaves.deleteObject(input.permit, input.unitId, index, object, input.faults?.afterStaged);
  }
}

/** Run (or idempotently resume) one planned/completed prune or sweep unit. */
export async function runTwoPhaseVerifiedDelete(
  input: VerifiedDeleteEngineInput,
): Promise<PruneReceiptV1> {
  return runTwoPhaseVerifiedDeleteWith(diskPruneUnitLeaves(input.root), input);
}

/** {@link runTwoPhaseVerifiedDelete} over the unit leaves: the one engine body. `input.root` is not read here. */
export async function runTwoPhaseVerifiedDeleteWith(
  leaves: PruneUnitLeaves, input: VerifiedDeleteEngineInput,
): Promise<PruneReceiptV1> {
  await leaves.assertConfinedUnit(input.unitId);
  const completed = await readVerifiedReceipt(leaves, input, "prune-completed");
  if (completed !== null) return completed;
  const plan = await planDelete(leaves, input);
  await input.faults?.afterPlanned?.();
  await deletePhase(leaves, input, plan.authority.objects);
  await input.faults?.afterDeletes?.();
  await input.faults?.beforeCompleted?.();
  const receipt = signPruneReceipt(
    input.key, pruneReceiptContent("prune-completed", plan.authority));
  await leaves.publishReceipt(input.permit, input.unitId, "prune-completed", canonicalBytes(receipt));
  return receipt;
}
