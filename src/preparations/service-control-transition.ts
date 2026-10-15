/**
 * @file src/preparations/service-control-transition.ts
 * @description The two moves every OPERATOR CONTROL VERB makes identically:
 * resolve the run it was aimed at, and append one transition under the project
 * lock.
 *
 * EXTRACTED WITH BOTH CALLERS IN HAND, not ahead of them. `fail` and `pause`
 * differ entirely in their preconditions — one drives a planned run terminal, the
 * other holds a checkpointed run — and in nothing else: the same readiness gate,
 * the same run lookup, the same `ordinary` acquisition, the same append, the same
 * release, and the same choice to report a busy lock as a refusal rather than
 * throw. Two copies of that is how one comes to acquire at a different intent, or
 * to release on one path and not another.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN IS THE RUN ID. D-10-9 requires each
 * operation to capture `request.runId` in its OWN synchronous prologue, before
 * any await, because a field re-read after one retargets the durable transition
 * at a run the caller never named. Taking an already-captured `string` here keeps
 * that capture where the rule puts it — a helper that took the request would move
 * the read past the operation's first await and quietly undo the fix.
 *
 * ONE BODY EACH over {@link ControlVerbSteps}, none of which takes a project
 * root: {@link withControlTargetFrom} (readiness, then the run) and
 * {@link appendControlTransitionWith} (the acquisition's two refusals, the
 * fenced append, the release). The lock's acquire and release are the one
 * MECHANISM the steps carry; every decision about their outcome is in the body.
 * The verbs' root forms keep their signatures and pass {@link diskControlVerbSteps},
 * which calls the incumbent root readers, lock and writer when asked;
 * {@link controlVerbStepsOver} composes the reads and the append from each one's
 * own body, with the caller's lock.
 */

import { RecoveryGateError, acquireMutationLock } from "../operation-bundles/lock-gate.js";
// The same pairing `operation drive` uses: the gate acquires, utils releases.
import { releaseLock } from "../utils/lock.js";
import { preparationRunPredecessor } from "./run-integrity.js";
import { appendPreparationTransitionLocked, appendPreparationTransitionWith, type PreparationRunWriteSteps } from "./run-store.js";
import type {
  AppendPreparationTransitionInput, PreparationRunBinding, PreparationRunPredecessor, PreparationRunV1,
} from "./run-types.js";
import {
  resolveHostReadiness, resolveHostReadinessFrom, type HostReadinessV1, type PreparationReadinessReads,
} from "./service-readiness.js";
import {
  resolvePreparationRun, resolvePreparationRunFrom, type PreparationRunLookupReads, type PreparationRunLookupV1,
} from "./service-run-lookup.js";

/** The project lock a control append runs under: a MECHANISM, no decision. `acquire` may throw the gate's refusal. */
export interface ControlLock {
  /** Acquire at `ordinary` intent: true when held, false when busy; THROWS a `RecoveryGateError` when the gate refuses. */
  acquire(): Promise<boolean>;
  /** Release what `acquire` took. */
  release(): Promise<void>;
}

/** What a control verb asks for, in order. No member takes a project root. */
export interface ControlVerbSteps {
  /** Whether the project's own configuration can be read. */
  hostReadiness(): Promise<HostReadinessV1>;
  /** The named run, authenticated, with its binding. */
  resolveRun(runId: string): Promise<PreparationRunLookupV1>;
  /** The project lock. */
  readonly lock: ControlLock;
  /** Append one transition fenced to `expected`, under the held lock. */
  appendTransition(binding: PreparationRunBinding, expected: PreparationRunPredecessor, transition: AppendPreparationTransitionInput): Promise<unknown>;
}

/** LOCAL DISK. The incumbent root readers, lock and writer for `root`, each called when asked. */
export function diskControlVerbSteps(root: string): ControlVerbSteps {
  return {
    hostReadiness: () => resolveHostReadiness(root),
    resolveRun: (runId) => resolvePreparationRun(root, runId),
    lock: { acquire: () => acquireMutationLock(root, "ordinary"), release: () => releaseLock(root) },
    appendTransition: (binding, expected, transition) => appendPreparationTransitionLocked(root, binding, expected, transition),
  };
}

/** The same reads and append over each one's own body, under the caller's `lock`. Building it does no I/O. */
export function controlVerbStepsOver(
  sources: { readiness: PreparationReadinessReads; lookup: PreparationRunLookupReads; runs: PreparationRunWriteSteps }, lock: ControlLock,
): ControlVerbSteps {
  return {
    hostReadiness: () => resolveHostReadinessFrom(sources.readiness),
    resolveRun: (runId) => resolvePreparationRunFrom(sources.lookup, runId),
    lock,
    appendTransition: (binding, expected, transition) => appendPreparationTransitionWith(sources.runs, binding, expected, transition),
  };
}

/** The run a control verb will act on, or the reason it will not. */
type ControlTargetV1 =
  | { readonly ok: true; readonly binding: PreparationRunBinding; readonly run: PreparationRunV1 }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the run one control verb was aimed at: the project is readable, and
 * the named run exists and loads.
 *
 * READINESS FIRST, and it is not an authority check. A project whose own
 * configuration cannot be read must not have a durable transition driven against
 * it; nothing here decides whether the caller MAY act, only whether acting is
 * meaningful.
 *
 * @param steps - The readiness and run reads.
 * @param runId - The run id the operation captured in its synchronous prologue.
 * @returns The bound run, or the refusal reason to report unchanged.
 */
async function resolveControlTarget(steps: ControlVerbSteps, runId: string): Promise<ControlTargetV1> {
  const ready = await steps.hostReadiness();
  if (!ready.ready) return { ok: false, reason: ready.reason ?? "the project is not ready" };
  const resolved = await steps.resolveRun(runId);
  return resolved.ok
    ? { ok: true, binding: resolved.binding, run: resolved.run }
    : { ok: false, reason: resolved.reason };
}

/** Resolve a captured identity, preserving the refusal before invoking a control's own policy. THE ONE BODY. */
export async function withControlTargetFrom<T>(
  steps: ControlVerbSteps, runId: string,
  apply: (binding: PreparationRunBinding, run: PreparationRunV1) => Promise<T>,
): Promise<T | { status: "refused"; reason: string }> {
  const target = await resolveControlTarget(steps, runId);
  if (!target.ok) return { status: "refused", reason: target.reason };
  return apply(target.binding, target.run);
}

/**
 * The one wording for an acquisition that lost the race for the project lock.
 *
 * MODULE-PRIVATE: the three control verbs now receive this as a `reason` on the
 * returned refusal rather than composing it themselves, so exporting it would
 * put a second way to say one thing on the surface.
 */
const BUSY_LOCK_REFUSAL = "project lock is busy";

/** Whether one control transition landed, or the reason it did not. */
export type ControlAppendV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Append one control transition under the project lock.
 *
 * AN `ordinary` INTENT: a control verb appends to one run's history and touches
 * no lifecycle registry, so it must not acquire as though it were destructive.
 *
 * BOTH WAYS THE ACQUISITION CAN DECLINE ARE RETURNED, and the second one was
 * missing while this docblock argued for the first. A busy lock was already a
 * refusal rather than a throw, on the stated ground that "throwing it left
 * `--json` with empty stdout so a consumer got no envelope at all" — and the
 * gate's own refusal, raised from the same call, still threw. That reasoning was
 * applied to one arm of one function and not the other.
 *
 * IT WAS UNREACHABLE UNTIL THE RESET SURFACE SHIPPED, which is why it survived:
 * `acquireMutationLock` is a GATED acquisition, and at `ordinary` it refuses
 * while any lifecycle unit is pending. Nothing that shipped could leave a
 * pending `project-key-reset` unit, so the operator never met this arm. Reset's
 * pass one is now the documented first step of a repair runbook, and it leaves
 * exactly that state — so `fail`, `pause` and `resume` were measured returning
 * exit 1 with an empty `--json` body in the state an operator reaches while
 * repairing their project.
 *
 * The RETURN TYPE changed rather than the message being widened, because a
 * boolean cannot carry the gate's reason, and reporting the gate's refusal as
 * "project lock is busy" would tell an operator to retry something that will
 * refuse identically forever.
 *
 * @param steps - The project lock and the fenced append.
 * @param binding - The run's authenticated binding.
 * @param run - The run as read, supplying the predecessor the append is fenced to.
 * @param transition - The already-built transition, including its actor and instant.
 * @returns That the transition landed, or the honest reason it did not.
 */
export async function appendControlTransitionWith(
  steps: ControlVerbSteps, binding: PreparationRunBinding, run: PreparationRunV1,
  transition: AppendPreparationTransitionInput,
): Promise<ControlAppendV1> {
  return underGatedLock<ControlAppendV1>(steps.lock, (reason) => ({ ok: false, reason }), async () => {
    await steps.appendTransition(binding, preparationRunPredecessor(run), transition);
    return { ok: true };
  });
}

/**
 * Run `work` under a GATED project acquisition, deciding both of its declines
 * once for every operation that takes one (the control verbs, `gate`, `stage`).
 *
 * The gate's own refusal and a busy lock each become `refuse(reason)`, and
 * neither releases anything, because nothing was taken. Any other acquisition
 * fault rethrows. A held lock is released after `work`, however it ends.
 *
 * @param lock - The acquisition MECHANISM: true when held, false when busy, throwing the gate's refusal.
 * @param refuse - Builds the operation's own refusal from a reason.
 * @param work - What runs while the lock is held.
 */
export async function underGatedLock<T>(
  lock: ControlLock, refuse: (reason: string) => T, work: () => Promise<T>,
): Promise<T> {
  let acquired: boolean;
  try {
    acquired = await lock.acquire();
  } catch (error) {
    // THE GATE'S OWN CLASS. `RecoveryGateError` is the base, so this covers every
    // arm the gate has and any it grows — the same classification `prune` and
    // `sweep` already perform at their own acquisition.
    if (error instanceof RecoveryGateError) return refuse(error.message);
    throw error;
  }
  if (!acquired) return refuse(BUSY_LOCK_REFUSAL);
  try {
    return await work();
  } finally {
    await lock.release();
  }
}
