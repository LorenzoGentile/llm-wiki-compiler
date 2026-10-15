/** Shared storage mechanics for independently keyed run stores; callers own parsing and authentication. */
import { AtomicWriteCollisionError, atomicWrite, atomicWriteNoReplaceDurable } from "./atomic-write.js";
import type { CappedLeafRead } from "./confined-read.js";

/** Classify failed parsing or authentication without allowing a partial run to escape. */
function authenticatedRunRead<T>(parse: () => T, verify: (run: T) => boolean):
  { status: "ok"; run: T } | { status: "unavailable"; detail: "run-invalid"; code: "run-integrity-invalid" } {
  try {
    const run = parse();
    if (!verify(run)) throw new Error("integrity");
    return { status: "ok", run };
  } catch {
    return { status: "unavailable", detail: "run-invalid", code: "run-integrity-invalid" };
  }
}

/** One store's run key as the run read sees it: absent, unavailable, or its bytes. */
type RunKeyReadLike = { status: "absent" } | { status: "unavailable" } | { status: "ok"; key: Buffer };

/** Every outcome {@link readAuthenticatedRunFrom} can return, given the store's own two refusals `U`. */
export type AuthenticatedRunReadOutcome<R, U> =
  | { status: "ok"; run: R }
  | { status: "absent" }
  | U
  | { status: "unavailable"; detail: "key-missing"; code: "integrity-key-missing" }
  | { status: "unavailable"; detail: "key-unreadable"; code: "integrity-key-unreadable" }
  | { status: "unavailable"; detail: "run-invalid"; code: "run-integrity-invalid" };

/**
 * One store's run-read policy. The two refusals are the store's OWN taxonomy and are
 * passed as values, never derived here: the operation store's `identity` and
 * `run-leaf` refusals carry no code, the preparation store's carry its own codes.
 */
export interface RunReadPolicy<R, U> {
  /** The run leaf's byte cap. */
  maxBytes: number;
  /** Parse and bind the leaf text (may throw: an invalid run). */
  parse(body: string): R;
  /** Authenticate the parsed run under the key (false: an invalid run). */
  verify(run: R, key: Buffer): boolean;
  /** Returned when reading the leaf throws or rejects (an unsafe identity or otherwise). */
  identity: U;
  /** Returned when the leaf exists but is unavailable. */
  runLeaf: U;
}

/**
 * THE shared run read over a store's leaves: the leaf first (a throw is the store's
 * `identity` refusal), absent, the store's `runLeaf` refusal, then the key only for a
 * present leaf (missing or unreadable, with the shared integrity codes), then parse,
 * bind and authenticate. Order, caps and codes are each store's incumbent ones.
 */
export async function readAuthenticatedRunFrom<B, R, U>(
  leaves: { readRunLeaf(binding: B, maxBytes: number): Promise<CappedLeafRead>; readKey(): Promise<RunKeyReadLike> },
  binding: B,
  policy: RunReadPolicy<R, U>,
): Promise<AuthenticatedRunReadOutcome<R, U>> {
  let leaf: CappedLeafRead;
  try {
    leaf = await leaves.readRunLeaf(binding, policy.maxBytes);
  } catch {
    return policy.identity;
  }
  if (leaf.kind === "absent") return { status: "absent" };
  if (leaf.kind === "unavailable") return policy.runLeaf;
  const key = await leaves.readKey();
  if (key.status === "absent") return { status: "unavailable", detail: "key-missing", code: "integrity-key-missing" };
  if (key.status === "unavailable") return { status: "unavailable", detail: "key-unreadable", code: "integrity-key-unreadable" };
  return authenticatedRunRead(() => policy.parse(leaf.body), (run) => policy.verify(run, key.key));
}

/**
 * The create-only genesis collision diagnostic for one store: its label and its run
 * read as of the collision. Built eagerly, READ only when the create collides.
 */
export function genesisCollisionMessage<B>(
  store: "operation" | "preparation", readRun: (binding: B) => Promise<{ status: string }>, binding: B,
): () => Promise<string> {
  return async () => `${store} run genesis already exists: ${(await readRun(binding)).status}`;
}

/** Publish once; only a real create collision invokes the store-specific readback diagnostic. */
export async function publishRunGenesis(
  location: { root: string; file: string }, serialized: string, collisionMessage: () => Promise<string>,
): Promise<void> {
  try {
    await atomicWriteNoReplaceDurable(location.file, serialized, {
      confineRoot: location.root, exactParent: true, mode: 0o600,
    });
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) throw new Error(await collisionMessage());
    throw error;
  }
}

/**
 * Durably replace one run leaf (a transition append's physical write): confined to
 * the root, exact parent, strictly durable, owner-private. Shared because both run
 * stores make this identical write; what is written, and when, stays theirs.
 */
export function replaceRunLeaf(location: { root: string; file: string }, serialized: string): Promise<void> {
  return atomicWrite(location.file, serialized, {
    confineRoot: location.root, exactParent: true, durable: true, strictDurability: true, mode: 0o600,
  });
}
