/**
 * @file src/preparations/service-show.ts
 * @description The `show` operation — one run's durable state, in the detail
 * `list` deliberately does not carry. Read-only and GRANT-FREE, exactly as `list`
 * is (D-10-13): it takes no lock, writes no byte, and resolves no principal.
 *
 * IT REPORTS REFERENCES, NEVER BODIES. Every evidence item is named by its
 * content-addressed ref and every plan by its digest; nothing here opens an
 * evidence object or inlines a manifest. That keeps the response bounded by the
 * run's own record rather than by the size of what the run produced, and it keeps
 * a read verb from becoming a way to exfiltrate evidence bytes through a surface
 * that charges no grant for them.
 *
 * D-10-4 AT EVERY BACKING LEG. There are three — the project, the run lookup, and
 * the execution owner's liveness — and each of them can fail in a way that means
 * "could not see" rather than "does not qualify". The project leg splits absent
 * from unreadable through the shared read-readiness home; the lookup leg inherits
 * the taxonomy `service-run-lookup.ts` already owns; and the owner leg is the one
 * this operation exists to expose.
 *
 * WHY THE OWNER'S LIVENESS IS THE POINT OF THE VERB. Everywhere else in the
 * system that fact is a boolean, because everywhere else the DECISION is binary:
 * reclaim or do not. Reporting is not a decision, and the boolean's fail-safe
 * collapse — treating "cannot tell" as "live" — is actively misleading when what
 * the operator needs to know is whether waiting will ever help. So `show` reports
 * the classification itself, including WHICH kind of unobservable, because one of
 * them resolves on a retry and the other never will.
 *
 * ONE BODY, OVER TWO DIFFERENT KINDS OF DEPENDENCY. Every decision above is
 * made in `showPreparationOperationFrom`, which takes no project root.
 * `PreparationShowReads` is PROJECT STORAGE: readiness, then the run lookup.
 * `PreparationShowHostObservation` is NOT storage: it observes a process on
 * THIS HOST, and no store of any kind could answer it. They are separate
 * parameters so the second is never mistaken for portable I/O. The root-named
 * operation keeps its signature and reaches the body over the private
 * local-disk reads and the incumbent process classifier, unchanged. Naming
 * them here selects no backend and sets no new liveness policy.
 */

import { REQUEST_CAPTURE_REFUSAL, capturedRequest } from "./service-request-capture.js";
import { classifyExecutionOwnerLiveness } from "./attempts/lease.js";
import type { PreparationExecutionOwnerV1, PreparationRunState, PreparationRunV1 } from "./run-types.js";
import { resolvePreparationReadReadiness } from "./service-readiness.js";
import type { ReadReadinessV1 } from "./service-readiness.js";
import { resolvePreparationRun } from "./service-run-lookup.js";
import type { PreparationRunLookupV1 } from "./service-run-lookup.js";
import type { OwnerLiveness } from "../utils/lock-owner.js";

/** Request for the `show` operation. Carries no actor, surface or grant. */
export interface ShowRequestV1 {
  /** The run to describe. */
  readonly runId: string;
}

/** What is known about the process a run's in-flight attempt is running under. */
export interface ExecutionOwnerReportV1 {
  readonly pid: number;
  readonly attemptId: string;
  readonly acquiredAt: string;
  /** What the evidence says, uncollapsed — see {@link OwnerLiveness}. */
  readonly liveness: OwnerLiveness;
  /** Whether observing this owner again could ever produce a different answer. */
  readonly retryable: boolean;
  /** What an operator should do about it, in one line. */
  readonly guidance: string;
}

/** One phase's settled facts, by reference. */
export interface PhaseReportV1 {
  readonly phaseInstanceId: string;
  readonly logicalPhaseId: string;
  readonly state: string;
  readonly attemptCount: number;
  /** The content address of the phase's output evidence, when it produced any. */
  readonly outputEvidenceDigest: string | null;
  /** The failed leg's fixed problem code, when the phase settled failed. */
  readonly problem: string | null;
  /** The host's sentence about the failure, bounded at write time. */
  readonly problemDetail: string | null;
}

/** One run's durable state, by reference. */
export interface RunReportV1 {
  readonly workspaceId: string;
  readonly preparationId: string;
  readonly runId: string;
  readonly state: PreparationRunState;
  /** The digest of the immutable plan this run is bound to — never the plan. */
  readonly manifestDigest: string;
  readonly transitionCount: number;
  readonly phases: readonly PhaseReportV1[];
  /** Content addresses only; `show` opens no evidence object. */
  readonly evidenceRefs: readonly string[];
  /** Present only while an attempt is recorded as in flight. */
  readonly executionOwner: ExecutionOwnerReportV1 | null;
}

/** The closed outcome of one show. */
export type ShowResultV1 =
  | { readonly status: "shown"; readonly run: RunReportV1 }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "unavailable"; readonly detail: string };

/**
 * What an operator should do about an owner in each liveness class.
 *
 * TOTAL OVER THE CLASSIFICATION, so a new arm does not compile until somebody
 * decides what it means for a person reading it. The two unobservable arms are
 * the reason this table exists: they carry the same boolean everywhere else in
 * the system and opposite instructions here.
 */
const LIVENESS_GUIDANCE: Readonly<Record<OwnerLiveness, string>> = {
  live: "the attempt's process is running; wait for the phase to settle, or cancel the run",
  stale: "the attempt's process is gone; recover the run to clear the owner and continue",
  "unobservable-unreadable":
    "this host cannot read the process's identity, so whether the attempt is still running is "
    + "undetermined here; the same run may resolve from the host that started it, or once the "
    + "process table is readable",
  "unobservable-unrecorded":
    "the owner was recorded without a process identity, so nothing can ever determine whether it "
    + "is still running; retrying will not change this answer and recovery will refuse the run — "
    + "an operator must confirm the executor is gone",
  // THE SAME PERMANENCE AS `unrecorded`, ARRIVED AT DIFFERENTLY. The record does
  // carry an identity; it is in a format written before process identity became
  // timezone-invariant, which this build cannot compare against what it reads
  // now. Comparing them would be reading a format difference as evidence of pid
  // reuse, which is how a migration reclaims a live holder's run.
  "unobservable-unrecognised":
    "this run's owner was recorded before the process-identity format changed, so its identity "
    + "cannot be compared with what this host reads now; retrying will not change this answer, and "
    + "the difference is NOT evidence the process is gone — an operator must confirm the executor "
    + "is gone",
};

/**
 * Whether observing this owner AGAIN could produce a different answer.
 *
 * The honest split the team asked for, and it is a property of the EVIDENCE
 * rather than of the process: a `stale` or `live` observation is already
 * conclusive, an unreadable probe may succeed later, and an unrecorded identity
 * is permanently unanswerable because no read recovers what the write declined
 * to store.
 */
function livenessIsRetryable(liveness: OwnerLiveness): boolean {
  return liveness === "unobservable-unreadable";
}

/**
 * What `show` asks of the preparation store. Owned by `show`; no read takes a
 * project root. Each member must resolve or reject, never throw synchronously:
 * the body catches nothing and adds no normalization.
 */
export interface PreparationShowReads {
  /** Whether the project is something to read a run from. */
  readReadiness(): Promise<ReadReadinessV1>;
  /** Locate one run and its authenticated binding by the id the caller named. */
  resolveRun(runId: string): Promise<PreparationRunLookupV1>;
}

/**
 * What `show` asks of THE HOST IT RUNS ON. A process observation, not project
 * storage: the answer depends on this machine's process table and on nothing a
 * store holds. Synchronous, as the incumbent classifier is.
 */
export interface PreparationShowHostObservation {
  /** Classify whether the recorded owner's process is still running here. */
  classifyOwnerLiveness(owner: Pick<PreparationExecutionOwnerV1, "pid" | "processStartTime">): OwnerLiveness;
}

/**
 * The local-disk reads for one project root. Private, and built per call: each
 * closure calls the imported root-taking reader when it is asked, never earlier.
 */
function diskPreparationShowReads(root: string): PreparationShowReads {
  return {
    readReadiness: () => resolvePreparationReadReadiness(root),
    resolveRun: (runId) => resolvePreparationRun(root, runId),
  };
}

/** This host's process observation: the incumbent classifier, called as before. */
const HOST_PROCESS_OBSERVATION: PreparationShowHostObservation = {
  classifyOwnerLiveness: classifyExecutionOwnerLiveness,
};

/** Report one execution owner, classification and remedy included. */
function ownerReport(owner: PreparationExecutionOwnerV1, host: PreparationShowHostObservation): ExecutionOwnerReportV1 {
  const liveness = host.classifyOwnerLiveness(owner);
  return {
    pid: owner.pid, attemptId: owner.attemptId, acquiredAt: owner.acquiredAt,
    liveness, retryable: livenessIsRetryable(liveness), guidance: LIVENESS_GUIDANCE[liveness],
  };
}

/** Project one run's durable record into the reference-only report. */
function runReport(run: PreparationRunV1, manifestDigest: string, host: PreparationShowHostObservation): RunReportV1 {
  return {
    workspaceId: run.workspaceId, preparationId: run.preparationId, runId: run.runId,
    state: run.state, manifestDigest, transitionCount: run.transitions.length,
    phases: run.phaseSummaries.map((summary) => ({
      phaseInstanceId: summary.phaseInstanceId, logicalPhaseId: summary.logicalPhaseId,
      state: summary.state, attemptCount: summary.attemptCount,
      outputEvidenceDigest: summary.outputEvidenceDigest ?? null,
      problem: summary.problem ?? null, problemDetail: summary.problemDetail ?? null,
    })),
    // THE REF, NOT THE OBJECT. `evidenceRefs` are content addresses; resolving
    // them is a different operation with a different bound.
    evidenceRefs: run.evidenceRefs.map((ref) => ref.digest),
    executionOwner: run.executionOwner === undefined ? null : ownerReport(run.executionOwner, host),
  };
}

/**
 * Render one classified lookup failure in this operation's own vocabulary.
 *
 * TOTAL OVER THE CLASSIFICATION, so a third failure kind does not compile until
 * somebody decides which of `show`'s three exit codes it earns. The mapping is
 * the identity — the lookup's taxonomy and this operation's are the same
 * distinction, named twice because one is about a read and the other is about an
 * answer — and writing it out is what stops the next reader from collapsing them
 * again on the grounds that they looked similar.
 */
function lookupOutcome(miss: Extract<PreparationRunLookupV1, { ok: false }>): ShowResultV1 {
  return miss.failure === "unavailable"
    ? { status: "unavailable", detail: miss.reason }
    : { status: "refused", reason: miss.reason };
}

/**
 * Describe one run, or say honestly why it cannot be described.
 *
 * `unavailable` AND `refused` ARE NOT THE SAME ANSWER, and this is the leg where
 * collapsing them costs the most. A store this process could not read is a
 * retryable condition about the OBSERVER; a run that does not exist is a settled
 * fact about the STORE. An operator told "no such run" for a directory they lack
 * permission on goes looking for a run that is sitting right there.
 *
 * @param root - The project root this invocation reads within.
 * @param request - The run the caller named.
 * @returns The run's referenced state, a refusal, or an unavailability.
 */
export async function showPreparationOperation(
  root: string, request: ShowRequestV1,
): Promise<ShowResultV1> {
  return showPreparationOperationFrom(diskPreparationShowReads(root), HOST_PROCESS_OBSERVATION, request);
}

/**
 * {@link showPreparationOperation} over `show`'s own reads and its host
 * observation: the one body. The host is asked only for a run that records an
 * owner, and only after both reads.
 */
export async function showPreparationOperationFrom(
  reads: PreparationShowReads, host: PreparationShowHostObservation, request: ShowRequestV1,
): Promise<ShowResultV1> {
  // CAPTURED BEFORE THE FIRST AWAIT (D-10-9), for the same reason the mutating
  // verbs do it: a field re-read afterwards would describe a run the caller
  // never named, and a read reporting the wrong run is a wrong answer even
  // though it wrote nothing.
  // AND BY DESCRIPTOR. `refused` rather than `unavailable`: a request this
  // service will not read is a statement about the caller's INPUT, where
  // `unavailable` means the PROJECT could not be read. Collapsing them would
  // report a caller's bad object as a broken project.
  const captured = capturedRequest<ShowRequestV1>(request);
  if (captured === null) return { status: "refused", reason: REQUEST_CAPTURE_REFUSAL };
  const runId = captured.runId;
  const readiness = await reads.readReadiness();
  if (readiness.status === "unreadable") return { status: "unavailable", detail: readiness.detail };
  if (readiness.status === "absent") return { status: "refused", reason: readiness.detail };
  const resolved = await reads.resolveRun(runId);
  // THE LOOKUP'S OWN CLASSIFICATION, not a re-derivation of it. Every failing
  // arm used to land on `refused`, so a degraded manifest scan and a corrupt run
  // leaf — both of which mean this observer could not see — were reported as
  // settled facts about the store, and the CLI exited 1 where its documented
  // retryable code is 2.
  if (!resolved.ok) return lookupOutcome(resolved);
  return { status: "shown", run: runReport(resolved.run, resolved.binding.manifestDigest, host) };
}
