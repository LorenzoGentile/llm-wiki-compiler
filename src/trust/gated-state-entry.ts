/**
 * @file src/trust/gated-state-entry.ts
 * @description The ONE precondition seam every write that moves an entity INTO a
 * lifecycle state must call: relation-count and artifact-existence preconditions for
 * the entered state. Both {@link validateLiveTypedPage} (full-page-body writes) and
 * {@link applyLifecycleLocked} (the lifecycle-transition mutation kind) route through
 * here, so a new state-entry precondition can never again be wired into one path and
 * missed on the other (the post-lock audit's Critical). Lock-free: both enforcers only
 * read, under the caller's already-held project lock.
 *
 * DENY BEATS PARK (D-C.1): the two enforcers run relation-then-artifact, but the seam
 * surfaces the WORST of their two outcomes, not whichever throws first. Outcomes rank
 * any Unmet (hard denial) > any Unverifiable (park/retry) > pass, with relation taking
 * precedence over artifact within a tier. Without this, a held relation park could
 * preempt a genuine artifact denial, so a run with a real violation would park/retry
 * forever instead of hard-failing. A relation Unmet still short-circuits (the artifact
 * enforcer need not run — nothing beats a denial), but a relation park no longer
 * preempts an artifact denial discovered afterward.
 *
 * ONE BODY: {@link enforceGatedStateEntryFrom} owns the order, the capture of
 * exactly the four known outcomes and the ranking over {@link GatedStateEntryChecks},
 * the two enforcers as whole operations. The root form keeps its signature and
 * passes the exported root enforcers, called at call time, each of which runs its
 * own root-free body over its own store reads.
 */
import {
  RelationPreconditionUnmetError,
  RelationPreconditionUnverifiableError,
  enforceRelationPreconditions,
  type EnforceRelationPreconditionsArgs,
} from "../relations/enforce-precondition.js";
import {
  ArtifactPreconditionUnmetError,
  ArtifactPreconditionUnverifiableError,
  enforceArtifactPreconditions,
  type EnforceArtifactPreconditionsArgs,
} from "../artifacts/enforce-precondition.js";
import type { LifecycleDef, ProfilePack } from "../profile/types.js";

/**
 * The two state-entry checks the seam ranks. No member takes a project root. Each
 * resolves on a pass and throws its own Unmet/Unverifiable outcome otherwise.
 */
export interface GatedStateEntryChecks {
  /** Relation-count preconditions. Local: `enforceRelationPreconditions({ root, ...args })`. */
  relations(args: Omit<EnforceRelationPreconditionsArgs, "root">): Promise<void>;
  /** Artifact-existence preconditions. Local: `enforceArtifactPreconditions({ root, ...args })`. */
  artifacts(args: Omit<EnforceArtifactPreconditionsArgs, "root">): Promise<void>;
}

/** LOCAL DISK. The two exported root enforcers for one root, built per call; each called when asked. */
function diskGatedStateEntryChecks(root: string): GatedStateEntryChecks {
  return {
    relations: (args) => enforceRelationPreconditions({ root, ...args }),
    artifacts: (args) => enforceArtifactPreconditions({ root, ...args }),
  };
}

/** Inputs to {@link enforceGatedStateEntry}; the caller has already resolved `enteredState` to a real state string. */
export interface GatedStateEntryInput {
  root: string;
  profile: ProfilePack;
  entityType: string;
  slug: string;
  enteredState: string;
  lifecycle: LifecycleDef;
  meta: Record<string, unknown>;
}

/**
 * Run `fn`; resolve to `undefined` on success, or to the thrown error IFF it is one
 * of the four known precondition types (a captured outcome to be ranked). Any OTHER
 * error is a genuine bug, not an outcome to prioritize — it rethrows immediately so
 * this seam never swallows it.
 */
async function capturePrecondition(fn: () => Promise<void>): Promise<Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    if (
      err instanceof RelationPreconditionUnmetError ||
      err instanceof RelationPreconditionUnverifiableError ||
      err instanceof ArtifactPreconditionUnmetError ||
      err instanceof ArtifactPreconditionUnverifiableError
    ) {
      return err;
    }
    throw err;
  }
}

/**
 * Enforce every precondition for ENTERING `enteredState`: relation-count and
 * artifact-existence. Returns normally only when BOTH pass; otherwise throws the
 * WORST captured outcome (deny beats park — see the file overview).
 * @throws {RelationPreconditionUnmetError|RelationPreconditionUnverifiableError}
 * @throws {ArtifactPreconditionUnmetError|ArtifactPreconditionUnverifiableError}
 */
export async function enforceGatedStateEntry(input: GatedStateEntryInput): Promise<void> {
  const { root, ...request } = input;
  return enforceGatedStateEntryFrom(diskGatedStateEntryChecks(root), request);
}

/** {@link enforceGatedStateEntry} over {@link GatedStateEntryChecks}: THE ONE BODY (relation, then artifact, then the ranking). */
export async function enforceGatedStateEntryFrom(
  checks: GatedStateEntryChecks, input: Omit<GatedStateEntryInput, "root">,
): Promise<void> {
  const { profile, entityType, slug, enteredState, lifecycle, meta } = input;
  const relationError = await capturePrecondition(() =>
    checks.relations({ profile, entityType, slug, enteredState, lifecycle }),
  );
  // Nothing beats a relation denial — the artifact enforcer need not run.
  if (relationError instanceof RelationPreconditionUnmetError) throw relationError;

  const artifactError = await capturePrecondition(() =>
    checks.artifacts({ profile, entityType, slug, enteredState, lifecycle, meta }),
  );
  // An artifact denial beats a held relation park — THE fix.
  if (artifactError instanceof ArtifactPreconditionUnmetError) throw artifactError;
  if (relationError instanceof RelationPreconditionUnverifiableError) throw relationError;
  if (artifactError instanceof ArtifactPreconditionUnverifiableError) throw artifactError;
}
