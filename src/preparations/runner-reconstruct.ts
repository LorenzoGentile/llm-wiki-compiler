/**
 * @file src/preparations/runner-reconstruct.ts
 * @description The restart/reconstruct read-and-assemble leg of the host runner
 * (runner design v3 §3.4): read the persisted materialization manifest and its
 * payloads back out of the durable evidence store (R1), and assemble the
 * {@link PreparationHandoffRequestV1} purely from that persisted material plus the
 * caller's capabilities. Extracted from `runner.ts` so the driver module stays
 * within the size limit; it holds NO orchestration — `reconstructAndHandoff` still
 * owns the sequencing and calls these pure readers/assemblers.
 *
 * Only TYPES are imported from `runner.ts` (the input + the internal test-fault
 * shape), so there is no runtime import cycle: the runner imports these functions
 * as values; this module imports nothing executable from the runner.
 *
 * ONE BODY EACH over {@link RunEvidenceBytes}, the verified evidence read at the
 * run's own location: {@link readManifestBackFrom} and {@link readPayloadsBackFrom}.
 * The input-taking forms keep their signatures and pass {@link diskRunEvidenceBytes},
 * which asks the incumbent root reader; {@link runEvidenceBytesOver} asks the
 * evidence store's own body over its leaf. Neither body sees a project root.
 */

import {
  readPreparationEvidenceBytes, readPreparationEvidenceBytesFrom,
  type PreparationEvidenceBytesRead, type PreparationEvidenceLeafReads, type PreparationEvidenceLocation,
} from "./evidence-store.js";
import {
  parseMaterializationManifest, toOperationEvidenceRef,
  type MaterializationResultV1, type PreparationHandoffMaterializationV1,
} from "./materialization.js";
import type { PreparationHandoffRequestV1 } from "./handoff.js";
import type { PreparationRunBinding, PreparationRunV1 } from "./run-types.js";
import type { RunPreparationInputV1, RunnerFaultsForTestV1 } from "./runner.js";

/** One verified evidence read (bare digest, required cap) at the run's own location. No member takes a project root. */
export type RunEvidenceBytes = (digest: string, maxBytes: number) => Promise<PreparationEvidenceBytesRead>;

/** The evidence location a run binding names. */
export function evidenceLocationOf(binding: PreparationRunBinding): PreparationEvidenceLocation {
  return { workspaceId: binding.workspaceId, preparationId: binding.preparationId };
}

/**
 * LOCAL DISK, for one read-back operation. The location is taken ONCE, when the
 * operation's facade builds this reader, and the root is read lazily at each
 * read: exactly the incumbent's timing, which took the location before its read
 * (or before its payload loop) and the root at every call.
 */
function diskRunEvidenceBytes(input: RunPreparationInputV1): RunEvidenceBytes {
  const location = evidenceLocationOf(input.binding);
  return (digest, maxBytes) => readPreparationEvidenceBytes(input.root, location, digest, maxBytes);
}

/** The same read over the evidence store's own leaf, at `binding`'s location. Building it does no I/O. */
export function runEvidenceBytesOver(leaves: PreparationEvidenceLeafReads, binding: PreparationRunBinding): RunEvidenceBytes {
  const location = evidenceLocationOf(binding);
  return (digest, maxBytes) => readPreparationEvidenceBytesFrom(leaves, location, digest, maxBytes);
}

/** R1-read the manifest bytes (prefixed run digest → bare CAS key) and parse. */
export async function readManifestBack(
  input: RunPreparationInputV1, digest: string, cap: number,
): Promise<PreparationHandoffMaterializationV1 | string> {
  return readManifestBackFrom(diskRunEvidenceBytes(input), digest, cap);
}

/** {@link readManifestBack} over {@link RunEvidenceBytes}: THE ONE BODY. */
export async function readManifestBackFrom(
  evidence: RunEvidenceBytes, digest: string, cap: number,
): Promise<PreparationHandoffMaterializationV1 | string> {
  const bare = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  const bytes = await evidence(bare, cap);
  if (bytes.status !== "ok") return `manifest evidence ${bytes.status}`;
  try {
    return parseMaterializationManifest(bytes.bytes);
  } catch (cause) {
    return `manifest unparseable: ${(cause as Error).message}`;
  }
}

/** R1-read every payload the manifest references, keyed by bare CAS digest. */
export async function readPayloadsBack(
  input: RunPreparationInputV1, body: MaterializationResultV1, cap: number,
): Promise<Map<string, Buffer> | string> {
  return readPayloadsBackFrom(diskRunEvidenceBytes(input), body, cap);
}

/** {@link readPayloadsBack} over {@link RunEvidenceBytes}: THE ONE BODY. One read per payload, in manifest order; the first refusal stops. */
export async function readPayloadsBackFrom(
  evidence: RunEvidenceBytes, body: MaterializationResultV1, cap: number,
): Promise<Map<string, Buffer> | string> {
  const payloads = new Map<string, Buffer>();
  for (const ref of body.payloadRefs) {
    const bytes = await evidence(ref.digest, cap);
    if (bytes.status !== "ok") return `payload ${ref.digest} ${bytes.status}`;
    payloads.set(ref.digest, bytes.bytes);
  }
  return payloads;
}

/** Assemble the handoff request purely from persisted material plus capabilities. It reads no project root. */
export function handoffRequest(
  input: Omit<RunPreparationInputV1, "root">, run: PreparationRunV1,
  manifest: PreparationHandoffMaterializationV1, payloads: Map<string, Buffer>,
  faults: RunnerFaultsForTestV1 | undefined,
): PreparationHandoffRequestV1 {
  const body = manifest.body;
  const payloadDigests = new Set(payloads.keys());
  return {
    binding: input.binding,
    compilation: {
      adapters: input.adapters, contract: input.policyContract,
      targets: body.targets as never, proposals: body.proposals as never,
      reconciliations: body.reconciliations as never, selections: body.selections as never,
      completeness: body.completeness as never,
      ...(body.requiredProposalIds === undefined ? {} : { requiredProposalIds: body.requiredProposalIds }),
    },
    authorities: {
      grantDigest: manifest.grantDigest as never,
      inputs: body.authorityInputs as never, bounds: body.authorityBounds as never,
      operationRun: {
        declaredCompensatorIndexes: body.operationRun.declaredCompensatorIndexes as never,
        controlTransitionAllowance: body.operationRun.controlTransitionAllowance as never,
        actor: manifest.actor as never,
      },
    },
    preparationEvidence: run.evidenceRefs.map((ref) => toOperationEvidenceRef(ref, payloadDigests)),
    payloads,
    actor: input.principal, at: input.clock.now(),
    // Unit G: the materializer's superseding local intent, validated at capture,
    // threaded into the handoff so the bundle records which prior bundle it supersedes.
    ...(body.supersedesBundleId === undefined ? {} : { supersedesBundleId: body.supersedesBundleId }),
    // TEST-ONLY: thread the after-stage crash seam into the hand-off's own boundary
    // so a partial hand-off (`handoff-started`) is produced through the real path.
    ...(faults?.afterStage === undefined ? {} : { faultsForTest: { afterStage: faults.afterStage } }),
  };
}
