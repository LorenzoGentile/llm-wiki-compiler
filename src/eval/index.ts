/**
 * Report assembly for the llmwiki eval harness.
 *
 * Combines evaluated components (health, citation coverage, stats, citation support)
 * into a final EvalReport with delta tracking and threshold validation.
 * Shared by the CLI eval command and the MCP run_eval tool.
 *
 * The pipeline has ONE body, {@link runEvalFrom}, over {@link EvalSources}: one
 * existing seam per evaluator, reader and writer it runs. `runEval` keeps its
 * root-taking form and hands that body the local disk's sources.
 */

import { evaluateHealthFrom } from "./health.js";
import { evaluateCitationCoverageFrom, type CitationCoverageSources } from "./citation-coverage.js";
import { evaluateSourceUtilizationFrom, type SourceUtilizationSources } from "./source-utilization.js";
import { evaluateCitationDepthFrom } from "./citation-depth.js";
import { evaluatePageHealthDistributionFrom } from "./page-health-distribution.js";
import { evaluateGraphHealthFrom } from "./graph-health.js";
import { evaluateCitationSupportFrom, type CitationSupportSources } from "./citation-support.js";
import { collectStatsFrom, appendHistoryFrom, loadPreviousReportFrom, loadLastFullReportFrom, type StatsSources } from "./stats.js";
import { computeDelta } from "./delta.js";
import { checkThresholdsFrom } from "./thresholds.js";
import { diskEvalFileReads, type EvalFileReads } from "./file-reads.js";
import { diskEvalFileWrites, type EvalFileWrites } from "./file-writes.js";
import { diskSourceFileLocations, diskSourceFileReads } from "./source-path.js";
import { diskLintSources, type LintSources } from "../linter/lint-sources.js";
import { diskLintPageSources, type LintPageSources } from "../linter/rules-shared.js";
import { diskLocalEntityScans, diskLocalReads, locationKindNoFollow } from "../storage/disk-local-reads.js";
import type { LegacyLocalEntityScans } from "../storage/legacy-local-reads.js";
import { diskStoredEmbeddingReads } from "../utils/embeddings-storage.js";
import { ensureProviderAvailable } from "../utils/provider-guard.js";
import type { EvalReport, HealthResult, CitationCoverageResult, SourceUtilizationResult, CitationDepthResult, PageHealthDistributionResult, GraphHealthResult, CitationSupportResult, StatsResult } from "./types.js";

export const DEFAULT_SAMPLE_SIZE = 20;

interface EvalComponents {
  health: HealthResult;
  citationCoverage: CitationCoverageResult;
  sourceUtilization: SourceUtilizationResult;
  citationDepth: CitationDepthResult;
  pageHealthDistribution?: PageHealthDistributionResult;
  graphHealth?: GraphHealthResult | null;
  stats: StatsResult;
  previousReport: EvalReport | null;
  citationSupport?: CitationSupportResult | null;
}

/**
 * What the pipeline asks of the project: ONE ENTRY PER STEP, each the existing
 * seam of the evaluator, reader or writer that step runs. Nothing is shared
 * between steps that the root-taking steps did not share: the health score
 * and the per-page distribution each have lint sources of their own. It holds
 * no finding, metric, pair, verdict or report; every one is worked out by the
 * step from what its entry returns.
 */
export interface EvalSources {
  health: LintSources;
  citationCoverage: CitationCoverageSources;
  sourceUtilization: SourceUtilizationSources;
  citationDepth: LintPageSources;
  pageHealthDistribution: LintSources;
  graphHealth: LegacyLocalEntityScans;
  stats: StatsSources;
  /** The history file's reads, for the previous report and, in the full suite, the last full report. */
  history: EvalFileReads;
  /** Asked only in the full suite, after the nine reads above. */
  citationSupport: CitationSupportSources;
  /** The thresholds file's reads, asked once the report's parts are in. */
  thresholds: EvalFileReads;
  /** The history file's writes. Asked last, and only when the run is recorded. */
  record: EvalFileWrites;
}

/** LOCAL DISK. The pipeline's sources for the project at `root`, each built as its own root-taking step built it. Building them does no I/O. In no package index. */
export function diskEvalSources(root: string): EvalSources {
  const pages = (): LintPageSources => diskLintPageSources(root);
  return {
    health: diskLintSources(root),
    citationCoverage: { pages: pages(), locations: diskSourceFileLocations(root) },
    sourceUtilization: { reads: diskLocalReads(root), locations: diskSourceFileLocations(root), kindNoFollow: locationKindNoFollow, pages: pages() },
    citationDepth: pages(),
    pageHealthDistribution: diskLintSources(root),
    graphHealth: diskLocalEntityScans(root),
    stats: { sourceReads: diskLocalReads(root), pages: pages(), embeddings: diskStoredEmbeddingReads(root) },
    history: diskEvalFileReads(root),
    citationSupport: {
      pairs: { pages: pages(), sources: diskSourceFileReads(root) },
      cache: { reads: diskEvalFileReads(root), writes: diskEvalFileWrites(root) },
    },
    thresholds: diskEvalFileReads(root),
    record: diskEvalFileWrites(root),
  };
}

async function buildReport(thresholds: EvalFileReads, components: EvalComponents, suite: "fast" | "full"): Promise<EvalReport> {
  const { health, citationCoverage, sourceUtilization, citationDepth, pageHealthDistribution, graphHealth, stats, previousReport, citationSupport } = components;
  const partial = {
    suite,
    timestamp: new Date().toISOString(),
    health,
    citationCoverage,
    sourceUtilization,
    citationDepth,
    ...(pageHealthDistribution ? { pageHealthDistribution } : {}),
    ...(graphHealth ? { graphHealth } : {}),
    stats,
    ...(citationSupport ? { citationSupport } : {}),
  };
  const delta = previousReport ? computeDelta(partial as EvalReport, previousReport) : undefined;
  const thresholdViolations = await checkThresholdsFrom(partial as EvalReport, thresholds);
  return { ...partial, ...(delta ? { delta } : {}), thresholdViolations };
}

/** Run the full eval pipeline, optionally append to history, and return the report. */
export async function runEval(root: string, suite: "fast" | "full", sampleSize: number, record = true): Promise<EvalReport> {
  return runEvalFrom(diskEvalSources(root), suite, sampleSize, record);
}

/**
 * {@link runEval} over {@link EvalSources}: THE ONE BODY. In the full suite the
 * providers are checked before anything is asked of the project. The nine reads
 * are then started together, in the order written. The citation judge runs
 * after them, in the full suite only, keeping the last full report's sample.
 * The report is assembled, checked against the thresholds, and appended to the
 * history only when `record` is true.
 *
 * @param from - One existing seam per step of the pipeline.
 * @param suite - `fast` skips the citation judge; `full` runs it.
 * @param sampleSize - Number of citation pairs the judge samples in the full suite.
 * @param record - Whether the finished report is appended to the history.
 * @returns The finished report.
 */
export async function runEvalFrom(from: EvalSources, suite: "fast" | "full", sampleSize: number, record: boolean): Promise<EvalReport> {
  if (suite === "full") ensureProviderAvailable();
  const [health, citationCoverage, sourceUtilization, citationDepth, pageHealthDistribution, graphHealth, stats, previousReport, previousFullReport] = await Promise.all([
    evaluateHealthFrom(from.health),
    evaluateCitationCoverageFrom(from.citationCoverage),
    evaluateSourceUtilizationFrom(from.sourceUtilization),
    evaluateCitationDepthFrom(from.citationDepth),
    evaluatePageHealthDistributionFrom(from.pageHealthDistribution),
    evaluateGraphHealthFrom(from.graphHealth),
    collectStatsFrom(from.stats),
    loadPreviousReportFrom(from.history),
    suite === "full" ? loadLastFullReportFrom(from.history) : Promise.resolve(null),
  ]);
  const citationSupport = suite === "full"
    ? await evaluateCitationSupportFrom(from.citationSupport, sampleSize, previousFullReport?.citationSupport?.sampledHashes ?? [])
    : undefined;
  const report = await buildReport(from.thresholds, { health, citationCoverage, sourceUtilization, citationDepth, pageHealthDistribution, graphHealth, stats, previousReport, citationSupport }, suite);
  if (record) await appendHistoryFrom(from.record, report);
  return report;
}
