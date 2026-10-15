/**
 * @file src/trust/journal-classify.ts
 * @description The SINGLE shared journal classifier both the strict, MUTATING
 * pre-compile gate ({@link recoverJournalBeforeCompile}) and the read-only health
 * detector ({@link journalHealth}) consume, so they can never disagree on what is
 * `unsafe`/`unavailable` versus a clean (committed/absent) or pending state.
 *
 * Classification is PURE (no writes, no replay, no prune): given a project root
 * and a batch id it loads + shape-validates the file and applies the whole-batch
 * confinement gate, reporting one of three categories. Each consumer then decides
 * what to DO with that category — the strict gate prunes/reverts, the read-only
 * detector merely reports — but the categorization itself lives here exactly once.
 *
 * It reuses the journal's own primitives ({@link parseJournalBatch}, the pure
 * parse and shape check {@link loadBatch} runs, and
 * {@link targetConfinedUnderRoot}, the per-target check
 * {@link allTargetsConfined} loops over) so the strict path and the read-only
 * path share the same definition of a valid, confined batch, and also owns the
 * shared {@link listBatchIds} iteration so both consumers enumerate the journal
 * dir identically.
 *
 * ONE BODY, TWO WAYS IN. {@link classifyJournalFileFrom} and
 * {@link listBatchIdsFrom} read through a {@link JournalBatches} they are handed.
 * The root-named {@link classifyJournalFile} and {@link listBatchIds} run those
 * same bodies over the local disk and make exactly the disk calls they always
 * made: neither resolves the journal directory. What a read MEANS (unsafe,
 * committed, pending) is decided here; where a batch is, how it is read without
 * following a link, and whether a recorded target is inside the project are
 * answered by the batches object.
 *
 * STORAGE. The disk batch reads and the disk read sources are each ONE
 * construction over raw I/O ({@link journalBatchReadsFrom},
 * {@link journalReadSourcesFrom}); the root forms pass the incumbent local disk
 * (`./journal-io.ts`) and make the same calls in the same order.
 */

import { classifyJournalDirFrom, journalPath, parseJournalBatch, targetConfinedUnderRootFrom } from "./journal.js";
import { diskJournalReplayIo, type JournalReplayIo } from "./journal-io.js";

/** The raw members the per-batch reads ask for: a no-follow read, and confinement by either root spelling. */
type BatchReadIo = Pick<JournalReplayIo, "readLeafTextNoFollow" | "confineTarget" | "realPath">;
/** What opening a journal asks beyond the batch reads: the nullable realpath and a listing. */
type ReadSourceIo = BatchReadIo & Pick<JournalReplayIo, "safeRealPath" | "listDirectoryNames">;

/**
 * The batch files of one journal directory, as the classifier reads them. OWNED
 * BY THE JOURNAL READERS: a narrow seam with one disk implementation. It is not
 * `ProjectStore`, not a hosted or access-control contract, and it selects no
 * backend. It carries NO meaning: what `null`, a name or `false` implies is the
 * classifier's decision.
 */
export interface JournalBatches {
  /** The names directly in the journal directory, in the order the store returns them. REJECTS with the raw error. */
  listNames(): Promise<string[]>;
  /** One batch file's text, read WITHOUT following a link; `null` for EVERY failure (absent, a link, unreadable). */
  readBatchText(batchId: string): Promise<string | null>;
  /** Whether a recorded target lies inside the project, by either spelling of its root. Never rejects. */
  targetConfined(targetPath: string): Promise<boolean>;
}

/** What opening a project's journal answers: no directory, one that leaves the project, or its batches. */
export type JournalOpening = { kind: "absent" } | { kind: "escape" } | { kind: "ok"; journal: JournalBatches };

/** Where a project's journal is found. Read-only: nothing here writes, replays, prunes or locks. */
export interface JournalReadSources {
  /** Called ONCE per health read. Never rejects. */
  openJournal(): Promise<JournalOpening>;
}

/**
 * The classification of a single journal file:
 *  - `legacy-committed` — a cleanly-loadable non-pending (committed) batch: a
 *    stale pre-state copy that needs no recovery (the strict gate prunes it,
 *    health ignores it);
 *  - `pending-revertable` — a cleanly-loadable `status:"pending"` batch whose
 *    every target confines under root (an incomplete compile, safe to revert);
 *  - `unsafe` — the file is malformed/unreadable, OR names a target that escapes
 *    root. A tamper/corruption is ALWAYS this, never one of the clean categories.
 */
export type JournalFileClass = "legacy-committed" | "pending-revertable" | "unsafe";

/**
 * Classify one journal batch file purely from disk, applying the SAME load,
 * shape-validation, and whole-batch confinement checks the strict recovery gate
 * uses — but performing NO mutation. Both the mutating gate and the read-only
 * detector call this so they can never drift on what counts as `unsafe`.
 *
 * @param root - Absolute project root the journal hangs off.
 * @param batchId - The `<batchId>` stem of the journal file to classify.
 * @returns The file's {@link JournalFileClass}.
 */
export function classifyJournalFile(
  root: string,
  batchId: string,
): Promise<JournalFileClass> {
  return classifyJournalFileFrom(journalBatchReadsFrom(diskJournalReplayIo, root), batchId);
}

/**
 * {@link classifyJournalFile} over the batch reads it is handed: THE ONE BODY.
 * Read the batch (not loadable is unsafe), parse and shape-check it (broken is
 * unsafe), let a non-pending batch through as committed, then ask of each
 * recorded target in order whether it is confined; the first that is not makes
 * the batch unsafe and no later target is asked. A `root` serialized in the file
 * is NEVER read: confinement is the batches object's answer alone.
 */
export async function classifyJournalFileFrom(
  journal: Pick<JournalBatches, "readBatchText" | "targetConfined">,
  batchId: string,
): Promise<JournalFileClass> {
  const raw = await journal.readBatchText(batchId);
  if (raw === null) return "unsafe"; // not loadable
  const batch = parseJournalBatch(raw);
  if (batch === null) return "unsafe"; // unreadable JSON or malformed shape
  if (batch.status !== "pending") return "legacy-committed";
  for (const entry of batch.entries) {
    if (!(await journal.targetConfined(entry.targetPath))) return "unsafe"; // a target escapes root
  }
  return "pending-revertable";
}

/**
 * List the `<batchId>` stems of every `.json` file directly in the confined
 * journal dir — the single shared iteration both the strict gate and the
 * read-only detector use to enumerate batches before classifying each.
 *
 * @param confinedDir - The confined absolute journal directory to list.
 * @returns The batch-id stems (filenames with the trailing `.json` removed).
 */
function listBatchIds(confinedDir: string): Promise<string[]> {
  return listBatchIdsFrom({ listNames: () => diskJournalReplayIo.listDirectoryNames(confinedDir) });
}

/** {@link listBatchIds} over a listing: keep names ending `.json`, in the order listed, without the ending. */
export async function listBatchIdsFrom(journal: Pick<JournalBatches, "listNames">): Promise<string[]> {
  const files = await journal.listNames();
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}

/**
 * The two per-batch reads for the project at `root`, over the given raw I/O:
 * the batch file by the root AS WRITTEN (not its resolved form), opened without
 * following a link; and each target confined against that same root. Building
 * it does no I/O.
 */
export function journalBatchReadsFrom(io: BatchReadIo, root: string): Pick<JournalBatches, "readBatchText" | "targetConfined"> {
  return {
    readBatchText: (batchId) => io.readLeafTextNoFollow(journalPath(root, batchId)),
    targetConfined: (targetPath) => targetConfinedUnderRootFrom(io, targetPath, root),
  };
}

/**
 * LOCAL DISK. The journal of the project at `root`. Building it does no I/O.
 * Opening resolves the journal directory once ({@link classifyJournalDir}); the
 * names listed are those of the RESOLVED directory, while each batch is read by
 * the root as written, exactly as the detector always did. In no package index.
 */
export function diskJournalReadSources(root: string): JournalReadSources {
  return journalReadSourcesFrom(diskJournalReplayIo, root);
}

/**
 * THE ONE CONSTRUCTION of {@link diskJournalReadSources}, over the given raw
 * I/O. Building it does no I/O; each opening resolves the directory with the
 * nullable realpath, lists the RESOLVED directory, and reads by the root as written.
 */
export function journalReadSourcesFrom(io: ReadSourceIo, root: string): JournalReadSources {
  return {
    openJournal: async () => {
      const state = await classifyJournalDirFrom(io, root);
      if (state.kind !== "ok") return state;
      return { kind: "ok", journal: { listNames: () => io.listDirectoryNames(state.dir), ...journalBatchReadsFrom(io, root) } };
    },
  };
}
