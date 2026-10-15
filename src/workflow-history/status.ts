/**
 * @file src/workflow-history/status.ts
 * @description The read-only `status` operation: classify run(s) against the
 * active profile config.
 *
 * `status` reports how each persisted run relates to the CURRENT profile, so a
 * config change between start and resume is surfaced rather than silently
 * mis-resumed. It is strictly read-only: it takes NO lock, creates nothing, and
 * NEVER repairs a malformed run — an unavailable/corrupt record is SURFACED as a
 * `problem`, not auto-fixed, and an unknown run id is a fail-closed `problem`
 * too (never a throw). The active profile is loaded ONCE and threaded through the
 * per-run classification.
 *
 * ## Classification
 *  - `current`: the run's def digest still matches AND every known stage (and the
 *    current stage) still exists in the active def.
 *  - `needs-adaptation`: the def changed (digest differs) but the run's current
 *    stage still maps into the active def.
 *  - `blocked-by-config`: the run sits on a stage the active def no longer
 *    declares — it cannot be acted on under the current config. Also used for an
 *    absent/unavailable run record and an unknown run id (with a `problem`).
 *  - `historical`: the run is terminal, OR its workflow was removed from the
 *    profile — readable history only, not actionable.
 */

import { diskWorkflowStatusSources, scopeStatusToWorkflow, workflowStatusFrom, type RunStatus } from "./status-read.js";

export { classifyRun } from "./status-read.js";
export type { RunClassification, RunStatus } from "./status-read.js";

/**
 * Status of one run (by id) or of all runs in the project.
 *
 * Read-only: takes no lock and creates nothing. With a `runId`, an
 * unresolvable/invalid id is a fail-closed `problem` (`blocked-by-config`) — the
 * caller asked about a specific id, so an empty result would hide the reason.
 * Without a `runId`, every run under the project is classified — and an
 * UNAVAILABLE run store (escape / read failure) is surfaced as a `problem` row
 * rather than reported as "no runs", so a broken store never reads as clean. A
 * malformed run record is surfaced as a `problem`, never repaired and never thrown.
 *
 * @param root - Absolute project root.
 * @param runId - When given, report on just this run; otherwise report on all.
 * @returns One {@link RunStatus} per run (a single entry in the single-id case).
 */
export async function workflowStatus(root: string, runId?: string): Promise<RunStatus[]> {
  return workflowStatusFrom(diskWorkflowStatusSources(root), runId);
}

/**
 * Status of all runs, OBJECT-SCOPE-FILTERED to `workflowId`. Three row kinds are
 * handled distinctly so a workflow-scoped view stays fail-visible WITHOUT leaking
 * another workflow's run identity:
 *  - STORE-LEVEL health (`storeLevel === true`) → ALWAYS kept (global health, not
 *    workflow-specific).
 *  - a READABLE run → kept IFF `run.workflowId === workflowId` (object scope).
 *  - a PER-RUN problem (`run === undefined && !storeLevel`: an unreadable/corrupt
 *    individual run carrying its REAL runId) → its id is UNSCOPABLE to this
 *    workflow, so it is NEVER exposed; if ANY are seen they are replaced by ONE
 *    redacted aggregate (fail-visible, id-free, count-free).
 *
 * The scope is {@link scopeStatusToWorkflow}, applied to this project's own
 * {@link workflowStatus}; `workflowStatusForWorkflowFrom` applies it over sources.
 *
 * @param root - Absolute project root.
 * @param workflowId - The workflow to scope readable runs to.
 * @returns Store-level health + readable `workflowId` runs + (if any) one aggregate.
 */
export async function workflowStatusForWorkflow(root: string, workflowId: string): Promise<RunStatus[]> {
  return scopeStatusToWorkflow(await workflowStatus(root), workflowId);
}
