/**
 * @file src/connectors/candidate-supersession.ts
 * @description Count-bounded connector candidate selection, exact-custody
 * archive, and closed in-process compensation. Callers retain store-owned file
 * identities and raw-byte receipts; the move seam accepts no path strings. A
 * move is successful only when the bounded digest/inode observer proves the
 * exact archived or restored state, and every post-attempt failure is reduced
 * to an ordered recovery-required result rather than a raw filesystem error.
 *
 * EACH CONSUMER HAS ONE BODY over bound candidate-store mechanisms:
 * {@link selectConnectorCandidateEntriesFrom},
 * {@link selectConnectorCandidateEntriesForRunFrom},
 * {@link archiveCandidatesWithUndoFrom} and {@link restoreArchivedCandidatesFrom}.
 * The domain stays here: the provenance and key match, the batch caps, the
 * fixed unavailable mapping, the dense and exact receipt capture, the archive
 * preflight, the ordered moves and their post-observations, compensation of
 * EVERY receipt, and the deterministic recovery-required result. The root
 * forms are thin delegates over the local disk's mechanisms. A caller-supplied
 * {@link CandidateMovePort} is called exactly as before; the root a move
 * request carries is its validated legacy field, never a source of project I/O.
 */

import {
  assertCandidateMutationAccessFrom,
  assertCandidateNamespacesHealthyFrom,
  CandidateCustodyUnavailableError,
  diskCandidateCustodyReads,
  moveCandidateWithCustodyFrom,
  observeCandidateCustodyFrom,
  type CandidateCustodyMoveRequest,
  type CandidateCustodyReads,
  type CandidateCustodyReceipt,
  type CandidateStoreMoveReads,
  type CandidateStoreScanReads,
  type CandidateStoreWriteReads,
} from "../compiler/candidate-custody.js";
import {
  CandidateCustodyBoundaryError,
  captureCandidateCustodyReceipt,
  captureCandidateCustodyReceipts,
} from "../compiler/candidate-custody-snapshot.js";
import { UnsafeCandidateDirError } from "../compiler/candidate-store-paths.js";
import {
  assertCandidateIdsWritable,
  CandidateIdentityMismatchError,
  CandidateMutationScanCapacityError,
  selectCandidateEntriesForMutationWithTotalFrom,
  selectReadableCandidateEntriesForMutationFrom,
  type CandidateMutationSelectionHooks,
  type CandidateMutationSelector,
} from "../compiler/candidate-selection.js";
import { DEFAULT_STAGED_WRITE_PER_SESSION } from "../trust/staged-change.js";
import { UnsafeCandidateIdError } from "../compiler/candidate-paths.js";
import {
  ConnectorCandidateBatchOverflowError,
  connectorCandidateBatchLimit,
  MAX_CONNECTOR_CANDIDATE_BATCH,
} from "./candidate-batch.js";
import { connectorBlockFromBody } from "./origin.js";
import {
  CandidateRecordMalformedError,
  countCandidatesFrom,
  type CandidateFileEntry,
} from "../compiler/candidate-read.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import { captureDenseArray, captureExactRecord, captureOwnDataRecord } from "../utils/runtime-capture.js";
import type { ReviewCandidate } from "../utils/types.js";
import type { CandidateCustodyPolicy } from "../compiler/candidate-custody-limits.js";

/** Host-owned move seam carrying root, exact file identity, direction, and receipt. */
export interface CandidateMovePort {
  move(request: CandidateCustodyMoveRequest): Promise<boolean>;
}

/** Closed outcome of one candidate supersession adapter operation. */
export type CandidateSupersessionResult =
  | { kind: "archived"; receipts: readonly CandidateCustodyReceipt[] }
  | { kind: "failed-and-restored" }
  | { kind: "recovery-required"; candidateIds: readonly string[] };

/** Bind the trusted host policy and the bound store outside the caller-supplied move request. */
function defaultMovePort(reads: CandidateStoreMoveReads, policy: CandidateCustodyPolicy): CandidateMovePort {
  return { move: (request) => moveCandidateWithCustodyFrom(reads, request, policy) };
}
export const CONNECTOR_CANDIDATE_STORE_UNAVAILABLE =
  "connector candidate store unavailable";

/** Normal-run selection either returns exact entries or one fixed unavailable result. */
export interface ConnectorCandidateSelection {
  readonly totalPending: number;
  readonly entries: readonly CandidateFileEntry[];
}

/** True when selected predecessors make room for exactly one fresh intent. */
export function canStageFreshConnectorIntent(selection: ConnectorCandidateSelection): boolean {
  return selection.totalPending - selection.entries.length + 1 <=
    DEFAULT_STAGED_WRITE_PER_SESSION;
}

/** Closed normal-run selection snapshot or fixed unavailable result. */
export type ConnectorCandidateEntriesResult = ConnectorCandidateSelection | {
  kind: "unavailable";
  reason: string;
};

/**
 * What the connector run's tolerant selection reads: the candidate store's
 * mechanisms (namespace and access probes, the tolerant listing with custody)
 * and the tolerant record directories the pending count lists.
 */
export interface ConnectorCandidateRunSources {
  readonly store: CandidateStoreWriteReads;
  readonly records: LegacyLocalRecordDirs;
}

/** Idempotency identity from the body block first; sidecar only as legacy fallback. */
function durableProvenance(
  candidate: ReviewCandidate,
): { idempotencyKey: string; contentHash: string } | undefined {
  const block = connectorBlockFromBody(candidate.body);
  if (block) return { idempotencyKey: block.idempotencyKey, contentHash: block.contentHash };
  return candidate.connectorProvenance;
}

/** Select the candidates whose durable provenance carries `idempotencyKey`. */
function hasIdempotencyKey(idempotencyKey: string): CandidateMutationSelector {
  return (candidate) => durableProvenance(candidate)?.idempotencyKey === idempotencyKey;
}

/** Re-enumerate a connector key, stopping before materializing selected entry 201. */
export async function selectConnectorCandidateEntries(
  root: string,
  idempotencyKey: string,
): Promise<CandidateFileEntry[]> {
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return selectConnectorCandidateEntriesFrom(diskCandidateCustodyReads(root), idempotencyKey);
}

/** {@link selectConnectorCandidateEntries} over the strict-scan mechanisms: THE ONE BODY. */
export async function selectConnectorCandidateEntriesFrom(
  reads: CandidateStoreScanReads,
  idempotencyKey: string,
): Promise<CandidateFileEntry[]> {
  const selection = await selectCandidateEntriesForMutationWithTotalFrom(reads, hasIdempotencyKey(idempotencyKey), {
    maxSelected: MAX_CONNECTOR_CANDIDATE_BATCH,
    overflowError: () => new ConnectorCandidateBatchOverflowError(),
  });
  return [...selection.entries];
}

/** True for every bounded store-authority failure the run maps to one unavailable result. */
function isConnectorStoreUnavailable(error: unknown): boolean {
  return error instanceof ConnectorCandidateBatchOverflowError ||
    error instanceof CandidateCustodyUnavailableError ||
    error instanceof CandidateRecordMalformedError ||
    error instanceof CandidateIdentityMismatchError ||
    error instanceof CandidateMutationScanCapacityError ||
    error instanceof UnsafeCandidateDirError ||
    error instanceof UnsafeCandidateIdError;
}

/** Map bounded store-authority failures into normal connector unavailable results. */
export async function selectConnectorCandidateEntriesForRun(
  root: string,
  idempotencyKey: string,
  hooks: CandidateMutationSelectionHooks = {},
): Promise<ConnectorCandidateEntriesResult> {
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  const sources = { store: diskCandidateCustodyReads(root), records: diskLocalRecordDirs(root) };
  return selectConnectorCandidateEntriesForRunFrom(sources, idempotencyKey, hooks);
}

/**
 * {@link selectConnectorCandidateEntriesForRun} over the bound sources: THE ONE
 * BODY. The namespace check, the tolerant key selection, the mutation-access
 * preflight (archive only when something was selected), then the tolerant
 * pending count; every bounded store-authority failure is the fixed unavailable
 * result, and any other fault propagates.
 */
export async function selectConnectorCandidateEntriesForRunFrom(
  sources: ConnectorCandidateRunSources,
  idempotencyKey: string,
  hooks: CandidateMutationSelectionHooks = {},
): Promise<ConnectorCandidateEntriesResult> {
  try {
    await assertCandidateNamespacesHealthyFrom(sources.store);
    const entries = await selectReadableCandidateEntriesForMutationFrom(
      sources.store,
      hasIdempotencyKey(idempotencyKey),
      undefined,
      hooks,
    );
    await assertCandidateMutationAccessFrom(sources.store, entries.length > 0);
    return { entries, totalPending: await countCandidatesFrom(sources.records) };
  } catch (error) {
    if (isConnectorStoreUnavailable(error)) {
      return { kind: "unavailable", reason: CONNECTOR_CANDIDATE_STORE_UNAVAILABLE };
    }
    throw error;
  }
}

/** True when a selected entry already records the fetched content hash. */
export function includesConnectorContentHash(
  entries: readonly CandidateFileEntry[],
  contentHash: string,
): boolean {
  return entries.some(({ candidate }) => durableProvenance(candidate)?.contentHash === contentHash);
}

/** Capture one direct entry's only mutation-authority fields. */
function captureEntryReceipt(value: unknown, policy: CandidateCustodyPolicy): CandidateCustodyReceipt {
  const entry = captureExactRecord(value, ["fileId", "candidate", "custodyReceipt"]);
  const candidate = captureOwnDataRecord(entry.candidate);
  if (typeof entry.fileId !== "string" || candidate.id !== entry.fileId) {
    throw new CandidateCustodyBoundaryError();
  }
  assertCandidateIdsWritable([entry.fileId, typeof candidate.id === "string" ? candidate.id : null]);
  const receipt = captureCandidateCustodyReceipt(entry.custodyReceipt, policy);
  if (receipt.fileId !== entry.fileId) throw new CandidateCustodyBoundaryError();
  return receipt;
}

/** Revalidate direct archive input and extract frozen receipts in input order. */
function receiptsForEntries(entries: unknown, policy: CandidateCustodyPolicy): readonly CandidateCustodyReceipt[] {
  try {
    return captureDenseArray(
      entries,
      connectorCandidateBatchLimit(policy),
      (entry) => captureEntryReceipt(entry, policy),
      () => new ConnectorCandidateBatchOverflowError(),
    );
  } catch (error) {
    if (error instanceof ConnectorCandidateBatchOverflowError ||
      error instanceof CandidateCustodyBoundaryError) throw error;
    throw new CandidateCustodyBoundaryError();
  }
}

/** Revalidate direct restore input before any path or move work. */
function captureReceiptBatch(receipts: unknown, policy: CandidateCustodyPolicy): readonly CandidateCustodyReceipt[] {
  return captureCandidateCustodyReceipts(
    receipts,
    connectorCandidateBatchLimit(policy),
    () => new ConnectorCandidateBatchOverflowError(),
    policy,
  );
}

/**
 * One bound supersession: the mechanisms every observation reads, the legacy
 * root each move request carries (never a source of I/O here), the mover, and
 * the byte policy.
 */
interface Supersession {
  readonly reads: CandidateCustodyReads;
  readonly root: string;
  readonly mover: CandidateMovePort;
  readonly policy: CandidateCustodyPolicy;
}

/** Build one path-free request for the candidate-store-owned mover. */
function moveRequest(
  root: string,
  receipt: CandidateCustodyReceipt,
  direction: "archive" | "restore",
): CandidateCustodyMoveRequest {
  return Object.freeze({ root, fileId: receipt.fileId, direction, receipt });
}

/** True only when every receipt proves the pending-only exact pre-state. */
async function archivePreflight(
  run: Supersession, receipts: readonly CandidateCustodyReceipt[],
): Promise<boolean> {
  for (const receipt of receipts) {
    if (await observeCandidateCustodyFrom(run.reads, receipt, run.policy) !== "restored") return false;
  }
  return true;
}

/** Attempt one exact restoration and classify all faults as unresolved. */
async function restoreReceipt(run: Supersession, receipt: CandidateCustodyReceipt): Promise<boolean> {
  try {
    const before = await observeCandidateCustodyFrom(run.reads, receipt, run.policy);
    if (before === "restored") return true;
    if (before !== "archived") return false;
    await run.mover.move(moveRequest(run.root, receipt, "restore")).catch(() => false);
    return await observeCandidateCustodyFrom(run.reads, receipt, run.policy) === "restored";
  } catch {
    return false;
  }
}

/** Attempt every compensation and preserve deterministic receipt order. */
async function compensateReceipts(
  run: Supersession,
  receipts: readonly CandidateCustodyReceipt[],
): Promise<CandidateSupersessionResult> {
  const candidateIds: string[] = [];
  for (const receipt of receipts) {
    if (!(await restoreReceipt(run, receipt))) candidateIds.push(receipt.fileId);
  }
  return candidateIds.length === 0
    ? Object.freeze({ kind: "failed-and-restored" })
    : Object.freeze({ kind: "recovery-required", candidateIds: Object.freeze(candidateIds) });
}

/** Attempt one archive and require both mover assent and exact post-observation. */
async function archiveReceipt(run: Supersession, receipt: CandidateCustodyReceipt): Promise<boolean> {
  try {
    const moved = await run.mover.move(moveRequest(run.root, receipt, "archive"));
    return moved && await observeCandidateCustodyFrom(run.reads, receipt, run.policy) === "archived";
  } catch {
    return false;
  }
}

/** Archive a validated batch and report incomplete in-process compensation. */
export async function archiveCandidatesWithUndo(
  root: string,
  entries: readonly CandidateFileEntry[],
  mover?: CandidateMovePort,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateSupersessionResult> {
  return archiveCandidatesWithUndoFrom(diskCandidateCustodyReads(root), root, entries, mover, policy);
}

/**
 * {@link archiveCandidatesWithUndo} over the move mechanisms: THE ONE BODY.
 * Receipts are captured densely and exactly first; then every receipt must
 * observe the pending-only pre-state; then each is moved in order and must
 * observe archived; the first failure compensates EVERY receipt in order. The
 * supplied `reads` choose the project; `root` only fills each move request's
 * legacy field, for the default mover and for a caller-supplied one alike.
 */
export async function archiveCandidatesWithUndoFrom(
  reads: CandidateStoreMoveReads,
  root: string,
  entries: readonly CandidateFileEntry[],
  mover?: CandidateMovePort,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateSupersessionResult> {
  const run: Supersession = { reads, root, mover: mover ?? defaultMovePort(reads, policy), policy };
  const receipts = receiptsForEntries(entries, policy);
  if (!(await archivePreflight(run, receipts))) return compensateReceipts(run, receipts);
  for (const receipt of receipts) {
    if (await archiveReceipt(run, receipt)) continue;
    return compensateReceipts(run, receipts);
  }
  return Object.freeze({ kind: "archived", receipts });
}

/** Restore exact archived receipts and surface every unresolved filename identity. */
export async function restoreArchivedCandidates(
  root: string,
  receipts: readonly CandidateCustodyReceipt[],
  mover?: CandidateMovePort,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateSupersessionResult> {
  return restoreArchivedCandidatesFrom(diskCandidateCustodyReads(root), root, receipts, mover, policy);
}

/**
 * {@link restoreArchivedCandidates} over the move mechanisms: THE ONE BODY. The
 * receipt batch is captured before any observation or move, then EVERY receipt
 * is compensated in order. `root` only fills each move request's legacy field.
 */
export async function restoreArchivedCandidatesFrom(
  reads: CandidateStoreMoveReads,
  root: string,
  receipts: readonly CandidateCustodyReceipt[],
  mover?: CandidateMovePort,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateSupersessionResult> {
  const captured = captureReceiptBatch(receipts, policy);
  return compensateReceipts({ reads, root, mover: mover ?? defaultMovePort(reads, policy), policy }, captured);
}
