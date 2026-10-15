/**
 * @file src/preparations/fan-out-driver.ts
 * @description The runner's fan-out phase drivers (Chunk 3 unit B): the two
 * expansion kinds that drive more than one phase instance. A `map` phase reads
 * its source phase's output evidence, decodes the items, enumerates the
 * bounded/de-duplicated instance set, and drives each. A `bounded-repeat` phase
 * drives one iteration at a time, reading each committed iteration's own output
 * evidence to decide — via the pure `repeatIterationDecision` — whether to run
 * the next, converge, or apply the limit disposition.
 *
 * These live outside `runner.ts` so the coordinator keeps one responsibility;
 * the runner injects `driveInstance` (its single-instance attempt loop) so this
 * module never reaches into the attempt machinery. The `RunPreparation*` types
 * are imported type-only from the runner — erased at runtime, so no cycle.
 *
 * ONE BODY EACH over {@link FanOutReads} (the run read, then the run's verified
 * evidence read) and a {@link FanOutInput} that carries no project root:
 * {@link driveMapPhaseWith} and {@link driveRepeatPhaseWith}. The input-taking
 * forms keep their signatures and pass the incumbent root readers, called when
 * asked; {@link fanOutReadsOver} composes the same reads from each store's own body.
 */

import { readPreparationEvidenceBytes, type PreparationEvidenceLeafReads } from "./evidence-store.js";
import { derivePhaseInstanceId, repeatExpansionIdentity, singleExpansionIdentity } from "./ids.js";
import {
  enumerateMapExpansion, repeatIterationDecision, type RepeatContinuationInputV1,
} from "./expansion.js";
import type { NormalizedPhaseV1 } from "./plan-types.js";
import { readPreparationRun, readPreparationRunFrom, type PreparationRunLeafReads, type PreparationRunRead } from "./run-store.js";
import type { PreparationRunBinding } from "./run-types.js";
import { evidenceLocationOf, runEvidenceBytesOver, type RunEvidenceBytes } from "./runner-reconstruct.js";
import type { RunPreparationInputV1, RunPreparationResultV1 } from "./runner.js";

/** Cap on decodable source-evidence bytes for one fan-out. */
const MAX_SOURCE_EVIDENCE_BYTES = 4 * 1024 * 1024;

/** The two reads a fan-out makes, in order: the authenticated run, then its verified evidence. No member takes a project root. */
export interface FanOutReads {
  /** The run at the input's binding. */
  readRun(): Promise<PreparationRunRead>;
  /** One verified evidence object at the run's location. */
  readonly evidenceBytes: RunEvidenceBytes;
}

/** What a fan-out body reads off the runner input: the binding and the pack's item decoder, never the root. */
export type FanOutInput = Pick<RunPreparationInputV1, "binding" | "decodeExpansionItems">;

/** LOCAL DISK. The incumbent root readers for the input, each called when asked and reading the root and the location off the input at that read, as the incumbent did. */
function diskFanOutReads(input: RunPreparationInputV1): FanOutReads {
  return {
    readRun: () => readPreparationRun(input.root, input.binding),
    evidenceBytes: (digest, maxBytes) => readPreparationEvidenceBytes(input.root, evidenceLocationOf(input.binding), digest, maxBytes),
  };
}

/** The same reads over the run store's and the evidence store's own leaves, at `binding`. Building it does no I/O. */
export function fanOutReadsOver(
  sources: { runs: PreparationRunLeafReads; evidence: PreparationEvidenceLeafReads }, binding: PreparationRunBinding,
): FanOutReads {
  return { readRun: () => readPreparationRunFrom(sources.runs, binding), evidenceBytes: runEvidenceBytesOver(sources.evidence, binding) };
}

/** The runner's single-instance attempt loop, injected so this module never owns it. */
export type DriveInstanceFn =
  (logicalPhaseId: string, expansionIdentity: string) => Promise<RunPreparationResultV1 | null>;

/**
 * Drive a `map` phase: read the source phase's output evidence, decode its
 * items through the pack capability, enumerate the bounded/de-duplicated
 * instance set, and drive each. The overflow deficit is surfaced in the
 * refusal reason for now; threading it into the completeness record is the
 * next unit.
 */
export async function driveMapPhase(
  input: RunPreparationInputV1, phase: NormalizedPhaseV1,
  expansion: Extract<NormalizedPhaseV1["expansion"], { kind: "map" }>,
  driveInstance: DriveInstanceFn,
): Promise<RunPreparationResultV1 | null> {
  return driveMapPhaseWith(diskFanOutReads(input), input, phase, expansion, driveInstance);
}

/** {@link driveMapPhase} over {@link FanOutReads}: THE ONE BODY. */
export async function driveMapPhaseWith(
  reads: FanOutReads, input: FanOutInput, phase: NormalizedPhaseV1,
  expansion: Extract<NormalizedPhaseV1["expansion"], { kind: "map" }>,
  driveInstance: DriveInstanceFn,
): Promise<RunPreparationResultV1 | null> {
  if (input.decodeExpansionItems === undefined) {
    return { status: "refused", runId: input.binding.runId, reason: `map phase ${phase.logicalPhaseId} needs an item decoder` };
  }
  const items = await readSourceItems(reads, input, phase, expansion);
  if (typeof items === "string") return { status: "refused", runId: input.binding.runId, reason: items };
  const enumerated = enumerateMapExpansion(items, expansion);
  if (enumerated.status !== "ok") {
    return { status: "refused", runId: input.binding.runId, reason: `fan-out of ${phase.logicalPhaseId}: ${enumerated.reason}` };
  }
  for (const instance of enumerated.instances) {
    const outcome = await driveInstance(phase.logicalPhaseId, instance.expansionIdentity);
    if (outcome !== null) return outcome;
  }
  return null;
}

/**
 * Drive a `bounded-repeat` phase (design v3 §4). Each iteration is one committed
 * attempt on the same logical phase under an iteration-indexed expansion
 * identity; after it commits the runner reads that iteration's own output
 * evidence and lets `repeatIterationDecision` choose whether to run the next. A
 * `while-boolean` continuation is refused, not mis-driven.
 */
export async function driveRepeatPhase(
  input: RunPreparationInputV1, phase: NormalizedPhaseV1,
  expansion: Extract<NormalizedPhaseV1["expansion"], { kind: "bounded-repeat" }>,
  driveInstance: DriveInstanceFn,
): Promise<RunPreparationResultV1 | null> {
  return driveRepeatPhaseWith(diskFanOutReads(input), input, phase, expansion, driveInstance);
}

/** {@link driveRepeatPhase} over {@link FanOutReads}: THE ONE BODY. */
export async function driveRepeatPhaseWith(
  reads: FanOutReads, input: FanOutInput, phase: NormalizedPhaseV1,
  expansion: Extract<NormalizedPhaseV1["expansion"], { kind: "bounded-repeat" }>,
  driveInstance: DriveInstanceFn,
): Promise<RunPreparationResultV1 | null> {
  const continuation = repeatContinuationInput(expansion.continuation);
  if (continuation === null) {
    return { status: "refused", runId: input.binding.runId, reason: `bounded-repeat ${phase.logicalPhaseId}: while-boolean continuation is unsupported` };
  }
  for (let index = 0; index < expansion.maximumIterations; index += 1) {
    const outcome = await driveInstance(phase.logicalPhaseId, repeatExpansionIdentity(index));
    if (outcome !== null) return outcome;
    const remaining = await repeatRemainingIsEmpty(reads, input, phase, index, continuation);
    if (typeof remaining === "string") return { status: "refused", runId: input.binding.runId, reason: remaining };
    const decision = repeatIterationDecision({
      completedIndex: index, maximumIterations: expansion.maximumIterations,
      continuation, remainingIsEmpty: remaining, limitDisposition: expansion.limitDisposition,
    });
    if (decision.kind === "refused") return { status: "refused", runId: input.binding.runId, reason: `fan-out of ${phase.logicalPhaseId}: ${decision.reason}` };
    if (decision.kind !== "continue") return null; // converged or stopped-incomplete
  }
  return null;
}

/** Narrow the plan continuation to the two the runner drives; null = unsupported. */
function repeatContinuationInput(
  continuation: Extract<NormalizedPhaseV1["expansion"], { kind: "bounded-repeat" }>["continuation"],
): RepeatContinuationInputV1 | null {
  if (continuation.kind === "fixed-count") return { kind: "fixed-count", count: continuation.count };
  if (continuation.kind === "until-empty") return { kind: "until-empty" };
  return null;
}

/** Whether one committed iteration's remaining-queue is empty (fixed-count never reads). */
async function repeatRemainingIsEmpty(
  reads: FanOutReads, input: FanOutInput, phase: NormalizedPhaseV1, index: number,
  continuation: RepeatContinuationInputV1,
): Promise<boolean | string> {
  if (continuation.kind === "fixed-count") return true; // unread by the fixed-count decision
  if (input.decodeExpansionItems === undefined) return `bounded-repeat ${phase.logicalPhaseId} needs an item decoder`;
  const instance = derivePhaseInstanceId({
    manifestDigest: input.binding.manifestDigest, logicalPhaseId: phase.logicalPhaseId,
    expansionIdentity: repeatExpansionIdentity(index),
  });
  const items = await readInstanceItems(reads, input, phase.logicalPhaseId, instance);
  return typeof items === "string" ? items : items.length === 0;
}

/** Read and decode the source phase's output evidence for a map expansion. */
async function readSourceItems(
  reads: FanOutReads, input: FanOutInput, phase: NormalizedPhaseV1,
  expansion: Extract<NormalizedPhaseV1["expansion"], { kind: "map" }>,
): Promise<readonly unknown[] | string> {
  const binding = phase.inputBindings.find((entry) => entry.bindingId === expansion.sourceEvidenceBinding);
  if (binding?.sourcePhaseId === undefined) return `map source binding ${expansion.sourceEvidenceBinding} is unbound`;
  const sourceInstance = derivePhaseInstanceId({
    manifestDigest: input.binding.manifestDigest, logicalPhaseId: binding.sourcePhaseId,
    expansionIdentity: singleExpansionIdentity(),
  });
  return readInstanceItems(reads, input, phase.logicalPhaseId, sourceInstance);
}

/**
 * Read one phase instance's settled output evidence and decode it through the
 * pack's item decoder, keyed by the fanning phase's id. Shared by the map
 * fan-out (source instance) and the bounded-repeat continuation (the just-
 * committed iteration instance) — both decode a list from durable evidence.
 */
async function readInstanceItems(
  reads: FanOutReads, input: FanOutInput, decoderPhaseId: string,
  instancePhaseId: ReturnType<typeof derivePhaseInstanceId>,
): Promise<readonly unknown[] | string> {
  const read = await reads.readRun();
  if (read.status !== "ok") return "run unreadable";
  const summary = read.run.phaseSummaries.find((entry) => entry.phaseInstanceId === instancePhaseId);
  if (summary?.outputEvidenceDigest === undefined) return `phase ${decoderPhaseId} produced no output evidence`;
  const bare = summary.outputEvidenceDigest.startsWith("sha256:")
    ? summary.outputEvidenceDigest.slice("sha256:".length) : summary.outputEvidenceDigest;
  const bytes = await reads.evidenceBytes(bare, MAX_SOURCE_EVIDENCE_BYTES);
  if (bytes.status !== "ok") return `source evidence ${bytes.status}`;
  return input.decodeExpansionItems!(decoderPhaseId, bytes.bytes);
}
