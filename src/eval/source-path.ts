/**
 * Safe source-file resolver for the eval harness.
 *
 * Citation markers in wiki pages contain free-form file paths. Before the
 * eval harness reads any file or checks its existence, the path must be
 * confined to the project's `sources/` directory. Three independent layers
 * of defense are applied in order:
 *
 *   1. Structural: reject empty strings, absolute paths, and any `..` segment.
 *   2. Pre-realpath: resolve the joined path and verify it stays under sourcesDir.
 *   3. Symlink: call `fs.realpath` on both sides and verify again, catching
 *      symlinks inside sources/ that point outside the tree.
 *
 * The confinement pattern mirrors `resolveSafePath` in src/context/provenance.ts.
 *
 * The resolver has ONE body, {@link resolveSourceFileFrom}. It asks the place
 * sources are kept for two raw facts only, through {@link SourceFileLocations}:
 * where the sources directory is, and what a location resolves to. Every rule
 * above stays in that body. `resolveSourceFile` hands it the local disk's facts.
 */

import path from "path";
import { locationRealPath, readLocationText } from "../storage/disk-locations.js";
import { SOURCES_DIR } from "../utils/constants.js";

/**
 * The raw facts the resolver asks for. Neither member decides anything: the
 * lexical rules, both containment checks and the null-on-failure rule are all
 * in {@link resolveSourceFileFrom}.
 *
 * `sourcesDir`, and every location handed to `realPath` or returned by it, is a
 * LOCATOR in the legacy local sense: on disk, an absolute path. Locators are
 * physical identities, joined and compared with the host's path rules. They are
 * not logical ids, and a body that takes them is not free of the local layout.
 */
export interface SourceFileLocations {
  /** The sources directory's locator. On local disk, `path.join(root, SOURCES_DIR)`. */
  sourcesDir: string;
  /** The location with every link resolved. Returns a promise that rejects raw when the location does not resolve. */
  realPath(location: string): Promise<string>;
}

/** LOCAL DISK. The locations for the project at `root`, built per call and held by none. Building them does no I/O. */
export function diskSourceFileLocations(root: string): SourceFileLocations {
  return { sourcesDir: path.join(root, SOURCES_DIR), realPath: locationRealPath };
}

/**
 * The resolver's locations and ONE more raw read: the whole text at a location.
 * A consumer resolves a cited file with {@link resolveSourceFileFrom} and reads
 * the location that came back. The read resolves, confines and checks nothing,
 * and says nothing about whether the text is usable: every such decision stays
 * with the consumer. Locations are the same legacy physical locators as above.
 */
export interface SourceFileReads {
  /** The source resolver's locations. */
  locations: SourceFileLocations;
  /** The whole text at a location as UTF-8, following links. Returns a promise that rejects raw when it cannot be read. */
  readText(location: string): Promise<string>;
}

/** LOCAL DISK. The source reads for the project at `root`, built per call. Building them does no I/O. */
export function diskSourceFileReads(root: string): SourceFileReads {
  return { locations: diskSourceFileLocations(root), readText: readLocationText };
}

/**
 * True when any `/`- or `\`-separated segment of `file` is literally `..`.
 * Splitting on both separators ensures a `nested\..\escape.md` path written
 * for a Windows consumer is also caught on Linux where `\` is a valid filename
 * character.
 */
function containsParentSegment(file: string): boolean {
  return file.split(/[/\\]/).some((seg) => seg === "..");
}

/** True when `candidate` equals `parent` or sits beneath it. */
function isInside(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  const parentWithSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return candidate.startsWith(parentWithSep);
}

/**
 * Resolve `file` under `sourcesDir`, rejecting:
 *   - empty strings and absolute paths (`/etc/passwd`)
 *   - any path segment that is literally `..` (traversal, even normalizing back
 *     inside sources/ is rejected — the raw marker must be unambiguous)
 *   - paths that resolve outside `sourcesDir` after normalization
 *   - paths whose `realpath` escapes `sourcesDir` (symlink escapes)
 *
 * Returns the canonical absolute path on success, or `null` if the path is
 * rejected, the sources directory does not exist, or the file is not found.
 *
 * @param sourcesDir - Absolute path to the project's sources/ directory.
 * @param file - Relative file path from a citation marker (untrusted input).
 */
export async function resolveSourceFile(
  sourcesDir: string,
  file: string,
): Promise<string | null> {
  return resolveSourceFileFrom({ sourcesDir, realPath: locationRealPath }, file);
}

/**
 * {@link resolveSourceFile} over {@link SourceFileLocations}: THE ONE BODY.
 * The directory is resolved first, then the file, one after the other, on
 * every call; nothing is remembered between calls. Any failure of either
 * lookup answers `null`.
 *
 * @param locations - Where the sources directory is, and what a location resolves to.
 * @param file - Relative file path from a citation marker (untrusted input).
 */
export async function resolveSourceFileFrom(locations: SourceFileLocations, file: string): Promise<string | null> {
  const { sourcesDir } = locations;
  if (file.length === 0 || path.isAbsolute(file)) return null;
  if (containsParentSegment(file)) return null;
  const joined = path.join(sourcesDir, file);
  if (!isInside(sourcesDir, path.resolve(joined))) return null;
  try {
    const realDir = await locations.realPath(sourcesDir);
    const realFile = await locations.realPath(joined);
    if (!isInside(realDir, realFile)) return null;
    return realFile;
  } catch {
    return null;
  }
}
