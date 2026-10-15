/**
 * @file src/storage/disk-durable-leaves.ts
 * @description Eight local-disk operations the product-package install and the
 * active-product binding made inline: two small reads, three plain creations
 * whose MODE matters, one best-effort directory sync, and the two incumbent
 * atomic writers reached with the caller's own options. Each is one call, or
 * one existing body, moved here unchanged.
 *
 * This is a LOCAL PHYSICAL IMPLEMENTATION BOUNDARY, like the other
 * `storage/disk-*` files: one implementation, nothing injected, no port. A
 * path may be in the project, in the operating system's temporary directory,
 * or in a directory an operator named; these functions do not know which. A
 * registered or hosted project uses `ProjectStore`; none of this is a step
 * toward hosting these files.
 *
 * THE FILE NAME IS NOT A PROMISE. Nothing here adds confinement, atomicity or
 * durability. For the two atomic writers those properties are exactly what the
 * CALLER'S OPTIONS ask the incumbent writer for, and nothing more: the options
 * object is passed through untouched, with no default, no added key and no
 * removed key. The other six functions are not atomic and not durable at all,
 * and {@link syncDirectoryBestEffort} deliberately tolerates a filesystem that
 * cannot sync a directory.
 *
 * WHAT THESE DO NOT KNOW. None knows a product, package, member, receipt or
 * binding. They raise no domain error, choose no message, hold no lock and
 * decide no capacity or collision question. Each reports what happened and its
 * caller decides what that means.
 *
 * LOOK-ALIKES THAT MUST NOT BE MERGED.
 *  - {@link readCappedBytesClassified} is NOT the bytes form of
 *    `readLeafTextNoFollowCapped` in `disk-handle-leaves.ts`. That one returns
 *    a failed open as a value CARRYING the raw error, reports an over-cap leaf
 *    WITH its size, REJECTS for a failed `stat` or read, and REJECTS for a
 *    failing `close`. This one never rejects: a failed open is `absent` or
 *    `unavailable` with no error, an over-cap leaf is `unavailable` with no
 *    size, a failed `stat` or read is `unavailable`, and a failing `close` is
 *    ignored.
 *  - {@link locationByteSizeNoFollow} is NOT `locationByteSize` in
 *    `disk-bundle-tree.ts`, which follows a link to its target.
 *  - {@link syncDirectoryBestEffort} is NOT the strict `fsyncDirectory` of
 *    the atomic writer, which fails closed where this one tolerates.
 */

import { lstat, mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  atomicWrite, atomicWriteNoReplaceDurable,
  type AtomicWriteNoReplaceDurableOptions, type AtomicWriteOptions,
} from "../utils/atomic-write.js";
import { readCappedNoFollowBuffer, type CappedLeafReadBuffer } from "../utils/confined-read.js";

/**
 * LEAF-ONLY CHECK, NOT CONFINED, NEVER REJECTS. The existing hardened
 * `readCappedNoFollowBuffer(leaf, maxBytes)`: a no-follow open, then the
 * handle must be a regular file of at most `maxBytes`, then its raw bytes.
 * The answer is a classification: `absent` is `ENOENT` on the open only;
 * every other refusal or failure (a link, a non-regular file, over the cap, a
 * failed `stat` or read) is `unavailable`, with no error and no size. A
 * failing `close` is ignored. It decodes nothing.
 */
export function readCappedBytesClassified(leaf: string, maxBytes: number): Promise<CappedLeafReadBuffer> {
  return readCappedNoFollowBuffer(leaf, maxBytes);
}

/**
 * NO GUARD. `(await lstat(location)).size`: the size in bytes of the entry
 * ITSELF. No link is followed, so a link gives the link's own size, never its
 * target's. REJECTS with the raw error when nothing is there.
 */
export async function locationByteSizeNoFollow(location: string): Promise<number> {
  return (await lstat(location)).size;
}

/**
 * NO GUARD. `mkdtemp(prefix)`: a new directory whose name is `prefix` plus a
 * suffix the operating system chooses, created owner-only. Returns its path.
 * The prefix is used as given; nothing is confined. REJECTS with the raw
 * error.
 */
export function makeUniqueDirectory(prefix: string): Promise<string> {
  return mkdtemp(prefix);
}

/**
 * NO GUARD. `mkdir(dir, { recursive: true, mode })`. The mode applies only to
 * directories this call creates and is filtered by the process umask; an
 * existing directory keeps its mode and is not an error. REJECTS with the raw
 * error.
 */
export async function makeDirectoryTreeWithMode(dir: string, mode: number): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
}

/**
 * NO GUARD, AND IT OVERWRITES. `writeFile(location, bytes, { mode })`:
 * whatever is at the path is replaced, and a link there is followed. NOT
 * atomic and NOT synced: a reader can see a partial file, and a crash can
 * leave one. The mode applies only when the file is created, filtered by the
 * umask; an existing file keeps its mode. Returns Node's promise itself.
 * REJECTS with the raw error.
 */
export function writeLocationBytesWithMode(location: string, bytes: Uint8Array, mode: number): Promise<void> {
  return writeFile(location, bytes, { mode });
}

/**
 * BEST EFFORT, NOT A DURABILITY PROOF. Open the directory read-only and
 * `sync` it, so a completed rename or create inside it is asked to reach the
 * device where the filesystem can do that. A failed open or sync with code
 * `EINVAL`, `EPERM`, `ENOTSUP` or `ENOENT` is TOLERATED and resolves; any
 * other failure REJECTS with the raw error. The handle never leaves this
 * function: it is closed once in `finally` if it was opened, and a failing
 * `close` is ignored.
 */
export async function syncDirectoryBestEffort(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOENT") throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * EXISTING WRITER'S PROPERTIES ONLY, AS THE CALLER'S OPTIONS ASK.
 * `atomicWrite(leaf, content, opts)` with `opts` passed through UNCHANGED:
 * the writer's own options type, production flags and test seams alike.
 * Whether the write is confined, exact-parent, durable or strictly durable,
 * and with what mode, is decided entirely by the caller's object. Returns the
 * writer's promise itself; its rejections pass through.
 */
export function replaceLeafAtomicWith(leaf: string, content: string | Uint8Array, opts: AtomicWriteOptions): Promise<void> {
  return atomicWrite(leaf, content, opts);
}

/**
 * EXISTING WRITER'S PROPERTIES ONLY, AS THE CALLER'S OPTIONS ASK.
 * `atomicWriteNoReplaceDurable(leaf, content, opts)` with `opts` passed
 * through UNCHANGED: the incumbent create-only writer, which never replaces
 * an existing destination. Returns the writer's promise itself; its
 * rejections, the collision error included, pass through.
 */
export function createLeafNoReplaceDurableWith(
  leaf: string, content: string | Uint8Array, opts: AtomicWriteNoReplaceDurableOptions,
): Promise<void> {
  return atomicWriteNoReplaceDurable(leaf, content, opts);
}
