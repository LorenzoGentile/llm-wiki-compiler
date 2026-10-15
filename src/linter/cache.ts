/**
 * Persistent cache of the most recent `llmwiki lint` run.
 *
 * Written by the lint command after a completed run, before any non-zero exit
 * for lint findings, so the cache always reflects the run the user just saw.
 * Crashed or partial runs leave the prior cache untouched.
 *
 * Consumers (e.g., the upcoming viewer's /api/health endpoint) read the cache
 * to surface lint counts without re-running lint per request. A missing or
 * malformed cache reads as null, which means "lint has not been run yet." The
 * one exception is a per-rule breakdown that contradicts the totals beside it:
 * that field alone is dropped, because the totals are still trustworthy and
 * "lint has not been run yet" would be a worse lie than an absent breakdown.
 *
 * `writeLintCacheFrom` and `readLintCacheFrom` are THE ONE BODY of each half
 * and hold no project root: they reach the project only through
 * {@link LintCacheSources}. The root-taking `writeLintCache` and `readLintCache`
 * are delegates over a private binding built per call. The sources do FOUR things
 * and decide nothing: make a directory tree, replace a file's text, read a
 * file's text, and say where a located path is relative to the project. The
 * bodies own the order, the aggregation, WHICH paths are made relative, the
 * clock, the bytes and every validation and null rule. Every member of the
 * local binding is the same unconfined local-disk call as before.
 */

import path from "path";
import { LLMWIKI_DIR, LAST_LINT_FILE } from "../utils/constants.js";
import { makeDirectoryTree, writeLeafAtomicUnconfined } from "../storage/disk-guarded-leaves.js";
import { readLocationText } from "../storage/disk-locations.js";
import type { LintResult, LintSummary } from "./types.js";

/** Per-rule freshness counts, derived from the lint results. Optional so a pre-upgrade cache still parses. */
export interface LintFreshnessCounts {
  stalePages: number;
  orphanedPages: number;
}

/** One rule's contribution to a lint run. */
export interface LintRuleAggregate {
  rule: string;
  severity: "error" | "warning";
  /** Findings this rule produced. */
  count: number;
  /** Distinct files this rule flagged. */
  fileCount: number;
  /**
   * The file this rule flagged most often, and how often. Always root-
   * relative (e.g. `wiki/concepts/foo.md`) — never an absolute filesystem
   * path, even though some lint rules report `file` as absolute internally.
   */
  topFile: string;
  topFileCount: number;
}

/** One persisted lint summary. Shape is part of the public viewer-cache contract. */
export interface LintCacheEntry {
  warnings: number;
  errors: number;
  /** ISO-8601 timestamp of the run that produced these counts. */
  at: string;
  /** Stale/orphaned page counts from the freshness lint rule. Absent on pre-0.9 caches. */
  freshness?: LintFreshnessCounts;
  /**
   * Per-rule breakdown of error/warning findings, one row per rule that
   * fired, sorted by count descending. Absent when the run had no
   * error/warning findings (a clean run), on pre-upgrade caches, and when a
   * persisted breakdown failed to reconcile with the totals above it (see
   * {@link readLintCache}).
   */
  rules?: LintRuleAggregate[];
}

/**
 * The exact ISO-8601 shape `writeLintCache` produces and `readLintCache` accepts.
 * Exported so tests can assert against the same regex the validator enforces and
 * never drift from the documented contract.
 */
export const LINT_CACHE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Root-relative form of a lint finding's file path. Most rules derive `file`
 * from `path.join(root, ...)` (see `collectAllPages`), so it arrives absolute
 * — but a few infra rules (journal-health, pending-embeddings, workflow-run-
 * health) already emit a hardcoded root-relative constant. Only the absolute
 * form needs converting; the already-relative form passes through unchanged.
 *
 * This keeps `topFile` a portable wiki-relative path rather than a raw local
 * filesystem path. The viewer's `/api/health` route (unlike `/api/page` and
 * `/api/index`) does not gate its payload on loopback-vs-non-loopback bind,
 * so an absolute path here would reach the browser unconditionally — the
 * same class of local-path disclosure `routeRegistered` in server.ts
 * otherwise suppresses on non-loopback binds. Relativizing at the source
 * means the cache itself never holds a value that needs that gating.
 */
function toRootRelativePath(sources: LintCacheSources, file: string): string {
  return path.isAbsolute(file) ? sources.projectRelative(file) : file;
}

/**
 * Everything the lint cache asks of the project. Paths given to the first
 * three members are project-relative. None confines, checks a link, or makes
 * anything durable; each rejects with the backend's own error.
 */
export interface LintCacheSources {
  /** Create a directory and its missing parents. Succeeds when it is already there. */
  makeDirectoryTree(relDir: string): Promise<void>;
  /** Replace a file's whole text so that a reader sees the old text or the new. NOT confined to the project. */
  writeAtomic(relPath: string, text: string): Promise<void>;
  /** A file's whole text as UTF-8, following links. */
  readText(relPath: string): Promise<string>;
  /** Where an ABSOLUTE located path is, relative to the project. Asked only for an absolute path. On local disk, `path.relative(root, file)`. */
  projectRelative(file: string): string;
}

/** LOCAL DISK. The sources for the project at `root`, built per call. Building them does no I/O. In no package index. */
export function diskLintCacheSources(root: string): LintCacheSources {
  return {
    makeDirectoryTree: (relDir) => makeDirectoryTree(path.join(root, relDir)),
    writeAtomic: (relPath, text) => writeLeafAtomicUnconfined(path.join(root, relPath), text),
    readText: (relPath) => readLocationText(path.join(root, relPath)),
    projectRelative: (file) => path.relative(root, file),
  };
}

/** All results emitted by a given lint rule, regardless of severity. */
function resultsByRule(results: LintResult[], rule: string): LintResult[] {
  return results.filter((r) => r.rule === rule);
}

/** Count results emitted by a given lint rule. */
function countByRule(results: LintResult[], rule: string): number {
  return resultsByRule(results, rule).length;
}

/**
 * The file a rule flagged most often within its own findings, and how many
 * times. Ties broken by file path ascending so the choice is deterministic
 * across runs with identical counts, matching the ascending tie-break the
 * top-level rows use.
 */
function findTopFile(ruleResults: LintResult[]): { topFile: string; topFileCount: number } {
  const countsByFile = new Map<string, number>();
  for (const r of ruleResults) countsByFile.set(r.file, (countsByFile.get(r.file) ?? 0) + 1);
  const [topFile, topFileCount] = [...countsByFile.entries()].sort(
    ([fileA, countA], [fileB, countB]) => countB - countA || fileA.localeCompare(fileB),
  )[0];
  return { topFile, topFileCount };
}

/** Build one rule's aggregate row from its own error/warning findings. */
function buildRuleAggregate(rule: string, ruleResults: LintResult[]): LintRuleAggregate {
  return {
    rule,
    // A rule that somehow emits both severities is reported as "error" —
    // the more severe finding must never be hidden behind a warning row.
    severity: ruleResults.some((r) => r.severity === "error") ? "error" : "warning",
    count: ruleResults.length,
    fileCount: new Set(ruleResults.map((r) => r.file)).size,
    ...findTopFile(ruleResults),
  };
}

/**
 * Aggregate error/warning findings into one row per rule that fired, sorted
 * by count descending (ties broken by rule name ascending) so the viewer
 * never has to re-sort. `info` findings are excluded — they are already
 * excluded from the `warnings`/`errors` headline totals, and including them
 * here would make the rows fail to sum back to those totals. File paths are
 * normalized to root-relative (see {@link toRootRelativePath}) before
 * grouping, so every downstream `file`/`topFile` value is safe to persist
 * and to serve. Returns `undefined` for a clean run so the caller omits the
 * field rather than persisting an empty array.
 */
function aggregateRules(sources: LintCacheSources, results: LintResult[]): LintRuleAggregate[] | undefined {
  const actionable = results
    .filter((r) => r.severity === "error" || r.severity === "warning")
    .map((r) => ({ ...r, file: toRootRelativePath(sources, r.file) }));
  if (actionable.length === 0) return undefined;

  const ruleNames = [...new Set(actionable.map((r) => r.rule))];
  const rows = ruleNames.map((rule) => buildRuleAggregate(rule, resultsByRule(actionable, rule)));
  rows.sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
  return rows;
}

/**
 * Persist a lint summary to `.llmwiki/last-lint.json` after a completed run.
 * Creates the `.llmwiki/` directory if missing. Overwrites any prior entry so
 * the cache reflects the most recent run, including zero-issue runs.
 */
export async function writeLintCache(root: string, summary: LintSummary): Promise<void> {
  return writeLintCacheFrom(diskLintCacheSources(root), summary);
}

/**
 * {@link writeLintCache} through `sources`: THE ONE BODY. In this order: make
 * the directory, aggregate the findings, read the clock, write the entry.
 */
export async function writeLintCacheFrom(sources: LintCacheSources, summary: LintSummary): Promise<void> {
  await sources.makeDirectoryTree(LLMWIKI_DIR);
  const rules = aggregateRules(sources, summary.results);
  const entry: LintCacheEntry = {
    warnings: summary.warnings,
    errors: summary.errors,
    at: new Date().toISOString(),
    freshness: {
      stalePages: countByRule(summary.results, "stale-page"),
      orphanedPages: countByRule(summary.results, "orphaned-page"),
    },
    ...(rules !== undefined ? { rules } : {}),
  };
  await sources.writeAtomic(LAST_LINT_FILE, `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * Read the cached lint summary, returning null for missing or malformed files.
 * Validation is strict: every field must have its expected type, otherwise the
 * cache is treated as absent so callers do not surface garbage counts.
 *
 * A schema-valid `rules` breakdown that contradicts the totals it was derived
 * from is dropped on its own, leaving the entry otherwise intact — see
 * {@link rulesAgreeWithTotals}.
 */
export async function readLintCache(root: string): Promise<LintCacheEntry | null> {
  return readLintCacheFrom(diskLintCacheSources(root));
}

/** {@link readLintCache} through `sources`: THE ONE BODY. One whole-file read; any rejection of it reads as null. */
export async function readLintCacheFrom(sources: LintCacheSources): Promise<LintCacheEntry | null> {
  let raw: string;
  try {
    raw = await sources.readText(LAST_LINT_FILE);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidEntry(parsed)) return null;
  const entry: LintCacheEntry = {
    warnings: parsed.warnings,
    errors: parsed.errors,
    at: parsed.at,
    ...(parsed.freshness !== undefined ? { freshness: parsed.freshness } : {}),
  };
  const rules = parsed.rules;
  return rules !== undefined && rulesAgreeWithTotals(rules, entry) ? { ...entry, rules } : entry;
}

/**
 * Whether a breakdown reconciles with the headline counts beside it.
 *
 * {@link writeLintCache} guarantees all three checks by construction: the rows
 * partition exactly the error/warning findings the totals count, and both
 * `fileCount` and `topFileCount` are derived from that same partition. A
 * violation therefore means the file was hand-edited or corrupted — the same
 * threat model the type validation above defends against.
 *
 * The failure is partial, not total, because the two halves of the entry fail
 * independently. The totals drive the viewer's problem chip and its whole-wiki
 * verdict; the rows only decorate them with a bar and a table. Rejecting the
 * whole entry would throw away an accurate error/warning count over a cosmetic
 * inconsistency, and would report "lint has never run" for a wiki that has.
 * Dropping the rows alone degrades the panel to totals-only, which is a state
 * it already renders correctly for pre-upgrade caches.
 */
function rulesAgreeWithTotals(
  rules: LintRuleAggregate[],
  totals: Pick<LintCacheEntry, "errors" | "warnings">,
): boolean {
  const summed = rules.reduce((total, row) => total + row.count, 0);
  if (summed !== totals.errors + totals.warnings) return false;
  // Per-row: `mostAffectedText` in the viewer renders "<page> · <topFileCount>
  // of <count>", so a row whose parts exceed its own total reads as nonsense
  // even when the rows happen to sum correctly.
  return rules.every((row) => row.topFileCount <= row.count && row.fileCount <= row.count);
}

/** True for finite non-negative integers, including zero. NaN and Infinity fail Number.isInteger. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validates the optional freshness sub-object; rejects if present but malformed. */
function isValidFreshness(value: unknown): value is LintFreshnessCounts {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return isNonNegativeInteger(c.stalePages) && isNonNegativeInteger(c.orphanedPages);
}

/** Severities a persisted rule aggregate row may carry. `info` is never aggregated. */
const VALID_RULE_AGGREGATE_SEVERITIES: ReadonlySet<unknown> = new Set(["error", "warning"]);

/** Validates a single persisted rule-aggregate row. */
function isValidRuleAggregate(value: unknown): value is LintRuleAggregate {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.rule === "string" &&
    r.rule.length > 0 &&
    VALID_RULE_AGGREGATE_SEVERITIES.has(r.severity) &&
    isNonNegativeInteger(r.count) &&
    isNonNegativeInteger(r.fileCount) &&
    typeof r.topFile === "string" &&
    isNonNegativeInteger(r.topFileCount)
  );
}

/** Validates the optional rules breakdown; rejects if present but malformed. */
function isValidRules(value: unknown): value is LintRuleAggregate[] {
  return Array.isArray(value) && value.every(isValidRuleAggregate);
}

/**
 * Validates the always-required top-level fields.
 *
 * Counts must be finite non-negative integers (the writer only ever persists
 * `LintSummary` severity counts, which originate from a length on an array, so
 * anything else means the file was hand-edited or corrupted). The timestamp
 * must match the exact ISO-8601 shape the writer produces, otherwise downstream
 * consumers risk surfacing values like "2026-01-01" as full timestamps.
 */
function hasValidCoreFields(candidate: Record<string, unknown>): boolean {
  return (
    isNonNegativeInteger(candidate.warnings) &&
    isNonNegativeInteger(candidate.errors) &&
    typeof candidate.at === "string" &&
    LINT_CACHE_TIMESTAMP_PATTERN.test(candidate.at)
  );
}

/**
 * Validates the optional `freshness` and `rules` sub-fields independently —
 * each is only checked when present, so a pre-upgrade cache omitting either
 * (or both) still parses.
 */
function hasValidOptionalFields(candidate: Record<string, unknown>): boolean {
  if (candidate.freshness !== undefined && !isValidFreshness(candidate.freshness)) return false;
  if (candidate.rules !== undefined && !isValidRules(candidate.rules)) return false;
  return true;
}

/** Strict type guard for the persisted cache entry; see {@link hasValidCoreFields} and {@link hasValidOptionalFields}. */
function isValidEntry(value: unknown): value is LintCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return hasValidCoreFields(candidate) && hasValidOptionalFields(candidate);
}
