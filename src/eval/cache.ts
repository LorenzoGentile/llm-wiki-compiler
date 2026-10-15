/**
 * Citation cache management for the llmwiki eval harness.
 *
 * The citation cache stores LLM judge results in .llmwiki/eval/citation-cache.jsonl
 * so subsequent `eval --suite full` runs skip already-judged (claim, span) pairs.
 * This module provides helpers to inspect and clear that cache independently of
 * running a full evaluation.
 *
 * The clear and the load each have ONE body (`clearCitationCacheFrom`,
 * `loadCitationCacheFrom`) over the evaluation's raw file reads and writes. The
 * root-taking forms hand them the local disk's. This is the PUBLIC, array-shaped
 * reader of the cache; the judge keeps its own keyed reader in
 * `citation-support.ts`, with different duplicate handling, and is not touched.
 */

import path from "path";
import { diskEvalFileReads, type EvalFileReads } from "./file-reads.js";
import { diskEvalFileWrites, type EvalFileWrites } from "./file-writes.js";
import type { CitationJudgement } from "./types.js";

const CACHE_FILE = path.join(".llmwiki", "eval", "citation-cache.jsonl");

export interface CacheSummary {
  total: number;
  fullySupported: number;
  partiallySupported: number;
  unsupported: number;
  byPage: Array<{ slug: string; count: number }>;
}

/**
 * Delete the citation cache file.
 * Returns true if the file existed and was deleted, false if it was already absent.
 * @param root - Absolute path to the project root.
 */
export async function clearCitationCache(root: string): Promise<boolean> {
  return clearCitationCacheFrom(diskEvalFileReads(root), diskEvalFileWrites(root));
}

/**
 * {@link clearCitationCache} over the raw reads and writes: THE ONE BODY. The
 * existence answer is asked first and trusted: `false` removes nothing, and a
 * removal that then fails rejects raw.
 *
 * @param reads - Whether the cache file is there.
 * @param writes - The removal.
 * @returns True when the file was asked for, found and removed; false when it was not found.
 */
export async function clearCitationCacheFrom(reads: EvalFileReads, writes: EvalFileWrites): Promise<boolean> {
  if (!reads.existsSync(CACHE_FILE)) return false;
  await writes.removeFile(CACHE_FILE);
  return true;
}

/**
 * Load all cached citation judgements as an array.
 * Returns an empty array if the cache file does not exist.
 * Malformed lines are silently skipped.
 * @param root - Absolute path to the project root.
 */
export async function loadCitationCache(root: string): Promise<CitationJudgement[]> {
  return loadCitationCacheFrom(diskEvalFileReads(root));
}

/**
 * {@link loadCitationCache} over the raw reads: THE ONE BODY. Every line that
 * parses is kept, in file order, duplicates and any score included.
 *
 * @param reads - Whether the cache file is there, and its whole text.
 */
export async function loadCitationCacheFrom(reads: EvalFileReads): Promise<CitationJudgement[]> {
  if (!reads.existsSync(CACHE_FILE)) return [];

  const content = await reads.readText(CACHE_FILE);
  const judgements: CitationJudgement[] = [];
  for (const line of content.trim().split("\n").filter(Boolean)) {
    try {
      judgements.push(JSON.parse(line) as CitationJudgement);
    } catch {
      // Skip malformed cache lines
    }
  }
  return judgements;
}

/**
 * Aggregate cached judgements into a summary with score distribution and per-page counts.
 * @param judgements - Array of citation judgements loaded from the cache.
 */
export function summarizeCitationCache(judgements: CitationJudgement[]): CacheSummary {
  let fullySupported = 0;
  let partiallySupported = 0;
  let unsupported = 0;
  const pageCounts = new Map<string, number>();

  for (const j of judgements) {
    if (j.score === 2) fullySupported++;
    else if (j.score === 1) partiallySupported++;
    else unsupported++;
    pageCounts.set(j.pageSlug, (pageCounts.get(j.pageSlug) ?? 0) + 1);
  }

  const byPage = [...pageCounts.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count);

  return { total: judgements.length, fullySupported, partiallySupported, unsupported, byPage };
}
