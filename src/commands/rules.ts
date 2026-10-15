/**
 * Commander actions for `llmwiki rules …` (rule pipeline).
 *
 * The rule-candidate lifecycle mirrors the concept review flow but emits
 * structured `RuleCandidate` records for a downstream rule importer instead of prose pages:
 *
 *   rules extract            — LLM-extract rules from changed sources into
 *                              .llmwiki/rule-candidates/<id>.json (status proposed)
 *   rules list               — list pending candidates
 *   rules approve <id>       — flip status → approved (in place)
 *   rules reject  <id>       — flip status → rejected, archive out of pending
 *   rules export [--scope]   — write the candidate array as JSON for the rule importer
 *
 * Mutations run under `.llmwiki/lock` to serialize against a concurrent
 * extract/approve/reject, matching the concept review lock discipline.
 *
 * ONE BODY PER SUBCOMMAND, NO ROOT. Each `…CommandWith` owns its decisions (the
 * no-sources refusal, the not-found precheck before the lock, the lock refusal,
 * reject as status-then-archive, the export scope and write) over
 * {@link RulesCommandSteps}. Each root form keeps its signature, reads the
 * working directory as before, and passes the local steps, which call the
 * incumbent root forms when asked (so module spies and mocks still intercept).
 */

import path from "path";
import { writeLeafAtomicUnconfined } from "../storage/disk-guarded-leaves.js";
import { locationExistsSync } from "../storage/disk-locations.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import * as output from "../utils/output.js";
import { SOURCES_DIR } from "../utils/constants.js";
import {
  extractRuleCandidates,
  type RuleExtractionResult,
} from "../compiler/rule-extractor.js";
import {
  archiveRuleCandidate,
  readRuleCandidate,
  setRuleCandidateStatus,
} from "../compiler/rule-candidates.js";
import { candidateFileId } from "../utils/candidate-store.js";
import {
  RULE_EXPORT_SCOPES,
  buildRuleCandidatesJson,
  collectRuleCandidatesForExport,
  type RuleExportScope,
} from "../export/rule-candidates-json.js";

/** Default output path (relative to root) for `rules export`. */
const RULE_EXPORT_PATH = "dist/exports/rule-candidates.json";

/** The project steps the rules subcommands take. No member takes a project root. */
export interface RulesCommandSteps {
  /** Whether the sources directory exists, answered at once. */
  sourcesPresent(): boolean;
  /** Take the project mutation lock without blocking; false when another process holds it. */
  acquireLock(): Promise<boolean>;
  /** Release the project lock. */
  releaseLock(): Promise<void>;
  /** Extract rule candidates from the changed sources. */
  extract(): Promise<RuleExtractionResult>;
  /** The candidates in `scope`, as the export orders them. */
  collect(scope: RuleExportScope): ReturnType<typeof collectRuleCandidatesForExport>;
  /** One pending candidate, or null. */
  readCandidate(fileId: string): ReturnType<typeof readRuleCandidate>;
  /** Set one candidate's status; null when it is gone. */
  setStatus(fileId: string, status: "approved" | "rejected"): ReturnType<typeof setRuleCandidateStatus>;
  /** Move one candidate out of the pending store. */
  archive(fileId: string): Promise<boolean>;
  /** Write the export's text; resolves to where it was written, as reported. */
  writeExport(text: string): Promise<string>;
}

/** LOCAL DISK. The incumbent root forms for `root`, each called when asked. */
function localRulesSteps(root: string): RulesCommandSteps {
  return {
    sourcesPresent: () => locationExistsSync(path.join(root, SOURCES_DIR)),
    acquireLock: () => acquireMutationLock(root, "ordinary"),
    releaseLock: () => releaseLock(root),
    extract: () => extractRuleCandidates(root),
    collect: (scope) => collectRuleCandidatesForExport(root, scope),
    readCandidate: (fileId) => readRuleCandidate(root, fileId),
    setStatus: (fileId, status) => setRuleCandidateStatus(root, fileId, status),
    archive: (fileId) => archiveRuleCandidate(root, fileId),
    writeExport: async (text) => {
      const outPath = path.join(root, RULE_EXPORT_PATH);
      await writeLeafAtomicUnconfined(outPath, text);
      return outPath;
    },
  };
}

/**
 * Extract rule candidates from changed sources. Requires the sources/ folder
 * and an available provider (the caller's CLI guard enforces the latter).
 */
export async function rulesExtractCommand(): Promise<void> {
  return rulesExtractCommandWith(localRulesSteps(process.cwd()));
}

/** {@link rulesExtractCommand} over {@link RulesCommandSteps}: THE ONE BODY. */
export async function rulesExtractCommandWith(steps: RulesCommandSteps): Promise<void> {
  if (!steps.sourcesPresent()) {
    output.status("!", output.warn("No sources found. Run `llmwiki ingest <url>` first."));
    return;
  }

  const locked = await steps.acquireLock();
  if (!locked) {
    output.status("!", output.error("Could not acquire lock. Try again later."));
    process.exitCode = 1;
    return;
  }
  try {
    output.header("Extracting rule candidates");
    reportExtraction(await steps.extract());
  } finally {
    await steps.releaseLock();
  }
}

/** Print extraction notes, each candidate, and a one-line summary. */
function reportExtraction(result: RuleExtractionResult): void {
  for (const note of result.notes) output.status("i", output.dim(note));
  for (const candidate of result.candidates) {
    output.status("?", output.info(`Rule candidate ready: ${candidate.id}`));
  }
  output.status(
    "✓",
    output.success(
      `${result.candidates.length} rule candidate(s) from ${result.processedSources.length} source(s).`,
    ),
  );
}

/** List pending rule candidates with their proposed-rule summary line. */
export async function rulesListCommand(): Promise<void> {
  return rulesListCommandWith(localRulesSteps(process.cwd()));
}

/** {@link rulesListCommand} over {@link RulesCommandSteps}: THE ONE BODY. */
export async function rulesListCommandWith(steps: RulesCommandSteps): Promise<void> {
  const pending = await steps.collect("proposed");
  if (pending.length === 0) {
    output.status("i", output.dim("No pending rule candidates."));
    return;
  }
  for (const c of pending) {
    output.status(
      "?",
      output.info(`${c.id} [${c.confidence}] — ${c.proposed.title}`),
    );
  }
}

/** Approve a candidate by flipping its status to "approved" under the lock. */
export async function rulesApproveCommand(id: string): Promise<void> {
  return rulesApproveCommandWith(localRulesSteps(process.cwd()), id);
}

/** {@link rulesApproveCommand} over {@link RulesCommandSteps}: THE ONE BODY. */
export async function rulesApproveCommandWith(steps: RulesCommandSteps, id: string): Promise<void> {
  await mutateUnderLock(steps, id, async (fileId) => {
    const updated = await steps.setStatus(fileId, "approved");
    if (!updated) return false;
    output.status("+", output.success(`Approved rule candidate ${updated.id}.`));
    return true;
  });
}

/** Reject a candidate: flip status to "rejected" then archive it out of pending. */
export async function rulesRejectCommand(id: string): Promise<void> {
  return rulesRejectCommandWith(localRulesSteps(process.cwd()), id);
}

/** {@link rulesRejectCommand} over {@link RulesCommandSteps}: THE ONE BODY. Status first, then the archive. */
export async function rulesRejectCommandWith(steps: RulesCommandSteps, id: string): Promise<void> {
  await mutateUnderLock(steps, id, async (fileId) => {
    const updated = await steps.setStatus(fileId, "rejected");
    if (!updated) return false;
    await steps.archive(fileId);
    output.status("-", output.warn(`Rejected rule candidate ${updated.id} — archived.`));
    return true;
  });
}

/**
 * Export rule candidates as a JSON array for the rule importer. Defaults to approved-only;
 * `--scope proposed|all` widens the selection. Writes to
 * dist/exports/rule-candidates.json.
 */
export async function rulesExportCommand(options: { scope?: string } = {}): Promise<void> {
  return rulesExportCommandWith(localRulesSteps(process.cwd()), options);
}

/** {@link rulesExportCommand} over {@link RulesCommandSteps}: THE ONE BODY. The scope is resolved before any read. */
export async function rulesExportCommandWith(steps: RulesCommandSteps, options: { scope?: string } = {}): Promise<void> {
  const scope = resolveScope(options.scope);
  const candidates = await steps.collect(scope);
  const outPath = await steps.writeExport(buildRuleCandidatesJson(candidates));
  output.status(
    "+",
    output.success(`Exported ${candidates.length} rule candidate(s) → ${output.source(outPath)}`),
  );
}

/** Validate the --scope flag, defaulting to "approved". Throws on bad input. */
function resolveScope(raw: string | undefined): RuleExportScope {
  if (!raw) return "approved";
  if (!(RULE_EXPORT_SCOPES as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown --scope value "${raw}". Valid: ${RULE_EXPORT_SCOPES.join(", ")}`,
    );
  }
  return raw as RuleExportScope;
}

/**
 * Shared approve/reject skeleton: pre-check the candidate exists, acquire the
 * lock, re-read under it (TOCTOU guard), run the mutation, release. Sets exit
 * code 1 when the candidate is missing at either check.
 */
async function mutateUnderLock(
  steps: RulesCommandSteps,
  id: string,
  underLock: (fileId: string) => Promise<boolean>,
): Promise<void> {
  const fileId = candidateFileId(id);

  const preCheck = await steps.readCandidate(fileId);
  if (!preCheck) {
    output.status("!", output.error(`Rule candidate not found: ${id}`));
    process.exitCode = 1;
    return;
  }

  const locked = await steps.acquireLock();
  if (!locked) {
    output.status("!", output.error("Could not acquire lock. Try again later."));
    process.exitCode = 1;
    return;
  }
  try {
    const ok = await underLock(fileId);
    if (!ok) {
      output.status("!", output.error(`Rule candidate ${id} was removed during review.`));
      process.exitCode = 1;
    }
  } finally {
    await steps.releaseLock();
  }
}
