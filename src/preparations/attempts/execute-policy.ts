/**
 * @file src/preparations/attempts/execute-policy.ts
 * @description The attempt executor's PURE commit policy, split out of
 * `execute.ts` so the orchestrator stays within the size limit: the drift checks
 * a late result is held to (pin, grant, backend readiness, per-receipt), the
 * sealed-bound and spend checks, the effect recording rule, the cancellation and
 * leg-fault park reasons and their durable problem codes, and the projectors the
 * park and the settlement append. Nothing here reads or writes anything: every
 * function decides over values the orchestrator already holds, so the executor's
 * decisions are unchanged by where they live. `ephemeral-execute.ts` shares the
 * bound check through `execute.ts`'s re-export.
 */

import { externalEffectReceiptDigest } from "../../capability-providers/brokers/receipts.js";
import type { AttemptId } from "../ids.js";
import type { EffectSummaryV1, PhaseSummaryV1, PreparationRunProblemCode } from "../run-types.js";
import type { PreparationRunContentProjector } from "../run-store.js";
import { upsertPhaseSummary } from "./start.js";
import type { AttemptEffectObservationV1, AttemptLegOutcomeV1, SealedAttemptContextV1 } from "./types.js";

/** The one park reason a CANCELLATION produces; see {@link parkProblemCode}. */
const CANCEL_EFFECT_UNCERTAIN = "cancel-effect-uncertain";
/**
 * The park reason a required leg's own FAULT records — an unknown-state leg,
 * which retry refuses.
 */
export const LEG_FAULT_PARK = "leg-fault";

/** External-effect outcomes that cannot land without honest recording (a later task). */
const APPLIED_OR_UNKNOWN_EFFECTS = new Set(["applied", "already-applied", "outcome-unknown"]);

/** Emit an optional field only when defined. */
export function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/** Compare one observed pin/grant pair against the sealed authority. */
function pinGrantDrift(
  sealed: SealedAttemptContextV1, observedPin: string | undefined, observedGrant: string | undefined,
): "provider-pin-drift" | "grant-drift" | null {
  const pin = sealed.authority.providerPinDigest;
  const grant = sealed.authority.grantSnapshotDigest;
  if (pin !== undefined && observedPin !== undefined && observedPin !== pin) return "provider-pin-drift";
  if (grant !== undefined && observedGrant !== undefined && observedGrant !== grant) return "grant-drift";
  return null;
}

/** Detect provider-pin, grant, or backend-readiness drift observed during the leg. */
export function observedDrift(sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1): string | null {
  const backend = sealed.authority.backendReadinessDigest;
  if (backend !== undefined && outcome.observedBackendReadinessDigest !== undefined && outcome.observedBackendReadinessDigest !== backend) {
    return "backend-readiness-drift";
  }
  const top = pinGrantDrift(sealed, outcome.observedProviderPinDigest, outcome.observedGrantSnapshotDigest);
  if (top !== null) return top;
  for (const { receipt } of outcome.effects) {
    const drift = pinGrantDrift(sealed, receipt.providerPinDigest, receipt.grantSnapshotDigest);
    if (drift !== null) return `receipt-${drift}`;
  }
  return null;
}

type EffectRecording =
  | { safe: true; effects: readonly EffectSummaryV1[] }
  | { safe: false; reason: string };

/** Record benign external effects honestly; park on any applied/unknown effect. */
export function recordEffects(attemptId: AttemptId, observations: readonly AttemptEffectObservationV1[]): EffectRecording {
  if (observations.some((observation) => APPLIED_OR_UNKNOWN_EFFECTS.has(observation.receipt.outcome))) {
    return { safe: false, reason: "external-effect-unrecorded" };
  }
  const effects = observations.map((observation): EffectSummaryV1 => ({
    attemptId, effectIndex: observation.effectIndex, outcome: observation.receipt.outcome,
    receiptDigest: externalEffectReceiptDigest(observation.receipt),
  }));
  return { safe: true, effects };
}

/** A leg outcome that is committed as succeeded and so must fit every ceiling. */
function isSuccessOutcome(outcome: AttemptLegOutcomeV1): boolean {
  return outcome.phaseState === "succeeded" || outcome.phaseState === "succeeded-with-warnings";
}

/**
 * A cancellation delivered MID-FLIGHT (the leg actually ran, invocationCount > 0)
 * to an EFFECT-CAPABLE phase (maximumEffectsPerAttempt > 0) cannot prove no
 * mutating external effect applied before the backend honored the cancel — a
 * cancelled provider result does not surface its in-flight receipts. Such an
 * outcome fails closed to `recovery-required` rather than a false `cancelled`
 * (design section 23.2). A pre-launch cancel (invocationCount 0) and an
 * effect-free phase (maximumEffectsPerAttempt 0) are provably effect-free and
 * settle `cancelled` honestly.
 */
export function cancelEffectUncertain(sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1): string | null {
  if (outcome.phaseState !== "cancelled") return null;
  return outcome.invocationCount > 0 && sealed.bounds.maximumEffectsPerAttempt > 0 ? CANCEL_EFFECT_UNCERTAIN : null;
}

/**
 * A MEASURED usage dimension proven above its sealed ceiling. This is a breach
 * the host observed, not an unproven compliance claim, so it holds for EVERY
 * outcome — a failed or cancelled attempt that burned more than the phase was
 * authorized to spend overran its budget just as a successful one would, and
 * committing it as ordinary settled work would let the overrun settle silently
 * and reach a later retry preview as fact. An unobserved dimension is handled
 * separately (see {@link boundsViolation}): it is a missing proof, not a breach.
 */
function usageExceedsCeiling(usage: number | "unobserved", ceiling: number, dimension: string): string | null {
  if (usage === "unobserved") return null;
  return usage > ceiling ? `${dimension}-exceed-sealed-bound` : null;
}

/** Every measured usage dimension proven above its sealed ceiling, or null. */
function usageBreach(bounds: SealedAttemptContextV1["bounds"], outcome: AttemptLegOutcomeV1): string | null {
  return usageExceedsCeiling(outcome.tokenCount, bounds.maximumTokensPerAttempt, "tokens")
    ?? usageExceedsCeiling(outcome.costMicros, bounds.maximumCostMicrosPerAttempt, "cost");
}

/**
 * Fail closed on an UNPROVEN usage dimension. An `"unobserved"` value means the
 * dimension is APPLICABLE (the capability could consume it) but the runtime did
 * not meter it, so it can never be proven within ANY hard limit (including 0). A
 * proven non-applicable dimension arrives as a measured 0 and passes. This is a
 * success-only check: only a commit as succeeded asserts the attempt stayed
 * within its ceilings, so only a commit needs the proof.
 */
function usageUnproven(outcome: AttemptLegOutcomeV1): string | null {
  if (outcome.tokenCount === "unobserved") return "tokens-unobserved";
  return outcome.costMicros === "unobserved" ? "cost-unobserved" : null;
}

/**
 * Reject a leg outcome that exceeds a sealed phase resource ceiling.
 *
 * A MEASURED token/cost overrun is checked on every outcome; the remaining
 * ceilings — per-object and aggregate output bytes, invocation, broker-request,
 * and effect counts — plus the unobserved-dimension proof apply only to a SUCCESS
 * outcome, whose commit is the claim that the attempt stayed in bounds (RC-B).
 * Exported so the ephemeral read enforces the SAME ceilings before projecting a
 * result, rather than cloning a second, weaker ceiling check.
 */
export function boundsViolation(sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1): string | null {
  const b = sealed.bounds;
  const breach = usageBreach(b, outcome);
  if (breach !== null) return breach;
  if (!isSuccessOutcome(outcome)) return null;
  const aggregate = outcome.pendingEvidence.reduce((sum, item) => sum + item.ref.byteCount, 0);
  if (outcome.pendingEvidence.some((item) => item.ref.byteCount > b.maximumOutputEvidenceBytes)) return "output-bytes-exceed-sealed-bound";
  if (aggregate > b.maximumOutputEvidenceBytes) return "aggregate-output-bytes-exceed-sealed-bound";
  if (outcome.invocationCount > b.maximumInvocationsPerAttempt) return "invocations-exceed-sealed-bound";
  if (outcome.brokerRequestCount > b.maximumBrokerRequestsPerAttempt) return "broker-requests-exceed-sealed-bound";
  if (outcome.effects.length > b.maximumEffectsPerAttempt) return "effects-exceed-sealed-bound";
  return usageUnproven(outcome);
}

/**
 * The durable problem code one park records.
 *
 * Every park used to write the SAME generic obligation, so the record could not
 * say what had gone wrong: a revalidation drift, a bounds violation, a
 * publication failure and a cancellation that could not prove effect-freeness
 * were indistinguishable once written. Anything later deciding whether a
 * `recovery-required` run may be advanced then had nothing durable to read, and a
 * cancellation settlement could carry an unrelated integrity obligation to a
 * terminal. The cancellation park now names itself.
 */
export function parkProblemCode(reason: string): PreparationRunProblemCode {
  if (reason === CANCEL_EFFECT_UNCERTAIN) return "preparation-cancellation-effect-unproven";
  if (reason === LEG_FAULT_PARK) return "preparation-leg-fault";
  return "preparation-integrity-obligation";
}

/**
 * One spend dimension the signed record may carry: a figure that was METERED and
 * that the sealed ceiling ADMITS. Everything else is omitted, and omission reads
 * back as unobserved.
 *
 * Two different absences collapse here on purpose. An unmetered dimension is
 * omitted because a fabricated zero would report a billable attempt as free. An
 * over-ceiling dimension is omitted because a figure above the phase's sealed
 * authorization is not a measurement the record can vouch for — it is either a
 * runtime that overran its budget or a meter that cannot be believed, and there
 * is no way to tell which from the number alone. Clamping it to the ceiling
 * would be worse than either: it would put a figure smaller than the observed
 * spend into signed state and present it as fact, which is exactly the
 * understatement the whole `"unobserved"` sentinel exists to prevent.
 *
 * The loader cannot make this call — `parsePhaseSummary` validates the grammar
 * (bounded nonnegative integer) but never sees the plan, so the sealed ceiling is
 * only knowable here. This is the one place spend enters the run.
 */
function admissibleSpend(usage: number | "unobserved", ceiling: number): number | undefined {
  return usage === "unobserved" || usage > ceiling ? undefined : usage;
}

/**
 * Persist the attempt's admissible metered spend. Named field by field so nothing
 * else from the leg outcome can be spread into the signed summary.
 */
function durableSpend(
  bounds: SealedAttemptContextV1["bounds"], outcome: AttemptLegOutcomeV1,
): { tokenCount?: number; costMicros?: number } {
  return {
    ...optional("tokenCount", admissibleSpend(outcome.tokenCount, bounds.maximumTokensPerAttempt)),
    ...optional("costMicros", admissibleSpend(outcome.costMicros, bounds.maximumCostMicrosPerAttempt)),
  };
}

/** Clear the owner and mark the phase recovery-required on a durable park. */
export function recoveryParkProjector(sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1): PreparationRunContentProjector {
  return (next) => {
    const { executionOwner: _cleared, ...rest } = next;
    const prior = next.phaseSummaries.find((summary) => summary.phaseInstanceId === sealed.phaseInstanceId);
    const summary: PhaseSummaryV1 = {
      phaseInstanceId: sealed.phaseInstanceId, logicalPhaseId: sealed.logicalPhaseId, state: "recovery-required",
      disposition: sealed.disposition, attemptCount: prior?.attemptCount ?? 1, currentAttemptId: sealed.attemptId,
      invocationCount: outcome.invocationCount, brokerRequestCount: outcome.brokerRequestCount, effectCount: 0,
      // CARRIED, not dropped: the leg's own problem is the only durable record
      // of what failed. A park that recorded the state but not the cause left
      // an operator unable to tell a missing tool from an integrity fault.
      ...optional("problem", outcome.problem),
      ...optional("problemDetail", outcome.problemDetail),
      ...durableSpend(sealed.bounds, outcome),
    };
    return { ...rest, phaseSummaries: upsertPhaseSummary(next.phaseSummaries, summary) };
  };
}

/** Build the settled phase summary the commit projects onto the run. */
function settledPhaseSummary(
  sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1, prior: PhaseSummaryV1 | undefined, effectCount: number,
): PhaseSummaryV1 {
  return {
    phaseInstanceId: sealed.phaseInstanceId, logicalPhaseId: sealed.logicalPhaseId, state: outcome.phaseState,
    disposition: sealed.disposition, attemptCount: prior?.attemptCount ?? 1, currentAttemptId: sealed.attemptId,
    ...optional("outputEvidenceDigest", outcome.outputEvidenceDigest),
    invocationCount: outcome.invocationCount, brokerRequestCount: outcome.brokerRequestCount, effectCount,
    ...optional("problem", outcome.problem),
    ...optional("problemDetail", outcome.problemDetail),
    ...durableSpend(sealed.bounds, outcome),
  };
}

/** Project the settled facts, clearing the execution owner (design section 12.5). */
export function settleProjector(
  sealed: SealedAttemptContextV1, outcome: AttemptLegOutcomeV1, effects: readonly EffectSummaryV1[],
): PreparationRunContentProjector {
  return (next) => {
    const { executionOwner: _cleared, ...rest } = next;
    const prior = next.phaseSummaries.find((summary) => summary.phaseInstanceId === sealed.phaseInstanceId);
    return {
      ...rest,
      phaseSummaries: upsertPhaseSummary(next.phaseSummaries, settledPhaseSummary(sealed, outcome, prior, effects.length)),
      evidenceRefs: [...next.evidenceRefs, ...outcome.pendingEvidence.map((item) => item.ref)],
      effectSummaries: [...next.effectSummaries, ...effects],
    };
  };
}

// --- The public entrypoint ----------------------------------------------
