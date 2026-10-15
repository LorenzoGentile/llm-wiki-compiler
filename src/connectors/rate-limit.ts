/**
 * @file src/connectors/rate-limit.ts
 * @description Host-owned per-connector request-interval floor.
 *
 * The last-request timestamp is persisted under the project root and read/updated
 * under the project lock, so concurrent connector runs cannot both pass the
 * interval check. Reads route through the confined leaf reader and writes through
 * the confined atomic writer — a symlinked connectors directory fails closed.
 *
 * Disk access: {@link enforceRequestInterval} takes the project lock and then
 * runs {@link updateRateStampLockedFrom} over the two local-disk bindings for the
 * project root: one capped confined read and one confined atomic write. The
 * lock, the parse, the clock and the decision stay in this module.
 */

import path from "node:path";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { diskLocalCappedReads } from "../storage/disk-local-reads.js";
import { diskLocalRecords } from "../storage/disk-local-records.js";
import type { LegacyLocalCappedReads } from "../storage/legacy-local-reads.js";
import type { LegacyLocalRecords } from "../storage/legacy-local-records.js";
import type { ConnectorRuntimeConfig } from "./config.js";
import type { RunConnectorResult } from "./run.js";

const RATE_STAMP_MAX_BYTES = 512;

/** Apply the configured request-interval floor before any external fetch. */
export async function enforceRequestInterval(
  root: string,
  connectorId: string,
  config: ConnectorRuntimeConfig,
  now?: () => Date,
): Promise<RunConnectorResult | null> {
  if (config.minRequestIntervalMs <= 0) return null;
  if (!(await acquireMutationLock(root, "ordinary", { quiet: true }))) {
    return { kind: "unavailable", reason: "connector rate state locked" };
  }
  try {
    return await updateRateStampLockedFrom(
      diskLocalCappedReads(root), diskLocalRecords(root), connectorId, config.minRequestIntervalMs, now,
    );
  } finally {
    await releaseLock(root);
  }
}

/**
 * Read/update the connector's last-request timestamp through `reads` and
 * `records`: exactly one capped read, then at most one atomic write.
 *
 * THE CALLER MUST HOLD THE PROJECT MUTATION LOCK. Nothing here takes it or
 * checks it, so two unlocked callers can both pass the interval check. The
 * caller also owns `connectorId`: it goes into the stamp's path as it is given
 * and is not validated here. This is an internal seam over the legacy local
 * bindings. It confers no authority and is not a hosted or public contract.
 *
 * @param reads - Where the stamp is read from, capped and confined.
 * @param records - Where the stamp is written, atomically and confined.
 * @param connectorId - The connector whose stamp this is; trusted as given.
 * @param minIntervalMs - The floor between two requests, in milliseconds.
 * @param now - The clock; read once, after the stamp, and only when it is usable.
 */
export async function updateRateStampLockedFrom(
  reads: LegacyLocalCappedReads,
  records: Pick<LegacyLocalRecords, "writeAtomic">,
  connectorId: string,
  minIntervalMs: number,
  now?: () => Date,
): Promise<RunConnectorResult | null> {
  const stamp = await readRateStamp(reads, connectorId);
  if (stamp.kind === "unavailable") return stamp;
  const current = (now ? now() : new Date()).getTime();
  if (stamp.kind === "ok" && current - stamp.atMs < minIntervalMs) {
    return { kind: "refused", reason: "connector minimum request interval has not elapsed" };
  }
  try {
    await writeRateStamp(records, connectorId, current);
  } catch {
    return { kind: "unavailable", reason: "connector rate state unavailable" };
  }
  return null;
}

/** Read the prior connector request timestamp, preserving unavailable as fail-closed. */
async function readRateStamp(
  reads: LegacyLocalCappedReads,
  connectorId: string,
): Promise<{ kind: "ok"; atMs: number } | { kind: "absent" } | { kind: "unavailable"; reason: string }> {
  const read = await reads.readCappedText(rateStampPath(connectorId), RATE_STAMP_MAX_BYTES);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unavailable") return { kind: "unavailable", reason: "connector rate state unavailable" };
  return parseRateStamp(read.body);
}

/** Parse the persisted rate timestamp. */
function parseRateStamp(raw: string): { kind: "ok"; atMs: number } | { kind: "unavailable"; reason: string } {
  try {
    const parsed = JSON.parse(raw) as { atMs?: unknown };
    if (typeof parsed.atMs === "number" && Number.isSafeInteger(parsed.atMs)) return { kind: "ok", atMs: parsed.atMs };
  } catch {
    // handled below
  }
  return { kind: "unavailable", reason: "connector rate state corrupt" };
}

/** Persist the current connector request timestamp under the project root. */
async function writeRateStamp(
  records: Pick<LegacyLocalRecords, "writeAtomic">,
  connectorId: string,
  atMs: number,
): Promise<void> {
  await records.writeAtomic(rateStampPath(connectorId), `${JSON.stringify({ atMs })}\n`);
}

/** The host-owned request-interval marker for one connector, relative to the project root. */
function rateStampPath(connectorId: string): string {
  return path.join(".llmwiki", "connectors", `${connectorId}.last-fetch.json`);
}
