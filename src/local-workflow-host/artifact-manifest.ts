/**
 * @file src/local-workflow-host/artifact-manifest.ts
 * @description Resolve a declared artifact manifest under current profile
 * authority without accepting a caller-selected filesystem path.
 *
 * ONE BODY. {@link readLocalWorkflowArtifactManifest} keeps its signature and
 * runs {@link readLocalWorkflowArtifactManifestFrom} over the incumbent root
 * readers; {@link workflowArtifactManifestReadsOver} is the same two reads over
 * the profile's and the artifact resolver's own seams. Neither is a hosted
 * store, and neither is in a package index.
 */
import { loadNonDefaultProfile, loadNonDefaultProfileFrom } from "../profile/block.js";
import type { EffectiveProfileSources } from "../profile/load.js";
import type { LoadedProfile } from "../profile/types.js";
import { artifactDiscoveryReadsOver, diskArtifactDiscoveryReads, type ArtifactDiscoveryReads } from "../artifacts/discover.js";
import type { ManifestRead } from "../artifacts/store.js";
import type { ArtifactStoreReads } from "../artifacts/resolve.js";

/** The two reads one manifest lookup makes: the active non-default profile, then the declared manifest. */
export interface WorkflowArtifactManifestReads extends Pick<ArtifactDiscoveryReads, "manifest"> {
  /** The active non-default profile, or `undefined` for the built-in default. */
  nonDefaultProfile(): Promise<LoadedProfile | undefined>;
}

/** LOCAL DISK. The incumbent root readers, each called when asked. */
function diskWorkflowArtifactManifestReads(root: string): WorkflowArtifactManifestReads {
  return { nonDefaultProfile: () => loadNonDefaultProfile(root), manifest: diskArtifactDiscoveryReads(root).manifest };
}

/** The same reads over the profile loader's sources and the artifact resolver's store seam. */
export function workflowArtifactManifestReadsOver(profile: EffectiveProfileSources, store: ArtifactStoreReads): WorkflowArtifactManifestReads {
  return { nonDefaultProfile: () => loadNonDefaultProfileFrom(profile), manifest: artifactDiscoveryReadsOver(store).manifest };
}

/** Return null for an undeclared type; preserve absent/malformed/unavailable manifest outcomes. */
export async function readLocalWorkflowArtifactManifest(root: string, artifactType: string, slug: string): Promise<ManifestRead | null> {
  return readLocalWorkflowArtifactManifestFrom(diskWorkflowArtifactManifestReads(root), artifactType, slug);
}

/** THE ONE BODY: the profile first, null for an undeclared type, then the manifest. A path refusal still rejects. */
export async function readLocalWorkflowArtifactManifestFrom(
  reads: WorkflowArtifactManifestReads, artifactType: string, slug: string,
): Promise<ManifestRead | null> {
  const loaded = await reads.nonDefaultProfile();
  const def = loaded?.profile.artifacts?.[artifactType];
  if (!def) return null;
  return reads.manifest(artifactType, slug, def.fileName);
}
