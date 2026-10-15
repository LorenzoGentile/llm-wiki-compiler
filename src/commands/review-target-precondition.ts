/**
 * Shared under-lock destination checks for single and batch approval. A body
 * pin protects the candidate, not its live destination: proposed repairs must
 * also retain the target hash or absence they observed. Unverifiable targets
 * fail closed, including on retries after a successful page promotion.
 *
 * ONE BODY. {@link targetUnchangedSinceProposeFrom} decides over the one text
 * read it needs; {@link targetUnchangedSincePropose} keeps its signature and
 * reads through the incumbent `diskLocalReads(root)`. Only ENOENT proves absence.
 */
import path from "node:path";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import { sha256Text } from "../connectors/hash.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import type { ReviewCandidate } from "../utils/types.js";

/** Verify the destination still satisfies the proposal's exact preconditions. */
export async function targetUnchangedSincePropose(root: string, candidate: ReviewCandidate): Promise<boolean> {
  return targetUnchangedSinceProposeFrom(diskLocalReads(root), candidate);
}

/** {@link targetUnchangedSincePropose} over the destination's text read: THE ONE BODY. Contradictory pins refuse before any read. */
export async function targetUnchangedSinceProposeFrom(reads: Pick<LegacyLocalReads, "readText">, candidate: ReviewCandidate): Promise<boolean> {
  if (candidate.expectTargetAbsent && candidate.expectedTargetHash !== undefined) return false;
  if (candidate.expectTargetAbsent) {
    try {
      await reads.readText(candidateTargetRelPath(candidate));
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  if (candidate.expectedTargetHash === undefined) return true;
  try {
    const current = await reads.readText(candidateTargetRelPath(candidate));
    return sha256Text(current) === candidate.expectedTargetHash;
  } catch {
    return false;
  }
}

/**
 * Follow the same typed/default routing as the approval planner. The path is
 * project-relative; the storage binding joins the root back on.
 */
function candidateTargetRelPath(candidate: ReviewCandidate): string {
  if (candidate.targetEntityType) {
    return path.join("wiki", candidate.targetEntityType, `${candidate.slug}.md`);
  }
  const directory = candidate.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
  return path.join(directory, `${candidate.slug}.md`);
}
