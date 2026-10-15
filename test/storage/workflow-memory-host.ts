/**
 * @file test/storage/workflow-memory-host.ts
 * @description One compact in-memory `LocalWorkflowHost` for the workflow
 * engine witnesses. Nothing here touches a directory.
 *
 * WHAT RUNS FOR REAL. The run store's own write and read bodies
 * (`writeRunWith`, `writeRunCandidatesWith`, `readRunFrom`, `listRunsFrom`,
 * `resolveRunIdFrom`) over ONE Map of run texts keyed by run id, signed and
 * verified with ONE fixed key; the profile loader (`loadProfileFrom`) over the
 * held profile text; the status bodies and the process-authority bodies over
 * those same sources. The engine therefore sees the signed records it wrote.
 *
 * WHAT THE DOUBLES DECIDE. The mutation transaction is a handle that is active
 * only inside its callback; record and page writes refuse a handle that is not
 * active. The terminal confirmation, the local grant, the human-gate switch and
 * the trusted-write grant answer from `HostWorld` (read at each call, so a case
 * may change them between verbs); the terminal is a TTY that is never read. A
 * page plan always allows, and its apply only answers. A projection write
 * records the text it was handed. The domain effects and every observation
 * throw when reached, so a journey shows exactly which members it used. Every
 * call is logged as `<group>.<member>`.
 *
 * NOT A STORE. This is not a hosted backend, not an access-control layer and
 * not `ProjectStore`; it shows nothing about confinement or locking on disk.
 */

import { LOCAL_WORKFLOW_CORE_INSTANCE, LocalWorkflowTransactionError, type LocalWorkflowTransaction, type LocalWorkflowTransactions } from "../../src/local-workflow-host/contracts.js";
import type { LocalWorkflowHost } from "../../src/local-workflow-host/host-contract.js";
import type { LocalWorkflowObservations } from "../../src/local-workflow-host/observations.js";
import { writeRunCandidatesWith, writeRunWith, type RunRecordStore } from "../../src/local-workflow-host/run-store.js";
import { loadProfileFrom } from "../../src/profile/load.js";
import type { CapabilityClass, ProfilePack } from "../../src/profile/types.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { runIntegrityComputation } from "../../src/workflow-history/integrity.js";
import { assertCurrentWorkflowProcessAuthorityFrom, resolveWorkflowProcessAuthorityFrom } from "../../src/workflow-history/process-authority.js";
import { workflowStatusForWorkflowFrom, workflowStatusFrom, type WorkflowStatusSources } from "../../src/workflow-history/status-read.js";
import { listRunsFrom, readRunFrom, resolveRunIdFrom, type WorkflowRunReads } from "../../src/workflow-history/store.js";
import { effectiveProfileOf, unasked, type Copy } from "./copied-project.js";

/** What the host's plain-function members answer. */
export interface HostWorld { confirm?: boolean; humanGate?: boolean; trusted?: boolean; grant?: CapabilityClass }

/** The memory host, its run texts, its projections and its call log. */
export interface MemoryWorkflowHost {
  host: LocalWorkflowHost;
  runs: Map<string, string>;
  projections: Map<string, string>;
  log: string[];
  /** Replace the held profile text (the next load reads it). */
  install(pack: ProfilePack): void;
}

const RUN_KEY = Buffer.alloc(32, 7);
const RUN_LEAF = /^(.+)\.json$/;

/** The run reads over the Map: one runs directory, one leaf per held run; integrity only once a key was made. */
function runReadsOf(runs: Map<string, string>, keyed: () => boolean): WorkflowRunReads {
  return {
    resolvePrivateDir: async () => "memory:private",
    resolveRunsDir: async () => ({ kind: "ok", dir: "memory:runs" }),
    listRunNames: async () => [...runs.keys()].map((runId) => `${runId}.json`),
    readRunLeaf: async (_dir, name) => {
      const body = runs.get(RUN_LEAF.exec(name)?.[1] ?? "");
      return body === undefined ? { kind: "absent" } : { kind: "ok", body };
    },
    loadIntegrity: async () => (keyed() ? runIntegrityComputation(RUN_KEY) : null),
  };
}

/** A mutation scope whose handles are active only inside their callback. */
function transactionsOf(log: string[]): LocalWorkflowTransactions {
  const active = new Set<LocalWorkflowTransaction>();
  return {
    coreInstance: LOCAL_WORKFLOW_CORE_INSTANCE,
    async withMutation(_root, body) {
      const transaction = {} as LocalWorkflowTransaction;
      log.push("tx.open"); active.add(transaction);
      try { return await body(transaction); } finally { active.delete(transaction); log.push("tx.close"); }
    },
    assertActive(transaction) { if (!active.has(transaction)) throw new LocalWorkflowTransactionError("expired"); },
  };
}

/** The run history over the status sources: the real readers and status bodies. */
function historyOf(sources: WorkflowStatusSources, log: string[]): LocalWorkflowHost["history"] {
  return {
    read: async (_root, runId) => { log.push("history.read"); return readRunFrom(sources.runs, runId); },
    resolve: async (_root, rawId) => { log.push("history.resolve"); return resolveRunIdFrom(sources.runs, rawId); },
    list: async () => { log.push("history.list"); return listRunsFrom(sources.runs); },
    exists: async (_root, runId) => { log.push("history.exists"); return (await readRunFrom(sources.runs, runId)).status !== "absent"; },
    status: async (_root, runId) => { log.push("history.status"); return workflowStatusFrom(sources, runId); },
    statusForWorkflow: async (_root, workflowId) => { log.push("history.statusForWorkflow"); return workflowStatusForWorkflowFrom(sources, workflowId); },
  };
}

/** The profile loader and process-authority bodies over the held profile. */
function profilesOf(sources: WorkflowStatusSources, log: string[]): LocalWorkflowHost["profiles"] {
  const product = sources.profile.activeProduct;
  return {
    load: async () => { log.push("profiles.load"); return loadProfileFrom(sources.profile); },
    resolveProcessAuthority: async (_root, workspaceId, required) => { log.push("profiles.resolve"); return resolveWorkflowProcessAuthorityFrom(product, workspaceId, required); },
    assertProcessAuthority: async (_root, run) => { log.push("profiles.assert"); return assertCurrentWorkflowProcessAuthorityFrom(product, run); },
  };
}

/** Record and page writes, each refusing a handle that is not live. */
function writesOf(store: RunRecordStore, tx: LocalWorkflowTransactions, log: string[]): Pick<LocalWorkflowHost, "records" | "pages"> {
  const live = (name: string, transaction: LocalWorkflowTransaction, root: string): void => { log.push(name); tx.assertActive(transaction, root); };
  return {
    records: {
      write: async (transaction, root, run) => { live("records.write", transaction, root); await writeRunWith(store, run); },
      writeCandidates: async (transaction, root, candidates) => { live("records.writeCandidates", transaction, root); return writeRunCandidatesWith(store, candidates); },
    },
    pages: {
      plan: async (_transaction, _root, output) => { log.push("pages.plan"); return { planned: [{ kind: "page", slug: output.slug }] as never, decision: "allow", checks: [] }; },
      validate: async () => { log.push("pages.validate"); },
      apply: async (transaction, root, planned) => { live("pages.apply", transaction, root); return planned.map(() => ({ kind: "page" }) as const); },
    },
  };
}

/** The terminal, authority and projection answers from `world`; the domain and every observation unreachable. */
function plainMembersOf(world: HostWorld, projections: Map<string, string>, log: string[]): Pick<LocalWorkflowHost, "terminal" | "domain" | "projections" | "authority" | "observations"> {
  return {
    terminal: {
      confirmHumanGate: async () => { log.push("terminal.confirm"); return world.confirm ?? false; },
      processIo: () => { log.push("terminal.io"); return { stdinIsTty: true, stdoutIsTty: true, write: () => {}, readLine: async () => null }; },
    },
    domain: { previewLifecycle: unasked("domain.previewLifecycle"), apply: unasked("domain.apply") },
    projections: { write: async (_root, workflowId, body) => { log.push("projections.write"); projections.set(workflowId, body); return { status: "written", path: `memory:wiki/${workflowId}.md` }; } },
    authority: {
      isTrustedWriteGranted: () => { log.push("authority.trusted"); return world.trusted ?? false; },
      localGrant: async () => { log.push("authority.grant"); return world.grant ?? "read-only"; },
      humanGateEnabled: async () => { log.push("authority.humanGate"); return world.humanGate ?? false; },
    },
    observations: new Proxy({}, { get: (_target, member) => unasked(`observations.${String(member)}`) }) as LocalWorkflowObservations,
  };
}

/** Build the memory host over `pack`. */
export function memoryWorkflowHost(pack: ProfilePack, world: HostWorld = {}): MemoryWorkflowHost {
  const log: string[] = [];
  const runs = new Map<string, string>();
  const projections = new Map<string, string>();
  const copy: Copy = { files: new Map([[PROFILE_FILE, JSON.stringify(pack)]]), listings: new Map() };
  let keyed = false;
  const store: RunRecordStore = { loadKey: async () => { keyed = true; return RUN_KEY; }, persist: async (runId, json) => { runs.set(runId, json); } };
  const sources: WorkflowStatusSources = { profile: effectiveProfileOf(copy, () => {}), runs: runReadsOf(runs, () => keyed) };
  const transactions = transactionsOf(log);
  const host: LocalWorkflowHost = {
    ...transactions, ...plainMembersOf(world, projections, log), ...writesOf(store, transactions, log),
    profiles: profilesOf(sources, log), history: historyOf(sources, log),
  };
  return { host, runs, projections, log, install: (next) => { copy.files.set(PROFILE_FILE, JSON.stringify(next)); } };
}
