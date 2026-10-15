/**
 * @file test/storage/lifecycle-recorded-reads.ts
 * @description The shared shape of the lifecycle binding witnesses (the pass-one
 * classifiers, the scan): one project planted with signed prune and quarantine
 * units at several protocol positions, and a recorder that captures every answer
 * the disk reads give, keyed by call, so a later leg can REPLAY them from memory
 * after the project is gone. The replay answers only what was recorded; anything
 * else fails the test. Nothing here decides anything.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { lifecyclePruneUnitPaths } from "../../src/preparations/lifecycle-fs/paths.js";
import type { PreparationLifecycleNamespaceV1 } from "../../src/preparations/lifecycle-fs/types.js";
import type { LifecycleLeafReads } from "../../src/preparations/lifecycle-snapshot/classifier-types.js";
import { lifecycleStagedDeleteName } from "../../src/preparations/paths.js";
import {
  lifecycleSnapshotFixture, plantPlannedQuarantine, plantRetainedQuarantine, writePruneReceipts,
} from "../preparations/lifecycle-snapshot-fixture.js";

/** Every recorded call, in order, and each call's answer. */
export interface Recorded { calls: string[]; answers: Map<string, unknown> }

/** A fresh, empty recording. */
export const newRecording = (): Recorded => ({ calls: [], answers: new Map() });

/** Record `answer` under `key`: the call first, then its settled value. */
export async function record<T>(into: Recorded, key: string, answer: Promise<T>): Promise<T> {
  into.calls.push(key);
  const value = await answer;
  into.answers.set(key, value);
  return value;
}

/** Answer `key` from `recorded`, logging the call; an unrecorded call fails the test. */
export async function replay<T>(recorded: Recorded, log: string[], key: string): Promise<T> {
  log.push(key);
  if (!recorded.answers.has(key)) throw new Error(`unrecorded lifecycle read ${key}`);
  return recorded.answers.get(key) as T;
}

/** Wrap leaf reads so every observation is recorded under `kind file`. */
export function recordingLeafReads(reads: LifecycleLeafReads, into: Recorded): LifecycleLeafReads {
  return {
    readLeaf: (file, expectedDir, maxBytes) => record(into, `leaf ${file}`, reads.readLeaf(file, expectedDir, maxBytes)),
    regularLeaf: (file, expectedDir) => record(into, `regular ${file}`, reads.regularLeaf(file, expectedDir)),
    observePlannedLeaf: (input) => record(into, `planned ${input.file}`, reads.observePlannedLeaf(input)),
  };
}

/** Memory leaf reads replaying `recorded`, logging every call. */
export function replayingLeafReads(recorded: Recorded, log: string[]): LifecycleLeafReads {
  return {
    readLeaf: (file) => replay(recorded, log, `leaf ${file}`),
    regularLeaf: (file) => replay(recorded, log, `regular ${file}`),
    observePlannedLeaf: (input) => replay(recorded, log, `planned ${input.file}`),
  };
}

/** Plant signed units at applying (prune), planned and completed-retained (quarantine) positions. */
export async function plantLifecycleUnits(root: string): Promise<PreparationLifecycleNamespaceV1> {
  const fixture = await lifecycleSnapshotFixture(root);
  await plantRetainedQuarantine(fixture, "qtn-retained");
  await plantPlannedQuarantine(fixture, "qtn-planned");
  const body = Buffer.from("delete-me");
  const object = { logicalPath: "workspaces/ws/delete-applying.bin", byteCount: body.length, digest: createHash("sha256").update(body).digest("hex") };
  await writePruneReceipts({ ...fixture, unitId: "prn-applying", operation: "prune", objects: [object] });
  await writeFile(`${lifecyclePruneUnitPaths(fixture.namespace, "prn-applying").unitRoot}/${lifecycleStagedDeleteName(0)}`, body);
  return fixture.namespace;
}
