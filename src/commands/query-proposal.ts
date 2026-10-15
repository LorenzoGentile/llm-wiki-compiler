/**
 * Persist a freshly validated query proposal as its own candidate identity.
 * The publication caller owns the lock; this writer never publishes a page or
 * refreshes live index/embedding artifacts. The proposal captures a CLOSED
 * precondition on the target page (its digest, or expect-absent) so approval
 * refuses if the page was edited or created between staging and approval.
 *
 * ONE BODY, TWO ROUTES. {@link stageQueryProposalFrom} takes the two steps it
 * needs: the target page's text, and the fresh-candidate write.
 * {@link stageQueryProposal} gives it the root functions it always called
 * (`readLocationText`, `writeFreshCandidate`), so their mocks and spies still
 * intercept; a bound caller gives it the candidate store's own body.
 */
import path from "path";
import { readLocationText } from "../storage/disk-locations.js";
import { writeFreshCandidate, type CandidateDraft } from "../compiler/candidates.js";
import { parseFrontmatter, slugify } from "../utils/markdown.js";
import { sha256Text } from "../connectors/hash.js";
import { QUERIES_DIR } from "../utils/constants.js";
import type { AnswerCitationReport } from "../citations/answer-types.js";
import { summarizeAnswer } from "./query-document.js";

/** A CLOSED precondition on the query page: its digest, or an explicit expect-absent. */
type QueryTargetPrecondition = { expectedTargetHash: string } | { expectTargetAbsent: true };

/** The two steps staging takes: the target page's text, then the fresh-candidate write. No member takes a project root. */
export interface QueryProposalSteps {
  /** The whole text of the project-relative `relPath`; rejects raw (`ENOENT` when nothing is there). */
  readTargetText(relPath: string): Promise<string>;
  /** Persist `draft` as a fresh candidate; resolves to its id. */
  writeCandidate(draft: CandidateDraft): Promise<string>;
}

/** The input staging is asked for: the question, the canonical document and the fresh report. */
interface QueryProposalInput { question: string; document: string; report: AnswerCitationReport }

/**
 * Capture the target page's content digest when it exists, or expect-absent when
 * it does not (ENOENT ONLY). Any other read error refuses the proposal: a
 * precondition that cannot be captured must never fail open into a blind
 * overwrite at approval time.
 */
async function captureQueryPrecondition(steps: QueryProposalSteps, slug: string): Promise<QueryTargetPrecondition> {
  try {
    return { expectedTargetHash: sha256Text(await steps.readTargetText(path.join(QUERIES_DIR, `${slug}.md`))) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { expectTargetAbsent: true };
    throw err;
  }
}

/** Stage exactly the document and observations checked inside the publication lock. */
export async function stageQueryProposal(input: QueryProposalInput & { root: string }): Promise<string> {
  // `async` so that a malformed argument REJECTS rather than throwing synchronously.
  const { root, ...request } = input;
  return stageQueryProposalFrom({
    readTargetText: (relPath) => readLocationText(path.join(root, relPath)),
    writeCandidate: async (draft) => (await writeFreshCandidate(root, draft)).id,
  }, request);
}

/** {@link stageQueryProposal} over {@link QueryProposalSteps}: THE ONE BODY. Slug, body, precondition, then the write. */
export async function stageQueryProposalFrom(steps: QueryProposalSteps, input: QueryProposalInput): Promise<string> {
  const { question, document, report } = input;
  const slug = slugify(question);
  const body = parseFrontmatter(document).body;
  const precondition = await captureQueryPrecondition(steps, slug);
  return steps.writeCandidate({
    title: question, slug, summary: summarizeAnswer(body),
    body: document, sources: [], targetDirectory: "queries", reviewMode: "forced",
    candidateKind: { name: "validated-answer", version: 1 },
    citationManifest: { version: 1, bodyDigest: sha256Text(body), citations: report.citations },
    ...precondition,
  });
}
