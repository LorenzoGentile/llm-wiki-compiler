/**
 * @file Orchestrate an OKF import: read the bundle (confined + bounded), invert each
 * doc to a llmwiki page, then apply the collision policy. Side-effect free with respect
 * to wiki/ — the caller (command) decides to stage as candidates or write live.
 *
 * ONE BODY, {@link importOkfBundleFrom}, over {@link OkfImportSources}: the bundle
 * reads, the effective profile's sources and the collision sources, all existing
 * raw ports. The bundle read, the index read, the block parse, the profile load,
 * the split, the mapping and both collision legs are the production bodies.
 * `importOkfBundle(…, root, …)` hands it the local disk's sources. The bundle
 * directory is a local path the caller names; the mutations that follow an
 * import (staging, trust, recovery) are not part of this body.
 */
import path from "path";
import { slugify } from "../utils/markdown.js";
import { DISK_OKF_BUNDLE_READS, readOkfBundleFrom, readIndexFrontmatterFrom, type OkfBundleReads } from "./okf-read.js";
import { okfDocToPage, slugFromRelPath, type OkfMapContext } from "./okf-map.js";
import { diskOkfCollisionSources, filterCollisionsFrom, filterTypedCollisionsFrom, type OkfCollisionSources } from "./okf-collision.js";
import { partitionProfileDocs } from "./profile-import.js";
import { parseBundleBlock, type ParsedBundleBlock } from "./bundle-block-read.js";
import { loadNonDefaultProfileFrom } from "../profile/block.js";
import { diskEffectiveProfileSources, type EffectiveProfileSources } from "../profile/load.js";
import { DEFAULT_OKF_LIMITS } from "./okf-limits.js";
import type { LoadedProfile } from "../profile/types.js";
import type { OkfImportLimits, MappedOkfPage, MappedTypedOkfDoc, RawOkfDoc, TypedImportOutcome } from "./types.js";
import type { SkippedOkfPage } from "./okf-collision.js";

/** Stable, filesystem-safe bundle id derived from the bundle directory name. */
function bundleIdFor(bundleDir: string): string {
  return slugify(path.basename(path.resolve(bundleDir))) || "bundle";
}

/** Build a slug->title resolver over the whole bundle so intra-bundle links reverse cleanly. */
function titleResolver(docs: RawOkfDoc[]): (slug: string) => string | null {
  const map = new Map<string, string>();
  for (const d of docs) {
    const slug = slugFromRelPath(d.relPath);
    if (typeof d.meta.title === "string") map.set(slug, d.meta.title);
  }
  return (slug) => map.get(slug) ?? null;
}

/** The read+map+collision result of an OKF bundle: untyped pages, typed docs, and the inert bundle block. */
export interface ImportedOkfBundle {
  /** Untyped concept/query pages (the legacy leg). */
  pages: MappedOkfPage[];
  /** Collision-filtered typed profile-entity docs (the CLP-7.6 typed leg). */
  typed: MappedTypedOkfDoc[];
  /** Untyped-leg collision skips. */
  skipped: SkippedOkfPage[];
  /** Typed-leg collision-skip outcomes. */
  typedSkipped: TypedImportOutcome[];
  /** The inert bundle-level `x-llmwiki` block (relations/workflows/profile). */
  bundleBlock?: ParsedBundleBlock;
  /** The active NON-DEFAULT profile, threaded to the caller's typed staging leg; absent for a default project. */
  profile?: LoadedProfile;
}

/**
 * Read + map + collision-filter an OKF bundle into stage-ready pages, ALSO
 * parsing the bundle-level `x-llmwiki` metadata block off `index.md` as untrusted
 * input (CLP 7.6). Parse warnings are forwarded through `onWarn`; the parsed block
 * (relations/workflows/profile) is returned INERT for the caller to surface — it
 * is never applied here.
 *
 * For a NON-DEFAULT-profile project the docs are additionally partitioned into the
 * untyped `native` leg and the TYPED profile-entity leg (D-7.6.4): typed docs are
 * reconstructed + collision-filtered here and applied through the trust planner by
 * the caller (under its held lock). A default-profile project routes every doc
 * through the untyped path exactly as before (D-7.6.10 parity).
 */
export async function importOkfBundle(
  bundleDir: string,
  root: string,
  overrides: Partial<OkfImportLimits> = {},
  onWarn?: (msg: string) => void,
): Promise<ImportedOkfBundle> {
  // `async` so that a throw while the disk sources are built REJECTS.
  return importOkfBundleFrom(diskOkfImportSources(root), bundleDir, root, overrides, onWarn);
}

/** Everything {@link importOkfBundleFrom} reads. Production builds the project-side members from one root. */
export interface OkfImportSources {
  /** The bundle directory's raw reads (a local path the caller names). */
  bundle: OkfBundleReads;
  /** The effective profile, loaded ONCE; a present but broken profile THROWS. */
  profile: EffectiveProfileSources;
  /** The candidate store and the live-page probe, for both collision legs. */
  collisions: OkfCollisionSources;
}

/** LOCAL DISK. The import sources for the project at `root`. Building them does no I/O. In no package index; exported for the import preview only. */
export function diskOkfImportSources(root: string): OkfImportSources {
  return { bundle: DISK_OKF_BUNDLE_READS, profile: diskEffectiveProfileSources(root), collisions: diskOkfCollisionSources(root) };
}

/**
 * {@link importOkfBundle} over {@link OkfImportSources}: THE ONE BODY. The bundle read
 * (with the printing default sink when no `onWarn` is given), the index read (with its
 * silent default), the block parse, the profile load, the split, then the untyped and
 * the typed collision legs, one after another.
 */
export async function importOkfBundleFrom(
  sources: OkfImportSources,
  bundleDir: string,
  root: string,
  overrides: Partial<OkfImportLimits> = {},
  onWarn?: (msg: string) => void,
): Promise<ImportedOkfBundle> {
  const limits = { ...DEFAULT_OKF_LIMITS, ...overrides };
  const docs = await readOkfBundleFrom(sources.bundle, bundleDir, overrides, onWarn);
  const indexMeta = await readIndexFrontmatterFrom(sources.bundle, bundleDir, limits, onWarn);
  const { block, warnings } = parseBundleBlock(indexMeta, limits);
  if (onWarn) warnings.forEach(onWarn);
  const ctx: OkfMapContext = { bundleId: bundleIdFor(bundleDir), titleOf: titleResolver(docs) };
  // Fail-closed: loadNonDefaultProfile returns undefined ONLY for the legitimate
  // default-profile case (missing file) and THROWS ProfileLoadError for a present
  // but broken/confined profile. That throw must abort the import — never degrade to
  // the untyped/default routing, or a `--trusted` run would write a typed doc live as
  // an untyped page via writeAll, bypassing typed validation entirely.
  const profile = await loadNonDefaultProfileFrom(sources.profile);
  const { nativeDocs, typedDocs } = splitDocs(docs, ctx, profile, onWarn);
  const { kept, skipped } = await filterCollisionsFrom(sources.collisions, root, nativeDocs.map((d) => okfDocToPage(d, ctx)));
  const { kept: typed, skipped: typedSkipped } = await filterTypedCollisionsFrom(sources.collisions, root, typedDocs);
  return { pages: kept, typed, skipped, typedSkipped, bundleBlock: block, profile };
}

/** Partition a bundle's docs into the untyped native leg and the typed leg (typed only under a non-default profile). */
function splitDocs(
  docs: RawOkfDoc[],
  ctx: OkfMapContext,
  profile: LoadedProfile | undefined,
  onWarn?: (msg: string) => void,
): { nativeDocs: RawOkfDoc[]; typedDocs: MappedTypedOkfDoc[] } {
  if (profile === undefined) return { nativeDocs: docs, typedDocs: [] };
  const { native, typed } = partitionProfileDocs(docs, profile.profile, ctx, onWarn ?? (() => {}));
  return { nativeDocs: native, typedDocs: typed };
}
