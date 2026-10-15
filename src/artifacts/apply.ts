/**
 * Under-lock artifact write authority — the mirror of applyRelationLocked, with
 * page-style two-file journal durability. Re-loads the profile, COMPOSES the real
 * trust decision (plan.ts), denies on a non-live decision, gates on the
 * LLMWIKI_TRUSTED_WRITE grant (v0 has no byte-staging store), root-anchors the
 * targets' shared PARENT directory BEFORE journaling and refuses non-regular
 * pre-existing targets BEFORE journaling too (`apply-guards.ts`), preflights the
 * exact derived-only audit event, journals the pre-state of BOTH targets, writes
 * bytes then manifest, commits, then emits. Applied-once only when manifest
 * identity AND on-disk bytes both verify.
 *
 * A MEMBER-BEARING type takes the same admission (plan → grant) and then the
 * members write path (`apply-members.ts`): one batch over the manifest pair, the
 * member leaves, and any obsolete leaf.
 *
 * ONE BODY. {@link applyArtifactLocked} runs {@link applyArtifactLockedWith}
 * over {@link localArtifactApplySources}: the incumbent profile load, the
 * trusted-write grant (AUTHORITY, read at call time), the members write path
 * (DOMAIN, still root-bound), the target guard and the durable two-file writer
 * (PHYSICAL), the accepted confined store reads, the page journal's raw I/O, and
 * the audit store's bound-append sources. Admission, the order, the bytes, the
 * caps, applied-once and the files-before-event residual stay in this file. The
 * single body is a UTF-8 string end to end, as it always was, and nothing here
 * adds a conversion. The caller still holds the lock; nothing here takes one.
 */
import { loadNonDefaultProfile } from "../profile/block.js";
import type { LoadedProfile } from "../profile/types.js";
import { isTrustedWriteGranted } from "../trust/trusted-write.js";
import { commitBatchFrom, openBatchFrom, recordPreStateFrom } from "../trust/journal.js";
import { diskJournalBatchIo, type JournalBatchIo } from "../trust/journal-io.js";
import {
  appendBoundEventLockedFrom, appendEventLockedFrom, diskEventBoundWriteSources, preflightEventAppendFrom,
  type EventBoundWriteSources,
} from "../events/store.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import type { ArtifactPlannedMutation } from "../trust/planner.js";
import type { ArtifactRef } from "./ref.js";
import type { TrustDecision } from "../trust/decision.js";
import { planArtifactMutation, ARTIFACT_LIVE_WRITE_DECISIONS } from "./plan.js";
import {
  ARTIFACT_MANIFEST_MAX_BYTES, artifactPaths, hashArtifactBody, manifestReadOf, writeArtifactFiles, type ArtifactManifest, type ArtifactPathsV1,
} from "./store.js";
import { diskArtifactStoreReads, type ArtifactLeafReads, type ArtifactStoreReads } from "./resolve.js";
import { snapshotMemberFiles } from "./members.js";
import { applyMembersLocked, type MembersWriteV1 } from "./apply-members.js";
import {
  ArtifactWriteDeniedError, ArtifactWriteRefusedError, artifactEvent, assertTargetsRegularOrAbsent, refAndManifest,
} from "./apply-guards.js";

// The typed refusal classes keep their historical import home (the members-only
// ArtifactTargetDirUnreadableError lives in apply-guards until a surface routes it).
export {
  ArtifactWriteDeniedError, ArtifactWriteRefusedError, ArtifactTargetNotRegularError, ArtifactTargetDirEscapesRootError,
} from "./apply-guards.js";

/**
 * Everything {@link applyArtifactLockedWith} asks for: five artifact members
 * (DOMAIN, AUTHORITY, and two PHYSICAL ones) and the existing store-read, page
 * journal and audit ports. Not `ProjectStore`, not hosted, and it selects no
 * backend.
 */
export interface ArtifactApplySources {
  /** The project root, handed to the paths and the journal as data. */
  root: string;
  /** DOMAIN. The active non-default profile, or `undefined`. Local: `loadNonDefaultProfile(root)`. */
  loadProfile(): Promise<LoadedProfile | undefined>;
  /** AUTHORITY. Whether the out-of-band trusted-write grant covers `profileId`. Local: `isTrustedWriteGranted(profileId)` (the environment, at call time). */
  trustedWrite(profileId: string): boolean;
  /** DOMAIN. The member-bearing write path, still root-bound. Local: `applyMembersLocked(write)`. */
  applyMembers(write: MembersWriteV1): Promise<{ ref: ArtifactRef; decision: TrustDecision }>;
  /** PHYSICAL. The parent confinement then the regular-or-absent check of each target. Local: `assertTargetsRegularOrAbsent(root, …)`. */
  guardTargets(expectedDir: string, targets: readonly string[]): Promise<void>;
  /** PHYSICAL, DURABLE. The body then the manifest, each a confined durable atomic write. Local: `writeArtifactFiles(root, …)`. */
  writeFiles(paths: ArtifactPathsV1, body: string, manifest: ArtifactManifest): Promise<void>;
  /** The accepted confined artifact reads. Local: `diskArtifactStoreReads(root)`. */
  store: ArtifactStoreReads;
  /** The page journal's raw I/O. Local: `diskJournalBatchIo`. */
  journal: JournalBatchIo;
  /** The audit store's read, repair, pre-flight, append, seal and durable header. Local: `diskEventBoundWriteSources(root)`. */
  events: EventBoundWriteSources;
}

/** LOCAL. The incumbent collaborators for the project at `root`, each called at call time. Building them does no I/O. In no package index. */
function localArtifactApplySources(root: string): ArtifactApplySources {
  return {
    root,
    loadProfile: () => loadNonDefaultProfile(root),
    trustedWrite: (profileId) => isTrustedWriteGranted(profileId),
    applyMembers: (write) => applyMembersLocked(write),
    guardTargets: (expectedDir, targets) => assertTargetsRegularOrAbsent(root, expectedDir, targets),
    writeFiles: (paths, body, manifest) => writeArtifactFiles(root, paths, body, manifest),
    store: diskArtifactStoreReads(root),
    journal: diskJournalBatchIo,
    events: diskEventBoundWriteSources(root),
  };
}

/**
 * Applied-once: manifest identity AND on-disk bytes must BOTH verify (a lying/orphaned manifest is rewritten).
 * The manifest is read at its 64 KiB cap; the body only when the identity matches, at the type's `maxBytes`.
 */
async function isAlreadyAppliedFrom(leaves: ArtifactLeafReads, m: ArtifactManifest, maxBytes: number): Promise<boolean> {
  const existing = manifestReadOf(await leaves.readManifestText(ARTIFACT_MANIFEST_MAX_BYTES));
  if (existing.kind !== "ok") return false;
  const e = existing.manifest;
  if (e.sha256 !== m.sha256 || e.bytes !== m.bytes || e.contentKind !== m.contentKind
    || e.artifactType !== m.artifactType || e.slug !== m.slug) return false;
  const onDisk = await leaves.readBodyText(maxBytes);
  return onDisk.kind === "ok" && hashArtifactBody(onDisk.body) === m.sha256
    && Buffer.byteLength(onDisk.body, "utf8") === m.bytes;
}

/** Journal BOTH targets' pre-states, write body then manifest, and commit, through the sources' journal I/O. A failed write leaves the batch pending for the next replay, as it always did. */
async function writeUnderJournal(sources: ArtifactApplySources, paths: ArtifactPathsV1, body: string, manifest: ArtifactManifest): Promise<void> {
  const batch = await openBatchFrom(sources.journal, sources.root);
  await recordPreStateFrom(sources.journal, batch, paths.bytesPath);
  await recordPreStateFrom(sources.journal, batch, paths.manifestPath);
  await sources.writeFiles(paths, body, manifest);
  await commitBatchFrom(sources.journal, batch);
}

/**
 * Apply an `artifact` mutation WHILE THE CALLER ALREADY HOLDS the project lock —
 * the under-lock authority for the artifact kind. RE-loads the active profile
 * under the lock, COMPOSES the real decision via {@link planArtifactMutation}
 * (an undeclared type or a body-contract violation denies WITHOUT the grant
 * hint — a grant cannot override a planner block), then gates the live-decision
 * case on the operator {@link isTrustedWriteGranted} grant (the ONLY refusal
 * that advises it). The targets' parent directory and any pre-existing
 * non-regular target are both refused BEFORE any journal write (see the file
 * overview). Applied-once short-circuits only when
 * BOTH the manifest and the on-disk bytes verify; otherwise the bytes are
 * (re)written under the journal and the audit event is emitted.
 *
 * @param root - Absolute project root (the caller holds its lock).
 * @param mutation - The planned artifact mutation (intent only; not trusted).
 * @returns The persisted {@link ArtifactRef} and the composed live-write decision.
 */
export async function applyArtifactLocked(root: string, supplied: ArtifactPlannedMutation, binding?: OperationBinding): Promise<{ ref: ArtifactRef; decision: TrustDecision }> {
  return applyArtifactLockedWith(localArtifactApplySources(root), supplied, binding);
}

/**
 * {@link applyArtifactLocked} over {@link ArtifactApplySources}: THE ONE BODY,
 * in the incumbent order. The caller MUST already hold the project lock.
 *
 * @param sources - The artifact members and the store-read, journal and audit ports.
 * @param supplied - The planned artifact mutation (snapshotted before any await).
 * @param binding - The operation binding for a bundle-produced write, if any.
 * @returns The artifact ref and the composed live-write decision.
 */
export async function applyArtifactLockedWith(
  sources: ArtifactApplySources,
  supplied: ArtifactPlannedMutation,
  binding?: OperationBinding,
): Promise<{ ref: ArtifactRef; decision: TrustDecision }> {
  // SNAPSHOT the member bytes before anything else awaits: the plan hashes
  // them and the write lands them, and both must see the SAME frozen bytes
  // even if the caller mutates its buffers mid-flight (see members.ts).
  const mutation: ArtifactPlannedMutation = supplied.memberFiles === undefined
    ? supplied : { ...supplied, memberFiles: snapshotMemberFiles(supplied.memberFiles) };
  const loaded = await sources.loadProfile();
  if (!loaded) throw new ArtifactWriteDeniedError(mutation.artifactType, "deny", ["no profile is active; artifacts require a profile-declared artifact type"]);
  const { decision, checks, def, body } = planArtifactMutation(loaded.profile, mutation);
  if (!ARTIFACT_LIVE_WRITE_DECISIONS.has(decision) || !def || body === undefined) {
    throw new ArtifactWriteDeniedError(mutation.artifactType, decision, checks.filter((c) => c.verdict !== "pass").map((c) => c.message));
  }
  if (!sources.trustedWrite(loaded.profile.profileId)) throw new ArtifactWriteRefusedError(mutation.artifactType);
  const paths = artifactPaths(sources.root, mutation.artifactType, mutation.slug, def.fileName);
  if (def.members !== undefined) {
    return sources.applyMembers({ root: sources.root, profile: loaded.profile, def, mutation, body, decision, paths, binding });
  }
  // The store coordinates are fixed HERE, from the values `artifactPaths` just validated; `artifactAt`
  // does no I/O and repeats only those already-passed checks, so it adds no error path.
  const leaves = sources.store.artifactAt(mutation.artifactType, mutation.slug, def.fileName);
  await sources.guardTargets(paths.expectedDir, [paths.bytesPath, paths.manifestPath]); // BEFORE journaling — see file overview
  const { ref, manifest } = refAndManifest(mutation, def.contentKind, hashArtifactBody(body), body) as { ref: ArtifactRef; manifest: ArtifactManifest };
  if (await isAlreadyAppliedFrom(leaves, manifest, def.maxBytes)) return { ref, decision };
  const event = artifactEvent(manifest, mutation.origin, decision); // build ONCE — preflight and append the SAME object
  await preflightEventAppendFrom(sources.events, event);
  await writeUnderJournal(sources, paths, body, manifest);
  if (binding === undefined) await appendEventLockedFrom(sources.events, event);
  else await appendBoundEventLockedFrom(sources.events, event, binding);
  return { ref, decision };
}
