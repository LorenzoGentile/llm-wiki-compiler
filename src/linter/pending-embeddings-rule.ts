/**
 * @file src/linter/pending-embeddings-rule.ts
 * @description The `pending-embeddings` lint rule. SURFACES the durable
 * pending-embedding refresh marker as a lint `warning`, so `llmwiki lint` (and the
 * `lint_wiki` MCP tool / SDK `lint`) reports when a compile skipped/failed its
 * embeddings refresh — making the otherwise-invisible "N pages have stale
 * embeddings pending retry" state discoverable and the "re-run compile" remedy
 * actionable. Threads the SHARED read-only {@link pendingEmbeddingsWarning} mapper
 * into the linter's existing `LintResult` channel, MIRRORING `checkJournalHealth`.
 * Read-only: emits a diagnostic only, never drains the marker.
 *
 * An empty marker (the default) yields zero findings, so the default lint output
 * stays byte-identical (parity-safe).
 *
 * `checkPendingEmbeddingsFrom` is THE ONE BODY and holds no project root; the
 * root-taking `checkPendingEmbeddings` builds the local disk marker reads for
 * that one call and delegates. Both warnings are asked together, as before,
 * and each still makes its own two marker reads.
 */

import { pendingEmbeddingsWarningFrom } from "../trust/pending-embeddings-warning.js";
import { quarantinedEmbeddingsWarningFrom } from "../trust/quarantined-embeddings-warning.js";
import { diskEmbeddingMarkerReads, type EmbeddingMarkerReads } from "../utils/pending-embeddings.js";
import { PENDING_EMBEDDINGS_FILE } from "../utils/constants.js";
import type { LintResult } from "./types.js";

/**
 * Emit a `pending-embeddings` warning when the durable refresh marker is
 * non-empty. The finding's `message` is prefixed with the stable warning code
 * (`embeddings-refresh-pending`) so scripted consumers can branch on it without
 * parsing the human-readable tail.
 *
 * Also emits `quarantined-embeddings` for stopped retries or unreadable quarantine.
 * @param root - Absolute path to the project root directory.
 * @returns Separate pending and quarantine warnings; empty when neither needs attention.
 */
export async function checkPendingEmbeddings(root: string): Promise<LintResult[]> {
  return checkPendingEmbeddingsFrom(diskEmbeddingMarkerReads(root));
}

/** {@link checkPendingEmbeddings} through `reads`: THE ONE BODY. */
export async function checkPendingEmbeddingsFrom(reads: EmbeddingMarkerReads): Promise<LintResult[]> {
  const [warning, quarantine] = await Promise.all([
    pendingEmbeddingsWarningFrom(reads), quarantinedEmbeddingsWarningFrom(reads),
  ]);
  const results: LintResult[] = [];
  if (warning) results.push({
    rule: "pending-embeddings",
    severity: "warning",
    file: PENDING_EMBEDDINGS_FILE,
    message: `${warning.code}: ${warning.message}`,
  });
  if (quarantine) results.push({
    rule: "quarantined-embeddings",
    severity: "warning",
    file: quarantine.file,
    message: `${quarantine.code}: ${quarantine.message}`,
  });
  return results;
}
