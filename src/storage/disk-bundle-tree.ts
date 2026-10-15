/**
 * @file src/storage/disk-bundle-tree.ts
 * @description Four operations on a directory tree a local caller names, used
 * by the OKF import and export: how many bytes a file holds, whether a path
 * resolves, a byte-for-byte copy of one file to another, and the removal of
 * an entry with everything under it. Each is ONE Node call its caller used to
 * make inline, moved here unchanged.
 *
 * They are here, and not beside the single-location helpers, because they are
 * what a BUNDLE needs: an import reads a directory the user points at, and an
 * export writes one the user chooses. That directory may be outside the
 * project altogether. These are facts about paths on this host. A registered
 * or hosted project uses `ProjectStore`, which makes no such promise and must
 * not be given one.
 *
 * NO FUNCTION HERE GUARDS ANYTHING. A path is used exactly as the caller
 * passes it. Nothing is confined, no root is checked, no link is refused, and
 * every answer is a snapshot that can be stale at once. There is no retry, no
 * catch and no option. Whether a path may be read, overwritten or DESTROYED
 * is decided by the caller, before it calls.
 *
 * TWO OF THESE WRITE, AND ONE DESTROYS.
 *  - {@link copyLocationBytes} overwrites its destination and follows a link
 *    there. It copies bytes and never decodes them.
 *  - {@link removeTreeForced} is the ONLY recursive delete in `src/storage`.
 *    It removes whatever it is given, with all its contents, and treats a
 *    missing entry as success. A link is removed as a link: what it points at
 *    is not touched. It has THREE production callers, and each decides for
 *    itself what may be destroyed: the OKF export, which clears a recognized
 *    prior bundle only after its own refusals have run; the product-package
 *    store, which removes its own project-private temp tree after a commit;
 *    and the local product install, which removes its own scratch directory
 *    under the operating system's temporary directory, OUTSIDE any project.
 *
 * {@link locationByteSize} is separate from the kind helpers on purpose: a
 * size is metadata of what the path resolves to, not a statement of what kind
 * of entry is there.
 */

import { access, copyFile, rm, stat } from "node:fs/promises";

/**
 * NO GUARD. `(await stat(location)).size`: the size in bytes of what the path
 * resolves to. Links are followed, so a link to a file gives that file's
 * size. REJECTS with the raw error when the path does not resolve.
 */
export async function locationByteSize(location: string): Promise<number> {
  return (await stat(location)).size;
}

/**
 * NO GUARD. `access(location)`: resolves when the path resolves to something,
 * of any kind, and REJECTS with the raw error otherwise. Links are followed,
 * so a dangling link rejects. Returns Node's promise itself; the caller turns
 * resolve-or-reject into whatever answer it needs.
 */
export function locationAccessible(location: string): Promise<void> {
  return access(location);
}

/**
 * NO GUARD, AND IT WRITES. `copyFile(from, to)`: the bytes of `from`, exactly
 * and undecoded. An existing `to` is OVERWRITTEN and a link there is followed.
 * Not atomic and not made durable. Returns Node's promise itself. REJECTS
 * with the raw error.
 */
export function copyLocationBytes(from: string, to: string): Promise<void> {
  return copyFile(from, to);
}

/**
 * NO GUARD, AND IT DESTROYS. `rm(location, { recursive: true, force: true })`:
 * the entry and everything under it. A missing entry is not an error. A link
 * is removed as a link and its target is left alone. Nothing is recoverable
 * afterwards. Returns Node's promise itself. REJECTS with the raw error.
 */
export function removeTreeForced(location: string): Promise<void> {
  return rm(location, { recursive: true, force: true });
}
