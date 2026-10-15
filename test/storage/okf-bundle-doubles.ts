/**
 * @file test/storage/okf-bundle-doubles.ts
 * @description The OKF bundle writer's sources over one copied project, shared
 * by the two storage tests that run the writer with no directory on disk:
 * `okf-bundle-binding.test.ts`, which runs `buildOkfBundleFrom` itself, and
 * `export-run-binding.test.ts`, which runs the top-level export bodies over it.
 * The doubles were written in the first of those files and are stated once,
 * here, unchanged.
 *
 * WHAT THEY DECIDE. The in-memory tree answers what a map of files and a set of
 * directories can: whether a path exists and its kind, a file's text, a
 * directory's names. It RECORDS each explicit directory creation, file write,
 * file copy and removal. It has no links, so its real path is the path, and its
 * `confine` is a lexical stand-in for the disk mechanism. The run store is
 * answered as absent.
 *
 * WHAT THEY ARE NOT. Not a store, not an access-control layer, not
 * `ProjectStore`, and nothing about the disk mechanisms themselves.
 */

import path from "node:path";
import type { OkfBundleSources, OkfBundleTree } from "../../src/export/okf/bundle.js";
import { LLMWIKI_DIR } from "../../src/utils/constants.js";
import { isInsideDir } from "../../src/utils/path-confine.js";
import type { WorkflowRunReads } from "../../src/workflow-history/store.js";
import { unasked, type Copy, type Note } from "./copied-project.js";
import { exportProfileSourcesOf } from "./export-profile-doubles.js";

/** Where the in-memory tree holds the copied project. */
export const MEM_ROOT = "/memory/project";

/**
 * An in-memory tree holding the copied project under {@link MEM_ROOT}. It records each EXPLICIT
 * `makeTree` (`mkdir`), each write, copy and removal; the parent directories a write creates
 * implicitly are added without a record.
 */
export function memoryTree(copy: Copy, effects: string[]): { tree: OkfBundleTree; files: Map<string, string>; dirs: Set<string> } {
  const files = new Map([...copy.files].map(([rel, text]) => [path.posix.join(MEM_ROOT, rel), text] as const));
  const dirs = new Set(["/", "/memory", "/memory/out", ...[...copy.listings.keys()].map((rel) => path.posix.join(MEM_ROOT, rel))]);
  const absent = (location: string): Error => Object.assign(new Error(`ENOENT: ${location}`), { code: "ENOENT" });
  const held = (location: string): string => { const text = files.get(location); if (text === undefined) throw absent(location); return text; };
  const names = (dir: string): string[] => [...new Set([...files.keys(), ...dirs].filter((p) => p !== dir && path.posix.dirname(p) === dir))].map((p) => path.posix.basename(p)).sort();
  const under = (location: string) => (p: string): boolean => p === location || p.startsWith(`${location}/`);
  const makeTree = async (dir: string, record = true): Promise<void> => {
    for (let at = dir; !dirs.has(at); at = path.posix.dirname(at)) { dirs.add(at); if (record) effects.push(`mkdir ${at}`); }
  };
  const tree: OkfBundleTree = {
    realpath: async (location) => (files.has(location) || dirs.has(location) ? location : null),
    kindNoFollow: async (location) => { if (files.has(location)) return "file"; if (dirs.has(location)) return "directory"; throw absent(location); },
    readText: async (location) => held(location),
    listNames: async (dir) => { if (!dirs.has(dir)) throw absent(dir); return names(dir); },
    listEntries: async (dir) => (await tree.listNames(dir)).map((name) => ({ name, isDirectory: () => dirs.has(path.posix.join(dir, name)) })),
    makeTree,
    removeTree: async (location) => {
      effects.push(`remove ${location}`);
      for (const p of [...files.keys()].filter(under(location))) files.delete(p);
      for (const p of [...dirs].filter(under(location))) dirs.delete(p);
    },
    confine: async (rel, root) => {
      const abs = path.posix.normalize(path.posix.join(root, rel));
      if (!isInsideDir(abs, root)) throw new Error(`path escapes project root: ${rel}`);
      return abs;
    },
    write: async (location, content) => { await makeTree(path.posix.dirname(location), false); files.set(location, content); effects.push(`write ${location}`); },
    copyBytes: async (from, to) => { files.set(to, held(from)); effects.push(`copy ${from} -> ${to}`); },
  };
  return { tree, files, dirs };
}

/** The run store, answered as absent; a calling suite shows its copies hold none. */
function noRunsOf(note: Note): WorkflowRunReads {
  return {
    resolvePrivateDir: async () => { note("private"); return `${MEM_ROOT}/${LLMWIKI_DIR}`; },
    resolveRunsDir: async (dir) => { note(`dir ${dir}`); return { kind: "absent" }; },
    listRunNames: unasked("runs.listRunNames"), readRunLeaf: unasked("runs.readRunLeaf"), loadIntegrity: unasked("runs.loadIntegrity"),
  };
}

/** The bundle sources over one copy and one tree: the export profile doubles, and the absent run store. */
export function bundleSourcesOf(copy: Copy, tree: OkfBundleTree, log: string[]): OkfBundleSources {
  const { profile, scans, graph } = exportProfileSourcesOf(copy, MEM_ROOT, log);
  return { tree, profile, scans, block: { graph, runs: noRunsOf((call) => { log.push(`runs:${call}`); }) } };
}
