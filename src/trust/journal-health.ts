/**
 * @file src/trust/journal-health.ts
 * @description The READ-ONLY journal health detector. A journal-backed project
 * mutation that crashes mid-batch leaves a `pending` journal (recovered by the
 * next compile's {@link recoverJournalBeforeCompile}); read surfaces should SURFACE that state
 * rather than silently serving partial post-crash bytes. {@link journalHealth}
 * inspects the journal directory and reports one of three states WITHOUT any
 * mutation — no write, no replay, no prune, no lock, and crucially no `.llmwiki`
 * mkdir (a clean project must stay untouched after a health probe).
 *
 * It shares the strict gate's exact classification — {@link classifyJournalDir}
 * for the directory and {@link classifyJournalFile} per file — so the read-only
 * detector and the mutating recovery gate can never disagree on what is
 * `unavailable`/`unsafe`. The strict gate ACTS on that verdict (prune/revert);
 * this detector only REPORTS it.
 */

import { classifyJournalFileFrom, diskJournalReadSources, listBatchIdsFrom } from "./journal-classify.js";
import type { JournalBatches, JournalReadSources } from "./journal-classify.js";

/**
 * The read-only health verdict for a project's intent journal:
 *  - `ok` — journal dir absent, OR it holds only legacy committed files / nothing
 *    pending (a tamper-free, no-incomplete-compile state). A clean compile leaves
 *    zero journal files → `ok`;
 *  - `pending` — at least one cleanly-loadable `status:"pending"` batch (an
 *    incomplete project mutation whose partial bytes should not be served as final);
 *  - `unavailable` — the journal/private dir symlink-escapes root, OR a pending
 *    file is malformed/unreadable, OR a recorded target escapes root (anything the
 *    strict gate would call `unsafe`). Tamper/corruption is NEVER `ok`/`pending`.
 */
export type JournalHealthStatus = "ok" | "pending" | "unavailable";

/**
 * Report the project's journal health WITHOUT mutating the filesystem.
 *
 * Resolves the journal directory via the SHARED {@link classifyJournalDir}
 * (absent → `ok`, symlink-escape → `unavailable`) and, when present, classifies
 * every `.json` batch via the SHARED {@link classifyJournalFile}. A single
 * `unsafe` file makes the whole journal `unavailable` (fail closed); otherwise a
 * single `pending-revertable` batch makes it `pending`; a journal of only legacy
 * committed files (or none) is `ok`. This is purely a read — it never replays,
 * prunes, locks, or creates `.llmwiki`.
 *
 * @param root - Absolute project root whose journal directory is inspected.
 * @returns The read-only {@link JournalHealthStatus}.
 */
export async function journalHealth(
  root: string,
): Promise<{ status: JournalHealthStatus }> {
  return journalHealthFrom(diskJournalReadSources(root));
}

/**
 * {@link journalHealth} over {@link JournalReadSources}: THE ONE BODY. The
 * journal is opened once. No directory is `ok`; a directory that leaves the
 * project is `unavailable`; otherwise its batches decide. Nothing is caught: a
 * listing that rejects rejects the read.
 */
export async function journalHealthFrom(
  sources: JournalReadSources,
): Promise<{ status: JournalHealthStatus }> {
  const opening = await sources.openJournal();
  if (opening.kind === "absent") return { status: "ok" };
  if (opening.kind === "escape") return { status: "unavailable" };
  return { status: await classifyBatches(opening.journal) };
}

/**
 * Classify every batch file of the opened journal, in listing order, and reduce to a single
 * health status. Any `unsafe` file short-circuits to `unavailable` (fail closed);
 * else any `pending-revertable` batch yields `pending`; else `ok`.
 */
async function classifyBatches(journal: JournalBatches): Promise<JournalHealthStatus> {
  let sawPending = false;
  for (const batchId of await listBatchIdsFrom(journal)) {
    const verdict = await classifyJournalFileFrom(journal, batchId);
    if (verdict === "unsafe") return "unavailable";
    if (verdict === "pending-revertable") sawPending = true;
  }
  return sawPending ? "pending" : "ok";
}
