/**
 * Batch review approval: one project lock, one journalled page batch, and one
 * shared finalization. Invalid candidates stay pending while valid candidates
 * proceed. Technical failures stop the operation and retain candidates until
 * finalization succeeds. Cleanup is not atomic: an interruption while deleting
 * candidates can leave a partially cleared queue, whose missing IDs are reported
 * on retry. There is no whole-operation transaction or durable approval receipt.
 *
 * ONE BODY. {@link approveReviewBatchWith} owns the whole sequence (manifest
 * validation and dedupe, the lock and its refusal, plan, candidate-access
 * refusal, embedding intent, the retry-capacity refusal, promotion,
 * finalization, candidate cleanup, the completed/partial/failed status, the
 * release) over {@link ReviewBatchSteps}, none of which takes a project root.
 * {@link approveReviewBatch} keeps its signature and passes the local steps,
 * which call the incumbent root forms when asked, so module spies still
 * intercept. The lock is a mechanism the steps carry.
 */

import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { withQuiet } from "../utils/output.js";
import { deleteCandidate } from "../compiler/candidates.js";
import { assertCandidateMutationAccess } from "../compiler/candidate-custody.js";
import { applyApprovedMutationsLocked } from "../trust/executor.js";
import { finalizeReviewApprovals, prepareReviewEmbeddingIntent, timeReviewPhase, type ReviewFinalizeTimings } from "./review-finalize.js";
import type { ReviewEmbeddingIntent } from "./review-embedding-intent.js";
import { planReviewBatch, uniqueBatchItems, type PlannedReviewApproval } from "./review-batch-plan.js";
import type { PlannedMutation } from "../trust/planner.js";
import type { ReviewCandidate } from "../utils/types.js";
import { readReviewBatchManifest } from "./review-batch-input.js";
import { unrecordableScopedIds } from "../utils/embeddings-retry.js";
import { embeddingsDisabled } from "../utils/embeddings-config.js";
import {
  parseReviewBatchManifest,
  REVIEW_BATCH_SCHEMA_VERSION,
  type ReviewBatchCandidateResult,
  type ReviewBatchItem,
  type ReviewBatchManifest,
  type ReviewBatchResult,
} from "./review-batch-types.js";

/** The project steps one batch approval takes. No member takes a project root. */
export interface ReviewBatchSteps {
  /** Take the project lock under the review intent without blocking: false when busy; a gate refusal THROWS. */
  acquireLock(): Promise<boolean>;
  /** Release the project lock. */
  releaseLock(): Promise<void>;
  /** Plan the valid subset, recording each refusal in `results`. */
  plan(items: ReviewBatchItem[], results: ReviewBatchCandidateResult[]): Promise<PlannedReviewApproval[]>;
  /** Refuse unless the candidate store may be mutated (no archive insert needed). */
  assertCandidateAccess(): Promise<void>;
  /** Open the embedding intent for the approved candidates. */
  prepareIntent(candidates: ReviewCandidate[]): Promise<ReviewEmbeddingIntent>;
  /** The page ids the embedding retry marker could not record. */
  unrecordable(pageIds: string[]): Promise<string[]>;
  /** Promote the planned mutations under the held lock. */
  promote(planned: PlannedMutation[]): Promise<unknown>;
  /** The shared review finalization. */
  finalize(candidates: ReviewCandidate[], timings: Partial<ReviewFinalizeTimings>, intent: ReviewEmbeddingIntent): Promise<void>;
  /** Remove one approved candidate from the queue. */
  deleteCandidate(id: string): Promise<unknown>;
}

/** LOCAL DISK. The incumbent root forms for `root`, each called when asked with its old arguments. */
function diskReviewBatchSteps(root: string): ReviewBatchSteps {
  return {
    acquireLock: () => acquireMutationLock(root, "review"),
    releaseLock: () => releaseLock(root),
    plan: (items, results) => planReviewBatch(root, items, results),
    assertCandidateAccess: () => assertCandidateMutationAccess(root, false),
    prepareIntent: (candidates) => prepareReviewEmbeddingIntent(root, candidates),
    unrecordable: (pageIds) => unrecordableScopedIds(root, pageIds),
    promote: (planned) => applyApprovedMutationsLocked(root, planned),
    finalize: (candidates, timings, intent) => finalizeReviewApprovals(root, candidates, timings, { embeddingScope: "affected-only", intent }),
    deleteCandidate: (id) => deleteCandidate(root, id),
  };
}

/** CLI file and output options. */
interface ReviewApproveBatchOptions {
  input: string;
  json?: boolean;
}

/** Read a manifest and print one outcome; JSON mode suppresses all progress output. */
export default async function reviewApproveBatchCommand(options: ReviewApproveBatchOptions): Promise<void> {
  const run = async (): Promise<ReviewBatchResult> => {
    try {
      const manifest = await readReviewBatchManifest(options.input);
      return await approveReviewBatch(process.cwd(), manifest);
    } catch (error) {
      return { ...emptyResult(), status: "failed", error: errorMessage(error) };
    }
  };
  const result = await (options.json ? withQuiet(run) : run());
  if (result.status !== "completed") process.exitCode = 1;
  if (options.json) console.log(JSON.stringify(result));
  else printBatchResult(result);
}

/** Execute an approval manifest under one lock and return a complete structured result. */
export async function approveReviewBatch(root: string, manifest: ReviewBatchManifest): Promise<ReviewBatchResult> {
  return approveReviewBatchWith(diskReviewBatchSteps(root), manifest);
}

/** {@link approveReviewBatch} over {@link ReviewBatchSteps}: THE ONE BODY. */
export async function approveReviewBatchWith(steps: ReviewBatchSteps, manifest: ReviewBatchManifest): Promise<ReviewBatchResult> {
  const started = performance.now();
  const result = emptyResult();
  let locked = false;
  try {
    const validated = parseReviewBatchManifest(manifest);
    const unique = uniqueBatchItems(validated.candidates);
    result.results = unique.results;
    await timeReviewPhase(result.timingsMs, "lockWait", async () => { locked = await steps.acquireLock(); });
    if (!locked) throw new Error("Could not acquire lock. Try again later.");
    await runBatchUnderLock(steps, { ...validated, candidates: unique.items }, result);
    result.status = result.results.every((item) => item.status === "approved") ? "completed" : "partial";
  } catch (error) {
    result.status = "failed";
    result.error = errorMessage(error);
    for (const item of result.results) if (item.status === "failed") item.error = result.error;
  } finally {
    if (locked) await steps.releaseLock();
    result.timingsMs.total = performance.now() - started;
  }
  return result;
}

/** Plan after the shared recovery gate, then preflight storage before promoting the valid subset. */
async function runBatchUnderLock(
  steps: ReviewBatchSteps,
  manifest: ReviewBatchManifest,
  result: ReviewBatchResult,
): Promise<void> {
  let approvals: PlannedReviewApproval[] = [];
  await timeReviewPhase(result.timingsMs, "validation", async () => {
    approvals = await steps.plan(manifest.candidates, result.results);
  });
  if (approvals.length === 0) return;
  await steps.assertCandidateAccess();
  const candidates = approvals.map(approval => approval.candidate);
  const intent = await steps.prepareIntent(candidates);
  await assertRetryCapacity(steps, [...intent.pageIds]);
  await timeReviewPhase(result.timingsMs, "promotion", () =>
    steps.promote(approvals.flatMap((approval) => approval.planned)));
  await steps.finalize(candidates, result.timingsMs, intent);
  result.finalized = true;
  await timeReviewPhase(result.timingsMs, "cleanup", async () => {
    for (const approval of approvals) {
      await steps.deleteCandidate(approval.result.id);
      approval.result.status = "approved";
    }
  });
}

/**
 * Refuse before promotion when the embedding retry marker could not record this
 * batch's known pages, so a full marker leaves every candidate pending instead
 * of failing finalization after the pages are live. Links rewritten during
 * finalization are only known later; their capacity is still checked there.
 */
async function assertRetryCapacity(steps: ReviewBatchSteps, pageIds: string[]): Promise<void> {
  if (embeddingsDisabled()) return;
  const unrecordable = await steps.unrecordable(pageIds);
  if (unrecordable.length === 0) return;
  throw new Error(
    `Embedding retry queue is full: ${unrecordable.length} approved page(s) could not be recorded for retry. ` +
    "Run `llmwiki compile` to work through queued embeddings, then retry; no candidate was approved.",
  );
}

/** Initialize the versioned envelope before reading files or acquiring locks. */
function emptyResult(): ReviewBatchResult {
  return {
    schemaVersion: REVIEW_BATCH_SCHEMA_VERSION,
    status: "completed",
    finalized: false,
    results: [],
    timingsMs: { total: 0 },
  };
}

/** Normalize thrown values for the output contract. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Print a compact human result with refusals and technical errors on stderr. */
function printBatchResult(result: ReviewBatchResult): void {
  for (const item of result.results) {
    const message = `${item.id}: ${item.status}${item.pagePath ? ` → ${item.pagePath}` : ""}`;
    if (item.status === "approved") console.log(message);
    else console.error(`${message}${item.error ? ` (${item.error})` : ""}`);
  }
  if (result.error) console.error(result.error);
}
