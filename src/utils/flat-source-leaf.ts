/**
 * @file src/utils/flat-source-leaf.ts
 * @description The common path policy for sealing and re-verifying retained
 * source leaves, and the ONE read both source-evidence consumers make: the
 * host-side capture (`products/source-evidence-capture.ts`) and the runtime spec
 * builder (`operations-packs/runtime/source-evidence.ts`). Each consumer's body
 * takes {@link SourceLeafReads}; {@link diskSourceLeafReads} is the confined
 * read under `root/sources` they always made, called when asked. It is not a
 * hosted store and is in no package index.
 */

import path from "node:path";
import { readConfinedLeafBuffer, type CappedLeafReadBuffer } from "./confined-read.js";

/** The retention directory source-evidence paths are relative to. */
const SOURCES_DIR = "sources";

/** The one source read a source-evidence consumer makes. No member takes a project root. */
export interface SourceLeafReads {
  /** The flat leaf `relative` under `sources/`, confined there and capped at `maxBytes`. */
  readSourceLeaf(relative: string, maxBytes: number): Promise<CappedLeafReadBuffer>;
}

/** LOCAL DISK. The hardened confined read under `root/sources`, called when asked; building it does no I/O. */
export function diskSourceLeafReads(root: string): SourceLeafReads {
  return {
    readSourceLeaf: (relative, maxBytes) => {
      const sourcesRoot = path.join(root, SOURCES_DIR);
      return readConfinedLeafBuffer(sourcesRoot, path.join(sourcesRoot, relative), sourcesRoot, maxBytes);
    },
  };
}

/** Reject separators, hidden names and dot segments before confined reading. */
export function isFlatSourceLeaf(relative: string): boolean {
  return relative.length > 0 && !relative.includes("/") && !relative.includes("\\")
    && relative !== "." && relative !== ".." && !relative.startsWith(".");
}
