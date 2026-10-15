/**
 * @file src/commands/operation/cancel.ts
 * @description `llmwiki operation cancel <target>` — write the lock-free advisory
 * cancellation request (design v2 section 18). The advisory is create-only and
 * non-authoritative: it never settles state itself; a later lock holder observes
 * it and appends the signed cancellation transition. The command reports
 * `created` or `exists` and refuses (non-zero) only when the run has already
 * reached a terminal state, where a cancel advisory can never take effect.
 *
 * ONE BODY. {@link operationCancelCommandWith} decides over
 * {@link OperationCancelSteps}, none of which takes a project root: the target's
 * resolution refusal, the cancellable-state refusal and the report. The lock-free
 * advisory write and the clock are MECHANISM steps.
 */

import * as output from "../../utils/output.js";
import { writeCancelRequestLockFree, type CancelRequestInput } from "../../operation-bundles/cancel-request.js";
import type { OperationRunState } from "../../operation-bundles/run-types.js";
import { resolveTargetRun, resolveTargetRunFrom, type ResolvedTarget, type TargetRun, type TargetRunReads } from "./resolve.js";
import { CLI_OPERATOR_ID } from "../../cli/shared.js";
import { emitJson, reportFailure } from "./render.js";

/** CLI options for `operation cancel`. */
export interface OperationCancelOptions {
  /** Emit the machine-readable envelope instead of the human line. */
  json?: boolean;
}

/**
 * Run states where cancellation is still meaningful: pre-effect approval states
 * plus the live unsettled states. Every other (terminal) state cannot be affected
 * by an advisory, so the command refuses rather than write dead bytes.
 */
const CANCELLABLE_RUN_STATES: ReadonlySet<OperationRunState> = new Set([
  "awaiting-approval", "approved", "applying", "recovery-required", "compensating",
]);

/** Report the created/exists outcome for humans or machines. */
function reportOutcome(outcome: "created" | "exists", resolved: ResolvedTarget, json: boolean | undefined): void {
  if (json) {
    emitJson({ workspaceId: resolved.workspaceId, bundleId: resolved.bundleId, runId: resolved.runId, cancel: outcome });
    return;
  }
  const line = `Cancel advisory ${outcome} for run ${resolved.runId}.`;
  output.status(outcome === "created" ? "✓" : "i", outcome === "created" ? output.success(line) : output.info(line));
}

/** What `operation cancel` asks of the project. No member takes a project root. */
export interface OperationCancelSteps {
  /** The named target and its authenticated run, or a bounded error. */
  resolve(target: string): Promise<TargetRun>;
  /** MECHANISM: the lock-free, create-only advisory write. */
  writeCancel(input: CancelRequestInput): Promise<"created" | "exists">;
  /** CLOCK: the advisory's timestamp. */
  now(): string;
}

/** LOCAL DISK. The incumbent resolution and advisory write for `root`, each called when asked. */
function diskOperationCancelSteps(root: string): OperationCancelSteps {
  return {
    resolve: (target) => resolveTargetRun(root, target),
    writeCancel: (input) => writeCancelRequestLockFree(root, input),
    now: () => new Date().toISOString(),
  };
}

/** The resolution over its own body and reads, with the caller's advisory write and clock. Building it does no I/O. */
export function operationCancelStepsOver(
  reads: TargetRunReads, writeCancel: OperationCancelSteps["writeCancel"], now: () => string,
): OperationCancelSteps {
  return { resolve: (target) => resolveTargetRunFrom(reads, target), writeCancel, now };
}

/**
 * Write the advisory cancellation request for a run by run id or bundle id.
 *
 * @param root - The project root.
 * @param target - A run id or bundle id.
 * @param options - `--json` toggles the machine-readable envelope.
 * @returns 0 when the advisory is present (created or already existed), 1 when the
 *   target is unknown/unreadable or the run is already terminal.
 */
export async function operationCancelCommand(root: string, target: string, options: OperationCancelOptions = {}): Promise<number> {
  return operationCancelCommandWith(diskOperationCancelSteps(root), target, options);
}

/** {@link operationCancelCommand} over {@link OperationCancelSteps}: THE ONE BODY. */
export async function operationCancelCommandWith(steps: OperationCancelSteps, target: string, options: OperationCancelOptions = {}): Promise<number> {
  const target_ = await steps.resolve(target);
  if ("error" in target_) return reportFailure(target_.error);
  const { resolved, run } = target_;
  if (!CANCELLABLE_RUN_STATES.has(run.state)) {
    return reportFailure(`Run ${resolved.runId} is ${run.state}; a cancel advisory cannot take effect.`);
  }
  const outcome = await steps.writeCancel({
    workspaceId: resolved.workspaceId, runId: resolved.runId, requester: CLI_OPERATOR_ID, at: steps.now(),
  });
  reportOutcome(outcome, resolved, options.json);
  return 0;
}
