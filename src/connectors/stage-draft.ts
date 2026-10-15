/**
 * @file src/connectors/stage-draft.ts
 * @description The connector run's staging under the held project lock: the
 * noop of an already-staged content hash, the candidate-store refusals, the
 * archive with undo and its outcomes, the staged replacement and the order of
 * the connector event's preflight and append. Moved from `run.ts` unchanged.
 *
 * ONE BODY. {@link stagePreparedDraftWith} decides over
 * {@link PreparedDraftStageSteps}, none of which takes a project root. The root
 * form keeps its signature and builds the local steps per call; each calls the
 * incumbent root-taking reader or writer when asked, with its old arguments, so
 * module spies still intercept. Archiving with undo and staging the candidate are
 * MECHANISM steps; {@link preparedDraftStageStepsOver} composes the selection,
 * event and profile steps from their own bodies.
 */

import { appendEventLocked, appendEventLockedFrom, preflightEventAppend, preflightEventAppendFrom, type EventWriteSources } from "../events/store.js";
import { loadNonDefaultProfile, loadNonDefaultProfileFrom } from "../profile/block.js";
import type { EffectiveProfileSources } from "../profile/load.js";
import type { ProfilePack } from "../profile/types.js";
import { CandidatePublicationUnavailableError, FreshCandidateIdExhaustedError } from "../compiler/candidates.js";
import { CandidateCustodyUnavailableError } from "../compiler/candidate-custody.js";
import { UnsafeCandidateDirError } from "../compiler/candidate-store-paths.js";
import { StagedWriteOverflowError } from "../trust/staged-change.js";
import { appendConnectorEvent, connectorEvent } from "./audit.js";
import { stagedCandidatePreflightId } from "./candidate-identity.js";
import {
  archiveCandidatesWithUndo, canStageFreshConnectorIntent, CONNECTOR_CANDIDATE_STORE_UNAVAILABLE, includesConnectorContentHash,
  selectConnectorCandidateEntriesForRun, selectConnectorCandidateEntriesForRunFrom, type ConnectorCandidateRunSources,
} from "./candidate-supersession.js";
import { stageConnectorCandidate, type ConnectorCandidateStageResult } from "./stage-candidate.js";
import type { ConnectorProvenance } from "./types.js";
import type { RunConnectorDeps, RunConnectorResult } from "./run.js";

/** One mapped connector draft, ready to stage. */
export interface PreparedDraft {
  entityType: string;
  slug: string;
  body: string;
  provenance: ConnectorProvenance;
  idempotencyKey: string;
  contentHash: string;
  draftContentHash: string;
  finalUrl: string;
}

type CandidateUnavailable = Extract<RunConnectorResult, { kind: "unavailable" }>;

/** A root-taking reader or writer with its root removed. */
type Rootless<F> = F extends (root: string, ...args: infer A) => infer R ? (...args: A) => R : never;

/** What staging one prepared draft asks of the project. No member takes a project root. */
export interface PreparedDraftStageSteps {
  /** The pending candidates this run's idempotency key selects. */
  selectEntries: Rootless<typeof selectConnectorCandidateEntriesForRun>;
  /** Prove one event would append, writing nothing. */
  preflightEvent: Rootless<typeof preflightEventAppend>;
  /** Append one event under the held lock. */
  appendEvent: Rootless<typeof appendEventLocked>;
  /** The active non-default profile, or undefined. */
  loadProfile: Rootless<typeof loadNonDefaultProfile>;
  /** MECHANISM: archive the superseded candidates, undoing on failure. */
  archive: Rootless<typeof archiveCandidatesWithUndo>;
  /** MECHANISM: stage the replacement candidate. */
  stage: Rootless<typeof stageConnectorCandidate>;
  /** Append the connector-fetch event for the staged result. */
  appendConnectorEvent: Rootless<typeof appendConnectorEvent>;
}

/** LOCAL DISK. The incumbent readers and writers for `root`, each called when asked. */
function diskPreparedDraftStageSteps(root: string): PreparedDraftStageSteps {
  return {
    selectEntries: (...args) => selectConnectorCandidateEntriesForRun(root, ...args),
    preflightEvent: (...args) => preflightEventAppend(root, ...args),
    appendEvent: (...args) => appendEventLocked(root, ...args),
    loadProfile: () => loadNonDefaultProfile(root),
    archive: (...args) => archiveCandidatesWithUndo(root, ...args),
    stage: (...args) => stageConnectorCandidate(root, ...args),
    appendConnectorEvent: (...args) => appendConnectorEvent(root, ...args),
  };
}

/** The selection, event and profile steps over their own bodies, with the caller's archive and stage. Building it does no I/O. */
export function preparedDraftStageStepsOver(
  seams: { selection: ConnectorCandidateRunSources; events: EventWriteSources; profile: EffectiveProfileSources },
  mechanisms: Pick<PreparedDraftStageSteps, "archive" | "stage">,
): PreparedDraftStageSteps {
  return {
    ...mechanisms,
    selectEntries: (...args) => selectConnectorCandidateEntriesForRunFrom(seams.selection, ...args),
    preflightEvent: (input) => preflightEventAppendFrom(seams.events, input),
    appendEvent: (input) => appendEventLockedFrom(seams.events, input),
    loadProfile: () => loadNonDefaultProfileFrom(seams.profile),
    appendConnectorEvent: (...args) => appendEventLockedFrom(seams.events, connectorEvent(...args)),
  };
}

/** Mutate the candidate store under the held project lock and append the audit event. */
export async function stagePreparedDraft(
  root: string,
  draft: PreparedDraft,
  deps: RunConnectorDeps,
): Promise<RunConnectorResult> {
  return stagePreparedDraftWith(diskPreparedDraftStageSteps(root), draft, deps);
}

/** {@link stagePreparedDraft} over {@link PreparedDraftStageSteps}: THE ONE BODY. */
export async function stagePreparedDraftWith(
  steps: PreparedDraftStageSteps,
  draft: PreparedDraft,
  deps: RunConnectorDeps,
): Promise<RunConnectorResult> {
  const selection = await steps.selectEntries(draft.idempotencyKey, deps.candidateSelectionHooksForTest);
  if ("kind" in selection) return selection;
  const existing = selection.entries;
  const candidateIds = existing.map(({ fileId }) => fileId);
  if (includesConnectorContentHash(existing, draft.contentHash)) {
    const event = connectorEvent(draft, [], candidateIds, [], deps.now, "public");
    await steps.preflightEvent(event);
    await steps.appendEvent(event);
    return { kind: "noop", candidateIds };
  }
  if (!canStageFreshConnectorIntent(selection)) return candidateStoreUnavailable();
  const loaded = await steps.loadProfile();
  if (!loaded) return { kind: "unavailable", reason: "connector profile unavailable" };
  const preflightIds = [stagedCandidatePreflightId(draft.slug)];
  const archivedIds = candidateIds;
  await steps.preflightEvent(connectorEvent(draft, preflightIds, [], archivedIds, deps.now, "public"));
  const archived = await steps.archive(existing, deps.candidateMoves, "public");
  if (archived.kind === "recovery-required") return archived;
  if (archived.kind === "failed-and-restored") {
    return { kind: "unavailable", reason: "connector could not archive a superseded candidate" };
  }
  const staged = await stageReplacement(steps, draft, loaded.profile, archived.receipts, deps);
  if (staged.kind !== "staged") return staged;
  await steps.appendConnectorEvent(draft, [staged.change.id], [], archivedIds, deps.now, "public");
  return archivedIds.length > 0
    ? { kind: "superseded", archivedIds, candidateIds: [staged.change.id] }
    : { kind: "staged", candidateIds: [staged.change.id] };
}

/** Stage after archive; map only errors whose exact compensation already settled. */
async function stageReplacement(
  steps: PreparedDraftStageSteps,
  draft: PreparedDraft,
  profile: ProfilePack,
  receipts: Parameters<typeof stageConnectorCandidate>[3],
  deps: RunConnectorDeps,
): Promise<ConnectorCandidateStageResult | CandidateUnavailable> {
  try {
    return await steps.stage(
      draft, profile, receipts, deps.candidateMoves, deps.now,
      deps.beforeCandidateStageForTest, "public",
    );
  } catch (error) {
    if (error instanceof StagedWriteOverflowError ||
        error instanceof FreshCandidateIdExhaustedError ||
        error instanceof CandidatePublicationUnavailableError ||
        error instanceof CandidateCustodyUnavailableError ||
        error instanceof UnsafeCandidateDirError) return candidateStoreUnavailable();
    throw error;
  }
}

/** Build the one fixed normal-run candidate-authority refusal. */
function candidateStoreUnavailable(): CandidateUnavailable {
  return { kind: "unavailable", reason: CONNECTOR_CANDIDATE_STORE_UNAVAILABLE };
}
