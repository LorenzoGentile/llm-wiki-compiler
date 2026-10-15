/**
 * Advisory evaluation of pending concept/query candidates. Reads the queue and
 * current sources, then reuses the citation judge without publishing anything.
 * Candidate reports are separate from live history and thresholds by design.
 *
 * The evaluator has ONE body, {@link evaluateCandidatesFrom}, over
 * {@link CandidateEvalSources}. `evaluateCandidates` keeps its root-taking form.
 */
import path from "node:path";
import { readCandidateSnapshotFrom } from "../compiler/candidate-read.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import { listCandidateFileIdsFrom } from "../utils/candidate-store.js";
import { CANDIDATES_DIR } from "../utils/constants.js";
import { ensureCompileProviderAvailable, ProviderUnavailableError, UnknownProviderError } from "../utils/provider-guard.js";
import { candidateAssessments, currentEvidenceReaderFrom, evaluationHash } from "./candidate-evidence.js";
import { candidateJudgeConfig } from "./candidate-judge-config.js";
import { createCitationJudgeFrom, selectDeterministicSample, type CitationJudgeCacheFiles, type CitationPair } from "./citation-support.js";
import { diskEvalFileReads } from "./file-reads.js";
import { diskEvalAtomicWrites, diskEvalFileWrites, type EvalAtomicWrites } from "./file-writes.js";
import { diskSourceFileReads, type SourceFileReads } from "./source-path.js";
import type { CandidateAssessment, CandidateEvalReport, CandidateReference } from "./candidate-types.js";
import type { ReviewCandidate } from "../utils/types.js";

const REPORT_FILE = path.join(".llmwiki", "eval", "candidates-latest.json");

/**
 * What the evaluator asks of the project. It holds no candidate, evidence
 * text, verdict or report; each is read or worked out by the evaluator from
 * what these return.
 */
export interface CandidateEvalSources {
  /** The pending queue: its directory listing, then one leaf per file id. */
  candidates: LegacyLocalRecordDirs;
  /** The current sources the drafts cite, resolved and read at most once per file in a run. */
  sources: SourceFileReads;
  /** The shared citation judge's cache file. Asked only in the full suite, and only when a pair is eligible. */
  judgeCache: CitationJudgeCacheFiles;
  /** The report file's whole-text replacement, asked once, last. */
  report: EvalAtomicWrites;
}

/** The directory approval writes to: any value other than "queries" routes to concepts. */
function approvalDirectory(candidate: ReviewCandidate): "concepts" | "queries" {
  return candidate.targetDirectory === "queries" ? "queries" : "concepts";
}

/** Capture identity of the loaded record, including metadata and full page content. */
function referenceFor(candidate: ReviewCandidate, raw: string): CandidateReference {
  return { id: candidate.id, target: `${approvalDirectory(candidate)}/${candidate.slug}`,
    generatedAt: candidate.generatedAt, revision: evaluationHash(raw),
    contentHash: evaluationHash(candidate.body) };
}

/** Read only hash strings, preserving nested source keys without changing approval sanitization. */
function generationHashes(raw: string): Record<string, string> {
  const states: unknown = (JSON.parse(raw) as Record<string, unknown>).sourceStates;
  if (!states || typeof states !== "object" || Array.isArray(states)) return {};
  return Object.fromEntries(Object.entries(states).flatMap(([file, state]) => {
    const hash = state && typeof state === "object" ? (state as Record<string, unknown>).hash : undefined;
    return typeof hash === "string" && hash.length ? [[file, hash]] : [];
  }));
}

/** Preserve invalid/unsupported queue entries as explicit skips. */
function skipReason(candidate: ReviewCandidate | undefined, id: string): string | undefined {
  if (!candidate || candidate.id !== id) return "Candidate is missing, malformed, or has a mismatched file id.";
  // Only typed candidates leave the default pages; an unrecognized directory is
  // still published by approval (into concepts), so it is assessed like one.
  if (candidate.targetEntityType) return "Typed profile candidates are outside this evaluation scope.";
  return undefined;
}

/** Inventory candidate snapshots without mutating the queue or compile state. */
async function collectPending(from: CandidateEvalSources, report: CandidateEvalReport): Promise<void> {
  const directory = await from.candidates.directory(CANDIDATES_DIR);
  const ids = directory ? (await listCandidateFileIdsFrom(directory)).sort() : [];
  const read = currentEvidenceReaderFrom(from.sources);
  for (const id of ids) {
    const snapshot = await readCandidateSnapshotFrom(from.candidates, id);
    const candidate = snapshot?.candidate;
    const reason = skipReason(candidate, id);
    if (reason || !candidate) {
      report.skippedCandidates.push({ id, reason: reason! });
      continue;
    }
    const reference = referenceFor(candidate, snapshot!.raw);
    report.candidates.push(reference);
    const { assessments, prose, cited } = await candidateAssessments(
      { body: candidate.body, hashes: generationHashes(snapshot!.raw) }, reference, read);
    report.assessments.push(...assessments);
    report.coverage.proseParagraphs += prose;
    report.coverage.citedParagraphs += cited;
    if (!prose) report.skippedCandidates.push({ id, reason: "No prose paragraphs in the evaluator's scope." });
  }
}

/** Convert one eligible observation to the shared engine's input. */
function citationPair(item: CandidateAssessment): CitationPair {
  const evidence = item.evidence!;
  return { claimHash: item.id, pageSlug: `candidate:${item.candidate.id}@${item.candidate.revision}`,
    claimText: item.claimText, citedFile: evidence.file, spanText: evidence.spanText!,
    lineStart: evidence.lineStart!, lineEnd: evidence.lineEnd! };
}

/** Configure the chat-only judge once, retaining safe guidance when unavailable. */
async function prepareJudge(cache: CitationJudgeCacheFiles, report: CandidateEvalReport) {
  try {
    ensureCompileProviderAvailable(false);
    return await createCitationJudgeFrom(cache, candidateJudgeConfig());
  } catch (error) {
    report.judgeUnavailable = error instanceof ProviderUnavailableError ? error.message
      : error instanceof UnknownProviderError ? "Unknown chat provider; check LLMWIKI_PROVIDER."
      : "Cannot configure citation judge; check provider settings and the evaluation cache.";
    return null;
  }
}

/** Judge a bounded sample, preserving coverage and failures even when unavailable. */
async function judgePending(cache: CitationJudgeCacheFiles, report: CandidateEvalReport, sampleSize: number): Promise<void> {
  const eligible = report.assessments.filter(item => item.status === "eligible");
  if (!eligible.length) return;
  const judge = await prepareJudge(cache, report);
  const pairs = selectDeterministicSample(eligible.map(citationPair), sampleSize);
  const selected = new Map(pairs.map(pair => [pair.claimHash, pair]));
  report.coverage.selectedPairs = pairs.length;
  for (const item of eligible) {
    const pair = selected.get(item.id);
    item.status = pair ? "judge-error" : "not-sampled";
    if (!pair) continue;
    if (!judge) {
      item.reason = "Judge unavailable; see judgeUnavailable for configuration guidance.";
      continue;
    }
    try {
      item.judgement = (await judge(pair)).judgement;
      item.status = "judged";
    } catch {
      // Provider errors can include sensitive endpoint details. Keep the report generic.
      item.reason = "Citation judge failed; no support verdict is available.";
    }
  }
}

/** LOCAL DISK. The evaluator's sources for the project at `root`. Building them does no I/O. In no package index. */
export function diskCandidateEvalSources(root: string): CandidateEvalSources {
  return {
    candidates: diskLocalRecordDirs(root), sources: diskSourceFileReads(root),
    judgeCache: { reads: diskEvalFileReads(root), writes: diskEvalFileWrites(root) }, report: diskEvalAtomicWrites(root),
  };
}

/** Evaluate pending drafts; only report/cache files under .llmwiki/eval are written. */
export async function evaluateCandidates(root: string, suite: "fast" | "full", sampleSize = 20): Promise<CandidateEvalReport> {
  return evaluateCandidatesFrom(diskCandidateEvalSources(root), suite, sampleSize);
}

/**
 * {@link evaluateCandidates} over {@link CandidateEvalSources}: THE ONE BODY.
 * The sample size is checked before anything is asked of the project. The
 * queue is read in file-id order; the judge runs in the full suite only; the
 * report is written once, last, whatever the judge did.
 *
 * @param from - The queue, the current sources, the judge's cache file and the report write.
 * @param suite - `fast` describes eligibility only; `full` also judges a sample.
 * @param sampleSize - How many eligible pairs the judge may sample.
 * @returns The report, exactly as it was written.
 */
export async function evaluateCandidatesFrom(from: CandidateEvalSources, suite: "fast" | "full", sampleSize: number): Promise<CandidateEvalReport> {
  if (!Number.isSafeInteger(sampleSize) || sampleSize <= 0) throw new Error("Sample size must be a positive safe integer");
  const report: CandidateEvalReport = { selection: "candidates", suite,
    timestamp: new Date().toISOString(), evidencePolicy: "current-sources", candidates: [], skippedCandidates: [],
    coverage: { proseParagraphs: 0, citedParagraphs: 0, eligiblePairs: 0, selectedPairs: 0,
      judgedPairs: 0, unjudgeable: 0, judgeErrors: 0 }, meanScore: null, assessments: [] };
  await collectPending(from, report);
  report.coverage.eligiblePairs = report.assessments.filter(item => item.status === "eligible").length;
  if (suite === "full") await judgePending(from.judgeCache, report, sampleSize);
  const judged = report.assessments.flatMap(item => item.judgement ? [item.judgement] : []);
  report.coverage.judgedPairs = judged.length;
  report.coverage.unjudgeable = report.assessments.filter(item => item.status === "unjudgeable").length;
  report.coverage.judgeErrors = report.assessments.filter(item => item.status === "judge-error").length;
  if (judged.length) report.meanScore = judged.reduce((sum, item) => sum + item.score, 0) / judged.length;
  await from.report.writeAtomic(REPORT_FILE, JSON.stringify(report, null, 2));
  return report;
}

/** Human-readable manual review, with identity and every skipped/unsampled observation. */
export function formatCandidateReport(report: CandidateEvalReport): string {
  const coverage = report.coverage;
  const lines = ["Pending candidate citation support (advisory; not approval)",
    `Current source evidence. ${report.candidates.length} candidates; ${coverage.citedParagraphs}/${coverage.proseParagraphs} prose paragraphs cited.`,
    `Judged ${coverage.judgedPairs}/${coverage.eligiblePairs} eligible pairs; mean score ${report.meanScore ?? "not measured"}/2.`,
    `Unjudgeable: ${coverage.unjudgeable}; judge errors: ${coverage.judgeErrors}.`];
  if (report.judgeUnavailable) lines.push(`Judge unavailable: ${report.judgeUnavailable}`);
  for (const candidate of report.candidates) {
    lines.push(`\n${candidate.id} -> ${candidate.target}\nRevision: ${candidate.revision}\nContent: ${candidate.contentHash}`);
    for (const item of report.assessments.filter(item => item.candidate.id === candidate.id)) {
      lines.push(`  Paragraph ${item.paragraph}: ${item.status}${item.evidence ? ` (${item.evidence.file}, ${item.evidence.status})` : ""}`,
        `    ${item.judgement ? `${item.judgement.score}/2: ${item.judgement.reason}` : item.reason ?? "No verdict requested/selected."}`);
    }
  }
  for (const skipped of report.skippedCandidates) lines.push(`Skipped ${skipped.id}: ${skipped.reason}`);
  lines.push("\nReport: .llmwiki/eval/candidates-latest.json; candidates and live pages unchanged.");
  return lines.join("\n");
}
