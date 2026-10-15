/**
 * Provenance helpers for `llmwiki context`.
 *
 * Slice 4 ships two related pieces of work:
 *   1. Flatten `ViewerPage.citations` (`ClaimCitation[]`, each with one
 *      or more `SourceSpan` entries) into the documented
 *      `ContextPrimary.citations[]` shape: one object per span,
 *      `file`/`start`/`end` lifted from `span.lines` when present,
 *      paragraph-only citations omit `start`/`end`, de-duped by
 *      `(file, start, end)`, preserved in first-seen document order
 *      (plan §Provenance And Source Windows).
 *   2. Materialize bounded `ContextSourceWindow[]` for `--include-sources`
 *      by reading short line ranges out of `sources/`. Path-confined:
 *      traversal, absolute paths, and symlink escapes are rejected.
 *      Only claim-level spans (`lines` populated) become windows;
 *      paragraph-only citations are intentionally skipped because the
 *      caller asked for SPECIFIC line context, not whole files.
 *
 * Citation flattening is the inner contract for `primary[].citations`;
 * source-window materialization is the outer guard rail for
 * `--include-sources` per-pack and per-window caps.
 *
 * Disk access: {@link materializeSourceWindows} runs the one body,
 * {@link materializeSourceWindowsFrom}, over private local-disk
 * {@link SourceWindowSources}. FOR EACH CITED WINDOW, IN THIS ORDER: the
 * sources are opened; then the body applies its own rules to the key as
 * written; then the file is located; then read once. So a refused key costs
 * exactly the open. Nothing is kept from one window to the next.
 */

import path from "path";
import { locationRealPath, readLocationText } from "../storage/disk-locations.js";
import type { ClaimCitation, SourceSpan } from "../utils/types.js";
import { SOURCES_DIR } from "../utils/constants.js";

/** Per-pack ceiling on emitted source windows. */
export const MAX_SOURCE_WINDOWS = 20;
/** Per-window ceiling on lines read out of a source file. */
export const MAX_LINES_PER_WINDOW = 30;
/**
 * Visible ASCII delimiter for {@link citationKey} dedup tuples. Plain
 * spaces and dashes can legally appear inside `file` names so the key
 * must use a separator that filenames cannot contain. `' <#> '` is
 * unambiguous, ASCII-clean (no control bytes — graph.ts had the same
 * class of bug with NUL delimiters), and obvious in diagnostic output.
 */
const CITATION_KEY_SEPARATOR = " <#> ";

/**
 * Flat citation shape consumed by `ContextPrimary.citations[]` AND by
 * the JSON export's `ExportPage.citations[]`. Exported so both
 * surfaces share one normalized shape rather than drifting — consumers
 * can reuse the same flattening rule across `llmwiki context` and
 * `llmwiki export`.
 */
export interface FlatCitation {
  file: string;
  start?: number;
  end?: number;
}

/**
 * Materialized source window consumed by
 * `ContextPrimary.sourceWindows[]`. Always carries explicit line
 * numbers — Slice 4 only ever materializes claim-level spans, so
 * `start`/`end` are mandatory.
 */
interface SourceWindow {
  file: string;
  start: number;
  end: number;
  text: string;
}

/**
 * Flatten a page's `ClaimCitation[]` into the JSON-shape citation list.
 * Multi-source markers (`^[a.md, b.md]`) produce one object per span.
 * Paragraph-only citations stay (with no `start`/`end`).
 */
export function flattenCitations(citations: ClaimCitation[]): FlatCitation[] {
  const out: FlatCitation[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    for (const span of citation.spans) {
      const flat = toFlatCitation(span);
      const key = citationKey(flat);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(flat);
    }
  }
  return out;
}

/** Lift one `SourceSpan` into the public flat shape. */
function toFlatCitation(span: SourceSpan): FlatCitation {
  if (!span.lines) return { file: span.file };
  return { file: span.file, start: span.lines.start, end: span.lines.end };
}

/** Deduplication key. Uses `-` for missing line ranges; safe because lines are positive integers. */
function citationKey(citation: FlatCitation): string {
  const start = citation.start ?? "-";
  const end = citation.end ?? "-";
  return [citation.file, String(start), String(end)].join(CITATION_KEY_SEPARATOR);
}

/**
 * Per-pack source-window budget accumulator passed into
 * {@link materializeSourceWindows}. The orchestrator owns one
 * instance and shares it across all primary pages so the global
 * 20-window ceiling is enforced even when many pages each carry many
 * citations.
 */
interface SourceWindowBudget {
  remaining: number;
}

/** Create a fresh budget seeded with the documented per-pack cap. */
export function createSourceWindowBudget(): SourceWindowBudget {
  return { remaining: MAX_SOURCE_WINDOWS };
}

/**
 * Materialize source windows for one page's citations. Returns an
 * empty array when the citation list is empty, when no entries carry
 * line ranges (paragraph-only), or when the budget is exhausted.
 */
export async function materializeSourceWindows(
  root: string,
  citations: FlatCitation[],
  budget: SourceWindowBudget,
): Promise<SourceWindow[]> {
  return materializeSourceWindowsFrom(diskSourceWindowSources(root), citations, budget);
}

/**
 * One project's sources while ONE window is read. OWNED BY THE SOURCE-WINDOW
 * READER, and deliberately not freshness's `SourceLocations`: this one resolves
 * against the real sources directory, has no existence test, and is never asked
 * about an absolute key.
 */
export interface SourceWindowLocations {
  /** A token for a key the reader has already accepted, or `null` when it is not inside the sources. Never rejects. */
  locateSource(file: string): Promise<string | null>;
  /** The whole text behind a token, decoded as UTF-8. REJECTS with the raw error. */
  readText(source: string): Promise<string>;
}

/** Where a project's sources are found. A narrow seam with one disk implementation; not `ProjectStore`, not hosted. */
export interface SourceWindowSources {
  /** Called ONCE PER CITED WINDOW, before anything else. `null` when there are no sources to open. Never rejects. */
  openSources(): Promise<SourceWindowLocations | null>;
}

/** {@link materializeSourceWindows} over {@link SourceWindowSources}: THE ONE BODY. The context pack's bound reads (`contextPackReadsOver`) call it. */
export async function materializeSourceWindowsFrom(
  sources: SourceWindowSources,
  citations: FlatCitation[],
  budget: SourceWindowBudget,
): Promise<SourceWindow[]> {
  if (budget.remaining <= 0) return [];
  const windows: SourceWindow[] = [];
  for (const citation of citations) {
    if (budget.remaining <= 0) break;
    if (citation.start === undefined || citation.end === undefined) continue;
    const window = await readSourceWindow(sources, citation);
    if (!window) continue;
    windows.push(window);
    budget.remaining -= 1;
  }
  return windows;
}

/**
 * Read one source window or return null when it is refused. ORDER: open the
 * sources; refuse the key as written; locate; read. A refused key has cost
 * exactly the open, as it always did.
 */
async function readSourceWindow(
  sources: SourceWindowSources,
  citation: FlatCitation,
): Promise<SourceWindow | null> {
  if (citation.start === undefined || citation.end === undefined) return null;
  const opened = await sources.openSources();
  if (!opened) return null;
  if (!isAcceptableKey(citation.file)) return null;
  const source = await opened.locateSource(citation.file);
  if (!source) return null;
  return readClampedWindow(opened, source, citation);
}

/** LOCAL DISK. The sources of the project at `root`. Opening resolves `sources/` afresh EVERY time; nothing is cached. */
function diskSourceWindowSources(root: string): SourceWindowSources {
  return {
    openSources: async () => {
      const sourcesRoot = await resolveSourcesRoot(root);
      if (!sourcesRoot) return null;
      return {
        locateSource: (file) => locateUnderSources(sourcesRoot, file),
        readText: (source) => readLocationText(source),
      };
    },
  };
}

/**
 * Resolve the canonical `sources/` directory. Returns null when the
 * directory doesn't exist; otherwise returns the realpath so
 * `isInside` checks against canonical paths on platforms with
 * symlinked parents (macOS `/var` → `/private/var`, Linux container
 * bind mounts, etc.). Path confinement still rejects files whose
 * realpath escapes this canonical root, so a symlinked sources/ tree
 * remains safe.
 */
async function resolveSourcesRoot(root: string): Promise<string | null> {
  const candidate = path.join(root, SOURCES_DIR);
  try {
    return await locationRealPath(candidate);
  } catch {
    return null;
  }
}

/**
 * The reader's OWN rules on a citation key, applied to the key AS WRITTEN and
 * before anything is located. Rejects:
 *   - an empty key
 *   - absolute paths (`/etc/passwd`)
 *   - ANY `..` segment, even one that would normalize back inside
 *     sources/ (`nested/../paper.md` is rejected — the spec says
 *     "reject parent traversal", and "looks safe after normalization"
 *     is still traversal a reviewer must be able to spot in the raw
 *     citation marker)
 */
function isAcceptableKey(file: string): boolean {
  if (file.length === 0) return false;
  if (path.isAbsolute(file)) return false;
  return !containsParentSegment(file);
}

/**
 * LOCAL DISK. Resolve an accepted key under the real `sourcesRoot`, answering
 * `null` for a path whose realpath escapes it (symlinks pointing outside
 * `sources/`) or cannot be resolved.
 */
async function locateUnderSources(sourcesRoot: string, file: string): Promise<string | null> {
  const joined = path.join(sourcesRoot, file);
  const resolved = path.resolve(joined);
  // Defense in depth: even after the segment guard, if the resolved
  // path escapes sources/ (e.g., a Windows drive-letter trick or a
  // separator we did not recognize) refuse it.
  if (!isInside(sourcesRoot, resolved)) return null;
  try {
    const realPath = await locationRealPath(resolved);
    if (!isInside(sourcesRoot, realPath)) return null;
    return realPath;
  } catch {
    return null;
  }
}

/**
 * True when any segment of `file` is literally `..`. Splits on BOTH
 * `/` and the platform separator so a malicious `nested\..\paper.md`
 * on Linux (where `\` is a legal filename char) is still rejected when
 * served to a Windows agent reading the same context pack.
 */
function containsParentSegment(file: string): boolean {
  const segments = file.split(/[/\\]/);
  return segments.some((segment) => segment === "..");
}

/**
 * True when `candidate` is `parent` itself or a descendant of it.
 * Adds a path separator suffix to `parent` before the prefix check so
 * `/parent` does not incorrectly contain `/parentish`.
 */
function isInside(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  const normalizedParent = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return candidate.startsWith(normalizedParent);
}

/**
 * Read the requested line window, clamping to a maximum length so a
 * runaway citation cannot pull hundreds of lines into the pack. Both
 * `start` and `end` are 1-indexed inclusive (matching the
 * `SourceSpan` convention).
 */
async function readClampedWindow(
  opened: SourceWindowLocations,
  source: string,
  citation: FlatCitation,
): Promise<SourceWindow | null> {
  if (citation.start === undefined || citation.end === undefined) return null;
  let raw: string;
  try {
    raw = await opened.readText(source);
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  const startIndex = Math.max(0, citation.start - 1);
  const inclusiveEnd = Math.min(lines.length, citation.end);
  if (startIndex >= inclusiveEnd) return null;
  const clampedEnd = Math.min(inclusiveEnd, startIndex + MAX_LINES_PER_WINDOW);
  const text = lines.slice(startIndex, clampedEnd).join("\n");
  return { file: citation.file, start: citation.start, end: startIndex + (clampedEnd - startIndex), text };
}
