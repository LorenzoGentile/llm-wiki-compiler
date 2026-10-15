/**
 * @file src/eval/file-reads.ts
 * @description The two raw reads the evaluation's history readers and its
 * threshold check make of one project file each: is it there, and its whole
 * text.
 *
 * WHY THIS IS ITS OWN SMALL SEAM. Those readers ask whether the file exists
 * SYNCHRONOUSLY and then start the read in the same turn. The ordinary local
 * read binding answers existence through a promise, which would start the read
 * one turn later; the readers run beside other reads inside `runEval`, so that
 * is a change in the order calls reach the disk. This seam keeps the answer
 * synchronous. It holds nothing else: no parsing, no default, no decision about
 * what an absent, empty or malformed file means. All of that stays in the
 * readers.
 *
 * WHAT IT IS NOT. Both reads are the unguarded local ones: links are followed
 * and nothing is confined. This is the legacy local binding, not
 * `ProjectStore`, not a hosted contract and not an access-control layer.
 */

import path from "path";
import { locationExistsSync, readLocationText } from "../storage/disk-locations.js";

/** What a history reader or the threshold check asks of the project, for one project-relative file. */
export interface EvalFileReads {
  /** Whether the path resolves, following links, answered AT ONCE and not through a promise. A failed lookup is `false`, as absence is. */
  existsSync(relPath: string): boolean;
  /** The file's whole text as UTF-8, following links. Returns a promise that rejects raw when it cannot be read, for a directory too. */
  readText(relPath: string): Promise<string>;
}

/** LOCAL DISK. The reads for the project at `root`, built per call and held by none. Building them does no I/O. */
export function diskEvalFileReads(root: string): EvalFileReads {
  return {
    existsSync: (relPath) => locationExistsSync(path.join(root, relPath)),
    readText: (relPath) => readLocationText(path.join(root, relPath)),
  };
}
