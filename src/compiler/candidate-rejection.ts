/**
 * Raw candidate rejection deliberately bypasses promotion admission so a record
 * whose validated-answer metadata is malformed can still be archived by its
 * explicit safe id. Only the filename identifies the record; its JSON is never
 * parsed or trusted for paths. Custody capture keeps the store's confinement,
 * regular-file and race guards without sanitizing the archived bytes.
 * One custody capture feeds both the caller's pre-archive step and the move,
 * so the step sees exactly the bytes that are archived.
 *
 * Each consumer has ONE BODY over bound candidate-store mechanisms
 * ({@link loadRejectableCandidateOrFailFrom}, {@link archiveRejectedCandidateFrom});
 * the root forms are thin delegates over the local disk's mechanisms. The
 * caller's `beforeArchive` step is invoked exactly as before and is not bound
 * by this: whatever it reads or writes stays the caller's.
 */
import {
  captureCandidateCustodyFrom,
  diskCandidateCustodyReads,
  moveCandidateWithCustodyFrom,
  type CandidateCustodyReads,
  type CandidateStoreMoveReads,
} from "./candidate-custody.js";
import * as output from "../utils/output.js";

/** Report absence while leaving unsafe ids and genuine store failures visible. */
export async function loadRejectableCandidateOrFail(root: string, id: string): Promise<boolean> {
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return loadRejectableCandidateOrFailFrom(diskCandidateCustodyReads(root), id);
}

/** {@link loadRejectableCandidateOrFail} over the custody-read mechanisms: THE ONE BODY. */
export async function loadRejectableCandidateOrFailFrom(reads: CandidateCustodyReads, id: string): Promise<boolean> {
  if (await captureCandidateCustodyFrom(reads, id, undefined, "public") !== null) return true;
  return reportMissing(id);
}

/**
 * Archive the original queue file through the custody move without admission.
 * `beforeArchive` receives the captured bytes; a throw refuses the rejection
 * and leaves the candidate pending. The move is bound to that same capture.
 */
export async function archiveRejectedCandidate(
  root: string,
  id: string,
  beforeArchive?: (bytes: Buffer) => Promise<void>,
): Promise<boolean> {
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return archiveRejectedCandidateFrom(diskCandidateCustodyReads(root), root, id, beforeArchive);
}

/**
 * {@link archiveRejectedCandidate} over the move mechanisms: THE ONE BODY. The
 * public-policy capture, absence as the shared refusal, the caller's step
 * OUTSIDE the move's `try` (so its throw propagates and the record stays
 * pending), the move bound to that capture's receipt, and any move fault or
 * refusal as the fixed diagnostic with exit code 1. The supplied `reads` choose
 * the project; `root` only fills the move request's validated legacy field.
 */
export async function archiveRejectedCandidateFrom(
  reads: CandidateStoreMoveReads,
  root: string,
  id: string,
  beforeArchive?: (bytes: Buffer) => Promise<void>,
): Promise<boolean> {
  const custody = await captureCandidateCustodyFrom(reads, id, undefined, "public");
  if (custody === null) return reportMissing(id);
  await beforeArchive?.(custody.bytes);
  let archived = false;
  try {
    archived = await moveCandidateWithCustodyFrom(reads, { root, fileId: id, direction: "archive", receipt: custody.receipt }, "public");
  } catch {
    archived = false;
  }
  if (!archived) {
    output.status("!", output.error("Candidate could not be archived safely."));
    process.exitCode = 1;
  }
  return archived;
}

/** Shared not-found refusal for the pre-lock check and the under-lock archive. */
function reportMissing(id: string): false {
  output.status("!", output.error(`Candidate not found or removed during review: ${id}`));
  process.exitCode = 1;
  return false;
}
