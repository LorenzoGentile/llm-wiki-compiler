/**
 * @file src/commands/review-reject.ts
 * @description The `review reject` subcommand: archives a pending candidate
 * without touching `wiki/`.
 *
 * Rejection reads the candidate's raw queue file by its explicit safe id and
 * never runs promotion admission, so a record with malformed validated-answer
 * metadata can still be cleared. The archive move runs under the review lock
 * and re-captures custody immediately before moving, so a candidate that was
 * removed or replaced between the pre-lock check and the move fails cleanly
 * rather than silently succeeding on a stale handle.
 *
 * A candidate retained by an interrupted batch may key embedding work in the
 * review intent. Before archiving, that work is handed to the embedding retry
 * queue, keyed from the same captured bytes the move archives; if the queue
 * cannot record it, or either store is unreadable, the rejection refuses and
 * the candidate stays pending. A page whose content is still excluded stays
 * excluded; that never blocks the rejection.
 *
 * ONE BODY, NO ROOT. {@link rejectCandidateWith} owns the rejection policy over
 * {@link ReviewRejectSteps}: archive under custody, release the intent from the
 * captured bytes BEFORE the move, hand released pages to the retry queue (none
 * when there are none or refreshes are disabled), refuse when the queue cannot
 * record them, and report only a real archive. The lock stays the caller's
 * (`runReviewUnderLock`). The local steps call the incumbent root forms when
 * asked; {@link reviewRejectStepsOver} composes the same steps from each one's
 * root-free body. In no package index.
 */

import type { CandidateStoreMoveReads } from "../compiler/candidate-custody.js";
import { archiveRejectedCandidate, archiveRejectedCandidateFrom, loadRejectableCandidateOrFail } from "../compiler/candidate-rejection.js";
import { embeddingsDisabled } from "../utils/embeddings-config.js";
import { queueScopedEmbeddingRetry, queueScopedEmbeddingRetryFrom, type EmbeddingMarkerStorage } from "../utils/embeddings-retry.js";
import * as output from "../utils/output.js";
import type { PageId } from "../utils/page-id.js";
import { releaseRejectedIntent, releaseRejectedIntentFrom, type ReviewEmbeddingIntentStorage } from "./review-embedding-intent.js";
import { runReviewUnderLock } from "./review-helpers.js";

/** The three project steps one rejection takes, for ONE project. No member takes a project root. */
export interface ReviewRejectSteps {
  /** Archive the candidate under re-captured custody, calling `beforeArchive` with its captured bytes first; false when it was not archived. */
  archive(id: string, beforeArchive: (bytes: Buffer) => Promise<void>): Promise<boolean>;
  /** Release the review intent keyed by the captured record bytes, handing its pages to `handOff`. */
  releaseIntent(recordBytes: Buffer, handOff: (pageIds: PageId[]) => Promise<void>): Promise<void>;
  /** Queue released pages for an embedding retry; the ids the queue could NOT record. */
  queueRetry(pageIds: PageId[]): Promise<PageId[]>;
}

/** LOCAL DISK. The incumbent root forms for `root`, each called when asked; building them does no I/O. */
function diskReviewRejectSteps(root: string): ReviewRejectSteps {
  return {
    archive: (id, beforeArchive) => archiveRejectedCandidate(root, id, beforeArchive),
    releaseIntent: (recordBytes, handOff) => releaseRejectedIntent(root, recordBytes, handOff),
    queueRetry: (pageIds) => queueScopedEmbeddingRetry(root, pageIds),
  };
}

/**
 * The steps over each one's own root-free body: THE ONE BOUND COMPOSITION.
 * `moveRoot` is only the value the archive move's legacy field receives. Building
 * it does no I/O.
 */
export function reviewRejectStepsOver(seams: {
  custody: CandidateStoreMoveReads; moveRoot: string; intent: ReviewEmbeddingIntentStorage; markers: EmbeddingMarkerStorage;
}): ReviewRejectSteps {
  return {
    archive: (id, beforeArchive) => archiveRejectedCandidateFrom(seams.custody, seams.moveRoot, id, beforeArchive),
    releaseIntent: (recordBytes, handOff) => releaseRejectedIntentFrom(seams.intent, recordBytes, handOff),
    queueRetry: (pageIds) => queueScopedEmbeddingRetryFrom(seams.markers, pageIds),
  };
}

/** Reject a pending candidate by archiving its JSON record. */
export default async function reviewRejectCommand(id: string): Promise<void> {
  await runReviewUnderLock(id, rejectUnderLock, loadRejectableCandidateOrFail);
}

/** Archive the candidate while holding the lock; the helper reports every refusal. */
async function rejectUnderLock(root: string, id: string): Promise<void> {
  return rejectCandidateWith(diskReviewRejectSteps(root), id);
}

/** {@link rejectUnderLock} over {@link ReviewRejectSteps}: THE ONE BODY. The caller holds the review lock. */
export async function rejectCandidateWith(steps: ReviewRejectSteps, id: string): Promise<void> {
  const released = await steps.archive(id, bytes =>
    steps.releaseIntent(bytes, pageIds => handOffEmbeddingWork(steps, pageIds)));
  if (!released) return;
  output.status(
    "-",
    output.warn(`Rejected candidate ${id} — archived, wiki unchanged.`),
  );
}

/**
 * Queue released pages like a finished batch would. Disabled refreshes touch no
 * retry file: the next enabled refresh rediscovers these pages by their stale
 * vectors and admits any whose content differs from an excluded attempt.
 */
async function handOffEmbeddingWork(steps: ReviewRejectSteps, pageIds: PageId[]): Promise<void> {
  if (pageIds.length === 0 || embeddingsDisabled()) return;
  const unrecorded = await steps.queueRetry(pageIds);
  if (unrecorded.length === 0) return;
  throw new Error(
    `Embedding retry queue is full: ${unrecorded.length} page(s) from an interrupted batch could not be queued. ` +
    "Run `llmwiki compile` to work through queued embeddings, then retry; the candidate was not rejected.",
  );
}
