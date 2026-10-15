/**
 * @file src/operation-bundles/adapters/projection.ts
 * @description The projection store adapter. It renders deterministically and
 * network-free from the immutable recipe identity, writes output plus its
 * format-neutral sidecar through the founding projection store, and never lets an
 * authoritative mutation depend on it (the executor runs projections last). The
 * required/optional criticality is manifest data and cannot be changed by the
 * renderer.
 *
 * ONE BODY. {@link defineProjectionAdapter} owns every verdict (the render
 * digest gate, the store's classification, the write and its failure classes,
 * verify) over {@link ProjectionAdapterStores}, none of which takes a project
 * root. The shipped {@link projectionAdapter} passes the local stores, which
 * read the context's root when called and call the founding projection store.
 * `AdapterContext.root` stays the compatibility handle a host adapter receives.
 */

import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import {
  observeProjection, writeProjectionLocked, type ProjectionObservation, type ProjectionTarget, type ProjectionWriteResult,
} from "../projection-store.js";
import {
  defineOperationStoreAdapter, type AdapterApply, type AdapterContext, type AdapterPreflight, type AdapterVerify,
  type OperationObservation, type OperationStoreAdapter,
} from "../adapter-types.js";
import type { ProjectionCriticality } from "../run-types.js";
import type { ProjectionOperationMutation } from "../types.js";
import { createOnlyWriteVerdict, digestBytes } from "./shared.js";

/**
 * The Milestone A deterministic, network-free render: a canonical descriptor of
 * the immutable recipe identity and output path. A host recipe engine that folds
 * committed authoritative reads is later scope; this render never reaches the
 * network and depends on no projection.
 */
function renderProjection(mutation: ProjectionOperationMutation): Buffer {
  return canonicalBytes({
    recipeId: mutation.target.recipeId,
    recipeDigest: mutation.target.recipeDigest,
    output: mutation.target.output,
  });
}

/** The manifest-declared criticality; the renderer cannot change it. */
export function projectionCriticality(mutation: ProjectionOperationMutation): ProjectionCriticality {
  return mutation.target.criticality;
}

/** Build the store target from the manifest mutation and its postcondition. */
function projectionTarget(ctx: AdapterContext<ProjectionOperationMutation>): ProjectionTarget {
  return {
    workspaceId: ctx.manifest.workspaceId, recipeId: ctx.mutation.target.recipeId,
    recipeDigest: ctx.mutation.target.recipeDigest, output: ctx.mutation.target.output,
    outputDigest: ctx.mutation.postcondition.digest, criticality: ctx.mutation.target.criticality,
  };
}

/** What the projection adapter asks of the project. No member takes a project root. */
export interface ProjectionAdapterStores {
  /** The founding store's classification of one projection target. */
  observe(target: ProjectionTarget): Promise<ProjectionObservation>;
  /** Write one projection's output and sidecar; the caller holds the project lock. */
  write(target: ProjectionTarget, bytes: Buffer): Promise<ProjectionWriteResult>;
}

/** LOCAL DISK. The founding projection store, reading the context's root when called. */
function diskProjectionAdapterStores(ctx: Pick<AdapterContext, "root">): ProjectionAdapterStores {
  return {
    observe: (target) => observeProjection(ctx.root, target),
    write: (target, bytes) => writeProjectionLocked(ctx.root, target, bytes),
  };
}

/** Observe projection state through the founding store's exact classification. */
async function observeProjectionState(stores: ProjectionAdapterStores, ctx: AdapterContext<ProjectionOperationMutation>): Promise<OperationObservation> {
  const observation = await stores.observe(projectionTarget(ctx));
  switch (observation.status) {
    case "absent": return { outcome: "not-applied" };
    // Projections are recipe-addressed with no per-mutation binding (unbound).
    case "same": return { outcome: "applied", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: false };
    case "replaceable": return { outcome: "not-applied" };
    case "conflict": return { outcome: "conflict", detail: observation.detail };
    default: return { outcome: "unavailable", detail: observation.detail };
  }
}

/** Preflight: the deterministic render must hash to the declared output digest. */
async function preflightProjection(ctx: AdapterContext<ProjectionOperationMutation>): Promise<AdapterPreflight> {
  if (digestBytes(renderProjection(ctx.mutation)) !== ctx.mutation.postcondition.digest) {
    return { status: "park", code: "bundle-precondition-conflict", detail: "projection render digest mismatch" };
  }
  return { status: "ready" };
}

/** Apply: render, re-check the digest, then write through the store; identical output is an unbound skip. */
async function applyProjection(stores: ProjectionAdapterStores, ctx: AdapterContext<ProjectionOperationMutation>): Promise<AdapterApply> {
  const bytes = renderProjection(ctx.mutation);
  if (digestBytes(bytes) !== ctx.mutation.postcondition.digest) {
    return { status: "conflict", detail: "projection render digest mismatch" };
  }
  return createOnlyWriteVerdict(() => stores.write(projectionTarget(ctx), bytes), () => ctx.mutation.postcondition.digest, "projection write failed");
}

/** Verify: the observation, restated as a verdict. */
async function verifyProjection(stores: ProjectionAdapterStores, ctx: AdapterContext<ProjectionOperationMutation>): Promise<AdapterVerify> {
  const observation = await observeProjectionState(stores, ctx);
  if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest };
  if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "projection unreadable" };
  return { status: "mismatch", detail: observation.detail ?? "projection postcondition not met" };
}

/** The projection adapter over the stores `storesOf` gives each context: THE ONE BODY of every verdict. */
export function defineProjectionAdapter(storesOf: (ctx: AdapterContext<ProjectionOperationMutation>) => ProjectionAdapterStores): OperationStoreAdapter {
  return defineOperationStoreAdapter<"projection">({
    kind: "projection",
    preflight: (ctx) => preflightProjection(ctx),
    observe: (ctx) => observeProjectionState(storesOf(ctx), ctx),
    apply: (ctx) => applyProjection(storesOf(ctx), ctx),
    verify: (ctx) => verifyProjection(storesOf(ctx), ctx),
  });
}

/** The shipped projection adapter: the body over the local stores for each context's root. */
export const projectionAdapter: OperationStoreAdapter = defineProjectionAdapter(diskProjectionAdapterStores);
