/**
 * @file src/wiki/delete-page.ts
 * @description Journalled deletion of wiki concept pages — the delete
 * counterpart to the journalled write batch in `src/compiler/compile-write.ts`.
 *
 * Every wiki page WRITE in llmwiki routes through a journal batch so a crash
 * mid-mutation replays back to the pre-state. Deletion needs the same guarantee,
 * and needs it more: `llmwiki rm` has no confirmation prompt, so the journal is
 * the ONLY recovery path if the process dies partway through a removal.
 *
 * Each page's bytes are recorded via `recordPreState` BEFORE it is unlinked, so
 * `replayJournal` restores every page in a batch that never committed. That buys
 * crash-recovery WITHOUT extending the trust executor: this module composes the
 * same public journal primitives the write path composes.
 *
 * Two contracts are deliberately mirrored from `applyCompilePageWritesLocked`:
 *
 *  - SKIP, NOT ABORT. A slug failing the {@link isSafeFilenameComponent} floor is
 *    reported in `skipped`, never path-joined, and never fatal to the rest of the
 *    batch — an out-of-tree slug must not be able to cancel a legitimate removal.
 *  - EMPTY ⇒ NO-OP. With nothing deletable, NO batch is opened, so a no-op
 *    removal leaves no dangling pending batch and no false recovery window.
 *
 * PRECONDITION: the caller MUST already hold the project lock. This acquires
 * nothing, so it is safe inside an outer locked region.
 *
 * ONE BODY. {@link deleteWikiPagesWith} keeps the replay-first order, the floor
 * split, the empty no-op, and record → unlink → verify-absent → commit, over
 * {@link PageDeleteSteps} addressed by slug. {@link deleteWikiPagesLocked} keeps
 * its signature and passes {@link localPageDeleteSteps}, which map a slug to
 * `wiki/concepts/<slug>.md` and call the incumbent journal primitives (and the
 * `unlinkOne` hook, with the same target path) when asked. The hook is read
 * where it always was: once, just before the batch opens, so an empty or
 * all-skipped call never touches it.
 */

import path from "path";
import { locationKindNoFollow } from "../storage/disk-local-reads.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { openBatch, recordPreState, commitBatch, replayJournal, confinedUnlink, type JournalBatch } from "../trust/journal.js";

/** The unlink primitive, injectable so a crash mid-batch is testable. */
export type UnlinkOne = (targetPath: string) => Promise<void>;

/** A page the batch refused to delete, with the floor that refused it. */
export interface SkippedDelete {
  /** The offending slug, as supplied. */
  slug: string;
  /** Machine-readable reason, prefixed `floor:` like the write path's skips. */
  reason: string;
}

/** Options for {@link deleteWikiPagesLocked}. */
export interface DeleteOptions {
  /** Override the unlink primitive (fault injection). Defaults to `confinedUnlink`. */
  unlinkOne?: UnlinkOne;
}

/** What the page-delete batch asks of the project, by slug. No member takes a project root. */
export interface PageDeleteSteps {
  /** Recover any batch a prior crash left pending. */
  replayJournal(): Promise<void>;
  /** Open (persist) a new journal batch. */
  openBatch(): Promise<JournalBatch>;
  /** Record one page's pre-state into `batch` before it is touched. */
  recordPreState(batch: JournalBatch, slug: string): Promise<void>;
  /** Attempt one page's unlink; may swallow a failure (the verify below catches it). */
  unlink(slug: string): Promise<void>;
  /** Resolve when anything at all remains at the page, without following a link; reject `ENOENT` when it is gone. */
  probeNoFollow(slug: string): Promise<void>;
  /** Commit `batch` once every page is verified gone. */
  commitBatch(batch: JournalBatch): Promise<void>;
}

/**
 * LOCAL DISK: the incumbent journal primitives for one root, built per call. The
 * `unlinkOne` hook keeps its target-path contract and is selected inside
 * `openBatch`, immediately before the batch opens, as the incumbent did. In no package index.
 */
function localPageDeleteSteps(root: string, opts: DeleteOptions = {}): PageDeleteSteps {
  const target = (slug: string) => path.join(root, CONCEPTS_DIR, `${slug}.md`);
  let unlinkOne: UnlinkOne = () => Promise.reject(new Error("internal: unlink before the batch opened"));
  return {
    replayJournal: () => replayJournal(root),
    openBatch: () => {
      unlinkOne = opts.unlinkOne ?? ((targetPath: string) => confinedUnlink(targetPath, root));
      return openBatch(root);
    },
    recordPreState: (batch, slug) => recordPreState(batch, target(slug)),
    unlink: (slug) => unlinkOne(target(slug)),
    probeNoFollow: async (slug) => { await locationKindNoFollow(target(slug)); },
    commitBatch: (batch) => commitBatch(batch),
  };
}

/**
 * Delete concept pages as ONE journalled batch under the caller's held lock.
 *
 * Every unlink is VERIFIED, not trusted. `confinedUnlink`'s catch is shared
 * with the journal's own revert path, where swallowing any error is correct
 * (an absent target IS the goal there). Reused here for a DELETE, that same
 * catch also swallows EACCES/EROFS/EBUSY — real failures that leave the page
 * on disk. So after `unlinkOne` returns, {@link assertUnlinked} re-checks the
 * target and THROWS if it is still present, rather than letting the loop
 * reach `commitBatch` and report success for a delete that never happened.
 * The throw lands BEFORE commit, so the batch stays `pending` — its journal
 * file, and every pre-state recorded so far (including siblings this same
 * batch DID delete), survives for a later {@link replayJournal} to restore.
 *
 * @param root - Absolute project root.
 * @param slugs - Bare concept slugs (no `.md`, no directory part).
 * @param opts - Optional injectable unlink primitive.
 * @returns The floor-skipped slugs; allowed pages are deleted as a side
 *   effect. Throws if an allowed page survives its unlink attempt, leaving
 *   the batch pending for replay instead of reporting a false success.
 */
export async function deleteWikiPagesLocked(
  root: string,
  slugs: string[],
  opts: DeleteOptions = {},
): Promise<{ skipped: SkippedDelete[] }> {
  return deleteWikiPagesWith(localPageDeleteSteps(root, opts), slugs);
}

/** {@link deleteWikiPagesLocked} over {@link PageDeleteSteps}: THE ONE BODY. The caller holds the project lock. */
export async function deleteWikiPagesWith(steps: PageDeleteSteps, slugs: string[]): Promise<{ skipped: SkippedDelete[] }> {
  // Replay-before-mutate, under the held lock: recover any batch a prior crash
  // left pending BEFORE opening a new one. Mirrors the executor's dispatch.
  await steps.replayJournal();

  const { allowed, skipped } = partitionBySlugFloor(slugs);
  if (allowed.length === 0) return { skipped };

  const batch = await steps.openBatch();
  for (const slug of allowed) {
    await steps.recordPreState(batch, slug);
    await steps.unlink(slug);
    await assertUnlinked(steps, slug);
  }
  await steps.commitBatch(batch);
  return { skipped };
}

/**
 * Confirm the page is actually gone after its unlink returns, so a swallowed
 * unlink failure can never be misreported as a completed delete. No-follow
 * (`lstat` on disk), not `stat`: a symlink LEAF must still count as present
 * rather than being followed and misread as absent.
 *
 * @param steps - The batch's steps; only the no-follow probe is asked.
 * @param slug - The slug being deleted, named in the thrown error so a caller
 *   can tell which page failed.
 */
async function assertUnlinked(steps: PageDeleteSteps, slug: string): Promise<void> {
  try {
    await steps.probeNoFollow(slug);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return; // gone — the delete succeeded
    throw error; // an unexpected lstat fault is a real problem, not "still there"
  }
  throw new Error(`failed to delete wiki page "${slug}": file still exists after unlink`);
}

/**
 * Split slugs by the filename floor. The floor is applied HERE, independently of
 * any caller-side validation, so an out-of-tree slug can never reach a path-join
 * no matter who calls this.
 */
function partitionBySlugFloor(slugs: string[]): { allowed: string[]; skipped: SkippedDelete[] } {
  const allowed: string[] = [];
  const skipped: SkippedDelete[] = [];
  for (const slug of slugs) {
    if (isSafeFilenameComponent(slug)) allowed.push(slug);
    else skipped.push({ slug, reason: "floor:unsafe-slug" });
  }
  return { allowed, skipped };
}
