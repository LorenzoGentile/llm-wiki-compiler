/**
 * @file src/portable/host/pending-gate.ts
 * @description The pending-portable-intent leg of the mutation gate, and the
 * registration-aware wrapper for legacy writers that take no lock.
 *
 * OPT-IN BY CONSTRUCTION. The first thing either function does is one `lstat`
 * of `.llmwiki/portable/`. That directory exists only in a project someone
 * registered, so on every other project the answer is "no" after a single
 * `lstat` and NOTHING else runs: no control-state lookup, no ledger read, no
 * lock. The directory is feature discovery, never authority — a registered
 * project is one the host's control state maps to this exact root.
 *
 * On a registered project, ordinary mutations are refused while a portable
 * publication intent is unresolved, exactly as an unsettled operation bundle
 * refuses them today. Only portable recovery or an operator's resolve proceeds.
 *
 * ONE BODY, TWO COLLABORATORS. `portableGateBlockFrom` decides the gate over
 * PROJECT reads (the portable directory, the unresolved intent ledger) and HOST
 * control reads (this root's registration and its control record), kept apart
 * because they are different authorities. `portableGateBlock` keeps its
 * signature and delegates over the local bindings, built per call. Nothing here
 * selects a backend or adds hosted semantics.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { unresolvedDiskIntents } from "../store/disk-intent.js";
import { PORTABLE_DIR } from "../store/disk-layout.js";
import { isSupportedRegistration, type ProjectControlRecord } from "./control.js";
import { localControlRoot, projectRecordFile, readJsonFile, registeredProjectId } from "./local-registry.js";

/** True when `root` has the portable directory at all: one `lstat`, nothing more. */
export async function hasPortableDirectory(root: string): Promise<boolean> {
  try {
    return (await lstat(path.join(root, PORTABLE_DIR))).isDirectory();
  } catch {
    return false;
  }
}

/** Why an ordinary mutation of a project carrying a portable directory must not proceed. */
export type PortableGateBlock = "unresolved-intent" | "unsupported-registration";

/** What the gate asks of the PROJECT: whether it carries the portable directory, and its unresolved intents. */
export interface PortableGateProjectReads {
  hasPortableDirectory(): Promise<boolean>;
  unresolvedIntents(): Promise<readonly string[]>;
}

/** What the gate asks of the HOST control state: this project's registration, and its control record. */
export interface PortableGateHostReads {
  /** The host-issued project id this root is registered under, or null. */
  registeredProjectId(): Promise<string | null>;
  /** That project's control record, or null when there is none; a rejection is treated as unreadable. */
  readProjectRecord(projectId: string): Promise<ProjectControlRecord | null>;
}

/** The local project reads for one root, built per call. Internal; in no package index. */
export function localPortableGateProjectReads(root: string): PortableGateProjectReads {
  return { hasPortableDirectory: () => hasPortableDirectory(root), unresolvedIntents: () => unresolvedDiskIntents(root) };
}

/** The local host control reads for one root, built per call: the control root is resolved when asked. */
export function localPortableGateHostReads(root: string): PortableGateHostReads {
  return {
    registeredProjectId: () => registeredProjectId(root),
    readProjectRecord: (projectId) => readJsonFile<ProjectControlRecord>(projectRecordFile(localControlRoot(), projectId)),
  };
}

/**
 * Whether an ordinary mutation of `root` must be refused, and why.
 *
 * FAIL CLOSED once the portable directory exists. An unresolved publication
 * intent blocks whether or not control state can be found: missing or
 * unreadable control state must never be a way around an existing ledger. A
 * registered project additionally has its registration record validated, so a
 * binary that does not support the project's format or required features
 * refuses to mutate it at all (D24), not only to open it portably.
 */
export async function portableGateBlock(root: string): Promise<PortableGateBlock | null> {
  return portableGateBlockFrom(localPortableGateProjectReads(root), localPortableGateHostReads(root));
}

/**
 * {@link portableGateBlock} over its two collaborators: the one body. Without the
 * portable directory nothing else is read, neither ledger nor host; an
 * unresolved intent refuses before, and regardless of, any host read.
 */
export async function portableGateBlockFrom(
  project: PortableGateProjectReads, host: PortableGateHostReads,
): Promise<PortableGateBlock | null> {
  if (!(await project.hasPortableDirectory())) return null;
  if ((await project.unresolvedIntents()).length > 0) return "unresolved-intent";
  const projectId = await host.registeredProjectId();
  if (projectId === null) return null;
  const record = await host.readProjectRecord(projectId).catch(() => null);
  return record !== null && isSupportedRegistration(record) ? null : "unsupported-registration";
}

/** Typed refusal when an unresolved portable intent blocks an ordinary mutation. */
export class PortableRecoveryBlockingError extends Error {
  constructor(readonly block: PortableGateBlock) {
    super(block === "unresolved-intent"
      ? "portable-recovery-blocking: a portable publication is unresolved; run `llmwiki project status` or `llmwiki project resolve`"
      : "portable-recovery-blocking: this project's portable registration is not supported by this version");
    this.name = "PortableRecoveryBlockingError";
  }
}
