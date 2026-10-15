/**
 * Computed source-freshness layer.
 *
 * Two parts. CLASSIFICATION (`computeFreshness` and its helpers) derives a
 * page's freshness on demand from a FreshnessSnapshot and is pure: it reads
 * and writes nothing. BUILDING THE SNAPSHOT has ONE body,
 * `buildFreshnessSnapshotFrom`. It reads sources only through the
 * {@link SourceFreshnessSources} it is handed: for each source the state lists,
 * where it is, then its text, which the body hashes. `buildFreshnessSnapshot`
 * is the root form every caller uses: it reads the state file unless one is
 * supplied, then runs that body over the local disk
 * ({@link diskSourceFreshnessSources}, through the physical functions in
 * `src/storage/disk-locations.ts`). Nothing here writes, and freshness is never
 * persisted.
 */

import type { FreshnessSnapshot, PageFreshness, PageFreshnessInput, FreshnessStatus, SourceFreshness } from "./types.js";
import { createHash } from "node:crypto";
import path from "path";
import { readStateClassified } from "../utils/state.js";
import type { ClassifiedState } from "../utils/state.js";
import { SOURCES_DIR } from "../utils/constants.js";
import { locationExistsSync, locationRealPath, NotRegularFileError, readRegularLocationText } from "../storage/disk-locations.js";

/** Compute the three orthogonal freshness signals for one page. */
export function computeFreshness(page: PageFreshnessInput, snapshot: FreshnessSnapshot): PageFreshness {
  return {
    freshnessStatus: classify(page, snapshot),
    contradicted: Array.isArray(page.frontmatter.contradictedBy) && page.frontmatter.contradictedBy.length > 0,
    archived: page.frontmatter.archived === true,
  };
}

/**
 * Source-derived freshness status, per the spec's ordered ownership algorithm.
 *
 * SCOPED LIMITATION (typed entity pages). Source ownership is recorded only for
 * DEFAULT concepts (in `state.sources[file].concepts`). TYPED entity pages
 * (non-concepts produced by a non-default profile, e.g. `papers/`, `ideas/`)
 * have no source ownership entry, so `ownersOf` returns empty and they are
 * INTENTIONALLY classified `unverified` — and therefore excluded from orphan
 * pruning — in this phase. This is a known, scoped limitation: typed-page
 * source ownership (and orphan pruning) is deferred to a later phase.
 */
function classify(page: PageFreshnessInput, snapshot: FreshnessSnapshot): FreshnessStatus {
  if (snapshot.stateStatus !== "ok") return "unverified";
  // Query pages are generated answers, not source projections — always unverified,
  // never orphaned/fresh (they also never receive `orphaned` frontmatter).
  if (page.pageDirectory === "queries") return "unverified";
  if (page.frontmatter.orphaned === true) return "orphaned";

  const owners = ownersOf(page.slug, snapshot);
  if (owners.length === 0) return "unverified";

  const live = owners.filter((o) => o.exists);
  if (live.length === 0) return "orphaned";
  if (live.length < owners.length) return "stale";
  if (live.some((o) => o.currentHash !== o.recordedHash)) return "stale";
  return "fresh";
}

/**
 * Reverse-index cache keyed by snapshot object identity, so the inversion in
 * {@link buildOwnersIndex} happens once per run rather than once per page.
 */
const ownersIndexCache = new WeakMap<FreshnessSnapshot, Map<string, SourceFreshness[]>>();

/** Sources whose recorded concept set includes this page's slug (state is authoritative). */
function ownersOf(slug: string, snapshot: FreshnessSnapshot) {
  let index = ownersIndexCache.get(snapshot);
  if (!index) {
    index = buildOwnersIndex(snapshot);
    ownersIndexCache.set(snapshot, index);
  }
  return index.get(slug) ?? [];
}

/**
 * Reverse index of the freshness snapshot: concept slug → owning sources.
 *
 * The forward lookup (`Object.values(sources).filter(s => s.concepts.includes(slug))`)
 * costs one pass over every source for every page, so a 2356-page wiki with 289
 * sources pays ~680k `Array.includes` calls plus 2356 array allocations per
 * snapshot build — the dominant cost of `llmwiki context` on a large wiki.
 * Inverting the map once turns each per-page lookup into a hash lookup.
 *
 * Cached per snapshot object (WeakMap), so the inversion happens once per run
 * and the cache entry goes away with the snapshot. Requires the caller to treat
 * the snapshot as immutable, which `buildFreshnessSnapshot` already does.
 */
function buildOwnersIndex(snapshot: FreshnessSnapshot): Map<string, SourceFreshness[]> {
  const index = new Map<string, SourceFreshness[]>();
  for (const source of Object.values(snapshot.sources)) {
    for (const slug of source.concepts) {
      const owners = index.get(slug);
      if (owners) owners.push(source);
      else index.set(slug, [source]);
    }
  }
  return index;
}

/**
 * Where the sources a compile state names are found and read. OWNED BY
 * FRESHNESS: a narrow seam for this one consumer, with one disk implementation
 * ({@link diskSourceFreshnessSources}). It is not `ProjectStore`, not a hosted
 * or access-control contract, and it selects no backend.
 */
export interface SourceFreshnessSources {
  /** Called ONCE per snapshot, and only when the state is `ok`. Never rejects. */
  openSources(): Promise<SourceLocations>;
}

/** One project's sources, as {@link SourceFreshnessSources.openSources} hands them out. */
export interface SourceLocations {
  /**
   * A token for the source when its key is lexically inside the sources root,
   * something exists there (a directory counts) and it resolves inside the real
   * sources root; `null` otherwise. Never rejects.
   */
  resolveSource(file: string): Promise<string | null>;
  /**
   * The whole text behind a token, decoded as UTF-8, or `null` when what is
   * there is not a regular file (a named pipe, directory or device) and so
   * cannot be verified as the source. REJECTS with the raw error otherwise.
   */
  readText(source: string): Promise<string | null>;
}

/**
 * Build the per-run freshness snapshot: one read-only state read + one hash
 * pass over sources/. Shared by every freshness consumer so hashing happens once.
 *
 * @param classified - Optional pre-read classified state. When supplied the
 *   disk read is skipped, letting callers that already have state avoid a
 *   redundant read. Omit (or pass `undefined`) to read from disk as usual.
 */
export async function buildFreshnessSnapshot(
  root: string,
  classified?: ClassifiedState,
): Promise<FreshnessSnapshot> {
  return buildFreshnessSnapshotFrom(diskSourceFreshnessSources(root), classified ?? (await readStateClassified(root)));
}

/**
 * {@link buildFreshnessSnapshot} over {@link SourceFreshnessSources}, given a
 * state that is already classified. A state that is not `ok` makes NO source
 * call. Otherwise the sources are opened once and each source the state lists
 * is classified in the state's key order, ONE AT A TIME. Nothing is caught: a
 * rejecting read rejects the snapshot with that same error, and later sources
 * are not touched.
 */
export async function buildFreshnessSnapshotFrom(
  sources: SourceFreshnessSources,
  classified: ClassifiedState,
): Promise<FreshnessSnapshot> {
  const { status, state } = classified;
  const classifiedSources: FreshnessSnapshot["sources"] = {};
  if (status === "ok") {
    const locations = await sources.openSources();
    for (const [file, entry] of Object.entries(state.sources)) {
      classifiedSources[file] = await classifySource(locations, file, entry);
    }
  }
  return { stateStatus: status, sources: classifiedSources };
}

/**
 * Classify one source entry from state.json. A source the locations cannot
 * place is "not there": `exists: false`, and it is never read. A source whose
 * read is `null` (not a regular file, such as a named pipe where the source
 * used to be) is unverifiable and also `exists: false`. Any other is read and
 * hashed HERE, once: SHA-256 of its decoded text, as hex.
 */
async function classifySource(
  locations: SourceLocations,
  file: string,
  entry: { hash: string; concepts: string[] },
): Promise<SourceFreshness> {
  const source = await locations.resolveSource(file);
  const content = source === null ? null : await locations.readText(source);
  if (content === null) {
    return { recordedHash: entry.hash, currentHash: null, exists: false, concepts: entry.concepts };
  }
  return {
    recordedHash: entry.hash,
    currentHash: createHash("sha256").update(content).digest("hex"),
    exists: true,
    concepts: entry.concepts,
  };
}

/**
 * LOCAL DISK. The sources of the project at `root`. Building it does no I/O.
 * Exported so the viewer snapshot's disk sources can use it without copying
 * it; it is in no package index.
 *
 * Opening resolves the real sources root ONCE — the per-source containment
 * check reuses it, so a snapshot over N sources does at most N (not 2N)
 * realpath syscalls.
 */
export function diskSourceFreshnessSources(root: string): SourceFreshnessSources {
  return {
    openSources: async () => {
      const sourcesRoot = path.resolve(root, SOURCES_DIR);
      const realSourcesRoot = await realSourcesRootOrFallback(sourcesRoot);
      return {
        resolveSource: (file) => locateDiskSource(sourcesRoot, realSourcesRoot, file),
        readText: (source) => readDiskSourceText(source),
      };
    },
  };
}

/**
 * LOCAL DISK. A source's text, opened without blocking: `null` for a named
 * pipe, directory or device, so a source replaced by one never stalls the
 * snapshot. Any other failure rejects raw.
 */
async function readDiskSourceText(source: string): Promise<string | null> {
  try {
    return await readRegularLocationText(source);
  } catch (err) {
    if (err instanceof NotRegularFileError) return null;
    throw err;
  }
}

/**
 * Real path of the sources root, falling back to the lexical path if realpath
 * throws (e.g. sources/ does not exist yet). The fallback is safe: a missing
 * sources root means no source file can resolve inside it, and per-file
 * existsSync already gates hashing.
 */
async function realSourcesRootOrFallback(sourcesRoot: string): Promise<string> {
  try {
    return await locationRealPath(sourcesRoot);
  } catch {
    return sourcesRoot;
  }
}

/**
 * Resolve a file's symlinks and check whether its real path is inside the
 * pre-resolved real sources root. The root is realpath'd once by the caller so
 * projects under symlinked temp dirs (e.g. macOS /tmp → /private/tmp) still pass.
 * Returns false on any error (treat as not inside, refuse to hash).
 */
async function resolvesInsideSources(resolved: string, realSourcesRoot: string): Promise<boolean> {
  try {
    const realFile = await locationRealPath(resolved);
    return realFile === realSourcesRoot || realFile.startsWith(realSourcesRoot + path.sep);
  } catch {
    return false;
  }
}

/**
 * Where one source key from state.json is on disk, or `null`, guarding against
 * both path traversal and symlink escapes. A poisoned key like
 * `../../etc/passwd` is rejected by the cheap lexical check (first gate). A
 * symlink inside sources/ pointing outside is rejected by the realpath check
 * (second gate), which runs only for something that exists. Nothing is read.
 */
async function locateDiskSource(sourcesRoot: string, realSourcesRoot: string, file: string): Promise<string | null> {
  const resolved = path.resolve(sourcesRoot, file);
  const lexicallyInside = resolved === sourcesRoot || resolved.startsWith(sourcesRoot + path.sep);
  if (!lexicallyInside) return null;
  if (!locationExistsSync(resolved)) return null;
  // Symlink escapes sources/ — treat as unverifiable, never hash/read it.
  if (!(await resolvesInsideSources(resolved, realSourcesRoot))) return null;
  return resolved;
}
