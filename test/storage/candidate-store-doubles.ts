/**
 * @file test/storage/candidate-store-doubles.ts
 * @description The candidate-store pieces the candidate binding suites share:
 * the move preflight, rejection and connector supersession suites. Each suite
 * snapshots a real project's `.llmwiki` tree, seeds ONE in-memory store from that
 * snapshot, and re-runs the same operations over its own `CandidateStoreMoveReads`
 * double.
 *
 * - {@link snapshotTree}: the real `.llmwiki` tree as file texts and directories.
 * - {@link heldOf} / {@link memoryStateOf}: the held leaves seeded from a snapshot,
 *   with synthetic inodes, and the held directory set beside them.
 * - {@link capturedDirectoryOf} / {@link sequentialIdentity}: directory capture
 *   over the held directory set.
 * - {@link heldLeavesOf}: the leaf mechanisms (directory create, leaf path, leaf
 *   read, guarded rename), each create and rename also sent to the suite's sink.
 * - {@link unaskedWriteLeaves}: the four write members a move-only double refuses.
 *
 * The suite still assembles its double, choosing its own probe, re-proof,
 * listing and unused members. These pieces decide only physical facts, never a
 * custody verdict.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CandidateStoreBinding, CandidateStoreMoveReads } from "../../src/compiler/candidate-custody.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR, LLMWIKI_DIR } from "../../src/utils/constants.js";

/** Where the in-memory project lives; it fills only a move request's validated legacy field. */
export const MEM_PROJECT = "/memory/project";
export const pendingRel = (fileId: string): string => `${CANDIDATES_DIR}/${fileId}.json`;
export const archivedRel = (fileId: string): string => `${CANDIDATES_ARCHIVE_DIR}/${fileId}.json`;

/** The `.llmwiki` tree as encoded file bytes and directories. */
export interface Tree { files: Record<string, string>; dirs: string[] }
/** One held leaf: its bytes and its synthetic inode. */
export interface Held { bytes: Buffer; ino: number }
/** How a suite encodes file bytes in its snapshot: exact bytes as base64, or UTF-8 text. */
export type TreeEncoding = "base64" | "utf8";

/** Snapshot `.llmwiki` on disk: each file's bytes in `encoding`, and every directory, relative to the project. */
export async function snapshotTree(root: string, encoding: TreeEncoding, rel = LLMWIKI_DIR, tree: Tree = { files: {}, dirs: [] }): Promise<Tree> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => null);
  if (entries === null) return tree;
  tree.dirs.push(rel);
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) await snapshotTree(root, encoding, child, tree);
    else tree.files[child] = (await readFile(path.join(root, child))).toString(encoding);
  }
  return tree;
}

/** The held leaves of a snapshot, in its file order, each given inode 100 + its position. */
const heldOf = (before: Tree, encoding: TreeEncoding): Map<string, Held> =>
  new Map(Object.entries(before.files).map(([rel, text], index) => [rel, { bytes: Buffer.from(text, encoding), ino: 100 + index }]));

/** One memory store's starting state: a snapshot's held leaves (see {@link heldOf}) and its directories. */
export const memoryStateOf = (before: Tree, encoding: TreeEncoding): { held: Map<string, Held>; dirs: Set<string> } =>
  ({ held: heldOf(before, encoding), dirs: new Set(before.dirs) });

/** The four write members a move-only store double never expects to be asked, each refused through the suite's own `unused`. */
export const unaskedWriteLeaves = (unused: (member: string) => () => Promise<never>) =>
  ({ leafPresent: unused("leafPresent"), createLeaf: unused("createLeaf"), replaceLeaf: unused("replaceLeaf"), removeLeaf: unused("removeLeaf") });

/** A project-relative path of an in-memory location. */
export const memoryRelOf = (location: string): string => path.posix.relative(MEM_PROJECT, location);

/** A directory's synthetic identity. */
export type DirectoryIdentity = (relDir: string) => CandidateStoreBinding["identity"];

/** Identities numbered in first-capture order, stable for the store's life. */
export function sequentialIdentity(): DirectoryIdentity {
  const inos = new Map<string, number>();
  return (relDir) => ({ dev: 1, ino: inos.get(relDir) ?? inos.set(relDir, inos.size + 1).size });
}

/** Capture a held directory under `identity`, or null when it is not held; `note` first records the capture when given. */
export function capturedDirectoryOf(dirs: Set<string>, identity: DirectoryIdentity, note?: (call: string) => void): CandidateStoreMoveReads["captureDirectory"] {
  return async (relDir) => {
    note?.(`dir ${relDir}`);
    const location = path.posix.join(MEM_PROJECT, relDir);
    return dirs.has(relDir) ? { dir: location, realDir: location, identity: identity(relDir) } : null;
  };
}

/** Whether a leaf read is size-capped, and whether the rename throws (a fault with no disk twin). */
export interface HeldLeafOptions { capped: boolean; moveThrows?: boolean }

/** The leaf mechanisms over `held` and `dirs`; every directory create and rename is also sent to `effect`. */
export function heldLeavesOf(
  held: Map<string, Held>, dirs: Set<string>, effect: (event: string) => void, options: HeldLeafOptions,
): Pick<CandidateStoreMoveReads, "ensureDirectory" | "leafPath" | "readLeaf" | "moveLeaf"> {
  return {
    ensureDirectory: async (relDir) => { if (dirs.has(path.posix.dirname(relDir)) && !dirs.has(relDir)) { dirs.add(relDir); effect(`ensure ${relDir}`); } },
    leafPath: async (fileId, location) => path.posix.join(MEM_PROJECT, location === "pending" ? pendingRel(fileId) : archivedRel(fileId)),
    readLeaf: async (request) => {
      const leaf = held.get(memoryRelOf(request.leaf));
      if (leaf === undefined) return { kind: "absent" };
      if (options.capped && leaf.bytes.byteLength > request.maxBytes) return { kind: "unavailable" };
      return { kind: "ok", bytes: leaf.bytes, fileIdentity: { dev: 1, ino: leaf.ino } };
    },
    moveLeaf: async (request) => {
      if (options.moveThrows) throw new Error("EIO: rename failed");
      const source = held.get(memoryRelOf(request.source));
      const digest = source && createHash("sha256").update(source.bytes).digest("hex");
      if (!source || source.ino !== request.expect.fileIdentity.ino || digest !== request.expect.sha256) return false;
      held.delete(memoryRelOf(request.source));
      held.set(memoryRelOf(request.destination), source);
      effect(`move ${memoryRelOf(request.source)} -> ${memoryRelOf(request.destination)}`);
      return request.afterRename();
    },
  };
}
