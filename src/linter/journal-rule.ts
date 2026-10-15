/**
 * @file src/linter/journal-rule.ts
 * @description The `journal-health` lint rule. SURFACES a pending/unavailable
 * compile journal as a lint `warning`, so `llmwiki lint` (and the `lint_wiki`
 * MCP tool / SDK `lint`) never reports a project clean while an incomplete or
 * tampered compile left partial post-crash state on disk. Threads the SHARED
 * read-only {@link journalHealthWarning} mapper into the linter's existing
 * `LintResult` channel — mirroring how the other read surfaces surface the same
 * signal. Read-only: emits a diagnostic only, never replays/prunes the journal.
 *
 * A healthy (`ok`) journal yields zero findings, so the default lint output
 * stays byte-identical (parity-safe).
 *
 * `checkJournalHealthFrom` is THE ONE BODY and holds no project root; the
 * root-taking `checkJournalHealth` builds the local disk journal sources for
 * that one call and delegates.
 */

import { diskJournalReadSources, type JournalReadSources } from "../trust/journal-classify.js";
import { journalHealthWarningFrom } from "../trust/journal-health-warning.js";
import { LLMWIKI_DIR } from "../utils/constants.js";
import type { LintResult } from "./types.js";

/** Project-relative path the `journal-health` finding points at. */
const JOURNAL_REL_PATH = `${LLMWIKI_DIR}/journal`;

/**
 * Emit a `journal-health` warning when the compile journal is pending or
 * unavailable. The finding's `message` is prefixed with the stable warning code
 * (`incomplete-compile` / `journal-unavailable`) so scripted consumers can branch
 * on it without parsing the human-readable tail.
 *
 * @param root - Absolute path to the project root directory.
 * @returns A single-element result list when degraded; empty when healthy.
 */
export async function checkJournalHealth(root: string): Promise<LintResult[]> {
  return checkJournalHealthFrom(diskJournalReadSources(root));
}

/** {@link checkJournalHealth} through `sources`: THE ONE BODY. */
export async function checkJournalHealthFrom(sources: JournalReadSources): Promise<LintResult[]> {
  const warning = await journalHealthWarningFrom(sources);
  if (warning === null) return [];
  return [
    {
      rule: "journal-health",
      severity: "warning",
      file: JOURNAL_REL_PATH,
      message: `${warning.code}: ${warning.message}`,
    },
  ];
}
