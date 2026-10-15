/**
 * @file test/fixtures/portable-local-control.ts
 * @description Test support: the local host's control plane on disk, and
 * project registration, as the portable prototype wrote them. Public builds
 * ship no way to register a project; the gate witnesses use this to create the
 * registered state that `src/portable/host/pending-gate.ts` reads.
 *
 * The host identity is PERSISTED: its incarnation and the secret that keys
 * operation ids are stable across CLI processes and restarts, so an id
 * allocated by one command is honoured by the next. If that identity is ever
 * lost, a fresh one is minted and old ids simply stop verifying; nothing
 * re-creates an old identity against an empty ledger.
 *
 * Registration is the one knowing opt-in. It issues a new project id for a
 * canonical root, binds the registering OS user as owner, and records the
 * portable format version and the features a binary must support. It refuses a
 * root that already carries another identity's portable ledger, and roots it
 * can recognise as sync-managed or network-backed.
 */

import { randomBytes } from "node:crypto";
import { mkdir, realpath, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureOwnerPrivateDirectory } from "../../src/capability-providers/packages/paths.js";
import { atomicWrite, atomicWriteNoReplaceDurable, AtomicWriteCollisionError } from "../../src/utils/atomic-write.js";
import { PortableHostError } from "../../src/portable/errors.js";
import { PORTABLE_DIR } from "../../src/portable/store/disk-layout.js";
import {
  DEFAULT_HOST_LIMITS, REQUIRED_FEATURES, type HostControl, type HostLimits,
  type ProjectControlRecord,
} from "../../src/portable/host/control.js";
import {
  hostIdentityFile, localControlRoot, projectRecordFile, readJsonFile, registeredProjectId, rootMappingFile,
} from "../../src/portable/host/local-registry.js";

/** Owner-only mode for control-state files. */
const PRIVATE_FILE_MODE = 0o600;

/** Path fragments of folders a sync client manages. Recognition is deliberately incomplete. */
const SYNC_MANAGED_MARKERS = [
  "/Library/Mobile Documents/", "/Library/CloudStorage/", "/Dropbox/", "/OneDrive", "/Google Drive/",
];

/** Linux filesystem magic numbers for network and userspace filesystems. */
const NON_LOCAL_FS_TYPES: ReadonlySet<number> = new Set([0x6969, 0xff534d42, 0x65735546, 0x517b, 0x01021997]);

/** The persisted identity of this user's local host. */
interface HostIdentity { incarnation: string; secret: string }

/** Write one owner-private control file atomically. */
async function writeControlFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, JSON.stringify(value, null, 2), { mode: PRIVATE_FILE_MODE });
}

/**
 * Mint the host identity exactly once. It is published create-only and durably,
 * so two first opens racing each other cannot each keep an incarnation: one
 * write wins, and the loser loads and uses the winner's.
 */
async function createHostIdentity(controlRoot: string): Promise<HostIdentity> {
  const minted = { incarnation: randomBytes(16).toString("hex"), secret: randomBytes(32).toString("base64") };
  const file = hostIdentityFile(controlRoot);
  try {
    await atomicWriteNoReplaceDurable(file, JSON.stringify(minted, null, 2), { mode: PRIVATE_FILE_MODE });
    return minted;
  } catch (error) {
    if (!(error instanceof AtomicWriteCollisionError)) throw error;
  }
  const winner = await readJsonFile<HostIdentity>(file);
  if (winner === null) throw new PortableHostError("host identity could not be established");
  return winner;
}

/** The local host's control plane, backed by owner-private files outside every project. */
class LocalHostControl implements HostControl {
  private constructor(
    private readonly controlRoot: string,
    readonly incarnation: string,
    readonly secret: Buffer,
    readonly limits: HostLimits,
  ) {}

  /** Open (creating on first use) the control plane under the per-user control root. */
  static async open(controlRoot = localControlRoot()): Promise<LocalHostControl> {
    const root = await ensureOwnerPrivateDirectory(controlRoot);
    const identity = (await readJsonFile<HostIdentity>(hostIdentityFile(root))) ?? (await createHostIdentity(root));
    return new LocalHostControl(root, identity.incarnation, Buffer.from(identity.secret, "base64"), DEFAULT_HOST_LIMITS);
  }

  loadProject(projectId: string): Promise<ProjectControlRecord | null> {
    if (!/^prj_[0-9a-f]+$/u.test(projectId)) return Promise.resolve(null);
    return readJsonFile<ProjectControlRecord>(projectRecordFile(this.controlRoot, projectId));
  }

  saveProject(record: ProjectControlRecord): Promise<void> {
    return writeControlFile(projectRecordFile(this.controlRoot, record.projectId), record);
  }

  /** The local audit sink is a no-op in the prototype: the local owner is trusted. */
  audit(): void {}

  /** Map a canonical root to the project id issued for it. */
  mapRoot(canonicalRoot: string, projectId: string): Promise<void> {
    return writeControlFile(rootMappingFile(this.controlRoot, canonicalRoot), { projectId, canonicalRoot });
  }

  /** The project registered for `root`, or `null`. */
  async projectForRoot(root: string): Promise<ProjectControlRecord | null> {
    const projectId = await registeredProjectId(root, this.controlRoot);
    return projectId === null ? null : this.loadProject(projectId);
  }
}

/** The subject the local host derives for the OS user running it. */
function localSubject(): string {
  return `local:${os.userInfo().username}`;
}

/** Refuse roots recognisable as sync-managed or network-backed (D22). Not a complete detector. */
async function assertQualifiedRoot(canonicalRoot: string): Promise<void> {
  const marker = SYNC_MANAGED_MARKERS.find((fragment) => `${canonicalRoot}/`.includes(fragment));
  if (marker) throw new PortableHostError(`unsupported root: ${marker.trim()} looks sync-managed`);
  const type = await statfs(canonicalRoot).then((info) => Number(info.type)).catch(() => null);
  if (type !== null && NON_LOCAL_FS_TYPES.has(type)) {
    throw new PortableHostError("unsupported root: not a local regular filesystem");
  }
}

/** A portable directory already at `root` belongs to another identity: never adopted. */
async function assertNoForeignLedger(canonicalRoot: string): Promise<void> {
  const existing = await stat(path.join(canonicalRoot, PORTABLE_DIR)).catch(() => null);
  if (existing !== null) {
    throw new PortableHostError(
      `${PORTABLE_DIR} already exists and belongs to another registration; move it aside before registering`,
    );
  }
}

/** What registering a root reports. */
export interface RegistrationResult {
  record: ProjectControlRecord;
  /** False when the root was already registered and nothing changed. */
  created: boolean;
  requirement: string;
}

const ROOT_REQUIREMENT =
  "Supported only on a local regular filesystem with cooperating writers; network and sync-managed folders are not supported, and not every such folder can be recognised.";

/**
 * Register a project directory for the portable path.
 *
 * @param root - The project directory. Its canonical path is what gets bound.
 * @param controlRoot - The host control root (defaults to the per-user one).
 */
export async function registerLocalProject(root: string, controlRoot?: string): Promise<RegistrationResult> {
  const canonicalRoot = await realpath(root);
  const control = await LocalHostControl.open(controlRoot);
  const existing = await control.projectForRoot(canonicalRoot);
  if (existing !== null) return { record: existing, created: false, requirement: ROOT_REQUIREMENT };
  await assertQualifiedRoot(canonicalRoot);
  await assertNoForeignLedger(canonicalRoot);
  const projectId = `prj_${randomBytes(12).toString("hex")}`;
  const record: ProjectControlRecord = {
    projectId, tenant: "local", formatVersion: 1, requiredFeatures: [...REQUIRED_FEATURES],
    compartment: `${projectId}:default`, policyRevision: 1, ticketRevision: 1,
    bindings: [{ subject: localSubject(), roles: ["owner"] }], serviceGrants: [], tickets: [], canonicalRoot,
    hostIncarnation: control.incarnation,
  };
  await control.saveProject(record);
  await mkdir(path.join(canonicalRoot, PORTABLE_DIR), { recursive: true, mode: 0o700 });
  await control.mapRoot(canonicalRoot, projectId);
  return { record, created: true, requirement: ROOT_REQUIREMENT };
}
