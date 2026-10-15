/**
 * @file src/trust/executor.ts
 * @description The guarded MUTATION DISPATCHER — turns an approved
 * {@link PlannedMutation} plan into bytes on disk, under the CLP atomicity
 * contract ("partial application of an approved batch is a bug").
 *
 * STATUS: ALL current public mutation surfaces — compile, import, refresh,
 * review-approve, `createRelation`, and `transitionLifecycle` — route through
 * THIS ONE executor seam ({@link applyApprovedMutationsLocked}). Each enters the
 * locked core (review-approve under its already-held review lock; relation and
 * lifecycle under their own bounded-blocking acquire) so there is a single
 * under-lock authority and audit path, not a bespoke per-surface helper.
 *
 * This is NOT a cross-store all-or-none / co-commit guarantee. "One seam" means a
 * single dispatch + authority + journal discipline, NOT that a page/relation
 * mutation and its audit-event append land atomically together across their two
 * stores (see the cross-store audit residual documented in `relation-apply.ts`
 * and `lifecycle-apply.ts`). Cross-store co-commit is a Phase-5 op-ID journal task.
 *
 * ATOMICITY SCOPE (honest boundary). The journal batch covers ONLY the page
 * byte-writes in the plan. It does NOT extend to a consumer's post-write tail —
 * e.g. `review approve`'s source-state persist, index/MOC/embeddings refresh, and
 * candidate deletion run under the same lock but OUTSIDE this batch, and are
 * best-effort + idempotent/re-derivable rather than journalled. "The approved
 * batch applies atomically" means the PAGE BYTES, not the whole approve
 * operation.
 *
 * {@link applyApprovedMutations} runs the batch behind the project lock and a
 * single-store intent journal:
 *  1. acquire the PID-based project lock (same discipline as compile/review);
 *  2. open a journal batch and record EVERY target's pre-state before any write;
 *  3. apply each `page` mutation via {@link writeLeafAtomicUnconfined}
 *     (`atomicWrite` with no confine root: temp-then-rename);
 *  4. commit the journal once all writes land;
 *  5. release the lock in `finally`.
 *
 * If any write throws mid-batch, the journal stays `pending` (uncommitted), so a
 * subsequent {@link replayJournal} reverts the whole batch to its pre-state — no
 * partial post-state ever survives. Every write target is confined under the
 * project root via {@link confineUnderRoot} before it is touched (in
 * {@link applyPageMutationLocked}).
 *
 * SHAPE GUARD + DISPATCH: a GLOBAL {@link replayJournalFrom} runs first (under the
 * held lock), then {@link assertBatchShape} rejects any batch that cannot be
 * applied atomically under today's single-store durability — a mixed-kind batch
 * or a multi-mutation single-store batch — with a typed
 * {@link CrossStoreBatchUnsupportedError}. A homogeneous page batch rides the
 * journalled page path and yields one {@link ApplyResult} per mutation; a lone
 * `relation` shape routes to {@link applyRelationLocked} (the under-lock
 * authority — re-load profile, re-plan, append) and yields its persisted ref;
 * a lone `lifecycle-transition` shape routes to {@link applyLifecycleLocked}
 * (the under-lock authority — re-load profile, compose a decision over the final
 * frontmatter, write via the shared page-apply primitive).
 *
 * S5 — FULL-FLOOR RE-ASSERTION AT APPLY: the executor is where bytes hit disk,
 * so it does not trust that plan-time checks still hold. The per-page primitive
 * {@link applyPageMutationLocked} re-runs the mandatory floor before every write;
 * a non-allow decision throws and writes NOTHING — a hand-built mutation that
 * bypassed the planner cannot smuggle an oversized or malformed body past.
 *
 * PRE-STATE ORDER, PRECISELY. Pre-states are recorded per target, sequentially:
 * each page's pre-state is durably recorded immediately BEFORE that page's own
 * write, not all of them before the first write (step 2 above compresses this).
 * A WRITE failure at page N leaves pages 1..N's pre-states pending. A refusal at
 * page N before its record (identity, confinement, create collision or floor)
 * leaves pages 1..N-1's — page N was never touched — and a failed persist
 * withdraws its own entry. Either way every target that could have changed has
 * its pre-state recorded, so replay restores the full pre-batch state.
 *
 * STORAGE AND DOMAIN. The held-lock core has ONE BODY,
 * {@link applyApprovedMutationsLockedFrom}, over {@link ApprovedMutationPorts}:
 * RAW journal I/O (replay, open, every pre-state record and the commit run over
 * that ONE object — the recorder handed to the page body records through it,
 * never through the legacy disk-bound {@link JournalBatch} fallback), RAW page
 * I/O, the page write, the replay diagnostics port, and the three non-page
 * handlers. The handlers are DOMAIN collaborators — root-bound under-lock
 * authorities that re-load the profile and do their own I/O — NOT storage, and
 * nothing here makes them portable. {@link applyApprovedMutationsLocked} keeps
 * its signature and passes the local disk ports, which call the incumbent
 * functions at call time. The self-locking {@link applyApprovedMutations} still
 * takes the ordinary recovery gate on the local disk and is NOT bound.
 */

import { releaseLock } from "../utils/lock.js";
import { note } from "../utils/output.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { writeLeafAtomicUnconfined } from "../storage/disk-guarded-leaves.js";
import { openBatchFrom, commitBatchFrom, recordPreStateFrom, replayJournalFrom, type JournalBatch } from "./journal.js";
import {
  diskJournalBatchIo, diskJournalReplayIo, type JournalBatchIo, type JournalNote, type JournalReplayIo,
} from "./journal-io.js";
import { type ApplyResult, CrossStoreBatchUnsupportedError } from "./apply-result.js";
import { applyPageMutationLockedFrom, diskPageApplyIo, type PageApplyIo, type PreStateRecorder, type WriteOne } from "./page-apply.js";
import { applyRelationLocked } from "./relation-apply.js";
import { applyLifecycleLocked } from "./lifecycle-apply.js";
import { applyArtifactLocked } from "../artifacts/apply.js";
import type { PlannedMutation, PagePlannedMutation } from "./planner.js";

export type { WriteOne } from "./page-apply.js";

/** One mutation kind of the plan union. */
type MutationOf<Kind extends PlannedMutation["kind"]> = Extract<PlannedMutation, { kind: Kind }>;
/** One result kind of the result union. */
type ResultOf<Kind extends ApplyResult["kind"]> = Extract<ApplyResult, { kind: Kind }>;

/**
 * The lone non-page shapes' UNDER-LOCK AUTHORITIES. Each is a DOMAIN
 * collaborator — it re-loads the profile, re-plans, composes the real decision
 * and does its own I/O — and is NOT storage, NOT portable and NOT bound here.
 */
export interface NonPageMutationHandlers {
  /** Local: `applyRelationLocked(root, mutation)`. */
  relation(root: string, mutation: MutationOf<"relation">): Promise<Omit<ResultOf<"relation">, "kind">>;
  /** Local: `applyLifecycleLocked(root, mutation)`, with no operation binding. */
  lifecycle(root: string, mutation: MutationOf<"lifecycle-transition">): Promise<ResultOf<"lifecycle-transition">["decision"]>;
  /** Local: `applyArtifactLocked(root, mutation)`, with no operation binding. */
  artifact(root: string, mutation: MutationOf<"artifact">): Promise<Omit<ResultOf<"artifact">, "kind">>;
}

/**
 * What the held-lock core is handed. `journal` and `page` are RAW I/O (each
 * member answers physically and decides nothing); `writeOne` is the raw page
 * write; `notes` is replay's diagnostics port; `handlers` are domain.
 */
export interface ApprovedMutationPorts {
  /** The batch lifecycle's members plus replay's, as ONE object, so replay, open, record and commit share it. */
  journal: JournalBatchIo & JournalReplayIo;
  /** The per-page body's raw I/O. */
  page: PageApplyIo;
  /** The per-target page write. */
  writeOne: WriteOne;
  /** Where replay's diagnostics go. */
  notes: JournalNote;
  /** The non-page under-lock authorities (domain, root-bound). */
  handlers: NonPageMutationHandlers;
}

/** LOCAL DISK. The journal's two incumbent I/O objects as one (their shared members are the same functions); frozen. In no package index. */
const diskExecutorJournalIo: JournalBatchIo & JournalReplayIo = Object.freeze({ ...diskJournalBatchIo, ...diskJournalReplayIo });

/** LOCAL. The incumbent under-lock authorities, called at call time with exactly the arguments the executor always passed; frozen. */
const localNonPageMutationHandlers: NonPageMutationHandlers = Object.freeze({
  relation: (root: string, mutation: MutationOf<"relation">) => applyRelationLocked(root, mutation),
  lifecycle: (root: string, mutation: MutationOf<"lifecycle-transition">) => applyLifecycleLocked(root, mutation),
  artifact: (root: string, mutation: MutationOf<"artifact">) => applyArtifactLocked(root, mutation),
});

/**
 * The local ports for one call. `writeOne` is a GETTER, so `opts.writeOne` is
 * observed exactly when — and as often as — the body reads it: once, after
 * replay, the shape guard and the page-batch choice, before the batch opens, and
 * never for an empty, refused or non-page plan. It yields the caller's writer, or
 * the incumbent `writeLeafAtomicUnconfined` itself, unwrapped, as before.
 */
function localApprovedMutationPorts(opts: ApplyOptions): ApprovedMutationPorts {
  return {
    journal: diskExecutorJournalIo,
    page: diskPageApplyIo,
    get writeOne(): WriteOne {
      return opts.writeOne ?? writeLeafAtomicUnconfined;
    },
    notes: (message) => note(message),
    handlers: localNonPageMutationHandlers,
  };
}

/** Options for {@link applyApprovedMutations}; `writeOne` defaults to {@link writeLeafAtomicUnconfined}. */
export interface ApplyOptions {
  /** Per-target write primitive (defaults to {@link writeLeafAtomicUnconfined}). */
  writeOne?: WriteOne;
}

/**
 * Error thrown when a mutation targets a store the executor does not handle.
 * Module-private: callers match on the typed `not-implemented:` message prefix
 * (the stable contract) rather than the class, so the class need not be exported.
 */
class NotImplementedMutationError extends Error {
  constructor(kind: string) {
    super(`not-implemented: executor does not handle mutation kind "${kind}"`);
    this.name = "NotImplementedMutationError";
  }
}

/**
 * Reject any batch that cannot be applied atomically under today's single-store
 * durability. An empty or all-`page` batch is fine (the journalled page path
 * batches pages atomically). A mixed-kind batch has no cross-store op-ID
 * atomicity (a Phase-5 task), and a multi-mutation single non-page store has no
 * per-store batch semantics yet — both throw a typed
 * {@link CrossStoreBatchUnsupportedError}. A lone relation/lifecycle shape
 * passes the guard and routes to its under-lock handler.
 *
 * BATCH-SHAPE GUARD = the safety net for deferred cross-store atomicity. Because
 * mixed-store and multi-non-page batches are REFUSED here, the executor never has
 * to span two stores in one batch — so the absence of a cross-store op-ID journal
 * cannot silently produce a torn cross-store batch. The only multi-mutation path
 * that survives the guard is the all-`page` batch, which IS journalled atomically
 * within its single store. This guard relaxes (admitting mixed/multi-store
 * batches) only when the Phase-5 op-ID journal lands to make them co-committable.
 */
function assertBatchShape(planned: PlannedMutation[]): void {
  if (planned.length === 0) return;
  const kinds = new Set(planned.map((m) => m.kind));
  if (planned.every((m) => m.kind === "page")) return;
  if (kinds.size > 1) {
    throw new CrossStoreBatchUnsupportedError(`mixed-kind batch: ${[...kinds].join("+")}`);
  }
  if (planned.length > 1) {
    throw new CrossStoreBatchUnsupportedError(`multi-${planned[0].kind} batch (no per-store batch semantics yet)`);
  }
}

/**
 * The pre-state recorder the page body is handed: it records into `batch`
 * through the SAME raw journal I/O that opened it, so a bound route never falls
 * back to the disk-bound {@link JournalBatch} recorder.
 */
function recorderFor(io: JournalBatchIo, batch: JournalBatch): PreStateRecorder {
  return { recordPreState: (absolutePath: string) => recordPreStateFrom(io, batch, absolutePath) };
}

/**
 * Apply every page mutation in the batch under an already-open journal, delegating
 * each, in plan order, to the shared per-page body {@link applyPageMutationLockedFrom}.
 * Throws on the first collision, floor violation, or failing write, leaving the
 * journal uncommitted for replay.
 */
async function applyBatch(
  ports: ApprovedMutationPorts,
  root: string,
  planned: PagePlannedMutation[],
  batch: JournalBatch,
  writeOne: WriteOne,
): Promise<void> {
  const recorder = recorderFor(ports.journal, batch);
  for (const mutation of planned) {
    await applyPageMutationLockedFrom(ports.page, root, mutation, recorder, writeOne);
  }
}

/**
 * Read the write ONCE, then open one batch, apply every page in order, and
 * commit once all writes landed; one `page` result per mutation. The read comes
 * first so a throwing `writeOne` getter opens no batch, exactly as before.
 */
async function applyPageBatch(ports: ApprovedMutationPorts, root: string, planned: PagePlannedMutation[]): Promise<ApplyResult[]> {
  const writeOne = ports.writeOne;
  const batch = await openBatchFrom(ports.journal, root);
  await applyBatch(ports, root, planned, batch, writeOne);
  await commitBatchFrom(ports.journal, batch);
  return planned.map(() => ({ kind: "page" as const }));
}

/**
 * Apply an approved plan to disk atomically WHILE THE CALLER ALREADY HOLDS the
 * project lock — the lock-free core shared with {@link applyApprovedMutations}.
 *
 * The caller MUST already hold the project lock; this function acquires NOTHING,
 * so it can run inside an outer locked region (e.g. `review approve`, which holds
 * the review lock across its whole mutation) WITHOUT a nested-acquire deadlock.
 *
 * Self-recovery: BEFORE the shape guard it runs a GLOBAL {@link replayJournalFrom}, so
 * a `pending` journal left dangling by a prior crash is reverted under the SAME
 * held lock before this batch begins. Then {@link assertBatchShape} rejects an
 * un-applicable batch shape; a homogeneous page batch is journalled and yields one
 * {@link ApplyResult} per mutation; a lone `relation` shape routes to
 * {@link applyRelationLocked} and yields its persisted ref; a lone
 * `lifecycle-transition` shape routes to {@link applyLifecycleLocked} and yields
 * a lifecycle ApplyResult; a lone `artifact` shape routes to
 * {@link applyArtifactLocked} and yields its persisted ref. A mid-batch page
 * failure leaves a `pending` journal for replay to revert to the full pre-state.
 *
 * @param root - Absolute project root.
 * @param planned - The approved mutations to apply.
 * @param opts - Optional injectable write primitive (for fault injection).
 * @returns One {@link ApplyResult} per applied mutation.
 */
export async function applyApprovedMutationsLocked(
  root: string,
  planned: PlannedMutation[],
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  return applyApprovedMutationsLockedFrom(localApprovedMutationPorts(opts), root, planned);
}

/**
 * THE ONE BODY of {@link applyApprovedMutationsLocked}, over the ports it is
 * handed. The caller MUST already hold the project lock; this acquires nothing.
 * Replay runs FIRST, before the shape guard, for EVERY plan — empty, refused,
 * page or non-page.
 *
 * @param ports - Raw journal and page I/O, the write, replay's notes port and the domain handlers.
 * @param root - Project root, handed to every port as data.
 * @param planned - The approved mutations to apply.
 * @returns One {@link ApplyResult} per applied mutation.
 */
export async function applyApprovedMutationsLockedFrom(
  ports: ApprovedMutationPorts,
  root: string,
  planned: PlannedMutation[],
): Promise<ApplyResult[]> {
  // GLOBAL replay-before-dispatch, under the held lock: recover any dangling
  // pending batch from a prior crash before any shape decision or new write.
  await replayJournalFrom(ports.journal, ports.notes, root);
  assertBatchShape(planned);
  if (planned.length === 0) return [];
  if (planned.every((m) => m.kind === "page")) {
    return applyPageBatch(ports, root, planned as PagePlannedMutation[]);
  }
  return dispatchLoneNonPage(ports.handlers, root, planned);
}

/** Route a guard-passed lone non-page mutation to its under-lock authority and forward what it composed. */
async function dispatchLoneNonPage(
  handlers: NonPageMutationHandlers,
  root: string,
  planned: PlannedMutation[],
): Promise<ApplyResult[]> {
  if (planned.length === 1 && planned[0].kind === "relation") {
    // The relation handler is the UNDER-LOCK authority: it re-loads the profile,
    // re-plans, re-composes the decision, and appends — the caller-supplied plan
    // is intent only. The persisted ref + composed decision flow back through the
    // apply RESULT, so a consumer records the REAL decision (not a literal).
    const { ref, decision } = await handlers.relation(root, planned[0]);
    return [{ kind: "relation", ref, decision }];
  }
  if (planned.length === 1 && planned[0].kind === "lifecycle-transition") {
    // The lifecycle handler is the UNDER-LOCK authority: it re-loads the profile,
    // composes a real decision over the FINAL frontmatter (FSM + entity fields),
    // and writes via the shared page-apply primitive — no dispatcher re-entry.
    // The composed decision flows back through the apply RESULT.
    const decision = await handlers.lifecycle(root, planned[0]);
    return [{ kind: "lifecycle-transition", decision }];
  }
  if (planned.length === 1 && planned[0].kind === "artifact") {
    // The artifact handler is the UNDER-LOCK authority: it re-loads the profile,
    // re-plans (composing the real decision over the type-declared + body-contract
    // checks), gates on the operator trusted-write grant, and writes the content-
    // addressed bytes + manifest via the journal. The composed decision flows back
    // through the apply RESULT.
    const { ref, decision } = await handlers.artifact(root, planned[0]);
    return [{ kind: "artifact", ref, decision }];
  }
  // workflow kinds stay not-implemented.
  throw new NotImplementedMutationError(planned[0].kind);
}

/**
 * Apply an approved plan to disk atomically, acquiring the project lock itself.
 * Acquires the PID-based project lock, delegates the journalled batch to
 * {@link applyApprovedMutationsLocked} (replay → guard → open → apply → commit),
 * then releases the lock in `finally`. There is ONE batch implementation; this is
 * the self-locking entry point for callers that do NOT already hold the lock.
 *
 * @param root - Absolute project root.
 * @param planned - The approved mutations to apply.
 * @param opts - Optional injectable write primitive (for fault injection).
 * @returns One {@link ApplyResult} per applied mutation.
 */
export async function applyApprovedMutations(
  root: string,
  planned: PlannedMutation[],
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  const acquired = await acquireMutationLock(root, "ordinary");
  if (!acquired) throw new Error("could not acquire project lock for mutation batch");
  try {
    return await applyApprovedMutationsLocked(root, planned, opts);
  } finally {
    await releaseLock(root);
  }
}
