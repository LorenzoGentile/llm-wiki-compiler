/**
 * @file src/operation-bundles/registered-project-lock.ts
 * @description Brings the few legacy writers that take NO project lock under
 * the shared, gated lock — on projects registered for the portable path only.
 *
 * Source ingest, the SDK's source delete and `schema init` write authoritative
 * project content without the mutation lock. On an ordinary project that is
 * today's behaviour and it does not change: the wrapper costs one `lstat` and
 * then runs the writer exactly as before, lock-free.
 *
 * A registered project has knowingly opted into the portable gates. There the
 * same write runs inside the gated mutation lock, so it serializes with
 * portable publications and is refused while a publication intent is
 * unresolved, as every other ordinary mutation of that project already is.
 *
 * A portable `source.add` never comes through here: it writes through the
 * store under its own gate intent, so there is no re-entry.
 *
 * ONE BODY. {@link withRegisteredProjectLockWith} owns the decision (lock only a
 * registered project, release on every exit) over a
 * {@link RegisteredProjectGate}: the portable-directory look and the blocking
 * lock are its mechanisms. The root form passes the local gate.
 */

import { hasPortableDirectory } from "../portable/host/pending-gate.js";
import { releaseLock } from "../utils/lock.js";
import { saveSource } from "../utils/source-writer.js";
import { acquireMutationLockBlocking } from "./lock-gate.js";

/**
 * Run a lock-free legacy writer, under the gated project lock when (and only
 * when) the project carries the portable directory.
 *
 * @param root - Project root directory.
 * @param write - The writer, unchanged.
 */
export async function withRegisteredProjectLock<T>(root: string, write: () => Promise<T>): Promise<T> {
  return withRegisteredProjectLockWith({
    registered: () => hasPortableDirectory(root),
    acquire: () => acquireMutationLockBlocking(root, "ordinary"),
    release: () => releaseLock(root),
  }, write);
}

/** The registration look and the gated blocking lock: MECHANISMS, no decision. */
export interface RegisteredProjectGate {
  /** Whether the project carries the portable directory. */
  registered(): Promise<boolean>;
  /** Take the gated project lock, waiting for it; a gate refusal THROWS. */
  acquire(): Promise<void>;
  /** Release the project lock. */
  release(): Promise<void>;
}

/** {@link withRegisteredProjectLock} over a {@link RegisteredProjectGate}: THE ONE BODY. */
export async function withRegisteredProjectLockWith<T>(gate: RegisteredProjectGate, write: () => Promise<T>): Promise<T> {
  if (!(await gate.registered())) return write();
  await gate.acquire();
  try {
    return await write();
  } finally {
    await gate.release();
  }
}

/**
 * Save an ingested source: lock-free on an ordinary project, under the gated
 * project lock once the project is registered for the portable path. Every
 * ingest entry point calls this instead of the bare writer.
 */
export function saveSourceUnderProjectGate(
  root: string, title: string, document: string, source: string,
): ReturnType<typeof saveSource> {
  return withRegisteredProjectLock(root, () => saveSource(root, title, document, source));
}
