/**
 * @file test/storage/export-profile-doubles.ts
 * @description The JSON export profile block's sources over one copied
 * project, shared by the two storage tests that run the export with no project
 * directory: `export-profile-block-binding.test.ts`, which runs the block
 * itself, and `export-json-binding.test.ts`, which runs the whole in-memory
 * JSON export over it. The doubles were written in the first of those files
 * and are stated once, here.
 *
 * WHAT THEY DECIDE. Only what a copy can: whether a path is held, what a
 * directory lists, and a held file's text. The profile binding leaf is
 * `absent` (the shared `noBindingLeafDouble`), the real path is the one the
 * caller gives, and the preparation store is NEVER ASKED: a profile that arms
 * an execution-provenance requirement fails the case instead of being
 * answered. Every double logs `<step>:<call>` to the caller's log, under the
 * steps `profile`, `scans`, `graph`, `pages`, `artifacts` and `real`.
 *
 * `graphStoreOf` is also used by `okf-profile-blocks-binding.test.ts`.
 *
 * WHAT THEY ARE NOT. Not a store, not an access-control layer, not
 * `ProjectStore`, and nothing about confinement on disk.
 */

import type { ExportProfileSources } from "../../src/export/profile-block.js";
import type { EntityPageReads } from "../../src/profile/lifecycle-read.js";
import { WIKI_GRAPH_DIR } from "../../src/utils/constants.js";
import type { GraphStoreReads } from "../../src/utils/jsonl-store.js";
import { artifactStoreOver } from "./artifact-store-double.js";
import { effectiveProfileOf, entityScansOf, type Copy, type Note } from "./copied-project.js";
import { unaskedPreparationStore } from "./preparation-store-doubles.js";

/** The graph-store read over the copy: a held store's text, or `null` when the copy holds none. */
export function graphStoreOf(copy: Copy, note: Note): GraphStoreReads {
  return { readStore: async (config) => { note(config.fileName); return copy.files.get(`${WIKI_GRAPH_DIR}/${config.fileName}`) ?? null; } };
}

/** One entity page's whole text over the copy, or `absent`. */
function pagesOf(copy: Copy, note: Note): EntityPageReads {
  return { readEntityPage: async (directory, slug) => {
    note(`${directory}/${slug}`);
    const body = copy.files.get(`${directory}/${slug}.md`);
    return body === undefined ? { kind: "absent" } : { kind: "ok", body };
  } };
}

/**
 * The export profile block's sources over one copy, each logging `<step>:<call>`.
 *
 * @param copy - The copied project.
 * @param realRoot - What the real-path look answers, and the root entry locators sit under.
 * @param log - The caller's ordered log.
 */
export function exportProfileSourcesOf(copy: Copy, realRoot: string, log: string[]): ExportProfileSources {
  const as = (step: string): Note => (call) => { log.push(`${step}:${call}`); };
  return {
    profile: effectiveProfileOf(copy, as("profile")),
    scans: entityScansOf(copy, realRoot, as("scans")),
    graph: graphStoreOf(copy, as("graph")),
    pages: pagesOf(copy, as("pages")),
    artifacts: artifactStoreOver(copy.files, as("artifacts")),
    provenance: unaskedPreparationStore("provenance"),
    realRoot: async () => { as("real")("realRoot"); return realRoot; },
  };
}
