/**
 * LLM citation judge for the llmwiki eval harness.
 *
 * For each cited prose paragraph in the wiki, extracts the (claim, source span)
 * pair and asks an LLM judge whether the source actually supports the claim.
 * Scoring: 0 = unsupported, 1 = partial, 2 = fully supported.
 *
 * Uses deterministic hash-based sampling so the same N citations are evaluated
 * on every run (reproducible). Results are cached in .llmwiki/eval/citation-cache.jsonl
 * so subsequent runs skip already-judged pairs.
 *
 * The pair extraction has ONE body, {@link extractCitationPairsFrom}, over the
 * page collection's sources and the source resolver's reads. The judge has ONE
 * body too, {@link createCitationJudgeFrom}, over the raw reads and writes of
 * its cache file. The evaluator has ONE body as well,
 * {@link evaluateCitationSupportFrom}, over those two together.
 */

import { createHash } from "crypto";
import path from "path";
import { diskEvalFileReads, type EvalFileReads } from "./file-reads.js";
import { diskEvalFileWrites, type EvalFileWrites } from "./file-writes.js";
import { collectAllPagesFrom, diskLintPageSources, type LintPageSources } from "../linter/rules-shared.js";
import { parseFrontmatter, extractClaimCitations, splitProseParagraphs } from "../utils/markdown.js";
import { callClaude } from "../utils/llm.js";
import {
  DEFAULT_PROVIDER,
  PROVIDER_MODELS,
  normalizeProviderName,
} from "../utils/constants.js";
import { diskSourceFileReads, resolveSourceFileFrom, type SourceFileReads } from "./source-path.js";
import type { LLMTool } from "../utils/provider.js";
import type { CitationJudgement, CitationSupportResult } from "./types.js";
import type { SourceSpan } from "../utils/types.js";

const CACHE_DIR = path.join(".llmwiki", "eval");
const CACHE_FILE = path.join(CACHE_DIR, "citation-cache.jsonl");
/** Internal pair combining a claim paragraph with its cited source span. */
export interface CitationPair {
  claimHash: string;
  pageSlug: string;
  claimText: string;
  citedFile: string;
  spanText: string;
  lineStart: number;
  lineEnd: number;
}

export const JUDGE_TOOL: LLMTool = {
  name: "judge_citation",
  description: "Rate how well the source excerpt supports the claim.",
  input_schema: {
    type: "object",
    properties: {
      score: {
        type: "integer",
        enum: [0, 1, 2],
        description:
          "0=not supported or contradicted, 1=partially supported, 2=fully supported",
      },
      reason: { type: "string", description: "One sentence explaining the rating." },
    },
    required: ["score", "reason"],
  },
};

const JUDGE_SYSTEM =
  "You are an expert fact-checker. Given a claim from a wiki article and a source excerpt, rate whether the source supports the claim. Be strict: partial credit only if the source addresses the claim but is incomplete. Important: if the source excerpt consists entirely of YAML frontmatter (metadata fields such as title, date, author, or tags between --- delimiters), treat it as non-evidence for any substantive claim and score it 0, unless the claim is explicitly about that metadata field.";

// Content-addressable fingerprint of the judge prompt + tool schema.
// Any edit to JUDGE_SYSTEM or JUDGE_TOOL produces a new hash, automatically
// invalidating cached judgements without requiring a manual version bump.
const JUDGE_CONFIG_HASH = createHash("sha256")
  .update(JUDGE_SYSTEM + JSON.stringify(JUDGE_TOOL))
  .digest("hex")
  .slice(0, 8);

/** Compute a stable 16-char hex hash for a (claim, span) pair. */
function hashPair(claimText: string, spanText: string): string {
  return createHash("sha256").update(claimText + spanText).digest("hex").slice(0, 16);
}

/** Derive a full cache key from content hash + judge config fingerprint + model. */
function makeCacheKey(contentHash: string, model: string): string {
  return createHash("sha256")
    .update(contentHash + JUDGE_CONFIG_HASH + model)
    .digest("hex")
    .slice(0, 16);
}

/** Extract the text of specific lines from a file (1-indexed, inclusive). */
async function readSourceLines(sources: SourceFileReads, filePath: string, start: number, end: number): Promise<string> {
  const content = await sources.readText(filePath);
  return content
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
}

/** Strip `^[...]` markers from a paragraph to get the bare claim text. */
function stripCitationMarkers(paragraph: string): string {
  return paragraph.replace(/\^\[[^\]]+\]/g, "").trim();
}

/** Build a CitationPair from one span, or null if the source file is missing or has no line range. */
async function buildSpanPair(
  slug: string,
  claimText: string,
  span: SourceSpan,
  sources: SourceFileReads,
): Promise<CitationPair | null> {
  if (!span.lines) return null;
  const sourceFile = await resolveSourceFileFrom(sources.locations, span.file);
  if (sourceFile === null) return null;
  const spanText = await readSourceLines(sources, sourceFile, span.lines.start, span.lines.end);
  return {
    claimHash: hashPair(claimText, spanText),
    pageSlug: slug,
    claimText,
    citedFile: span.file,
    spanText,
    lineStart: span.lines.start,
    lineEnd: span.lines.end,
  };
}

/** Extract citation pairs from a single cited paragraph. */
async function extractParagraphPairs(
  slug: string,
  para: string,
  sources: SourceFileReads,
): Promise<CitationPair[]> {
  const citations = extractClaimCitations(para);
  if (citations.length === 0) return [];
  const claimText = stripCitationMarkers(para);
  const spans = citations.flatMap((c) => c.spans);
  const pairs = await Promise.all(spans.map((s) => buildSpanPair(slug, claimText, s, sources)));
  return pairs.filter((p): p is CitationPair => p !== null);
}

/** Extract citation pairs from a single page body. */
async function extractPagePairs(
  slug: string,
  body: string,
  sources: SourceFileReads,
): Promise<CitationPair[]> {
  const paragraphs = splitProseParagraphs(body);
  const results = await Promise.all(paragraphs.map((p) => extractParagraphPairs(slug, p, sources)));
  return results.flat();
}

/** What the pair extraction asks of the project: every page first, then one resolution and one whole-text read per cited span with a line range. */
export interface CitationPairSources {
  /** The page collection's sources. */
  pages: LintPageSources;
  /** The source resolver's reads. Nothing is kept between spans: a file cited twice is resolved and read twice. */
  sources: SourceFileReads;
}

/**
 * Extract all (claim, source span) pairs from the wiki.
 * Only pairs with valid line ranges pointing to existing source files are included.
 * @param root - Absolute path to the project root.
 */
export async function extractCitationPairs(root: string): Promise<CitationPair[]> {
  return extractCitationPairsFrom({ pages: diskLintPageSources(root), sources: diskSourceFileReads(root) });
}

/**
 * {@link extractCitationPairs} over {@link CitationPairSources}: THE ONE BODY.
 * Pages are taken one after another; within a page every paragraph and span
 * is started together. A span that does not resolve yields no pair; a source
 * read that fails rejects the extraction. The cited lines are sliced as given.
 *
 * @param from - The pages and the source resolver's reads.
 * @returns The pairs in page order, then paragraph order, then span order.
 */
export async function extractCitationPairsFrom(from: CitationPairSources): Promise<CitationPair[]> {
  const pages = await collectAllPagesFrom(from.pages);
  const all: CitationPair[] = [];
  for (const { filePath, content } of pages) {
    const { body } = parseFrontmatter(content);
    const slug = path.basename(filePath, ".md");
    const pairs = await extractPagePairs(slug, body, from.sources);
    all.push(...pairs);
  }
  return all;
}

/**
 * Select a stable sample of N pairs that resists churn as the corpus grows.
 *
 * Previously-sampled hashes are retained first; only empty slots are filled
 * from new pairs (sorted by claimHash for determinism). This means adding new
 * citations to the corpus never displaces an already-evaluated pair, so score
 * movement in reports reflects quality change rather than sample turnover.
 *
 * @param pairs - All extracted citation pairs.
 * @param sampleSize - Maximum number of pairs to return.
 * @param previousHashes - Hashes selected in the prior run (from the saved report).
 */
export function selectDeterministicSample(
  pairs: CitationPair[],
  sampleSize: number,
  previousHashes: string[] = [],
): CitationPair[] {
  const pairByHash = new Map(pairs.map((p) => [p.claimHash, p]));
  const retained = previousHashes.flatMap((h) => {
    const p = pairByHash.get(h);
    return p ? [p] : [];
  });
  if (retained.length >= sampleSize) return retained.slice(0, sampleSize);
  const retainedSet = new Set(previousHashes);
  const newPairs = pairs
    .filter((p) => !retainedSet.has(p.claimHash))
    .sort((a, b) => a.claimHash.localeCompare(b.claimHash));
  return [...retained, ...newPairs].slice(0, sampleSize);
}

/** Load previously cached judgements keyed by claimHash. */
async function loadCachedJudgements(reads: EvalFileReads): Promise<Map<string, CitationJudgement>> {
  if (!reads.existsSync(CACHE_FILE)) return new Map();
  const content = await reads.readText(CACHE_FILE);
  const map = new Map<string, CitationJudgement>();
  for (const line of content.trim().split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line) as CitationJudgement;
      map.set(entry.claimHash, entry);
    } catch {
      // Skip malformed cache lines
    }
  }
  return map;
}

/** Append a single judgement to the cache file. */
async function appendCachedJudgement(writes: EvalFileWrites, judgement: CitationJudgement): Promise<void> {
  await writes.makeDirectoryTree(CACHE_DIR);
  await writes.appendText(CACHE_FILE, JSON.stringify(judgement) + "\n");
}

/** Resolve the current model identifier for recording in judgements. */
function resolveJudgementModel(): string {
  const provider = normalizeProviderName(process.env.LLMWIKI_PROVIDER ?? DEFAULT_PROVIDER);
  if (provider === "offline") return PROVIDER_MODELS.offline;
  return process.env.LLMWIKI_MODEL ?? PROVIDER_MODELS[provider] ?? provider;
}

/** Call the LLM judge for a single (claim, span) pair. */
async function callJudge(pair: CitationPair, cacheKey: string, model: string): Promise<CitationJudgement> {
  const userMessage =
    `Claim: ${pair.claimText}\n\nSource (${pair.citedFile}, lines ${pair.lineStart}–${pair.lineEnd}):\n${pair.spanText}`;

  const raw = await callClaude({
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    tools: [JUDGE_TOOL],
    maxTokens: 256,
  });

  const parsed = JSON.parse(raw) as { score: 0 | 1 | 2; reason: string };
  if (![0, 1, 2].includes(parsed?.score) || typeof parsed.reason !== "string" || !parsed.reason.trim()) {
    throw new Error("Citation judge returned an invalid score or reason");
  }
  return {
    claimHash: cacheKey,
    pageSlug: pair.pageSlug,
    citedFile: pair.citedFile,
    lineStart: pair.lineStart,
    lineEnd: pair.lineEnd,
    claimText: pair.claimText,
    spanText: pair.spanText,
    score: parsed.score,
    reason: parsed.reason,
    model,
    timestamp: new Date().toISOString(),
  };
}

/** Aggregate raw judgement scores into summary statistics. */
function aggregateJudgements(judgements: CitationJudgement[]): Pick<
  CitationSupportResult,
  "meanScore" | "fullySupported" | "partiallySupported" | "unsupported"
> {
  const fullySupported = judgements.filter((j) => j.score === 2).length;
  const partiallySupported = judgements.filter((j) => j.score === 1).length;
  const unsupported = judgements.filter((j) => j.score === 0).length;
  const meanScore =
    judgements.length === 0
      ? 0
      : judgements.reduce((sum, j) => sum + j.score, 0) / judgements.length;
  return { meanScore, fullySupported, partiallySupported, unsupported };
}

/**
 * Judge each non-cached pair in the sample, returning all collected judgements
 * and an error count. Throws if every non-cached call fails (credentials missing,
 * provider down, etc.) — an empty result would be meaningless.
 */
async function judgeNewPairs(
  sample: CitationPair[],
  cache: CitationJudgeCacheFiles,
): Promise<{ judgements: CitationJudgement[]; judgeErrors: number }> {
  const judge = await createCitationJudgeFrom(cache);
  const judgements: CitationJudgement[] = [];
  let judgeErrors = 0;
  let newPairsAttempted = 0;
  let firstError: unknown;

  for (const pair of sample) {
    try {
      const result = await judge(pair);
      if (!result.cached) newPairsAttempted++;
      judgements.push(result.judgement);
    } catch (err) {
      newPairsAttempted++;
      judgeErrors++;
      if (firstError === undefined) firstError = err;
    }
  }

  if (newPairsAttempted > 0 && judgeErrors === newPairsAttempted) {
    const msg = firstError instanceof Error ? firstError.message : String(firstError);
    throw new Error(`Citation judge failed for all ${judgeErrors} sampled pair(s): ${msg}`);
  }

  return { judgements, judgeErrors };
}

/**
 * What the judge asks of the project for its cache: the raw reads and writes of
 * one file under `.llmwiki/eval`. It holds no parsed cache, judgement or
 * verdict; the judge loads, checks, memoizes and appends by itself. The judge
 * never asks `writes.removeFile`.
 */
export interface CitationJudgeCacheFiles {
  /** Whether the cache file is there, answered at once, and its whole text. */
  reads: EvalFileReads;
  /** The directory tree, then one appended line per new verdict. */
  writes: EvalFileWrites;
}

/** Share the existing judge and cache with alternate document selections. */
export async function createCitationJudge(root: string, options: { namespace?: string; model?: string; persist?: boolean } = {}) {
  return createCitationJudgeFrom({ reads: diskEvalFileReads(root), writes: diskEvalFileWrites(root) }, options);
}

/**
 * {@link createCitationJudge} over {@link CitationJudgeCacheFiles}: THE ONE
 * BODY. The options are resolved when the judge is made. With `persist` the
 * cache is read once, then; without it no file is asked about, read or
 * written. A verdict is appended before it is remembered, so a failed append
 * leaves the judge without it.
 *
 * @param files - The cache file's raw reads and writes.
 * @param options - The cache namespace, the model recorded and keyed on, and whether the cache file is used.
 * @returns The judge: one pair in, its judgement and whether it came from the cache out.
 */
export async function createCitationJudgeFrom(files: CitationJudgeCacheFiles, options: { namespace?: string; model?: string; persist?: boolean } = {}) {
  const { namespace = "", model = resolveJudgementModel(), persist = true } = options;
  const cache = persist ? await loadCachedJudgements(files.reads) : new Map<string, CitationJudgement>();
  return async (pair: CitationPair) => {
    const cacheKey = makeCacheKey(pair.claimHash + namespace, model);
    const cached = cache.get(cacheKey);
    if (cached && [0, 1, 2].includes(cached.score) && typeof cached.reason === "string" && cached.reason.trim()) {
      // Content cache reuse must not carry the previous document's identity.
      return { cached: true, judgement: { ...cached, ...pair, claimHash: cacheKey } };
    }
    const judgement = await callJudge(pair, cacheKey, model);
    if (persist) await appendCachedJudgement(files.writes, judgement);
    cache.set(cacheKey, judgement);
    return { cached: false, judgement };
  };
}

/**
 * What the evaluator asks of the project: the pair extraction's sources, then
 * the judge's cache file. It holds no pair, sample, verdict or report; each is
 * worked out in {@link evaluateCitationSupportFrom} from what these return.
 */
export interface CitationSupportSources {
  /** The pages and the source resolver's reads the pairs are extracted from. */
  pairs: CitationPairSources;
  /** The judge's cache file. Not asked about at all when no pair is found. */
  cache: CitationJudgeCacheFiles;
}

/**
 * Run the citation support judge across a stable sample of wiki citations.
 * Returns null if no citable paragraphs exist.
 * @param root - Absolute path to the project root.
 * @param sampleSize - Number of citation pairs to judge per run.
 * @param previousHashes - Hashes sampled in the prior run; retained to prevent sample churn.
 */
export async function evaluateCitationSupport(
  root: string,
  sampleSize = 20,
  previousHashes: string[] = [],
): Promise<CitationSupportResult | null> {
  return evaluateCitationSupportFrom({
    pairs: { pages: diskLintPageSources(root), sources: diskSourceFileReads(root) },
    cache: { reads: diskEvalFileReads(root), writes: diskEvalFileWrites(root) },
  }, sampleSize, previousHashes);
}

/**
 * {@link evaluateCitationSupport} over {@link CitationSupportSources}: THE ONE
 * BODY. Every pair is extracted first; with none, the answer is null and the
 * cache is never asked. Otherwise the sample is chosen, one judge is made, and
 * the sampled pairs are judged one after another in sample order.
 *
 * @param from - The pair extraction's sources and the judge's cache file.
 * @param sampleSize - Number of citation pairs to judge per run.
 * @param previousHashes - Hashes sampled in the prior run; retained to prevent sample churn.
 * @returns The sampled judgements with their totals, or null when the wiki has no citable pair.
 */
export async function evaluateCitationSupportFrom(
  from: CitationSupportSources,
  sampleSize: number,
  previousHashes: string[],
): Promise<CitationSupportResult | null> {
  const allPairs = await extractCitationPairsFrom(from.pairs);
  if (allPairs.length === 0) return null;

  const sample = selectDeterministicSample(allPairs, sampleSize, previousHashes);
  const { judgements, judgeErrors } = await judgeNewPairs(sample, from.cache);

  return {
    sampledCount: judgements.length,
    sampledHashes: sample.map((p) => p.claimHash),
    totalCitations: allPairs.length,
    judgeErrors,
    ...aggregateJudgements(judgements),
    judgements,
  };
}
