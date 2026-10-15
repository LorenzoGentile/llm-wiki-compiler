/**
 * @file src/artifacts/capture-member.ts
 * @description Generic one-member artifact capture through the existing locked,
 * journaled write authority, followed by the existing full health resolver.
 *
 * ONE BODY. {@link captureVerifiedMemberArtifactWith} owns the capture ladder:
 * apply the one artifact mutation, require an artifact result, require an active
 * non-default profile, then require the full resolution to be healthy. It runs
 * over {@link CaptureMemberSteps}, none of which takes a project root.
 * {@link captureVerifiedMemberArtifact} keeps its signature and passes the
 * incumbent root forms, called when asked; the self-locking write authority stays
 * the caller's. {@link captureMemberStepsOver} keeps that authority as given and
 * composes the profile and resolution from their own bodies over their seams.
 */
import { loadNonDefaultProfile, loadNonDefaultProfileFrom } from "../profile/block.js";
import type { EffectiveProfileSources } from "../profile/load.js";
import type { LoadedProfile, ProfilePack } from "../profile/types.js";
import type { ApplyResult } from "../trust/apply-result.js";
import { applyApprovedMutations } from "../trust/executor.js";
import type { ArtifactOrigin, PlannedMutation } from "../trust/planner.js";
import type { ArtifactMemberFileInput } from "./members.js";
import type { ArtifactRef } from "./ref.js";
import { resolveArtifactRef, resolveArtifactRefFrom, type ArtifactResolution, type ArtifactStoreReads } from "./resolve.js";

export interface CaptureMemberArtifactV1 {
  readonly artifactType: string;
  readonly slug: string;
  readonly member: ArtifactMemberFileInput;
  readonly origin: ArtifactOrigin;
}

/** The three steps one capture takes, in order. No member takes a project root. */
export interface CaptureMemberSteps {
  /** The locked, journaled write authority applying approved mutations. */
  apply(planned: PlannedMutation[]): Promise<ApplyResult[]>;
  /** The active non-default profile, or undefined. */
  loadProfile(): Promise<LoadedProfile | undefined>;
  /** The full health resolution of `ref` under `profile`. */
  resolve(profile: ProfilePack, ref: ArtifactRef): Promise<ArtifactResolution>;
}

/** LOCAL DISK. The incumbent root forms for `root`, each called when asked. */
function diskCaptureMemberSteps(root: string): CaptureMemberSteps {
  return {
    apply: (planned) => applyApprovedMutations(root, planned),
    loadProfile: () => loadNonDefaultProfile(root),
    resolve: (profile, ref) => resolveArtifactRef(root, profile, ref),
  };
}

/** The same steps with the host's write authority as given and the profile and resolution over their own seams. Building it does no I/O. */
export function captureMemberStepsOver(sources: {
  apply: CaptureMemberSteps["apply"]; profile: EffectiveProfileSources; store: ArtifactStoreReads;
}): CaptureMemberSteps {
  return {
    apply: (planned) => sources.apply(planned),
    loadProfile: () => loadNonDefaultProfileFrom(sources.profile),
    resolve: (profile, ref) => resolveArtifactRefFrom(sources.store, profile, ref),
  };
}

/** Persist one member atomically and return only after the complete ref verifies. */
export async function captureVerifiedMemberArtifact(
  root: string, input: CaptureMemberArtifactV1,
): Promise<ArtifactRef> {
  return captureVerifiedMemberArtifactWith(diskCaptureMemberSteps(root), input);
}

/** {@link captureVerifiedMemberArtifact} over {@link CaptureMemberSteps}: THE ONE BODY. */
export async function captureVerifiedMemberArtifactWith(
  steps: CaptureMemberSteps, input: CaptureMemberArtifactV1,
): Promise<ArtifactRef> {
  const [applied] = await steps.apply([{
    kind: "artifact", artifactType: input.artifactType, slug: input.slug,
    body: "", memberFiles: [input.member], origin: input.origin,
  }]);
  if (applied?.kind !== "artifact") throw new Error("member capture returned a non-artifact result");
  const loaded = await steps.loadProfile();
  if (!loaded) throw new Error("member capture requires an active non-default profile");
  const resolved = await steps.resolve(loaded.profile, applied.ref);
  if (resolved.health !== "ok") throw new Error(`captured member artifact is not healthy: ${resolved.health}`);
  return applied.ref;
}
