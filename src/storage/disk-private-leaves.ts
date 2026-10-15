/**
 * @file src/storage/disk-private-leaves.ts
 * @description Physical reads of ONE LEAF inside a local project's private
 * directory (`.llmwiki/`), for callers that have ALREADY resolved that
 * directory themselves. The embedding index, its retry markers and its legacy
 * raw reader are the callers, and these bodies are what those modules did
 * inline.
 *
 * This is a LOCAL PHYSICAL IMPLEMENTATION BOUNDARY, like
 * `disk-guarded-leaves.ts`: one implementation, nothing injected, no port. A
 * registered or hosted project uses `ProjectStore`; none of this is a step
 * toward hosting these files.
 *
 * WHAT EVERY FUNCTION HERE GUARANTEES, AND WHAT NONE DOES. Each checks the
 * LEAF ONLY: no link is followed, and the three reads accept a regular file
 * whose size is within the cap the caller passes. NONE CONFINES ANYTHING: no
 * root, no expected parent and no identity is checked, so each is safe only on
 * a leaf inside a private directory its caller has resolved and confined. That
 * resolution is deliberately not here.
 *
 * THE THREE READS ARE DIFFERENT ON PURPOSE and must not be merged. They differ
 * in what a failed open means, whether a failed `stat` or read propagates,
 * whether the result is text or bytes, and what a failing `close` does. Each
 * keeps exactly the behaviour of the caller it came from:
 *
 *  - {@link readPrivateLeafText} never rejects: absent, unavailable or text.
 *  - {@link readPrivateLeafTextOrThrow} returns `null` for "nothing usable
 *    there" and REJECTS for anything else, a failing `close` included.
 *  - {@link readPrivateLeafBytes} returns `null` only for "over the cap" and
 *    REJECTS for every failure, so its caller can map them all to one value.
 *
 * None of them parses, decodes a format, or knows what an embedding is.
 *
 * THE TWO WRITES ARE WEAKER STILL, and nothing above about no-follow reads
 * applies to them. {@link createPrivateLeafExclusive} and
 * {@link linkPrivateLeafNoReplace} are plain system calls BY PATH: both follow
 * links in the PARENT directories, neither checks a root, a parent or an
 * identity, and neither is hardened. Each guarantees exactly one thing, at the
 * final name only: the create fails if anything is already there, and the link
 * fails if the destination is already there. The project lock's publication
 * is their caller, and those two bodies are what it did inline.
 */

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { linkTempNoReplace } from "../utils/atomic-write-no-replace-durable.js";
import { readCappedNoFollow, type CappedLeafRead } from "../utils/confined-read.js";
import { NoFollowOpenError, openFileNoFollow } from "../utils/no-follow-open.js";

/** What is at a path, by one `lstat`: nothing, a regular file, or anything else (a link included). */
export type PrivateLeafKind = "absent" | "regular" | "other";

/**
 * NO GUARD. One `lstat(leaf)`, so a link is never followed: `ENOENT` is
 * `"absent"`, a regular file is `"regular"`, and a directory, a link or any
 * other object is `"other"`. Any other failure REJECTS with the raw error; a
 * permission error is not absence.
 */
export async function leafKindNoFollow(leaf: string): Promise<PrivateLeafKind> {
  try {
    return (await lstat(leaf)).isFile() ? "regular" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

/**
 * LEAF-ONLY CHECK, NOT CONFINED, NEVER REJECTS. The existing hardened
 * `readCappedNoFollow(leaf, maxBytes)`: a no-follow open, then the handle must
 * be a regular file of at most `maxBytes`. `absent` is `ENOENT` on the open
 * only; every other refusal or failure (a link, a non-regular file, over the
 * cap, a failed `stat` or read) is `unavailable`. A failing `close` is ignored.
 */
export async function readPrivateLeafText(leaf: string, maxBytes: number): Promise<CappedLeafRead> {
  return readCappedNoFollow(leaf, maxBytes);
}

/**
 * LEAF-ONLY CHECK, NOT CONFINED. Text, or `null` when nothing usable is there:
 * the open was refused as a link or a non-regular file, the leaf is absent
 * (`ENOENT`) or a link (`ELOOP`), or it is over `maxBytes`. Those three open
 * outcomes are `null` ONLY when they come from the open. Every other failure
 * REJECTS with the raw error: any other open error, a failed `stat`, a failed
 * read, and a failing `close`, which runs in `finally`.
 */
export async function readPrivateLeafTextOrThrow(leaf: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await openFileNoFollow(leaf, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof NoFollowOpenError || code === "ENOENT" || code === "ELOOP") return null;
    throw err;
  }
  try {
    const size = (await handle.stat()).size;
    if (size > maxBytes) return null;
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * LEAF-ONLY CHECK, NOT CONFINED. The leaf's raw bytes, or `null` when its size
 * is over `maxBytes` (checked on the open handle before anything is read).
 * EVERY failure REJECTS with the raw error: the no-follow open (absent, a
 * link, a non-regular file), `stat`, the read, and a failing `close`, which
 * runs in `finally` and so rejects even after `null` or the bytes were ready.
 * It decodes and parses nothing; the caller chooses the cap.
 */
export async function readPrivateLeafBytes(leaf: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await openFileNoFollow(leaf, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > maxBytes) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * UNCONFINED, NOT HARDENED. Create `leaf` and write `text` to it as UTF-8:
 * `open(leaf, "wx")`, write, close. The ONLY guarantee is the exclusive
 * create: it fails with the raw `EEXIST` if ANYTHING is at the final name, a
 * link included, so an existing object is never opened or replaced. Links in
 * the parent directories ARE followed, and no root or parent is checked.
 *
 * No mode is passed, so the mode is the process default filtered by the umask;
 * nothing is synced. Every failure REJECTS with the raw error: the open, the
 * write, and a failing `close`, which runs in `finally`. A failed write leaves
 * the created leaf behind; removing it is the caller's business.
 */
export async function createPrivateLeafExclusive(leaf: string, text: string): Promise<void> {
  const handle = await open(leaf, "wx");
  try {
    await handle.writeFile(text, "utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * UNCONFINED, NOT HARDENED. Give the file at `from` a second name, `to`: the
 * existing `linkTempNoReplace(from, to)`, one `link` by path. The ONLY
 * guarantee is no-replace at the destination: if `to` already exists it
 * rejects with `AtomicWriteCollisionError` and `to` is untouched. Every other
 * failure REJECTS with the raw error. Links in the parent directories are
 * followed, and no root, parent or identity is checked.
 */
export async function linkPrivateLeafNoReplace(from: string, to: string): Promise<void> {
  await linkTempNoReplace(from, to);
}
