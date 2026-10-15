/**
 * Rule-extraction orchestrator (rule pipeline).
 *
 * Drives the `RuleCandidate` producer half of the learning loop: for each
 * changed source file (by SHA-256 or selected output language), call the LLM
 * with the rule-extraction tool, map each
 * extracted rule into a `RuleCandidate`, and persist it under
 * `.llmwiki/rule-candidates/`.
 *
 * Provenance is stamped with the active model id (W4's `resolveActiveModelId`)
 * and the rule-prompt version so each recommendation is auditable even though
 * the extraction itself is nondeterministic. The createdAt timestamp is the
 * only nondeterministic field by design (RFC3339 wall-clock).
 *
 * ONE BODY OVER SIX STEPS. {@link extractRuleCandidatesWith} decides over
 * {@link RuleExtractionSteps}: the cursor, change detection, each source's text,
 * the existing-candidate looks, the candidate write and the cursor advance. The
 * provider call, the provenance stamp and the output language stay in the body.
 * {@link extractRuleCandidates} keeps its signature and passes the local steps,
 * built per call, which call the incumbent root readers and writers when asked,
 * so module spies and mocks still intercept. {@link ruleExtractionStepsOver}
 * composes the same steps from each one's existing body over its own seam. None
 * is a hosted store, and none is in a package index.
 */

import path from "path";
import { readLocationText } from "../storage/disk-locations.js";
import { detectChanges, detectChangesFrom } from "./hasher.js";
import { parseFrontmatter, slugify } from "../utils/markdown.js";
import { callClaude } from "../utils/llm.js";
import { resolveActiveModelId } from "../utils/provider.js";
import { getOutputLanguage } from "../utils/output-language.js";
import { budgetAndNumberSource } from "./prompt-budget.js";
import { SOURCES_DIR } from "../utils/constants.js";
import {
  readRuleState,
  readRuleStateFrom,
  updateRuleSourceState,
  updateRuleSourceStateFrom,
  type RuleStateLeaf,
} from "./rule-state.js";
import {
  RULE_EXTRACTION_TOOL,
  RULE_PROMPT_VERSION,
  buildRuleExtractionPrompt,
  parseRules,
  type ExtractedRule,
} from "./rule-prompts.js";
import {
  buildRuleCandidate,
  buildRuleSlug,
  readRuleCandidate,
  readRuleCandidateFrom,
  sanitizeRuleCategory,
  validateRuleCandidate,
  writeRuleCandidate,
  writeRuleCandidateFrom,
  type RuleCandidateLeaves,
} from "./rule-candidates.js";
import { candidateFileId } from "../utils/candidate-store.js";
import { createHash } from "node:crypto";
import type { EvidenceRef, RuleCandidate, RuleProvenance } from "../utils/rule-types.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import type { SourceChange } from "../utils/types.js";

/** Producer tag stamped on every candidate's provenance. */
const PROVENANCE_SOURCE = "llm-wiki-compiler";

/** Structured outcome of a rules-extraction run, for CLI + programmatic use. */
export interface RuleExtractionResult {
  /** Source files processed because content or selected language changed. */
  processedSources: string[];
  /** Candidates written this run. */
  candidates: RuleCandidate[];
  /** Non-fatal problems (e.g. a source that yielded no rules). */
  notes: string[];
}

/** The rule cursor as the steps read it. */
type RuleCursor = Awaited<ReturnType<typeof readRuleState>>;

/** The six project steps one extraction run takes. No member takes a project root. */
export interface RuleExtractionSteps {
  /** The rule cursor (`.llmwiki/rule-state.json`); an empty cursor when absent or unreadable. */
  readCursor(): Promise<RuleCursor>;
  /** The selected sources' changes against `cursor`. */
  detectChanges(cursor: RuleCursor): Promise<SourceChange[]>;
  /** One source's whole text; rejects when it cannot be read. */
  readSource(sourceFile: string): Promise<string>;
  /** One existing candidate in `location`, or null. */
  readCandidate(fileId: string, location: "active" | "archive"): Promise<RuleCandidate | null>;
  /** Write one candidate to the active store. */
  writeCandidate(candidate: RuleCandidate): Promise<unknown>;
  /** Advance the cursor for one processed source, reading it afresh. */
  advanceCursor(sourceFile: string, entry: Parameters<typeof updateRuleSourceState>[2]): Promise<void>;
}

/** LOCAL DISK. The incumbent root readers and writers for `root`, each called when asked. */
function diskRuleExtractionSteps(root: string): RuleExtractionSteps {
  return {
    readCursor: () => readRuleState(root),
    detectChanges: (cursor) => detectChanges(root, cursor),
    readSource: (sourceFile) => readLocationText(path.join(root, SOURCES_DIR, sourceFile)),
    readCandidate: (fileId, location) => readRuleCandidate(root, fileId, location),
    writeCandidate: (candidate) => writeRuleCandidate(root, candidate),
    advanceCursor: (sourceFile, entry) => updateRuleSourceState(root, sourceFile, entry),
  };
}

/** The steps over their own seams: the cursor leaf, the ordinary local reads (selection, listing, source text), and the candidate store's leaves. */
export function ruleExtractionStepsOver(seams: {
  cursor: RuleStateLeaf; reads: LegacyLocalReads; candidates: RuleCandidateLeaves;
}): RuleExtractionSteps {
  return {
    readCursor: () => readRuleStateFrom(seams.cursor),
    detectChanges: (cursor) => detectChangesFrom(seams.reads, cursor),
    readSource: (sourceFile) => seams.reads.readText(path.join(SOURCES_DIR, sourceFile)),
    readCandidate: (fileId, location) => readRuleCandidateFrom(seams.candidates, fileId, location),
    writeCandidate: (candidate) => writeRuleCandidateFrom(seams.candidates, candidate),
    advanceCursor: (sourceFile, entry) => updateRuleSourceStateFrom(seams.cursor, sourceFile, entry),
  };
}

/** Determine whether a source's `source` frontmatter field is a URL. */
function isUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/**
 * Build the evidence list for an extracted rule from its source file.
 *
 * URL-origin sources emit a `url` evidence ref; everything else emits a `file`
 * ref keyed on the source filename, carrying the extraction's line span when
 * present. Exactly one evidence ref is produced per rule so the contract stays
 * predictable for the rule importer.
 */
function buildEvidence(
  sourceFile: string,
  sourceMeta: Record<string, unknown>,
  rule: ExtractedRule,
  maxLine: number,
): EvidenceRef[] {
  const origin = sourceMeta.source;
  if (isUrl(origin)) {
    return [{ kind: "url", url: origin }];
  }
  const fileRef: EvidenceRef = { kind: "file", path: sourceFile };
  // Drop spans pointing past the content actually shown to the model — an
  // out-of-bounds anchor is a hallucination, not evidence.
  if (rule.evidenceLineStart !== undefined && rule.evidenceLineStart <= maxLine) {
    fileRef.lineStart = rule.evidenceLineStart;
  }
  if (rule.evidenceLineEnd !== undefined && rule.evidenceLineEnd <= maxLine) {
    fileRef.lineEnd = rule.evidenceLineEnd;
  }
  return [fileRef];
}

/** Build the provenance stamp shared by every candidate from a run. */
function buildProvenance(): RuleProvenance {
  return {
    source: PROVENANCE_SOURCE,
    modelId: resolveActiveModelId(),
    modelVersion: RULE_PROMPT_VERSION,
  };
}

/**
 * Call the LLM with the rule-extraction tool and parse the result.
 * @param numberedContent - Source content with 1-based line numbers already
 *   prepended (and clipped to the prompt budget), so the model's line-span
 *   citations refer to anchors it can actually see.
 */
async function extractRulesFromContent(numberedContent: string): Promise<ExtractedRule[]> {
  const system = buildRuleExtractionPrompt(numberedContent);
  const raw = await callClaude({
    system,
    messages: [{ role: "user", content: "Extract the actionable rules from this source." }],
    tools: [RULE_EXTRACTION_TOOL],
  });
  return parseRules(raw);
}

/** A rule paired with the source line count the model was shown, for span bounding. */
interface RuleInContext {
  rule: ExtractedRule;
  maxLine: number;
}

/**
 * Build a candidate for a single extracted rule. The category is normalized to
 * the rule importer's `[a-z0-9_]` alphabet and the slug carries a content-hash suffix so
 * distinct rules never collide on the same id/file. createdAt is injected by
 * the caller for a single consistent timestamp per run.
 */
function candidateForRule(
  sourceFile: string,
  sourceMeta: Record<string, unknown>,
  context: RuleInContext,
  provenance: RuleProvenance,
  createdAt: string,
): RuleCandidate {
  const { rule, maxLine } = context;
  const signature = `${sourceFile}\n${rule.when}\n${rule.then}\n${rule.description}`;
  return buildRuleCandidate(
    {
      category: sanitizeRuleCategory(rule.category),
      slug: buildRuleSlug(rule.title, signature),
      title: rule.title,
      description: rule.description,
      when: rule.when,
      then: rule.then,
      evidence: buildEvidence(sourceFile, sourceMeta, rule, maxLine),
      provenance,
      confidence: rule.confidence,
    },
    createdAt,
  );
}

/** Process one source file end-to-end: read, number, extract, build candidates. */
async function extractForSource(
  steps: RuleExtractionSteps,
  sourceFile: string,
  provenance: RuleProvenance,
  createdAt: string,
): Promise<{ candidates: RuleCandidate[]; note?: string; hash: string }> {
  const raw = await steps.readSource(sourceFile);
  const hash = createHash("sha256").update(raw).digest("hex");
  const { meta } = parseFrontmatter(raw);
  const numbered = budgetAndNumberSource(sourceFile, raw);
  const maxLine = numbered.split("\n").length;
  const rules = await extractRulesFromContent(numbered);
  if (rules.length === 0) {
    return { candidates: [], note: `No rules extracted from ${sourceFile}`, hash };
  }
  const candidates = rules
    .filter((rule) => slugify(rule.title).length > 0)
    .map((rule) => candidateForRule(sourceFile, meta, { rule, maxLine }, provenance, createdAt));
  return { candidates, hash };
}

/**
 * Source filenames whose content or selected language needs rule extraction.
 * Compares against `.llmwiki/rule-state.json` — NOT the concept compiler's
 * state — so extraction has an independent change-detection cursor.
 */
async function changedSources(steps: RuleExtractionSteps, outputLanguage: string): Promise<string[]> {
  const state = await steps.readCursor();
  const changes = await steps.detectChanges(state);
  return changes
    .filter((c) => c.status === "new" || c.status === "changed" ||
      (c.status === "unchanged" && (state.sources[c.file]?.outputLanguage ?? "") !== outputLanguage))
    .map((c) => c.file);
}

/**
 * Extract rule candidates for every changed source and persist them.
 *
 * @param root - Project root directory.
 * @param createdAt - RFC3339 timestamp injected once per run for determinism in
 *   tests; defaults to the current wall-clock time.
 * @returns Structured result with processed sources, written candidates, notes.
 */
export async function extractRuleCandidates(
  root: string,
  createdAt: string = new Date().toISOString(),
): Promise<RuleExtractionResult> {
  return extractRuleCandidatesWith(diskRuleExtractionSteps(root), createdAt);
}

/**
 * {@link extractRuleCandidates} over {@link RuleExtractionSteps}: THE ONE BODY.
 * Provenance and language first, then the changed sources; per source, extract,
 * persist each candidate (never over a human decision), then advance the cursor.
 */
export async function extractRuleCandidatesWith(
  steps: RuleExtractionSteps,
  createdAt: string = new Date().toISOString(),
): Promise<RuleExtractionResult> {
  const provenance = buildProvenance();
  const outputLanguage = getOutputLanguage() ?? "";
  const sources = await changedSources(steps, outputLanguage);

  const candidates: RuleCandidate[] = [];
  const notes: string[] = [];
  for (const sourceFile of sources) {
    const outcome = await extractForSource(steps, sourceFile, provenance, createdAt);
    if (outcome.note) notes.push(outcome.note);
    for (const candidate of outcome.candidates) {
      if (await persistCandidate(steps, candidate, notes)) candidates.push(candidate);
    }
    // Advance the rule cursor whether or not this source yielded candidates, so
    // an unchanged source is not re-extracted (and approvals are never re-fired)
    // on the next run.
    await steps.advanceCursor(sourceFile, {
      hash: outcome.hash,
      concepts: [],
      compiledAt: createdAt,
      outputLanguage,
    });
  }

  return { processedSources: sources, candidates, notes };
}

/**
 * Persist a freshly-extracted candidate, refusing to clobber a human decision.
 * Returns true when the candidate was written. An existing candidate that has
 * already been approved or rejected is preserved as-is; a candidate that would
 * fail the rule importer's import gate is dropped with a note instead of being emitted.
 */
async function persistCandidate(
  steps: RuleExtractionSteps,
  candidate: RuleCandidate,
  notes: string[],
): Promise<boolean> {
  const fileId = candidateFileId(candidate.id);
  const existing = await steps.readCandidate(fileId, "active") ?? await steps.readCandidate(fileId, "archive");
  if (existing && existing.status !== "proposed") {
    notes.push(`Kept ${existing.status} candidate ${candidate.id} (re-extraction did not overwrite it).`);
    return false;
  }
  const invalid = validateRuleCandidate(candidate);
  if (invalid) {
    notes.push(`Dropped candidate ${candidate.id}: ${invalid}`);
    return false;
  }
  await steps.writeCandidate(candidate);
  return true;
}
