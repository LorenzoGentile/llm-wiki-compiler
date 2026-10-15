/**
 * @file src/profile/templates/remote-lifecycle.ts
 * @description Exact remote release resolution for advisory planning and
 * under-lock update execution. Lock fields locate evidence but never bless it.
 *
 * The PROJECT sequencing is one body each over {@link RemotePlanSteps}:
 * {@link resolveRemoteUpdatePairFrom} (the provenance lock read and its refusal,
 * then the pair) and {@link planRemoteTemplateUpdateWith} (pair, then the active
 * profile, then the plan). Remote tap resolution ({@link resolveRemotePairFromLock})
 * stays a HOST step, unchanged; the root forms build the local steps per call.
 */
import { loadProfile } from "../load.js";
import type { LoadedProfile } from "../types.js";
import { compareTemplateVersions } from "./registry.js";
import { readTemplateLock, type TemplateLockRead } from "./lock.js";
import { parseTemplateCoordinate, type TemplateCoordinate } from "./signing/protocol.js";
import { resolveRemotePackage, type ResolvedRemotePackage } from "./taps/package.js";
import type { TapPaths } from "./taps/paths.js";
import type { RemoteTemplateProvenance, TemplateLockV2 } from "./types.js";
import { planTemplateUpdate, type TemplateUpdatePlan } from "./update.js";

/** Exact verified base and target releases for one remote update attempt. */
export interface RemoteUpdatePair {
  lock: TemplateLockV2;
  base: ResolvedRemotePackage;
  candidate: ResolvedRemotePackage;
  fromCoordinate: string;
  toCoordinate: string;
}

/** Advisory remote plan with fully qualified release identities. */
export interface RemoteTemplateUpdatePlan extends TemplateUpdatePlan {
  fromCoordinate: string;
  toCoordinate: string;
}

/** Parse a complete remote lock and require all identity fields to agree. */
export function remoteCoordinateFromLock(lock: TemplateLockV2): TemplateCoordinate {
  if (!lock.remote) throw new Error("remote template provenance is missing");
  const coordinate = parseTemplateCoordinate(lock.remote.coordinate);
  if (coordinate.tap !== lock.remote.tap
    || coordinate.publisher !== lock.publisher
    || coordinate.templateId !== lock.templateId
    || coordinate.version !== lock.version) {
    throw new Error("remote template provenance identity is inconsistent");
  }
  return coordinate;
}

/** Derive advisory remote provenance exclusively from verified resolver output. */
export function remoteProvenanceForResolved(resolved: ResolvedRemotePackage): RemoteTemplateProvenance {
  const coordinate = parseTemplateCoordinate(resolved.coordinate);
  return {
    coordinate: resolved.coordinate,
    packageDigest: resolved.payloadDigest,
    tap: coordinate.tap,
    indexSequence: resolved.tapSequence,
    publisherKeyId: resolved.publisherKeyId,
    verifiedAt: new Date().toISOString(),
  };
}

/** What the remote planning asks of the project and the host. No member takes a project root. */
export interface RemotePlanSteps {
  /** The advisory provenance lock. Local: `readTemplateLock(root)`. */
  readTemplateLock(): Promise<TemplateLockRead>;
  /** HOST. The verified base and target pair. Local: {@link resolveRemotePairFromLock} over the tap paths. */
  resolvePairFromLock(lock: TemplateLockV2, toVersion: string, offline: boolean): Promise<RemoteUpdatePair>;
  /** The active profile. Local: `loadProfile(root)`. */
  loadProfile(): Promise<LoadedProfile>;
  /** DOMAIN. The compatibility plan. Local: `planTemplateUpdate(root, ...)`. */
  planUpdate(active: LoadedProfile["profile"], base: ResolvedRemotePackage["package"], candidate: ResolvedRemotePackage["package"]): Promise<TemplateUpdatePlan>;
}

/** LOCAL. The project collaborators for one root and the host tap resolution, built per call. */
function localRemotePlanSteps(root: string, paths: TapPaths): RemotePlanSteps {
  return {
    readTemplateLock: () => readTemplateLock(root),
    resolvePairFromLock: (lock, toVersion, offline) => resolveRemotePairFromLock(paths, lock, toVersion, offline),
    loadProfile: () => loadProfile(root),
    planUpdate: (active, base, candidate) => planTemplateUpdate(root, active, base, candidate),
  };
}

/** Produce a read-only remote update plan from independently verified releases. */
export async function planRemoteTemplateUpdate(
  root: string,
  paths: TapPaths,
  toVersion: string,
): Promise<RemoteTemplateUpdatePlan> {
  return planRemoteTemplateUpdateWith(localRemotePlanSteps(root, paths), toVersion);
}

/** {@link planRemoteTemplateUpdate} over {@link RemotePlanSteps}: the pair, then the active profile, then the plan. */
export async function planRemoteTemplateUpdateWith(steps: RemotePlanSteps, toVersion: string): Promise<RemoteTemplateUpdatePlan> {
  const pair = await resolveRemoteUpdatePairFrom(steps, toVersion, false);
  const active = (await steps.loadProfile()).profile;
  const plan = await steps.planUpdate(active, pair.base.package, pair.candidate.package);
  return { ...plan, fromCoordinate: pair.fromCoordinate, toCoordinate: pair.toCoordinate };
}

/** Resolve using the advisory lock belonging to a specific project root. */
export async function resolveRemoteUpdatePairForRoot(
  root: string,
  paths: TapPaths,
  toVersion: string,
  offline: boolean,
): Promise<RemoteUpdatePair> {
  return resolveRemoteUpdatePairFrom(localRemotePlanSteps(root, paths), toVersion, offline);
}

/** {@link resolveRemoteUpdatePairForRoot} over {@link RemotePlanSteps}: a current v2 remote lock, else refuse, then the pair. */
export async function resolveRemoteUpdatePairFrom(
  steps: Pick<RemotePlanSteps, "readTemplateLock" | "resolvePairFromLock">,
  toVersion: string,
  offline: boolean,
): Promise<RemoteUpdatePair> {
  const lockRead = await steps.readTemplateLock();
  if (lockRead.kind !== "ok" || lockRead.lock.schemaVersion !== 2 || lockRead.lock.sourceType !== "remote") {
    throw new Error(`remote update provenance is ${lockRead.kind}`);
  }
  return steps.resolvePairFromLock(lockRead.lock, toVersion, offline);
}

/** Resolve a pair from a freshly read v2 remote lock. */
export async function resolveRemotePairFromLock(
  paths: TapPaths,
  lock: TemplateLockV2,
  toVersion: string,
  offline: boolean,
): Promise<RemoteUpdatePair> {
  const installed = remoteCoordinateFromLock(lock);
  const target = `${installed.tap}/${installed.publisher}/${installed.templateId}@${toVersion}`;
  parseTemplateCoordinate(target);
  if (compareTemplateVersions(toVersion, installed.version) <= 0) {
    throw new Error("remote template update target must be newer than the installed version");
  }
  const [base, candidate] = await Promise.all([
    resolveRemotePackage(paths, lock.remote!.coordinate, { offline }),
    resolveRemotePackage(paths, target, { offline }),
  ]);
  assertLockMatchesResolved(lock, base);
  if (base.indexExpired || candidate.indexExpired) throw new Error("remote template update requires current tap evidence");
  return { lock, base, candidate, fromCoordinate: base.coordinate, toCoordinate: candidate.coordinate };
}

function assertLockMatchesResolved(lock: TemplateLockV2, base: ResolvedRemotePackage): void {
  if (lock.remote!.packageDigest !== base.payloadDigest || lock.remote!.publisherKeyId !== base.publisherKeyId) {
    throw new Error("verified installed release differs from advisory provenance locator");
  }
}
