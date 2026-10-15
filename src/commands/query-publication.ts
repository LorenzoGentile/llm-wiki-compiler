/**
 * Query publication owns the existing mutation lock and the direct-save profile
 * gate. Only a fresh strict citation check can authorize writing or staging the
 * canonical document. Reviewed staging is allowed in profile-enabled projects
 * because a review candidate is the trust-routed destination: approval routes
 * through the planner. Refusals are answer-preserving results; actual
 * persistence failures propagate.
 *
 * ONE BODY, TWO ROUTES. {@link maybeSaveQueryPageFrom} takes the publication
 * steps. {@link maybeSaveQueryPage} gives it the root functions it always called
 * (lock, profile gate, validation, staging, save), so every mock and spy of them
 * still intercepts; {@link queryPublicationStepsOver} composes the same steps
 * from each one's existing body over its own seam. The LOCK STAYS THE HOST'S:
 * the bound composition takes it as given.
 */
import { collectAnswerCitationIndexFrom, type AnswerCitationSources } from "../citations/answer-index.js";
import {
  CitationPublicationError, validateCitationPublication, validateCitationPublicationWith, type CitationPublicationMode,
} from "../citations/answer-publication.js";
import type { AnswerCitationReport } from "../citations/answer-types.js";
import { writeFreshCandidateFrom } from "../compiler/candidates.js";
import type { CandidatePublicationStore } from "../compiler/candidate-publication.js";
import { generateIndexFrom, type IndexGenerationSources } from "../compiler/indexgen.js";
import { loadNonDefaultProfile, loadNonDefaultProfileFrom } from "../profile/block.js";
import type { EffectiveProfileSources } from "../profile/load.js";
import type { LoadedProfile } from "../profile/types.js";
import { updateEmbeddingsLockedCoreFrom, type EmbeddingWriterSources } from "../utils/embeddings.js";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { releaseLock } from "../utils/lock.js";
import type { QueryResult } from "../utils/types.js";
import * as output from "../utils/output.js";
import { buildQueryDocument } from "./query-document.js";
import { slugify } from "../utils/markdown.js";
import { saveQueryPageLocked, saveQueryPageLockedFrom, type QuerySaveSteps } from "./query-save.js";
import { stageQueryProposal, stageQueryProposalFrom, type QueryProposalSteps } from "./query-proposal.js";

interface QueryPublicationOptions {
  root: string;
  question: string;
  answer: string;
  save: boolean;
  review?: boolean;
  document?: string;
}

type PublicationResult = Pick<QueryResult, "saved" | "candidateId" | "publicationRefusal">;
/** What one answered query asks publication: the options without the root. */
type QueryPublicationRequest = Omit<QueryPublicationOptions, "root">;

/** The steps publication takes, in the order the body takes them. No member takes a project root. */
export interface QueryPublicationSteps {
  /** HOST: the project mutation lock, held around every decision and write. */
  lock: { acquire(): Promise<void>; release(): Promise<void> };
  /** The active non-default profile, or `undefined` for the built-in default (the direct-save gate). */
  nonDefaultProfile(): Promise<LoadedProfile | undefined>;
  /** Fresh strict citation validation of the canonical document for `mode`; rejects on refusal or fault. */
  validate(document: string, mode: CitationPublicationMode, targetSlug: string): Promise<AnswerCitationReport>;
  /** Stage the validated answer as a review candidate; resolves to its id. */
  stage(input: { question: string; document: string; report: AnswerCitationReport }): Promise<string>;
  /** Save the validated answer directly; resolves to its slug. */
  save(question: string, document: string): Promise<string>;
}
type PublicationRefusal = NonNullable<QueryResult["publicationRefusal"]>;
let afterDefaultProfileCheckForTest: (() => Promise<void>) | undefined;

/** Reject an invalid reviewed-save request before provider or filesystem work. */
export function assertQuerySaveOptions(options: { save?: boolean; review?: boolean }): void {
  if (options.review && !options.save) throw new Error("Query review requires save.");
}

/** Test-only seam after the under-lock profile decision, before fresh resolution. */
export function setQuerySaveTestHookForTest(hook: (() => Promise<void>) | undefined): void {
  afterDefaultProfileCheckForTest = hook;
}

/** Refuse profile-disabled direct writes with the existing actionable warning. */
function profileRefusal(): PublicationResult {
  const message = "query --save is disabled in profile-enabled projects (the saved-query "
    + "write path is not yet trust-routed). Run without --save, or use the default profile.";
  output.status("!", output.warn(message));
  return { publicationRefusal: { code: "profile-disabled", targets: [], message } };
}

/** Recover only validation failure; page/index/embedding/log writes are outside. */
async function checkCitations(steps: QueryPublicationSteps, document: string, mode: CitationPublicationMode, targetSlug: string): Promise<
  { report: AnswerCitationReport } | { publicationRefusal: PublicationRefusal }
> {
  try {
    return { report: await steps.validate(document, mode, targetSlug) };
  } catch (error) {
    if (error instanceof CitationPublicationError) {
      return { publicationRefusal: { code: error.code, targets: error.targets, message: error.message } };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { publicationRefusal: { code: "unavailable", targets: [], message: `Answer publication refused: citation validation unavailable (${detail})` } };
  }
}

/** Publish or stage on request only after the gates and fresh citations pass under one lock. */
export async function maybeSaveQueryPage(options: QueryPublicationOptions): Promise<PublicationResult> {
  // `async` so that a malformed argument REJECTS rather than throwing synchronously.
  const { root, ...request } = options;
  return maybeSaveQueryPageFrom({
    lock: { acquire: () => acquireMutationLockBlocking(root, "ordinary"), release: () => releaseLock(root) },
    nonDefaultProfile: () => loadNonDefaultProfile(root),
    validate: (document, mode, targetSlug) => validateCitationPublication(root, document, mode, targetSlug),
    stage: (input) => stageQueryProposal({ root, ...input }),
    save: (question, document) => saveQueryPageLocked(root, question, document),
  }, request);
}

/**
 * {@link maybeSaveQueryPage} over {@link QueryPublicationSteps}: THE ONE BODY.
 * Nothing is asked without `save`; then, under the lock: the profile gate (direct
 * saves only), the canonical document, fresh validation, then stage or save.
 */
export async function maybeSaveQueryPageFrom(steps: QueryPublicationSteps, request: QueryPublicationRequest): Promise<PublicationResult> {
  const { question, answer, save, review } = request;
  if (!save) return {};
  await steps.lock.acquire();
  try {
    // Only the direct write is gated by the profile: a reviewed proposal is the
    // trust-routed destination and its approval goes through the planner.
    if (!review && await steps.nonDefaultProfile()) return profileRefusal();
    await afterDefaultProfileCheckForTest?.();
    const document = request.document ?? buildQueryDocument(question, answer, new Date().toISOString()).document;
    const validation = await checkCitations(steps, document, review ? "proposal" : "direct", slugify(question));
    if ("publicationRefusal" in validation) return validation;
    if (review) return { candidateId: await steps.stage({ question, document, report: validation.report }) };
    return { saved: await steps.save(question, document) };
  } finally {
    await steps.lock.release();
  }
}

/** The raw seams of the publication steps: each the existing seam of the body that answers it, plus the HOST lock. */
export interface QueryPublicationSources {
  /** HOST: the mutation lock, taken as given. */
  lock: QueryPublicationSteps["lock"];
  /** The effective profile, for the direct-save gate. */
  profile: EffectiveProfileSources;
  /** The answer-citation index's project, collected afresh for each validation. */
  citations: AnswerCitationSources;
  /** The staged proposal's target-page text read (ENOENT-only expect-absent). */
  readTargetText: QueryProposalSteps["readTargetText"];
  /** The candidate store the proposal is published to. */
  candidates: CandidatePublicationStore;
  /** The direct save's page write and the notice's locator. */
  writePage: QuerySaveSteps["writePage"];
  locate: QuerySaveSteps["locate"];
  /** The index regeneration's sources. */
  index: IndexGenerationSources;
  /** The embedding writer's sources, for the saved page's refresh. */
  embeddings: EmbeddingWriterSources;
}

/** The publication steps over {@link QueryPublicationSources}: THE ONE BOUND COMPOSITION. */
export function queryPublicationStepsOver(sources: QueryPublicationSources): QueryPublicationSteps {
  return {
    lock: sources.lock,
    nonDefaultProfile: () => loadNonDefaultProfileFrom(sources.profile),
    validate: (document, mode, targetSlug) =>
      validateCitationPublicationWith(() => collectAnswerCitationIndexFrom(sources.citations), document, mode, targetSlug),
    stage: (input) => stageQueryProposalFrom({
      readTargetText: sources.readTargetText,
      writeCandidate: async (draft) => (await writeFreshCandidateFrom(sources.candidates, draft)).id,
    }, input),
    save: (question, document) => saveQueryPageLockedFrom({
      writePage: sources.writePage, locate: sources.locate,
      regenerateIndex: () => generateIndexFrom(sources.index),
      refreshEmbedding: (pageId) => updateEmbeddingsLockedCoreFrom(sources.embeddings, [pageId]),
    }, question, document),
  };
}
