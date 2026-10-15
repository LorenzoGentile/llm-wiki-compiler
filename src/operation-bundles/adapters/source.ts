/**
 * @file src/operation-bundles/adapters/source.ts
 * @description The retained-source store adapter — a thin call over the founding
 * content-addressed source store. The target is derived from a content-address
 * digest and can never name a path; apply reads the immutable bundle payload and
 * publishes it create-only; unavailable never falls through to a create.
 *
 * ONE BODY. {@link defineSourceAdapter} owns every verdict (the content-address
 * gate, the payload digest, the present/absent/unreadable observation, the
 * create-or-same publication and its failure classes, verify) over
 * {@link SourceAdapterStores}, none of which takes a project root. The shipped
 * {@link sourceAdapter} passes the local stores, which read the context's root
 * when called and call the incumbent payload reader, durable leaf reader and
 * create-only writer. `AdapterContext.root` stays the compatibility handle a host
 * adapter receives.
 */

import { MAX_RETAINED_SOURCE_BYTES } from "../constants.js";
import type { CreateOnlyBlobResult } from "../blob-store.js";
import { readDurableOperationLeafBuffer } from "../durable-leaf.js";
import type { BundleId } from "../ids.js";
import { operationPaths } from "../paths.js";
import { writeRetainedSourceCreateOnly, type RetainedSourceLocation } from "../source-store.js";
import {
  defineOperationStoreAdapter, type AdapterApply, type AdapterContext, type AdapterPreflight, type AdapterVerify,
  type OperationObservation, type OperationStoreAdapter,
} from "../adapter-types.js";
import type { SourceRetainMutation } from "../types.js";
import type { CappedLeafReadBuffer } from "../../utils/confined-read.js";
import { createOnlyWriteVerdict, digestBytes, readBundlePayload, type PayloadRead } from "./shared.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** What the source adapter asks of the project. No member takes a project root. */
export interface SourceAdapterStores {
  /** One retained bundle payload. */
  readPayload(workspaceId: string, bundleId: BundleId, payloadRef: string): Promise<PayloadRead>;
  /** The workspace's retained sources; deriving them THROWS for an invalid workspace, before any read. */
  retainedSources(workspaceId: string): { read(digest: string): Promise<CappedLeafReadBuffer> };
  /** Publish one retained source create-only: `same` when identical bytes are already there. */
  writeRetained(location: RetainedSourceLocation, bytes: Buffer): Promise<CreateOnlyBlobResult>;
}

/** LOCAL DISK. The incumbent payload reader, durable leaf reader and create-only writer, each reading the context's root when called. */
function diskSourceAdapterStores(ctx: Pick<AdapterContext, "root">): SourceAdapterStores {
  return {
    readPayload: (workspaceId, bundleId, payloadRef) => readBundlePayload(ctx.root, workspaceId, bundleId, payloadRef),
    retainedSources: (workspaceId) => {
      const paths = operationPaths(ctx.root, workspaceId);
      return { read: (digest) => readDurableOperationLeafBuffer(ctx.root, paths.sourceFile(digest), paths.sourcesRoot, MAX_RETAINED_SOURCE_BYTES) };
    },
    writeRetained: (location, bytes) => writeRetainedSourceCreateOnly(ctx.root, location, bytes),
  };
}

/** Read the immutable payload bound to this source mutation. */
function readPayload(stores: SourceAdapterStores, ctx: AdapterContext<SourceRetainMutation>): Promise<PayloadRead> {
  return stores.readPayload(ctx.manifest.workspaceId, ctx.manifest.bundleId, ctx.mutation.payloadRef);
}

/** Observe the retained source: absent, present at its digest (unbound), mismatched, or unreadable. */
async function observeSource(stores: SourceAdapterStores, ctx: AdapterContext<SourceRetainMutation>): Promise<OperationObservation> {
  const digest = ctx.mutation.target.digest;
  if (!SHA256_HEX.test(digest)) return { outcome: "conflict", detail: "retained source target is not a content-address digest" };
  const sources = stores.retainedSources(ctx.manifest.workspaceId);
  let read: CappedLeafReadBuffer;
  try { read = await sources.read(digest); }
  catch { return { outcome: "unavailable", detail: "retained source path is invalid" }; }
  if (read.kind === "absent") return { outcome: "not-applied" };
  if (read.kind !== "ok") return { outcome: "unavailable", detail: "retained source is unreadable" };
  const actual = digestBytes(read.body);
  // Retained sources are content-addressed with no per-mutation binding, so
  // presence cannot prove this run produced it (unbound).
  return actual === ctx.mutation.postcondition.digest
    ? { outcome: "applied", postStateDigest: actual, boundToMutation: false }
    : { outcome: "conflict", detail: "retained source digest mismatch" };
}

/** Preflight: a content-address target and a payload at the declared digest. */
async function preflightSource(stores: SourceAdapterStores, ctx: AdapterContext<SourceRetainMutation>): Promise<AdapterPreflight> {
  if (!SHA256_HEX.test(ctx.mutation.target.digest)) {
    return { status: "park", code: "bundle-precondition-conflict", detail: "retained source target is not a content-address digest" };
  }
  const payload = await readPayload(stores, ctx);
  if (payload.kind !== "ok") return { status: "unavailable", detail: "retained source payload is unreadable" };
  if (digestBytes(payload.bytes) !== ctx.mutation.postcondition.digest) {
    return { status: "park", code: "bundle-precondition-conflict", detail: "retained source payload digest mismatch" };
  }
  return { status: "ready" };
}

/** Apply: publish the payload create-only; identical bytes already there are an unbound idempotent skip. */
async function applySource(stores: SourceAdapterStores, ctx: AdapterContext<SourceRetainMutation>): Promise<AdapterApply> {
  const payload = await readPayload(stores, ctx);
  if (payload.kind !== "ok") return { status: "unavailable", detail: "retained source payload is unreadable" };
  return createOnlyWriteVerdict(
    () => stores.writeRetained({ workspaceId: ctx.manifest.workspaceId, digest: ctx.mutation.target.digest }, payload.bytes),
    () => ctx.mutation.postcondition.digest, "retained source write failed");
}

/** Verify: the observation, restated as a verdict. */
async function verifySource(stores: SourceAdapterStores, ctx: AdapterContext<SourceRetainMutation>): Promise<AdapterVerify> {
  const observation = await observeSource(stores, ctx);
  if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest };
  if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "retained source unreadable" };
  return { status: "mismatch", detail: observation.detail ?? "retained source postcondition not met" };
}

/** The source adapter over the stores `storesOf` gives each context: THE ONE BODY of every verdict. */
export function defineSourceAdapter(storesOf: (ctx: AdapterContext<SourceRetainMutation>) => SourceAdapterStores): OperationStoreAdapter {
  return defineOperationStoreAdapter<"source-retain">({
    kind: "source-retain",
    preflight: (ctx) => preflightSource(storesOf(ctx), ctx),
    observe: (ctx) => observeSource(storesOf(ctx), ctx),
    apply: (ctx) => applySource(storesOf(ctx), ctx),
    verify: (ctx) => verifySource(storesOf(ctx), ctx),
  });
}

/** The shipped source adapter: the body over the local stores for each context's root. */
export const sourceAdapter: OperationStoreAdapter = defineSourceAdapter(diskSourceAdapterStores);
