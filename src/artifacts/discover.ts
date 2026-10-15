/**
 * Exact-selector artifact discovery for recovery callers that lost a returned
 * reference. A manifest supplies only a candidate digest; the existing confined
 * verifier recomputes body hashes before discovery returns a reference. This is
 * not evidence that an operation happened, and unavailability never proves that
 * it did not. Callers must separately authenticate their occurrence bindings.
 *
 * ONE BODY. {@link discoverArtifact} keeps its signature and runs
 * {@link discoverArtifactFrom} over {@link diskArtifactDiscoveryReads}, which call
 * the incumbent root readers when asked (so mocks still intercept).
 * {@link artifactDiscoveryReadsOver} is the same two reads over the resolver's
 * own {@link ArtifactStoreReads} seam; it is not a hosted store and is in no
 * package index.
 */
import type { ArtifactRef } from "./ref.js";
import type { ProfilePack } from "../profile/types.js";
import { isSlugSafe } from "../profile/identity.js";
import { ARTIFACT_MANIFEST_MAX_BYTES, artifactPaths, manifestReadOf, readArtifactManifest, type ManifestRead } from "./store.js";
import { readVerifiedArtifactBody, verifiedBodyOf, type VerifiedArtifactBodyV1 } from "./read-verified.js";
import { readVerifiedArtifactFrom, type ArtifactStoreReads } from "./resolve.js";

/** An exact location, not a glob or a query over project contents. */
export interface ArtifactSelectorV1 { artifactType: string; slug: string }
/** Unavailable deliberately does not distinguish absence from uncertain reads. */
export type ArtifactDiscoveryV1 = { status: "found"; ref: ArtifactRef } | { status: "unavailable" };

/** Capture own data properties before asynchronous profile loading; never call getters. */
export function captureArtifactSelector(input: ArtifactSelectorV1): ArtifactSelectorV1 {
  if (!input || typeof input !== "object") throw new TypeError("Invalid artifact selector");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== 2) throw new TypeError("Invalid artifact selector");
  const artifactType = fields.artifactType?.value;
  const slug = fields.slug?.value;
  if (typeof artifactType !== "string" || typeof slug !== "string"
    || !isSlugSafe(artifactType) || !isSlugSafe(slug)) throw new TypeError("Invalid artifact selector");
  return { artifactType, slug };
}

/** The two reads one discovery makes. No member takes a project root. */
export interface ArtifactDiscoveryReads {
  /** The declared artifact's sidecar manifest under the store's manifest cap. A path refusal throws. */
  manifest(artifactType: string, slug: string, fileName: string): Promise<ManifestRead>;
  /** The freshly verified body of `ref` under `profile`. */
  verifiedBody(profile: ProfilePack, ref: ArtifactRef): Promise<VerifiedArtifactBodyV1>;
}

/** LOCAL DISK. The incumbent root readers, each called when asked; building them does no I/O. In no package index. */
export function diskArtifactDiscoveryReads(root: string): ArtifactDiscoveryReads {
  return {
    manifest: (artifactType, slug, fileName) => readArtifactManifest(root, artifactPaths(root, artifactType, slug, fileName)),
    verifiedBody: (profile, ref) => readVerifiedArtifactBody(root, profile, ref),
  };
}

/** The same reads over the resolver's own store seam: the manifest leaf under the same cap, then the one verifier body. */
export function artifactDiscoveryReadsOver(store: ArtifactStoreReads): ArtifactDiscoveryReads {
  return {
    manifest: async (artifactType, slug, fileName) =>
      manifestReadOf(await store.artifactAt(artifactType, slug, fileName).readManifestText(ARTIFACT_MANIFEST_MAX_BYTES)),
    verifiedBody: async (profile, ref) => verifiedBodyOf(await readVerifiedArtifactFrom(store, profile, ref)),
  };
}

/** Discover one declared artifact, returning only a freshly verified pinned reference. */
export async function discoverArtifact(
  root: string, profile: ProfilePack, selector: ArtifactSelectorV1,
): Promise<ArtifactDiscoveryV1> {
  return discoverArtifactFrom(diskArtifactDiscoveryReads(root), profile, selector);
}

/**
 * THE ONE BODY of {@link discoverArtifact}: the selector is captured first and
 * synchronously, an undeclared type is unavailable before any read, and every
 * read fault (a path refusal included) is unavailable.
 */
export async function discoverArtifactFrom(
  reads: ArtifactDiscoveryReads, profile: ProfilePack, selector: ArtifactSelectorV1,
): Promise<ArtifactDiscoveryV1> {
  const { artifactType, slug } = captureArtifactSelector(selector);
  const declared = profile.artifacts ?? {};
  const definition = Object.hasOwn(declared, artifactType) ? declared[artifactType] : undefined;
  if (!definition) return { status: "unavailable" };
  try {
    const manifest = await reads.manifest(artifactType, slug, definition.fileName);
    if (manifest.kind !== "ok") return { status: "unavailable" };
    const ref = { artifactType, slug, sha256: manifest.manifest.sha256 };
    const verified = await reads.verifiedBody(profile, ref);
    return verified.health === "ok" ? { status: "found", ref } : { status: "unavailable" };
  } catch { return { status: "unavailable" }; }
}
