/**
 * @file Post-write refresh for trusted OKF imports (links, index, MOC, embeddings).
 *
 * ONE BODY, NO ROOT. {@link refreshAfterImportWith} owns the id-to-slug mapping
 * and the order over {@link ImportRefreshSteps}. {@link refreshAfterImport} keeps
 * its signature and passes the local steps, built per call over its root, which
 * call the incumbent root forms when asked (so module spies and mocks still
 * intercept). {@link importRefreshStepsOver} composes the same steps from each
 * step's own root-free body over its own seam: link resolution over the local
 * reads (its page writes applied through the caller's applier), the index and MOC
 * generators, and the embedding DRAIN. The lock stays the caller's; none of this
 * is in a package index.
 */
import { resolveAndApplyLinks, resolveLinksFrom } from "../compiler/resolver.js";
import { generateIndex, generateIndexFrom, type IndexGenerationSources } from "../compiler/indexgen.js";
import { generateMOC, generateMOCFrom, type MocGenerationSources } from "../compiler/obsidian.js";
import type { CompilePageWrite } from "../compiler/compile-write.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import { refreshEmbeddingsDrainingPending, refreshEmbeddingsFrom, type EmbeddingRefreshSources } from "../utils/embeddings-refresh.js";
import { slugFromPageId, type PageId } from "../utils/page-id.js";

/** The four steps one post-import refresh takes, for ONE project. No member takes a project root. */
export interface ImportRefreshSteps {
  /** Resolve and apply interlinks for the changed and new slugs. */
  resolveLinks(changedSlugs: string[], newSlugs: string[]): Promise<unknown>;
  /** Regenerate `wiki/index.md`. */
  generateIndex(): Promise<void>;
  /** Regenerate the MOC. */
  generateMOC(): Promise<void>;
  /** Union `changedPageIds` into the pending-marker DRAIN and refresh. */
  refreshEmbeddings(changedPageIds: PageId[]): Promise<unknown>;
}

/** LOCAL DISK. The incumbent root forms for `root`, each called when asked; building them does no I/O. */
function diskImportRefreshSteps(root: string): ImportRefreshSteps {
  return {
    resolveLinks: (changedSlugs, newSlugs) => resolveAndApplyLinks(root, changedSlugs, newSlugs),
    generateIndex: () => generateIndex(root),
    generateMOC: () => generateMOC(root),
    refreshEmbeddings: (changedPageIds) => refreshEmbeddingsDrainingPending(root, changedPageIds),
  };
}

/** The seams the bound composition takes: each step's own, plus the caller's applier for the resolved page writes. */
export interface ImportRefreshSources {
  /** The local reads link resolution runs over. */
  linkReads: LegacyLocalReads;
  /** Apply the resolved page writes under the caller's held lock. */
  applyPageWrites(writes: CompilePageWrite[]): Promise<unknown>;
  /** The index generator's sources. */
  index: IndexGenerationSources;
  /** The MOC generator's sources. */
  moc: MocGenerationSources;
  /** The embedding refresh's sources; the scope is always the drain. */
  embeddings: EmbeddingRefreshSources;
}

/** The refresh steps over each step's own root-free body: THE ONE BOUND COMPOSITION. Building it does no I/O. */
export function importRefreshStepsOver(sources: ImportRefreshSources): ImportRefreshSteps {
  return {
    resolveLinks: async (changedSlugs, newSlugs) => sources.applyPageWrites(await resolveLinksFrom(sources.linkReads, changedSlugs, newSlugs)),
    generateIndex: () => generateIndexFrom(sources.index),
    generateMOC: () => generateMOCFrom(sources.moc),
    refreshEmbeddings: (changedPageIds) => refreshEmbeddingsFrom(sources.embeddings, changedPageIds, "drain"),
  };
}

/**
 * Rebuild derived artifacts after writing imported pages live.
 *
 * The embeddings refresh routes through the SHARED
 * {@link refreshEmbeddingsDrainingPending} — the same drain compile and
 * `review approve` use — so an OKF import UNIONS the imported page-ids into any
 * prior-pending marker and settles it per-id. Without this, a workflow of OKF
 * imports + refresh that never runs a plain compile would never drain
 * accumulated pending compile-embeddings, leaving them stale indefinitely. The
 * import already holds the project lock across this call (runOkfImport:
 * acquireLock → writeAll → refreshAfterImport, inside the try, before the
 * finally releaseLock), so the shared drain's lock-free Core is correct (the
 * self-locking wrapper would deadlock under the held lock).
 *
 * @param root - Project root path.
 * @param pageIds - Qualified page ids of the imported pages (`<namespace>/<slug>`).
 */
export async function refreshAfterImport(root: string, pageIds: PageId[]): Promise<void> {
  return refreshAfterImportWith(diskImportRefreshSteps(root), pageIds);
}

/** {@link refreshAfterImport} over {@link ImportRefreshSteps}: THE ONE BODY. Links, index, MOC, then the drain; a failure stops the rest. */
export async function refreshAfterImportWith(steps: ImportRefreshSteps, pageIds: PageId[]): Promise<void> {
  // resolveAndApplyLinks operates on bare slugs (default concepts/queries
  // pipeline). The OKF import already holds the project lock (runOkfImport), so
  // this routes through the lock-free resolution seam.
  const slugs = pageIds.map(slugFromPageId);
  await steps.resolveLinks(slugs, slugs);
  await steps.generateIndex();
  await steps.generateMOC();
  // Union the imported page-ids into the shared pending-marker drain (preserves
  // the existing changed-id set; the drain adds prior-pending ids on top).
  await steps.refreshEmbeddings(pageIds);
}
