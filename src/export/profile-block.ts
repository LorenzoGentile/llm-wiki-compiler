/**
 * Additive profile entity block for the JSON export.
 *
 * Mirrors the `status`/`listPages` additive-block pattern: for the built-in
 * default profile this returns `undefined` so the default export envelope is
 * byte-identical, and ONLY for a non-default profile does it assemble a
 * `JsonExportProfileBlock` carrying the content-bearing `EntityPage`s from the
 * shared collector. The built-in is gated through the shared
 * {@link loadNonDefaultProfile} primitive.
 *
 * ONE BODY, {@link buildExportProfileBlockFrom}, over the profile summary's
 * existing sources without the event store ({@link ExportProfileSources}):
 * the profile, the entity scans, the relation store, the endpoint pages, the
 * artifact store's and the preparation store's leaf reads, and the real-path
 * look. Each step is its reader's own one body over those sources, never a
 * finished answer. `buildExportProfileBlock(root)` hands it the local disk's
 * sources from the summary's one disk builder, built per call. Naming the
 * sources selects no backend and rules on no mechanism; the preparation
 * store's lifecycle read and proof stay root-bound disk authority, unchanged.
 */

import {
  loadNonDefaultProfileFrom, collectEntityPagesWithMessagesFrom, relationReadProblem, diskProfileSummarySources, type ProfileSummarySources,
} from "../profile/block.js";
import { collectStandingRelationProblemsFrom } from "../profile/relation-standing.js";
import { artifactProblemViewsFrom } from "../profile/artifact-lint.js";
import { toEntityPageView } from "../profile/types.js";
import { PROFILE_BLOCK_VERSION } from "./json-export.js";
import type { JsonExportProfileBlock, RelationView } from "./json-export.js";
import type { EntityProblemView, LoadedProfile } from "../profile/types.js";
import { readLiveValidRelationsFrom } from "../relations/live-valid.js";
import type { RelationRef } from "../relations/types.js";
import type { GraphStoreReads } from "../utils/jsonl-store.js";

/**
 * Everything {@link buildExportProfileBlockFrom} reads: the profile summary's
 * sources without the event store, which the export never reads. The
 * effective profile is loaded FIRST and the built-in default ends the block;
 * `profile.activeProduct.root` is the root as given, the label problem paths
 * fall back to when the real path is unknown. The real-path look is asked
 * once after the entity collection, ALWAYS, and once more by artifact health
 * only when it has a finding.
 */
export type ExportProfileSources = Omit<ProfileSummarySources, "events">;

/**
 * Map an internal {@link RelationRef} to its public, path-safe {@link RelationView}:
 * carry the EntityId endpoints (already opaque, not paths), the typed attributes,
 * the content hash, AND the `evidence` citations. Evidence is now contract-VALIDATED
 * on write (safe project-relative paths, allowlisted keys), so exporting it leaks no
 * filesystem path and makes the published `contentHash` recomputable by a consumer.
 * The `evidence` key is included ONLY when present, so an evidence-less relation's
 * view stays byte-identical.
 */
function toRelationView(ref: RelationRef): RelationView {
  return {
    id: ref.id, type: ref.type, from: ref.from, to: ref.to,
    attributes: ref.attributes,
    ...(ref.evidence ? { evidence: ref.evidence } : {}),
    contentHash: ref.contentHash,
  };
}

/** The export's relation-store contribution: path-safe live views and/or a fail-closed problem. */
interface ExportRelationResult {
  relations?: RelationView[];
  problem?: EntityProblemView;
}

/**
 * Read the live relation store for the export, returning path-safe views ONLY
 * for relations STILL VALID against the current profile. A relation-less profile
 * yields `{}` (no `relations` key, so the export stays byte-identical). A
 * fail-closed read (corrupt / too-new / symlinked-leaf / symlinked-or-escaping
 * `wiki/graph` dir) yields a `relation-store` `problem` (mapped via the SHARED
 * {@link relationReadProblem}) instead of partial relations — so the export
 * reports a broken store VISIBLY, exactly like status, rather than emitting a
 * clean-looking block that reads as "there are no relations". Relations the
 * profile has outgrown (type removed / endpoint type disallowed / attributes now
 * invalid) are OMITTED from this live snapshot but retained on disk; lint flags
 * them as `relation-profile-invalid`.
 */
async function exportRelationViews(graph: GraphStoreReads, loaded: LoadedProfile): Promise<ExportRelationResult> {
  // Read the store even when the profile declares NO `relations` block: a
  // relation-less project's store is empty (→ `{}`, byte-identical), but
  // a project whose `relations` block was removed while records remain must
  // surface only those still valid (here: none) rather than stale ones.
  try {
    const valid = await readLiveValidRelationsFrom(graph, loaded.profile);
    return valid.length > 0 ? { relations: valid.map(toRelationView) } : {};
  } catch (error) {
    return { problem: relationReadProblem(error) }; // rethrows a non-store error
  }
}

/**
 * Build the additive JSON-export profile block for a project root.
 *
 * @param root - Absolute project root directory.
 * @returns The profile block for a non-default profile, or `undefined` for the
 *   built-in default so the export gains no `profile` key.
 */
export async function buildExportProfileBlock(
  root: string,
): Promise<JsonExportProfileBlock | undefined> {
  // `async` so that a throw while the disk sources are built REJECTS.
  return buildExportProfileBlockFrom(diskProfileSummarySources(root));
}

/**
 * {@link buildExportProfileBlock} over {@link ExportProfileSources}: THE ONE
 * BODY. One step after another, never together: the profile; the entity pages
 * with bodies, then the real-path look; the relation store; the standing
 * check; artifact health. `loaded` is used as given by every step.
 */
export async function buildExportProfileBlockFrom(
  sources: ExportProfileSources,
): Promise<JsonExportProfileBlock | undefined> {
  const loaded = await loadNonDefaultProfileFrom(sources.profile);
  if (loaded === undefined) return undefined;
  const asGiven = sources.profile.activeProduct.root;
  const realRoot = (): Promise<string | null> => sources.realRoot();
  const { pages, problems } = await collectEntityPagesWithMessagesFrom({ scans: sources.scans, realRoot, root: asGiven }, loaded);
  const { relations, problem } = await exportRelationViews(sources.graph, loaded);
  // Re-evaluate every page CURRENTLY in a gated lifecycle state against the live
  // relation graph (READ-ONLY, LOCK-FREE) so a precondition that has drifted since
  // write time surfaces on the export too — exactly like status/viewer. A
  // non-gated/default profile adds none, so the block stays byte-identical.
  const standing = await collectStandingRelationProblemsFrom(sources, loaded.profile);
  // Every hash-pinned artifactRef (page field or live relation attribute)
  // resolved against the ACTUAL bytes — same collector lint/status/viewer use,
  // reshaped path-safe. An artifact-less profile does no extra work.
  const artifacts = await artifactProblemViewsFrom(sources, pages, loaded.profile, { realRoot, asGiven });
  // Merge the fail-closed relation-store problem (if any) and the standing
  // problems alongside the entity problems so a broken/drifted store is reported
  // VISIBLY, not silently omitted. When the store is healthy/relation-less/default
  // there is no extra problem, so the block stays byte-identical.
  const allProblems = [...problems, ...(problem ? [problem] : []), ...standing, ...artifacts];
  return {
    version: PROFILE_BLOCK_VERSION,
    profileId: loaded.profile.profileId,
    entityPages: pages.map((page) => toEntityPageView(page, true)),
    ...(allProblems.length > 0 ? { problems: allProblems, problemTotal: allProblems.length } : {}),
    ...(relations ? { relations } : {}),
  };
}
