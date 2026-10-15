/**
 * Request-time artifact projection. Metadata and optional local bytes are derived
 * from one verified read; no caller may verify a path and subsequently reopen it.
 *
 * ONE BODY. {@link readViewerArtifactWith} owns the projection (the ref refusal,
 * the declared-metadata filter, the loopback gate on bytes) over the one verified
 * read it makes. {@link readViewerArtifact} keeps its signature and passes the
 * incumbent root reader, called when asked; {@link readViewerArtifactFrom} passes
 * the verified read's own body over the artifact store's seam.
 */
import type { ProfilePack } from "../profile/types.js";
import { parseArtifactRef, type ArtifactRef } from "../artifacts/ref.js";
import { readVerifiedArtifact, readVerifiedArtifactFrom, type ArtifactStoreReads, type VerifiedArtifactRead } from "../artifacts/resolve.js";
import { PathSafetyError } from "./path-safety.js";

/** The one verified read a projection makes, of a parsed ref under the declared artifacts. */
export type ViewerArtifactRead = (ref: ArtifactRef) => Promise<VerifiedArtifactRead>;

/** Verify a pinned ref and expose only declared metadata outside loopback. */
export async function readViewerArtifact(root: string, artifacts: ProfilePack["artifacts"], raw: string, isLoopback: boolean): Promise<Record<string, unknown>> {
  return readViewerArtifactWith((ref) => readVerifiedArtifact(root, { artifacts }, ref), artifacts, raw, isLoopback);
}

/** {@link readViewerArtifact} over the artifact store's seam. */
export async function readViewerArtifactFrom(store: ArtifactStoreReads, artifacts: ProfilePack["artifacts"], raw: string, isLoopback: boolean): Promise<Record<string, unknown>> {
  return readViewerArtifactWith((ref) => readVerifiedArtifactFrom(store, { artifacts }, ref), artifacts, raw, isLoopback);
}

/** {@link readViewerArtifact} over its one verified read: THE ONE BODY. A malformed ref refuses before the read. */
export async function readViewerArtifactWith(read: ViewerArtifactRead, artifacts: ProfilePack["artifacts"], raw: string, isLoopback: boolean): Promise<Record<string, unknown>> {
  const ref = parseArtifactRef(raw);
  if (!ref) throw new PathSafetyError("Invalid artifact reference.");
  const result = await read(ref);
  const { body, storeFault: _fault, ...resolution } = result;
  const def = artifacts && Object.hasOwn(artifacts, ref.artifactType) ? artifacts[ref.artifactType] : undefined;
  const metadata = body !== undefined && def?.contentKind === "json"
    ? declaredMetadata(JSON.parse(body), Object.keys(def.metadata ?? {})) : undefined;
  return { kind: "artifact", ref: raw, ...resolution,
    contentAccess: isLoopback ? "available" : "loopback-only",
    ...(def ? { fileName: def.fileName } : {}),
    ...(metadata ? { metadata } : {}),
    ...(body !== undefined && isLoopback ? { body } : {}) };
}

/** Exclude undeclared JSON fields, even when the artifact permits extra keys. */
function declaredMetadata(parsed: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.filter((name) => Object.hasOwn(parsed, name)).map((name) => [name, parsed[name]]));
}
