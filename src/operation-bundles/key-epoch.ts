/**
 * @file src/operation-bundles/key-epoch.ts
 * @description Distinct absent, unavailable, and healthy operation-key reads
 * plus the only empty-epoch key creation seam. Reads are confined, capped, and
 * no-follow; creation is lock-required by contract, durable, and mode 0600.
 *
 * ONE KEY READ, OVER THE READER'S OWN LEAF. What makes bytes a key is decided in
 * one body, {@link readOperationKeyFrom}: the cap it asks for, the canonical
 * base64 of exactly 32 bytes, the epoch derived from those bytes, and the three
 * statuses. It takes {@link OperationKeyLeafReads} and no project root or path.
 * The root reader and the creation and recovery reads keep their signatures and
 * reach that body over the private local-disk leaf, built on each call. What the
 * local disk adds stays on the disk side, unchanged: the confined no-follow open,
 * owner and mode, then (only when those are healthy) the link count against the
 * one reserved alias, then the capped handle-bound read. This mirrors the
 * accepted `PreparationKeyLeafReads` seam but keeps the OPERATION key's own
 * short-circuit order. Nothing here selects a backend; no writer moved.
 *
 * ONE CREATE-OR-REFUSE BODY. {@link createOperationKeyForEmptyEpochLockedWith}
 * decides the empty-epoch creation over {@link OperationKeyCreateSteps}, none of
 * which takes a project root: the exact empty inventory, the unavailable / ok /
 * absent policy for the current key, reuse of a synced crash-ready key, and the
 * collision re-read. Minting fresh bytes and the durable no-replace write stay
 * MECHANISM. The root form keeps its signature and builds the local steps per call.
 */

import path from "node:path";
import { durableTempPath, durableWritingPath } from "../utils/atomic-write-no-replace-durable.js";
import { openConfinedLeaf, readWithinCapOrElse, type CappedLeafRead } from "../utils/confined-read.js";
import { healthyKeyLinks, healthyKeyMetadata, publishKeyLeafNoReplace, recoveredEpochKey } from "../utils/key-leaf-health.js";
import { operationKeyEpochId } from "./run-integrity.js";
import type { OperationDigest } from "./types.js";

const OPERATION_KEY_BYTES = 32;
const MAX_OPERATION_KEY_FILE_BYTES = 1_024;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;

/** Count, byte total, and scan health for one active-epoch object class. */
export interface OperationEpochInventoryEntry { count: number; bytes: number; health: "ok" | "unavailable" }

export interface OperationEpochInventory {
  bundles: OperationEpochInventoryEntry;
  runs: OperationEpochInventoryEntry;
  payloads: OperationEpochInventoryEntry;
  evidence: OperationEpochInventoryEntry;
  cancelRequests: OperationEpochInventoryEntry;
  orphans: OperationEpochInventoryEntry;
}

/** Deterministic race seam used only by create-collision tests. */
export interface OperationKeyCreateOptions { beforePublishForTest?: () => Promise<void> }

export type OperationKeyRead =
  | { status: "absent" }
  | { status: "unavailable" }
  | { status: "ok"; key: Buffer; keyEpochId: OperationDigest };

/** Return the one project-global operation-key leaf. */
function operationKeyFile(root: string): string {
  return path.join(root, ".llmwiki", "operation-bundles.runkey");
}

/** Decode only the canonical base64 serialization of exactly 32 bytes. */
function decodeOperationKey(body: string): Buffer | null {
  if (!BASE64_KEY.test(body)) return null;
  const key = Buffer.from(body, "base64");
  if (key.length !== OPERATION_KEY_BYTES || key.toString("base64") !== body) return null;
  return key;
}

/**
 * What the operation key read asks of the store. Owned by the key reader; the
 * read takes no project root and no path.
 */
export interface OperationKeyLeafReads {
  /**
   * The key leaf's text within `maxBytes`, from a leaf the store vouches for.
   * `absent` is a store with no key leaf. `unavailable` is a leaf that exists and
   * may not be trusted or read: on the local disk that is confinement, the
   * no-follow open, owner and mode, the link count and the byte cap. May reject;
   * the body catches nothing.
   */
  readKeyLeaf(maxBytes: number): Promise<CappedLeafRead>;
}

/** The local-disk key leaf for one exact file. Private, built per call: the closure opens and checks the leaf when asked, never earlier. */
function diskOperationKeyLeafReads(root: string, file: string, reservedAlias?: string): OperationKeyLeafReads {
  return { readKeyLeaf: (maxBytes) => readHealthyOperationKeyLeafText(root, file, reservedAlias, maxBytes) };
}

/**
 * The local-disk leaf of the project's CURRENT operation key: the key file, with
 * its durable temp path as the one reserved alias. Building it does no path work
 * and no I/O. In no package index.
 */
export function diskCurrentOperationKeyLeafReads(root: string): OperationKeyLeafReads {
  return { readKeyLeaf: (maxBytes) => {
    const file = operationKeyFile(root);
    return diskOperationKeyLeafReads(root, file, durableTempPath(file)).readKeyLeaf(maxBytes);
  } };
}

/** Read the operation key without creating directories or collapsing faults. */
export async function readOperationKey(root: string): Promise<OperationKeyRead> {
  return readOperationKeyFrom(diskCurrentOperationKeyLeafReads(root));
}

/**
 * {@link readOperationKey} over the reader's own leaf: THE ONE BODY. It asks for
 * the leaf under the key cap, then decodes the canonical 32-byte key and derives
 * its epoch HERE. A leaf that does not decode is `unavailable`, the same answer as
 * a leaf the store refused. It confines nothing and checks no owner, mode or link:
 * an in-memory leaf is trusted exactly as far as whoever supplied it.
 */
export async function readOperationKeyFrom(leaves: OperationKeyLeafReads): Promise<OperationKeyRead> {
  const leaf = await leaves.readKeyLeaf(MAX_OPERATION_KEY_FILE_BYTES);
  if (leaf.kind === "absent") return { status: "absent" };
  if (leaf.kind === "unavailable") return { status: "unavailable" };
  const key = decodeOperationKey(leaf.body);
  return key === null ? { status: "unavailable" } : { status: "ok", key, keyEpochId: operationKeyEpochId(key) };
}

/** Read one exact key-shaped leaf through the same confined key contract (creation and crash-recovery reads). */
async function readOperationKeyLeaf(root: string, file: string, reservedAlias?: string): Promise<OperationKeyRead> {
  return readOperationKeyFrom(diskOperationKeyLeafReads(root, file, reservedAlias));
}

/**
 * One confined operation key leaf's text, or why not: the local disk's half of the
 * key read. The no-follow confined open, then owner and mode, and ONLY if those are
 * healthy the link count against the one reserved alias (the operation key's own
 * short-circuit order), then the capped handle-bound read, where any non-ok read is
 * `unavailable`. The handle is closed on every refusal. It decodes nothing.
 */
async function readHealthyOperationKeyLeafText(
  root: string, file: string, reservedAlias: string | undefined, maxBytes: number,
): Promise<CappedLeafRead> {
  const opened = await openConfinedLeaf(root, file, path.dirname(file));
  if (opened.kind !== "confirmed") return opened;
  if (!healthyKeyMetadata(opened.mode, opened.uid) || !(await healthyKeyLinks(opened, reservedAlias))) {
    await opened.handle.close().catch(() => {});
    return { kind: "unavailable" };
  }
  const read = await readWithinCapOrElse(opened, maxBytes, () => ({ kind: "unavailable" as const }));
  return read.kind === "ok" ? read : { kind: "unavailable" };
}


/** Require the exact six-part active inventory and prove every byte count is zero. */
function assertEmptyEpochInventory(inventory: OperationEpochInventory): void {
  const expected = ["bundles", "runs", "payloads", "evidence", "cancelRequests", "orphans"];
  const keys = Object.keys(inventory);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("operation key creation requires an exact empty epoch inventory");
  }
  for (const key of expected) {
    if (!emptyHealthyEntry(inventory[key as keyof OperationEpochInventory])) {
      throw new Error("operation key creation requires an empty epoch inventory");
    }
  }
}

/** Validate the exact entry shape before interpreting zero byte totals. */
function emptyHealthyEntry(value: unknown): boolean {
  if (!inventoryEntryShape(value)) return false;
  return zeroHealthyEntry(value);
}

/** Recognize only the three exact inventory-entry fields. */
function inventoryEntryShape(value: unknown): value is Partial<OperationEpochInventoryEntry> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3 && ["count", "bytes", "health"].every((key) => keys.includes(key));
}

/** Require healthy scanning plus exact zero count and byte totals. */
function zeroHealthyEntry(entry: Partial<OperationEpochInventoryEntry>): boolean {
  if (entry.health !== "ok" || !Number.isSafeInteger(entry.count) || !Number.isSafeInteger(entry.bytes)) return false;
  return entry.count === 0 && entry.bytes === 0;
}

/** What empty-epoch key creation asks of the store. No member takes a project root. */
export interface OperationKeyCreateSteps {
  /** The current key, read as any reader reads it (also the collision re-read). */
  readCurrentKey(): Promise<OperationKeyRead>;
  /** A synced ready-only crash key an interrupted publication left, read through the same key contract. */
  readCrashReadyKey(): Promise<OperationKeyRead>;
  /** MECHANISM: durably publish `key` without replacing one; `collision` when one is there. Any other fault THROWS. */
  publishKey(key: Buffer): Promise<"created" | "collision">;
}

/** LOCAL DISK. The current and crash-ready key leaves and the no-replace write for `root`, each reached when asked. */
function diskOperationKeyCreateSteps(root: string): OperationKeyCreateSteps {
  return {
    readCurrentKey: () => readOperationKey(root),
    readCrashReadyKey: () => {
      const file = operationKeyFile(root);
      return readOperationKeyLeaf(root, durableTempPath(file), durableWritingPath(file));
    },
    publishKey: (key) => publishKeyLeafNoReplace(root, operationKeyFile(root), key),
  };
}

/** The reads over the key reader's own body, with the caller's publication mechanism. Building it does no I/O. */
export function operationKeyCreateStepsOver(
  leaves: { current: OperationKeyLeafReads; crashReady: OperationKeyLeafReads }, publishKey: OperationKeyCreateSteps["publishKey"],
): OperationKeyCreateSteps {
  return { readCurrentKey: () => readOperationKeyFrom(leaves.current), readCrashReadyKey: () => readOperationKeyFrom(leaves.crashReady), publishKey };
}

/** Reconcile any crash-left aliases before reporting an existing healthy key. */
async function refuseExistingKeyEpoch(steps: OperationKeyCreateSteps, key: Buffer): Promise<never> {
  await steps.publishKey(key);
  throw new Error("operation key epoch already exists");
}

/** Mint the first key only after the caller's under-lock inventory proves emptiness. */
export async function createOperationKeyForEmptyEpochLocked(
  root: string,
  inventory: OperationEpochInventory,
  options: OperationKeyCreateOptions = {},
): Promise<{ key: Buffer; keyEpochId: OperationDigest }> {
  return createOperationKeyForEmptyEpochLockedWith(diskOperationKeyCreateSteps(root), inventory, options);
}

/** {@link createOperationKeyForEmptyEpochLocked} over {@link OperationKeyCreateSteps}: THE ONE BODY. */
export async function createOperationKeyForEmptyEpochLockedWith(
  steps: OperationKeyCreateSteps,
  inventory: OperationEpochInventory,
  options: OperationKeyCreateOptions = {},
): Promise<{ key: Buffer; keyEpochId: OperationDigest }> {
  assertEmptyEpochInventory(inventory);
  const current = await steps.readCurrentKey();
  if (current.status === "unavailable") throw new Error("operation key is unavailable");
  if (current.status === "ok") return refuseExistingKeyEpoch(steps, current.key);
  const key = recoveredEpochKey(await steps.readCrashReadyKey(), OPERATION_KEY_BYTES, "operation");
  await options.beforePublishForTest?.();
  if (await steps.publishKey(key) === "collision") {
    const collision = await steps.readCurrentKey();
    throw new Error(`operation key creation collision: ${collision.status}`);
  }
  return { key, keyEpochId: operationKeyEpochId(key) };
}
