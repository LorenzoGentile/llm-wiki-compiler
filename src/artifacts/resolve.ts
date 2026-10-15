/**
 * Resolve a hash-pinned artifact ref to a health verdict by verifying against the
 * ACTUAL bytes — never trusting the manifest hash alone (that would miss a bytes-only
 * tamper). Reads manifest + bytes through the confined readers, recomputes sha256 over
 * the bytes, and compares bytes↔manifest, ref↔recomputed, and (json) schema-over-bytes.
 * The metadata resolver never returns bodies; the verified reader returns only
 * the exact content whose integrity it checked, for loopback viewer access.
 *
 * ONE BODY: {@link readVerifiedArtifact} runs {@link readVerifiedArtifactFrom}
 * over the local disk. Which leaves are read, in what order and under which
 * caps, the verdict ladder, and what every outcome means are decided in this
 * file and in `resolve-members.ts`. The leaves themselves are ASKED FOR through
 * {@link ArtifactStoreReads}. WHAT ANSWERS ON DISK IS UNCHANGED AND STILL READS
 * A PROJECT ROOT: the store's confined, no-follow, capped readers and the
 * bounded directory lister. This file binds the resolver's decisions, not
 * those reads; nothing here is a hosted store or selects a backend.
 *
 * THE METADATA-ONLY RESOLUTION HAS ONE BODY TOO: {@link resolveArtifactRefFrom},
 * over the same {@link ArtifactStoreReads}. It is the verified read with the
 * body left out. {@link resolveArtifactRef} runs it over the local disk, and
 * the artifact health check (`profile/artifact-lint.ts`) runs it over the
 * store reads it is handed, so that check holds no project root for this.
 */
import type { ProfilePack, ArtifactTypeDef } from "../profile/types.js";
import type { ArtifactRef } from "./ref.js";
import {
  ARTIFACT_MANIFEST_MAX_BYTES, artifactPaths, hashArtifactBody, manifestReadOf, memberLeafPath, readArtifactBody, readArtifactMemberBytes,
  type ArtifactBodyRead, type ArtifactManifest, type ArtifactMemberRead,
} from "./store.js";
import { listConfinedDirBounded, type ConfinedDirListing } from "../utils/confined-dir.js";
import { readConfinedLeaf, type CappedLeafRead } from "../utils/confined-read.js";
import { validateArtifactBody } from "./body-contract.js";
import { verifyMembers } from "./resolve-members.js";

export type ArtifactHealth =
  | "ok" | "artifact-dangling" | "artifact-unreadable" | "artifact-bytes-tampered"
  | "artifact-schema-invalid" | "artifact-hash-mismatch" | "artifact-store-unavailable";

/**
 * Why an `artifact-store-unavailable` health arose: a genuine store fault
 * (malformed/unwritten manifest — retryable, so the write-time precondition
 * PARKS) vs a manifest integrity-lie (identity/contentKind/byte-count mismatch —
 * the manifest is adversarial, so the precondition DENIES). This lets the enforcer
 * split the OVERLOADED `artifact-store-unavailable` string WITHOUT widening the
 * public {@link ArtifactHealth} enum (FT3 deliberately avoided that).
 */
export type StoreFaultReason = "genuine-fault" | "integrity-lie";

/**
 * The full resolve verdict: the health, the parsed manifest (when it parsed at
 * all), and — ONLY when `health` is `artifact-store-unavailable` — the
 * discriminated {@link StoreFaultReason}. Read surfaces (lint/status/MCP) destructure
 * `{ health }` / `{ health, manifest }` and ignore `storeFault`, so this is additive.
 */
export interface ArtifactResolution {
  health: ArtifactHealth;
  manifest?: ArtifactManifest;
  storeFault?: StoreFaultReason;
}

/** A verified content snapshot; unhealthy results never carry a body. */
export type VerifiedArtifactRead = ArtifactResolution & { body?: string };

/**
 * True when the loaded profile declares at least one artifact type. Shared by
 * `artifact verify` (CLI) and `verifyArtifact` (SDK) so both surfaces refuse
 * a zero-artifact-types profile identically instead of drifting.
 */
export function declaresArtifactTypes(profile: { artifacts?: Record<string, unknown> }): boolean {
  return Object.keys(profile.artifacts ?? {}).length > 0;
}

/**
 * Thrown when verifying an artifact ref is requested for a project with no
 * active non-default profile, or one that declares NO artifact types at all.
 * In either case no ref could ever resolve, so verify fails CLOSED with a
 * dedicated, catchable error rather than falling through to
 * {@link resolveArtifactRef} and surfacing a misleading `"artifact-dangling"`
 * verdict. Mirrors {@link LifecycleTransitionUnavailableError}'s reason-coded
 * shape (`src/trust/lifecycle-apply.ts`).
 */
export class ArtifactVerifyUnavailableError extends Error {
  constructor(reason: "no-profile" | "no-artifact-types", detail: string) {
    super(`cannot verify artifact: ${detail}`);
    this.name = "ArtifactVerifyUnavailableError";
    void reason;
  }
}

/**
 * Terminal checks once a body has come back `ok` (identity/kind/oversize have
 * already cleared): the manifest's declared length, its own recorded hash, the
 * ref's pinned hash, and the write-time schema — in that order.
 */
function verifyOkBody(def: ArtifactTypeDef, ref: ArtifactRef, m: ArtifactManifest, body: string): { health: ArtifactHealth; storeFault?: StoreFaultReason } {
  // A byte-count divergence is a manifest lying about its own body length — an
  // integrity-lie the write-time precondition must DENY, not a retryable fault.
  if (m.bytes !== Buffer.byteLength(body, "utf8")) return { health: "artifact-store-unavailable", storeFault: "integrity-lie" };
  const recomputed = hashArtifactBody(body);
  if (recomputed !== m.sha256) return { health: "artifact-bytes-tampered" };
  if (recomputed !== ref.sha256) return { health: "artifact-hash-mismatch" };
  // The SAME validator the write plan ran (src/artifacts/body-contract.ts) — the read
  // side re-verifies with identical rules, so write/read contracts cannot drift.
  if (validateArtifactBody(def, body).length > 0) return { health: "artifact-schema-invalid" };
  return { health: "ok" };
}

/** Spread `manifest` into a resolve return only when the manifest itself parsed — omits the key entirely (rather than setting it `undefined`) for the absent/malformed/undeclared-type cases. */
function withManifest(manifest: ArtifactManifest | undefined): { manifest?: ArtifactManifest } {
  return manifest ? { manifest } : {};
}

/**
 * The MANIFEST-ONLY integrity check: a parsed manifest that LIES about its identity
 * (artifactType/slug) or contentKind is an integrity-lie the write-time precondition
 * DENIES. Never dereferences the body, so {@link resolveArtifactRef} applies it the
 * moment the manifest parses — BEFORE any body-readability check — so an unreadable
 * body can never launder a lie into a park (OQ10). Returns `undefined` when the
 * manifest is honest on these fields (the byte-count/sha checks live in verifyOkBody,
 * which genuinely needs the body bytes).
 */
function manifestIntegrityLie(def: ArtifactTypeDef, ref: ArtifactRef, m: ArtifactManifest): ArtifactResolution | undefined {
  if (m.artifactType !== ref.artifactType || m.slug !== ref.slug) return { health: "artifact-store-unavailable", storeFault: "integrity-lie", manifest: m };
  if (m.contentKind !== def.contentKind) return { health: "artifact-store-unavailable", storeFault: "integrity-lie", manifest: m };
  return undefined;
}

/**
 * One artifact's leaves, ALREADY LOCATED. OWNED BY THE RESOLVER: a narrow
 * seam, not `ProjectStore`, not a hosted or access-control contract. Each read
 * answers with the store's own outcome values and is asked afresh every time;
 * nothing is remembered between reads, and nothing makes two of them agree.
 */
export interface ArtifactLeafReads {
  /** The sidecar manifest's text within `maxBytes`. A leaf over the cap is `unavailable`. */
  readManifestText(maxBytes: number): Promise<CappedLeafRead>;
  /** The body's text within `maxBytes`. A body over the cap is `oversize` with its actual size, and is not read. */
  readBodyText(maxBytes: number): Promise<ArtifactBodyRead>;
  /** The artifact directory's entries; more than `maxEntries` is `unavailable`. */
  listEntries(maxEntries: number): Promise<ConfinedDirListing>;
  /** One member's bytes within `maxBytes`. THROWS `ArtifactPathError` for an unsafe member name, before any read. */
  readMemberBytes(fileName: string, maxBytes: number): Promise<ArtifactMemberRead>;
}

/** Where the resolver asks for an artifact's leaves. Owned by the resolver, like {@link ArtifactLeafReads}. */
export interface ArtifactStoreReads {
  /**
   * The artifact at these coordinates. Does no I/O. THROWS `ArtifactPathError`
   * for an unsafe type, slug or file name. The resolver asks ONCE before its
   * reads and ONCE MORE before the member step, each time with the values the
   * ref and the definition hold at that moment.
   */
  artifactAt(artifactType: string, slug: string, fileName: string): ArtifactLeafReads;
}

/**
 * LOCAL DISK. The artifact store's reads for the project at `root`. Building
 * them does no I/O; `artifactAt` validates and joins paths exactly as
 * `artifactPaths` does, and each read is the store's own confined reader with
 * the arguments the resolver always passed. Exported for the artifact health
 * check's disk builder only; in no package index.
 */
export function diskArtifactStoreReads(root: string): ArtifactStoreReads {
  return { artifactAt: (artifactType, slug, fileName) => {
    const paths = artifactPaths(root, artifactType, slug, fileName);
    return {
      readManifestText: (maxBytes) => readConfinedLeaf(root, paths.manifestPath, paths.expectedDir, maxBytes),
      readBodyText: (maxBytes) => readArtifactBody(root, paths, maxBytes),
      listEntries: (maxEntries) => listConfinedDirBounded(root, paths.relativeDir, maxEntries),
      readMemberBytes: (fileName, maxBytes) => readArtifactMemberBytes(root, memberLeafPath(paths.expectedDir, fileName), paths.expectedDir, maxBytes),
    };
  } };
}

/** Verify and return the same bounded content snapshot, never re-opening its path. */
export async function readVerifiedArtifact(root: string, profile: Pick<ProfilePack, "artifacts">, ref: ArtifactRef): Promise<VerifiedArtifactRead> {
  // `async` so that a throw while the disk reads are built REJECTS.
  return readVerifiedArtifactFrom(diskArtifactStoreReads(root), profile, ref);
}

/**
 * {@link readVerifiedArtifact} over {@link ArtifactStoreReads}: THE ONE BODY.
 * The declared-type check; the location; the manifest, then the body ALWAYS,
 * one after the other; the verdict ladder; then, for a member-bearing type
 * whose body verified, the location again and the members.
 */
export async function readVerifiedArtifactFrom(store: ArtifactStoreReads, profile: Pick<ProfilePack, "artifacts">, ref: ArtifactRef): Promise<VerifiedArtifactRead> {
  const def = declaredArtifact(profile, ref.artifactType);
  if (!def) return { health: "artifact-dangling" }; // undeclared type resolves to dangling on read; no manifest could ever exist
  const leaves = store.artifactAt(ref.artifactType, ref.slug, def.fileName);
  const manifest = manifestReadOf(await leaves.readManifestText(ARTIFACT_MANIFEST_MAX_BYTES));
  const body = await leaves.readBodyText(def.maxBytes);
  // Carry the PARSED manifest on every return below, independent of the overall
  // health verdict (not gated on `health === "ok"`): MCP's `verify_artifact`
  // shows manifest metadata whenever the manifest file itself parses — e.g. a
  // dangling body under an otherwise-valid manifest — so a caller consuming
  // this return for metadata must see the same thing resolve saw, in one read.
  const parsed = manifest.kind === "ok" ? manifest.manifest : undefined;
  // Integrity-lie check FIRST — before any body-readability check — so an unreadable
  // body can never launder an identity/kind lie into a park (see {@link manifestIntegrityLie}).
  if (manifest.kind === "ok") {
    const lie = manifestIntegrityLie(def, ref, manifest.manifest);
    if (lie) return lie;
  }
  // Discriminate: absent → dangling; a raw fault → unreadable; corrupt/wrong-shape manifest → store-unavailable.
  if (manifest.kind === "absent" || body.kind === "absent") return { health: "artifact-dangling", ...withManifest(parsed) };
  if (manifest.kind === "unavailable" || body.kind === "unavailable") return { health: "artifact-unreadable", ...withManifest(parsed) };
  if (manifest.kind === "malformed") return { health: "artifact-store-unavailable", storeFault: "genuine-fault" }; // never parsed — nothing to carry
  const m = manifest.manifest;
  if (body.kind === "oversize") {
    // The on-disk body exceeds `def.maxBytes` but is CONFIRMED in-root (see
    // `readArtifactBody`'s doc) — we cannot recompute its sha at this size, so
    // the recorded, co-tamperable `manifest.bytes` length (NOT a cryptographic
    // signature) is the strongest available signal: a divergence proves the
    // bytes changed (tampered); equality means the artifact was written
    // honestly and only the CURRENT, lowered `maxBytes` now excludes it
    // (benign policy — stays a park/warning, not an alarm).
    return { health: body.actualBytes !== m.bytes ? "artifact-bytes-tampered" : "artifact-unreadable", manifest: m };
  }
  return verifiedContent(store, def, { ref, manifest: m, body: body.body });
}

/** Release the captured body only after its contract and any binary members verify. */
async function verifiedContent(store: ArtifactStoreReads, def: ArtifactTypeDef,
  captured: { ref: ArtifactRef; manifest: ArtifactManifest; body: string },
): Promise<VerifiedArtifactRead> {
  const { ref, manifest, body } = captured;
  const verdict = verifyOkBody(def, ref, manifest, body);
  if (verdict.health === "ok" && def.members !== undefined) {
    // Located AGAIN, from what the ref and the definition hold NOW: the manifest and body above keep the first location.
    const leaves = store.artifactAt(ref.artifactType, ref.slug, def.fileName);
    const health = await verifyMembers(leaves, def, body);
    if (health !== null) return { health, manifest };
  }
  return { ...verdict, manifest, ...(verdict.health === "ok" ? { body } : {}) };
}

/** Prototype properties are not profile declarations, even for structurally valid ids. */
function declaredArtifact(profile: Pick<ProfilePack, "artifacts">, type: string): ArtifactTypeDef | undefined {
  const definitions = profile.artifacts ?? {};
  return Object.hasOwn(definitions, type) ? definitions[type] : undefined;
}

/** Metadata-only resolution remains body-free for lint, status and SDK consumers. */
export async function resolveArtifactRef(root: string, profile: ProfilePack, ref: ArtifactRef): Promise<ArtifactResolution> {
  // `async` so that a throw while the disk reads are built REJECTS.
  return resolveArtifactRefFrom(diskArtifactStoreReads(root), profile, ref);
}

/**
 * {@link resolveArtifactRef} over {@link ArtifactStoreReads}: THE ONE BODY of
 * the metadata-only resolution. It runs {@link readVerifiedArtifactFrom} once
 * and hands back everything but the body, so the result never has a `body`
 * key, healthy or not.
 */
export async function resolveArtifactRefFrom(store: ArtifactStoreReads, profile: ProfilePack, ref: ArtifactRef): Promise<ArtifactResolution> {
  const { body: _body, ...resolution } = await readVerifiedArtifactFrom(store, profile, ref);
  return resolution;
}
