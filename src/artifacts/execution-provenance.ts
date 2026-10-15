/**
 * @file src/artifacts/execution-provenance.ts
 * @description The write-time EXECUTION-PROVENANCE verifier — the optional arm of an
 * artifact-existence precondition (`ArtifactPreconditionReq.executionProvenance`)
 * that requires the pinned artifact's BYTES to have been admitted as provider
 * output of a real, settled preparation run. Invoked from the same
 * gated-state-entry authority as the health check (`./enforce-precondition.ts`),
 * never a second enforcement home.
 *
 * WHAT IT COMPARES: the pinned artifact digest against the ADMITTED EVIDENCE of a
 * run whose sealed plan carries the declared action id, whose frozen input names
 * this entity's slug under the declared field, and whose terminal state is EXACTLY
 * `succeeded` — never cancelled, abandoned, or failed. The matching evidence ref
 * must be `kind=provider-output` under the declared output id (its
 * `provenanceLabel`) with a provider producer, which is how admission records
 * attempt correlation. "Any admitted digest" would be TOO BROAD: an initial-input
 * ref or an unrelated provider artifact must never vouch for a result.
 *
 * FAIL CLOSED, with the deny/park split the sibling health check already speaks:
 * a store problem, a truncated scan, or an unreadable sealed input is "could not
 * verify" (park), never a pass and never silently narrowed to "no such run"
 * (deny). Only a clean scan with no vouching run denies.
 *
 * GENERIC BY CONSTRUCTION: this module speaks action ids, input fields, and
 * provider output ids — the plan's own vocabulary — and knows nothing about any
 * product's entities.
 *
 * ONE BODY: {@link verifyExecutionProvenance} runs
 * {@link verifyExecutionProvenanceFrom} over the local disk. The three store
 * reads are ASKED FOR through {@link ExecutionProvenanceReads}, which takes no
 * project root, so every conjunct can be witnessed against synthetic runs.
 *
 * WHAT ANSWERS THOSE THREE READS IS COMPOSED, NOT A ROOT CLOSURE.
 * {@link executionProvenanceReadsOver} builds them from the preparation
 * store's RAW LEAF READS (`preparations/store-leaf-reads.ts`): the inventory
 * scan, the run lookup, the sealed-input read and, under them, the store walk
 * and the manifest, key, run and evidence readers each run their one body over
 * the leaves they are handed. So the verifier and every decision under it,
 * the run's authentication included, run on whatever serves those leaves. On
 * disk the leaves are the same confined readers as before, asked in the same
 * order.
 *
 * ONE PART IS NOT A LEAF AND IS NOT MADE NEUTRAL: the lifecycle read the scan
 * borrows, and the proof that it is genuine. Both stay ROOT-BOUND LOCAL-DISK
 * AUTHORITY, carried as one named member of the leaf reads. That is a
 * deferment, not an accepted mechanism.
 *
 * WHO RUNS IT OVER LEAVES. The artifact health check
 * (`profile/artifact-lint.ts`) runs {@link verifyExecutionProvenanceFrom} over
 * {@link executionProvenanceReadsOver} the leaves it is handed, for lint, the
 * profile summary and the viewer snapshot; on disk those are
 * `diskPreparationStoreLeafReads(root)`. The write-time precondition
 * (`enforce-precondition.ts`) still calls the root form
 * {@link verifyExecutionProvenance}.
 */

import type { PreparationManifestV1 } from "../preparations/manifest-parse.js";
import {
  readPreparationInitialInputFrom, resolvePreparationRunFrom,
  type PreparationInitialInputLookupV1, type PreparationRunLookupV1,
} from "../preparations/service-run-lookup.js";
import {
  diskPreparationStoreLeafReads, preparationRunLookupReadsOver, type PreparationStoreLeafReads,
} from "../preparations/store-leaf-reads.js";
import type { ExecutionProvenanceReq } from "../profile/types.js";

/** The three-way outcome, matching the health check's deny/park vocabulary. */
export interface ExecutionProvenanceVerdictV1 {
  readonly verdict: "pass" | "deny" | "park";
  readonly detail: string;
}

/**
 * The three reads the verifier asks of the preparation store. OWNED BY THE
 * VERIFIER: a narrow seam, not `ProjectStore`, not a hosted or access-control
 * contract. No read takes a project root. Each is asked afresh every time:
 * nothing is remembered between candidates, and nothing makes two reads agree.
 */
export interface ExecutionProvenanceReads {
  /** The store's manifests and its scan problems. A REJECTION here is the one failure the verifier turns into a park. */
  scanInventory(): Promise<{ manifests: readonly PreparationManifestV1[]; problems: readonly unknown[] }>;
  /** One candidate's sealed initial input. A rejection propagates. */
  readInitialInput(manifest: PreparationManifestV1): Promise<PreparationInitialInputLookupV1>;
  /** One candidate's run, by id. A rejection propagates. */
  resolveRun(runId: string): Promise<PreparationRunLookupV1>;
}

/**
 * The verifier's three reads over the preparation store's raw leaf reads: THE
 * ONE COMPOSITION, used by the local disk and by any other supplier of leaves.
 * Each read is the store's own body over those leaves, with the arguments the
 * verifier always passed. Building them does no I/O. The run lookup scans the
 * inventory again on every call, as it always did. In no package index.
 *
 * @param leaves - The store's raw leaf reads, and its lifecycle authority.
 * @returns The inventory scan, the sealed-input read and the run lookup.
 */
export function executionProvenanceReadsOver(leaves: PreparationStoreLeafReads): ExecutionProvenanceReads {
  const lookup = preparationRunLookupReadsOver(leaves);
  return {
    scanInventory: () => lookup.scanInventory(),
    readInitialInput: (manifest) => readPreparationInitialInputFrom(lookup, manifest),
    resolveRun: (runId) => resolvePreparationRunFrom(lookup, runId),
  };
}

/** LOCAL DISK. The production reads for the project at `root`: {@link executionProvenanceReadsOver} the store's own disk leaves. Module-private; in no package index. */
function diskExecutionProvenanceReads(root: string): ExecutionProvenanceReads {
  return executionProvenanceReadsOver(diskPreparationStoreLeafReads(root));
}

/** One candidate's contribution: it vouches, it was unreadable, or it is out. */
type CandidateOutcome = "vouches" | "unreadable" | "no-match";

/** Whether one candidate run vouches for the pinned digest (see file overview). */
async function candidateOutcome(
  reads: ExecutionProvenanceReads, manifest: PreparationManifestV1,
  req: ExecutionProvenanceReq, slug: string, pinnedDigest: string,
): Promise<CandidateOutcome> {
  const input = await reads.readInitialInput(manifest);
  if (!input.ok) return "unreadable";
  if (input.record[req.slugInputField] !== slug) return "no-match";
  const resolved = await reads.resolveRun(manifest.runId);
  if (!resolved.ok) return resolved.failure === "unavailable" ? "unreadable" : "no-match";
  if (resolved.run.state !== "succeeded") return "no-match";
  const vouches = resolved.run.evidenceRefs.some((ref) =>
    ref.kind === "provider-output"
    && ref.provenanceLabel === req.resultOutputId
    && ref.producer.kind === "provider"
    && ref.digest === pinnedDigest);
  return vouches ? "vouches" : "no-match";
}

/**
 * {@link verifyExecutionProvenance} over {@link ExecutionProvenanceReads}: THE
 * ONE BODY, and the seam every conjunct is witnessed through. The scan; then
 * each candidate of the declared action in inventory order, its sealed input
 * before its run; the first that vouches ends the reading.
 */
export async function verifyExecutionProvenanceFrom(
  reads: ExecutionProvenanceReads, req: ExecutionProvenanceReq, slug: string, pinnedDigest: string,
): Promise<ExecutionProvenanceVerdictV1> {
  let inventory: Awaited<ReturnType<ExecutionProvenanceReads["scanInventory"]>>;
  try {
    inventory = await reads.scanInventory();
  } catch (error) {
    return { verdict: "park", detail: `the preparation store could not be scanned: ${(error as Error).message}` };
  }
  // FAIL CLOSED on a degraded scan: a truncated or problem-bearing inventory may
  // have DROPPED the vouching run, so "not found" would be could-not-see.
  if (inventory.problems.length > 0) {
    return { verdict: "park", detail: `the preparation inventory reported ${inventory.problems.length} problem(s); provenance cannot be verified` };
  }
  let unreadable = 0;
  for (const manifest of inventory.manifests) {
    if (manifest.plan.actionAuthority.actionId !== req.actionId) continue;
    const outcome = await candidateOutcome(reads, manifest, req, slug, pinnedDigest);
    if (outcome === "vouches") {
      return { verdict: "pass", detail: `run ${manifest.runId} admitted the pinned bytes under output '${req.resultOutputId}'` };
    }
    if (outcome === "unreadable") unreadable += 1;
  }
  // A candidate that could not be READ may be the vouching one: park, not deny.
  if (unreadable > 0) {
    return { verdict: "park", detail: `${unreadable} candidate run(s) could not be read; provenance cannot be verified` };
  }
  return {
    verdict: "deny",
    detail: `no succeeded '${req.actionId}' run with ${req.slugInputField}=${JSON.stringify(slug)} admitted the pinned bytes under output '${req.resultOutputId}'`,
  };
}

/**
 * Verify one execution-provenance arm for a pinned artifact digest.
 *
 * @param root - Absolute project root (the caller already holds its lock; every
 *   read here is lock-free).
 * @param req - The declared arm: action id, slug input field, result output id.
 * @param slug - The transitioning entity's slug.
 * @param pinnedDigest - The pinned artifact's `sha256:<hex>` digest.
 * @returns pass when a succeeded matching run admitted exactly these bytes under
 *   the declared output; park when the store could not be verified; deny otherwise.
 */
export async function verifyExecutionProvenance(
  root: string, req: ExecutionProvenanceReq, slug: string, pinnedDigest: string,
): Promise<ExecutionProvenanceVerdictV1> {
  // `async` so that a throw while the disk reads are built REJECTS.
  return verifyExecutionProvenanceFrom(diskExecutionProvenanceReads(root), req, slug, pinnedDigest);
}
