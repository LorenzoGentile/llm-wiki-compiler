/** @file Shared host-only preparation authority and lock boundary. Both staging
 * and retirement require the same explicit grant and serialize against operator
 * apply. The callback is internal implementation, never SDK request data.
 *
 * ONE BODY. {@link withRecordPreparationLockWith} owns the decisions (the actor
 * captured before any wait, the grant refusal before the lock, the busy refusal,
 * release on every exit) over a {@link RecordPreparationLock}, the lock itself
 * being the one physical mechanism: {@link diskRecordPreparationLock} for a
 * local project. */
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "./lock-gate.js";
import type { OperationPrincipal } from "./principal.js";

/** The project lock record preparation serializes under: a MECHANISM, no decision. */
export interface RecordPreparationLock {
  /** Take the lock at `ordinary` intent without blocking: false when busy; a gate refusal THROWS. */
  acquire(): Promise<boolean>;
  /** Release what `acquire` took. */
  release(): Promise<void>;
}

/** LOCAL DISK. The project lock at `root`: acquired at `ordinary` intent without blocking, then released. */
export function diskRecordPreparationLock(root: string): RecordPreparationLock {
  return { acquire: () => acquireMutationLock(root, "ordinary"), release: () => releaseLock(root) };
}

/** Capture host authority before waiting, then release the acquired lock on every exit: THE ONE BODY. */
export async function withRecordPreparationLockWith<T>(lock: RecordPreparationLock, principal: OperationPrincipal,
  action: (actor: OperationPrincipal) => Promise<T>): Promise<T> {
  const actor: OperationPrincipal = { id: principal.id, surface: principal.surface, grants: [...principal.grants] };
  if (!actor.grants.includes("operation-bundle.prepare")) throw new Error("record-prepare-grant-required");
  if (!await lock.acquire()) throw new Error("record-preparation-busy");
  try { return await action(actor); }
  finally { await lock.release(); }
}
