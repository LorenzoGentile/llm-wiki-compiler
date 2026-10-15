/**
 * SDK-compatible verified artifact body access. Reuses the public compiler's
 * single-read verifier rather than re-opening a file after verification. Only
 * the exact, digest-checked snapshot is returned; unhealthy reads expose no bytes.
 */
import { readVerifiedArtifact, type ArtifactHealth, type VerifiedArtifactRead } from "./resolve.js";
import type { ArtifactRef } from "./ref.js";
import type { ProfilePack } from "../profile/types.js";

/** An artifact health verdict with bytes only on a healthy verified read. */
export interface VerifiedArtifactBodyV1 {
  readonly health: ArtifactHealth;
  readonly bytes?: Buffer;
}

/** Return the verified snapshot in the byte-oriented SDK contract. */
export async function readVerifiedArtifactBody(
  root: string, profile: ProfilePack, ref: ArtifactRef,
): Promise<VerifiedArtifactBodyV1> {
  return verifiedBodyOf(await readVerifiedArtifact(root, profile, ref));
}

/** The byte-oriented view of one verified read: the bytes only on a healthy read that carries a body. */
export function verifiedBodyOf(result: VerifiedArtifactRead): VerifiedArtifactBodyV1 {
  if (result.health !== "ok" || result.body === undefined) return { health: result.health };
  return { health: "ok", bytes: Buffer.from(result.body, "utf8") };
}
