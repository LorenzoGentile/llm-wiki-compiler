/**
 * Read and plan batch approvals under the caller's project lock. All candidates
 * are read before writes; known validation refusals are individual outcomes,
 * while unexpected storage failures abort the operation. Conflicting target
 * identities are refused as a group so input order cannot decide an overwrite.
 *
 * ONE BODY. {@link planReviewBatchWith} owns every decision: the per-item order
 * (read, pins, validated-answer refusal, destination precondition, generic
 * citation refusal, typed or default plan), which errors are individual
 * refusals, the target-conflict group refusal, then the relation gate and the
 * source-snapshot conflicts. It runs over {@link ReviewBatchPlanSteps}, none of
 * which takes a project root. {@link planReviewBatch} keeps its signature and
 * passes the local steps, which call the incumbent root forms (including the
 * default page planner, with its rooted input) when asked, with exactly their
 * old arguments. The lock stays with the caller.
 */

import { readCandidate, UnsafeCandidateIdError } from "../compiler/candidates.js";
import { validateWikiPage } from "../utils/markdown.js";
import { sha256Text } from "../connectors/hash.js";
import { planTypedCandidate } from "../trust/promote.js";
import { ResourceLimitError } from "../trust/checks.js";
import type { PagePlannedMutation } from "../trust/planner.js";
import type { ReviewCandidate } from "../utils/types.js";
import { connectorPinMatches, isTypedPromotionRefusal, planDefaultCandidateWrite } from "./review-approve.js";
import type { ReviewBatchItem, ReviewBatchCandidateResult } from "./review-batch-types.js";
import { candidatePageNamespace } from "./review-finalize.js";
import { rejectBatchRelationGates } from "./review-batch-gates.js";
import { rejectSourceSnapshotConflicts } from "./review-batch-sources.js";
import { targetUnchangedSincePropose } from "./review-target-precondition.js";
import { genericPublicationRefusal, isValidatedAnswer } from "./review-publication.js";

/** One candidate and its validated mutations, linked to its output entry. */
export interface PlannedReviewApproval {
  candidate: ReviewCandidate;
  planned: PagePlannedMutation[];
  result: ReviewBatchCandidateResult;
}

/** The project steps one batch plan takes, per candidate and then once for the batch. No member takes a project root. */
export interface ReviewBatchPlanSteps {
  /** The under-lock candidate re-read with strict I/O: the candidate, or null when missing or malformed. */
  readCandidate(id: string): Promise<ReviewCandidate | null>;
  /** Whether the destination still satisfies the proposal's pins. */
  targetUnchanged(candidate: ReviewCandidate): Promise<boolean>;
  /** The generic citation refusal for a default candidate, or undefined. */
  publicationRefusal(candidate: ReviewCandidate): Promise<string | undefined>;
  /** The typed promotion plan; throws its typed refusals. */
  planTyped(candidate: ReviewCandidate): Promise<PagePlannedMutation[]>;
  /** The trust planner's mutations for a default candidate. */
  planDefault(candidate: ReviewCandidate): Promise<PagePlannedMutation[]>;
  /** The batch relation gate over the conflict-free approvals. */
  relationGates(approvals: PlannedReviewApproval[]): Promise<PlannedReviewApproval[]>;
}

/** LOCAL DISK. The incumbent root forms for `root`, each called when asked with its old arguments. */
function diskReviewBatchPlanSteps(root: string): ReviewBatchPlanSteps {
  return {
    readCandidate: (id) => readCandidate(root, id, { strictIo: true }),
    targetUnchanged: (candidate) => targetUnchangedSincePropose(root, candidate),
    publicationRefusal: (candidate) => genericPublicationRefusal(root, candidate),
    planTyped: (candidate) => planTypedCandidate(root, candidate),
    planDefault: (candidate) => planDefaultCandidateWrite(root, candidate),
    relationGates: (approvals) => rejectBatchRelationGates(root, approvals),
  };
}

/** Expected per-candidate refusal; unexpected errors must stop the shared batch. */
class CandidateValidationError extends Error {}

/** Deduplicate IDs and mark ambiguous body pins without silently choosing one. */
export function uniqueBatchItems(items: ReviewBatchItem[]): {
  items: ReviewBatchItem[];
  results: ReviewBatchCandidateResult[];
} {
  const unique = new Map<string, ReviewBatchItem>();
  const conflicts = new Set<string>();
  for (const item of items) {
    const existing = unique.get(item.id);
    if (existing && existing.draftContentHash !== item.draftContentHash) conflicts.add(item.id);
    if (!existing) unique.set(item.id, item);
  }
  return {
    items: [...unique.values()],
    results: [...unique.keys()].map((id) => conflicts.has(id)
      ? { id, status: "conflict", error: "Duplicate ID has conflicting content hashes." }
      : { id, status: "failed" }),
  };
}

/** Plan the valid subset, retaining known refusals and rejecting every target contender. */
export async function planReviewBatch(
  root: string,
  items: ReviewBatchItem[],
  results: ReviewBatchCandidateResult[],
): Promise<PlannedReviewApproval[]> {
  return planReviewBatchWith(diskReviewBatchPlanSteps(root), items, results);
}

/** {@link planReviewBatch} over {@link ReviewBatchPlanSteps}: THE ONE BODY. */
export async function planReviewBatchWith(
  steps: ReviewBatchPlanSteps,
  items: ReviewBatchItem[],
  results: ReviewBatchCandidateResult[],
): Promise<PlannedReviewApproval[]> {
  const approvals: PlannedReviewApproval[] = [];
  for (const [index, item] of items.entries()) {
    const result = results[index];
    if (result.status === "conflict") continue;
    const approval = await planOneCandidate(steps, item, result);
    if (approval) approvals.push(approval);
  }
  const ungated = await steps.relationGates(rejectTargetConflicts(approvals));
  return rejectSourceSnapshotConflicts(ungated);
}

/** Validate one under-lock candidate without suppressing an unexpected I/O error. */
async function planOneCandidate(
  steps: ReviewBatchPlanSteps,
  item: ReviewBatchItem,
  result: ReviewBatchCandidateResult,
): Promise<PlannedReviewApproval | null> {
  try {
    const candidate = await steps.readCandidate(item.id);
    if (!candidate) throw new CandidateValidationError("Candidate missing or malformed.");
    if (!candidateHashMatches(candidate, item.draftContentHash)) {
      throw new CandidateValidationError("Content hash missing or stale; re-review required.");
    }
    await checkBatchPublication(steps, candidate);
    const planned = candidate.targetEntityType
      ? await steps.planTyped(candidate)
      : await planDefaultCandidate(steps, candidate);
    const namespace = candidatePageNamespace(candidate);
    result.pagePath = `wiki/${namespace}/${candidate.slug}.md`;
    return { candidate, planned, result };
  } catch (error) {
    if (!isCandidateRefusal(error)) throw error;
    result.status = "invalid";
    result.error = error.message;
    return null;
  }
}

/** Preserve shared target/citation policy while keeping validated answers on the single path. */
async function checkBatchPublication(steps: ReviewBatchPlanSteps, candidate: ReviewCandidate): Promise<void> {
  if (isValidatedAnswer(candidate)) {
    throw new CandidateValidationError("Validated answers must be approved individually with review approve.");
  }
  if (!(await steps.targetUnchanged(candidate))) {
    throw new CandidateValidationError("Target page changed since this proposal; re-propose against the current page.");
  }
  const problem = await steps.publicationRefusal(candidate);
  if (problem) throw new CandidateValidationError(problem);
}

/** Require connector pins and honor optional body pins for every other candidate. */
function candidateHashMatches(candidate: ReviewCandidate, supplied: string | undefined): boolean {
  if (!connectorPinMatches(candidate, supplied)) return false;
  return supplied === undefined || sha256Text(candidate.body) === supplied;
}

/** Recognize only expected validation errors; never downgrade unknown storage faults. */
function isCandidateRefusal(error: unknown): error is Error {
  return error instanceof CandidateValidationError || error instanceof UnsafeCandidateIdError ||
    error instanceof ResourceLimitError || isTypedPromotionRefusal(error);
}

/** Apply the same default-page title and trust-planner gates as single approval. */
async function planDefaultCandidate(steps: ReviewBatchPlanSteps, candidate: ReviewCandidate): Promise<PagePlannedMutation[]> {
  if (!validateWikiPage(candidate.body)) throw new CandidateValidationError("Candidate failed page validation.");
  const planned = await steps.planDefault(candidate);
  if (planned.length === 0) throw new CandidateValidationError("Candidate blocked by the write planner.");
  return planned;
}

/** Refuse portable target aliases, even if neither target exists on this filesystem. */
function rejectTargetConflicts(approvals: PlannedReviewApproval[]): PlannedReviewApproval[] {
  const counts = new Map<string, number>();
  for (const { result } of approvals) {
    const key = portableTargetKey(result.pagePath!);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return approvals.filter(({ result }) => {
    if (counts.get(portableTargetKey(result.pagePath!)) === 1) return true;
    result.status = "conflict";
    result.error = "Multiple candidates target the same wiki page under portable case/Unicode comparison.";
    return false;
  });
}

/**
 * Compare conservatively on every platform: case-sensitive hosts also refuse
 * aliases that could overwrite each other when moved to a case-insensitive or
 * normalization-insensitive filesystem. This key never changes a stored path.
 */
function portableTargetKey(pagePath: string): string {
  // Expansion is intentional: default macOS filesystems alias `Straße` and
  // `STRASSE`, so accepting both would pass planning and collide during writes.
  return pagePath.normalize("NFD").toLowerCase().toUpperCase().normalize("NFD");
}
