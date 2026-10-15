/**
 * @file src/commands/operation/drive.ts
 * @description `llmwiki operation resume` and `operation compensate` — the two
 * operator recovery-drive commands. Both acquire the project lock under the
 * `recovery` intent (which owns the re-drive and so bypasses the recovery gate),
 * route through the existing locked seams, faithfully report the resulting
 * {@link OperationActionResult}, and release the lock in a `finally`.
 *
 * AUTHORITY: the local drive request carries the CLI operator's grants and the
 * runtime built by `createCliOperationRuntime` (via `buildDriveRequest`), which
 * installs the production operations-authority resolver. So every drive
 * recomputes the authority snapshot from current state: unchanged authority
 * proceeds, genuine drift parks, and unreadable or absent backing state fails
 * closed. Any refusal is surfaced verbatim (state + problem, non-zero exit),
 * never papered over.
 *
 * ONE BODY. {@link operationResumeWith} and {@link operationCompensateWith} own
 * every decision (target resolution, the busy lock, recover-versus-resume from
 * the run's own state, the cancellation trigger, the release, the exit code)
 * over {@link OperationDriveSteps}: the existing `TargetRunReads` plus the lock,
 * the cancel advisory, the drive request (with the host's runtime) and the
 * three locked settlement entries, none of which takes a project root. The
 * operator grants the request carries are the body's; which runtime it carries
 * is the steps'. The commands keep their signatures and pass the disk steps,
 * which call the incumbent root forms when asked.
 */

import { releaseLock } from "../../utils/lock.js";
import { acquireMutationLock } from "../../operation-bundles/lock-gate.js";
import { recoverOperationRunLocked, resumeOperationRecoveryLocked } from "../../operation-bundles/recovery.js";
import { compensateOperationBundleLocked, type CompensationTrigger } from "../../operation-bundles/compensation.js";
import { readCancelRequest, type CancelRequestRead } from "../../operation-bundles/cancel-request.js";
import type { ApproveOperationBundleRequest, OperationActionResult } from "../../operation-bundles/executor.js";
import type { OperationRunId } from "../../operation-bundles/ids.js";
import type { OperationGrant } from "../../operation-bundles/principal.js";
import {
  buildDriveRequest, diskTargetRunReads, resolveTarget, type ResolvedTarget, type TargetRunReads,
} from "./resolve.js";
import { driveExitCode, emitJson, renderActionResult, reportFailure } from "./render.js";

/** CLI options shared by the recovery-drive commands. */
export interface OperationDriveOptions {
  /** Emit the machine-readable action envelope instead of the human summary. */
  json?: boolean;
}

/** What one recovery drive asks of the project. No member takes a project root. */
export interface OperationDriveSteps extends TargetRunReads {
  /** The project lock under the `recovery` intent: a MECHANISM, no decision. */
  readonly lock: { acquire(): Promise<boolean>; release(): Promise<void> };
  /** The run's cancellation advisory. */
  readCancel(workspaceId: string, runId: OperationRunId): Promise<CancelRequestRead>;
  /** The drive request for a resolved target under `grants`, carrying the host's operation runtime. */
  request(resolved: ResolvedTarget, grants: readonly OperationGrant[]): ApproveOperationBundleRequest;
  /** Re-drive a crash-interrupted `applying` run; the caller holds the lock. */
  recover(request: ApproveOperationBundleRequest): Promise<OperationActionResult>;
  /** Operator resume of a parked run; the caller holds the lock. */
  resume(request: ApproveOperationBundleRequest): Promise<OperationActionResult>;
  /** Compensate under the closed eligibility rule; the caller holds the lock. */
  compensate(request: ApproveOperationBundleRequest, trigger: CompensationTrigger): Promise<OperationActionResult>;
}

/** LOCAL DISK. The target reads, the recovery-intent lock, the advisory and the locked seams for `root`, each called when asked. */
function diskOperationDriveSteps(root: string): OperationDriveSteps {
  return {
    ...diskTargetRunReads(root),
    lock: { acquire: () => acquireMutationLock(root, "recovery"), release: () => releaseLock(root) },
    readCancel: (workspaceId, runId) => readCancelRequest(root, workspaceId, runId),
    request: (resolved, grants) => buildDriveRequest(resolved, grants),
    recover: (request) => recoverOperationRunLocked(root, request),
    resume: (request) => resumeOperationRecoveryLocked(root, request),
    compensate: (request, trigger) => compensateOperationBundleLocked(root, request, trigger),
  };
}

/** One recovery-drive action over a resolved target under the held lock. */
type DriveAction = (resolved: ResolvedTarget) => Promise<OperationActionResult>;

/** Run one action under the recovery-intent project lock, or report a busy lock. */
async function underRecoveryLock(steps: OperationDriveSteps, action: () => Promise<OperationActionResult>): Promise<OperationActionResult | "lock-busy"> {
  const acquired = await steps.lock.acquire();
  if (!acquired) return "lock-busy";
  try {
    return await action();
  } finally {
    await steps.lock.release();
  }
}

/** The machine-readable envelope for one drive result. */
function driveEnvelope(result: OperationActionResult): Record<string, unknown> {
  return { bundleId: result.bundleId, runId: result.runId, state: result.state, counters: result.counters, problems: result.problems };
}

/** Resolve the target, drive it under the lock, and render/emit the result. */
async function runDrive(steps: OperationDriveSteps, target: string, verb: string, json: boolean | undefined, action: DriveAction): Promise<number> {
  const inventory = await steps.inventory();
  const resolved = resolveTarget(inventory, target);
  if (resolved === null) return reportFailure(`No operation bundle or run matches "${target}".`);
  const result = await underRecoveryLock(steps, () => action(resolved));
  if (result === "lock-busy") return reportFailure("Another llmwiki process is using this project; not driving recovery.");
  if (json) emitJson(driveEnvelope(result));
  else renderActionResult(result, verb);
  return driveExitCode(result);
}

/** True when the resolved target's run is a crash-interrupted `applying` run. */
async function isApplyingRun(steps: OperationDriveSteps, resolved: ResolvedTarget): Promise<boolean> {
  const keyEpochId = await steps.keyEpoch();
  if (keyEpochId === null) return false;
  const read = await steps.run(resolved, keyEpochId);
  return read.status === "ok" && read.run.state === "applying";
}

/**
 * Resume drive: a crash-interrupted `applying` run is re-driven by observation
 * ({@link recoverOperationRunLocked}); any other run is treated as an explicit
 * operator resume of a parked `recovery-required` run ({@link resumeOperationRecoveryLocked}),
 * which itself refuses a run that is not parked.
 */
async function resumeAction(steps: OperationDriveSteps, resolved: ResolvedTarget): Promise<OperationActionResult> {
  const request = steps.request(resolved, ["operation-bundle.approve"]);
  return (await isApplyingRun(steps, resolved))
    ? steps.recover(request)
    : steps.resume(request);
}

/** Compensate drive: a pending cancel advisory selects the cancellation trigger. */
async function compensateAction(steps: OperationDriveSteps, resolved: ResolvedTarget): Promise<OperationActionResult> {
  const cancel = await steps.readCancel(resolved.workspaceId, resolved.runId);
  const trigger: CompensationTrigger = cancel.status === "present" ? "cancellation" : "apply-failure";
  return steps.compensate(steps.request(resolved, ["operation-bundle.approve"]), trigger);
}

/**
 * Resume a parked (or crash-interrupted) operation run toward settlement.
 *
 * @param root - The project root.
 * @param target - A run id or bundle id.
 * @param options - `--json` toggles the machine-readable envelope.
 * @returns 0 on a clean settlement, 1 on refusal/park/problems.
 */
export function operationResumeCommand(root: string, target: string, options: OperationDriveOptions = {}): Promise<number> {
  return operationResumeWith(diskOperationDriveSteps(root), target, options);
}

/** {@link operationResumeCommand} over {@link OperationDriveSteps}: THE ONE BODY. */
export function operationResumeWith(steps: OperationDriveSteps, target: string, options: OperationDriveOptions = {}): Promise<number> {
  return runDrive(steps, target, "resume", options.json, (resolved) => resumeAction(steps, resolved));
}

/**
 * Compensate an operation run's applied effects under the closed eligibility rule.
 *
 * @param root - The project root.
 * @param target - A run id or bundle id.
 * @param options - `--json` toggles the machine-readable envelope.
 * @returns 0 on a clean compensation, 1 on refusal/park/problems.
 */
export function operationCompensateCommand(root: string, target: string, options: OperationDriveOptions = {}): Promise<number> {
  return operationCompensateWith(diskOperationDriveSteps(root), target, options);
}

/** {@link operationCompensateCommand} over {@link OperationDriveSteps}: THE ONE BODY. */
export function operationCompensateWith(steps: OperationDriveSteps, target: string, options: OperationDriveOptions = {}): Promise<number> {
  return runDrive(steps, target, "compensate", options.json, (resolved) => compensateAction(steps, resolved));
}
