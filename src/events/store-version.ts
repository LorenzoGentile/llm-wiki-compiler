/**
 * @file src/events/store-version.ts
 * @description The explicit, under-lock event-store schema upgrade. Before the
 * first operation-bound append, the store header is raised from the ordinary base
 * write version to the operation version through a durable whole-file
 * replacement, preserving every existing record byte and its order — so the hash
 * chain, per-record checksums, and sealed head anchor all remain valid (the
 * header participates in none of them). An absent store is created header-only at
 * the operation version; an already-upgraded store is left untouched; a corrupt,
 * torn, too-new, symlinked, or unavailable store throws and is never upgraded.
 *
 * ONE BODY: {@link ensureEventOperationVersionLocked} runs
 * {@link ensureEventOperationVersionLockedFrom} over local-disk
 * {@link EventUpgradeSources}: the event read sources plus ONE raw write, the
 * DURABLE whole-store replacement. It is a member of its own, never the
 * non-durable repair replacement, because this is the one event-store write that
 * asks the atomic writer for power-loss durability. The version decisions, the
 * refusals and their messages, and the bytes written stay in this file.
 */

import path from "node:path";
import { EVENTS_FILE } from "../utils/constants.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { parseStoreHeaderVersion, splitStoreHeaderLine } from "../utils/store-header.js";
import { eventHeaderLine } from "./store-record.js";
import { diskEventReadSources, readEventsFrom, readEventStoreRawFrom, type EventReadSources } from "./store-read.js";
import { EVENT_STORE_BASE_WRITE_VERSION, EVENT_STORE_OPERATION_VERSION } from "./types.js";

/**
 * Everything {@link ensureEventOperationVersionLockedFrom} reads and writes.
 * Owned by the event store; not `ProjectStore`, not hosted, and it selects no
 * backend.
 */
export interface EventUpgradeSources extends EventReadSources {
  /**
   * Replace the WHOLE store body with `body`, DURABLY. Disk: the incumbent
   * `atomicWrite` of `<root>/wiki/graph/events.jsonl` (the root as given) with
   * `confineRoot`, `exactParent`, `durable` and `strictDurability`: an fsynced
   * O_EXCL temp, the rename, the published-destination check and the strict
   * directory-chain fsync. A rejection AFTER the rename is the writer's
   * `AtomicWritePostCommitError`: the body is published and its durability is
   * unproven. REJECTS raw otherwise.
   */
  replaceStoreDurable(body: string): Promise<void>;
}

/** Durably replace the whole store body through the confined atomic writer. */
async function writeStoreBody(root: string, body: string): Promise<void> {
  await atomicWrite(path.join(root, EVENTS_FILE), body, {
    confineRoot: root, exactParent: true, durable: true, strictDurability: true,
  });
}

/**
 * LOCAL DISK. The upgrade sources for the project at `root`: the event read
 * sources and the durable replacement, which reaches `atomicWrite` through
 * `../utils/atomic-write.js` at call time. Building them does no I/O. In no
 * package index.
 */
export function diskEventUpgradeSources(root: string): EventUpgradeSources {
  return { ...diskEventReadSources(root), replaceStoreDurable: (body) => writeStoreBody(root, body) };
}

/**
 * Ensure the event store header declares the operation schema version. The caller
 * holds the project lock and must have already repaired any uncommitted tail.
 * Throws when the store cannot be safely upgraded.
 */
export async function ensureEventOperationVersionLocked(root: string): Promise<void> {
  await ensureEventOperationVersionLockedFrom(diskEventUpgradeSources(root));
}

/**
 * {@link ensureEventOperationVersionLocked} over {@link EventUpgradeSources}:
 * THE ONE BODY. The raw read, then: absent → header-only at the operation
 * version; already there → nothing; not the base version → refused; a tail
 * problem → refused; otherwise the new header over the record bytes verbatim.
 */
export async function ensureEventOperationVersionLockedFrom(sources: EventUpgradeSources): Promise<void> {
  const raw = await readEventStoreRawFrom(sources.graph); // no-follow; symlink/oversize throw
  if (raw === null) {
    await sources.replaceStoreDurable(eventHeaderLine(EVENT_STORE_OPERATION_VERSION));
    return;
  }
  const split = splitStoreHeaderLine(raw);
  const version = split === null ? null : parseStoreHeaderVersion(split.headerLine, "event-store-header");
  if (version === EVENT_STORE_OPERATION_VERSION) return;
  if (split === null || version !== EVENT_STORE_BASE_WRITE_VERSION) {
    throw new Error("event store header is not upgradable to the operation version");
  }
  const { problems } = await readEventsFrom(sources); // interior corruption/too-new throw
  if (problems.length > 0) throw new Error("event store has an uncommitted or broken tail and is not upgraded");
  await sources.replaceStoreDurable(eventHeaderLine(EVENT_STORE_OPERATION_VERSION) + split.recordBytes);
}
