/**
 * @file src/context/build-reads.ts
 * @description The six reads `buildContextPackFrom` makes, and the two ways
 * they are answered.
 *
 * {@link diskContextPackReads} is the local root form. Each member calls the
 * ROOT-taking function `buildContextPack` always called, so a module mock or spy
 * of any of them (the context suites mock `retrieveSemanticChunks`) still
 * intercepts.
 *
 * {@link contextPackReadsOver} is THE ONE BOUND COMPOSITION. Each member runs its
 * reader's existing one body over its own seam when asked, never earlier.
 * Building either does no I/O. The profile and the journal are read through
 * the snapshot's OWN bindings, so they are the bindings the snapshot already
 * reads, not second copies.
 *
 * WHAT IT IS NOT. NOTHING TIES THE SEAMS TO ONE PROJECT, and nothing makes two
 * reads agree. This is not `ProjectStore`, not a hosted or access-control
 * contract, and it is in no package index.
 */

import { buildViewerSnapshot, buildViewerSnapshotFrom, type ViewerSnapshotSources } from "../viewer/snapshot.js";
import { loadNonDefaultProfile, loadNonDefaultProfileFrom } from "../profile/block.js";
import type { LoadedProfile } from "../profile/types.js";
import { collectProjectState, collectProjectStateFrom, type ProjectState } from "../project/state.js";
import type { ProjectStateSources } from "../project/state-sources.js";
import { retrieveSemanticChunks, retrieveSemanticChunksFrom, type LazyContextLoads, type SemanticRetrievalOutcome } from "./retrieval.js";
import { materializeSourceWindows, materializeSourceWindowsFrom, type FlatCitation, type SourceWindowSources } from "./provenance.js";
import { journalHealthWarning, journalHealthWarningFrom, type JournalWarning } from "../trust/journal-health-warning.js";
import type { LivePageReads } from "../utils/page-registry.js";
import type { ViewerSnapshot } from "../viewer/types.js";

/** The pack's shared source-window budget, as the window reader takes it. */
type SourceWindowBudget = Parameters<typeof materializeSourceWindows>[2];

/** The reads one context pack makes, in the order the body makes them. No member takes a project root. */
export interface ContextPackReads {
  /** The frozen viewer snapshot. */
  snapshot(): Promise<ViewerSnapshot>;
  /** The active non-default profile, or `undefined` for the built-in default. A rejection rejects the pack. */
  nonDefaultProfile(): Promise<LoadedProfile | undefined>;
  /** The project state the recommendation and warnings read. */
  projectState(): Promise<ProjectState>;
  /** Best-effort semantic retrieval for the ranking prompt. */
  semantic(prompt: string, topChunks: number): Promise<SemanticRetrievalOutcome>;
  /** One primary page's source windows, under the pack's shared budget. Asked once per primary, serially. */
  sourceWindows(citations: FlatCitation[], budget: SourceWindowBudget): ReturnType<typeof materializeSourceWindows>;
  /** The compile journal's read-surface warning, or `null` when it is ok. */
  journalWarning(): Promise<JournalWarning | null>;
}

/** LOCAL DISK. The root-taking readers `buildContextPack` always called, each called when asked. */
export function diskContextPackReads(root: string): ContextPackReads {
  return {
    snapshot: () => buildViewerSnapshot(root),
    nonDefaultProfile: () => loadNonDefaultProfile(root),
    projectState: () => collectProjectState(root),
    semantic: (prompt, topChunks) => retrieveSemanticChunks(root, prompt, topChunks),
    sourceWindows: (citations, budget) => materializeSourceWindows(root, citations, budget),
    journalWarning: () => journalHealthWarning(root),
  };
}

/** The raw seams of the context readers: each the existing seam of the reader that answers it. */
export interface ContextPackSources {
  /** The snapshot's sources; its `profile` and `journal` bindings also answer those two reads. */
  snapshot: ViewerSnapshotSources;
  /** The project state's sources. */
  state: ProjectStateSources;
  /** Where semantic retrieval reads live pages. */
  pages: LivePageReads;
  /** The semantic step's two lazy loads. */
  loads: LazyContextLoads;
  /** Where cited source windows are read. */
  windows: SourceWindowSources;
}

/** The context reads over {@link ContextPackSources}: THE ONE BOUND COMPOSITION. */
export function contextPackReadsOver(sources: ContextPackSources): ContextPackReads {
  return {
    snapshot: () => buildViewerSnapshotFrom(sources.snapshot),
    nonDefaultProfile: () => loadNonDefaultProfileFrom(sources.snapshot.bindings.profile),
    projectState: () => collectProjectStateFrom(sources.state),
    semantic: (prompt, topChunks) => retrieveSemanticChunksFrom(sources.pages, sources.loads, prompt, topChunks),
    sourceWindows: (citations, budget) => materializeSourceWindowsFrom(sources.windows, citations, budget),
    journalWarning: () => journalHealthWarningFrom(sources.snapshot.bindings.journal),
  };
}
