/**
 * @file Immutable allocation of record-effect bundle identities. The service must
 * hold the project lock, validate host authority/profile/preimage, and check the
 * operation inventory before calling. This is preparation indexing, not a run
 * journal: it cannot approve, apply, retire or certify settlement. Reservations
 * are retained indefinitely in this prototype; no automatic reclamation exists.
 *
 * ONE BODY over {@link EffectReservationLeaves}: read the reservation leaf, refuse
 * an interrupted create's companions, and create-only publish. The body owns
 * parsing, the intent-conflict rule and minting; it never mints when the leaf is
 * uncertain. The local-disk factory derives the content-addressed path per call.
 */
import path from "node:path";
import { lstat } from "node:fs/promises";
import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { atomicWriteNoReplaceDurable } from "../utils/atomic-write.js";
import { durableTempPath, durableWritingPath } from "../utils/atomic-write-no-replace-durable.js";
import type { CappedLeafReadBuffer } from "../utils/confined-read.js";
import { readDurableOperationLeafBuffer } from "./durable-leaf.js";
import { assertBundleId, assertOperationRunId, mintBundleId, mintOperationRunId, type BundleId, type OperationRunId } from "./ids.js";
import { digest, exact, record, textValue, timestamp } from "./manifest-values.js";
import { recordIntentDigest, type RecordIntentV1 } from "./record-intent.js";
import type { OperationDigest } from "./types.js";

const MAX_RESERVATION_BYTES = 8192;
type EffectKey = { workspaceId: string; preparerId: string; effectId: string };

/** Core-owned IDs and timestamp keep materialization stable after interrupted staging. */
export type EffectReservation = EffectKey & { schema: "llmwiki-effect-reservation-v1";
  intentDigest: OperationDigest; bundleId: BundleId; runId: OperationRunId; createdAt: string };

/** Dedicated core index sits outside run inventory; no request supplies its path. */
function reservationPath(root: string, key: EffectKey) {
  const parent = path.join(root, ".llmwiki", "operation-effect-reservations");
  const id = canonicalDigest({ domain: "llmwiki.effect-reservation.v1", ...key }).slice(7);
  return { parent, file: path.join(parent, `${id}.json`) };
}

/** Decode bounded canonical storage and validate every identity before reuse. */
function parseReservation(bytes: Buffer, key: EffectKey): EffectReservation {
  const value = record(JSON.parse(bytes.toString("utf8")), "reservation");
  exact(value, ["schema", "workspaceId", "preparerId", "effectId", "intentDigest", "bundleId", "runId", "createdAt"]);
  if (value.schema !== "llmwiki-effect-reservation-v1" || value.workspaceId !== key.workspaceId ||
    value.preparerId !== key.preparerId || value.effectId !== key.effectId) throw new Error("effect-reservation-unavailable");
  const parsed: EffectReservation = { ...key, schema: "llmwiki-effect-reservation-v1",
    intentDigest: digest(value.intentDigest, "intentDigest"), bundleId: assertBundleId(value.bundleId),
    runId: assertOperationRunId(value.runId), createdAt: timestamp(value.createdAt) };
  if (!canonicalBytes(parsed).equals(bytes)) throw new Error("effect-reservation-unavailable");
  return parsed;
}

/** An interrupted create has an uncertain identity; never replace it with fresh IDs. */
async function requireNoPartialReservation(file: string): Promise<void> {
  for (const companion of [durableTempPath(file), durableWritingPath(file)]) {
    try { await lstat(companion); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("effect-reservation-unavailable");
    }
    throw new Error("effect-reservation-unavailable");
  }
}

/** What the reservation body asks of the store, keyed by the effect key. No member takes a project root. */
export interface EffectReservationLeaves {
  /** The reservation leaf within `maxBytes`. */
  readReservation(key: EffectKey, maxBytes: number): Promise<CappedLeafReadBuffer>;
  /** Reject `effect-reservation-unavailable` when an interrupted create left a companion. */
  assertNoPartialReservation(key: EffectKey): Promise<void>;
  /** Create-only durable publication; any failure propagates. */
  createReservation(key: EffectKey, bytes: Buffer): Promise<void>;
}

/** The local-disk reservation leaves for one root, built per call. In no package index. */
function diskEffectReservationLeaves(root: string): EffectReservationLeaves {
  return {
    readReservation: (key, maxBytes) => {
      const location = reservationPath(root, key);
      return readDurableOperationLeafBuffer(root, location.file, location.parent, maxBytes);
    },
    assertNoPartialReservation: (key) => requireNoPartialReservation(reservationPath(root, key).file),
    createReservation: (key, bytes) =>
      atomicWriteNoReplaceDurable(reservationPath(root, key).file, bytes, { confineRoot: root, exactParent: true }),
  };
}

/** Reserve once under the project lock. Any uncertain write is propagated, not retried. */
export async function reserveRecordEffectLocked(root: string, preparerId: string, intent: RecordIntentV1): Promise<EffectReservation> {
  return reserveRecordEffectWith(diskEffectReservationLeaves(root), preparerId, intent);
}

/** {@link reserveRecordEffectLocked} over the reservation leaves: the one body. */
export async function reserveRecordEffectWith(leaves: EffectReservationLeaves, preparerId: string, intent: RecordIntentV1): Promise<EffectReservation> {
  const key = { workspaceId: intent.workspaceId, effectId: intent.effectId, preparerId: textValue(preparerId, "preparerId") };
  const intentDigest = recordIntentDigest(intent);
  const read = await leaves.readReservation(key, MAX_RESERVATION_BYTES);
  if (read.kind === "ok") {
    const existing = parseReservation(read.body, key);
    if (existing.intentDigest !== intentDigest) throw new Error("effect-intent-conflict");
    return existing;
  }
  if (read.kind !== "absent") throw new Error("effect-reservation-unavailable");
  await leaves.assertNoPartialReservation(key);
  const reservation: EffectReservation = { ...key, schema: "llmwiki-effect-reservation-v1", intentDigest,
    bundleId: mintBundleId(), runId: mintOperationRunId(), createdAt: new Date().toISOString() };
  await leaves.createReservation(key, canonicalBytes(reservation));
  return reservation;
}
