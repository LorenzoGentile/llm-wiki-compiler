/**
 * @file test/storage/graph-store-memory.ts
 * @description The two graph-store reads the relation-create parity suites
 * (`relation-append` and `relation-operation-append`) answer over one flat text
 * map: the capped store read by the store's own file name, and the event store's
 * private-directory and head-leaf looks. Every call is logged to the map's log
 * exactly as each suite's trace expects.
 *
 * WHAT IT IS NOT. Each suite keeps its own append, durable replacement and faults;
 * nothing here shows confinement, no-follow opens or durability.
 */

import type { EventReadSources } from "../../src/events/store-read.js";
import type { GraphStoreReads } from "../../src/utils/jsonl-store.js";

/** A flat project map: project-relative keys and the ordered log. */
export interface GraphMemory { files: Map<string, string>; log: string[] }

/** The graph read over the map, by the store's own file name and cap. */
export function memoryGraphReads(memory: GraphMemory): GraphStoreReads {
  return { readStore: async (config) => {
    memory.log.push(`read ${config.fileName}`);
    const text = memory.files.get(`wiki/graph/${config.fileName}`);
    if (text !== undefined && Buffer.byteLength(text) > config.maxBytes) throw config.makeOversizeError(Buffer.byteLength(text));
    return text ?? null;
  } };
}

/** The event store's private-directory look (present once any `.llmwiki/` key is held) and its head-leaf read. */
export function memoryEventHeadReads(memory: GraphMemory): Pick<EventReadSources, "resolvePrivateDir" | "readHeadLeaf"> {
  return {
    resolvePrivateDir: async () => { memory.log.push("private-dir"); return [...memory.files.keys()].some((rel) => rel.startsWith(".llmwiki/")) ? ".llmwiki" : null; },
    readHeadLeaf: memoryHeadLeaf(memory),
  };
}

/** The event store's head-leaf read over any flat text map, logged as `head <name>`. */
export function memoryHeadLeaf(memory: GraphMemory): EventReadSources["readHeadLeaf"] {
  return async (dir, name) => {
    memory.log.push(`head ${name}`);
    const text = memory.files.get(`${dir}/${name}`);
    return text === undefined ? { kind: "absent" } : { kind: "text", text };
  };
}
