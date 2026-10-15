/**
 * @file src/utils/stream-digest.ts
 * @description The one streaming SHA-256 over an already-confinement-proven handle.
 * Lifecycle planning, lifecycle verification, and evidence capture all need the same
 * thing — hash a leaf without buffering it whole, and refuse rather than truncate past
 * the caller's ceiling — and a second copy of that loop is a second place for the
 * ceiling or the truncation behaviour to drift.
 *
 * The loop asks two things of what it is given, and its parameter type names
 * exactly those: a size, and positional reads. A confirmed confined open
 * satisfies it, and so does a leaf a store lends without handing over a file
 * handle. The loop itself is the same for both.
 */

import { createHash } from "node:crypto";

/** Chunk size for hashing a leaf without holding it in memory. */
const DIGEST_CHUNK_BYTES = 1024 * 1024;

/** The two things the digest loop reads from an opened leaf: its size, and positional reads. */
interface SizedPositionalSource {
  readonly size: number;
  readonly handle: {
    read(target: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  };
}

/**
 * Hash a confirmed handle in bounded chunks. Returns null when the leaf exceeds
 * `maxBytes`, so an over-ceiling object is refused rather than silently truncated
 * into a digest that would match the wrong bytes.
 */
export async function streamConfinedDigest(
  opened: SizedPositionalSource, maxBytes: number, chunkBytes = DIGEST_CHUNK_BYTES,
): Promise<{ digest: string; total: number } | null> {
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, opened.size)));
  let total = 0;
  for (;;) {
    const read = await opened.handle.read(scratch, 0, scratch.byteLength, total);
    if (read.bytesRead === 0) break;
    hash.update(scratch.subarray(0, read.bytesRead));
    total += read.bytesRead;
    if (total > maxBytes) return null;
  }
  return { digest: hash.digest("hex"), total };
}
