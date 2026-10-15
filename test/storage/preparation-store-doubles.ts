/**
 * @file test/storage/preparation-store-doubles.ts
 * @description The in-memory `PreparationStoreLeafReads` that the storage tests
 * of the provenance verifier's CALLERS share: the shared lint doubles, the
 * profile-lint, status and summary binding tests, and the two tests that run
 * the verifier over copied preparation records. What a lifecycle read the
 * test vouches for looks like, what an untouched store looks like and what an
 * empty one looks like are stated once, here.
 *
 * WHAT THEY ARE. Three builders. `unaskedPreparationStore` fails the case if
 * any leaf, or the lifecycle authority, is asked. `emptyPreparationStore` is a
 * store with no preparation in it: the walk finds no `workspaces` directory,
 * every other leaf fails the case if asked, and the lifecycle authority lends
 * the read below or rejects with a held error. `vouchedLifecycleRead` is that
 * read: a successful one whose quarantine and prune storage hold nothing,
 * carrying only what the inventory scan reads.
 *
 * WHAT THEY ARE NOT. THE LIFECYCLE READ IS ONE THE TEST VOUCHES FOR, and the
 * proof the doubles answer always resolves: nothing here is evidence of
 * lifecycle capture, its lease or its provenance, and no authority is
 * established by it. The doubles confine nothing and check no owner, mode,
 * link or cap. Not a hosted store, not an access-control layer and not
 * `ProjectStore`; not a general test framework.
 */

import type { PreparationLifecycleReadV1 } from "../../src/preparations/lifecycle-snapshot/types.js";
import type { PreparationStoreLeafReads } from "../../src/preparations/store-leaf-reads.js";
import { unasked, type Note } from "./copied-project.js";

/** A lifecycle read THE TEST VOUCHES FOR: a successful one whose quarantine and prune storage hold nothing. It carries only what the scan reads. */
export function vouchedLifecycleRead(): PreparationLifecycleReadV1 {
  const nothingHeld = { health: "ok", traversalEntries: 0, bytes: 0, count: 0 };
  const snapshot = { storage: { prune: nothingHeld, quarantine: nothingHeld } };
  return { snapshot, status: "ok" } as unknown as PreparationLifecycleReadV1;
}

/** Leaves none of which may be asked, each failing the case under `name` if it is. */
export function unaskedPreparationStore(name: string): PreparationStoreLeafReads {
  const never = (member: string) => unasked(`${name}.${member}`);
  return {
    walk: { visitDirectory: never("walk"), observeLeaf: never("observe") },
    manifests: { manifestLeavesIn: never("manifest") }, key: { readKeyLeaf: never("key") },
    runLeaves: { readRunLeaf: never("run-leaf") }, evidence: { useEvidenceLeaf: never("evidence") },
    lifecycle: { borrowLifecycleRead: never("borrow"), assertLifecycleRead: never("assert") },
  };
}

/**
 * A store with no preparation in it. Each walk visit, borrow and proof logs
 * through `note` under `name` before it answers. A borrow rejects with
 * `borrowFails(n)` for the n-th borrow (from 1) when that returns an error.
 *
 * @param name - The prefix of every logged call.
 * @param note - Records each call line.
 * @param borrowFails - The error the n-th borrow rejects with, or `undefined` to lend.
 */
export function emptyPreparationStore(
  name: string, note: Note, borrowFails: (borrow: number) => Error | undefined = () => undefined,
): PreparationStoreLeafReads {
  let borrows = 0;
  return {
    ...unaskedPreparationStore(name),
    walk: {
      visitDirectory: async (directory) => { note(`${name}.walk ${directory}`); return "absent"; },
      observeLeaf: unasked(`${name}.observe`),
    },
    lifecycle: {
      borrowLifecycleRead: async (_maxRegistryEntries, use) => {
        borrows += 1;
        note(`${name}.borrow`);
        const refusal = borrowFails(borrows);
        if (refusal !== undefined) throw refusal;
        return use(vouchedLifecycleRead());
      },
      assertLifecycleRead: async () => { note(`${name}.assert`); },
    },
  };
}
