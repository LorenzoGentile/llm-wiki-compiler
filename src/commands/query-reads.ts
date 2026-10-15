/**
 * @file src/commands/query-reads.ts
 * @description The six steps `generateAnswerFrom` takes outside the answer LLM,
 * and the two ways they are answered.
 *
 * {@link diskQueryAnswerReads} is the local root form. Each member calls the
 * ROOT-taking function `generateAnswer` always called, so the module mocks and
 * spies the query suites use (`selectRelevantPages`, `appendLog`, the
 * `fs/promises` tape) still intercept.
 *
 * {@link queryAnswerReadsOver} is THE ONE BOUND COMPOSITION. Every step runs its
 * existing one body over its own seam when asked: the index presence look, the
 * page selection over host-loaded inputs (profile, then embedding store, then
 * journal, the root order), hydration under the profile's namespace
 * directories, the answer-citation index and its classification inside the same
 * recovery boundary, publication (`maybeSaveQueryPageFrom` over
 * `queryPublicationStepsOver`, with the HOST's mutation lock), and the
 * activity-log append. Building either does no I/O. Publication is asked on
 * EVERY grounded answer, `save: false` included (it answers `{}` itself then).
 *
 * WHAT IT IS NOT. NOTHING TIES THE SEAMS TO ONE PROJECT. This is not
 * `ProjectStore`, not a hosted or access-control contract, and it is in no
 * package index. The answer LLM is not a storage read and stays in the body.
 */

import path from "path";
import { collectAnswerCitationIndexFrom, type AnswerCitationSources } from "../citations/answer-index.js";
import { classifyAnswerCitations } from "../citations/answer-report.js";
import { loadProfileFrom, type EffectiveProfileSources } from "../profile/load.js";
import { loadSelectedRefRecords, type RetrievalOptions, type SelectedPageRef } from "../search/retrieval.js";
import { locationExistsSync } from "../storage/disk-locations.js";
import { journalHealthWarningFrom } from "../trust/journal-health-warning.js";
import type { JournalReadSources } from "../trust/journal-classify.js";
import { appendLog, appendLogWith, type AppendProjectText } from "../utils/activity-log.js";
import { INDEX_FILE } from "../utils/constants.js";
import type { EmbeddingLoadOutcome } from "../utils/embeddings-load.js";
import { buildNamespaceDirs, loadPageRecordPairsByPageIdFrom, type LivePageReads, type PageRecordWithId } from "../utils/page-registry.js";
import type { QueryResult } from "../utils/types.js";
import { reportQueryAnswerCitations, reportQueryAnswerCitationsWith } from "./query-citation-report.js";
import { maybeSaveQueryPage, maybeSaveQueryPageFrom, queryPublicationStepsOver, type QueryPublicationSources } from "./query-publication.js";
import { selectRelevantPages, selectRelevantPagesFrom, type SelectedPages } from "./query-selection.js";

/** What one answered query asks publication: the publication options without the root. */
type QueryPublicationRequest = Omit<Parameters<typeof maybeSaveQueryPage>[0], "root">;

/** The steps one answer takes outside the LLM, in the order the body takes them. No member takes a project root. */
export interface QueryAnswerReads {
  /** Whether `wiki/index.md` is there (following links). Asked first. */
  indexPresent(): Promise<boolean>;
  /** The page selection for the question, narrowed to `pageScope`. */
  select(question: string, debug: boolean, pageScope: readonly string[] | undefined, options: RetrievalOptions): Promise<SelectedPages>;
  /** The selected refs' live records, each with its qualified id; a ref that does not hydrate is dropped. */
  hydrate(refs: SelectedPageRef[]): Promise<PageRecordWithId[]>;
  /** The advisory answer-citation report for the canonical body; an unavailable snapshot omits the field. */
  answerCitations(body: string): Promise<Pick<QueryResult, "answerCitations">>;
  /** Publication of the answer under the mutation lock: the profile gate, fresh validation, then stage or save. */
  publish(request: QueryPublicationRequest): ReturnType<typeof maybeSaveQueryPage>;
  /** The activity-log entry; a failure is a warning, never a throw. */
  log(question: string, details: string[]): Promise<void>;
}

/** LOCAL DISK. The root-taking steps `generateAnswer` always called, each called when asked. */
export function diskQueryAnswerReads(root: string): QueryAnswerReads {
  return {
    indexPresent: async () => locationExistsSync(path.join(root, INDEX_FILE)),
    select: (question, debug, pageScope, options) => selectRelevantPages(root, question, debug, pageScope, options),
    hydrate: (refs) => loadSelectedRefRecords(root, refs),
    answerCitations: (body) => reportQueryAnswerCitations(root, body),
    publish: (request) => maybeSaveQueryPage({ root, ...request }),
    log: (question, details) => appendLog(root, "query", question, { details }),
  };
}

/** The raw seams of the query steps: each the existing seam of the reader that answers it. */
export interface QueryAnswerSources {
  /** Live pages: selection, hydration and the index presence look. */
  pages: LivePageReads;
  /** The effective profile, loaded for selection and again for hydration, as the root route does. */
  profile: EffectiveProfileSources;
  /** The search-surface embedding-store load, a host function as in `LazyContextLoads`. */
  embeddings(): Promise<EmbeddingLoadOutcome>;
  /** The compile journal, for the selection's warning. */
  journal: JournalReadSources;
  /** The answer-citation index's project. */
  citations: AnswerCitationSources;
  /** Where the activity log is appended. */
  appendText: AppendProjectText;
  /** Publication's seams, the HOST's mutation lock included. */
  publication: QueryPublicationSources;
}

/** The query steps over {@link QueryAnswerSources}: THE ONE BOUND COMPOSITION. */
export function queryAnswerReadsOver(sources: QueryAnswerSources): QueryAnswerReads {
  return {
    indexPresent: () => sources.pages.reads.exists(INDEX_FILE),
    select: async (question, debug, pageScope, options) => {
      const profile = await loadProfileFrom(sources.profile);
      const embeddings = await sources.embeddings();
      const journalWarning = await journalHealthWarningFrom(sources.journal);
      return selectRelevantPagesFrom(sources.pages, { profile, embeddings, journalWarning }, question, debug, pageScope, options);
    },
    hydrate: async (refs) => {
      const profile = await loadProfileFrom(sources.profile);
      return loadPageRecordPairsByPageIdFrom(sources.pages.reads, refs.map((ref) => ref.pageId), buildNamespaceDirs(profile.profile));
    },
    answerCitations: (body) => reportQueryAnswerCitationsWith(async () => classifyAnswerCitations(body, await collectAnswerCitationIndexFrom(sources.citations))),
    publish: (request) => maybeSaveQueryPageFrom(queryPublicationStepsOver(sources.publication), request),
    log: (question, details) => appendLogWith(sources.appendText, "query", question, { details }),
  };
}
