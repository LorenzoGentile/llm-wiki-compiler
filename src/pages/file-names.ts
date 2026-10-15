/**
 * @file src/pages/file-names.ts
 * @description The entry names of one wiki page directory of a LOCAL project,
 * for a caller outside the core that lists pages without reading them. The
 * MCP resource templates use it to enumerate `wiki/concepts` and
 * `wiki/queries`.
 *
 * It exists so that code bundled outside the core does not make the
 * directory read itself and does not import a storage wrapper by relative
 * path: the one implementation of the listing stays in the core, and the
 * caller reaches it through the core's `compiler-cli` entry.
 *
 * WHAT IT IS NOT. It is not a page listing: the names are every entry of the
 * directory, returned as the operating system gives them. Nothing is sorted,
 * filtered, validated or read, so a name may belong to a directory, a link, a
 * dangling link, or a file that is not a page. It GUARDS NOTHING: the path is
 * `root` joined with the page directory and used as it is, links in it are
 * followed, and nothing is confined. The parameter's type names the two page
 * directories; that is a compile-time statement only, with no check at run
 * time. Any decision about which names are pages, and about what a failed
 * listing means, stays with the caller.
 *
 * This is a fact about a directory on this host. A registered or hosted
 * project uses `ProjectStore`, which makes no such promise.
 */

import path from "path";
import { listDirectoryNames } from "../storage/disk-guarded-leaves.js";
import type { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";

/**
 * NO GUARD. The entry names of `root/<pageDirectory>`, by one `readdir` of
 * that joined path, in the order returned.
 *
 * @param root - The project root, used as given.
 * @param pageDirectory - `wiki/concepts` or `wiki/queries`.
 * @returns Every entry name, unsorted and unfiltered.
 * @throws The raw error of the listing (a missing directory, a file in its
 *   place, a permission failure); the caller decides what that means.
 */
export function listPageFileNames(
  root: string,
  pageDirectory: typeof CONCEPTS_DIR | typeof QUERIES_DIR,
): Promise<string[]> {
  return listDirectoryNames(path.join(root, pageDirectory));
}
