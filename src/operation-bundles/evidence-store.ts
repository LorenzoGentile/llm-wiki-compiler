/**
 * @file src/operation-bundles/evidence-store.ts
 * @description Run-owned immutable evidence blobs and the fixed-shape,
 * non-persisting reference used when evidence exceeds the launch blob cap.
 *
 * ONE BODY. {@link writeRunEvidenceWith} decides the metadata bounds, when
 * evidence is over the blob cap (a hashed, excerpted reference and no write) and
 * the content-addressed reference, over {@link RunEvidenceBlobs}: the run's
 * evidence location (whose derivation validates the identities, before any size
 * decision, exactly as before) and its create-only blob write.
 * {@link writeRunEvidenceCreateOnly} keeps its signature and passes the local
 * disk blobs (`operationPaths` and `writeContentAddressedBlob`).
 */

import { createHash } from "node:crypto";
import type { OperationRunId } from "./ids.js";
import { MAX_RUN_EVIDENCE_BLOB_BYTES, MAX_RUN_EVIDENCE_BYTES } from "./constants.js";
import { contentDigest, writeContentAddressedBlob } from "./blob-store.js";
import { textValue } from "./manifest-values.js";
import { operationPaths } from "./paths.js";
import type { EvidenceOverLimitReference, RunEvidenceRef } from "./run-types.js";
import type { OperationDigest } from "./types.js";

export type { EvidenceOverLimitReference } from "./run-types.js";

const MAX_EVIDENCE_EXCERPT_CHARS = 256;
const MAX_EVIDENCE_METADATA_BYTES = 128;
const EVIDENCE_OBSERVATION_CHUNK_BYTES = 64 * 1024;

/** Namespace and bounded transition metadata for one evidence capture. */
export interface RunEvidenceLocation {
  workspaceId: string;
  runId: OperationRunId;
  type: string;
  provenance: string;
}

/** Either a stored evidence reference or its bounded over-limit replacement. */
export type RunEvidenceWriteResult = RunEvidenceRef | EvidenceOverLimitReference;

/** Render a byte-stable escaped excerpt without decoding untrusted bytes as text. */
function escapedExcerpt(bytes: Uint8Array): string {
  let excerpt = "";
  for (const value of bytes) {
    const part = value >= 0x20 && value <= 0x7e && value !== 0x5c ? String.fromCharCode(value) : `\\x${value.toString(16).padStart(2, "0")}`;
    if (excerpt.length + part.length > MAX_EVIDENCE_EXCERPT_CHARS) break;
    excerpt += part;
  }
  return excerpt;
}

/** Validate bounded metadata before hashing or retaining any caller bytes. */
function evidenceMetadata(location: RunEvidenceLocation): Pick<RunEvidenceRef, "type" | "provenance"> {
  return {
    type: textValue(location.type, "evidence type", MAX_EVIDENCE_METADATA_BYTES),
    provenance: textValue(location.provenance, "evidence provenance", MAX_EVIDENCE_METADATA_BYTES),
  };
}

/** Build the exact normal reference from validated metadata and immutable bytes. */
function evidenceReference(
  metadata: Pick<RunEvidenceRef, "type" | "provenance">,
  bytes: Buffer,
): RunEvidenceRef {
  return {
    digest: `sha256:${contentDigest(bytes)}` as OperationDigest,
    byteCount: bytes.byteLength,
    ...metadata,
  };
}

/** Build the fixed reference emitted instead of persisting oversize evidence. */
function overLimitReference(
  reference: RunEvidenceRef,
  excerpt: string,
): EvidenceOverLimitReference {
  return {
    kind: "evidence-over-limit", digest: reference.digest,
    byteCount: reference.byteCount, type: reference.type, provenance: reference.provenance,
    excerpt,
  };
}

/** Hash one bounded caller input through a fixed-size immutable observation window. */
function observeOverLimitEvidence(bytes: Buffer): { digest: OperationDigest; excerpt: string } {
  if (bytes.byteLength > MAX_RUN_EVIDENCE_BYTES) {
    throw new Error(`evidence observation exceeds the ${MAX_RUN_EVIDENCE_BYTES}-byte cap`);
  }
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(Math.min(EVIDENCE_OBSERVATION_CHUNK_BYTES, bytes.byteLength));
  let excerpt = "";
  for (let offset = 0; offset < bytes.byteLength; offset += scratch.byteLength) {
    const count = Math.min(scratch.byteLength, bytes.byteLength - offset);
    Buffer.prototype.copy.call(bytes, scratch, 0, offset, offset + count);
    const observed = scratch.subarray(0, count);
    hash.update(observed);
    if (excerpt.length === 0) excerpt = escapedExcerpt(observed);
  }
  return { digest: `sha256:${hash.digest("hex")}` as OperationDigest, excerpt };
}

/** One run's evidence location: where its content-addressed blobs are created. */
interface RunEvidenceTarget {
  /** Create the blob named by `digestHex`, create-only and capped at `maxBytes`; its result is not consulted. */
  writeBlob(digestHex: string, bytes: Buffer, maxBytes: number): Promise<unknown>;
}

/** Where run evidence goes. No member takes a project root. */
export interface RunEvidenceBlobs {
  /** The run's evidence location; deriving it validates both identities and THROWS on an invalid one. */
  target(workspaceId: string, runId: OperationRunId): RunEvidenceTarget;
}

/** LOCAL DISK. The run's evidence directory under `root` and the incumbent content-addressed blob writer. */
function diskRunEvidenceBlobs(root: string): RunEvidenceBlobs {
  return {
    target: (workspaceId, runId) => {
      const paths = operationPaths(root, workspaceId);
      paths.evidenceRoot(runId);
      return {
        writeBlob: (digestHex, bytes, maxBytes) => writeContentAddressedBlob({
          root, bytes, maxBytes, digest: digestHex,
          file: paths.evidenceFile(runId, digestHex), ownedRoot: paths.evidenceRoot(runId),
        }),
      };
    },
  };
}

/** Durably create one bounded evidence blob or emit a non-persisting limit reference. */
export async function writeRunEvidenceCreateOnly(
  root: string,
  location: RunEvidenceLocation,
  bytes: Buffer,
): Promise<RunEvidenceWriteResult> {
  return writeRunEvidenceWith(diskRunEvidenceBlobs(root), location, bytes);
}

/** {@link writeRunEvidenceCreateOnly} over {@link RunEvidenceBlobs}: THE ONE BODY. Metadata, then the location, then the size decision. */
export async function writeRunEvidenceWith(
  blobs: RunEvidenceBlobs,
  location: RunEvidenceLocation,
  bytes: Buffer,
): Promise<RunEvidenceWriteResult> {
  const metadata = evidenceMetadata(location), target = blobs.target(location.workspaceId, location.runId);
  if (bytes.byteLength > MAX_RUN_EVIDENCE_BLOB_BYTES) {
    const observed = observeOverLimitEvidence(bytes);
    const reference = { digest: observed.digest, byteCount: bytes.byteLength, ...metadata };
    return overLimitReference(reference, observed.excerpt);
  }
  const preparedBytes = Buffer.from(bytes);
  const reference = evidenceReference(metadata, preparedBytes);
  await target.writeBlob(reference.digest.slice("sha256:".length), preparedBytes, MAX_RUN_EVIDENCE_BLOB_BYTES);
  return reference;
}
