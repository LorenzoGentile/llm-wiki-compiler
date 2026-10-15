/**
 * @file test/storage/operation-run-memory.ts
 * @description The memory run domain the operation-bundle binding suites
 * (`operation-apply-binding`, `operation-settlement-binding`) run the bodies
 * over.
 *
 * - {@link copiedProject}: a real signed bundle staged on disk with the existing
 *   fixtures, and its manifest, key and run as read there.
 * - {@link memoryRunStores}: `OperationRunStores` over that copy. They append
 *   through the run writer's OWN body (`appendOperationTransitionWith` over memory
 *   run steps) and write evidence through the evidence body, and log every call.
 *   A {@link MemoryRunWorld} replaces any read a case names.
 * - {@link runtimeOf}: a deterministic runtime (fixed clock, the fixture
 *   authority, disk-free source and page doubles), with any adapter or the
 *   authority replaced where a case says so.
 *
 * Each suite keeps its own scenarios, expectations and root-form spies.
 */

import { createOperationAdapterRegistry, type OperationRuntime } from "../../src/operation-bundles/adapter-registry.js";
import { defineOperationStoreAdapter, type OperationStoreAdapter } from "../../src/operation-bundles/adapter-types.js";
import { artifactAdapter } from "../../src/operation-bundles/adapters/artifact.js";
import { catalogAdapter } from "../../src/operation-bundles/adapters/catalog.js";
import { lifecycleAdapter } from "../../src/operation-bundles/adapters/lifecycle.js";
import { relationAdapter } from "../../src/operation-bundles/adapters/relation.js";
import type { OperationAuthorityProvider } from "../../src/operation-bundles/authority.js";
import type { CancelRequestRead } from "../../src/operation-bundles/cancel-request.js";
import { writeRunEvidenceWith, type RunEvidenceBlobs } from "../../src/operation-bundles/evidence-store.js";
import { readOperationKey, type OperationKeyRead } from "../../src/operation-bundles/key-epoch.js";
import { readOperationManifest, type OperationManifestRead } from "../../src/operation-bundles/manifest-store.js";
import { parseOperationRun } from "../../src/operation-bundles/run-parse.js";
import type { OperationRunStores } from "../../src/operation-bundles/run-session.js";
import { appendOperationTransitionWith, type OperationRunRead, type OperationRunWriteSteps } from "../../src/operation-bundles/run-store.js";
import type { OperationRun } from "../../src/operation-bundles/run-types.js";
import type { PendingMarkerRead } from "../../src/utils/pending-embeddings.js";
import {
  compensatingSourceAdapter, failingProjectionAdapter, fixtureAuthority, readStagedRun, WORKSPACE, type StagedBundle,
} from "../operation-bundles/executor-fixtures.js";
import type { TempRootTrackerV1 } from "../temp-roots.js";

/** The one instant every deterministic runtime reports. */
const NOW = new Date("2026-07-19T00:00:01.000Z");

/** A page adapter double that logs its apply and never touches disk. */
function memoryPageAdapter(log: string[]): OperationStoreAdapter {
  return defineOperationStoreAdapter<"page">({
    kind: "page",
    async preflight() { return { status: "ready" }; },
    async observe() { return { outcome: "not-applied" }; },
    async apply(ctx) { log.push("page applied"); return { status: "applied", postStateDigest: (ctx.mutation.postcondition as { digest: string }).digest as never }; },
    async verify(ctx) { return { status: "verified", postStateDigest: (ctx.mutation.postcondition as { digest: string }).digest as never }; },
  });
}

/** A deterministic runtime: fixed clock, fixture authority, disk-free source and page doubles; any of them replaced as given. */
export function runtimeOf(
  log: string[], over: { source?: OperationStoreAdapter; projection?: OperationStoreAdapter; authority?: OperationAuthorityProvider } = {},
): OperationRuntime {
  const adapters = createOperationAdapterRegistry({
    "source-retain": over.source ?? compensatingSourceAdapter(), page: memoryPageAdapter(log), relation: relationAdapter,
    "lifecycle-transition": lifecycleAdapter, artifact: artifactAdapter, "catalog-record": catalogAdapter,
    projection: over.projection ?? failingProjectionAdapter(),
  });
  return { authority: over.authority ?? fixtureAuthority(), adapters, clock: { now: () => NOW } };
}

/** What the memory stores answer instead of the copied project, where a case says so. */
export interface MemoryRunWorld {
  manifest?: OperationManifestRead; key?: OperationKeyRead; run?: OperationRunRead;
  cancels?: CancelRequestRead[]; marker?: PendingMarkerRead;
}

/** A staged project and its manifest, key and run as read there. */
export type CopiedProject = Awaited<ReturnType<typeof copiedProject>>;

/** Stage with `stage` in a fresh tracked root, then read its manifest, key and run. */
export async function copiedProject(tracker: TempRootTrackerV1, stage: (root: string) => Promise<StagedBundle>) {
  const root = await tracker.create("operation-run-memory-", { real: true });
  const staged = await stage(root);
  const manifest = await readOperationManifest(root, WORKSPACE, staged.bundleId);
  const key = await readOperationKey(root);
  return { root, staged, manifest, key, run: await readStagedRun(root, staged) };
}

/** Memory stores over a copied project, appending and writing evidence through the bodies; each call logged. */
export function memoryRunStores(seed: CopiedProject, log: string[], world: MemoryRunWorld = {}): OperationRunStores & { current(): OperationRun } {
  let current = seed.run;
  const cancels = [...(world.cancels ?? [])];
  const runSteps: OperationRunWriteSteps = {
    readRun: async () => ({ status: "ok", run: current }), readKey: async () => seed.key,
    readEvidenceLeaf: async () => ({ kind: "absent" }) as never, publishGenesis: async () => { throw new Error("no genesis here"); },
    replaceRun: async (binding, serialized) => { current = parseOperationRun(serialized, binding); },
  };
  const blobs: RunEvidenceBlobs = { target: () => ({ writeBlob: async () => {} }) };
  return {
    capabilityRoot: "/memory/capability", current: () => current,
    readManifest: async () => { log.push("manifest"); return world.manifest ?? seed.manifest; },
    readKey: async () => { log.push("key"); return world.key ?? seed.key; },
    readRun: async () => { log.push("run"); return world.run ?? { status: "ok", run: current }; },
    appendTransition: async (binding, expected, input) => { log.push(input.type); return appendOperationTransitionWith(runSteps, binding, expected, input); },
    writeEvidence: async (location, bytes) => { log.push(`evidence ${location.type}`); return writeRunEvidenceWith(blobs, location, bytes); },
    readCancel: async () => { log.push("cancel?"); return cancels.shift() ?? { status: "absent" }; },
    removeCancel: async () => { log.push("cancel removed"); },
    readPendingMarker: async () => { log.push("marker?"); return world.marker ?? { status: "absent", entries: [] }; },
    writePendingMarker: async (entries) => { log.push(`marker ${entries.map(({ pageId }) => pageId).join(",")}`); },
  };
}
