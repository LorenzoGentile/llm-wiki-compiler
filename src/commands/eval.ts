/**
 * CLI action handlers for `llmwiki eval` and its subcommands.
 *
 * Default action (evalCommand): runs the full or fast eval suite and outputs
 * a terminal table or JSON report, appending the result to history.jsonl.
 *
 * Subcommand handlers:
 *   evalCacheClearCommand  — delete the citation judgement cache
 *   evalCacheShowCommand   — print a cache summary
 *   evalReportCommand      — re-display the most recent eval report
 *   evalHistoryCommand     — show a trend table of past runs
 *   evalJudgementsCommand  — browse individual citation judgements with filters
 *
 * Each handler has ONE body, its `…From` form, over the existing raw seams of
 * what it reads and writes in the project. The handler commander calls keeps
 * its name and options and hands that body the local disk's sources for the
 * current directory. Printing and the process exit status are the host's, and
 * stay direct.
 */

import { loadHistoryFrom, loadPreviousReportFrom } from "../eval/stats.js";
import { runEvalFrom, diskEvalSources, DEFAULT_SAMPLE_SIZE, type EvalSources } from "../eval/index.js";
import {
  formatTerminalReport,
  formatJsonReport,
  formatHistoryTable,
  formatCacheShow,
  formatJudgementsDisplay,
} from "../eval/report.js";
import { clearCitationCacheFrom, loadCitationCacheFrom, summarizeCitationCache } from "../eval/cache.js";
import { evaluateCandidatesFrom, diskCandidateEvalSources, formatCandidateReport, type CandidateEvalSources } from "../eval/candidates.js";
import type { CitationJudgeCacheFiles } from "../eval/citation-support.js";
import { diskEvalFileReads, type EvalFileReads } from "../eval/file-reads.js";
import { diskEvalFileWrites } from "../eval/file-writes.js";

interface EvalOptions {
  suite?: string;
  out?: string;
  sample?: string;
  candidates?: boolean;
}

/** What `llmwiki eval` asks of the project: the pipeline's sources for the live wiki, and the pending-candidate evaluator's for `--candidates`. Only the branch taken is asked. */
export interface EvalCommandSources {
  live: EvalSources;
  candidates: CandidateEvalSources;
}

/** Whether the CLI appends a finished live run to the history. It always has. */
const RECORD_CLI_RUN = true;

interface ResolvedEvalOptions {
  suite: "fast" | "full";
  sampleSize: number;
  outFormat: "terminal" | "json";
}

/**
 * Parse and validate --sample as a positive integer.
 * @throws if the value is not a positive integer (rejects 0, negatives, decimals, non-numeric).
 */
export function parseSampleSize(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--sample must be a positive integer (got "${raw}")`);
  }
  return n;
}

function resolveEvalOptions(options: EvalOptions): ResolvedEvalOptions {
  return {
    suite: options.suite === "full" ? "full" : "fast",
    sampleSize: parseSampleSize(options.sample ?? String(DEFAULT_SAMPLE_SIZE)),
    outFormat: options.out === "json" ? "json" : "terminal",
  };
}

/**
 * Run the eval harness against the current project.
 * @param options - Parsed CLI options.
 */
export default async function evalCommand(options: EvalOptions = {}): Promise<void> {
  const root = process.cwd();
  return evalCommandFrom({ live: diskEvalSources(root), candidates: diskCandidateEvalSources(root) }, options);
}

/**
 * {@link evalCommand} over {@link EvalCommandSources}: THE ONE BODY. The
 * options are resolved, and a bad `--sample` refused, before anything is asked
 * of the project. A pending-candidate run sets the exit status and returns; a
 * live run that breaks a threshold exits the process after printing.
 *
 * @param from - The live pipeline's sources and the pending-candidate evaluator's.
 * @param options - Parsed CLI options.
 */
export async function evalCommandFrom(from: EvalCommandSources, options: EvalOptions): Promise<void> {
  const { suite, sampleSize, outFormat } = resolveEvalOptions(options);

  if (options.candidates) {
    const report = await evaluateCandidatesFrom(from.candidates, suite, sampleSize);
    console.log(outFormat === "json" ? JSON.stringify(report, null, 2) : formatCandidateReport(report));
    if (report.coverage.judgeErrors) process.exitCode = 1;
    return;
  }

  const report = await runEvalFrom(from.live, suite, sampleSize, RECORD_CLI_RUN);

  const output = outFormat === "json" ? formatJsonReport(report) : formatTerminalReport(report);
  console.log(output);

  if (report.thresholdViolations.length > 0) {
    process.exit(1);
  }
}

/** Delete the citation judgement cache so all pairs are re-judged on the next full run. */
export async function evalCacheClearCommand(): Promise<void> {
  const root = process.cwd();
  return evalCacheClearCommandFrom({ reads: diskEvalFileReads(root), writes: diskEvalFileWrites(root) });
}

/** {@link evalCacheClearCommand} over the cache file's reads and writes: THE ONE BODY. */
export async function evalCacheClearCommandFrom(cache: CitationJudgeCacheFiles): Promise<void> {
  const deleted = await clearCitationCacheFrom(cache.reads, cache.writes);
  console.log(deleted ? "Citation cache cleared." : "No citation cache found.");
}

/** Print a summary of cached citation judgements (score distribution + per-page counts). */
export async function evalCacheShowCommand(): Promise<void> {
  return evalCacheShowCommandFrom(diskEvalFileReads(process.cwd()));
}

/** {@link evalCacheShowCommand} over the cache file's reads: THE ONE BODY. */
export async function evalCacheShowCommandFrom(reads: EvalFileReads): Promise<void> {
  const judgements = await loadCitationCacheFrom(reads);
  const summary = summarizeCitationCache(judgements);
  console.log(formatCacheShow(judgements, summary));
}

interface ReportOptions { out?: string }

/** Re-display the most recent eval report from history without running a new evaluation. */
export async function evalReportCommand(options: ReportOptions = {}): Promise<void> {
  return evalReportCommandFrom(diskEvalFileReads(process.cwd()), options);
}

/** {@link evalReportCommand} over the history file's reads: THE ONE BODY. */
export async function evalReportCommandFrom(reads: EvalFileReads, options: ReportOptions): Promise<void> {
  const report = await loadPreviousReportFrom(reads);
  if (!report) {
    console.log("No eval history found. Run `llmwiki eval` to record the first run.");
    return;
  }
  const output = options.out === "json" ? formatJsonReport(report) : formatTerminalReport(report);
  console.log(output);
}

interface HistoryOptions { n?: string; out?: string }

/** Show a trend table of the last N eval runs from history.jsonl. */
export async function evalHistoryCommand(options: HistoryOptions = {}): Promise<void> {
  return evalHistoryCommandFrom(diskEvalFileReads(process.cwd()), options);
}

/** {@link evalHistoryCommand} over the history file's reads: THE ONE BODY. */
export async function evalHistoryCommandFrom(reads: EvalFileReads, options: HistoryOptions): Promise<void> {
  const n = parseInt(options.n ?? "10", 10);
  const reports = await loadHistoryFrom(reads, n);
  if (options.out === "json") {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }
  console.log(formatHistoryTable(reports));
}

interface JudgementsOptions { score?: string; page?: string; n?: string; out?: string }

function filterJudgements(judgements: Awaited<ReturnType<typeof loadCitationCacheFrom>>, options: JudgementsOptions) {
  let result = judgements;
  if (options.score !== undefined) result = result.filter((j) => j.score === parseInt(options.score!, 10));
  if (options.page) result = result.filter((j) => j.pageSlug === options.page);
  if (options.n !== undefined) result = result.slice(0, parseInt(options.n, 10));
  return result;
}

/** Browse cached citation judgements with optional filters by score, page, and count. */
export async function evalJudgementsCommand(options: JudgementsOptions = {}): Promise<void> {
  return evalJudgementsCommandFrom(diskEvalFileReads(process.cwd()), options);
}

/** {@link evalJudgementsCommand} over the cache file's reads: THE ONE BODY. */
export async function evalJudgementsCommandFrom(reads: EvalFileReads, options: JudgementsOptions): Promise<void> {
  const judgements = filterJudgements(await loadCitationCacheFrom(reads), options);
  if (options.out === "json") {
    console.log(JSON.stringify(judgements, null, 2));
    return;
  }
  console.log(formatJudgementsDisplay(judgements));
}
