/**
 * @file src/relations/operation-write.ts
 * @description The operation-aware relation append seam. It reuses the ordinary
 * canonicalization, profile validation, and store-full-guarded append, but
 * stamps the out-of-band {@link OperationBinding} onto the authority record and
 * emits the operation child audit event carrying the same binding. Content
 * identity stays distinct from operation identity: an exact pre-existing relation
 * is a valid post-state and is never duplicated solely to attach a mutation id.
 *
 * ONE BODY: {@link appendRelationForOperationLocked} runs
 * {@link appendRelationForOperationLockedFrom} over local-disk
 * {@link RelationOperationSources} — this store's graph (read and append), its
 * DURABLE whole-store replacement for the header upgrade, and the audit store's
 * bound-append sources (which carry their own durable replacement). The lookup,
 * the dedup, the promised-id refusal, the order upgrade-then-precondition-then-
 * record-then-event, and every conflict detail stay here; the sources only
 * answer. No lock is taken: the caller holds it.
 */

import { operationBindingEquals, type OperationBinding } from "../utils/operation-binding.js";
import { appendOperationEventLockedFrom } from "../events/operation-events.js";
import { diskEventBoundWriteSources, type EventBoundWriteSources } from "../events/store.js";
import { prepareEventStoreForAppendFrom } from "../events/store-read.js";
import type { EventRecord } from "../events/types.js";
import type { ProfilePack } from "../profile/types.js";
import {
  appendRelationLineFrom, buildRelationRef, diskRelationGraphStore, type AppendRelationInput, type RelationGraphStore,
} from "./store.js";
import { readRelationRecordsFrom, type BoundRelationRecord } from "./store-read.js";
import { diskRelationUpgradeSources, ensureRelationOperationVersionLockedFrom, type RelationUpgradeSources } from "./store-version.js";
import type { RelationRef } from "./types.js";

/**
 * Everything {@link appendRelationForOperationLockedFrom} reads and writes: this
 * store's graph and its durable replacement (the upgrade's), and the audit
 * store's bound-append sources. Owned by the relation store; not `ProjectStore`,
 * not hosted, and it selects no backend.
 */
export interface RelationOperationSources extends RelationUpgradeSources {
  /** The relation store's read and append. */
  graph: RelationGraphStore;
  /** The audit store's read, repair, append, seal and durable replacement. */
  events: EventBoundWriteSources;
}

/**
 * LOCAL DISK. The sources for the project at `root`: this store's graph
 * (`./store.ts`), its durable replacement (`./store-version.ts`, through
 * `../utils/atomic-write.js`) and the event store's bound-append sources.
 * Building them does no I/O. In no package index.
 */
function diskRelationOperationSources(root: string): RelationOperationSources {
  return {
    graph: diskRelationGraphStore(root),
    replaceStoreDurable: diskRelationUpgradeSources(root).replaceStoreDurable,
    events: diskEventBoundWriteSources(root),
  };
}

/**
 * The outcome of applying one relation mutation through the operation seam. A
 * `skipped-idempotent` result reports `bound`: true when the present relation was
 * produced by THIS mutation (an exact same-mutation record), false when it is a
 * pre-existing relation deduped by content (this run did not create it).
 */
export type RelationOperationApply =
  | { status: "created"; ref: RelationRef; event: EventRecord }
  | { status: "skipped-idempotent"; ref: RelationRef; bound: boolean }
  | { status: "conflict"; detail: string };

type MutationLookup =
  | { status: "none" }
  | { status: "same-mutation"; ref: RelationRef }
  | { status: "conflict"; detail: string };

/** Classify the store's records against the target mutation identity. */
function lookupByMutation(
  records: readonly BoundRelationRecord[],
  binding: OperationBinding,
  contentHash: string,
): MutationLookup {
  const matches = records.filter((record) => record.operationBinding?.mutationId === binding.mutationId);
  if (matches.length > 1) return { status: "conflict", detail: "duplicate relation record for mutation" };
  if (matches.length === 0) return { status: "none" };
  const existing = matches[0]!;
  const exact = existing.operationBinding !== undefined
    && operationBindingEquals(existing.operationBinding, binding)
    && existing.ref.contentHash === contentHash;
  return exact
    ? { status: "same-mutation", ref: existing.ref }
    : { status: "conflict", detail: "relation mutation content mismatch" };
}

/** The latest live relation matching this content, if any (dedup by content). */
function liveContentMatch(records: readonly BoundRelationRecord[], contentHash: string): RelationRef | undefined {
  const byId = new Map<string, BoundRelationRecord>();
  for (const record of records) byId.set(record.ref.id, record);
  for (const record of byId.values()) {
    if (record.ref.contentHash === contentHash) return record.ref;
  }
  return undefined;
}

/** Append the relation-create child audit event carrying the operation binding. */
async function emitRelationOperationEvent(
  events: EventBoundWriteSources,
  ref: RelationRef,
  binding: OperationBinding,
): Promise<EventRecord> {
  const result = await appendOperationEventLockedFrom(events, {
    type: "relation-create", origin: "sdk",
    payload: { id: ref.id, relType: ref.type, from: ref.from, to: ref.to },
    at: new Date().toISOString(),
  }, binding);
  if (result.status === "conflict") throw new Error(`operation relation event conflict: ${result.detail}`);
  return result.event;
}

/**
 * Apply one relation mutation under the caller's lock, stamping the binding on a
 * newly created record and recording the child audit event. A record already
 * carrying this mutation id (exact) is idempotent; a divergent one parks; an
 * exact pre-existing relation is applied without a duplicate record.
 *
 * `promisedId` is the manifest's attested `postcondition.recordId`: when the
 * mutation creates a NEW record, the store writes exactly that id, so the
 * manifest's promise is a fact rather than an unverified attestation. Absent
 * (every non-operation caller), the store mints as it always has.
 */
export async function appendRelationForOperationLocked(
  root: string,
  profile: ProfilePack,
  input: AppendRelationInput,
  binding: OperationBinding,
  promisedId?: RelationRef["id"],
): Promise<RelationOperationApply> {
  return appendRelationForOperationLockedFrom(diskRelationOperationSources(root), profile, input, binding, promisedId);
}

/**
 * {@link appendRelationForOperationLocked} over {@link RelationOperationSources}:
 * THE ONE BODY, in the incumbent order. Only the create path upgrades this
 * store's header, and it does so BEFORE the audit store's precondition.
 */
export async function appendRelationForOperationLockedFrom(
  sources: RelationOperationSources,
  profile: ProfilePack,
  input: AppendRelationInput,
  binding: OperationBinding,
  promisedId?: RelationRef["id"],
): Promise<RelationOperationApply> {
  const ref = buildRelationRef(profile, input, promisedId); // canonical + profile-validated content
  const { records, problems } = await readRelationRecordsFrom(sources.graph);
  if (problems.length > 0) return { status: "conflict", detail: "relation store has an uncommitted tail" };
  const lookup = lookupByMutation(records, binding, ref.contentHash);
  if (lookup.status === "conflict") return lookup;
  if (lookup.status === "same-mutation") {
    // The authority record for this mutation is already present; forward-repair a
    // missing child audit event (a crash between the record and its event). The
    // emit is idempotent — it appends nothing when the bound event already exists.
    // The record is bound to this mutation, so a crash recovery records applied.
    await emitRelationOperationEvent(sources.events, lookup.ref, binding);
    return { status: "skipped-idempotent", ref: lookup.ref, bound: true };
  }
  const live = liveContentMatch(records, ref.contentHash);
  if (live !== undefined) {
    // A pre-existing relation deduped by content: this run did not produce it, so
    // the skip is unbound (it must never enter the compensation applied-set).
    await emitRelationOperationEvent(sources.events, live, binding);
    return { status: "skipped-idempotent", ref: live, bound: false };
  }
  if (promisedId !== undefined && records.some((record) => record.ref.id === promisedId)) {
    // The promised id is already LIVE with different content (same content
    // dedupes above). Appending under it would silently supersede the live
    // relation — the reader keeps the newest record per id — so an id collision
    // is a conflict, never an append.
    return { status: "conflict", detail: "promised relation id is already live with different content" };
  }
  await ensureRelationOperationVersionLockedFrom(sources);
  await prepareEventStoreForAppendFrom(sources.events); // fail closed on a tampered/symlinked audit store
  await appendRelationLineFrom(sources.graph, ref, binding);
  return { status: "created", ref, event: await emitRelationOperationEvent(sources.events, ref, binding) };
}
