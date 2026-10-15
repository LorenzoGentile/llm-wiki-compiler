/**
 * Class-specific approval prechecks run on the authoritative admitted candidate
 * under the existing review lock. Validated answers fail closed and preserve
 * exact bytes; ordinary candidates retain warning-only unavailable behavior.
 *
 * ONE BODY EACH. {@link checkCandidatePublicationWith} and
 * {@link genericPublicationRefusalWith} decide over {@link PublicationCheckReads}
 * (the generic broken targets, the strict answer validation). The root forms keep
 * their signatures and pass the incumbent root readers, called when asked;
 * {@link publicationCheckReadsOver} composes the same reads from each one's
 * existing body over its own seam. In no package index.
 */
import type { ReviewCandidate } from "../utils/types.js";
import type { PagePlannedMutation } from "../trust/planner.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { sha256Text } from "../connectors/hash.js";
import { collectAnswerCitationIndexFrom, type AnswerCitationSources } from "../citations/answer-index.js";
import { validateCitationPublication, validateCitationPublicationWith } from "../citations/answer-publication.js";
import { genericBrokenTargets, genericBrokenTargetsWith, type GenericCitationReads } from "../citations/generic-publication.js";
import * as output from "../utils/output.js";

/** Admission has already rejected unknown kinds and orphan/malformed manifests. */
export function isValidatedAnswer(candidate: ReviewCandidate): boolean {
  return candidate.candidateKind?.name === "validated-answer";
}

/** Refuse without mutating the candidate, leaving explicit recovery possible. */
function refuse(candidate: ReviewCandidate, message: string): false {
  output.status("!", output.error(`Candidate ${candidate.id} not approved: ${message}`));
  process.exitCode = 1;
  return false;
}

/** The two reads the publication checks make. No member takes a project root. */
export interface PublicationCheckReads {
  /** A default candidate body's broken targets that the repair pass cannot resolve. */
  brokenTargets(document: string): Promise<string[]>;
  /** Strict approval-mode validation of a validated answer; rejects on refusal or fault. */
  validateAnswer(document: string, slug: string): Promise<unknown>;
}

/** LOCAL DISK. The incumbent root readers for `root`, each called when asked. */
function diskPublicationCheckReads(root: string): PublicationCheckReads {
  return {
    brokenTargets: (document) => genericBrokenTargets(root, document),
    validateAnswer: (document, slug) => validateCitationPublication(root, document, "approval", slug),
  };
}

/** The same reads over the generic citation reads and the citation index's project. */
export function publicationCheckReadsOver(sources: { generic: GenericCitationReads; citations: AnswerCitationSources }): PublicationCheckReads {
  return {
    brokenTargets: (document) => genericBrokenTargetsWith(sources.generic, document),
    validateAnswer: (document, slug) =>
      validateCitationPublicationWith(() => collectAnswerCitationIndexFrom(sources.citations), document, "approval", slug),
  };
}

/** Apply policy only after connector prerequisites and under-lock admission. */
export async function checkCandidatePublication(root: string, candidate: ReviewCandidate): Promise<boolean> {
  return checkCandidatePublicationWith(diskPublicationCheckReads(root), candidate);
}

/** {@link checkCandidatePublication} over {@link PublicationCheckReads}: THE ONE BODY. */
export async function checkCandidatePublicationWith(reads: PublicationCheckReads, candidate: ReviewCandidate): Promise<boolean> {
  if (isValidatedAnswer(candidate)) return checkAnswer(reads, candidate);
  const problem = await genericPublicationRefusalWith(reads, candidate);
  return problem ? refuse(candidate, problem) : true;
}

/** Return generic citation refusals without changing the caller's process exit status. */
export async function genericPublicationRefusal(root: string, candidate: ReviewCandidate): Promise<string | undefined> {
  return genericPublicationRefusalWith(diskPublicationCheckReads(root), candidate);
}

/** {@link genericPublicationRefusal} over {@link PublicationCheckReads}: THE ONE BODY. A typed candidate reads nothing. */
export async function genericPublicationRefusalWith(reads: PublicationCheckReads, candidate: ReviewCandidate): Promise<string | undefined> {
  if (candidate.targetEntityType) return undefined;
  // Every other candidate lands in wiki/concepts or wiki/queries at approval
  // (any non-"queries" directory routes to concepts), so the check applies to all.
  let broken: string[];
  try {
    broken = await reads.brokenTargets(candidate.body);
  } catch (error) {
    output.status("!", output.warn(`Candidate ${candidate.id}: citation check unavailable (${String(error)}); continuing existing approval policy.`));
    return undefined;
  }
  return broken.length ? `broken citation targets: ${broken.join(", ")}` : undefined;
}

/** Digest is an edit detector; current resolution, rather than its observations, authorizes approval. */
async function checkAnswer(reads: PublicationCheckReads, candidate: ReviewCandidate): Promise<boolean> {
  // No default-profile gate here: a reviewed answer is the trust-routed
  // destination and the planner applies the current profile's rules at write.
  if (sha256Text(parseFrontmatter(candidate.body).body) !== candidate.citationManifest!.bodyDigest) {
    return refuse(candidate, "candidate-edited: regenerate and restage the answer.");
  }
  try {
    await reads.validateAnswer(candidate.body, candidate.slug);
  } catch (error) {
    return refuse(candidate, `citation validation refused or unavailable: ${String(error)}`);
  }
  return true;
}

/** Check the executor's exact proposed bytes and target before any answer write. */
export function checkAnswerPlan(candidate: ReviewCandidate, planned: PagePlannedMutation[]): boolean {
  if (!isValidatedAnswer(candidate)) return true;
  const [page] = planned;
  if (planned.length !== 1 || page.kind !== "page" || !["create", "update"].includes(page.operation)
    || !("directory" in page.target) || page.target.directory !== "queries" || page.target.slug !== candidate.slug
    || page.body !== candidate.body) return refuse(candidate, "planned answer bytes or target differ from the validated document.");
  if (page.operation === "update") {
    output.status("!", output.warn(`Replacing existing query wiki/queries/${candidate.slug}.md with candidate ${candidate.id}.`));
  }
  return true;
}
