/**
 * @file test/storage/memory-store-tree.ts
 * @description One in-memory tree, and the one provider that walks it through
 * the preparation scanner's seam, shared by the two tests that run the REAL
 * walk with no disk: `preparation-store-walk-binding.test.ts`, which builds
 * its trees by hand to pin the scanner's own decisions, and
 * `preparation-list-show-binding.test.ts`, which copies a real store's entries
 * into one and runs the walk under the two read verbs. How a tree answers the
 * seam, and the seam's stated contract, are written once, here.
 *
 * THE PROVIDER FOLLOWS THE SEAM'S CONTRACT. It obtains an entry and THEN asks
 * `take()`, never asks at the end of a directory, delivers nothing more after a
 * refusal, and refuses a directory only before any entry. Its log separates an
 * entry PULLED from one DELIVERED to `inspect`, and records each release and
 * each leaf observation.
 *
 * WHAT IT IS NOT. It opens nothing, so it is NOT evidence of no-follow opening,
 * confinement, handle-bound metadata, or release on every path on a real disk.
 * Its "release" line records what THIS DOUBLE did. Every leaf is reported on
 * device 1: only `ino` tells two leaves apart. It is not a general test
 * framework: it holds this one tree shape and its one provider.
 */

import path from "node:path";
import type { PreparationStoreEntry, PreparationStoreWalkReads } from "../../src/preparations/orphan-scan.js";

/** One entry that is not a directory: its kind, size and identity, and how observing it answers. */
export interface TreeLeaf { type: "file" | "link" | "other"; size: number; ino: number; observe?: "absent" | "unavailable" }
/** One directory of named entries, in order, and whether visiting it is refused. */
export interface TreeDirectory { type: "directory"; entries: Record<string, TreeNode>; refuse?: "unavailable" | "unlistable" }
export type TreeNode = TreeLeaf | TreeDirectory;

/** The node at a store-relative path, if any. */
function nodeAt(root: TreeDirectory, relative: string): TreeNode | undefined {
  return relative.split(path.sep).reduce<TreeNode | undefined>(
    (node, name) => (node?.type === "directory" ? node.entries[name] : undefined), root);
}

/** The entry the scanner is handed for one tree node. */
export function entryOf(name: string, node: TreeNode): PreparationStoreEntry {
  return {
    name, isDirectory: () => node.type === "directory",
    isFile: () => node.type === "file", isSymbolicLink: () => node.type === "link",
  };
}

/** The seam over `root`, following its contract, with a log of every pull, delivery, release and observation. */
export function treeReads(root: TreeDirectory): { reads: PreparationStoreWalkReads; log: string[] } {
  const log: string[] = [];
  const reads: PreparationStoreWalkReads = {
    visitDirectory: async (directory, visitor) => {
      const node = nodeAt(root, directory);
      if (node === undefined) return "absent";
      if (node.type !== "directory") return "unavailable";
      if (node.refuse !== undefined) return node.refuse;
      try {
        for (const [name, child] of Object.entries(node.entries)) {
          log.push(`pull ${directory}/${name}`);
          if (!visitor.take()) break;
          log.push(`deliver ${directory}/${name}`);
          await visitor.inspect(entryOf(name, child));
        }
      } finally {
        log.push(`release ${directory}`);
      }
      return "visited";
    },
    observeLeaf: async (file, parent) => {
      log.push(`observe ${file} in ${parent}`);
      const node = nodeAt(root, file);
      if (node === undefined || node.type === "directory" || node.observe === "absent") return { kind: "absent" };
      if (node.observe === "unavailable") return { kind: "unavailable" };
      return { kind: "confirmed", size: node.size, dev: 1, ino: node.ino };
    },
  };
  return { reads, log };
}
