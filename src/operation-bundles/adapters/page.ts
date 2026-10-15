/**
 * @file src/operation-bundles/adapters/page.ts
 * @description The page store adapter. It never writes `wiki/` directly and never
 * creates a candidate: apply reads the immutable bundle payload, re-plans through
 * the current trust planner, requires a live-write decision whose operation
 * matches the manifest, and lands bytes through the existing
 * `applyApprovedMutationsLocked` page authority, then re-reads and digests the
 * page to prove the postcondition.
 *
 * ONE BODY. {@link definePageAdapter} owns every verdict (the payload digest
 * gate, the absent/present/pre/post observation, the planner's clearance and
 * operation match, the post-apply re-read, verify) over {@link PageAdapterStores},
 * none of which takes a project root. The shipped {@link pageAdapter} passes the
 * local stores for the context's root, read at each call as before, which call
 * the incumbent payload reader, page digest, trust planner and page authority.
 * `AdapterContext.root` stays the compatibility handle a host adapter receives.
 */

import { applyApprovedMutationsLocked } from "../../trust/executor.js";
import type { TrustDecision } from "../../trust/decision.js";
import { planPageMutation, type PageMutationTarget, type PlanPageInput, type PlanResult } from "../../trust/planner.js";
import { defineOperationStoreAdapter, type OperationStoreAdapter } from "../adapter-types.js";
import type { AdapterApply, AdapterContext, AdapterPreflight, AdapterVerify, OperationObservation } from "../adapter-types.js";
import type { BundleId } from "../ids.js";
import type { PageOperationMutation } from "../types.js";
import { digestBytes, readBundlePayload, readPageDigest, type LeafDigest, type PayloadRead } from "./shared.js";

/** Decisions that clear a page mutation to land bytes. */
const PAGE_LIVE_WRITE_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

/**
 * True for the operations that act on an EXISTING page — update and delete —
 * which must be cleared past the "page already exists" block. The precondition
 * digest (checked at observe and by the manifest) is the real guard against a
 * stale or blind write; without delete here, an authored delete of any real
 * page was blocked before its precondition was ever consulted.
 */
function actsOnExistingPage(operation: "create" | "update" | "delete"): boolean {
  return operation === "update" || operation === "delete";
}

/** Build the planner's discriminated target from the manifest mutation target. */
function planTarget(mutation: PageOperationMutation): PageMutationTarget {
  return mutation.target.kind === "entity"
    ? { kind: "entity", entityType: mutation.target.entityType, slug: mutation.target.slug }
    : { kind: "raw", directory: mutation.target.directory, slug: mutation.target.slug };
}

/** What the page adapter asks of the project. No member takes a project root. */
export interface PageAdapterStores {
  /** One retained bundle payload. */
  readPayload(workspaceId: string, bundleId: BundleId, payloadRef: string): Promise<PayloadRead>;
  /** The mutation's page, as a digest of its current confined bytes. */
  readPageDigest(mutation: PageOperationMutation): Promise<LeafDigest>;
  /** The current trust planner's verdict on the page write. */
  planPage(input: Omit<PlanPageInput, "root">): Promise<PlanResult>;
  /** Land the planned mutations through the page authority; the caller holds the project lock. */
  applyPlanned(planned: PlanResult["planned"]): Promise<unknown>;
}

/** LOCAL DISK. The incumbent readers, planner and page authority, each reading the context's root when called. */
function diskPageAdapterStores(ctx: Pick<AdapterContext, "root">): PageAdapterStores {
  return {
    readPayload: (workspaceId, bundleId, payloadRef) => readBundlePayload(ctx.root, workspaceId, bundleId, payloadRef),
    readPageDigest: (mutation) => readPageDigest(ctx.root, mutation),
    planPage: (input) => planPageMutation({ root: ctx.root, ...input }),
    applyPlanned: (planned) => applyApprovedMutationsLocked(ctx.root, planned),
  };
}

/** Read the immutable payload bound to this page mutation. */
function readPayload(stores: PageAdapterStores, ctx: AdapterContext<PageOperationMutation>): Promise<PayloadRead> {
  return stores.readPayload(ctx.manifest.workspaceId, ctx.manifest.bundleId, ctx.mutation.payloadRef);
}

/**
 * A delete declares absence as its postcondition, so "satisfied" means the page
 * is GONE. Every digest comparison below is guarded by this: comparing against
 * a postcondition that declares no digest is meaningless, and treating absence
 * as a mismatch would make every successful delete look failed.
 */
function expectsAbsence(mutation: PageOperationMutation): boolean {
  return "kind" in mutation.postcondition && mutation.postcondition.kind === "absent";
}

/** The digest a non-delete mutation must reach; absent for a delete. */
function expectedDigest(mutation: PageOperationMutation): string | undefined {
  return "digest" in mutation.postcondition ? mutation.postcondition.digest : undefined;
}

/** Preflight: the payload is present and, unless the mutation deletes, matches the declared postcondition. */
async function preflightPage(stores: PageAdapterStores, ctx: AdapterContext<PageOperationMutation>): Promise<AdapterPreflight> {
  const payload = await readPayload(stores, ctx);
  if (payload.kind === "unavailable") return { status: "unavailable", detail: "page payload is unreadable" };
  if (payload.kind === "absent") return { status: "unavailable", detail: "page payload is missing" };
  // A delete's payload is inert — nothing is written from it — so it is not
  // held to a postcondition digest the mutation does not declare.
  if (!expectsAbsence(ctx.mutation) && digestBytes(payload.bytes) !== expectedDigest(ctx.mutation)) {
    return { status: "park", code: "bundle-precondition-conflict", detail: "page payload digest mismatch" };
  }
  return { status: "ready" };
}

/** Observe: absent, at the precondition, at the postcondition, or neither (a conflict). */
async function observePage(stores: PageAdapterStores, ctx: AdapterContext<PageOperationMutation>): Promise<OperationObservation> {
  const current = await stores.readPageDigest(ctx.mutation);
  if (current.kind === "unavailable") return { outcome: "unavailable", detail: "page is unreadable" };
  if (current.kind === "absent") {
    // For a delete an absent page is the goal state ALREADY REACHED — not a
    // conflict, and not work still outstanding. It is unbound because nothing
    // proves THIS run removed it.
    if (expectsAbsence(ctx.mutation)) {
      return { outcome: "applied", boundToMutation: false };
    }
    return ctx.mutation.precondition.kind === "absent"
      ? { outcome: "not-applied" }
      : { outcome: "conflict", detail: "expected existing page is absent" };
  }
  // Present. For a delete the work is outstanding, and whether it may proceed
  // is the PRECONDITION's business, checked below.
  if (!expectsAbsence(ctx.mutation) && current.digest === expectedDigest(ctx.mutation)) {
    // A page write carries no per-mutation binding, so a content match cannot
    // prove this run produced it (unbound).
    return { outcome: "applied", postStateDigest: current.digest, boundToMutation: false };
  }
  if (ctx.mutation.precondition.kind === "digest" && current.digest === ctx.mutation.precondition.digest) {
    return { outcome: "not-applied" };
  }
  return { outcome: "conflict", detail: "page digest matches neither precondition nor postcondition" };
}

/** Apply: re-plan through the current planner, land through the page authority, then re-read the postcondition. */
async function applyPage(stores: PageAdapterStores, ctx: AdapterContext<PageOperationMutation>): Promise<AdapterApply> {
  const payload = await readPayload(stores, ctx);
  if (payload.kind !== "ok") return { status: "unavailable", detail: "page payload is unreadable" };
  const plan = await stores.planPage({
    target: planTarget(ctx.mutation), body: payload.bytes.toString("utf8"),
    origin: "operation", reviewRouted: false, allowOverwrite: actsOnExistingPage(ctx.mutation.operation),
    deleting: ctx.mutation.operation === "delete",
  });
  if (!PAGE_LIVE_WRITE_DECISIONS.has(plan.decision) || plan.planned.length === 0) {
    return { status: "conflict", detail: `page not cleared for live write (${plan.decision})` };
  }
  if (plan.planned[0]!.operation !== ctx.mutation.operation) {
    return { status: "conflict", detail: "planned operation does not match the manifest" };
  }
  await stores.applyPlanned(plan.planned);
  const after = await stores.readPageDigest(ctx.mutation);
  if (expectsAbsence(ctx.mutation)) {
    return after.kind === "absent"
      ? { status: "applied-absent" }
      : { status: "conflict", detail: "page still present after delete" };
  }
  if (after.kind !== "ok") return { status: "unavailable", detail: "page could not be re-read after apply" };
  if (after.digest !== expectedDigest(ctx.mutation)) {
    return { status: "conflict", detail: "post-apply page digest mismatch" };
  }
  return { status: "applied", postStateDigest: after.digest };
}

/** Verify: the page is at its postcondition (or gone, for a delete). */
async function verifyPage(stores: PageAdapterStores, ctx: AdapterContext<PageOperationMutation>): Promise<AdapterVerify> {
  const after = await stores.readPageDigest(ctx.mutation);
  if (after.kind === "unavailable") return { status: "unavailable", detail: "page is unreadable" };
  if (expectsAbsence(ctx.mutation)) {
    return after.kind === "absent"
      ? { status: "verified-absent" }
      : { status: "mismatch", detail: "page still present after delete" };
  }
  if (after.kind === "absent" || after.digest !== expectedDigest(ctx.mutation)) {
    return { status: "mismatch", detail: "page postcondition digest not met" };
  }
  return { status: "verified", postStateDigest: after.digest };
}

/** The page adapter over the stores `storesOf` gives each context: THE ONE BODY of every verdict. */
export function definePageAdapter(storesOf: (ctx: AdapterContext<PageOperationMutation>) => PageAdapterStores): OperationStoreAdapter {
  return defineOperationStoreAdapter<"page">({
    kind: "page",
    preflight: (ctx) => preflightPage(storesOf(ctx), ctx),
    observe: (ctx) => observePage(storesOf(ctx), ctx),
    apply: (ctx) => applyPage(storesOf(ctx), ctx),
    verify: (ctx) => verifyPage(storesOf(ctx), ctx),
  });
}

/** The shipped page adapter: the body over the local stores for each context's root. */
export const pageAdapter: OperationStoreAdapter = definePageAdapter(diskPageAdapterStores);
