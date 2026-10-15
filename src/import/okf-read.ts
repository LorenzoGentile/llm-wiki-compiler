/**
 * @file Walk an OKF bundle directory, path-confine + size-bound every file, and
 * tolerantly parse each non-reserved markdown doc into a RawOkfDoc. Reserved
 * files (index.md / log.md) and malformed/typeless docs are skipped with a warning;
 * a bundle exceeding a resource cap is rejected outright.
 *
 * The `maxFiles` cap bounds the `.md` walk EARLY: the recursion throws as soon as
 * the accumulated markdown count exceeds the limit, so a hostile deep/wide bundle is
 * rejected mid-walk rather than fully enumerated first. (Residual: a tree of many
 * empty dirs / non-`.md` files is still walked unbounded — the spec's "max files"
 * contract is the `.md` count, which is acceptable for v1.)
 *
 * ONE BODY EACH, over {@link OkfBundleReads}: the walk, the confinement check,
 * the index read and the bundle read decide everything (order, limits, warnings,
 * errors, which entries count) through four raw reads of the bundle directory a
 * local caller names. That directory may be outside any project; the reads are
 * a local mechanism, not `ProjectStore`, a hosted store or an access-control layer.
 * The root forms hand the bodies the local disk's reads.
 */
import path from "path";
import { locationByteSize } from "../storage/disk-bundle-tree.js";
import { listDirectoryEntries } from "../storage/disk-guarded-leaves.js";
import { readLocationText } from "../storage/disk-locations.js";
import { safeRealpath, isInsideDir, toPosixPath } from "../utils/path-confine.js";
import { parseFrontmatterStatus } from "../utils/markdown.js";
import * as output from "../utils/output.js";
import { DEFAULT_OKF_LIMITS } from "./okf-limits.js";
import type { OkfImportLimits, RawOkfDoc } from "./types.js";

const RESERVED = new Set(["index.md", "log.md"]);

/**
 * The four raw reads the bundle bodies make, each on a path the body names. A
 * NARROW, import-specific seam: no member decides anything.
 */
export interface OkfBundleReads {
  /** The real path, or `null` when the location does not resolve. */
  realpath(location: string): Promise<string | null>;
  /** A directory's entries, with whether each is a directory or a regular file (links are neither). REJECTS raw. */
  listEntries(dir: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
  /** The size in bytes of what the location resolves to. REJECTS raw. */
  byteSize(location: string): Promise<number>;
  /** A file's whole text. REJECTS raw. */
  readText(location: string): Promise<string>;
}

/** LOCAL DISK. The bundle reads: the named disk mechanisms the reader always used. Holds no path. In no package index. */
export const DISK_OKF_BUNDLE_READS: OkfBundleReads = {
  realpath: (location) => safeRealpath(location),
  listEntries: listDirectoryEntries,
  byteSize: locationByteSize,
  readText: readLocationText,
};

/**
 * Collect bundle-relative `.md` paths. Throws as soon as the walk visits more than
 * `maxEntries` total directory entries (bounds deep/wide non-`.md` trees) or
 * accumulates more than `maxFiles` markdown files.
 */
async function listMarkdown(
  reads: OkfBundleReads,
  root: string,
  dir: string,
  limits: OkfImportLimits,
  acc: string[] = [],
  visited = { n: 0 },
): Promise<string[]> {
  for (const entry of await reads.listEntries(dir)) {
    if (++visited.n > limits.maxEntries) throw new Error(`OKF import: bundle exceeds max entry count (> ${limits.maxEntries})`);
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await listMarkdown(reads, root, abs, limits, acc, visited);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      acc.push(toPosixPath(path.relative(root, abs)));
      if (acc.length > limits.maxFiles) throw new Error(`OKF import: bundle exceeds max file count (> ${limits.maxFiles})`);
    }
  }
  return acc;
}

/**
 * Resolve `realRoot/rel` to its real path IFF that realpath stays within `realRoot`.
 * Returns null when the entry is missing or its realpath escapes the bundle (e.g. a
 * symlink pointing outside). Exported so the confinement guard is unit-testable
 * directly — `listMarkdown`'s `isFile()` filter would otherwise mask this path.
 */
export async function confinedInside(realRoot: string, rel: string): Promise<string | null> {
  return confinedInsideFrom(DISK_OKF_BUNDLE_READS, realRoot, rel);
}

/** {@link confinedInside} over {@link OkfBundleReads}: THE ONE BODY. */
async function confinedInsideFrom(reads: OkfBundleReads, realRoot: string, rel: string): Promise<string | null> {
  const real = await reads.realpath(path.join(realRoot, rel));
  return real && isInsideDir(real, realRoot) ? real : null;
}

/**
 * Read `index.md`'s frontmatter — the one reserved file carrying the bundle-level
 * `x-llmwiki` metadata block (CLP 7.6). Path-confined (a symlinked/escaping
 * `index.md` yields `{}`) and size-bounded by `maxDocBytes`; a missing, oversize,
 * or malformed-frontmatter index.md yields `{}` + a warning rather than throwing,
 * so the bundle-block parse is fail-safe and pages still import.
 *
 * @param bundleDir - The bundle root directory.
 * @param limits - Resource caps (the index.md read is bounded by `maxDocBytes`).
 * @param onWarn - Sink for a size/confinement warning.
 * @returns The parsed frontmatter mapping, or `{}` when unavailable.
 */
export async function readIndexFrontmatter(
  bundleDir: string,
  limits: OkfImportLimits,
  onWarn: (msg: string) => void = () => {},
): Promise<Record<string, unknown>> {
  return readIndexFrontmatterFrom(DISK_OKF_BUNDLE_READS, bundleDir, limits, onWarn);
}

/** {@link readIndexFrontmatter} over {@link OkfBundleReads}: THE ONE BODY, with the same silent default sink. */
export async function readIndexFrontmatterFrom(
  reads: OkfBundleReads,
  bundleDir: string,
  limits: OkfImportLimits,
  onWarn: (msg: string) => void = () => {},
): Promise<Record<string, unknown>> {
  const realRoot = await reads.realpath(bundleDir);
  if (!realRoot) return {};
  const real = await confinedInsideFrom(reads, realRoot, "index.md");
  if (!real) return {};
  if ((await reads.byteSize(real)) > limits.maxDocBytes) {
    onWarn("OKF import: index.md exceeds size limit; bundle metadata block ignored");
    return {};
  }
  return parseFrontmatterStatus(await reads.readText(real)).meta;
}

/** Read + parse an OKF bundle. Returns concept docs only (reserved + invalid skipped). */
export async function readOkfBundle(
  bundleDir: string,
  overrides: Partial<OkfImportLimits> = {},
  onWarn: (msg: string) => void = (m) => output.status("!", output.warn(m)),
): Promise<RawOkfDoc[]> {
  return readOkfBundleFrom(DISK_OKF_BUNDLE_READS, bundleDir, overrides, onWarn);
}

/** {@link readOkfBundle} over {@link OkfBundleReads}: THE ONE BODY, with the same printing default sink. */
export async function readOkfBundleFrom(
  reads: OkfBundleReads,
  bundleDir: string,
  overrides: Partial<OkfImportLimits> = {},
  onWarn: (msg: string) => void = (m) => output.status("!", output.warn(m)),
): Promise<RawOkfDoc[]> {
  const limits = { ...DEFAULT_OKF_LIMITS, ...overrides };
  const realRoot = await reads.realpath(bundleDir);
  if (!realRoot) throw new Error(`OKF import: bundle not found: ${bundleDir}`);
  const rels = (await listMarkdown(reads, realRoot, realRoot, limits)).sort();
  const docs: RawOkfDoc[] = [];
  let total = 0;
  for (const rel of rels) {
    if (RESERVED.has(rel)) continue;
    const real = await confinedInsideFrom(reads, realRoot, rel);
    if (!real) { onWarn(`OKF import: skipped path escaping bundle: ${rel}`); continue; }
    const size = await reads.byteSize(real);
    total += size;
    if (size > limits.maxDocBytes || total > limits.maxTotalBytes) throw new Error(`OKF import: bundle exceeds size limit at ${rel}`);
    const parsed = parseFrontmatterStatus(await reads.readText(real));
    const type = parsed.meta.type;
    if (parsed.malformedFrontmatter || typeof type !== "string" || type.trim() === "") {
      onWarn(`OKF import: skipped doc without a valid type: ${rel}`);
      continue;
    }
    docs.push({ relPath: rel, meta: parsed.meta, body: parsed.body });
  }
  return docs;
}
