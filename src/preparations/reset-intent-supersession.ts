/**
 * @file src/preparations/reset-intent-supersession.ts
 * @description The supported exit for a reset that recorded its intent and stopped.
 *
 * A first pass writes an unsigned intent marker and waits for the operator to return
 * with the continuation secret. Until they do, the unit is unsettled destructive work:
 * it blocks lifecycle mutation and holds reference completeness. That is correct — but
 * it must not be permanent, and the eligibility check for a NEW reset refuses a healthy
 * key, so ordering supersession behind that check left the state with no way out.
 *
 * Clearing a PRE-PLAN intent destroys nothing: no key was published, no plan was
 * signed, and the marker is deliberately unsigned, so it authorises nothing. The moment
 * the continuation leg materialises key material or custody, the unit stops being a
 * marker and this path refuses — deleting authority-adjacent state to unblock a queue
 * would be a worse defect than the block.
 *
 * The pass is SEQUENTIAL, one unit at a time, in listing order: each unit is
 * classified and, only if it is intent-only under the supplied confirmation, cleared
 * before the next unit is classified. (An earlier version of this header claimed every
 * unit was classified before ANY mutation; the loop never did that, and the order is
 * deliberately unchanged here.) Within one unit the mutation order makes the intent
 * marker the commit point: the empty `bytes/` directory goes first, so a failure there
 * leaves that unit fully intact and still supersedable, rather than stranding a
 * half-cleared unit whose marker is already gone.
 *
 * ONE BODY. `supersedeIntentOnlyUnitsWith` owns the listing refusal, the per-unit
 * classification over the observed names, bytes state and self-bound intent, the
 * confirmation check and the sequence, over {@link IntentSupersessionSteps}. The
 * observation and the clear (bytes first, intent last) stay physical operations in
 * `lifecycle-fs/reset-operations`, reached through the local steps.
 */

import {
  clearResetIntentUnit,
  observeResetIntentUnit,
  type ResetIntentUnitObservation,
} from "./lifecycle-fs/reset-operations.js";
import { listQuarantineUnits } from "./quarantine-move.js";
import { parseResetIntent, type ResetIntentV1 } from "./receipts.js";

/** The only entries a unit may hold before its signed plan takes authority. */
const PRE_PLAN_INTENT_LEAF = "reset-intent.json";
const PRE_PLAN_BYTES_DIRECTORY = "bytes";

/** What one candidate unit is, decided before any mutation happens. */
type SupersedableUnit =
  | { kind: "intent-only"; intent: ResetIntentV1; hasEmptyBytesDirectory: boolean }
  | { kind: "materialized" }
  | { kind: "unavailable" };

/** Closed-parse an observed intent, requiring it to name its own directory. */
function readSelfBoundIntent(
  observation: Extract<ResetIntentUnitObservation, { status: "ok" }>,
  unitId: string,
): ResetIntentV1 | null {
  if (observation.intentBody === undefined) return null;
  try {
    const intent = parseResetIntent(observation.intentBody.toString("utf8"));
    return intent.unitId === unitId ? intent : null;
  } catch {
    return null;
  }
}

/** What the supersession pass asks of the quarantine registry. No member takes a project root. */
export interface IntentSupersessionSteps {
  /** Every quarantine-unit directory id. Local: `listQuarantineUnits(root)`. */
  listUnits(): ReturnType<typeof listQuarantineUnits>;
  /** One unit's entry names, `bytes/` state and intent bytes, without mutating. Local: `observeResetIntentUnit`. */
  observeUnit(unitId: string): Promise<ResetIntentUnitObservation>;
  /** Clear one intent-only unit: the empty `bytes/` first (when present), the marker last. Local: `clearResetIntentUnit`. */
  clearUnit(unitId: string, hasEmptyBytesDirectory: boolean): Promise<void>;
}

/** The local supersession steps for one root, built per call. In no package index. */
function localIntentSupersessionSteps(root: string): IntentSupersessionSteps {
  return {
    listUnits: () => listQuarantineUnits(root),
    observeUnit: (unitId) => observeResetIntentUnit(root, unitId),
    clearUnit: (unitId, hasEmptyBytesDirectory) => clearResetIntentUnit(root, unitId, hasEmptyBytesDirectory),
  };
}

/** Classify one candidate unit without mutating anything. */
async function classifyUnit(steps: IntentSupersessionSteps, unitId: string): Promise<SupersedableUnit> {
  const observation = await steps.observeUnit(unitId);
  if (observation.status !== "ok") return { kind: "unavailable" };
  if (!observation.names.includes(PRE_PLAN_INTENT_LEAF)) return { kind: "materialized" };
  const extra = observation.names.filter((name) =>
    name !== PRE_PLAN_INTENT_LEAF && name !== PRE_PLAN_BYTES_DIRECTORY);
  if (extra.length > 0) return { kind: "materialized" };
  const hasBytesEntry = observation.names.includes(PRE_PLAN_BYTES_DIRECTORY);
  const hasEmptyBytesDirectory = hasBytesEntry && observation.bytes === "empty";
  if (hasBytesEntry && !hasEmptyBytesDirectory) return { kind: "materialized" };
  const intent = readSelfBoundIntent(observation, unitId);
  if (intent === null) return { kind: "unavailable" };
  return { kind: "intent-only", intent, hasEmptyBytesDirectory };
}

/**
 * Supersede every intent-only reset unit whose recorded reason demands exactly the
 * confirmation the caller supplied, returning the ids cleared. Runs BEFORE the
 * new-reset eligibility check so a healthy key cannot make a stale marker permanent.
 *
 * A unit whose continuation leg has materialised state is left completely untouched:
 * it is not superseded here and it is not deleted anywhere else, so the operator keeps
 * whatever recovery its own protocol affords.
 */
export async function supersedeIntentOnlyUnitsLocked(
  root: string,
  confirmation: string,
  requiredConfirmationFor: (reason: ResetIntentV1["reason"]) => string,
): Promise<string[]> {
  return supersedeIntentOnlyUnitsWith(localIntentSupersessionSteps(root), confirmation, requiredConfirmationFor);
}

/**
 * {@link supersedeIntentOnlyUnitsLocked} over the supersession steps: the one body.
 * The empty `bytes/` directory is cleared first and the intent marker last (inside the
 * clear step), so the marker's absence is the single durable signal of supersession.
 */
export async function supersedeIntentOnlyUnitsWith(
  steps: IntentSupersessionSteps,
  confirmation: string,
  requiredConfirmationFor: (reason: ResetIntentV1["reason"]) => string,
): Promise<string[]> {
  const listing = await steps.listUnits();
  if (listing.status !== "ok") throw new Error("quarantine registry is unreadable; refusing to supersede");
  const superseded: string[] = [];
  for (const unitId of listing.unitIds) {
    const unit = await classifyUnit(steps, unitId);
    if (unit.kind !== "intent-only") continue;
    // The marker's own confirmation/reason pairing is the PARSER's contract, so an
    // inconsistent marker never reaches here as intent-only. What remains for this
    // caller is that they supplied the destructive confirmation the reason demands.
    if (confirmation !== requiredConfirmationFor(unit.intent.reason)) continue;
    await steps.clearUnit(unitId, unit.hasEmptyBytesDirectory);
    superseded.push(unitId);
  }
  return superseded;
}
