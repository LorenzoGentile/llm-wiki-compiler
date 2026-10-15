/**
 * @file test/storage/copied-local-reads.ts
 * @description Two doubles over a copied project (see `copied-project.ts`) that
 * the whole-consumer suites share: `status-consumer-binding.test.ts`,
 * `context-pack-binding.test.ts`, `query-answer-binding.test.ts` and
 * `query-publication-binding.test.ts`.
 *
 * - {@link copiedSourceReadsOf}: the ordinary local reads the selected-source
 *   listing makes, which are the configuration text and the sources directory.
 * - {@link copiedLocalReadsOf}: EVERY ordinary local read over the copy, for a
 *   consumer that also lists, stats and reads pages. A path the copy does not
 *   hold is `missing`, and nothing here can answer a link or an escape.
 * - {@link copiedCitationSourcesOf}: the strict answer-citation index's project
 *   over the copy (`query-answer-binding`, `query-publication-binding`): each
 *   held page's whole text served as positional bytes, and the candidate queue.
 * - {@link defaultProfileSummaryOf}: the profile summary's sources for a
 *   DEFAULT-profile copy. The summary loads the profile from the copy and stops
 *   at the default gate, so every later member is unasked and fails the case if
 *   reached.
 *
 * WHAT IT IS NOT. As in `copied-project.ts`: the doubles decide only what a
 * copy can (whether a path is held, what a directory lists, a held file's
 * text). They are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import type { AnswerCitationSources, StrictPageDirectory } from "../../src/citations/answer-index.js";
import type { ProfileSummarySources } from "../../src/profile/block.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";
import { effectiveProfileOf, enoent, heldText, recordDirsOf, unasked, type Copy, type Note } from "./copied-project.js";
import { unaskedPreparationStore } from "./preparation-store-doubles.js";

/** The ordinary local reads the source listing makes over the copy: the configuration text and the sources directory. */
export function copiedSourceReadsOf(copy: Copy, note: Note): LegacyLocalReads {
  const under = (relDir: string, relative: string): string => (relative === "" ? relDir : `${relDir}/${relative}`);
  return {
    readText: async (rel) => { note(`config ${rel}`); return heldText(copy, rel); },
    realDirectory: async (relDir) => {
      note(`directory ${relDir}`);
      return copy.listings.has(relDir) ? { listEntries: async (relative) => copy.listings.get(under(relDir, relative))! } : null;
    },
    exists: unasked("reads.exists"), statNoFollow: unasked("reads.statNoFollow"), listNames: unasked("reads.listNames"),
    readConfinedPage: unasked("reads.readConfinedPage"), readConfinedFile: unasked("reads.readConfinedFile"),
    locate: (rel) => `memory:${rel}`,
  };
}

/** Every ordinary local read over the copy: the source listing's two reads, and the presence, kind, listing and page reads. */
export function copiedLocalReadsOf(copy: Copy, note: Note): LegacyLocalReads {
  const confined = async (rel: string) => {
    note(`page ${rel}`);
    const text = copy.files.get(rel);
    return text === undefined ? { dropped: "missing" } : { content: text };
  };
  return {
    ...copiedSourceReadsOf(copy, note),
    exists: async (rel) => { note(`exists ${rel}`); return copy.files.has(rel) || copy.listings.has(rel); },
    statNoFollow: async (rel) => {
      note(`stat ${rel}`);
      if (copy.listings.has(rel)) return "directory";
      if (copy.files.has(rel)) return "file";
      throw enoent();
    },
    listNames: async (relDir) => {
      note(`list ${relDir}`);
      const held = copy.listings.get(relDir);
      if (held === undefined) throw enoent();
      return held.map((entry) => entry.name);
    },
    readConfinedPage: (relDir, slug) => confined(`${relDir}/${slug}.md`),
    readConfinedFile: (rel) => confined(rel),
  };
}

/** The profile summary's sources over a default-profile copy: the legacy profile leaf from the copy, and every later member unasked. */
export function defaultProfileSummaryOf(copy: Copy, note: Note): ProfileSummarySources {
  const graph = { readStore: unasked("graph.readStore") };
  return {
    profile: effectiveProfileOf(copy, note),
    scans: { openEntityDirectory: unasked("scans.openEntityDirectory") }, graph,
    events: { graph, resolvePrivateDir: unasked("events.resolvePrivateDir"), readHeadLeaf: unasked("events.readHeadLeaf") },
    pages: { readEntityPage: unasked("pages.readEntityPage") }, artifacts: { artifactAt: unasked("artifacts.artifactAt") },
    provenance: unaskedPreparationStore("provenance"), realRoot: unasked("summary.realRoot"),
  };
}

/** One page directory of the copy as the strict citation index reads it: whole held text served as positional bytes. */
function copiedCitationDirectoryOf(copy: Copy, relDir: string, note: Note): StrictPageDirectory {
  return {
    listNames: async () => { note(`list ${relDir}`); return copy.listings.get(relDir)!.map((entry) => entry.name); },
    resolveEntry: async (name) => (copy.files.has(`${relDir}/${name}`) ? `${relDir}/${name}` : null),
    readEntryThrough: async (entry, read) => {
      const bytes = Buffer.from(heldText(copy, entry));
      return { kind: "ok", value: await read({ read: async (buffer, offset, length, position) => {
        const served = bytes.subarray(position, position + length);
        served.copy(buffer, offset);
        return { bytesRead: served.length };
      } }) };
    },
  };
}

/** The citation index's project over the copy; `fault`, when given, is what resolving the project rejects with. */
export function copiedCitationSourcesOf(copy: Copy, note: Note, fault?: Error): AnswerCitationSources {
  return { resolveProject: async () => {
    note("project");
    if (fault) throw fault;
    return {
      openPageDirectory: async (relDir) => (copy.listings.has(relDir) ? copiedCitationDirectoryOf(copy, relDir, note) : null),
      candidateDirs: recordDirsOf(copy, note),
    };
  } };
}
