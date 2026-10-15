/**
 * @file src/profile/templates/history-audit.ts
 * @description Strict record-level audits for candidate and workflow history
 * before a profile update can reinterpret project state.
 *
 * ONE BODY PER AUDIT over {@link HistoryAuditReads}: the archive directory, its
 * typed listing, one capped archived-candidate leaf, the workflow-runs listing and
 * the workflow store's own bound run read. The bodies own the entry caps, the
 * entry order, the unexpected-entry refusals, the record shape and every message;
 * the local reads keep the confined resolution, the raw listing and the confined
 * capped read. The root forms keep their signatures and build the reads per call.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { resolveConfinedCandidatesDir } from "../../compiler/candidate-store-paths.js";
import { readConfinedLeaf, type CappedLeafRead } from "../../utils/confined-read.js";
import { CANDIDATES_ARCHIVE_DIR } from "../../utils/constants.js";
import { isTerminalStatus } from "../../workflow-history/definition.js";
import { diskWorkflowRunReads, readRunFrom, type WorkflowRunReads } from "../../workflow-history/store.js";
import { confinedEntries } from "./corpus.js";

const MAX_ARCHIVED_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 10_000;

/** What the history audits read. No member takes a project root; `dir` is the handle the first returned. */
export interface HistoryAuditReads {
  /** The confined candidate archive, `null` when absent; rejects when unsafe. */
  resolveArchiveDir(): Promise<string | null>;
  /** The archive's entries with their file-ness, in listing order; rejects raw. */
  listArchive(dir: string): Promise<Array<{ name: string; isFile: boolean }>>;
  /** One archived candidate leaf, confined and capped. */
  readArchivedCandidate(name: string, maxBytes: number): Promise<CappedLeafRead>;
  /** The workflow-runs directory's entry names. Local: `confinedEntries(root, ".llmwiki/workflows/runs")`. */
  workflowRunEntries(): Promise<string[] | "absent" | "unavailable">;
  /** The workflow store's own run reads. Local: `diskWorkflowRunReads(root)`. */
  workflowRuns: WorkflowRunReads;
}

/** LOCAL DISK. The incumbent confined reads for one root, built per call; each called when asked. */
function diskHistoryAuditReads(root: string): HistoryAuditReads {
  return {
    resolveArchiveDir: () => resolveConfinedCandidatesDir(root, CANDIDATES_ARCHIVE_DIR),
    listArchive: async (dir) => (await readdir(dir, { withFileTypes: true })).map((entry) => ({ name: entry.name, isFile: entry.isFile() })),
    readArchivedCandidate: (name, maxBytes) => {
      const expectedDir = path.join(root, CANDIDATES_ARCHIVE_DIR);
      return readConfinedLeaf(root, path.join(expectedDir, name), expectedDir, maxBytes);
    },
    workflowRunEntries: () => confinedEntries(root, ".llmwiki/workflows/runs"),
    workflowRuns: diskWorkflowRunReads(root),
  };
}

/** Validate every archived candidate record through confined capped reads. */
export async function auditCandidateArchive(root: string): Promise<string[]> {
  return auditCandidateArchiveFrom(diskHistoryAuditReads(root));
}

/** {@link auditCandidateArchive} over {@link HistoryAuditReads}: THE ONE BODY. */
export async function auditCandidateArchiveFrom(reads: HistoryAuditReads): Promise<string[]> {
  let dir: string | null;
  try {
    dir = await reads.resolveArchiveDir();
  } catch {
    return ["candidate archive is unreadable or unsafe"];
  }
  if (dir === null) return [];
  let entries;
  try {
    entries = await reads.listArchive(dir);
  } catch {
    return ["candidate archive is unreadable or unsafe"];
  }
  if (entries.length > MAX_HISTORY_ENTRIES) return ["candidate archive exceeds its entry cap"];
  const reasons: string[] = [];
  for (const entry of entries) reasons.push(...await auditCandidateLeaf(reads, entry.name, entry.isFile));
  return reasons;
}

async function auditCandidateLeaf(reads: HistoryAuditReads, name: string, isFile: boolean): Promise<string[]> {
  if (!isFile || !name.endsWith(".json")) return [`candidate archive contains unexpected entry: ${name}`];
  const read = await reads.readArchivedCandidate(name, MAX_ARCHIVED_CANDIDATE_BYTES);
  if (read.kind !== "ok") return [`archived candidate is unreadable or unsafe: ${name}`];
  try {
    const value = JSON.parse(read.body) as Record<string, unknown>;
    const id = name.slice(0, -".json".length);
    return validCandidate(value, id) ? [] : [`archived candidate is malformed: ${name}`];
  } catch {
    return [`archived candidate is malformed: ${name}`];
  }
}

function validCandidate(value: Record<string, unknown>, expectedId: string): boolean {
  return value.id === expectedId
    && typeof value.title === "string"
    && typeof value.slug === "string"
    && typeof value.body === "string"
    && Array.isArray(value.sources);
}

/** Validate every workflow-store entry and block every non-terminal run. */
export async function auditWorkflowHistory(root: string): Promise<Array<{ kind: "store" | "workflow"; message: string }>> {
  return auditWorkflowHistoryFrom(diskHistoryAuditReads(root));
}

/** {@link auditWorkflowHistory} over {@link HistoryAuditReads}: THE ONE BODY. */
export async function auditWorkflowHistoryFrom(reads: HistoryAuditReads): Promise<Array<{ kind: "store" | "workflow"; message: string }>> {
  const entries = await reads.workflowRunEntries();
  if (entries === "absent") return [];
  if (entries === "unavailable" || entries.length > MAX_HISTORY_ENTRIES) {
    return [{ kind: "store", message: "workflow store is unreadable, unsafe, or over its entry cap" }];
  }
  const reasons: Array<{ kind: "store" | "workflow"; message: string }> = [];
  for (const name of entries) reasons.push(...await auditWorkflowLeaf(reads, name));
  return reasons;
}

async function auditWorkflowLeaf(reads: HistoryAuditReads, name: string): Promise<Array<{ kind: "store" | "workflow"; message: string }>> {
  if (!name.endsWith(".json")) return [{ kind: "store", message: `workflow store contains unexpected entry: ${name}` }];
  const runId = name.slice(0, -".json".length);
  const read = await readRunFrom(reads.workflowRuns, runId);
  if (read.status !== "ok") return [{ kind: "store", message: `workflow run ${runId} is unavailable` }];
  return isTerminalStatus(read.run.status) ? [] : [{ kind: "workflow", message: `workflow run ${runId} is active` }];
}
