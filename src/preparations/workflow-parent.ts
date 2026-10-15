/**
 * @file src/preparations/workflow-parent.ts
 * @description The one-way verified reference from a preparation to an existing
 * outer workflow run (design section 7.3). The reference is read-only: this
 * module reads the workflow run through the existing workflow store, verifies
 * its identity and digest, and confirms any named stage, but never creates,
 * mutates, re-signs, or re-executes the parent. A missing, unreadable, or
 * drifted parent parks the preparation; it is never silently recreated. The
 * workflow store records `workflowDigest` as bare lowercase hex, so the plan's
 * `sha256:`-prefixed reference digest is stripped before comparison.
 *
 * ONE VERDICT over the one run read. {@link verifyWorkflowParent} keeps its
 * signature and asks the incumbent root reader; {@link verifyWorkflowParentFrom}
 * asks the run store's own body over {@link WorkflowRunReads}. In no package index.
 */

import { readRun, readRunFrom, type WorkflowRunRead, type WorkflowRunReads } from "../workflow-history/store.js";
import type { WorkflowRunStatus } from "../workflow-history/types.js";
import type { WorkflowParentRefV1 } from "./types.js";

const SHA256_PREFIX = "sha256:";

/**
 * The complete verification outcome for one workflow-parent reference. A
 * `verified` outcome carries the parent's live `runStatus` and `currentStage`
 * so the STAGING admission can additionally require a running parent whose
 * current stage matches — a lifecycle gate this identity check deliberately
 * does NOT impose (a parent may legitimately be `pending` when its identity is
 * verified elsewhere).
 */
export type WorkflowParentVerification =
  | { status: "verified"; workflowId: string; stageId?: string; runStatus: WorkflowRunStatus; currentStage: string | null }
  | { status: "absent" }
  | { status: "unreadable"; detail: string }
  | { status: "drift"; detail: "workflow-id" | "digest" | "stage" };

/** Compare the run's bare-hex workflow digest to the ref's prefixed digest. */
function digestMatches(runDigest: string, refDigest: string): boolean {
  if (!refDigest.startsWith(SHA256_PREFIX)) return false;
  return runDigest === refDigest.slice(SHA256_PREFIX.length);
}

/**
 * Verify one workflow-parent reference against the live workflow run. The
 * caller parks the preparation on any non-`verified` outcome; this function has
 * no write path and returns distinct absent, unreadable, and drift reasons so
 * park-versus-deny classification stays exact at every read leg.
 */
export async function verifyWorkflowParent(
  root: string,
  ref: WorkflowParentRefV1,
): Promise<WorkflowParentVerification> {
  return parentVerificationOf(await readRun(root, ref.workflowRunId), ref);
}

/** {@link verifyWorkflowParent} over the run store's reads: the same verdict over the store's one body. */
export async function verifyWorkflowParentFrom(
  runs: WorkflowRunReads,
  ref: WorkflowParentRefV1,
): Promise<WorkflowParentVerification> {
  return parentVerificationOf(await readRunFrom(runs, ref.workflowRunId), ref);
}

/** The verdict over one run read: absent, unreadable, a drift, or verified with the parent's live state. Pure. */
function parentVerificationOf(read: WorkflowRunRead, ref: WorkflowParentRefV1): WorkflowParentVerification {
  if (read.status === "absent") return { status: "absent" };
  if (read.status !== "ok") return { status: "unreadable", detail: read.detail };
  const run = read.run;
  if (run.workflowId !== ref.workflowId) return { status: "drift", detail: "workflow-id" };
  if (!digestMatches(run.workflowDigest, ref.workflowDigest)) return { status: "drift", detail: "digest" };
  if (ref.stageId !== undefined && !run.knownStageIds.includes(ref.stageId)) {
    return { status: "drift", detail: "stage" };
  }
  return {
    status: "verified", workflowId: run.workflowId,
    runStatus: run.status, currentStage: run.currentStage,
    ...(ref.stageId === undefined ? {} : { stageId: ref.stageId }),
  };
}
