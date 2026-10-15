/**
 * @file src/operation-bundles/capacity-caps.ts
 * @description Pure operation capacity arithmetic, split out of `capacity.ts`
 * unchanged: the named launch caps a staging projection must satisfy, and the
 * per-owner aggregate caps for bundle payloads and run evidence. Nothing here
 * reads storage; `capacity.ts` re-exports the public names so every caller
 * imports them exactly as before.
 */

import { capacityViolation, uniqueInventoryBytes as uniqueBytes } from "../utils/inventory-arithmetic.js";
import {
  MAX_ACTIVE_BUNDLE_BYTES, MAX_BUNDLE_PAYLOAD_BYTES, MAX_CATALOG_FILE_BYTES,
  MAX_CATALOG_RECORD_BYTES, MAX_CATALOG_RECORDS_PER_WORKSPACE,
  MAX_MANIFEST_BYTES, MAX_MUTATIONS_PER_BUNDLE, MAX_NEW_BUNDLES_PER_STAGING_CALL,
  MAX_PAYLOAD_BYTES, MAX_PENDING_BUNDLES, MAX_PROJECTION_BYTES,
  MAX_RETAINED_SOURCE_BYTES, MAX_RUN_EVIDENCE_BLOB_BYTES,
  MAX_RUN_EVIDENCE_BYTES, MAX_WORKSPACE_PROJECTION_BYTES,
  MAX_WORKSPACE_RETAINED_SOURCE_BYTES,
} from "./constants.js";
import type { OperationInventoryProblem, OperationLeafObservation } from "./orphan-scan.js";

/** Every dimension preflight must project before the first staged write. */
export interface StageCapacityProjection {
  newBundles: number;
  pendingBundles: number;
  mutationCount: number;
  largestPayloadBytes: number;
  bundlePayloadBytes: number;
  manifestBytes: number;
  activeBundleBytes: number;
  largestSourceBytes: number;
  workspaceSourceBytes: number;
  catalogRecordBytes: number;
  catalogRecords: number;
  catalogBytes: number;
  largestProjectionBytes: number;
  workspaceProjectionBytes: number;
  largestEvidenceBytes: number;
  runEvidenceBytes: number;
}

/** Typed refusal naming the cap that invalidated the complete projection. */
export class StageCapacityError extends Error {
  constructor(public readonly dimension: string) {
    super(`operation staging exceeds the ${dimension} cap`);
    this.name = "StageCapacityError";
  }
}

const CAP_ENTRIES: ReadonlyArray<[
  keyof StageCapacityProjection, number, string,
]> = [
  ["newBundles", MAX_NEW_BUNDLES_PER_STAGING_CALL, "new-bundles"],
  ["pendingBundles", MAX_PENDING_BUNDLES, "pending-bundles"],
  ["mutationCount", MAX_MUTATIONS_PER_BUNDLE, "mutations"],
  ["largestPayloadBytes", MAX_PAYLOAD_BYTES, "payload"],
  ["bundlePayloadBytes", MAX_BUNDLE_PAYLOAD_BYTES, "bundle-payloads"],
  ["manifestBytes", MAX_MANIFEST_BYTES, "manifest"],
  ["activeBundleBytes", MAX_ACTIVE_BUNDLE_BYTES, "active-bytes"],
  ["largestSourceBytes", MAX_RETAINED_SOURCE_BYTES, "source"],
  ["workspaceSourceBytes", MAX_WORKSPACE_RETAINED_SOURCE_BYTES, "workspace-sources"],
  ["catalogRecordBytes", MAX_CATALOG_RECORD_BYTES, "catalog-record"],
  ["catalogRecords", MAX_CATALOG_RECORDS_PER_WORKSPACE, "catalog-records"],
  ["catalogBytes", MAX_CATALOG_FILE_BYTES, "catalog"],
  ["largestProjectionBytes", MAX_PROJECTION_BYTES, "projection"],
  ["workspaceProjectionBytes", MAX_WORKSPACE_PROJECTION_BYTES, "workspace-projections"],
  ["largestEvidenceBytes", MAX_RUN_EVIDENCE_BLOB_BYTES, "evidence"],
  ["runEvidenceBytes", MAX_RUN_EVIDENCE_BYTES, "run-evidence"],
];

/** Require nonnegative exact arithmetic and enforce every inclusive cap. */
export function assertStageCapacity(projection: StageCapacityProjection): void {
  const dimension = capacityViolation(projection, CAP_ENTRIES);
  if (dimension !== undefined) throw new StageCapacityError(dimension);
}

/** Group payloads and evidence by their exact protocol owner. */
function aggregateBlobGroups(
  leaves: readonly OperationLeafObservation[],
): Map<string, OperationLeafObservation[]> {
  const groups = new Map<string, OperationLeafObservation[]>();
  for (const leaf of leaves) {
    const key = aggregateBlobOwner(leaf);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), leaf]);
  }
  return groups;
}

/** Return the stable aggregate owner key for one counted blob. */
function aggregateBlobOwner(leaf: OperationLeafObservation): string | null {
  if (leaf.kind === "payload") {
    return `payload\0${leaf.workspaceId ?? ""}\0${leaf.bundleId ?? ""}`;
  }
  if (leaf.kind === "evidence") {
    return `evidence\0${leaf.workspaceId ?? ""}\0${leaf.runId ?? ""}`;
  }
  return null;
}

/** Mark aggregate bundle-payload and per-run evidence overages unavailable. */
export function assertAggregateBlobCaps(
  leaves: readonly OperationLeafObservation[],
  problems: OperationInventoryProblem[],
): void {
  const groups = aggregateBlobGroups(leaves);
  for (const [key, values] of groups) {
    const evidence = key.startsWith("evidence\0"), bytes = uniqueBytes(values);
    const limit = evidence ? MAX_RUN_EVIDENCE_BYTES : MAX_BUNDLE_PAYLOAD_BYTES;
    if (bytes > limit) {
      problems.push({
        dimension: evidence ? "run-evidence" : "bundle-payloads",
        detail: "operation blob aggregate exceeds its owner cap",
      });
    }
  }
}
