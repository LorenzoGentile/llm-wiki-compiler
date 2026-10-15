/**
 * @file src/operation-bundles/projection-store.ts
 * @description Founding authority for derived operation projections. Every
 * output is confined to one recipe-owned workspace root and paired with a
 * canonical format-neutral sidecar. The marker is published before output so
 * an interrupted create or replacement can be resumed without adopting bytes.
 *
 * ONE OBSERVE BODY AND ONE WRITE BODY over {@link ProjectionLeaves}: read the
 * output/marker pair, and publish one leaf with a revalidation callback the leaf
 * writer runs at its last pre-rename seam. The bodies own normalization,
 * classification, snapshots, marker-before-output order and verification; the
 * local-disk factory keeps the confined single-link reads and the strictly durable
 * exact-parent 0600 replacement, passing revalidation as the incumbent
 * `afterParentCheckForTest` hook.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { atomicWrite, type AtomicWriteOptions } from "../utils/atomic-write.js";
import { readConfinedLeafBuffer, type CappedLeafReadBuffer } from "../utils/confined-read.js";
import { MAX_PROJECTION_BYTES } from "./constants.js";
import { count, digest, exact, record, textValue } from "./manifest-values.js";
import {
  assertProjectionRelativeOutput, operationPaths, PROJECTION_MARKER_SUFFIX,
} from "./paths.js";
import type { OperationDigest } from "./types.js";

const MAX_MARKER_BYTES = 4 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Immutable manifest-owned metadata needed to address one projection output. */
export interface ProjectionTarget {
  workspaceId: string;
  recipeId: string;
  recipeDigest: OperationDigest;
  output: string;
  outputDigest: OperationDigest;
  criticality: "required" | "optional";
}

/** Format-neutral proof that an output belongs to one exact recipe identity. */
export interface ProjectionMarker {
  schemaVersion: 1;
  recipeId: string;
  recipeDigest: OperationDigest;
  relativeOutputPath: string;
  outputDigest: OperationDigest;
  byteCount: number;
}

export type ProjectionObservation =
  | { status: "absent" }
  | { status: "same"; marker: ProjectionMarker }
  | { status: "replaceable"; marker: ProjectionMarker }
  | { status: "conflict"; detail: string }
  | { status: "unavailable"; detail: string };

export type ProjectionWriteResult = "created" | "replaced" | "same";

/** Narrow deterministic fault seam used only by parent-swap tests. */
export interface ProjectionWriteOptions {
  beforeMarkerPublicationForTest?: () => Promise<void>;
  afterMarkerWriteForTest?: () => Promise<void>;
  beforeOutputDirectorySyncForTest?: AtomicWriteOptions["beforeDirectorySyncForTest"];
}

type ProjectionLeafSnapshot =
  | { kind: "absent" }
  | { kind: "ok"; body: Buffer };

type ProjectionLeafWriteOptions = Pick<AtomicWriteOptions,
  "afterParentCheckForTest" | "beforeDirectorySyncForTest">;

type ProjectionPair = { outputRead: CappedLeafReadBuffer; markerRead: CappedLeafReadBuffer };

/** What the projection bodies ask of the store. No member takes a project root. */
export interface ProjectionLeaves {
  /** The output and marker leaves of one normalized target; may reject for an unusable path. */
  readPair(target: ProjectionTarget): Promise<ProjectionPair>;
  /** Strictly replace the marker leaf; `revalidate` runs at the writer's last pre-rename seam. */
  writeMarker(target: ProjectionTarget, bytes: Buffer, revalidate: () => Promise<void>): Promise<void>;
  /** Strictly replace the output leaf likewise; `beforeDirectorySync` is a test seam only. */
  writeOutput(
    target: ProjectionTarget, bytes: Buffer, revalidate: () => Promise<void>,
    beforeDirectorySync?: AtomicWriteOptions["beforeDirectorySyncForTest"],
  ): Promise<void>;
}

/** Rebuild target fields before any filesystem await or directory creation. */
function normalizeTarget(target: ProjectionTarget): ProjectionTarget {
  const paths = operationPaths("/", target.workspaceId);
  paths.projectionRoot(target.recipeId);
  if (target.criticality !== "required" && target.criticality !== "optional") {
    throw new Error("projection criticality is unsupported");
  }
  return {
    workspaceId: target.workspaceId, recipeId: target.recipeId,
    recipeDigest: digest(target.recipeDigest, "projection recipeDigest"),
    output: assertProjectionRelativeOutput(target.output),
    outputDigest: digest(target.outputDigest, "projection outputDigest"),
    criticality: target.criticality,
  };
}

/** Return the exact recipe-owned output leaf after closed lexical validation. */
export function projectionOutputPath(root: string, target: ProjectionTarget): string {
  const normalized = normalizeTarget(target);
  return path.join(
    operationPaths(root, normalized.workspaceId).projectionRoot(normalized.recipeId),
    ...normalized.output.split("/"),
  );
}

/** Return the format-neutral sidecar adjacent to the recipe-owned output. */
export function projectionMarkerPath(root: string, target: ProjectionTarget): string {
  return `${projectionOutputPath(root, target)}${PROJECTION_MARKER_SUFFIX}`;
}

/** Hash exact raw output bytes into the manifest digest representation. */
function outputDigest(bytes: Uint8Array): OperationDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as OperationDigest;
}

/** Construct the only accepted sidecar shape. */
function markerFor(target: ProjectionTarget, byteCount: number): ProjectionMarker {
  return {
    schemaVersion: 1, recipeId: target.recipeId, recipeDigest: target.recipeDigest,
    relativeOutputPath: target.output, outputDigest: target.outputDigest, byteCount,
  };
}

/** Parse a canonical closed marker without trusting projection-controlled JSON. */
export function parseProjectionMarker(bytes: Buffer): ProjectionMarker {
  const text = UTF8_DECODER.decode(bytes);
  const item = record(parseBoundedUniqueJson(text, MAX_MARKER_BYTES), "projection marker");
  exact(item, [
    "schemaVersion", "recipeId", "recipeDigest", "relativeOutputPath", "outputDigest", "byteCount",
  ]);
  if (item.schemaVersion !== 1) throw new Error("projection marker schemaVersion is unsupported");
  const marker: ProjectionMarker = {
    schemaVersion: 1,
    recipeId: textValue(item.recipeId, "projection marker recipeId"),
    recipeDigest: digest(item.recipeDigest, "projection marker recipeDigest"),
    relativeOutputPath: assertProjectionRelativeOutput(item.relativeOutputPath),
    outputDigest: digest(item.outputDigest, "projection marker outputDigest"),
    byteCount: count(item.byteCount, "projection marker byteCount"),
  };
  if (marker.byteCount > MAX_PROJECTION_BYTES) throw new Error("projection marker byte count exceeds cap");
  if (!canonicalBytes(marker).equals(bytes)) throw new Error("projection marker is not canonical JSON");
  return marker;
}

/** Determine whether a valid marker authorizes this exact recipe-owned leaf. */
function markerOwnsTarget(marker: ProjectionMarker, target: ProjectionTarget): boolean {
  return marker.recipeId === target.recipeId
    && marker.recipeDigest === target.recipeDigest
    && marker.relativeOutputPath === target.output;
}

/** Read one output and its marker through the exact nested output parent. */
async function readProjectionPair(root: string, target: ProjectionTarget): Promise<ProjectionPair> {
  const output = projectionOutputPath(root, target), parent = path.dirname(output);
  const marker = projectionMarkerPath(root, target);
  const [outputRead, markerRead] = await Promise.all([
    readConfinedLeafBuffer(root, output, parent, MAX_PROJECTION_BYTES, { requireSingleLink: true }),
    readConfinedLeafBuffer(root, marker, parent, MAX_MARKER_BYTES, { requireSingleLink: true }),
  ]);
  return { outputRead, markerRead };
}

/** Parse and authorize one present marker, preserving read-fault taxonomy. */
function classifyProjectionMarker(
  target: ProjectionTarget,
  pair: ProjectionPair,
): ProjectionMarker | ProjectionObservation {
  if (pair.markerRead.kind === "unavailable") return { status: "unavailable", detail: "projection leaf is unavailable" };
  if (pair.markerRead.kind === "absent") return { status: "conflict", detail: "projection marker is missing" };
  let marker: ProjectionMarker;
  try { marker = parseProjectionMarker(pair.markerRead.body); }
  catch { return { status: "conflict", detail: "projection marker is invalid" }; }
  if (!markerOwnsTarget(marker, target)) return { status: "conflict", detail: "projection marker identity conflicts" };
  return marker;
}

/** Classify one already-confined pair against the requested target. */
function classifyProjection(
  target: ProjectionTarget,
  pair: ProjectionPair,
): ProjectionObservation {
  if (pair.outputRead.kind === "unavailable") return { status: "unavailable", detail: "projection leaf is unavailable" };
  if (pair.outputRead.kind === "absent" && pair.markerRead.kind === "absent") return { status: "absent" };
  const marker = classifyProjectionMarker(target, pair);
  if ("status" in marker) return marker;
  if (pair.outputRead.kind === "absent") return { status: "replaceable", marker };
  const exactBytes = pair.outputRead.body.byteLength === marker.byteCount
    && outputDigest(pair.outputRead.body) === marker.outputDigest;
  const intended = marker.outputDigest === target.outputDigest;
  return exactBytes && intended ? { status: "same", marker } : { status: "replaceable", marker };
}

/** Observe exact applied, recoverable, conflicting, absent, or unreadable state. */
export async function observeProjection(root: string, rawTarget: ProjectionTarget): Promise<ProjectionObservation> {
  return observeProjectionFrom(diskProjectionLeaves(root), rawTarget);
}

/** {@link observeProjection} over the projection leaves: the one observe body. */
async function observeProjectionFrom(leaves: ProjectionLeaves, rawTarget: ProjectionTarget): Promise<ProjectionObservation> {
  let target: ProjectionTarget, pair: ProjectionPair;
  try {
    target = normalizeTarget(rawTarget);
    pair = await leaves.readPair(target);
  } catch {
    return { status: "unavailable", detail: "projection path is unavailable" };
  }
  return classifyProjection(target, pair);
}

/** Snapshot and verify caller bytes before any read or write can yield control. */
function prepareProjection(target: ProjectionTarget, bytes: Buffer): { target: ProjectionTarget; bytes: Buffer } {
  const normalized = normalizeTarget(target);
  if (bytes.byteLength > MAX_PROJECTION_BYTES) throw new Error("projection output exceeds its byte cap");
  const prepared = Buffer.from(bytes);
  if (outputDigest(prepared) !== normalized.outputDigest) throw new Error("projection output digest mismatch");
  return { target: normalized, bytes: prepared };
}

/** Strictly replace one recipe-owned leaf and durably sync its directory chain. */
async function writeProjectionLeaf(
  root: string,
  leaf: string,
  bytes: Buffer,
  options: ProjectionLeafWriteOptions = {},
): Promise<void> {
  await atomicWrite(leaf, bytes, {
    confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: 0o600,
    ...options,
  });
}

/** The local-disk projection leaves for one root, built per call. In no package index. */
function diskProjectionLeaves(root: string): ProjectionLeaves {
  return {
    readPair: (target) => readProjectionPair(root, target),
    writeMarker: (target, bytes, revalidate) =>
      writeProjectionLeaf(root, projectionMarkerPath(root, target), bytes, { afterParentCheckForTest: revalidate }),
    writeOutput: (target, bytes, revalidate, beforeDirectorySync) =>
      writeProjectionLeaf(root, projectionOutputPath(root, target), bytes, {
        afterParentCheckForTest: revalidate,
        ...(beforeDirectorySync === undefined ? {} : { beforeDirectorySyncForTest: beforeDirectorySync }),
      }),
  };
}

/** Snapshot exact output bytes before this writer publishes its marker. */
function snapshotProjectionOutput(
  pair: ProjectionPair,
): ProjectionLeafSnapshot {
  if (pair.outputRead.kind === "absent") return { kind: "absent" };
  if (pair.outputRead.kind === "unavailable") throw new Error("projection output is unavailable");
  return { kind: "ok", body: Buffer.from(pair.outputRead.body) };
}

/** Snapshot exact marker bytes before this writer publishes its replacement. */
function snapshotProjectionMarker(
  pair: ProjectionPair,
): ProjectionLeafSnapshot {
  if (pair.markerRead.kind === "absent") return { kind: "absent" };
  if (pair.markerRead.kind === "unavailable") throw new Error("projection marker is unavailable");
  return { kind: "ok", body: Buffer.from(pair.markerRead.body) };
}

/** Compare one confined read result with its exact initial snapshot. */
function projectionLeafMatches(
  read: CappedLeafReadBuffer,
  expected: ProjectionLeafSnapshot,
): boolean {
  return expected.kind === "absent"
    ? read.kind === "absent"
    : read.kind === "ok" && read.body.equals(expected.body);
}

/** Refuse marker publication when either initial leaf changed. */
async function assertProjectionPairUnchanged(
  leaves: ProjectionLeaves,
  target: ProjectionTarget,
  expectedOutput: ProjectionLeafSnapshot,
  expectedMarker: ProjectionLeafSnapshot,
): Promise<void> {
  const pair = await leaves.readPair(target).catch(() => undefined);
  const markerMatches = pair !== undefined && projectionLeafMatches(pair.markerRead, expectedMarker);
  const outputMatches = pair !== undefined && projectionLeafMatches(pair.outputRead, expectedOutput);
  if (!markerMatches || !outputMatches) {
    throw new Error("projection marker or output changed concurrently before marker publication");
  }
}

/** Require marker ownership and output bytes to remain exact before rename. */
async function assertProjectionUnchanged(
  leaves: ProjectionLeaves,
  target: ProjectionTarget,
  expectedOutput: ProjectionLeafSnapshot,
  expectedMarker: Buffer,
): Promise<void> {
  const pair = await leaves.readPair(target).catch(() => undefined);
  const markerMatches = pair?.markerRead.kind === "ok" && pair.markerRead.body.equals(expectedMarker);
  const outputMatches = pair !== undefined && projectionLeafMatches(pair.outputRead, expectedOutput);
  if (!markerMatches || !outputMatches) throw new Error("projection changed concurrently before output publication");
}

/** Publish and verify the marker that authorizes one projection output. */
async function publishProjectionMarker(
  leaves: ProjectionLeaves,
  prepared: ReturnType<typeof prepareProjection>,
  expectedOutput: ProjectionLeafSnapshot,
  expectedMarker: ProjectionLeafSnapshot,
  options: ProjectionWriteOptions,
): Promise<Buffer> {
  const markerBytes = canonicalBytes(markerFor(prepared.target, prepared.bytes.byteLength));
  await leaves.writeMarker(prepared.target, markerBytes, async () => {
    await options.beforeMarkerPublicationForTest?.();
    await assertProjectionPairUnchanged(leaves, prepared.target, expectedOutput, expectedMarker);
  });
  await options.afterMarkerWriteForTest?.();
  const committedMarker = await observeProjectionFrom(leaves, prepared.target);
  if (committedMarker.status !== "replaceable" && committedMarker.status !== "same") {
    throw new Error(`projection marker did not retain ownership: ${committedMarker.status}`);
  }
  return markerBytes;
}

/** Publish sidecar then output so interrupted work remains explicitly resumable. */
export async function writeProjectionLocked(
  root: string,
  rawTarget: ProjectionTarget,
  rawBytes: Buffer,
  options: ProjectionWriteOptions = {},
): Promise<ProjectionWriteResult> {
  return writeProjectionWith(diskProjectionLeaves(root), rawTarget, rawBytes, options);
}

/** {@link writeProjectionLocked} over the projection leaves: marker, then output, then verification. */
export async function writeProjectionWith(
  leaves: ProjectionLeaves,
  rawTarget: ProjectionTarget,
  rawBytes: Buffer,
  options: ProjectionWriteOptions = {},
): Promise<ProjectionWriteResult> {
  const prepared = prepareProjection(rawTarget, rawBytes);
  let pair: ProjectionPair;
  try { pair = await leaves.readPair(prepared.target); }
  catch { throw new Error("projection is unavailable: projection path is unavailable"); }
  const initial = classifyProjection(prepared.target, pair);
  if (initial.status === "unavailable" || initial.status === "conflict") {
    throw new Error(`projection is ${initial.status}: ${initial.detail}`);
  }
  const expectedOutput = snapshotProjectionOutput(pair);
  const expectedMarker = snapshotProjectionMarker(pair);
  const markerBytes = await publishProjectionMarker(
    leaves, prepared, expectedOutput, expectedMarker, options,
  );
  await leaves.writeOutput(prepared.target, prepared.bytes,
    () => assertProjectionUnchanged(leaves, prepared.target, expectedOutput, markerBytes),
    options.beforeOutputDirectorySyncForTest);
  const verified = await observeProjectionFrom(leaves, prepared.target);
  if (verified.status !== "same") throw new Error(`projection verification failed: ${verified.status}`);
  if (initial.status === "absent") return "created";
  return initial.status === "same" ? "same" : "replaced";
}
