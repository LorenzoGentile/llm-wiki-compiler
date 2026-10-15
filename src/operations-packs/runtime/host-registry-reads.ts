/**
 * @file src/operations-packs/runtime/host-registry-reads.ts
 * @description The three project reads the executable host-handler registry
 * makes while a phase runs, as ONE seam no member of which takes a project root:
 * the `reconcile` family's current-store snapshot, and a `phase-output`
 * binding's predecessor read (the durable run, then its committed output
 * evidence). The local form reads the host's root and run binding off the
 * registry's dependencies AT EACH READ, building the evidence location at that
 * read, exactly as the registry always did; the bound form reads each through
 * its store's own body at a fixed binding. Decisions stay in the registry.
 */

import {
  readPreparationEvidenceBytes, readPreparationEvidenceBytesFrom,
  type PreparationEvidenceBytesRead, type PreparationEvidenceLeafReads,
} from "../../preparations/evidence-store.js";
import {
  readPreparationRun, readPreparationRunFrom, type PreparationRunLeafReads, type PreparationRunRead,
} from "../../preparations/run-store.js";
import type { PreparationRunBinding } from "../../preparations/run-types.js";
import {
  packStoreSnapshot, packStoreSnapshotFrom, type PackStoreSnapshotReads, type PackStoreSnapshotV1,
} from "./store-snapshot.js";

/** What the registry reads while a phase runs. No member takes a project root. */
export interface PackHostReads {
  /** The current-store snapshot of one compared entity class. */
  storeSnapshot(entityType: string): Promise<PackStoreSnapshotV1>;
  /** The durable run this registry executes for, authenticated. */
  readRun(): Promise<PreparationRunRead>;
  /** One committed evidence object of the run (bare digest), within `maxBytes`. */
  evidenceBytes(digest: string, maxBytes: number): Promise<PreparationEvidenceBytesRead>;
}

/** LOCAL DISK. The incumbent root readers, reading `deps.root` and `deps.binding` at each read. */
export function diskPackHostReads(deps: { readonly root: string; readonly binding: PreparationRunBinding }): PackHostReads {
  return {
    storeSnapshot: (entityType) => packStoreSnapshot(deps.root, entityType),
    readRun: () => readPreparationRun(deps.root, deps.binding),
    evidenceBytes: (digest, maxBytes) => readPreparationEvidenceBytes(deps.root,
      { workspaceId: deps.binding.workspaceId, preparationId: deps.binding.preparationId }, digest, maxBytes),
  };
}

/** The same reads over each store's own body, for the run at `binding`. Building them does no I/O. */
export function packHostReadsOver(
  sources: { snapshot: PackStoreSnapshotReads; runs: PreparationRunLeafReads; evidence: PreparationEvidenceLeafReads },
  binding: PreparationRunBinding,
): PackHostReads {
  return {
    storeSnapshot: (entityType) => packStoreSnapshotFrom(sources.snapshot, entityType),
    readRun: () => readPreparationRunFrom(sources.runs, binding),
    evidenceBytes: (digest, maxBytes) => readPreparationEvidenceBytesFrom(sources.evidence,
      { workspaceId: binding.workspaceId, preparationId: binding.preparationId }, digest, maxBytes),
  };
}
