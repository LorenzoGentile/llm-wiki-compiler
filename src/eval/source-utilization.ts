/**
 * Source utilization evaluator for the llmwiki eval harness.
 *
 * Measures whether every ingested source has been compiled into the wiki.
 * An uncited source means its concepts were either not extracted or not
 * linked to any generated page — a silent failure mode that no existing
 * lint rule catches.
 *
 * Algorithm: enumerate on-disk source files, resolve each through
 * resolveSourceFile to a canonical realpath, then cross-reference with
 * citation targets resolved the same way. Both sides use the same confined
 * resolver so symlinks and path differences are handled consistently.
 * When no valid sources remain after filtering, utilizationRate is null
 * ("not measured").
 *
 * The measure has ONE body, {@link evaluateSourceUtilizationFrom}, over
 * {@link SourceUtilizationSources}. It names no project root.
 * `evaluateSourceUtilization` builds the local-disk sources and delegates.
 */

import path from "path";
import { diskLocalReads, locationKindNoFollow } from "../storage/disk-local-reads.js";
import type { LegacyLocalReads, LocalEntryKind } from "../storage/legacy-local-reads.js";
import { collectAllPagesFrom, diskLintPageSources, type LintPageSources } from "../linter/rules-shared.js";
import { parseFrontmatter, extractClaimCitations, splitProseParagraphs } from "../utils/markdown.js";
import { scanSelectedSourcesFrom } from "../sources/scan.js";
import { diskSourceFileLocations, resolveSourceFileFrom, type SourceFileLocations } from "./source-path.js";
import type { SourceUtilizationResult } from "./types.js";

/**
 * Everything the measure asks of the project, in the order it asks. Each member
 * is an existing seam or one raw lookup; the inventory rules, the warnings,
 * the early return and the counting stay in this module.
 */
export interface SourceUtilizationSources {
  /** The source scan's reads: the source selection's configuration, then the sources directory's listings. */
  reads: LegacyLocalReads;
  /** The source resolver's locations: for every inventory file first, then for every file a page cites. */
  locations: SourceFileLocations;
  /**
   * What is at a location, WITHOUT following a final link. Asked once per
   * inventory file the resolver refused, only to word its warning. Returns a
   * promise that rejects raw when nothing is there; a rejection is worded as
   * the generic reason.
   */
  kindNoFollow(location: string): Promise<LocalEntryKind>;
  /** The page collection's sources. Not asked when no source is in the inventory. */
  pages: LintPageSources;
}

function collectRawCitedFiles(body: string): Set<string> {
  const files = new Set<string>();
  for (const para of splitProseParagraphs(body)) {
    const citations = extractClaimCitations(para);
    for (const { spans } of citations) {
      for (const span of spans) files.add(span.file);
    }
  }
  return files;
}

function pageSlug(filePath: string): string {
  const dir = path.basename(path.dirname(filePath));
  return dir + "/" + path.basename(filePath, ".md");
}

interface InventoryResult {
  /** Names of source files that passed confinement (the valid inventory). */
  validFiles: string[];
  /** Map from valid source filename to its canonical realpath. */
  fileToReal: Map<string, string>;
  /** Non-fatal issues (e.g. out-of-tree symlinks excluded). */
  warnings: string[];
}

/**
 * Build the filtered source inventory by resolving every on-disk source
 * through resolveSourceFile — the same confined resolver used for citation
 * targets. Files that fail resolution are excluded from the inventory and
 * reported as warnings. The caller MUST derive totalSources, perSource,
 * and cited/uncited counts from the returned validFiles, never from the
 * raw readdir() result.
 */
/**
 * Explain why a source file was excluded from the inventory. The common case is
 * a symlink whose target is missing or resolves outside the sources tree;
 * everything else (bad path, unreadable) collapses to a generic reason.
 */
async function exclusionReason(sources: SourceUtilizationSources, file: string): Promise<string> {
  const kind = await sources.kindNoFollow(path.join(sources.locations.sourcesDir, file)).catch(() => null);
  return kind === "link"
    ? "symlink target missing or outside sources/ (excluded)"
    : "could not be resolved (excluded)";
}

async function resolveSourceInventory(
  sources: SourceUtilizationSources,
  sourceFiles: string[],
): Promise<InventoryResult> {
  const fileToReal = new Map<string, string>();
  const validFiles: string[] = [];
  const warnings: string[] = [];
  for (const f of sourceFiles) {
    const resolved = await resolveSourceFileFrom(sources.locations, f);
    if (resolved === null) {
      // Filename first so the actionable detail survives any display
      // truncation; distinguish the common symlink case from other failures.
      warnings.push(`${f}: ${await exclusionReason(sources, f)}`);
    } else {
      fileToReal.set(f, resolved);
      validFiles.push(f);
    }
  }
  return { validFiles, fileToReal, warnings };
}

async function collectCitedRealpaths(
  locations: SourceFileLocations,
  pages: Array<{ filePath: string; content: string }>,
): Promise<Map<string, Set<string>>> {
  const citedRealToPages = new Map<string, Set<string>>();
  for (const { filePath, content } of pages) {
    const { body } = parseFrontmatter(content);
    const slug = pageSlug(filePath);
    for (const rawFile of collectRawCitedFiles(body)) {
      const resolved = await resolveSourceFileFrom(locations, rawFile);
      if (resolved === null) continue;
      const entry = citedRealToPages.get(resolved);
      if (entry) entry.add(slug);
      else citedRealToPages.set(resolved, new Set([slug]));
    }
  }
  return citedRealToPages;
}

function buildPerSource(
  validFiles: string[],
  fileToReal: Map<string, string>,
  citedRealToPages: Map<string, Set<string>>,
): SourceUtilizationResult["perSource"] {
  const records = validFiles.map((sourceFile) => {
    const real = fileToReal.get(sourceFile);
    const pageSlugs = real ? citedRealToPages.get(real) : undefined;
    return {
      sourceFile,
      citingPageCount: pageSlugs ? pageSlugs.size : 0,
      citingPages: pageSlugs ? [...pageSlugs].sort() : ([] as string[]),
    };
  });
  records.sort((a, b) => {
    if (a.citingPageCount !== b.citingPageCount) return b.citingPageCount - a.citingPageCount;
    return a.sourceFile.localeCompare(b.sourceFile);
  });
  return records;
}

export async function evaluateSourceUtilization(
  root: string,
): Promise<SourceUtilizationResult> {
  return evaluateSourceUtilizationFrom({
    reads: diskLocalReads(root), locations: diskSourceFileLocations(root),
    kindNoFollow: locationKindNoFollow, pages: diskLintPageSources(root),
  });
}

/**
 * {@link evaluateSourceUtilization} over {@link SourceUtilizationSources}: THE
 * ONE BODY. The scan, then the inventory, then (only when a source remains) the
 * pages and their citations.
 *
 * @param sources - The scan's reads, the resolver's locations, the kind lookup and the pages.
 * @returns The counts, the rate or null, each source's citing pages, and the warnings in the order they arose.
 */
export async function evaluateSourceUtilizationFrom(sources: SourceUtilizationSources): Promise<SourceUtilizationResult> {
  const scan = await scanSelectedSourcesFrom(sources.reads);
  const rawFiles = scan.files.filter((file) => file.endsWith(".md"));

  // Build the filtered inventory — all downstream counts must use this,
  // never rawFiles.length.
  const { validFiles, fileToReal, warnings } = await resolveSourceInventory(sources, rawFiles);
  warnings.push(...scan.symlinks.map((file) => `${file}: symlink source excluded`));
  const totalSources = validFiles.length;

  if (totalSources === 0) {
    // Preserve diagnostics even when every discovered entry was an alias.
    return {
      totalSources: 0, citedSources: 0, uncitedSources: 0,
      utilizationRate: null, perSource: [], warnings,
    };
  }

  const pages = await collectAllPagesFrom(sources.pages);
  const citedRealToPages = await collectCitedRealpaths(sources.locations, pages);
  const perSource = buildPerSource(validFiles, fileToReal, citedRealToPages);

  const citedCount = perSource.filter((e) => e.citingPageCount > 0).length;
  return {
    totalSources,
    citedSources: citedCount,
    uncitedSources: totalSources - citedCount,
    utilizationRate: Math.round((citedCount / totalSources) * 1000) / 1000,
    perSource,
    warnings,
  };
}
