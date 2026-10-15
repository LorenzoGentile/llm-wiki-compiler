/**
 * @file src/eval/file-writes.ts
 * @description The three raw writes the evaluation's history writer and its
 * citation-cache clear make under `.llmwiki/eval`: make a directory tree, append
 * text to a file, remove a file. Each takes a project-relative path.
 *
 * WHY THIS IS ITS OWN SMALL SEAM. No existing local binding offers these three
 * as they are used here. The record binding replaces a file atomically and
 * confined, which is a different write; the history and the cache are appended
 * to and unlinked with no guard. This seam keeps exactly the incumbent calls.
 * It decides nothing: what is serialized, in what order the calls are made, and
 * whether a file is asked about before it is removed all stay with the caller.
 *
 * WHAT IT DOES NOT GIVE. None of the three is atomic, locked, confined, made
 * durable, journalled or revision-checked. The append FOLLOWS a link at the
 * path and writes through it. The remove unlinks the path itself, so a link is
 * removed and its target is left. This is the legacy local binding, not
 * `ProjectStore`, not a hosted contract and not an access-control layer.
 */

import path from "path";
import { makeDirectoryTree, removeLeaf, writeLeafAtomicUnconfined } from "../storage/disk-guarded-leaves.js";
import { appendLocationText } from "../storage/disk-locations.js";

/** What the history writer and the cache clear ask of the project. Every path is project-relative. */
export interface EvalFileWrites {
  /** Make the directory and any missing parents; an existing directory is not an error. Returns a promise that rejects raw. */
  makeDirectoryTree(relDir: string): Promise<void>;
  /** Add `text` at the end of the file as UTF-8, creating the file when absent and following a link. Returns a promise that rejects raw, for a missing parent directory and for a directory at the path too. */
  appendText(relPath: string, text: string): Promise<void>;
  /** Unlink the path itself. Returns a promise that rejects raw when nothing is there, and for a directory. */
  removeFile(relPath: string): Promise<void>;
}

/** LOCAL DISK. The writes for the project at `root`, built per call and held by none. Building them does no I/O. */
export function diskEvalFileWrites(root: string): EvalFileWrites {
  return {
    makeDirectoryTree: (relDir) => makeDirectoryTree(path.join(root, relDir)),
    appendText: (relPath, text) => appendLocationText(path.join(root, relPath), text),
    removeFile: (relPath) => removeLeaf(path.join(root, relPath)),
  };
}

/**
 * The one whole-file replacement the pending-candidate evaluator makes for its
 * report. It is NOT one of the three writes above and is not interchangeable
 * with the append: a reader sees the old text or the new, and the existing
 * writer makes the parent directory and applies its own leaf and parent
 * checks. It is not confined to the project, not locked and not made durable.
 * This is the legacy local binding, not `ProjectStore` and not a hosted
 * contract.
 */
export interface EvalAtomicWrites {
  /** Replace the file's whole text at a project-relative path. Returns a promise that rejects raw. */
  writeAtomic(relPath: string, text: string): Promise<void>;
}

/** LOCAL DISK. The existing unconfined atomic writer at `root` joined with the path. Building it does no I/O. */
export function diskEvalAtomicWrites(root: string): EvalAtomicWrites {
  return { writeAtomic: (relPath, text) => writeLeafAtomicUnconfined(path.join(root, relPath), text) };
}
