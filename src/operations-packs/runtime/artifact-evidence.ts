/**
 * @file src/operations-packs/runtime/artifact-evidence.ts
 * @description Build the provider input specs a sealed ARTIFACT-EVIDENCE
 * descriptor names (AS-4 P4.2, D41a) — ONE function, TWO consumers, exactly
 * like its source-evidence sibling: the authority resolver computes the
 * exposure digest over these specs at seal and at leg-K revalidation; the leg
 * builder materializes the same specs into the provider's confined input
 * region.
 *
 * NOTHING SEALED IS TRUSTED, EVERYTHING SEALED IS RE-VERIFIED. The sealed ref
 * must still RESOLVE HEALTHY (the member-bearing verification: manifest, every
 * member, the directory sweep); the artifact's CURRENT manifest rows must
 * EQUAL the sealed member columns exactly (a rewritten-but-healthy bundle is
 * DRIFT, not evidence — the operator approved the sealed table); and every
 * member's bytes are REHASHED against the sealed digests and byte counts. A
 * refusal parks the leg with a named reason; the provider is never fed bytes
 * under an approved digest they no longer hash to.
 *
 * GENERIC BY CONSTRUCTION: refs, fields, and member names — no product
 * vocabulary. This same builder serves the exp-eval judge lane (D41): any
 * consumer whose capture derives a ref + member table hands it the identical
 * contract.
 *
 * ONE BODY. {@link buildArtifactEvidenceSpecsFrom} owns every decision above
 * over {@link ArtifactEvidenceSpecReads}: the capture's existing
 * {@link ArtifactEvidenceReads} (profile, full resolution, body) plus the one
 * member-bytes read the rehash needs. {@link buildArtifactEvidenceSpecs} keeps
 * its signature and passes the local reads, which call the incumbent root
 * readers when asked with their old arguments; {@link artifactEvidenceSpecReadsOver}
 * composes the same reads over the profile sources and the artifact store seam.
 */

import { createHash } from "node:crypto";
import { parseArtifactRef, type ArtifactRef } from "../../artifacts/ref.js";
import type { ArtifactStoreReads } from "../../artifacts/resolve.js";
import { parseMemberEntries, type ArtifactMemberEntry } from "../../artifacts/members.js";
import {
  artifactPaths, hashArtifactBody, memberLeafPath, readArtifactMemberBytes, type ArtifactMemberRead,
} from "../../artifacts/store.js";
import type { EffectiveProfileSources } from "../../profile/load.js";
import {
  artifactEvidenceReadsOver, diskArtifactEvidenceReads, type ArtifactEvidenceReads,
} from "../../products/artifact-evidence-capture.js";
import type { PlanArtifactEvidenceDescriptorV1 } from "../../preparations/plan-types.js";
import type { ProviderInputSpecV1 } from "../../capability-providers/runtime/inputs.js";
import type { SourceEvidenceSpecsV1 } from "./source-evidence.js";

/** A failure names WHICH leg refused; "couldn't verify" is never "doesn't exist". */
export type ArtifactEvidenceOutcomeV1 =
  | { readonly status: "ok"; readonly built: SourceEvidenceSpecsV1 }
  | { readonly status: "unavailable"; readonly reason: string };

/** The capture's artifact-evidence reads plus the member-bytes read the rehash makes. No member takes a project root. */
export interface ArtifactEvidenceSpecReads extends ArtifactEvidenceReads {
  /** The bytes of `member` beside the artifact body `fileName`, within `maxBytes`. An unsafe name throws. */
  readMember(artifactType: string, slug: string, fileName: string, member: string, maxBytes: number): Promise<ArtifactMemberRead>;
}

/** LOCAL DISK. The incumbent root readers for `root`, each called when asked with its old arguments. */
function diskArtifactEvidenceSpecReads(root: string): ArtifactEvidenceSpecReads {
  return {
    ...diskArtifactEvidenceReads(root),
    readMember: (artifactType, slug, fileName, member, maxBytes) => {
      const { expectedDir } = artifactPaths(root, artifactType, slug, fileName);
      return readArtifactMemberBytes(root, memberLeafPath(expectedDir, member), expectedDir, maxBytes);
    },
  };
}

/** The same reads over the profile loader's sources and the artifact store's seam. Building it does no I/O. */
export function artifactEvidenceSpecReadsOver(profile: EffectiveProfileSources, store: ArtifactStoreReads): ArtifactEvidenceSpecReads {
  return {
    ...artifactEvidenceReadsOver(profile, store),
    readMember: (artifactType, slug, fileName, member, maxBytes) => store.artifactAt(artifactType, slug, fileName).readMemberBytes(member, maxBytes),
  };
}

/** The three sealed member columns, or null when absent/mismatched. */
function columnsOf(
  descriptor: PlanArtifactEvidenceDescriptorV1, value: Readonly<Record<string, unknown>>,
): { names: string[]; digests: string[]; byteCounts: string[] } | null {
  const names = value[descriptor.memberNamesField];
  const digests = value[descriptor.memberDigestsField];
  const byteCounts = value[descriptor.memberByteCountsField];
  if (!Array.isArray(names) || !Array.isArray(digests) || !Array.isArray(byteCounts)) return null;
  if (names.length !== digests.length || names.length !== byteCounts.length) return null;
  return { names: names.map(String), digests: digests.map(String), byteCounts: byteCounts.map(String) };
}

/** True when the artifact's CURRENT manifest rows equal the sealed columns exactly. */
function manifestMatchesSealed(
  entries: readonly ArtifactMemberEntry[], columns: { names: string[]; digests: string[]; byteCounts: string[] },
): boolean {
  if (entries.length !== columns.names.length) return false;
  return entries.every((entry, index) =>
    entry.fileName === columns.names[index]
    && `sha256:${entry.sha256}` === columns.digests[index]
    && String(entry.bytes) === columns.byteCounts[index]);
}

/**
 * Read, verify, and build the specs one sealed artifact-evidence descriptor names.
 *
 * @param root - Absolute project root.
 * @param descriptor - The plan-sealed descriptor from the provider executor.
 * @param value - The run's frozen action-input value carrying the ref + columns.
 */
export async function buildArtifactEvidenceSpecs(
  root: string,
  descriptor: PlanArtifactEvidenceDescriptorV1,
  value: Readonly<Record<string, unknown>>,
): Promise<ArtifactEvidenceOutcomeV1> {
  return buildArtifactEvidenceSpecsFrom(diskArtifactEvidenceSpecReads(root), descriptor, value);
}

/** {@link buildArtifactEvidenceSpecs} over {@link ArtifactEvidenceSpecReads}: THE ONE BODY. */
export async function buildArtifactEvidenceSpecsFrom(
  reads: ArtifactEvidenceSpecReads,
  descriptor: PlanArtifactEvidenceDescriptorV1,
  value: Readonly<Record<string, unknown>>,
): Promise<ArtifactEvidenceOutcomeV1> {
  const verified = await verifiedSealedEntries(reads, descriptor, value);
  if ("reason" in verified) return { status: "unavailable", reason: verified.reason };
  return materializeSealedMembers(reads, descriptor, verified);
}

/** Everything the materialization loop needs, verified: the entries, the type def, the artifact's coordinates, the sealed columns. */
interface VerifiedSealedV1 {
  entries: readonly ArtifactMemberEntry[];
  maxMemberBytes: number;
  ref: ArtifactRef;
  fileName: string;
  digests: string[];
  byteCounts: string[];
}

/** Health, manifest, and manifest-vs-sealed equality — every pre-read verification, or the named reason. */
async function verifiedSealedEntries(
  reads: ArtifactEvidenceSpecReads, descriptor: PlanArtifactEvidenceDescriptorV1, value: Readonly<Record<string, unknown>>,
): Promise<VerifiedSealedV1 | { reason: string }> {
  const columns = columnsOf(descriptor, value);
  if (columns === null) return { reason: "artifact-evidence-columns-invalid" };
  if (columns.names.length > descriptor.maxItems) return { reason: "artifact-evidence-over-item-cap" };
  const ref = parseArtifactRef(value[descriptor.refField]);
  if (ref === null) return { reason: "artifact-evidence-ref-invalid" };
  const manifest = await healthyManifestEntries(reads, ref);
  if ("reason" in manifest) return manifest;
  // THE DRIFT CHECK: a manifest differing from the sealed table is NOT what the
  // operator approved — the sealed table is the authority, the store merely
  // holds bytes. Its unique catch is forged EXTRA/DROPPED rows: every
  // store-side change already breaks the sealed Merkle-root ref itself.
  if (!manifestMatchesSealed(manifest.entries, columns)) return { reason: "artifact-evidence-manifest-drift" };
  return { ...manifest, digests: columns.digests, byteCounts: columns.byteCounts };
}

/** The pinned artifact's HEALTHY manifest entries and store geometry, or the named reason. */
async function healthyManifestEntries(
  reads: ArtifactEvidenceSpecReads, ref: ArtifactRef,
): Promise<Omit<VerifiedSealedV1, "digests" | "byteCounts"> | { reason: string }> {
  const loaded = await reads.nonDefaultProfile();
  if (!loaded) return { reason: "artifact-evidence-no-profile" };
  const def = loaded.profile.artifacts?.[ref.artifactType];
  if (def?.members === undefined) return { reason: "artifact-evidence-not-member-bearing" };
  // HEALTH FIRST: the full member-bearing verification (manifest, members, sweep).
  const resolution = await reads.resolve(loaded.profile, ref);
  if (resolution.health !== "ok") return { reason: `artifact-evidence-unhealthy-${resolution.health}` };
  const body = await reads.readBody(ref.artifactType, ref.slug, def.fileName, def.maxBytes);
  if (body.kind !== "ok") return { reason: `artifact-evidence-manifest-${body.kind}` };
  // BIND the read to the sealed ref: a rewrite racing between the resolve
  // above and this read is a store change, not drift in the sealed columns.
  if (hashArtifactBody(body.body) !== ref.sha256) return { reason: "artifact-evidence-manifest-raced" };
  const entries = parseMemberEntries(body.body);
  if (entries === null) return { reason: "artifact-evidence-manifest-unparseable" };
  return { entries, maxMemberBytes: def.members.maxMemberBytes, ref, fileName: def.fileName };
}

/** Read + REHASH each member against the SEALED digests, materializing the specs. */
async function materializeSealedMembers(
  reads: ArtifactEvidenceSpecReads, descriptor: PlanArtifactEvidenceDescriptorV1, verified: VerifiedSealedV1,
): Promise<ArtifactEvidenceOutcomeV1> {
  const specs: ProviderInputSpecV1[] = [];
  const pathTable: Record<string, string> = {};
  let totalBytes = 0;
  for (let index = 0; index < verified.entries.length; index += 1) {
    const entry = verified.entries[index]!;
    const { ref, fileName } = verified;
    const read = await reads.readMember(ref.artifactType, ref.slug, fileName, entry.fileName, verified.maxMemberBytes);
    if (read.kind !== "ok") return { status: "unavailable", reason: `artifact-evidence-member-${read.kind}` };
    totalBytes += read.body.length;
    if (totalBytes > descriptor.maxBytes) return { status: "unavailable", reason: "artifact-evidence-over-byte-cap" };
    const digest = `sha256:${createHash("sha256").update(read.body).digest("hex")}`;
    if (digest !== verified.digests[index]) return { status: "unavailable", reason: "artifact-evidence-digest-drift" };
    if (String(read.body.length) !== verified.byteCounts[index]) return { status: "unavailable", reason: "artifact-evidence-bytecount-drift" };
    const inputId = `${descriptor.inputIdPrefix}-${index}`;
    specs.push({
      inputId, kind: descriptor.kind, provenanceLabel: descriptor.provenanceLabel,
      mediaType: descriptor.mediaType, bytes: read.body,
    });
    pathTable[inputId] = entry.fileName;
  }
  return { status: "ok", built: { specs, pathTable } };
}
