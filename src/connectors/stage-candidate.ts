/**
 * @file src/connectors/stage-candidate.ts
 * @description Stages one connector replacement and performs bounded,
 * observable in-process candidate restoration when staging throws. This is a
 * compensation boundary, not a journal or a power-loss transaction.
 *
 * ONE BODY, NO ROOT. {@link stageConnectorCandidateWith} owns the decisions: the
 * receipt batch captured under the policy cap, every archived predecessor
 * re-proved BEFORE staging, the staging request, and the compensation meaning
 * (recovery-required is returned; anything else rethrows the staging error). It
 * runs over {@link ConnectorStageSteps}. {@link stageConnectorCandidate} keeps its
 * signature and passes the local steps, built per call over its root, which call
 * the incumbent root forms when asked (so module spies and mocks still
 * intercept). {@link connectorStageStepsOver} composes the same steps from each
 * one's own root-free body: custody observation and restoration over the custody
 * reads, staging over the staging steps. In no package index.
 */

import { stageEntityPage, stageEntityPageWith, type EntityPageStagingSteps, type StageEntityPageInput } from "../trust/staging.js";
import {
  restoreArchivedCandidates,
  restoreArchivedCandidatesFrom,
  type CandidateMovePort,
  type CandidateSupersessionResult,
} from "./candidate-supersession.js";
import {
  ConnectorCandidateBatchOverflowError,
  connectorCandidateBatchLimit,
} from "./candidate-batch.js";
import { captureCandidateCustodyReceipts } from "../compiler/candidate-custody-snapshot.js";
import { CandidateCustodyUnavailableError, observeCandidateCustody, observeCandidateCustodyFrom,
  type CandidateCustodyReceipt, type CandidateCustodyState, type CandidateStoreMoveReads } from "../compiler/candidate-custody.js";
import type { ProfilePack } from "../profile/types.js";
import type { StagedChange } from "../trust/staged-change.js";
import type { ConnectorProvenance } from "./types.js";
import type { CandidateCustodyPolicy } from "../compiler/candidate-custody-limits.js";

/** Draft fields required by the typed connector staging seam. */
export interface ConnectorCandidateDraft {
  entityType: string;
  slug: string;
  body: string;
  provenance: ConnectorProvenance;
}

/** Closed internal staging result, including incomplete compensation. */
export type ConnectorCandidateStageResult =
  | { kind: "staged"; change: StagedChange }
  | { kind: "recovery-required"; candidateIds: readonly string[] };

/** The three project steps one connector staging takes, for ONE project. No member takes a project root. */
export interface ConnectorStageSteps {
  /** Observe one retained predecessor's custody state. */
  observeCustody(receipt: CandidateCustodyReceipt, policy: CandidateCustodyPolicy): Promise<CandidateCustodyState>;
  /** Stage the replacement page. */
  stage(input: StageEntityPageInput): Promise<StagedChange>;
  /** Restore every archived predecessor after a failed staging. */
  restore(receipts: readonly CandidateCustodyReceipt[], mover: CandidateMovePort | undefined, policy: CandidateCustodyPolicy): Promise<CandidateSupersessionResult>;
}

/** One staging request: the replacement, its profile, the retained predecessors and the run's seams. */
export interface ConnectorStageRequest {
  draft: ConnectorCandidateDraft;
  profile: ProfilePack;
  archivedReceipts: readonly CandidateCustodyReceipt[];
  mover?: CandidateMovePort;
  now?: () => Date;
  beforeStageForTest?: () => Promise<void>;
  policy: CandidateCustodyPolicy;
}

/** LOCAL DISK. The incumbent root forms for `root`, each called when asked; building them does no I/O. */
function diskConnectorStageSteps(root: string): ConnectorStageSteps {
  return {
    observeCustody: (receipt, policy) => observeCandidateCustody(root, receipt, policy),
    stage: (input) => stageEntityPage(root, input),
    restore: (receipts, mover, policy) => restoreArchivedCandidates(root, receipts, mover, policy),
  };
}

/**
 * The steps over each one's own root-free body: THE ONE BOUND COMPOSITION.
 * `moveRoot` is only the value the host's {@link CandidateMovePort} receives in
 * each move request's legacy field; it is never read here. Building it does no I/O.
 */
export function connectorStageStepsOver(seams: {
  custody: CandidateStoreMoveReads; staging: EntityPageStagingSteps; moveRoot: string;
}): ConnectorStageSteps {
  return {
    observeCustody: (receipt, policy) => observeCandidateCustodyFrom(seams.custody, receipt, policy),
    stage: (input) => stageEntityPageWith(seams.staging, input),
    restore: (receipts, mover, policy) => restoreArchivedCandidatesFrom(seams.custody, seams.moveRoot, receipts, mover, policy),
  };
}

/** Stage one replacement, restoring every archived filename identity on error. */
export async function stageConnectorCandidate(
  root: string,
  draft: ConnectorCandidateDraft,
  profile: ProfilePack,
  archivedReceipts: readonly CandidateCustodyReceipt[],
  mover?: CandidateMovePort,
  now?: () => Date,
  beforeStageForTest?: () => Promise<void>,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<ConnectorCandidateStageResult> {
  return stageConnectorCandidateWith(diskConnectorStageSteps(root), { draft, profile, archivedReceipts, mover, now, beforeStageForTest, policy });
}

/** {@link stageConnectorCandidate} over {@link ConnectorStageSteps}: THE ONE BODY. */
export async function stageConnectorCandidateWith(
  steps: ConnectorStageSteps, request: ConnectorStageRequest,
): Promise<ConnectorCandidateStageResult> {
  const { draft, policy } = request;
  const capturedReceipts = captureCandidateCustodyReceipts(
    request.archivedReceipts,
    connectorCandidateBatchLimit(policy),
    () => new ConnectorCandidateBatchOverflowError(),
    policy,
  );
  try {
    await request.beforeStageForTest?.();
    await assertArchivedPredecessors(steps, capturedReceipts, policy);
    const change = await steps.stage({
      entityType: draft.entityType,
      slug: draft.slug,
      body: draft.body,
      profile: request.profile,
      existingStagedCount: 0,
      now: request.now,
      reviewMode: "connector",
      heldReasons: [{ code: "connector-fetched" }],
      connectorProvenance: draft.provenance,
      freshCandidateId: capturedReceipts.length > 0,
    });
    return { kind: "staged", change };
  } catch (error) {
    const restored = await steps.restore(capturedReceipts, request.mover, policy);
    if (restored.kind === "recovery-required") return restored;
    throw error;
  }
}

/** Re-prove retained predecessors immediately before publishing their replacement. */
async function assertArchivedPredecessors(
  steps: ConnectorStageSteps, receipts: readonly CandidateCustodyReceipt[],
  policy: CandidateCustodyPolicy,
): Promise<void> {
  for (const receipt of receipts) {
    if (await steps.observeCustody(receipt, policy) !== "archived") {
      throw new CandidateCustodyUnavailableError();
    }
  }
}
