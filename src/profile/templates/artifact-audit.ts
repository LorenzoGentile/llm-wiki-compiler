/**
 * @file src/profile/templates/artifact-audit.ts
 * @description Complete confined artifact-store audit for profile updates.
 * Every stored artifact is verified, including records not referenced by pages.
 *
 * ONE BODY over {@link ArtifactAuditReads}: confined directory listings, one
 * artifact's manifest read, and the artifact store's own reads for the shared
 * resolver ({@link resolveArtifactRefFrom}). The body owns the entry cap, the
 * declared-type and slug refusals, the legacy pair-versus-members rule, manifest
 * before health, and every message. The root form builds the reads per call.
 */
import { diskArtifactStoreReads, resolveArtifactRefFrom, type ArtifactStoreReads } from "../../artifacts/resolve.js";
import { artifactPaths, readArtifactManifest, type ManifestRead } from "../../artifacts/store.js";
import { isSlugSafe } from "../identity.js";
import type { ProfilePack } from "../types.js";
import { confinedEntries } from "./corpus.js";

const MAX_ARTIFACT_STORE_ENTRIES = 10_000;

/** What the artifact audit reads. No member takes a project root. */
export interface ArtifactAuditReads {
  /** One project-relative directory's entry names. Local: {@link confinedEntries}. */
  entries(relativeDir: string): Promise<string[] | "absent" | "unavailable">;
  /** One artifact's manifest; an unplaceable type, slug or file name throws. Local: `readArtifactManifest(root, artifactPaths(...))`. */
  readManifest(artifactType: string, slug: string, fileName: string): Promise<ManifestRead>;
  /** The artifact store's reads for the shared resolver. Local: `diskArtifactStoreReads(root)`. */
  store: ArtifactStoreReads;
}

/** LOCAL DISK. The incumbent confined reads for one root, built per call; each called when asked. */
function diskArtifactAuditReads(root: string): ArtifactAuditReads {
  return {
    entries: (relativeDir) => confinedEntries(root, relativeDir),
    readManifest: (artifactType, slug, fileName) => readArtifactManifest(root, artifactPaths(root, artifactType, slug, fileName)),
    store: diskArtifactStoreReads(root),
  };
}

/** Return compatibility blockers for every unexpected or unhealthy artifact. */
export async function auditArtifactStore(root: string, profile: ProfilePack): Promise<string[]> {
  return auditArtifactStoreFrom(diskArtifactAuditReads(root), profile);
}

/** {@link auditArtifactStore} over {@link ArtifactAuditReads}: THE ONE BODY. */
export async function auditArtifactStoreFrom(reads: ArtifactAuditReads, profile: ProfilePack): Promise<string[]> {
  const types = await entries(reads, "artifacts");
  if (!Array.isArray(types)) return types === "absent" ? [] : ["artifact store is unreadable or unsafe"];
  const reasons: string[] = [];
  for (const artifactType of types) {
    const def = profile.artifacts?.[artifactType];
    if (!isSlugSafe(artifactType) || !def) {
      reasons.push(`artifact store contains undeclared type ${JSON.stringify(artifactType)}`);
      continue;
    }
    reasons.push(...await auditType(reads, artifactType, def.fileName, profile));
  }
  return reasons;
}

async function auditType(
  reads: ArtifactAuditReads,
  artifactType: string,
  fileName: string,
  profile: ProfilePack,
): Promise<string[]> {
  const slugs = await entries(reads, `artifacts/${artifactType}`);
  if (!Array.isArray(slugs)) return [`artifact type directory is unreadable or unsafe: ${artifactType}`];
  const reasons: string[] = [];
  for (const slug of slugs) {
    if (!isSlugSafe(slug)) reasons.push(`artifact store contains unsafe slug ${JSON.stringify(slug)}`);
    else reasons.push(...await auditArtifact(reads, { artifactType, slug, fileName }, profile));
  }
  return reasons;
}

async function auditArtifact(
  reads: ArtifactAuditReads,
  target: { artifactType: string; slug: string; fileName: string },
  profile: ProfilePack,
): Promise<string[]> {
  const { artifactType, slug, fileName } = target;
  const relative = `artifacts/${artifactType}/${slug}`;
  const leaves = await entries(reads, relative);
  if (!Array.isArray(leaves)) return [`artifact directory is unreadable or unsafe: ${relative}`];
  const expected = new Set([fileName, `${fileName}.manifest.json`]);
  // The shared resolver checks the complete member set; legacy types keep the pair check.
  const membersType = profile.artifacts?.[artifactType]?.members !== undefined;
  if (!membersType && leaves.some((leaf) => !expected.has(leaf))) return [`artifact directory contains unexpected files: ${relative}`];
  const manifest = await reads.readManifest(artifactType, slug, fileName);
  if (manifest.kind !== "ok") return [`artifact manifest is ${manifest.kind}: ${artifactType}/${slug}`];
  const resolution = await resolveArtifactRefFrom(reads.store, profile, { artifactType, slug, sha256: manifest.manifest.sha256 });
  return resolution.health === "ok" ? [] : [`artifact is ${resolution.health}: ${artifactType}/${slug}`];
}

async function entries(reads: ArtifactAuditReads, relative: string): Promise<string[] | "absent" | "unavailable"> {
  const result = await reads.entries(relative);
  if (Array.isArray(result) && result.length > MAX_ARTIFACT_STORE_ENTRIES) return "unavailable";
  return result;
}
