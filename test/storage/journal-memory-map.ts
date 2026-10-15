/**
 * @file test/storage/journal-memory-map.ts
 * @description The ONE text memory map the journalled bound-write parity suites
 * replay over (`artifact-apply` and `lifecycle-apply`; `artifact-members` shares
 * the key spelling and the path checks over its byte map): POSIX keys under
 * {@link MEM_ROOT}, the journal/replay/page reads and writes the executor's REAL
 * replay runs over, the audit store's bound-append sources, and the executor
 * ports that route one handler. Every member logs its call to the map's ordered
 * log exactly as each suite's trace expects.
 *
 * WHAT IT IS NOT. The maps are not real files: no link, confinement, `lstat`,
 * fsync or durability is shown here. Each suite keeps its own sources, faults and
 * assertions; a suite's one-shot fault is passed in, never kept here.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import type { EventBoundWriteSources } from "../../src/events/store.js";
import type { ApprovedMutationPorts } from "../../src/trust/executor.js";
import type { GraphAppendPlan, GraphStoreReads } from "../../src/utils/jsonl-store.js";
import { diskAuditReads, EVENTS, HEAD, memoryAuditReads, type AuditReads } from "./audit-event-fixtures.js";
import { cappedHeldText, enoent, unasked } from "./copied-project.js";
import { memoryHeadLeaf } from "./graph-store-memory.js";

/** The memory project's root: every memory path is absolute under it. */
export const MEM_ROOT = path.resolve("/memory/project");
/** The journal directory, as a project-relative key. */
export const JOURNAL = ".llmwiki/journal";
/** Files and directories as POSIX keys under {@link MEM_ROOT}, and the ordered log. */
export interface MemoryMap { files: Map<string, string>; dirs: Set<string>; log: string[] }

export const posix = (native: string): string => native.split(path.sep).join("/");
export const keyOf = (abs: string): string => posix(path.relative(MEM_ROOT, abs));
/** A key as the trace shows it: the root as `.`, a journal batch as `<batch>`. */
export const shownKey = (abs: string): string => (keyOf(abs) || ".").replace(/journal\/[^/]+\.json$/u, "journal/<batch>.json");
export function put(memory: MemoryMap, abs: string, text: string): void {
  memory.files.set(keyOf(abs), text);
  for (let dir = path.posix.dirname(keyOf(abs)); dir !== "."; dir = path.posix.dirname(dir)) memory.dirs.add(dir);
}

type JournalIo = ApprovedMutationPorts["journal"] & ApprovedMutationPorts["page"];
/** The three path checks over any map with directories (no links, so a realpath is the normalised spelling). */
export function memoryPathChecks(memory: { files: Map<string, unknown>; dirs: Set<string>; log: string[] }): Pick<JournalIo, "confineTarget" | "realPath" | "safeRealPath"> {
  const exists = (abs: string): boolean => memory.dirs.has(keyOf(abs)) || memory.files.has(keyOf(abs)) || keyOf(abs) === "";
  return {
    confineTarget: async (target, root) => { memory.log.push(`confine ${posix(target)}`); return path.resolve(root, target); },
    realPath: async (location) => { memory.log.push(`realpath ${shownKey(location)}`); if (!exists(location)) throw enoent(); return path.resolve(location); },
    safeRealPath: async (location) => { memory.log.push(`safe-realpath ${shownKey(location)}`); return exists(location) ? path.resolve(location) : null; },
  };
}

/** The journal, replay and page reads over the map, every call logged. */
export function memoryReads(memory: MemoryMap): Pick<JournalIo,
  "confineTarget" | "realPath" | "safeRealPath" | "leafPresent" | "readConfinedLeafText" | "readConfinedLeafBytes" | "readLeafTextNoFollow"> {
  return {
    ...memoryPathChecks(memory),
    leafPresent: async (dir, name) => { memory.log.push(`present ${shownKey(path.join(dir, name))}`); return memory.files.has(keyOf(path.join(dir, name))); },
    readConfinedLeafText: async (_root: string, leaf: string, _dir: string, maxBytes: number) => {
      memory.log.push(`read ${shownKey(leaf)}`);
      return cappedHeldText(memory.files.get(keyOf(leaf)), maxBytes);
    },
    readConfinedLeafBytes: unasked("readConfinedLeafBytes"),
    readLeafTextNoFollow: async (leaf) => { memory.log.push(`read-nofollow ${shownKey(leaf)}`); return memory.files.get(keyOf(leaf)) ?? null; },
  };
}

/** The journal, replay and page writes over the same map, every call logged. */
export function memoryWrites(memory: MemoryMap): Omit<JournalIo, keyof ReturnType<typeof memoryReads>> {
  return {
    replaceLeafAtomicWithin: async (_root, leaf, text) => { memory.log.push(`replace ${shownKey(leaf)}`); put(memory, leaf, text); },
    replaceLeafContentWithin: async (_root, leaf, content) => { memory.log.push(`restore ${shownKey(leaf)}`); put(memory, leaf, typeof content === "string" ? content : Buffer.from(content).toString("utf-8")); },
    removeLeaf: async (leaf) => { memory.log.push(`remove ${shownKey(leaf)}`); if (!memory.files.delete(keyOf(leaf))) throw enoent(); },
    listDirectoryNames: async (dir) => {
      const prefix = `${keyOf(dir)}/`;
      const names = [...new Set([...memory.files.keys()].filter((rel) => rel.startsWith(prefix)).map((rel) => rel.slice(prefix.length).split("/")[0]!))];
      memory.log.push(`list ${shownKey(dir)} -> ${names.map((name) => name.replace(/^.+\.json$/u, "<batch>.json")).join(",")}`);
      return names;
    },
    makeDirectoryTree: async (dir) => { memory.log.push(`mkdir ${shownKey(dir)}`); memory.dirs.add(keyOf(dir)); },
    renameLeafUnguarded: async (from, to) => { memory.log.push(`rename ${shownKey(from)} -> ${shownKey(to)}`); put(memory, to, memory.files.get(keyOf(from))!); memory.files.delete(keyOf(from)); },
  };
}

/** The journal and page I/O as one object: the reads and writes over the same map. */
export const journalIo = (memory: MemoryMap): JournalIo => ({ ...memoryReads(memory), ...memoryWrites(memory) });

/** The audit store's bound-append sources over the same map; `beforeAppend` (a suite's one-shot fault) runs first in each append. */
export function memoryEvents(memory: MemoryMap, beforeAppend: () => void = () => {}): EventBoundWriteSources {
  const graph: GraphStoreReads = { readStore: async (config) => { memory.log.push(`read ${config.fileName}`); return memory.files.get(`wiki/graph/${config.fileName}`) ?? null; } };
  const append = async (plan: GraphAppendPlan): Promise<void> => {
    beforeAppend();
    const existing = Buffer.byteLength(memory.files.get(EVENTS) ?? "");
    memory.log.push(`append events.jsonl at ${existing}`);
    memory.files.set(EVENTS, memory.files.get(EVENTS) ?? "");
    for (const chunk of plan(existing)) { memory.log.push("write events.jsonl"); memory.files.set(EVENTS, memory.files.get(EVENTS)! + chunk); }
  };
  return {
    graph,
    resolvePrivateDir: async () => { memory.log.push("private-dir"); return memory.dirs.has(".llmwiki") ? ".llmwiki" : null; },
    readHeadLeaf: memoryHeadLeaf(memory),
    replaceStore: async (body) => { memory.log.push("replace events.jsonl"); memory.files.set(EVENTS, body); },
    appendStore: append,
    storeByteSize: async () => { memory.log.push("size events.jsonl"); return Buffer.byteLength(memory.files.get(EVENTS) ?? ""); },
    sealHead: async (digest) => { memory.log.push("seal"); memory.files.set(HEAD, digest); },
    replaceStoreDurable: async (body) => { memory.log.push("durable events.jsonl"); memory.files.set(EVENTS, body); },
  };
}

/** The executor's ports over the map with exactly one handler routed; every other member is unasked. */
export function executorPorts(memory: MemoryMap, handlers: ApprovedMutationPorts["handlers"]): ApprovedMutationPorts {
  const io = journalIo(memory);
  return { journal: io, page: io, writeOne: unasked("writeOne"), notes: unasked("notes"), handlers };
}

/** The disk side's audit reads and journal-directory entries for one project root. */
export function diskJournalledReads(root: string): AuditReads & { journal(): Promise<string[]> } {
  return { ...diskAuditReads(root), journal: () => readdir(path.join(root, JOURNAL)).catch(() => []) };
}

/** The memory side's audit reads and journal entries over the map; the event reads use a quiet (unlogged) view. */
export function memorySideReads(memory: MemoryMap): AuditReads & { journal(): Promise<string[]> } {
  return {
    ...memoryAuditReads(memory.files, memoryEvents({ ...memory, log: [] })),
    journal: async () => [...memory.files.keys()].filter((rel) => rel.startsWith(`${JOURNAL}/`)),
  };
}

