/**
 * @file test/storage/lint-sources-doubles.ts
 * @description The in-memory `LintSources` shared by the two storage tests that
 * run the REAL lint coordinator with no project directory:
 * `lint-coordinator-binding.test.ts`, which runs the coordinator itself, and
 * `lint-command-binding.test.ts`, which runs the lint command over it. Both
 * need every lint source over one copied project, with each call logged; the
 * doubles were written in the first of those files and are stated once, here.
 *
 * WHAT THEY ARE. Maps of text and listings from a copied project, and a call
 * log. Each double logs one line per call before it answers: `schema <path>`,
 * `state <path>`, `freshness open`, `freshness read <source>`, `page <path>`,
 * `candidates <dir>`, `cited <path>`, `marker <file>`, `runs.private`, the
 * workflow rule's profile reads under `workflow.`, and the appendix's under
 * `appendix.`.
 *
 * WHAT THEY ASSUME ABOUT THE COPY. No journal, no embedding marker, no workflow
 * run, no pending candidate and no product binding: those five answer "absent"
 * whatever the copy holds. Four members are cast to their seam type because the
 * bodies under test use two or three members of a wider interface.
 *
 * WHAT THEY ARE NOT. Not a store, not an access-control layer, not
 * `ProjectStore`, and nothing about confinement on disk.
 */

import path from "node:path";
import type { LintSources } from "../../src/linter/lint-sources.js";
import type { LocalEntry } from "../../src/storage/legacy-local-reads.js";
import { LLMWIKI_DIR, SOURCES_DIR, WIKI_GRAPH_DIR } from "../../src/utils/constants.js";
import type { GraphStoreReads } from "../../src/utils/jsonl-store.js";
import { absentJournalOf, effectiveProfileOf, enoent, entityScansOf, heldText, unasked, type Minted } from "./copied-project.js";
import { unaskedPreparationStore } from "./preparation-store-doubles.js";

/** A copied project these doubles can read: its copy, the directory its pages are reported under, and its real root for entity pages. */
export type CopiedLintProject = Minted<{ real: string }>;

/** The profile checks' sources over a copy: the entity directories, and stores that are read from the copy's graph directory. */
export function entitiesOver(project: CopiedLintProject, note: (call: string) => void): LintSources["entities"] {
  const { copy } = project;
  const graph: GraphStoreReads = { readStore: async (config) => {
    note(`graph ${config.fileName}`);
    return copy.files.get(`${WIKI_GRAPH_DIR}/${config.fileName}`) ?? null;
  } };
  return {
    scans: entityScansOf(copy, project.onDisk.real, note),
    graph,
    events: {
      graph,
      resolvePrivateDir: async () => (copy.listings.has(LLMWIKI_DIR) ? LLMWIKI_DIR : null),
      readHeadLeaf: async (dir, name) => {
        const rel = `${dir}/${name}`;
        return copy.files.has(rel) ? { kind: "text", text: heldText(copy, rel) } : { kind: "absent" };
      },
    },
    // The sample profile declares no relation and no artifact, so the standing and artifact checks ask none of these.
    artifacts: { provenance: unaskedPreparationStore("provenance"), artifacts: { artifactAt: unasked("artifacts.artifactAt") }, graph },
    pages: { readEntityPage: unasked("pages.readEntityPage") },
  };
}

/** Profile checks' sources none of whose members may be asked: what a default-profile run must leave alone. */
export const NO_ENTITIES = {
  scans: { openEntityDirectory: unasked("entities.scans") }, graph: { readStore: unasked("entities.graph") },
  pages: { readEntityPage: unasked("entities.pages") },
} as unknown as LintSources["entities"];

/** The page, candidate and cited-source members over a copy. Each page read is logged as `page <path>`. */
function pageSourcesOver(project: CopiedLintProject, note: (call: string) => void): Pick<LintSources, "pages" | "candidates" | "cited"> {
  const { copy, dir } = project;
  const entriesOf = async (relDir: string): Promise<LocalEntry[]> => {
    const entries = copy.listings.get(relDir);
    if (entries === undefined) throw enoent();
    return entries;
  };
  return {
    pages: {
      locate: (rel) => path.join(dir, rel),
      readText: async (rel) => { note(`page ${rel}`); return heldText(copy, rel); },
      listEntries: entriesOf,
      listNames: async (relDir) => (await entriesOf(relDir)).map((entry) => entry.name),
      exists: async (rel) => copy.listings.has(rel),
    },
    candidates: { directory: async (relDir) => { note(`candidates ${relDir}`); return null; }, leaf: unasked("candidates.leaf") },
    cited: { exists: async (rel) => { note(`cited ${rel}`); return copy.files.has(rel); }, readText: async (rel) => heldText(copy, rel) },
  };
}

/** Every lint source over a copy, each call logged under its member's name. `entities` is the caller's. */
export function lintSourcesOver(project: CopiedLintProject, log: string[], entities: LintSources["entities"], over: Partial<LintSources> = {}): LintSources {
  const { copy, dir } = project;
  const note = (call: string): void => { log.push(call); };
  return {
    schema: {
      exists: async (rel: string) => { note(`schema ${rel}`); return copy.files.has(rel); },
      readText: async (rel: string) => heldText(copy, rel), locate: (rel: string) => path.join(dir, rel),
    } as unknown as LintSources["schema"],
    state: {
      exists: async (rel: string) => { note(`state ${rel}`); return copy.files.has(rel); },
      readTextNoFollow: async (rel: string) => heldText(copy, rel),
    } as unknown as LintSources["state"],
    sourceFreshness: { openSources: async () => {
      note("freshness open");
      return {
        resolveSource: async (file) => (copy.files.has(`${SOURCES_DIR}/${file}`) ? `${SOURCES_DIR}/${file}` : null),
        readText: async (source) => { note(`freshness read ${source}`); return heldText(copy, source); },
      };
    } },
    ...pageSourcesOver(project, note),
    journal: absentJournalOf(note),
    embeddings: { readMarkerText: async (markerFile) => { note(`marker ${markerFile}`); return { kind: "absent" }; } },
    workflows: {
      profile: effectiveProfileOf(copy, (call) => note(`workflow.${call}`)),
      runs: { resolvePrivateDir: async () => { note("runs.private"); return null; } } as unknown as LintSources["workflows"]["runs"],
    },
    profile: effectiveProfileOf(copy, (call) => note(`appendix.${call}`)),
    entities,
    ...over,
  };
}
