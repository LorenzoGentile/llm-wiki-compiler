/**
 * Read-only project-state collector for `llmwiki next`.
 *
 * Inspects an llmwiki project root and reports counts, lint cache status,
 * and structural warnings without acquiring locks, mutating disk, or
 * running compile/lint. Designed to be cheap on small projects and to
 * stay cheap on large wikis by using directory mtimes as a stale-lint
 * proxy instead of stat-ing every page.
 *
 * Stale-lint detection is intentionally approximate per the spec:
 * directory-structure changes after the last lint run produce a
 * `lint-cache-stale` warning. Content-only edits may not trigger it on
 * every filesystem; exact lint freshness belongs to `llmwiki lint`.
 *
 * Candidate reads are race-tolerant: this collector delegates to
 * `countCandidates`, which skips malformed/partial candidate JSON the
 * same way `review list` does.
 *
 * Disk access: {@link collectProjectState} builds local-disk
 * {@link ProjectStateSources} from the root (`./state-sources.ts`, which
 * holds the seam and its one disk implementation) and runs the one body,
 * {@link collectProjectStateFrom}. Every decision (what a failed probe means,
 * what counts as a page, how the lint cache is parsed, both staleness
 * comparisons, warning order) is in that body; the sources only look.
 */

import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import { diskProjectStateSources } from "./state-sources.js";
import type { ProjectStateProbes, ProjectStateSources } from "./state-sources.js";
import {
  SOURCES_DIR,
  CONCEPTS_DIR,
  QUERIES_DIR,
  LLMWIKI_DIR,
  LAST_LINT_FILE,
  INDEX_FILE,
} from "../utils/constants.js";
import { countCandidatesFrom } from "../compiler/candidate-read.js";
import { listSelectedSourceFilesFrom } from "../sources/scan.js";
import { LINT_CACHE_TIMESTAMP_PATTERN } from "../linter/cache.js";
import type { LintCacheEntry } from "../linter/cache.js";
import { readStateClassifiedFrom } from "../utils/state.js";
import type { StateStatus } from "../utils/state.js";

/** Markdown extension treated as a wiki page for counting purposes. */
const MARKDOWN_EXT = ".md";
const WIKI_DIR = "wiki";

/** Warning codes the v1 collector may emit. Pinned by tests. */
type ProjectStateWarningCode =
  | "lint-cache-stale"
  | "lint-cache-unparseable"
  | "freshness-cache-stale"
  | "index-missing"
  | "sources-not-compiled"
  | "pending-candidates"
  | "project-unreadable"
  | "state-unreadable"
  | "state-too-new"
  | "stale-pages";

/** One structural warning surfaced alongside the primary state. */
export interface ProjectStateWarning {
  code: ProjectStateWarningCode;
  message: string;
}

/** Three-state lint-cache shape per the JSON contract. */
interface LintCacheStatus {
  /** True when a cache file exists on disk, even if it failed to parse. */
  present: boolean;
  /** Parsed cache entry; null when no file exists OR file failed to parse. */
  entry: LintCacheEntry | null;
}

/** Full project-state snapshot consumed by `recommendNextAction` and renderers. */
export interface ProjectState {
  root: string;
  hasSourcesDir: boolean;
  hasWikiDir: boolean;
  hasInternalDir: boolean;
  sourceCount: number;
  conceptCount: number;
  queryCount: number;
  pendingCandidates: number;
  hasIndex: boolean;
  lint: LintCacheStatus;
  latestWikiMtimeMs: number | null;
  latestSourceMtimeMs: number | null;
  warnings: ProjectStateWarning[];
}

/**
 * Collect a full ProjectState snapshot for `root`. Never throws on
 * expected absent-file paths — those become `false`/`0`/`null` fields.
 * Returns a `project-unreadable` warning when the root itself cannot be
 * stat-ed; callers escalate that to the `broken-project` primary state.
 */
export function collectProjectState(root: string): Promise<ProjectState> {
  return collectProjectStateFrom(diskProjectStateSources(root));
}

/**
 * {@link collectProjectState} over {@link ProjectStateSources}: THE ONE BODY.
 * The root is looked at first; if it is not a directory nothing else is read.
 * Then, in order: presence, counts, the lint cache, the two times, the compile
 * state's status. A failed look is a quiet `false`, `0` or `null`. The source
 * listing is the exception: its rejection rejects the collector.
 */
export async function collectProjectStateFrom(sources: ProjectStateSources): Promise<ProjectState> {
  const { root, probes } = sources;
  const rootReadable = (await probes.probeRoot())?.isDirectory ?? false;
  if (!rootReadable) return brokenProjectState(root);
  const dirs = await collectDirPresence(probes);
  const counts = await collectPageCounts(sources, dirs);
  const lint = await collectLintCacheStatus(probes);
  const mtimes = await collectMtimes(probes, dirs);
  // Read-only; never writes a .bak file — safe for the cheap orientation command.
  const stateStatus = (await readStateClassifiedFrom(sources.records)).status;
  return assembleState({ root, dirs, counts, lint, mtimes, stateStatus });
}

/** State returned when `root` itself cannot be inspected. */
function brokenProjectState(root: string): ProjectState {
  return {
    root,
    hasSourcesDir: false,
    hasWikiDir: false,
    hasInternalDir: false,
    sourceCount: 0,
    conceptCount: 0,
    queryCount: 0,
    pendingCandidates: 0,
    hasIndex: false,
    lint: { present: false, entry: null },
    latestWikiMtimeMs: null,
    latestSourceMtimeMs: null,
    warnings: [
      {
        code: "project-unreadable",
        message: `Project root is unreadable or could not be inspected: ${root}`,
      },
    ],
  };
}

/** Cheap presence probes for the three structural directories the recommender keys on. */
interface DirPresence {
  hasSourcesDir: boolean;
  hasWikiDir: boolean;
  hasInternalDir: boolean;
}

/** Raw page counts surfaced into ProjectState; computed in one pass to keep collectProjectState short. */
interface PageCounts {
  sourceCount: number;
  conceptCount: number;
  queryCount: number;
  pendingCandidates: number;
  hasIndex: boolean;
}

/** Mtime proxies used for the cheap stale-lint approximation. */
interface MtimePair {
  latestWikiMtimeMs: number | null;
  latestSourceMtimeMs: number | null;
}

/** Probe the three structural directories without listing their contents. */
async function collectDirPresence(probes: ProjectStateProbes): Promise<DirPresence> {
  const [hasSourcesDir, hasWikiDir, hasInternalDir] = await Promise.all([
    isDirectory(probes, SOURCES_DIR),
    isDirectory(probes, WIKI_DIR),
    isDirectory(probes, LLMWIKI_DIR),
  ]);
  return { hasSourcesDir, hasWikiDir, hasInternalDir };
}

/** Compute page counts plus the wiki/index.md presence flag. */
async function collectPageCounts(from: ProjectStateSources, dirs: DirPresence): Promise<PageCounts> {
  const [sources, conceptCount, queryCount, pendingCandidates, hasIndex] = await Promise.all([
    listSelectedSourceFilesFrom(from.reads),
    dirs.hasWikiDir ? countMarkdownFiles(from.probes, CONCEPTS_DIR) : 0,
    dirs.hasWikiDir ? countMarkdownFiles(from.probes, QUERIES_DIR) : 0,
    dirs.hasInternalDir ? safeCountCandidates(from.candidateDirs) : 0,
    dirs.hasWikiDir ? isFile(from.probes, INDEX_FILE) : false,
  ]);
  return { sourceCount: sources.length, conceptCount, queryCount, pendingCandidates, hasIndex };
}

/** Read directory mtimes only when the directories exist; absent dirs report null. */
async function collectMtimes(probes: ProjectStateProbes, dirs: DirPresence): Promise<MtimePair> {
  const [latestWikiMtimeMs, latestSourceMtimeMs] = await Promise.all([
    dirs.hasWikiDir ? safeMtime(probes, WIKI_DIR) : Promise.resolve(null),
    dirs.hasSourcesDir ? safeMtime(probes, SOURCES_DIR) : Promise.resolve(null),
  ]);
  return { latestWikiMtimeMs, latestSourceMtimeMs };
}

/** Read and validate the lint cache, distinguishing missing from corrupt. */
async function collectLintCacheStatus(probes: ProjectStateProbes): Promise<LintCacheStatus> {
  const exists = await isFile(probes, LAST_LINT_FILE);
  if (!exists) return { present: false, entry: null };
  const entry = await readLintCacheEntry(probes);
  return { present: true, entry };
}

/** Strict parse + validate, returning null for any unreadable/corrupt cache file. */
async function readLintCacheEntry(probes: ProjectStateProbes): Promise<LintCacheEntry | null> {
  let raw: string;
  try {
    raw = await probes.readText(LAST_LINT_FILE);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateCacheShape(parsed);
  } catch {
    return null;
  }
}

/**
 * Validate the lint cache JSON shape, carrying the optional `freshness` field
 * through when it is present and well-formed. Returns null for any missing or
 * corrupt field in the required subset ({@link LintCacheEntry}).
 */
function validateCacheShape(value: unknown): LintCacheEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { warnings, errors, at, freshness } = candidate;
  if (!isNonNegativeInteger(warnings)) return null;
  if (!isNonNegativeInteger(errors)) return null;
  if (typeof at !== "string" || !LINT_CACHE_TIMESTAMP_PATTERN.test(at)) return null;
  const entry: LintCacheEntry = { warnings, errors, at };
  // Intentionally lenient (diverges from cache.ts:isValidEntry): a malformed
  // `freshness` sub-field is silently dropped rather than rejecting the whole
  // entry, so `next` still surfaces valid lint counts. Do not "align" the two.
  if (isValidFreshnessShape(freshness)) entry.freshness = freshness;
  return entry;
}

/** True when `value` is a well-formed freshness sub-object. */
function isValidFreshnessShape(
  value: unknown,
): value is { stalePages: number; orphanedPages: number } {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return isNonNegativeInteger(c.stalePages) && isNonNegativeInteger(c.orphanedPages);
}

/** True for finite, non-negative integers. NaN and Infinity fail Number.isInteger. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Inputs to {@link assembleState}, grouped to keep the function's arity within limits. */
interface AssembleStateInput {
  root: string;
  dirs: DirPresence;
  counts: PageCounts;
  lint: LintCacheStatus;
  mtimes: MtimePair;
  stateStatus: StateStatus;
}

/** Combine the per-section reads into the final ProjectState + warning list. */
function assembleState(input: AssembleStateInput): ProjectState {
  const { root, dirs, counts, lint, mtimes, stateStatus } = input;
  const warnings = buildWarnings({ dirs, counts, lint, mtimes, stateStatus });
  return { root, ...dirs, ...counts, lint, ...mtimes, warnings };
}

/** Inputs for warning derivation; passed as a record to keep argument lists short. */
interface WarningInput {
  dirs: DirPresence;
  counts: PageCounts;
  lint: LintCacheStatus;
  mtimes: MtimePair;
  stateStatus: StateStatus;
}

/** Derive every structural warning from the already-collected state slices. */
function buildWarnings(input: WarningInput): ProjectStateWarning[] {
  const warnings: ProjectStateWarning[] = [];
  appendLintWarnings(warnings, input.lint, input.mtimes.latestWikiMtimeMs);
  appendStructuralWarnings(warnings, input.dirs, input.counts);
  appendFreshnessWarnings(warnings, input.lint, input.stateStatus, input.mtimes.latestSourceMtimeMs);
  return warnings;
}

/** Lint-cache warnings: unparseable file or stale-vs-wiki-mtime. */
function appendLintWarnings(
  warnings: ProjectStateWarning[],
  lint: LintCacheStatus,
  latestWikiMtimeMs: number | null,
): void {
  if (lint.present && lint.entry === null) {
    warnings.push({
      code: "lint-cache-unparseable",
      message: "Lint cache file exists but could not be parsed. Re-run `llmwiki lint`.",
    });
    return;
  }
  if (lint.entry && isLintCacheStale(lint.entry, latestWikiMtimeMs)) {
    warnings.push({
      code: "lint-cache-stale",
      message: "Lint cache is older than the wiki directory; pages were added or removed since the last lint.",
    });
  }
}

/** Structural warnings: missing index, pending candidates, uncompiled sources. */
function appendStructuralWarnings(
  warnings: ProjectStateWarning[],
  dirs: DirPresence,
  counts: PageCounts,
): void {
  const hasPages = counts.conceptCount > 0 || counts.queryCount > 0;
  if (hasPages && !counts.hasIndex) {
    warnings.push({
      code: "index-missing",
      message: "wiki/index.md is missing even though pages exist.",
    });
  }
  if (counts.pendingCandidates > 0) {
    warnings.push({
      code: "pending-candidates",
      message: `${counts.pendingCandidates} generated candidate${counts.pendingCandidates === 1 ? "" : "s"} waiting for review.`,
    });
  }
  if (dirs.hasSourcesDir && counts.sourceCount > 0 && !hasPages) {
    warnings.push({
      code: "sources-not-compiled",
      message: "Sources exist but no wiki pages were found. Run `llmwiki compile`.",
    });
  }
}

/**
 * Freshness warnings: corrupt state.json (fail-loud, not silent), stale/orphaned
 * page counts from the lint cache, and a heuristic freshness-cache-stale warning
 * when sources/ changed after the last lint.
 *
 * Missing state stays quiet — it is normal before the first compile.
 * Only corrupt state warns because it silently zeros all findings.
 */
function appendFreshnessWarnings(
  warnings: ProjectStateWarning[],
  lint: LintCacheStatus,
  stateStatus: StateStatus,
  latestSourceMtimeMs: number | null,
): void {
  if (stateStatus === "corrupt") {
    warnings.push({
      code: "state-unreadable",
      message:
        ".llmwiki/state.json is corrupt — run `llmwiki compile` to rebuild it (freshness figures shown are from the last lint and may be stale).",
    });
  }
  if (stateStatus === "too-new") {
    warnings.push({
      code: "state-too-new",
      message:
        ".llmwiki/state.json was written by a newer llmwiki version — upgrade llmwiki to read this project (freshness figures shown are from the last lint and may be stale).",
    });
  }
  const f = lint.entry?.freshness;
  if (f && (f.stalePages > 0 || f.orphanedPages > 0)) {
    warnings.push({
      code: "stale-pages",
      message: `${f.stalePages} stale, ${f.orphanedPages} orphaned page(s) as of the last lint — run \`llmwiki compile\` to refresh.`,
    });
  }
  if (lint.entry && isFreshnessCacheStale(lint.entry, latestSourceMtimeMs)) {
    warnings.push({
      code: "freshness-cache-stale",
      message:
        "sources/ changed since the last lint — freshness counts may be out of date; run `llmwiki lint` to refresh.",
    });
  }
}

/**
 * Heuristic: the sources/ directory mtime is newer than the last lint run.
 * Catches added/removed source files; may NOT detect in-place content edits on
 * all filesystems (same limitation as the wiki-mtime lint-cache-stale check).
 */
function isFreshnessCacheStale(entry: LintCacheEntry, latestSourceMtimeMs: number | null): boolean {
  if (latestSourceMtimeMs === null) return false;
  const lintMs = Date.parse(entry.at);
  if (Number.isNaN(lintMs)) return false;
  return latestSourceMtimeMs > lintMs;
}

/** Cheap structural staleness: last-lint timestamp older than wiki dir mtime. */
function isLintCacheStale(entry: LintCacheEntry, latestWikiMtimeMs: number | null): boolean {
  if (latestWikiMtimeMs === null) return false;
  const lintMs = Date.parse(entry.at);
  if (Number.isNaN(lintMs)) return false;
  return latestWikiMtimeMs > lintMs;
}

/** True when the place is a directory; false for a failed look or any other type. ONE look. */
async function isDirectory(probes: ProjectStateProbes, relPath: string): Promise<boolean> {
  return (await probes.probe(relPath))?.isDirectory ?? false;
}

/** True when the place is a regular file; false for a failed look or a directory. ONE look. */
async function isFile(probes: ProjectStateProbes, relPath: string): Promise<boolean> {
  return (await probes.probe(relPath))?.isFile ?? false;
}

/** The directory's own modification time in ms epoch, or null when the look fails. ONE look. */
async function safeMtime(probes: ProjectStateProbes, relPath: string): Promise<number | null> {
  return (await probes.probe(relPath))?.modifiedMs ?? null;
}

/** Count `.md` files in a directory; 0 for missing dirs or any other error. */
async function countMarkdownFiles(probes: ProjectStateProbes, relDir: string): Promise<number> {
  try {
    const entries = await probes.listEntries(relDir);
    let count = 0;
    for (const entry of entries) {
      if (entry.isFile && entry.name.endsWith(MARKDOWN_EXT)) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/** Race-tolerant candidate count; defers to `countCandidatesFrom` and swallows IO errors. */
async function safeCountCandidates(dirs: LegacyLocalRecordDirs): Promise<number> {
  try {
    return await countCandidatesFrom(dirs);
  } catch {
    return 0;
  }
}
