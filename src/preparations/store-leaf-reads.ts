/**
 * @file src/preparations/store-leaf-reads.ts
 * @description The preparation store's RAW LEAF READS in one place, and the
 * composition of the store's read bodies over them.
 *
 * Every reader of the preparation store already has one body that takes its
 * own leaves and no project root: the store walk, the manifest read, the key
 * read, the run read, the evidence read, and above them the inventory scan and
 * the run lookup. Until now each was joined to the next only on the local
 * disk, by a private builder calling the next reader's root-taking form. This
 * file joins them once, body to body: {@link preparationRunLookupReadsOver}
 * answers the lookup's reads by running the inventory scan, which runs the
 * walk and the manifest, key and run readers, all over
 * {@link PreparationStoreLeafReads}. Nothing is decided here: which leaf is
 * asked, in what order, under which cap, how a run is authenticated and what
 * every outcome means all stay in those bodies, unchanged.
 *
 * WHAT A LEAF IS HERE. Directory visits and leaf observations of the store
 * tree; one manifest leaf's bytes; the key leaf's text; one run leaf's text;
 * one lent evidence leaf. No member takes a project root. No member returns a
 * parsed record, a verdict or an inventory.
 *
 * ONE MEMBER IS NOT A LEAF: {@link PreparationLifecycleAuthority}. The scan
 * borrows one lifecycle read and relies on a proof that it is genuine, live
 * and belongs to this store. On the local disk both are the real capture and
 * the real check against the root. THIS IS ROOT-BOUND LOCAL-DISK AUTHORITY,
 * CARRIED AND NAMED, NOT MADE NEUTRAL: a named deferment, not an accepted
 * mechanism. A supplier whose proof always resolves would run the scan on any
 * snapshot, so neither this interface nor the composition is in a package
 * entry, and the proof obligation lies with whoever supplies it.
 *
 * WHAT THIS IS NOT. Not `ProjectStore`, not a hosted or access-control
 * contract, and it selects no backend. Naming the leaves rules on no
 * mechanism: on disk each is the same confined, no-follow, capped reader as
 * before. The root-taking readers and their private disk builders are
 * untouched and still serve every other caller.
 */

import { scanPreparationInventoryBorrowingFrom, type PreparationInventoryLifecycleReads } from "./capacity.js";
import {
  diskPreparationEvidenceLeafReads, readPreparationEvidenceBytesFrom, type PreparationEvidenceLeafReads,
} from "./evidence-store.js";
import {
  diskCurrentPreparationKeyLeafReads, readPreparationKeyEpochFrom, readPreparationKeyFrom, type PreparationKeyLeafReads,
} from "./key-epoch.js";
import {
  assertPreparationLifecycleRead, withPreparationLifecycleRead, type PreparationLifecycleReadV1,
} from "./lifecycle-snapshot/read.js";
import {
  diskPreparationManifestLeafReads, readPreparationManifestFrom, type PreparationManifestLeafReads,
} from "./manifest-store.js";
import {
  diskPreparationStoreWalkReads, scanActivePreparationStoreFrom, type PreparationStoreWalkReads,
} from "./orphan-scan.js";
import { diskPreparationRunLeafReads, readPreparationRunFrom, type PreparationRunLeafReads } from "./run-store.js";
import type { PreparationRunBinding } from "./run-types.js";
import type { PreparationRunLookupReads } from "./service-run-lookup.js";

/**
 * The lifecycle read the inventory scan borrows, and the proof it relies on.
 * NOT A LEAF AND NOT STORAGE-NEUTRAL: see the file overview. One supplier must
 * answer both, so that a read lent by the borrow is one the proof accepts.
 * Declared here and not exported by name: it is reached only as the
 * `lifecycle` member of {@link PreparationStoreLeafReads}.
 */
interface PreparationLifecycleAuthority {
  /** Lend ONE lifecycle read, captured over at most `maxRegistryEntries` registry entries, for the length of `use`. */
  borrowLifecycleRead<T>(maxRegistryEntries: number, use: (read: PreparationLifecycleReadV1) => Promise<T>): Promise<T>;
  /** Prove a successful lifecycle read is genuine, live and belongs to this store; reject otherwise. */
  assertLifecycleRead(read: PreparationLifecycleReadV1): Promise<void>;
}

/** What the store's read bodies ask of the store, as raw leaves, each in the shape its own reader declares. */
export interface PreparationStoreLeafReads {
  /** The store tree: directory visits and leaf observations. */
  walk: PreparationStoreWalkReads;
  /** One preparation's manifest leaf, as bytes. */
  manifests: PreparationManifestLeafReads;
  /** The current key's leaf, as text. The key is decoded, and its epoch derived, by the key reader's body. */
  key: PreparationKeyLeafReads;
  /** One run's leaf, as text. The run is parsed and AUTHENTICATED by the run reader's body, against the key read above. */
  runLeaves: Pick<PreparationRunLeafReads, "readRunLeaf">;
  /** One lent evidence leaf. Its bytes are verified against their digest by the evidence reader's body. */
  evidence: PreparationEvidenceLeafReads;
  /** The lifecycle read and its proof: disk authority, carried and named. */
  lifecycle: PreparationLifecycleAuthority;
}

/**
 * LOCAL DISK. The store's leaves for the project at `root`: each reader's own
 * disk leaves, and the real lifecycle capture and check. Building them does no
 * I/O AND NO PATH WORK: the walk's reads resolve their paths when they are
 * asked, exactly where the root-taking scan resolved them. In no package index.
 */
export function diskPreparationStoreLeafReads(root: string): PreparationStoreLeafReads {
  return {
    walk: {
      visitDirectory: (directory, visitor) => diskPreparationStoreWalkReads(root).visitDirectory(directory, visitor),
      observeLeaf: (file, parent) => diskPreparationStoreWalkReads(root).observeLeaf(file, parent),
    },
    manifests: diskPreparationManifestLeafReads(root),
    key: diskCurrentPreparationKeyLeafReads(root),
    runLeaves: diskPreparationRunLeafReads(root),
    evidence: diskPreparationEvidenceLeafReads(root),
    lifecycle: {
      borrowLifecycleRead: (maxRegistryEntries, use) => withPreparationLifecycleRead(root, use, { maxRegistryEntries }),
      assertLifecycleRead: (read) => assertPreparationLifecycleRead(root, read),
    },
  };
}

/** The key-epoch read and the authenticated run read both seams ask for, each its reader's body over the leaves. */
function keyAndRunReadsOver(leaves: PreparationStoreLeafReads): Pick<PreparationRunLookupReads, "readKeyEpoch" | "readRun"> {
  const runLeaves: PreparationRunLeafReads = {
    readRunLeaf: (binding, maxBytes) => leaves.runLeaves.readRunLeaf(binding, maxBytes),
    readKey: () => readPreparationKeyFrom(leaves.key),
  };
  return {
    readKeyEpoch: () => readPreparationKeyEpochFrom(leaves.key),
    readRun: (binding: PreparationRunBinding) => readPreparationRunFrom(runLeaves, binding),
  };
}

/** The inventory scan's reads over the leaves: the walk and the manifest reader, the key and run reads, and the lifecycle authority handed on as it is. */
function preparationInventoryReadsOver(leaves: PreparationStoreLeafReads): PreparationInventoryLifecycleReads {
  return {
    ...keyAndRunReadsOver(leaves),
    assertLifecycleRead: (read) => leaves.lifecycle.assertLifecycleRead(read),
    borrowLifecycleRead: (maxRegistryEntries, use) => leaves.lifecycle.borrowLifecycleRead(maxRegistryEntries, use),
    scanActiveStore: (options) => scanActivePreparationStoreFrom(leaves.walk, options),
    readManifest: (workspaceId, preparationId) => readPreparationManifestFrom(leaves.manifests, workspaceId, preparationId),
  };
}

/**
 * The run lookup's four reads over the store's leaves: THE ONE COMPOSITION.
 * The inventory is the scan's own borrowing body, run afresh on every call
 * with the default options, as the root-taking scan is.
 *
 * @param leaves - The store's raw leaf reads, and its lifecycle authority.
 * @returns The inventory scan, the key-epoch read, the run read and the verified evidence read.
 */
export function preparationRunLookupReadsOver(leaves: PreparationStoreLeafReads): PreparationRunLookupReads {
  const inventory = preparationInventoryReadsOver(leaves);
  return {
    ...keyAndRunReadsOver(leaves),
    scanInventory: () => scanPreparationInventoryBorrowingFrom(inventory),
    readEvidenceBytes: (location, digest, maxBytes) => readPreparationEvidenceBytesFrom(leaves.evidence, location, digest, maxBytes),
  };
}
