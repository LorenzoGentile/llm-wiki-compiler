/**
 * @file src/preparations/runner-steps.ts
 * @description What the host runner asks of the project and its host while it
 * drives, materializes and hands off one preparation run, as ONE set of steps no
 * member of which takes a project root: {@link RunnerSteps}. Split out of
 * `runner.ts` so the runner keeps one responsibility and stays within the size
 * limit; every DECISION stays in the runner's body.
 *
 * The local steps call the incumbent root forms (the fan-out drivers, the gate
 * moves, the attempt executor, finalization, the read-backs, the append and the
 * handoff) for the captured input's root and binding, so module spies and mocks
 * still intercept them. {@link runnerStepsOver} composes the same steps from each
 * one's own root-free body over its seams.
 */

import { executePhaseAttempt, executePhaseAttemptWith, type AttemptBodyRequestV1, type AttemptExecutionSteps } from "./attempts/execute.js";
import type { AttemptOutcomeV1 } from "./attempts/types.js";
import { readPreparationEvidenceBytes, type PreparationEvidenceLeafReads } from "./evidence-store.js";
import {
  driveMapPhase, driveMapPhaseWith, driveRepeatPhase, driveRepeatPhaseWith, fanOutReadsOver,
  type DriveInstanceFn, type FanOutInput,
} from "./fan-out-driver.js";
import {
  finalizePreparationForHandoff, finalizePreparationForHandoffWith,
  type FinalizationBodyInputV1, type FinalizationResultV1, type FinalizationSteps,
} from "./finalization.js";
import {
  blockAtGate, blockAtGateWith, resumeFromGate, resumeFromGateWith,
  type GateDriverSteps, type GateMoveV1, type GatePhaseV1,
} from "./gate-driver.js";
import {
  handoffPreparation, handoffPreparationWith,
  type HandoffSteps, type PreparationHandoffRequestV1, type PreparationHandoffResultV1,
} from "./handoff.js";
import { readPreparationManifest, readPreparationManifestFrom, type PreparationManifestLeafReads, type PreparationManifestRead } from "./manifest-store.js";
import type { MaterializationResultV1, PreparationHandoffMaterializationV1 } from "./materialization.js";
import type { NormalizedPhaseV1 } from "./plan-types.js";
import {
  appendPreparationTransitionLocked, appendPreparationTransitionWith, readPreparationRun, readPreparationRunFrom,
  type PreparationRunLeafReads, type PreparationRunRead, type PreparationRunWriteSteps,
} from "./run-store.js";
import type { AppendPreparationTransitionInput, PreparationRunBinding, PreparationRunPredecessor, PreparationRunV1 } from "./run-types.js";
import {
  evidenceLocationOf, readManifestBack, readManifestBackFrom, readPayloadsBack, readPayloadsBackFrom,
  runEvidenceBytesOver, type RunEvidenceBytes,
} from "./runner-reconstruct.js";
import type { RunPreparationInputV1, RunPreparationResultV1 } from "./runner.js";

/** What the runner's body reads off its input: everything but the project root. */
export type RunnerBodyInputV1 = Omit<RunPreparationInputV1, "root">;

/** The map and bounded-repeat expansions a fan-out phase carries. */
type MapExpansion = Extract<NormalizedPhaseV1["expansion"], { kind: "map" }>;
type RepeatExpansion = Extract<NormalizedPhaseV1["expansion"], { kind: "bounded-repeat" }>;

/** What one runner call asks for. No member takes a project root. */
export interface RunnerSteps {
  /** The run at the input's binding, authenticated. */
  readRun(): Promise<PreparationRunRead>;
  /** The preparation's immutable manifest. */
  readManifest(): Promise<PreparationManifestRead>;
  /** One verified evidence object at the run's location (the attempt evidence the materializer reads). */
  readonly evidenceBytes: RunEvidenceBytes;
  /** Read back the persisted materialization manifest. */
  readManifestBack(digest: string, cap: number): Promise<PreparationHandoffMaterializationV1 | string>;
  /** Read back every payload that manifest references. */
  readPayloadsBack(body: MaterializationResultV1, cap: number): Promise<Map<string, Buffer> | string>;
  /** Drive one map fan-out phase. */
  driveMap(input: FanOutInput, phase: NormalizedPhaseV1, expansion: MapExpansion, drive: DriveInstanceFn): Promise<RunPreparationResultV1 | null>;
  /** Drive one bounded-repeat fan-out phase. */
  driveRepeat(input: FanOutInput, phase: NormalizedPhaseV1, expansion: RepeatExpansion, drive: DriveInstanceFn): Promise<RunPreparationResultV1 | null>;
  /** Block the run at a gate phase. */
  blockAtGate(gate: GatePhaseV1, actor: RunnerBodyInputV1["principal"], at: string): Promise<GateMoveV1>;
  /** Resume the run from a decided gate phase. */
  resumeFromGate(gate: GatePhaseV1, actor: RunnerBodyInputV1["principal"], at: string): Promise<GateMoveV1>;
  /** One lease-fenced phase attempt. */
  executeAttempt(request: AttemptBodyRequestV1): Promise<AttemptOutcomeV1>;
  /** Finalize the run into `handoff-ready`. */
  finalize(input: FinalizationBodyInputV1): Promise<FinalizationResultV1>;
  /** One ordinary or fixed-shape transition fenced to `expected`. */
  appendTransition(expected: PreparationRunPredecessor, transition: AppendPreparationTransitionInput): Promise<PreparationRunV1>;
  /** Hand the reconstructed request off into an operation bundle. */
  handoff(request: PreparationHandoffRequestV1): Promise<PreparationHandoffResultV1>;
}

/** LOCAL DISK AND HOST. The incumbent root forms for the captured input's root and binding, each called when asked. */
export function diskRunnerSteps(input: RunPreparationInputV1): RunnerSteps {
  const { root, binding } = input;
  return {
    readRun: () => readPreparationRun(root, binding),
    readManifest: () => readPreparationManifest(root, binding.workspaceId, binding.preparationId),
    evidenceBytes: (digest, maxBytes) => readPreparationEvidenceBytes(root, evidenceLocationOf(binding), digest, maxBytes),
    readManifestBack: (digest, cap) => readManifestBack(input, digest, cap),
    readPayloadsBack: (body, cap) => readPayloadsBack(input, body, cap),
    driveMap: (_fanOut, phase, expansion, drive) => driveMapPhase(input, phase, expansion, drive),
    driveRepeat: (_fanOut, phase, expansion, drive) => driveRepeatPhase(input, phase, expansion, drive),
    blockAtGate: (gate, actor, at) => blockAtGate(root, binding, gate, actor, at),
    resumeFromGate: (gate, actor, at) => resumeFromGate(root, binding, gate, actor, at),
    executeAttempt: (request) => executePhaseAttempt({ root, ...request }),
    finalize: (finalization) => finalizePreparationForHandoff({ root, ...finalization }),
    appendTransition: (expected, transition) => appendPreparationTransitionLocked(root, binding, expected, transition),
    handoff: (request) => handoffPreparation(root, request),
  };
}

/** The seams {@link runnerStepsOver} composes over: each store's leaves and each bound collaborator's own steps. */
export interface RunnerSources {
  readonly runs: PreparationRunLeafReads;
  readonly manifests: PreparationManifestLeafReads;
  readonly evidence: PreparationEvidenceLeafReads;
  readonly writes: PreparationRunWriteSteps;
  readonly gate: GateDriverSteps;
  readonly finalization: FinalizationSteps;
  /** The attempt steps for one attempt's captured request (its cancellation settlement is per request). */
  readonly attempt: (request: AttemptBodyRequestV1) => AttemptExecutionSteps;
  readonly handoff: HandoffSteps;
}

/** The same steps over each one's own root-free body, for the run at `binding`. Building them does no I/O. */
export function runnerStepsOver(sources: RunnerSources, binding: PreparationRunBinding): RunnerSteps {
  const evidenceBytes = runEvidenceBytesOver(sources.evidence, binding);
  const fanOut = fanOutReadsOver({ runs: sources.runs, evidence: sources.evidence }, binding);
  return {
    readRun: () => readPreparationRunFrom(sources.runs, binding),
    readManifest: () => readPreparationManifestFrom(sources.manifests, binding.workspaceId, binding.preparationId),
    evidenceBytes,
    readManifestBack: (digest, cap) => readManifestBackFrom(evidenceBytes, digest, cap),
    readPayloadsBack: (body, cap) => readPayloadsBackFrom(evidenceBytes, body, cap),
    driveMap: (input, phase, expansion, drive) => driveMapPhaseWith(fanOut, input, phase, expansion, drive),
    driveRepeat: (input, phase, expansion, drive) => driveRepeatPhaseWith(fanOut, input, phase, expansion, drive),
    blockAtGate: (gate, actor, at) => blockAtGateWith(sources.gate, binding, gate, actor, at),
    resumeFromGate: (gate, actor, at) => resumeFromGateWith(sources.gate, binding, gate, actor, at),
    executeAttempt: (request) => executePhaseAttemptWith(sources.attempt(request), request),
    finalize: (finalization) => finalizePreparationForHandoffWith(sources.finalization, finalization),
    appendTransition: (expected, transition) => appendPreparationTransitionWith(sources.writes, binding, expected, transition),
    handoff: (request) => handoffPreparationWith(sources.handoff, request),
  };
}
