/**
 * Commander action for `llmwiki lint`.
 *
 * Runs rule-based quality checks against the wiki without any LLM calls.
 * Prints colored diagnostics grouped by severity and exits with code 1
 * if any errors are found.
 *
 * The REPORT paths (flat, tiered, fix-preview) have ONE body,
 * {@link lintCommandFrom}, over {@link LintCommandSources}. They read and write
 * through those sources only and name no project root. That body REFUSES
 * `fixPropose`: it never stages a candidate. Printing and the process exit code
 * stay direct: they are the operator's terminal, not the project.
 *
 * `lintCommand` prints the header, builds the local-disk sources from the
 * working directory, and then either delegates to the report body or, for
 * `--fix-propose`, announces the schema and dispatches to the writer itself.
 *
 * OPEN, ROOT-ONLY: `--fix-propose` stages a review candidate under the project
 * lock, through the working directory (`lint-fix-propose.ts`). Only the root
 * wrapper reaches it. Its lock, recovery gate and candidate store are not
 * migrated.
 */

import { lintBothViewsFrom } from "../linter/index.js";
import { diskLintSources, type LintSources } from "../linter/lint-sources.js";
import type { TieredLintReportV1 } from "../linter/tiers.js";
import { diskLintCacheSources, writeLintCacheFrom, type LintCacheSources } from "../linter/cache.js";
import * as output from "../utils/output.js";
import type { LintResult } from "../linter/types.js";
import { loadSchemaFrom } from "../schema/index.js";
import { planLintFixesFrom } from "../linter/fix-plan.js";
import { lintFixProposeCommand } from "./lint-fix-propose.js";

/** Map severity levels to output formatting functions. */
const SEVERITY_FORMATTERS: Record<LintResult["severity"], (text: string) => string> = {
  error: output.error,
  warning: output.warn,
  info: output.info,
};

/** Map severity levels to display icons. */
const SEVERITY_ICONS: Record<LintResult["severity"], string> = {
  error: "x",
  warning: "!",
  info: "i",
};

/** Print a single lint result with colored output. */
function printResult(result: LintResult): void {
  const formatter = SEVERITY_FORMATTERS[result.severity];
  const icon = SEVERITY_ICONS[result.severity];
  const location = result.line ? `${result.file}:${result.line}` : result.file;
  output.status(icon, `${formatter(result.severity)} ${output.dim(location)} ${result.message}`);
}

/**
 * Run the lint command: execute all rules and print results.
 * Exits with code 1 if any errors are found.
 */
/** Options for {@link lintCommand}. */
export interface LintCommandOptions {
  /** Preview §4.6's deterministic repairs as concrete edits; write nothing. */
  fixPreview?: boolean;
  /**
   * Propose the nth deterministic fix (as `--fix-preview` numbers them) as a
   * review candidate the operator applies with `review approve`. Writes nothing
   * to `wiki/`; a target changed since the proposal is refused at approval.
   */
  fixPropose?: number;
  /**
   * Group findings by the KIND of claim each makes, and exit non-zero only for
   * deterministic errors. Off by default: the flat report and its exit code are
   * unchanged for every existing caller.
   */
  tiered?: boolean;
}

/** Print one tier under a heading, or say it is empty. */
function printTier(heading: string, results: readonly LintResult[]): void {
  output.status("*", `${heading} (${results.length})`);
  for (const result of results) printResult(result);
}

/**
 * The tiered report (§4.6): the same findings, split by what kind of claim they
 * make, so a reader can tell what is BROKEN from what is merely an opinion or
 * out of date.
 *
 * The exit code follows the deterministic tier alone. A model judging a page
 * low-confidence is not grounds to fail, and neither is an index that needs
 * regenerating — under the flat report both do fail, which is what makes a
 * "0 errors" bar unreachable on a healthy wiki.
 */
function printTiered(tiered: TieredLintReportV1): void {
  printTier("BROKEN — deterministic failures", tiered.deterministic);
  printTier("JUDGEMENT — a model's assessment, not a fact", tiered.providerJudgement);
  printTier("STALE — derived views to regenerate, nothing is wrong", tiered.derivedView);
}

/**
 * What the lint command reads and writes through, on every path except
 * `--fix-propose`. Both members are existing seams.
 */
export interface LintCommandSources {
  /**
   * The lint run's sources. Its `schema` member also answers the command's own
   * schema load, which comes BEFORE the run's; its `pages` and `candidates`
   * members are the fix preview's link sources.
   */
  lint: LintSources;
  /** The lint cache, written by the flat and the tiered path after the report is printed and before the exit code is set. */
  cache: LintCacheSources;
}

/** LOCAL DISK. The command's sources for the project at `root`. Building them does no I/O. Private to this module. */
function diskLintCommandSources(root: string): LintCommandSources {
  return { lint: diskLintSources(root), cache: diskLintCacheSources(root) };
}

/** The flags the report body takes: every flag except the one that stages a candidate. Private: callers pass a plain options object. */
type LintReportOptions = Omit<LintCommandOptions, "fixPropose">;

/** What the report body throws when it is handed `fixPropose`: it reports and never stages. */
const FIX_PROPOSE_IS_ROOT_ONLY =
  "lintCommandFrom does not stage fix proposals: --fix-propose runs only through lintCommand, under the project lock";

/** Pick the report run for the requested flags: fix-preview, else tiered, else flat. */
function selectReportRun(sources: LintCommandSources, options: LintReportOptions): () => Promise<void> {
  if (options.fixPreview === true) return () => runFixPreview(sources);
  return options.tiered === true ? () => runTiered(sources) : () => runFlat(sources);
}

/** Load the schema through the lint sources and print where it came from. The first step of every path. */
async function announceSchema(sources: LintCommandSources): Promise<void> {
  const schema = await loadSchemaFrom(sources.lint.schema);
  const schemaSource = schema.loadedFrom ?? "defaults (no schema file)";
  output.status("i", output.dim(`Schema: ${schemaSource}`));
}

export default async function lintCommand(options: LintCommandOptions = {}): Promise<void> {
  // The header is printed BEFORE the working directory is read, as it always was.
  output.header("Linting wiki");
  const sources = diskLintCommandSources(process.cwd());
  const proposeIndex = options.fixPropose;
  if (proposeIndex === undefined) return lintCommandFrom(sources, options);
  // Fix-propose wins over every other flag and still announces the schema first, once.
  await announceSchema(sources);
  return runFixPropose(proposeIndex);
}

/**
 * The report paths of {@link lintCommand}, after its header, over
 * {@link LintCommandSources}: THE ONE BODY for flat, tiered and fix-preview.
 * The schema is announced first; then exactly one path runs, chosen in this
 * order: fix-preview, tiered, flat.
 *
 * It REJECTS when `fixPropose` is set, before anything is read or printed. The
 * type excludes that flag; the check is for a caller that passes it anyway.
 *
 * @param sources - What the three report paths read and write through.
 * @param options - The report flags.
 * @throws {Error} When `fixPropose` is set.
 */
export async function lintCommandFrom(sources: LintCommandSources, options: LintReportOptions = {}): Promise<void> {
  if ((options as LintCommandOptions).fixPropose !== undefined) throw new Error(FIX_PROPOSE_IS_ROOT_ONLY);
  await announceSchema(sources);

  return selectReportRun(sources, options)();
}

/**
 * §4.6's other half: the deterministic repairs, PREVIEWED and never applied.
 *
 * The plan module existed and NOTHING imported it — correct-and-unreachable,
 * the same class as the packaging defects the parity run found. This is the
 * wiring: each fixable finding renders as the exact edit it would make, each
 * unfixable one as the recommendation §4.6 requires, and the command exits
 * without writing a byte either way.
 */
/** Stage one deterministic fix as a review candidate; exit non-zero on a refusal. ROOT-ONLY: called by {@link lintCommand} alone, through the working directory. */
async function runFixPropose(n: number): Promise<void> {
  const code = await lintFixProposeCommand(n);
  if (code !== 0) process.exit(code);
}

async function runFixPreview({ lint }: LintCommandSources): Promise<void> {
  const plans = await planLintFixesFrom({ pages: lint.pages, candidates: lint.candidates });
  if (plans.length === 0) {
    output.status("+", output.success("No broken wikilinks — nothing to fix."));
    return;
  }
  let fixNumber = 0;
  for (const plan of plans) {
    if (plan.kind === "fix") {
      // The number is the handle `--fix-propose <n>` takes; it counts FIXES
      // only (recommendations are not proposable), in this stable plan order.
      fixNumber += 1;
      output.status("~", output.info(`[${fixNumber}] ${plan.edit.file}:${plan.edit.line} [${plan.rule}]`));
      output.status(" ", output.dim(`  - ${plan.edit.from}`));
      output.status(" ", output.dim(`  + ${plan.edit.to}`));
    } else {
      output.status("!", output.warn(`${plan.file} [${plan.rule}] ${plan.advice}`));
    }
  }
  console.log();
  output.status("i", output.info(
    `${fixNumber} deterministic fix(es) previewed, ${plans.length - fixNumber} recommendation(s). ` +
      `Nothing was written. Propose fix N with \`llmwiki lint --fix-propose N\`.`,
  ));
}

/** The default path: one flat list and the pre-existing exit code. */
async function runFlat(sources: LintCommandSources): Promise<void> {
  // The flat summary of the one run, under the generic scope. The tiered view of the same run is not used here.
  const { summary } = await lintBothViewsFrom(sources.lint);

  for (const result of summary.results) {
    printResult(result);
  }

  console.log();
  const summaryLine = [
    output.error(`${summary.errors} error(s)`),
    output.warn(`${summary.warnings} warning(s)`),
    output.info(`${summary.info} info`),
  ].join(", ");
  output.status("*", summaryLine);

  await writeLintCacheFrom(sources.cache, summary);

  if (summary.errors > 0) {
    process.exit(1);
  }
}

/** The `--tiered` path: one run, both views, deterministic-only exit code. */
async function runTiered(sources: LintCommandSources): Promise<void> {
  const { summary, tiered } = await lintBothViewsFrom(sources.lint, "wiki-wide");
  printTiered(tiered);
  console.log();
  output.status("*", `${tiered.deterministicErrors} deterministic error(s) — the count that means something is wrong`);
  // The cache stays the flat summary every other reader already expects.
  await writeLintCacheFrom(sources.cache, summary);
  if (tiered.deterministicErrors > 0) process.exit(1);
}
