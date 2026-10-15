/**
 * @file src/compiler/compile-access.ts
 * @description The compiler's bounded PROJECT-ACCESS SEAM for the review-mode
 * compile: every read of project content that extraction and page generation
 * make, and the one place a generated candidate goes.
 *
 * The compile used to reach these through a project root path. That fused two
 * things: what the compile needs (a source's text, an existing page, the index)
 * and where it happens to live (a directory). {@link CompileAccess} names only
 * the first. The local compile builds {@link diskCompileAccess} from its root,
 * which runs exactly the code that was inline before, so local behaviour is
 * unchanged. A host that keeps a project somewhere else supplies its own
 * implementation, and the SAME extraction, renderer, lint and policy code runs
 * over it — it does not need a directory, and it can record what was read.
 *
 * The seam is deliberately bounded to the review-mode compile. Live page
 * writes, orphan marking, link resolution, index/MOC generation and embeddings
 * still take a root and are not made portable by this interface.
 *
 * Below the seam, a local project's content and configuration reads go through
 * the legacy-compatibility read binding (`src/storage/legacy-local-reads.ts`).
 * Its compile state and proposal queue are records and stay on their stores.
 *
 * What the pending proposal queue MEANS to a compile is decided in one body,
 * {@link pendingSourceStatesFrom}, over a supplied candidate listing: the local
 * records pass the incumbent listing for their root.
 */

import path from "path";
import { loadSchemaFrom, type SchemaConfig } from "../schema/index.js";
import { loadProjectConfigFrom } from "../project/config.js";
import { reviewPolicyFromConfig } from "../review/config.js";
import type { ReviewPolicy } from "../review/policy.js";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import { CompileStateDraft } from "./compile-state-draft.js";
import { detectChangesFrom, diskSourceHashText, hashSourceFrom, type SourceHashText } from "./hasher.js";
import { readWikiPageContentOrWarnFrom, warnDroppedReadIfPresentFrom } from "./confined-wiki-read.js";
import { listLinkableTitlesFrom } from "./resolver.js";
import {
  deleteCandidateBySlug,
  listCandidates,
  writeCandidate,
  type CandidateDraft,
} from "./candidates.js";
import { checkPageBrokenCitationsFrom } from "../linter/rules.js";
import type { LintResult } from "../linter/types.js";
import { CONCEPTS_DIR, INDEX_FILE, SOURCES_DIR } from "../utils/constants.js";
import type { ReviewCandidate, SourceChange, WikiState } from "../utils/types.js";

/** A page that may be offered as a wikilink target. */
export interface ConceptTitle {
  slug: string;
  title: string;
}

/** Source hash and prompt-modifier digest held by a pending proposal for one source. */
export interface PendingSourceState {
  hash: string;
  modifiers: string;
}

/** Everything the review-mode compile reads from, or emits into, a project. */
export interface CompileAccess {
  /** The resolved schema (defaults when the project declares none). */
  loadSchema(): Promise<SchemaConfig>;
  /** The review policy from project configuration. */
  loadReviewPolicy(): Promise<ReviewPolicy>;
  /** The incremental compile state as last recorded. */
  readState(): Promise<WikiState>;
  /** Classify every selected source as new, changed, unchanged or deleted. */
  detectChanges(previous: WikiState): Promise<SourceChange[]>;
  /** SHA-256 hex of one source's text. */
  hashSource(file: string): Promise<string>;
  /** One source's full text. */
  readSource(file: string): Promise<string>;
  /** The wiki index used as extraction dedup context; empty when absent. */
  readExtractionIndex(): Promise<string>;
  /** One concept page's full content; empty when absent or dropped. */
  readConceptPage(slug: string, warnAlways?: boolean): Promise<string>;
  /** File names (`<slug>.md`) in the concepts namespace, in listing order. */
  listConceptPageFiles(): Promise<string[]>;
  /** Titles of every non-orphaned concept page. */
  listConceptTitles(): Promise<ConceptTitle[]>;
  /** Source states held by proposals that are still pending. */
  pendingSourceStates(): Promise<Map<string, PendingSourceState>>;
  /** Citations in `fullPage` whose source is missing or whose span is out of bounds. */
  checkBrokenCitations(fullPage: string, virtualPath: string): Promise<LintResult[]>;
  /** Hand one generated candidate to whoever owns proposals for this project. */
  emitCandidate(draft: CandidateDraft): Promise<ReviewCandidate>;
  /** Drop pending candidates a live write of `slug` supersedes. */
  discardCandidatesForSlug(slug: string): Promise<void>;
}

/** Read `wiki/index.md` through the confined reader, dropping an escaping link. */
async function readExtractionIndexFrom(reads: LegacyLocalReads): Promise<string> {
  const result = await reads.readConfinedFile(INDEX_FILE);
  if ("content" in result) return result.content;
  // An absent index shares the escapes-dir reason; warn only when index.md
  // physically exists (an escaping symlink or a fail-closed read).
  await warnDroppedReadIfPresentFrom(reads, INDEX_FILE, INDEX_FILE, result.dropped);
  return "";
}

/** Concept-namespace file names, or none when the directory does not exist yet. */
async function listConceptFilesFrom(reads: LegacyLocalReads): Promise<string[]> {
  try {
    return await reads.listNames(CONCEPTS_DIR);
  } catch {
    return [];
  }
}

/**
 * Source hash + modifier snapshots held inside a pending-candidate queue: THE
 * ONE BODY. Candidates are taken in listing order and a LATER candidate's entry
 * for a source replaces an earlier one's. Each snapshot carries the modifiers its
 * candidate was generated under; a candidate that recorded none (written before
 * modifiers were recorded) reads as `""`, "none selected", and one with no
 * source states contributes nothing.
 *
 * @param listCandidates - The queue's pending candidates, in listing order; takes no project root.
 */
export async function pendingSourceStatesFrom(
  listCandidates: () => Promise<readonly Pick<ReviewCandidate, "sourceStates" | "promptModifiers">[]>,
): Promise<Map<string, PendingSourceState>> {
  const states = new Map<string, PendingSourceState>();
  for (const candidate of await listCandidates()) {
    const modifiers = candidate.promptModifiers ?? "";
    for (const [source, entry] of Object.entries(candidate.sourceStates ?? {})) {
      states.set(source, { hash: entry.hash, modifiers });
    }
  }
  return states;
}

/**
 * The part of {@link CompileAccess} that is a project's RECORDS rather than its
 * content: the compile state and the proposal queue. These still live in the
 * legacy stores and are not read through {@link LegacyLocalReads}.
 */
export type CompileRecords = Pick<
  CompileAccess,
  "readState" | "pendingSourceStates" | "emitCandidate" | "discardCandidatesForSlug"
>;

/**
 * Compose the seam for an ordinary local project: every content and
 * configuration read goes through `reads`, and the records come from `records`.
 * {@link diskCompileAccess} is exactly this over the project's directory.
 *
 * @param reads - The project's legacy-compatibility read binding.
 * @param records - Its compile state and proposal queue.
 * @param hashText - Where sources are read for hashing; by default `reads`.
 */
export function localCompileAccess(
  reads: LegacyLocalReads,
  records: CompileRecords,
  hashText: SourceHashText = (relPath) => reads.readText(relPath),
): CompileAccess {
  return {
    ...records,
    loadSchema: () => loadSchemaFrom(reads),
    loadReviewPolicy: async () => reviewPolicyFromConfig(await loadProjectConfigFrom(reads)),
    detectChanges: (previous) => detectChangesFrom(reads, previous, hashText),
    hashSource: (file) => hashSourceFrom(hashText, file),
    readSource: (file) => reads.readText(path.join(SOURCES_DIR, file)),
    readExtractionIndex: () => readExtractionIndexFrom(reads),
    readConceptPage: (slug, warnAlways) => readWikiPageContentOrWarnFrom(reads, CONCEPTS_DIR, slug, warnAlways),
    listConceptPageFiles: () => listConceptFilesFrom(reads),
    listConceptTitles: () => listLinkableTitlesFrom(reads),
    checkBrokenCitations: (fullPage, virtualPath) => checkPageBrokenCitationsFrom(reads, fullPage, virtualPath),
  };
}

/** The compile state and proposal queue of the local project at `root`, on the legacy stores. */
function diskCompileRecords(root: string): CompileRecords {
  return {
    readState: async () => (await CompileStateDraft.load(root)).read(),
    pendingSourceStates: () => pendingSourceStatesFrom(() => listCandidates(root)),
    emitCandidate: (draft) => writeCandidate(root, draft),
    discardCandidatesForSlug: async (slug) => { await deleteCandidateBySlug(root, slug); },
  };
}

/**
 * The local-directory implementation: each method runs the code the compile ran
 * inline before the seam existed, so a local compile behaves exactly as it did.
 * Sources are hashed like `hashFile`: opened without blocking, and a named
 * pipe, directory or device rejects with `NotRegularFileError`.
 *
 * @param root - Absolute project root directory.
 * @returns Access backed by the project's files and legacy candidate store.
 */
export function diskCompileAccess(root: string): CompileAccess {
  return localCompileAccess(diskLocalReads(root), diskCompileRecords(root), diskSourceHashText(root));
}

/** A project given either as its seam or, for local callers, as a root directory. */
export type CompileProject = string | CompileAccess;

/** The seam for `project`: itself, or the local-directory access for a root path. */
export function asCompileAccess(project: CompileProject): CompileAccess {
  return typeof project === "string" ? diskCompileAccess(project) : project;
}
