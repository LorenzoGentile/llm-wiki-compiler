/**
 * @file src/preparations/lifecycle-snapshot/classifier-types.ts
 * @description Internal two-pass classifier DTOs shared by quarantine and prune
 * classifiers without exposing raw authority records in the public snapshot.
 *
 * It also names the classifiers' ONE read seam, {@link LifecycleLeafReads}: the
 * three confined leaf observations a pass-one classification makes (a receipt
 * or intent leaf's bytes, a regular-leaf check, a planned object's state), none
 * of which takes a project root. {@link diskLifecycleLeafReads} hands each the
 * namespace's confined root at that read, exactly as the classifiers always did.
 */

import {
  lifecycleRegularLeaf, observeLifecyclePlannedLeaf, readLifecycleLeaf,
  type LifecycleLeafRead, type LifecyclePlannedLeafState,
} from "../lifecycle-fs/leaf-observation.js";
import type { PreparationLifecycleNamespaceV1 } from "../lifecycle-fs/types.js";
import type {
  PreparationLifecycleOperationV1,
  PreparationLifecycleProblemV1,
  PreparationLifecycleUnitV1,
} from "./types.js";

/** The confined leaf observations a pass-one classification makes. No member takes a project root. */
export interface LifecycleLeafReads {
  /** One single-link leaf's bytes within `maxBytes`, or absent; THROWS when it is unavailable or over its bound. */
  readLeaf(file: string, expectedDir: string, maxBytes: number): Promise<LifecycleLeafRead>;
  /** Whether a single-link regular leaf is there. */
  regularLeaf(file: string, expectedDir: string): Promise<boolean>;
  /** One planned object's no-follow state, streamed and checked against its declaration. */
  observePlannedLeaf(input: Omit<Parameters<typeof observeLifecyclePlannedLeaf>[0], "root">): Promise<LifecyclePlannedLeafState>;
}

/** LOCAL DISK. The confined leaf observations, reading the namespace's root at each read. */
export function diskLifecycleLeafReads(namespace: PreparationLifecycleNamespaceV1): LifecycleLeafReads {
  return {
    readLeaf: (file, expectedDir, maxBytes) => readLifecycleLeaf({ root: namespace.root.realPath, file, expectedDir, maxBytes }),
    regularLeaf: (file, expectedDir) => lifecycleRegularLeaf(namespace.root.realPath, file, expectedDir),
    observePlannedLeaf: (input) => observeLifecyclePlannedLeaf({ root: namespace.root.realPath, ...input }),
  };
}

/** Positive active-key retirement evidence emitted by one completed reset. */
export interface LifecycleRetirementEvidence {
  readonly unitId: string;
  readonly receiptDigest: string;
}

/** Pass-one result awaiting optional historical reconciliation. */
export interface LifecyclePassOneUnit {
  readonly unit: PreparationLifecycleUnitV1;
  readonly problem?: PreparationLifecycleProblemV1;
  readonly retirementEvidence: readonly LifecycleRetirementEvidence[];
  readonly historicalCandidateDigest?: string;
  readonly historicalCandidateOperation?: PreparationLifecycleOperationV1;
}

/** Why an observed unit cannot proceed to its registry-specific classifier. */
function lifecycleObservationRefusal(
  observation: {
    readonly problem?: {
      readonly code: PreparationLifecycleProblemV1["code"];
      readonly detail: string;
    };
    readonly directory?: unknown;
  },
): { code: PreparationLifecycleProblemV1["code"]; detail: string } | null {
  if (observation.problem !== undefined) return observation.problem;
  return observation.directory === undefined
    ? { code: "unit-unavailable", detail: "unit unavailable" }
    : null;
}

/** Closed pre-classifier disposition shared by both physical registries. */
export function lifecycleObservationDisposition(
  observation: {
    readonly problem?: {
      readonly code: PreparationLifecycleProblemV1["code"];
      readonly detail: string;
    };
    readonly directory?: { readonly names: readonly string[] };
  },
): {
  status: "unavailable";
  code: PreparationLifecycleProblemV1["code"];
  detail: string;
} | { status: "inert" } | { status: "ready" } {
  const refusal = lifecycleObservationRefusal(observation);
  if (refusal !== null) return { status: "unavailable", ...refusal };
  return observation.directory?.names.length === 0
    ? { status: "inert" }
    : { status: "ready" };
}
