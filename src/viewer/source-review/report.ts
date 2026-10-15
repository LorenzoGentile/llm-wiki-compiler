/**
 * Read-only source-maintenance prototype projection. Reuses compiler freshness
 * and candidate reads; deliberately exposes no approval or regeneration action.
 * Only default concept ownership is supported. Observations are not authority.
 *
 * ONE BODY. {@link collectSourceReviewFrom} decides over {@link SourceReviewReads}
 * and is told the root to DISPLAY (an output field, never a path it opens).
 * {@link collectSourceReview} keeps its signature and passes the local reads,
 * built per call, which call the incumbent root readers when asked, so module
 * spies and mocks still intercept. Only-ENOENT absence stays in that local read.
 */
import { createHash } from "node:crypto";
import { reviewFreshness } from "./freshness.js";
import { sourceExcerptReader } from "./source-excerpts.js";
import { locationKindNoFollow } from "../../storage/disk-local-reads.js";
import path from "node:path";
import { readStateClassified } from "../../utils/state.js";
import { listCandidateIdentityPage } from "../../compiler/candidate-read.js";
import { readConfinedWikiPage } from "../../compiler/confined-wiki-read.js";
import { parseFrontmatter } from "../../utils/markdown.js";
import { isSafeFilenameComponent } from "../../profile/identity.js";
import type { ReviewCandidate } from "../../utils/types.js";
import type { FreshnessSnapshot } from "../../freshness/types.js";
import type { ClassifiedState } from "../../utils/state.js";
import type { ConfinedReadResult } from "../../storage/legacy-local-reads.js";

const LIMIT = 100;
const TEXT_LIMIT = 80_000;
const CONCEPTS = "wiki/concepts";

/** The reads one review takes. No member takes a project root. */
export interface SourceReviewReads {
  /** The classified compile state. */
  readState(): Promise<ClassifiedState>;
  /** The fault-isolated freshness snapshot for that state. */
  freshness(classified: ClassifiedState): Promise<FreshnessSnapshot>;
  /** The bounded pending-candidate page, with file identities. */
  candidatePage(limit: number): ReturnType<typeof listCandidateIdentityPage>;
  /** A request-scoped excerpt reader over the observed sources. */
  excerptReader(filenames: string[]): ReturnType<typeof sourceExcerptReader>;
  /** One concept page's confined text. */
  readConcept(slug: string): Promise<ConfinedReadResult>;
  /** Whether the concept page is ABSENT (ENOENT only; unreadable is not absent). */
  conceptAbsent(slug: string): Promise<boolean>;
}

/** LOCAL DISK. The incumbent root readers, each called when asked; building them does no I/O. */
function localSourceReviewReads(root: string): SourceReviewReads {
  return {
    readState: () => readStateClassified(root),
    freshness: (classified) => reviewFreshness(root, classified),
    candidatePage: (limit) => listCandidateIdentityPage(root, limit),
    excerptReader: (filenames) => sourceExcerptReader(root, filenames),
    readConcept: (slug) => readConfinedWikiPage(root, CONCEPTS, slug),
    conceptAbsent: (slug) => targetAbsent(root, slug),
  };
}

/** Digest of exact displayed inputs, not a semantic correctness assertion. */
export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Candidate bindings are diagnostics only; ordinary CLI approval owns policy. */
function candidateChecks(candidate: ReviewCandidate, current: string | null, snapshot: FreshnessSnapshot, absent: boolean) {
  const target = targetCheck(candidate, current, absent);
  return { target, sources: sourceCheck(candidate, snapshot) };
}

/** Distinguish missing bindings, contradictory expectations and observed drift. */
function targetCheck(candidate: ReviewCandidate, current: string | null, absent: boolean): string {
  if (candidate.expectTargetAbsent) {
    if (candidate.expectedTargetHash !== undefined) return "invalid expectations";
    return absent ? "expected absence observed" : "expected absent; present or unreadable";
  }
  if (candidate.expectedTargetHash === undefined) return "not recorded";
  if (!/^[a-f0-9]{64}$/.test(candidate.expectedTargetHash)) return "invalid binding";
  return current !== null && digest(current) === candidate.expectedTargetHash ? "matches" : "changed or unreadable";
}

/** Only ENOENT is evidence of absence; unreadable/symlink targets are not absent. */
async function targetAbsent(root: string, slug: string): Promise<boolean> {
  try { await locationKindNoFollow(path.join(root, CONCEPTS, `${slug}.md`)); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** Sanitized legacy records can lose unsupported keys; partial coverage is not a match. */
function sourceCheck(candidate: ReviewCandidate, snapshot: FreshnessSnapshot): string {
  const bindings = candidate.sourceStates ?? {};
  const declared = candidate.sources;
  if (Object.keys(bindings).length === 0) return "not recorded";
  const owners = Object.entries(snapshot.sources).filter(([, source]) => source.concepts.includes(candidate.slug));
  const required = new Set([...declared, ...owners.map(([file]) => file)]);
  if (!required.size || [...required].some(file => !Object.hasOwn(bindings, file))) return "incomplete bindings";
  return Object.entries(bindings).every(([file, entry]) => snapshot.sources[file]?.currentHash === entry.hash)
    ? "matches" : "changed or unavailable";
}

/** Derive contributor changes from the shared freshness snapshot. */
function pageOwners(slug: string, snapshot: FreshnessSnapshot) {
  return Object.entries(snapshot.sources).filter(([, source]) => source.concepts.includes(slug))
    .map(([file, source]) => ({ file, ...source, status: !source.exists ? "unavailable"
      : source.currentHash === source.recordedHash ? "unchanged" : "changed" }));
}

/** No inference about authorship, approval, or semantic support. */
function impactOf(owners: ReturnType<typeof pageOwners>) {
  if (!owners.length) return "Source ownership unverified";
  if (owners.every(source => !source.exists)) return "No available contributors";
  return owners.some(source => source.status !== "unchanged") ? "Source update needs review" : "Pending proposal";
}

/** Keep the complete byte digest even when the displayed text is truncated. */
function currentProjection(current: string | null, absent: boolean) {
  return { current: current?.slice(0, TEXT_LIMIT) ?? null,
    currentHash: current === null ? null : digest(current), truncated: (current?.length ?? 0) > TEXT_LIMIT,
    readStatus: absent ? "Page does not exist yet" : current === null ? "Page could not be read safely" : "readable" };
}

/** Project one page without interpreting proposed Markdown as executable HTML. */
async function projectPage(reads: SourceReviewReads, slug: string, context: {
  snapshot: FreshnessSnapshot; candidates: ReviewCandidate[]; reconciliation: string[];
  readExcerpt: ReturnType<typeof sourceExcerptReader>;
}) {
  const read = await reads.readConcept(slug);
  const current = "content" in read ? read.content : null;
  const absent = await reads.conceptAbsent(slug);
  const owners = pageOwners(slug, context.snapshot);
  const excerpts = await Promise.all(owners.slice(0, 20).map(async owner => ({ file: owner.file,
    ...await context.readExcerpt(owner.file, owner.currentHash) })));
  const candidates = context.candidates.filter(candidate => candidate.slug === slug)
    .map(candidate => ({ id: candidate.id, generatedAt: candidate.generatedAt,
      body: candidate.body.slice(0, TEXT_LIMIT), bodyHash: digest(candidate.body), truncated: candidate.body.length > TEXT_LIMIT,
      checks: candidateChecks(candidate, current, context.snapshot, absent), reasons: candidate.heldReasons }));
  const meta = current === null ? {} : parseFrontmatter(current).meta;
  return { slug, title: typeof meta.title === "string" ? meta.title : slug, owners, candidates, excerpts,
    ...currentProjection(current, absent),
    reconciliationPending: context.reconciliation.includes(slug),
    impact: impactOf(owners) };
}

/** Collect live observations on demand; no state backups, providers, or writes. */
export async function collectSourceReview(root: string) {
  return collectSourceReviewFrom(localSourceReviewReads(root), path.resolve(root));
}

/** {@link collectSourceReview} over {@link SourceReviewReads}: THE ONE BODY. `displayRoot` is only reported. */
export async function collectSourceReviewFrom(reads: SourceReviewReads, displayRoot: string) {
  const classified = await reads.readState();
  const snapshot = await reads.freshness(classified);
  const queue = await reads.candidatePage(LIMIT);
  const candidates = queue.entries.map(({ fileId, candidate }) => ({ ...candidate, id: fileId })).filter(candidate => !candidate.targetEntityType
    && (!candidate.targetDirectory || candidate.targetDirectory === "concepts"));
  const changed = Object.values(snapshot.sources).filter(source =>
    !source.exists || source.currentHash !== source.recordedHash);
  const slugs = [...new Set([...changed.flatMap(source => source.concepts),
    ...candidates.map(candidate => candidate.slug)])].sort();
  const safe = slugs.filter(isSafeFilenameComponent);
  const context = { snapshot, candidates, reconciliation: classified.state.frozenSlugs ?? [],
    readExcerpt: reads.excerptReader(Object.keys(snapshot.sources)) };
  const pages = [];
  for (const slug of safe.slice(0, LIMIT)) pages.push(await projectPage(reads, slug, context));
  const content = { projectRoot: displayRoot, stateStatus: classified.status, pages, totalPages: safe.length,
    candidateTotal: queue.total, candidateShown: candidates.length,
    omittedUnsafeSlugs: slugs.length - safe.length };
  return { ...content, observedAt: new Date().toISOString(), fingerprint: digest(JSON.stringify(content)) };
}
