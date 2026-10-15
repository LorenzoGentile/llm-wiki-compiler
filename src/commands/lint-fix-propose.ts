/**
 * @file src/commands/lint-fix-propose.ts
 * @description `lint --fix-propose <n>`: turn the nth deterministic lint fix into
 * a reviewable PROPOSAL rather than applying it. It applies the fix's edit to the
 * current target page in memory, captures the page's content hash, and stages a
 * review candidate — writing NOTHING to `wiki/`. The operator applies it later
 * with `review approve <id>`, which is REFUSED if the target page changed since
 * the proposal (the stale-state guard), so a stale fix never clobbers newer
 * content. It is a thin bridge onto the existing reviewed mutation path; it does
 * not itself apply.
 *
 * WHAT IS DECIDED and WHAT IS STAGED are separate. Which fix the number names,
 * whether its page can be routed, the one page read and the exact draft are
 * `linter/fix-proposal.ts`, over sources. THIS module is the root-only half: it
 * takes the project lock and passes the recovery gate, asks for the proposal,
 * prints a refusal or stages the draft through the existing candidate writer,
 * and releases the lock. The lock, the gate and the candidate store are
 * root-taking calls here, as before; they are not migrated.
 */

import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { releaseLock } from "../utils/lock.js";
import { diskLintFixProposalSources, proposeLintFixFrom } from "../linter/fix-proposal.js";
import { writeCandidate } from "../compiler/candidates.js";
import * as output from "../utils/output.js";

/**
 * Stage the nth deterministic fix as a review candidate.
 * @param n - 1-based index into the fixable findings (as `--fix-preview` numbers them).
 * @returns Process exit code: 0 on a staged proposal, 1 when `n` names no fix.
 */
export async function lintFixProposeCommand(n: number): Promise<number> {
  const root = process.cwd();
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    return await proposeLocked(root, n);
  } finally {
    await releaseLock(root);
  }
}

/** Under the lock: ask for the proposal, then print its refusal or stage its draft. */
async function proposeLocked(root: string, n: number): Promise<number> {
  const proposal = await proposeLintFixFrom(diskLintFixProposalSources(root), n);
  if (proposal.kind === "refused") {
    output.status("!", output.error(proposal.message));
    return 1;
  }
  const { edit } = proposal;
  const candidate = await writeCandidate(root, proposal.draft);
  output.status("→", output.info(
    `Proposed fix for ${edit.file}:${edit.line} as review candidate ${output.source(candidate.id)}. ` +
      `Apply with: llmwiki review approve ${candidate.id}`,
  ));
  return 0;
}
