/**
 * @file src/sources/store.ts
 * @description Source-store I/O API for the llmwiki SDK: list / get / delete
 * sources under `sources/`. Source IDs are relative POSIX paths including `.md`
 * (e.g. "records/note.md"), never joined with an extra extension. The pure
 * record/guard logic lives in `./source-record.js`; this module is the thin
 * filesystem layer over it. Read-only-ish (delete aside), no LLM.
 *
 * ONE BODY PER OPERATION, OVER THE STORE'S OWN LEAVES. Each `…From` body keeps the
 * id validation, the missing-directory answer, paging and the cursor check, the
 * symlink/non-regular skip and the `ENOENT` distinctions, over
 * {@link SourceStoreLeaves}. The root forms keep their signatures and pass
 * {@link diskSourceStoreLeaves}, whose members call the incumbent confined,
 * no-follow helpers when asked. `dir` is the opaque handle `sourcesDir` returned.
 */
import path from "path";
import { removeLeaf } from "../storage/disk-guarded-leaves.js";
import { locationKindNoFollow } from "../storage/disk-local-reads.js";
import { readLocationText } from "../storage/disk-locations.js";
import { listSelectedSourceFiles } from "./scan.js";
import { confinedRegularFile, resolveSourcesDir } from "../utils/path-confine.js";
import {
  assertSafeSourceId,
  toRecord,
  type SourceRecord,
  type ListSourcesOptions,
  type ListSourcesResult,
} from "./source-record.js";

export type { SourceRecord, ListSourcesOptions, ListSourcesResult } from "./source-record.js";

/** What the source operations ask of the store. No member takes a project root. */
export interface SourceStoreLeaves {
  /** The confined `sources/` directory handle, or null when the project has none. */
  sourcesDir(): Promise<string | null>;
  /** Every selected source id, in listing order. */
  listIds(): Promise<string[]>;
  /** The confined regular file behind `id`, or null for a missing entry, a symlink, a directory or an escape. */
  regularFile(dir: string, id: string): Promise<string | null>;
  /** One confined file's text; may reject (`ENOENT` when it vanished). */
  readText(file: string): Promise<string>;
  /** Unlink `id`'s leaf; may reject (`ENOENT` when it vanished). */
  removeLeaf(dir: string, id: string): Promise<void>;
  /** Resolve when anything at all is at `id`, without following a link; reject `ENOENT` when nothing is. */
  probeNoFollow(dir: string, id: string): Promise<void>;
}

/** LOCAL DISK: the incumbent helpers for one project root, built per call, each called when asked. In no package index. */
export function diskSourceStoreLeaves(root: string): SourceStoreLeaves {
  return {
    sourcesDir: () => resolveSourcesDir(root),
    listIds: () => listSelectedSourceFiles(root),
    regularFile: (dir, id) => confinedRegularFile(dir, id),
    readText: (file) => readLocationText(file),
    removeLeaf: (dir, id) => removeLeaf(path.join(dir, id)),
    probeNoFollow: async (dir, id) => { await locationKindNoFollow(path.join(dir, id)); },
  };
}

export async function listSources(root: string, options: ListSourcesOptions = {}): Promise<ListSourcesResult> {
  return listSourcesFrom(diskSourceStoreLeaves(root), options);
}

/** {@link listSources} over the store's own leaves: the one body. */
export async function listSourcesFrom(leaves: SourceStoreLeaves, options: ListSourcesOptions = {}): Promise<ListSourcesResult> {
  const dir = await leaves.sourcesDir();
  if (dir === null) return { sources: [] };
  const files = await leaves.listIds();
  const offset = options.cursor !== undefined ? Number(options.cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`invalid listSources cursor: ${options.cursor}`);
  const limit = options.limit && options.limit > 0 ? options.limit : files.length;
  const page = files.slice(offset, offset + limit);
  const sources: SourceRecord[] = [];
  for (const id of page) {
    // Skip any entry that is not a confined regular file (symlinks — whether
    // escaping or in-tree aliases — are never sources).
    const real = await leaves.regularFile(dir, id);
    if (real === null) continue;
    const content = await leaves.readText(real);
    sources.push(toRecord(id, content, options.includeBody === true));
  }
  const next = offset + page.length < files.length ? String(offset + page.length) : undefined;
  return next !== undefined ? { sources, cursor: next } : { sources };
}

/**
 * Delete the source file `sources/<id>` (the id already includes `.md`).
 * Returns `true` if a file was removed, `false` if the (valid) id had no file.
 * Reconciliation of the now-orphaned compiled page is deferred to the next
 * `compile`, consistent with how llmwiki already handles deleted sources —
 * this does not touch `wiki/`.
 */
export async function deleteSource(root: string, id: string): Promise<boolean> {
  return deleteSourceFrom(diskSourceStoreLeaves(root), id);
}

/** {@link deleteSource} over the store's own leaves: the one body. */
export async function deleteSourceFrom(leaves: SourceStoreLeaves, id: string): Promise<boolean> {
  assertSafeSourceId(id);
  const dir = await leaves.sourcesDir();
  if (dir === null) return false;
  // Not a confined regular file (missing, symlink, or directory) → nothing to delete.
  // Keeps delete coherent with getSource/listSources.
  const real = await leaves.regularFile(dir, id);
  if (real === null) return false;
  try {
    await leaves.removeLeaf(dir, id);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * True when `sources/<id>` is genuinely ABSENT — nothing at that path at all.
 *
 * Deliberately narrower than "`getSource` returned null", which also covers
 * present-but-not-a-valid-source: a symlink, a directory, an unreadable entry.
 * `llmwiki rm` needs the distinction to tell "a previous removal already
 * unlinked this file" (resumable — see `planRemoval` in `./removal.ts`) from
 * "this name is occupied by something that was never a source" (not
 * resumable, and never silently deleted around).
 *
 * `lstat`, not `stat`: a DANGLING symlink is present, not absent, and must not
 * be mistaken for an interrupted removal.
 *
 * @param root - Absolute project root.
 * @param id - Source-relative path including `.md`.
 * @returns `true` when nothing exists at `sources/<id>`, `false` when
 *   something does — of any kind.
 */
export async function sourceFileMissing(root: string, id: string): Promise<boolean> {
  return sourceFileMissingFrom(diskSourceStoreLeaves(root), id);
}

/** {@link sourceFileMissing} over the store's own leaves: the one body. */
export async function sourceFileMissingFrom(leaves: SourceStoreLeaves, id: string): Promise<boolean> {
  assertSafeSourceId(id);
  const dir = await leaves.sourcesDir();
  if (dir === null) return true;
  try {
    await leaves.probeNoFollow(dir, id);
    return false;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return true;
    throw err;
  }
}

export async function getSource(root: string, id: string): Promise<SourceRecord | null> {
  return getSourceFrom(diskSourceStoreLeaves(root), id);
}

/** {@link getSource} over the store's own leaves: the one body. */
export async function getSourceFrom(leaves: SourceStoreLeaves, id: string): Promise<SourceRecord | null> {
  assertSafeSourceId(id);
  const dir = await leaves.sourcesDir();
  if (dir === null) return null;
  // Only confined regular files are valid sources (symlinks — in-tree or escaping — are not).
  const real = await leaves.regularFile(dir, id);
  if (real === null) return null;
  let content: string;
  try {
    content = await leaves.readText(real);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  return toRecord(id, content, true);
}
