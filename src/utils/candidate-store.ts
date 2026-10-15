/**
 * Shared filesystem primitives for candidate queues.
 *
 * Both the concept review queue (`compiler/candidates.ts`) and the rule
 * candidate queue (`compiler/rule-candidates.ts`) persist one JSON file per
 * candidate under a directory and list those files through the functions
 * here. The archive move below is used by the rule queue only
 * (`archiveRuleCandidate`); the concept queue archives rejected records
 * through its custody-guarded move instead. Each queue's own id/shape logic
 * stays local to its module.
 */

import path from "path";
import { makeDirectoryTree, removeLeaf, renameLeafUnguarded } from "../storage/disk-guarded-leaves.js";
import { locationExistsSync, overwriteLocationText } from "../storage/disk-locations.js";
import { diskRecordDirectory } from "../storage/disk-local-record-dirs.js";
import type { LocalRecordDirectory } from "../storage/legacy-local-record-dirs.js";
import { safeReadFile } from "./markdown.js";

/** Extension used for all candidate JSON files. */
const CANDIDATE_JSON_EXT = ".json";

/**
 * Turn a dotted candidate id into a single filesystem-safe path segment.
 *
 * Only characters outside `[a-z0-9._-]` are replaced (with `_`); dots are
 * PRESERVED. Collapsing dots to `-` (the old behavior) made `rulecand.a.b-c`
 * and `rulecand.a-b.c` map to the same file, silently overwriting one
 * candidate with the other. Keeping dots makes the mapping injective for the
 * ids this codebase emits (category in `[a-z0-9_]`, slug in `[a-z0-9-]`).
 * @param candidateId - The dotted candidate id.
 */
export function candidateFileId(candidateId: string): string {
  return candidateId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * List the file ids (basename without `.json`) of every candidate JSON file in
 * a directory, ignoring subdirectories (e.g. an `archive/` folder). Returns an
 * empty list when the directory does not exist.
 * @param dir - Absolute path to the candidate directory.
 */
export function listCandidateFileIds(dir: string): Promise<string[]> {
  return listCandidateFileIdsFrom(diskRecordDirectory(dir));
}

/**
 * {@link listCandidateFileIds} for a directory that is already resolved, with
 * the existence check and the listing made through `directory`. Ids come back
 * in the backend's listing order; no caller-visible sort happens here.
 */
export async function listCandidateFileIdsFrom(directory: LocalRecordDirectory): Promise<string[]> {
  if (!(await directory.exists())) return [];
  const entries = await directory.listEntries();
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(CANDIDATE_JSON_EXT)) continue;
    ids.push(entry.name.slice(0, -CANDIDATE_JSON_EXT.length));
  }
  return ids;
}

/**
 * Move a candidate JSON file into an archive location, creating the archive
 * directory if needed. Falls back to copy + unlink when `rename` fails for ANY
 * reason, not only across filesystems; a source that cannot be read in that
 * fallback is archived as an empty file. Returns false when the source file
 * does not exist.
 * @param sourcePath - Absolute path of the pending candidate file.
 * @param targetPath - Absolute archive destination path.
 */
export async function moveCandidateToArchive(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  if (!locationExistsSync(sourcePath)) return false;
  await makeDirectoryTree(path.dirname(targetPath));
  try {
    await renameLeafUnguarded(sourcePath, targetPath);
  } catch {
    const raw = await safeReadFile(sourcePath);
    await overwriteLocationText(targetPath, raw);
    await removeLeaf(sourcePath);
  }
  return true;
}
