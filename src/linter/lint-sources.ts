/**
 * @file src/linter/lint-sources.ts
 * @description Everything one lint run asks of a project, as the existing
 * seams of the readers and rules the coordinator runs, and the local-disk
 * wiring of all of them from one project root.
 *
 * The coordinator in `index.ts` takes a {@link LintSources} and no root. Each
 * member is a seam some reader or rule already owned; none is new here and
 * none carries a finding. Nothing ties the members to one project: production
 * builds all of them from one root with {@link diskLintSources}.
 *
 * DISPLAY PATHS ARE NOT I/O ROOTS. Two members carry a path token used only to
 * report where something is: `pages.locate` (the path a page is reported
 * under) and `profile.activeProduct.root` (the origin of `loadedFrom`). On
 * local disk both come from the project root, and the disk members also read
 * under that root, so this module does not make the lint run root-free on
 * disk; it makes the coordinator's BODY root-free.
 */

import { diskSourceFreshnessSources, type SourceFreshnessSources } from "../freshness/index.js";
import { diskProfileLintSources, type ProfileLintSources } from "../profile/lint.js";
import { diskEffectiveProfileSources, type EffectiveProfileSources } from "../profile/load.js";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";
import { diskLocalRecords } from "../storage/disk-local-records.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import type { LegacyLocalRecords } from "../storage/legacy-local-records.js";
import { diskJournalReadSources, type JournalReadSources } from "../trust/journal-classify.js";
import { diskEmbeddingMarkerReads, type EmbeddingMarkerReads } from "../utils/pending-embeddings.js";
import { diskWorkflowStatusSources, type WorkflowStatusSources } from "../workflow-history/status-read.js";
import type { CitedSourceReads } from "./rules-citations.js";
import { diskLintPageSources, type LintPageSources } from "./rules-shared.js";

/** What one lint run reads through, in the order the coordinator first asks each. */
export interface LintSources {
  /** The schema file, read FIRST. */
  schema: LegacyLocalReads;
  /** The compile state record, read second, for the freshness snapshot. */
  state: LegacyLocalRecords;
  /** The sources that state names, hashed once for the snapshot. */
  sourceFreshness: SourceFreshnessSources;
  /** The page collection. Every page rule walks it separately, at its own time. */
  pages: LintPageSources;
  /** The pending candidate records, for the broken-wikilink rule only. */
  candidates: LegacyLocalRecordDirs;
  /** The cited sources, for the broken-citation rule only. */
  cited: CitedSourceReads;
  /** The journal, for the journal-health rule. */
  journal: JournalReadSources;
  /** The embedding markers, for the pending-embeddings rule. */
  embeddings: EmbeddingMarkerReads;
  /** The workflow-run rule's own sources. It loads the effective profile and each run's authority through THESE, by itself. */
  workflows: WorkflowStatusSources;
  /** The effective profile, loaded LAST, for the profile appendix. Not shared with the workflow-run rule. */
  profile: EffectiveProfileSources;
  /** The profile checks' sources. Asked only under a non-default profile. */
  entities: ProfileLintSources;
}

/**
 * LOCAL DISK. The lint sources for the project at `root`. Building them does
 * no I/O and nothing is remembered between calls. Each member is the builder
 * its reader or rule used before, when each built its own per call. In no
 * package index.
 */
export function diskLintSources(root: string): LintSources {
  const reads = diskLocalReads(root);
  return {
    schema: reads,
    state: diskLocalRecords(root),
    sourceFreshness: diskSourceFreshnessSources(root),
    pages: diskLintPageSources(root),
    candidates: diskLocalRecordDirs(root),
    cited: reads,
    journal: diskJournalReadSources(root),
    embeddings: diskEmbeddingMarkerReads(root),
    workflows: diskWorkflowStatusSources(root),
    profile: diskEffectiveProfileSources(root),
    entities: diskProfileLintSources(root),
  };
}
