/**
 * @file src/trust/page-apply.ts
 * @description The shared per-page write primitive: confine the target path,
 * enforce create-collision + the mandatory page floor, record the pre-state in
 * the open journal batch, and write via the injectable primitive. Used by the
 * executor's page batch AND the lifecycle handler, so a lifecycle page write
 * inherits the SAME floor + journal discipline as a compile page write — without
 * re-entering the executor dispatcher.
 *
 * This module owns the PAGE concerns the executor used to inline: deriving the
 * wiki-relative path from the union target (re-asserting the identity floor as
 * defense-in-depth), re-probing a `create` collision under the lock, and
 * re-asserting the mandatory trust floor (S5) at the byte-writing boundary. The
 * executor imports these so it depends on page-apply — NOT the reverse — which
 * keeps the lifecycle handler free to import this primitive without an
 * executor↔lifecycle-apply import cycle.
 *
 * STORAGE. The per-page apply has ONE BODY, {@link applyPageMutationLockedFrom},
 * over the raw page I/O it asks ({@link PageApplyIo}: confine, presence, the
 * capped confined read for net growth, and the unlink) plus the two
 * collaborators its caller already owns: the pre-state recorder and the write.
 * {@link applyPageMutationLocked} hands it the local disk's I/O and the default
 * writer. What each answer MEANS stays in the body. NOT bound here: the legacy
 * {@link JournalBatch} recorder still records through `journal.ts` on disk (the
 * journal, recovery and locks are their own owners), and the probes are not
 * `ProjectStore`, hosted or access-controlled.
 */

import path from "path";
import { readConfinedLeafText, removeLeaf, writeLeafAtomicUnconfined } from "../storage/disk-guarded-leaves.js";
import type { CappedLeafRead } from "../utils/confined-read.js";
import { JOURNAL_PRESTATE_MAX_BYTES } from "../utils/constants.js";
import { recordPreState, type JournalBatch } from "./journal.js";

/**
 * Where a page write's pre-state goes before the bytes change.
 *
 * The legacy path records it in a pre-state-only journal batch that replay
 * reverts unconditionally. A portable publication owns its own recovery record
 * (a durable intent with retained pre-images) and must open NO legacy batch,
 * or legacy replay would roll it back before that intent was ever examined. So
 * the recorder is a parameter: a {@link JournalBatch} keeps today's behaviour,
 * and a caller with its own recovery owner supplies a recorder instead.
 */
export type PreStateRecorder = JournalBatch | { recordPreState(absolutePath: string): Promise<void> };

/** Record one target's pre-state with whichever recorder the caller owns. */
async function recordWith(recorder: PreStateRecorder, abs: string): Promise<void> {
  if ("recordPreState" in recorder) return recorder.recordPreState(abs);
  return recordPreState(recorder, abs);
}
import { parseEntityId, isSafeFilenameComponent } from "../profile/identity.js";
import { diskPageTargetProbes, resourceCapForOrigin, type PageTargetProbes } from "./checks.js";
import { runContentChecks } from "./content-floor.js";
import { composeTrustDecision } from "./decision.js";
import type { PagePlannedMutation, EntityRef, RawPageRef } from "./planner.js";

/** Decisions under which the executor is cleared to write bytes to disk. */
const APPLY_ALLOWED_DECISIONS = new Set(["allow", "allow-with-warning"]);

/** A single page write. Injectable so tests can fault-inject a failure. */
export type WriteOne = (filePath: string, content: string) => Promise<void>;

/**
 * The raw physical I/O of one page apply, besides the write: the page-target
 * probes, plus one existing primitive each for the net-growth read and the
 * delete. No member decides anything; the body decides what each answer means.
 */
export interface PageApplyIo extends PageTargetProbes {
  /**
   * The capped, confined read of `leaf`: refusals are values (`absent`,
   * `unavailable`), never a follow through a link. REJECTS raw.
   * Disk: `readConfinedLeafText(root, leaf, expectedDir, maxBytes)`.
   */
  readConfinedLeafText(root: string, leaf: string, expectedDir: string, maxBytes: number): Promise<CappedLeafRead>;
  /** Unlink `leaf` by path (a link itself, never its target). REJECTS raw. Disk: `removeLeaf(leaf)`. */
  removeLeaf(leaf: string): Promise<void>;
}

/** LOCAL DISK. The page-target probes plus the incumbent capped read and unlink; no state, frozen. In no package index. */
export const diskPageApplyIo: PageApplyIo = Object.freeze({
  ...diskPageTargetProbes,
  readConfinedLeafText: (root: string, leaf: string, expectedDir: string, maxBytes: number) => readConfinedLeafText(root, leaf, expectedDir, maxBytes),
  removeLeaf: (leaf: string) => removeLeaf(leaf),
});

/**
 * Thrown when a `create` target — free at plan time — has appeared on disk by
 * the time the batch runs under the lock. Aborting before any write closes the
 * plan→apply TOCTOU so a create never clobbers a concurrently-created file.
 * Callers match on the typed `create-collision:` message prefix.
 */
class CreateCollisionError extends Error {
  constructor(targetPath: string) {
    super(`create-collision: target already exists, refusing to overwrite: ${targetPath}`);
    this.name = "CreateCollisionError";
  }
}

/**
 * Thrown when a mutation's target identity is not slug-safe. The planner's
 * `checkIdentitySafe` guard only protects the planner path; a hand-built
 * {@link PagePlannedMutation} bypasses it, so the executor re-asserts the
 * identity before deriving a path. Callers match on the typed
 * `invalid-identity:` prefix.
 */
class InvalidIdentityError extends Error {
  constructor(message: string) {
    super(`invalid-identity: ${message}`);
    this.name = "InvalidIdentityError";
  }
}

/**
 * Thrown when a mutation fails the mandatory trust floor re-asserted at apply
 * time (S5): an oversized body, malformed frontmatter, or any block-composing
 * floor result. Refusing here — at the byte-writing boundary — means a
 * hand-built mutation that never passed the planner cannot reach disk. Callers
 * match on the typed `mutation-floor:` message prefix.
 */
class MutationFloorError extends Error {
  constructor(reason: string) {
    super(`mutation-floor: refused before write: ${reason}`);
    this.name = "MutationFloorError";
  }
}

/** True when something exists at `abs` (regular file, dir, or symlink), asked through `io`; a probe fault reads as absent. */
async function targetExists(io: PageApplyIo, abs: string): Promise<boolean> {
  try {
    return await io.leafPresent(path.dirname(abs), path.basename(abs));
  } catch {
    return false;
  }
}

/**
 * The wiki-relative page path for a DEFAULT page's {@link RawPageRef} target.
 *
 * Defense-in-depth: the executor does not trust the caller, so it RE-ASSERTS the
 * {@link isSafeFilenameComponent} floor on both the directory and the raw slug —
 * a hand-built mutation carrying a `..`/separator slug is rejected with a typed
 * {@link InvalidIdentityError} BEFORE `path.join` could collapse it into a wrong
 * in-root location (the planner's `checkDefaultIdentitySafe` guard is not on this
 * path).
 */
function rawPageRelPath(target: RawPageRef): string {
  if (!isSafeFilenameComponent(target.directory) || !isSafeFilenameComponent(target.slug)) {
    throw new InvalidIdentityError(`directory/slug is not a safe filename component: ${target.directory}/${target.slug}`);
  }
  return path.join("wiki", target.directory, `${target.slug}.md`);
}

/**
 * The wiki-relative page path for a PROFILE entity's {@link EntityRef} target.
 *
 * Defense-in-depth: the entityType/slug are re-validated by re-parsing the
 * branded `target.id` (which throws on a non-slug-safe slug half), so a
 * hand-built mutation carrying a `..` slug is rejected with a typed
 * {@link InvalidIdentityError} BEFORE `path.join` could collapse it into a wrong
 * in-root location — the planner's `checkIdentitySafe` guard is not on this path.
 */
function entityPageRelPath(target: EntityRef): string {
  let entityType: string;
  let slug: string;
  try {
    ({ entityType, slug } = parseEntityId(target.id));
  } catch (err) {
    throw new InvalidIdentityError((err as Error).message);
  }
  return path.join("wiki", entityType, `${slug}.md`);
}

/**
 * The wiki-relative page path for a page mutation's target, discriminating the
 * union: a DEFAULT page ({@link RawPageRef}, no `id`) takes the raw-component
 * path; a PROFILE entity ({@link EntityRef}) takes the typed-id path. Both
 * re-assert their identity floor as defense-in-depth.
 */
function pageRelPath(mutation: PagePlannedMutation): string {
  const target = mutation.target;
  if ("id" in target) return entityPageRelPath(target);
  return rawPageRelPath(target);
}

/**
 * The effective resource cap for one mutation at apply time.
 *
 * `create` always gets the absolute origin cap — a new page is never exempt. An
 * `update` gates on NET GROWTH instead of absolute size: the content-size floor
 * is sized for NEW content, but an update that adds none (e.g. a lifecycle
 * transition flipping one frontmatter field on an already-large page) must not be
 * floor-blocked. So an update's effective cap is `max(originCap, existingChars)`
 * — a normal-sized page (existing ≤ cap) is still capped at the origin cap
 * unchanged, while an already-over-cap page may be rewritten as long as the new
 * body does NOT GROW beyond what is already on disk. A growing rewrite is still
 * blocked. `abs` exists for an update (the target was probed), so its current
 * character length is read directly; a missing/unreadable file yields 0 (no
 * exemption), keeping the origin cap.
 */
async function effectiveMaxChars(io: PageApplyIo, root: string, mutation: PagePlannedMutation, abs: string): Promise<number> {
  const originCap = resourceCapForOrigin(mutation.provenance.origin);
  if (mutation.operation !== "update") return originCap;
  // Root-anchored, no-follow, capped read (mirrors recordPreState one hop later):
  // a symlinked leaf, a symlinked PARENT dir escaping root, or a non-regular page
  // yields `unavailable` here — fall through to 0 (origin cap) rather than reading
  // through the symlink; recordPreState then refuses the mutation. `expectedDir`
  // is the LEXICAL in-root parent from `pageRelPath` so it is NOT realpath'd (which
  // would follow the very symlink we must reject).
  const expectedDir = path.join(path.resolve(root), path.dirname(pageRelPath(mutation)));
  const existing = await io.readConfinedLeafText(root, abs, expectedDir, JOURNAL_PRESTATE_MAX_BYTES);
  const existingChars = existing.kind === "ok" ? existing.body.length : 0;
  return Math.max(originCap, existingChars);
}

/**
 * Re-assert the mandatory trust floor for one mutation at apply time (S5),
 * against a context whose `allowOverwrite` mirrors the operation (`update`
 * overwrites; `create` does not). Runs the floor checks not already enforced on
 * this path — resource-limit and frontmatter — and composes them; a non-allow
 * decision throws {@link MutationFloorError} so nothing is written.
 *
 * The resource cap is the {@link effectiveMaxChars} for the operation: `create`
 * keeps the absolute origin cap, while an `update` gates on net growth so a
 * no-content-added update of an already-large page is admitted (see that helper).
 */
async function assertFloorAtApply(io: PageApplyIo, root: string, mutation: PagePlannedMutation, abs: string): Promise<void> {
  // SAME origin→cap mapping the planner used, raised to the on-disk length for an
  // update so a no-growth rewrite of an over-cap page is not blocked. The checks
  // themselves are the shared path-free floor, so a host with no paths runs them too.
  const checks = await runContentChecks(mutation.body, await effectiveMaxChars(io, root, mutation, abs));
  const decision = composeTrustDecision(checks, { reviewRouted: false });
  if (!APPLY_ALLOWED_DECISIONS.has(decision)) {
    const reason = checks.find((c) => c.verdict === "block")?.message ?? decision;
    throw new MutationFloorError(reason);
  }
}

/**
 * Apply ONE page mutation under an already-open journal batch: confine the
 * target, re-probe a `create` collision under the lock, re-assert the trust
 * floor (S5), record the target's pre-state, then write it.
 *
 * A `create` target is RE-PROBED under the lock (the planner's collision check
 * runs before the lock): if it now exists, abort with {@link CreateCollisionError}
 * BEFORE any write lands, so a create never overwrites a file that appeared
 * after planning. `update` operations may legitimately overwrite. Throws on a
 * collision, floor violation, or failing write, leaving the journal uncommitted
 * for replay.
 *
 * @param root - Absolute project root the write must stay confined to.
 * @param mutation - The approved page mutation to apply.
 * @param batch - The legacy journal batch, or the caller's own pre-state recorder.
 * @param writeOne - Per-target write primitive (defaults to
 *   {@link writeLeafAtomicUnconfined}: `atomicWrite` with no confine root).
 */
/**
 * Remove one confined page, recorded so a crash reverts it.
 *
 * CRASH SAFETY COMES FREE FROM THE EXISTING JOURNAL, which is a ROLLBACK log
 * rather than a redo log: it records what was at the path BEFORE the batch and
 * recovery restores it. A delete therefore needs no new journal entry kind —
 * record the prior content, unlink, and an interrupted batch reverts by writing
 * the page back exactly as it was.
 *
 * NO CONTENT FLOOR RUNS, which is correct rather than a shortcut: the floor
 * validates the bytes a mutation WRITES (resource limits, frontmatter shape),
 * and a delete writes none.
 *
 * DELETING WHAT IS ALREADY ABSENT IS NOT AN ERROR. The goal state is "not
 * present"; something else reaching it first does not make this batch a
 * failure, and refusing would strand a retry after a partial apply.
 */
async function deletePageLocked(io: PageApplyIo, abs: string, batch: PreStateRecorder): Promise<void> {
  if (!(await targetExists(io, abs))) return;
  await recordWith(batch, abs);
  await io.removeLeaf(abs);
}

export async function applyPageMutationLocked(
  root: string,
  mutation: PagePlannedMutation,
  batch: PreStateRecorder,
  writeOne: WriteOne = writeLeafAtomicUnconfined,
): Promise<void> {
  return applyPageMutationLockedFrom(diskPageApplyIo, root, mutation, batch, writeOne);
}

/**
 * {@link applyPageMutationLocked} over `io`: THE ONE BODY. The identity floor
 * (before any I/O), the confinement (a rejection propagates), the delete of an
 * absent page (a no-op, no floor, no record), the create collision (before the
 * floor), the net-growth floor (an unreadable page counts as 0 characters), the
 * pre-state record BEFORE the write, and the write are all decided here.
 *
 * @param io - The raw page I/O; `root` is handed to it as data.
 * @param root - Project root the write must stay confined to.
 * @param mutation - The approved page mutation to apply.
 * @param batch - The legacy journal batch, or the caller's own pre-state recorder.
 * @param writeOne - The per-target write; required here, so the body has no disk default.
 */
export async function applyPageMutationLockedFrom(
  io: PageApplyIo,
  root: string,
  mutation: PagePlannedMutation,
  batch: PreStateRecorder,
  writeOne: WriteOne,
): Promise<void> {
  const abs = await io.confineTarget(pageRelPath(mutation), root);
  if (mutation.operation === "delete") return deletePageLocked(io, abs, batch);
  if (mutation.operation === "create" && (await targetExists(io, abs))) {
    throw new CreateCollisionError(abs);
  }
  await assertFloorAtApply(io, root, mutation, abs);
  await recordWith(batch, abs);
  await writeOne(abs, mutation.body);
}
