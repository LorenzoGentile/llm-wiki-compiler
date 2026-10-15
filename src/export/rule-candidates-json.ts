/**
 * Rule-candidate JSON export (rule pipeline).
 *
 * Emits the persisted `RuleCandidate` records as a JSON array for a downstream rule importer
 * to import. The array element shape is the canonical the rule importer contract verbatim
 * — camelCase keys, tagged evidence, lowercase status/confidence — because the
 * on-disk candidates are already stored in that shape. Export is a pure read +
 * filter + serialize with no LLM calls.
 *
 * Approved candidates remain in `.llmwiki/rule-candidates/` with `status:
 * "approved"` (only rejects are archived out), so export reads the live
 * candidate directory and filters by status scope.
 *
 * The scope selection is ONE BODY, {@link collectRuleCandidatesForExportFrom},
 * over a supplied listing that takes no project root; the root form hands it the
 * incumbent listing for its root.
 */

import { listRuleCandidates } from "../compiler/rule-candidates.js";
import type { RuleCandidate } from "../utils/rule-types.js";

/** Which candidates to include in an export. */
export type RuleExportScope = "approved" | "proposed" | "all";

/** Valid export scopes, used to validate CLI input. */
export const RULE_EXPORT_SCOPES: readonly RuleExportScope[] = [
  "approved",
  "proposed",
  "all",
];

/**
 * Collect rule candidates for export, filtered by status scope. Ordering is
 * the deterministic createdAt-then-id order from {@link listRuleCandidates}.
 *
 * @param root - Project root directory.
 * @param scope - "approved" (default), "proposed", or "all".
 * @returns The candidates matching the scope.
 */
export async function collectRuleCandidatesForExport(
  root: string,
  scope: RuleExportScope = "approved",
): Promise<RuleCandidate[]> {
  return collectRuleCandidatesForExportFrom(() => listRuleCandidates(root), scope);
}

/**
 * {@link collectRuleCandidatesForExport} over a supplied listing: THE ONE BODY.
 * `all` keeps the listing whole and in its order; any other scope keeps the
 * candidates with that status, in listing order. It reads the listing once and
 * writes nothing.
 *
 * @param listCandidates - Every persisted rule candidate, in listing order.
 * @param scope - "approved" (default), "proposed", or "all".
 */
export async function collectRuleCandidatesForExportFrom(
  listCandidates: () => Promise<RuleCandidate[]>,
  scope: RuleExportScope = "approved",
): Promise<RuleCandidate[]> {
  const all = await listCandidates();
  if (scope === "all") return all;
  return all.filter((c) => c.status === scope);
}

/**
 * Serialize rule candidates as a pretty-printed JSON array string.
 * @param candidates - Candidates to serialize.
 * @returns JSON array string matching the rule importer's RuleCandidate[] contract.
 */
export function buildRuleCandidatesJson(candidates: RuleCandidate[]): string {
  return `${JSON.stringify(candidates, null, 2)}\n`;
}
