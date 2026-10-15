/**
 * @file src/compiler/candidate-store-paths.ts
 * @description Confined directory classification for review candidate stores.
 * Ordinary paths retain public in-root alias support. Explicit strict scans
 * require literal directories; both modes bind canonical paths and inodes and
 * reject escapes, broken links, non-directories and unavailable components.
 *
 * The directory-binding mechanics live in `../storage/disk-record-directory.ts`
 * and are re-exported here unchanged. A leaf path is resolved through the
 * local-directory record-directory binding (`../storage/disk-local-record-dirs.ts`).
 */

import { isSafeFilenameComponent } from "../profile/identity.js";
import { captureCandidateDirectoryBinding } from "../storage/disk-record-directory.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";

export {
  captureCandidateDirectoryBinding,
  UnsafeCandidateDirError,
  type CandidateDirectoryBinding,
} from "../storage/disk-record-directory.js";

/** Extension used for every candidate JSON file. */
const CANDIDATE_EXT = ".json";

/** Resolve a safe candidate leaf while retaining the public lexical path form. */
export async function confinedCandidateFilePath(
  root: string,
  dir: string,
  id: string,
  onUnsafeId: (id: string) => Error,
): Promise<string> {
  if (!isSafeFilenameComponent(id)) throw onUnsafeId(id);
  return (await diskLocalRecordDirs(root).leaf(dir, `${id}${CANDIDATE_EXT}`)).location;
}

/** Resolve one confined candidate directory, including in-root aliases. */
export async function resolveConfinedCandidatesDir(
  root: string,
  dir: string,
): Promise<string | null> {
  return (await captureCandidateDirectoryBinding(root, dir))?.realDir ?? null;
}
