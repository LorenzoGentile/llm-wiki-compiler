/**
 * @file src/portable/store/disk-io.ts
 * @description The two confined reads the registered-project gate makes of the
 * publication ledger. Each reuses an existing safety primitive rather than
 * touching the filesystem directly: a handle-bound, no-follow, capped read of
 * one record, and a listing of one directory confined to the project root.
 * Nothing here writes.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { readConfinedLeafBuffer } from "../../utils/confined-read.js";
import { confineUnderRoot } from "../../utils/path-confine.js";
import { PortableRefusal } from "../errors.js";

/** Bytes of one project-relative file, `null` when absent. Refuses anything unreadable or over `maxBytes`. */
export async function readProjectFile(root: string, relative: string, maxBytes: number): Promise<Buffer | null> {
  const expectedDir = path.join(path.resolve(root), path.dirname(relative));
  const leaf = path.join(expectedDir, path.basename(relative));
  const result = await readConfinedLeafBuffer(root, leaf, expectedDir, maxBytes);
  if (result.kind === "absent") return null;
  if (result.kind !== "ok") throw new PortableRefusal("limit_exceeded", `unreadable or over cap: ${relative}`);
  return result.body;
}

/** Regular-file names directly inside a project-relative directory; none when it is absent. */
export async function listFileNames(root: string, relativeDir: string): Promise<string[]> {
  const abs = await confineUnderRoot(relativeDir, root, { mustExist: false });
  try {
    const entries = await readdir(abs, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
