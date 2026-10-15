/**
 * Shared source discovery: regular files with stable POSIX-relative
 * keys. Excluded directories are pruned before walking; symlinks are not sources.
 */
import { diskLocalReads } from "../storage/disk-local-reads.js";
import type { LegacyLocalReads, LocalDirectory } from "../storage/legacy-local-reads.js";
import { SOURCES_DIR } from "../utils/constants.js";
import { isSourceExcluded, loadSourceSelectionFrom, type SourceSelection } from "./selection.js";

/** Selected real files plus skipped aliases for inventory diagnostics. */
interface SourceScan {
  files: string[];
  symlinks: string[];
}

/** Walk selected real directories, preserving dot-files and exact relative names. */
async function walkSources(directory: LocalDirectory, prefix: string, selection: SourceSelection): Promise<SourceScan> {
  const result: SourceScan = { files: [], symlinks: [] };
  for (const entry of await directory.listEntries(prefix)) {
    const id = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isSourceExcluded(id, selection)) continue;
    if (entry.kind === "file") result.files.push(id);
    else if (entry.kind === "link") result.symlinks.push(id);
    else if (entry.kind === "directory" && selection.recursive) {
      const nested = await walkSources(directory, id, selection);
      result.files.push(...nested.files);
      result.symlinks.push(...nested.symlinks);
    }
  }
  return result;
}

/**
 * Scan without following aliases; absent/untrusted sources roots yield no entries.
 * THE ONE BODY of the scan: `reads` serve the source selection when none is
 * given, then the sources directory and every listing beneath it.
 */
export async function scanSelectedSourcesFrom(reads: LegacyLocalReads, selection?: SourceSelection): Promise<SourceScan> {
  const policy = selection ?? await loadSourceSelectionFrom(reads);
  const directory = await reads.realDirectory(SOURCES_DIR);
  if (directory === null) return { files: [], symlinks: [] };
  const result = await walkSources(directory, "", policy);
  result.files.sort();
  result.symlinks.sort();
  return result;
}

/** Scan the local project at `root`; see {@link scanSelectedSourcesFrom}. */
export function scanSelectedSources(root: string, selection?: SourceSelection): Promise<SourceScan> {
  return scanSelectedSourcesFrom(diskLocalReads(root), selection);
}

/** Markdown sources read through `reads`, in the order compilation consumes them. */
export async function listSelectedSourceFilesFrom(reads: LegacyLocalReads, selection?: SourceSelection): Promise<string[]> {
  return (await scanSelectedSourcesFrom(reads, selection)).files.filter((id) => id.endsWith(".md"));
}

/** List selected regular files, including raw non-Markdown viewer inventory. */
export function listSelectedSourceEntries(root: string, selection?: SourceSelection): Promise<string[]> {
  return listSelectedSourceEntriesFrom(diskLocalReads(root), selection);
}

/** {@link listSelectedSourceEntries} through `reads`, which also serve the source selection when none is given. */
export async function listSelectedSourceEntriesFrom(reads: LegacyLocalReads, selection?: SourceSelection): Promise<string[]> {
  return (await scanSelectedSourcesFrom(reads, selection)).files;
}

/** Markdown subset consumed by compilation and source-record inventory. */
export async function listSelectedSourceFiles(root: string, selection?: SourceSelection): Promise<string[]> {
  return (await listSelectedSourceEntries(root, selection)).filter((id) => id.endsWith(".md"));
}
