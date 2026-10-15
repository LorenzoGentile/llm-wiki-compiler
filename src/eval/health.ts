/**
 * Health score evaluator for the llmwiki eval harness.
 *
 * Aggregates the output of all 10+ lint rules into a single 0–100 score.
 * Errors on critical rules (broken links/citations, duplicates) cost 4 pts
 * each; contradicted pages cost 2 pts; all other warnings/info cost 1 pt each.
 * The final score is clamped to [0, 100].
 *
 * The score has ONE body, {@link evaluateHealthFrom}, over the lint run's own
 * {@link LintSources}: the lint run reads through all of them, and the pending
 * review count reads through their `candidates` member. It names no project
 * root. `evaluateHealth` and `runAllLintRules` build the local-disk sources
 * from their root and delegate.
 */

import {
  checkBrokenWikilinks,
  checkBrokenCitations,
  checkMalformedClaimCitations,
  checkOrphanedPages,
  checkMissingSummaries,
  checkDuplicateConcepts,
  checkEmptyPages,
  checkLowConfidencePages,
  checkContradictedPages,
  checkInferredWithoutCitations,
  checkSchemaCrossLinks,
} from "../linter/rules.js";
import { loadSchema } from "../schema/loader.js";
import { countCandidatesFrom } from "../compiler/candidate-read.js";
import { lintFrom } from "../linter/index.js";
import { diskLintSources, type LintSources } from "../linter/lint-sources.js";
import type { LintResult } from "../linter/types.js";
import type { HealthResult, HealthRuleResult } from "./types.js";

const MAX_SCORE = 100;
const ERROR_DEDUCTION = 4;
const CONTRADICTED_DEDUCTION = 2;
const DEFAULT_DEDUCTION = 1;

/** Rules treated as high-severity errors (−4 pts per violation). */
const ERROR_RULES = new Set([
  "broken-wikilink",
  "broken-citation",
  "duplicate-concept",
]);

/** Compute the point deduction for a single lint result. */
export function deductionFor(result: LintResult): number {
  if (result.rule === "pending-target") return 0;
  if (ERROR_RULES.has(result.rule)) return ERROR_DEDUCTION;
  if (result.rule === "contradicted-page") return CONTRADICTED_DEDUCTION;
  return DEFAULT_DEDUCTION;
}

/** Aggregate lint results into a per-rule summary with deduction totals. */
function aggregateRules(results: LintResult[]): HealthRuleResult[] {
  const map = new Map<string, HealthRuleResult>();
  for (const result of results) {
    const existing = map.get(result.rule);
    const deduction = deductionFor(result);
    if (existing) {
      existing.count++;
      existing.deduction += deduction;
    } else {
      map.set(result.rule, {
        rule: result.rule,
        count: 1,
        severity: result.severity,
        deduction,
      });
    }
  }
  return Array.from(map.values());
}

/**
 * Run all lint rules against the project root and return an aggregated
 * health score plus per-rule breakdown.
 * @param root - Absolute path to the project root.
 */
/**
 * Run all lint rules via the canonical linter orchestrator and return
 * flat results. Delegates to lint() so the rule list stays in sync with
 * llmwiki lint — no manual list to maintain. Used by evaluateHealth and
 * by page-health-distribution so both see the same diagnostics.
 */
export async function runAllLintRules(root: string): Promise<LintResult[]> {
  return runAllLintRulesFrom(diskLintSources(root));
}

/** {@link runAllLintRules} over {@link LintSources}: the flat findings of one lint run, with no project root. */
export async function runAllLintRulesFrom(sources: LintSources): Promise<LintResult[]> {
  const summary = await lintFrom(sources);
  return summary.results;
}

export async function evaluateHealth(root: string): Promise<HealthResult> {
  return evaluateHealthFrom(diskLintSources(root));
}

/**
 * {@link evaluateHealth} over {@link LintSources}: THE ONE BODY. The lint run
 * and the pending review count start together. A count that fails is 0; a lint
 * run that fails rejects the score.
 *
 * @param sources - The lint run's sources; their `candidates` member is also what the pending reviews are counted through.
 * @returns The clamped score, the per-rule breakdown and the pending review count.
 */
export async function evaluateHealthFrom(sources: LintSources): Promise<HealthResult> {
  const [allResults, pendingReviews] = await Promise.all([
    runAllLintRulesFrom(sources),
    countCandidatesFrom(sources.candidates).catch(() => 0),
  ]);

  const rules = aggregateRules(allResults);
  const totalDeduction = rules.reduce((sum, r) => sum + r.deduction, 0);
  const score = Math.max(0, MAX_SCORE - totalDeduction);

  return { score, maxScore: MAX_SCORE, rules, pendingReviews };
}
