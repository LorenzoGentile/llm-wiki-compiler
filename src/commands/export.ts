/**
 * Commander action for `llmwiki export [--target <name>]`.
 *
 * Transforms existing wiki content into portable export artifacts and writes
 * them into dist/exports/ (relative to the project root). Six single-file
 * formats run by default:
 *
 *   llms-txt      — concise index per llmstxt.org spec → llms.txt
 *   llms-full-txt — full content export               → llms-full.txt
 *   json          — pages + metadata as JSON          → wiki.json
 *   json-ld       — Schema.org JSON-LD graph          → wiki.jsonld
 *   graphml       — directed link graph as XML        → wiki.graphml
 *   marp          — Marp slide deck                   → wiki.md
 *
 * A seventh target, OKF, is opt-in via `--target okf`: it writes a directory
 * bundle (index + per-page docs + references + log) rather than a single file,
 * defaulting to dist/exports/okf/ (override with `--out`). It is excluded from
 * the default-all run so a plain `export` never emits a directory.
 *
 * No LLM calls are made — export is a pure transformation of wiki content.
 *
 * THE IN-MEMORY JSON EXPORT HAS ONE BODY, {@link exportJsonFrom}, over raw
 * sources ({@link ExportJsonSources}): the export page sources, the profile
 * block's sources and the journal. `exportJson(root)` hands it the local
 * disk's sources, built per call.
 *
 * THE FILE EXPORT HAS ONE BODY, {@link runExportFrom}, over
 * {@link RunExportSources}: the same reads, the OKF export core's sources, and
 * two local mechanisms named as members: the package.json load through this
 * module's `require` (its cache included) and the atomic file writer. The
 * option checks, the title decision, target selection, each format's content,
 * the write order and every message are the body's. The output paths are
 * local paths under the project or wherever `--out` names; this is a legacy
 * local contract, not a `ProjectStore` capability.
 */

import path from "path";
import { createRequire } from "module";
import { atomicWrite } from "../utils/markdown.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import { collectExportPagesFrom, diskExportPageSources, type ExportPageSources } from "../export/collect.js";
import { buildLlmsTxt, buildLlmsFullTxt } from "../export/llms-txt.js";
import {
  buildJsonExport,
  buildJsonExportDocument,
  type BuildJsonExportOptions,
  type ExportJsonOptions,
  type JsonExportDocument,
  type JsonExportProfileBlock,
  type JsonExportWarning,
} from "../export/json-export.js";
import { buildExportProfileBlockFrom, type ExportProfileSources } from "../export/profile-block.js";
import { validateProjectId } from "../export/project-id.js";
import { diskProfileSummarySources } from "../profile/block.js";
import { diskJournalReadSources, type JournalReadSources } from "../trust/journal-classify.js";
import { journalHealthWarningFrom } from "../trust/journal-health-warning.js";
import { buildJsonLd } from "../export/json-ld.js";
import { buildGraphml } from "../export/graphml.js";
import { buildMarp } from "../export/marp.js";
import { diskOkfExportSources, runOkfExportFrom, type OkfExportSources } from "../export/okf/run.js";
import { EXPORT_DIR } from "../utils/constants.js";
import { EXPORT_TARGETS, DEFAULT_EXPORT_TARGETS, MARP_SOURCES } from "../export/types.js";
import type { ExportPage, ExportTarget, MarpSource } from "../export/types.js";

const require = createRequire(import.meta.url);

/** Map each target to its output filename. */
const TARGET_FILENAMES: Record<ExportTarget, string> = {
  "llms-txt": "llms.txt",
  "llms-full-txt": "llms-full.txt",
  json: "wiki.json",
  "json-ld": "wiki.jsonld",
  graphml: "wiki.graphml",
  marp: "wiki.md",
  // okf is a directory target; this entry satisfies the exhaustive Record type
  // but is never accessed (the OKF branch continues before reaching it).
  okf: "okf",
};

/** Options accepted by exportCommand and its programmatic entry point. */
export interface ExportOptions {
  /** Limit export to a single target. When absent all targets are produced. */
  target?: string;
  /**
   * For the marp target: which page kinds to include.
   * Accepts "concepts", "queries", or "all" (default when absent).
   */
  source?: string;
  /**
   * Optional bridge identifier embedded in the JSON export envelope.
   * Validated against the bridge contract regex
   * (`/^[a-z0-9][a-z0-9-]{0,62}$/`); invalid values throw before any
   * file is written.
   */
  projectId?: string;
  /**
   * Output directory for directory-style targets (e.g. okf).
   * When absent defaults to `dist/exports/okf` relative to the project root.
   */
  out?: string;
}

/** Result returned by runExport for testing and MCP consumers. */
export interface ExportResult {
  /** Absolute paths of files that were written. */
  written: string[];
  /** Number of pages included in each export. */
  pageCount: number;
}

/**
 * Resolve the human-readable project title from package.json, defaulting gracefully.
 * The load is synchronous and may answer from the loader's cache; any throw falls back.
 */
function resolveProjectTitleFrom(loadPackageJson: (location: string) => unknown, root: string): string {
  try {
    const pkg = loadPackageJson(path.join(root, "package.json")) as { name?: string };
    return typeof pkg.name === "string" ? pkg.name : "Knowledge Wiki";
  } catch {
    return "Knowledge Wiki";
  }
}

/**
 * Probe the project's compile journal and return the read-surface warnings to
 * embed in the export (currently the JSON target only). Empty for a healthy
 * project so the default envelope is unchanged. Read-only — never mutates disk.
 * The one mapping, over the journal's read sources; both export bodies use it.
 */
async function collectExportWarningsFrom(journal: JournalReadSources): Promise<JsonExportWarning[]> {
  const warning = await journalHealthWarningFrom(journal);
  return warning ? [warning] : [];
}

/** Return true when the given string is a valid ExportTarget. */
function isValidTarget(value: string): value is ExportTarget {
  return (EXPORT_TARGETS as readonly string[]).includes(value);
}

/** Return true when the given string is a valid MarpSource. */
function isValidMarpSource(value: string): value is MarpSource {
  return (MARP_SOURCES as readonly string[]).includes(value);
}

/** Resolve and validate the marp source filter. Throws for unknown values. */
function resolveMarpSource(rawSource: string | undefined): MarpSource {
  if (!rawSource) return "all";
  if (!isValidMarpSource(rawSource)) {
    throw new Error(
      `Unknown --source value "${rawSource}". Valid values: ${MARP_SOURCES.join(", ")}`,
    );
  }
  return rawSource;
}

/** Inputs to {@link buildContent}. Grouped to keep the argument list short. */
interface BuildContentInputs {
  target: ExportTarget;
  pages: ExportPage[];
  projectTitle: string;
  marpSource: MarpSource;
  /** Optional bridge identifier; only consumed by the json target. */
  projectId?: string;
  /** Pre-computed non-default profile block; only consumed by the json target. */
  profile?: JsonExportProfileBlock;
  /** Pre-computed read-surface health warnings; only consumed by the json target. */
  warnings?: JsonExportWarning[];
}

/**
 * Assemble the JSON-export options from the optional bridge id, the pre-computed
 * profile block, and the read-surface warnings, omitting each key when absent so
 * the default envelope is unchanged.
 */
function buildJsonOptions(
  projectId: string | undefined,
  profile: JsonExportProfileBlock | undefined,
  warnings: JsonExportWarning[] | undefined,
): BuildJsonExportOptions {
  return {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(warnings !== undefined ? { warnings } : {}),
  };
}

/** Build the content string for a single target. */
function buildContent(inputs: BuildContentInputs): string {
  const { target, pages, projectTitle, marpSource, projectId, profile, warnings } = inputs;
  switch (target) {
    case "llms-txt":
      return buildLlmsTxt(pages, projectTitle);
    case "llms-full-txt":
      return buildLlmsFullTxt(pages, projectTitle);
    case "json":
      return buildJsonExport(pages, buildJsonOptions(projectId, profile, warnings));
    case "json-ld":
      return buildJsonLd(pages);
    case "graphml":
      return buildGraphml(pages);
    case "marp":
      return buildMarp(pages, projectTitle, marpSource);
    case "okf":
      // OKF is a directory target dispatched before buildContent is called.
      throw new Error("buildContent called for okf — this is a programming error");
  }
}

/**
 * Compute the page count to report in the CLI summary. When marp is the
 * only target and --source narrows the deck, report the filtered count so
 * the summary doesn't overstate what was exported. Multi-target runs keep
 * the collected total because non-marp targets always include every page.
 */
function computeReportedPageCount(
  pages: ExportPage[],
  targets: ExportTarget[],
  marpSource: MarpSource,
): number {
  const onlyMarpTarget = targets.length === 1 && targets[0] === "marp";
  if (onlyMarpTarget && marpSource !== "all") {
    return pages.filter((p) => p.pageDirectory === marpSource).length;
  }
  return pages.length;
}

/**
 * Programmatic entry point for the export pipeline.
 * @param root - Absolute path to the project root directory.
 * @param options - Export options (optional target filter).
 * @returns Paths written and page count.
 */
export async function runExport(root: string, options: ExportOptions = {}): Promise<ExportResult> {
  // `async` so that a throw while the disk sources are built REJECTS.
  return runExportFrom(diskRunExportSources(root), root, options);
}

/** Everything {@link runExportFrom} reads and writes through. Production builds all from one root. */
export interface RunExportSources {
  pages: ExportPageSources;
  profile: ExportProfileSources;
  journal: JournalReadSources;
  /** The OKF export core's sources, for the opt-in `okf` target (which collects its pages again). */
  okf: OkfExportSources;
  /** SYNCHRONOUS: the parsed package.json at a path; THROWS when it cannot be loaded. */
  loadPackageJson(location: string): unknown;
  /** Write one export file atomically, creating its parent directories. */
  writeFile(location: string, content: string): Promise<void>;
}

/** LOCAL DISK. The export sources for the project at `root`: this module's `require` and the atomic writer. Building them does no I/O. */
function diskRunExportSources(root: string): RunExportSources {
  return {
    pages: diskExportPageSources(root), profile: diskProfileSummarySources(root), journal: diskJournalReadSources(root),
    okf: diskOkfExportSources(root),
    loadPackageJson: (location) => require(location),
    writeFile: (location, content) => atomicWrite(location, content),
  };
}

/** Run the OKF export core for the `okf` target, printing its warnings then its bundle line. */
async function exportOkfTarget(okf: OkfExportSources, root: string, out: string | undefined): Promise<string[]> {
  const { outDir, writtenPaths, warnings: okfWarnings } = await runOkfExportFrom(okf, root, { out });
  for (const w of okfWarnings) output.status("!", output.warn(w));
  output.status("+", output.success(`Exported okf bundle → ${output.source(outDir)}`));
  return writtenPaths;
}

/** Write one single-file target under `dist/exports/`, then report it. */
async function writeTarget(sources: RunExportSources, root: string, target: ExportTarget, content: string): Promise<string> {
  const outPath = path.join(root, EXPORT_DIR, TARGET_FILENAMES[target]);
  await sources.writeFile(outPath, content);
  verbose(`target ${target}: ${content.length} chars → ${outPath}`);
  output.status("+", output.success(`Exported ${target} → ${output.source(outPath)}`));
  return outPath;
}

/**
 * {@link runExport} over {@link RunExportSources}: THE ONE BODY. The projectId check
 * first; then the pages, the title, the profile block and the journal warnings; then
 * the target and marp-source checks; then each target in order.
 */
export async function runExportFrom(sources: RunExportSources, root: string, options: ExportOptions = {}): Promise<ExportResult> {
  const projectId =
    options.projectId !== undefined ? validateProjectId(options.projectId) : undefined;
  const pages = await collectExportPagesFrom(sources.pages);
  const projectTitle = resolveProjectTitleFrom(sources.loadPackageJson, root);
  const profile = await buildExportProfileBlockFrom(sources.profile);
  const warnings = await collectExportWarningsFrom(sources.journal);
  verbose(`export: ${pages.length} pages collected`);

  const targets = resolveTargets(options.target);
  const marpSource = resolveMarpSource(options.source);
  const written: string[] = [];

  for (const target of targets) {
    if (target === "okf") {
      written.push(...(await exportOkfTarget(sources.okf, root, options.out)));
      continue;
    }
    const content = buildContent({ target, pages, projectTitle, marpSource, projectId, profile, warnings });
    written.push(await writeTarget(sources, root, target, content));
  }

  return { written, pageCount: computeReportedPageCount(pages, targets, marpSource) };
}

/**
 * Resolve the list of targets to run.
 * When a specific target is given it is validated; an error is thrown for unknown values.
 * With no target, defaults to the single-file formats only ({@link DEFAULT_EXPORT_TARGETS}) —
 * OKF is opt-in via `--target okf` because it writes a directory bundle.
 */
function resolveTargets(rawTarget: string | undefined): ExportTarget[] {
  if (!rawTarget) return [...DEFAULT_EXPORT_TARGETS];

  if (!isValidTarget(rawTarget)) {
    throw new Error(
      `Unknown export target "${rawTarget}". Valid targets: ${EXPORT_TARGETS.join(", ")}`,
    );
  }

  return [rawTarget];
}

/**
 * Pure in-memory entry point — collects pages and returns the export document
 * object without writing any files or emitting console output.
 * @param root - Absolute path to the project root directory.
 * @param options - Optional export options (e.g. `projectId`).
 * @returns The JsonExportDocument object ready for programmatic consumption.
 */
export async function exportJson(
  root: string,
  options: ExportJsonOptions = {},
): Promise<JsonExportDocument> {
  // `async` so that a throw while the disk sources are built REJECTS.
  return exportJsonFrom(
    { pages: diskExportPageSources(root), profile: diskProfileSummarySources(root), journal: diskJournalReadSources(root) }, options);
}

/**
 * Everything {@link exportJsonFrom} reads: the export page sources, the profile
 * block's sources and the journal. Nothing ties the three to one project;
 * production builds all from one root.
 */
export interface ExportJsonSources {
  pages: ExportPageSources;
  profile: ExportProfileSources;
  journal: JournalReadSources;
}

/**
 * {@link exportJson} over {@link ExportJsonSources}: THE ONE BODY. One step
 * after another: the pages, the profile block, the journal warning; then the
 * document, whose `projectId` is validated last, as before.
 */
export async function exportJsonFrom(
  sources: ExportJsonSources,
  options: ExportJsonOptions = {},
): Promise<JsonExportDocument> {
  const pages = await collectExportPagesFrom(sources.pages);
  const profile = await buildExportProfileBlockFrom(sources.profile);
  const warnings = await collectExportWarningsFrom(sources.journal);
  // Reconstruct build options from ONLY the public knob so a forged `profile` or
  // `warnings` on the caller's object can never reach the document; the
  // pipeline-computed `profile`/`warnings` are the sole source of those blocks.
  const buildOptions: BuildJsonExportOptions = {
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return buildJsonExportDocument(pages, buildOptions);
}

/**
 * CLI action for `llmwiki export`.
 * @param root - Project root directory (defaults to cwd).
 * @param options - Commander-parsed options.
 */
export default async function exportCommand(
  root: string,
  options: ExportOptions,
): Promise<void> {
  output.header("Exporting wiki");
  const { written, pageCount } = await runExport(root, options);
  output.status(
    "✓",
    output.success(`Done — ${pageCount} pages exported to ${written.length} file(s).`),
  );
}
