/**
 * @file src/trust/journal-recovery.ts
 * @description STRICT, FAIL-CLOSED pre-compile journal recovery — the entry point
 * `compile` runs BEFORE it opens its own journalled batches.
 *
 * The existing {@link replayJournal} is BEST-EFFORT: on a malformed or
 * target-escaping batch it QUARANTINES the file and continues, because it runs
 * inline right before a single `review approve` mutation where pressing on is the
 * safer default. Compile is different: it opens FIVE journalled batches per run
 * (× repeated watch/refresh), so a journal it cannot cleanly recover is a signal
 * the page store may be in an inconsistent state — pressing on could compound the
 * damage. {@link recoverJournalBeforeCompile} therefore refuses to silently
 * quarantine-and-continue: any non-revertable condition surfaces as `unsafe` so
 * the caller can fail the compile loudly.
 *
 * It shares the journal's own primitives (classify dir, load+shape-validate a
 * batch, whole-batch confinement gate, per-entry re-confined revert) so the
 * strict path and the best-effort path agree on what a valid, confined,
 * revertable batch is — only the response to a NON-revertable batch differs.
 *
 * STORAGE. {@link recoverJournalBeforeCompileFrom} is THE ONE BODY, over the raw
 * I/O it is handed; the root form passes the incumbent local disk
 * (`./journal-io.ts`). The body keeps every decision: the classify-then-load-
 * again gap (the second load re-checks neither status nor confinement), the
 * legacy prune, the typed refusal, and revert-before-remove. The CALLER holds
 * the project lock.
 */

import {
  classifyJournalDirFrom,
  loadBatchFrom,
  revertEntryFrom,
  journalPath,
  type JournalBatch,
} from "./journal.js";
import { classifyJournalFileFrom, journalBatchReadsFrom, listBatchIdsFrom } from "./journal-classify.js";
import { diskJournalReplayIo, type JournalReplayIo } from "./journal-io.js";

/** What strict recovery asks: restoration's members plus a listing — never the quarantine moves. */
type RecoveryIo = Omit<JournalReplayIo, "makeDirectoryTree" | "renameLeafUnguarded">;

/** The outcome of a strict pre-compile recovery pass. */
export type RecoveryStatus = "clean" | "replayed" | "unsafe";

/** Typed error used INTERNALLY to short-circuit the recovery loop on any non-revertable batch. */
export class JournalUnsafeError extends Error {
  constructor(reason: string) {
    super(`journal recovery unsafe: ${reason}`);
    this.name = "JournalUnsafeError";
  }
}

/**
 * Strictly recover the journal directory before a compile run begins.
 *
 * Iterates the CONFINED journal directory and, for every PENDING batch, attempts
 * a full strict revert to its recorded pre-state. STRICTER than
 * {@link replayJournal}: rather than quarantine-and-continue, ANY non-revertable
 * condition fails closed as `unsafe`. Legacy `committed` files (old pre-state
 * copies) are pruned.
 *
 * Returns:
 *  - `clean`    — dir absent, or nothing pending after pruning legacy committed files;
 *  - `replayed` — at least one pending batch was fully reverted and its file deleted;
 *  - `unsafe`   — the dir symlink-escapes root, a pending file is malformed/unreadable
 *                 (`loadBatch` null), or a recorded target escapes root.
 *
 * @param root - Absolute project root whose journal directory is recovered.
 * @returns The recovery {@link RecoveryStatus}.
 */
export async function recoverJournalBeforeCompile(
  root: string,
): Promise<{ status: RecoveryStatus }> {
  return recoverJournalBeforeCompileFrom(diskJournalReplayIo, root);
}

/** THE ONE BODY of {@link recoverJournalBeforeCompile}: only {@link JournalUnsafeError} becomes `unsafe`; every other failure propagates. */
export async function recoverJournalBeforeCompileFrom(
  io: RecoveryIo,
  root: string,
): Promise<{ status: RecoveryStatus }> {
  const dirState = await classifyJournalDirFrom(io, root);
  if (dirState.kind === "absent") return { status: "clean" };
  if (dirState.kind === "escape") return { status: "unsafe" };
  try {
    return { status: await recoverPendingBatches(io, root, dirState.dir) };
  } catch (err) {
    if (err instanceof JournalUnsafeError) return { status: "unsafe" };
    throw err;
  }
}

/**
 * Revert every pending batch in the confined journal dir, pruning legacy
 * committed files. Returns `replayed` if any pending batch was reverted, else
 * `clean`. Throws {@link JournalUnsafeError} on the first non-revertable batch.
 */
async function recoverPendingBatches(io: RecoveryIo, root: string, confinedDir: string): Promise<RecoveryStatus> {
  let replayedAny = false;
  for (const batchId of await listBatchIdsFrom({ listNames: () => io.listDirectoryNames(confinedDir) })) {
    if (await recoverOneBatch(io, root, batchId)) replayedAny = true;
  }
  return replayedAny ? "replayed" : "clean";
}

/**
 * Recover a single batch, acting on the SHARED {@link classifyJournalFile}
 * verdict so the strict gate and the read-only health detector can never disagree
 * on what is `unsafe`. Prunes a legacy committed file (returns false). Fully
 * reverts a pending batch and deletes its journal (returns true). Throws
 * {@link JournalUnsafeError} when the file is malformed/unreadable or names an
 * escaping target.
 */
async function recoverOneBatch(io: RecoveryIo, root: string, batchId: string): Promise<boolean> {
  const verdict = await classifyJournalFileFrom(journalBatchReadsFrom(io, root), batchId);
  if (verdict === "unsafe") {
    throw new JournalUnsafeError(`non-revertable journal ${batchId}.json`);
  }
  if (verdict === "legacy-committed") {
    await io.removeLeaf(journalPath(root, batchId)); // prune a legacy committed file
    return false;
  }
  await revertPendingBatch(io, root, await loadConfinedPending(io, root, batchId));
  return true;
}

/**
 * Re-load a batch the shared classifier already verdicted `pending-revertable`,
 * guarding the (vanishingly unlikely) concurrent-tamper window where the file
 * changed between classify and revert by failing closed as unsafe.
 */
async function loadConfinedPending(io: RecoveryIo, root: string, batchId: string): Promise<JournalBatch> {
  const batch = await loadBatchFrom(io, root, batchId);
  if (batch === null) throw new JournalUnsafeError(`journal vanished ${batchId}.json`);
  return batch;
}

/** Revert every entry of a confined pending batch, then delete its journal file. */
async function revertPendingBatch(io: RecoveryIo, root: string, batch: JournalBatch): Promise<void> {
  for (const entry of batch.entries) {
    await revertEntryFrom(io, entry, root);
  }
  await io.removeLeaf(journalPath(root, batch.batchId));
}
