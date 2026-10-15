/**
 * @file src/project/state-sources.ts
 * @description What the project-state collector (`./state.ts`) reads through,
 * and the one local-disk implementation of it. It lives beside the collector
 * only because the collector's file would otherwise pass the size limit; the
 * seam is the collector's own and nothing else uses it.
 *
 * {@link ProjectStateSources} is a narrow seam for that ONE consumer. It is not
 * `ProjectStore`, not a hosted or access-control contract, and it selects no
 * backend. It carries no decision: what a failed look means, what counts as a
 * page, how the lint cache is parsed and when it is stale are all decided in
 * `./state.ts`.
 *
 * `modifiedMs` on the local disk is the looked-at directory's OWN modification
 * time, so a change inside a nested directory does not move it. That is the
 * incumbent meaning, kept, not endorsed.
 */

import path from "path";
import { listDirectoryEntries } from "../storage/disk-guarded-leaves.js";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";
import { diskLocalRecords } from "../storage/disk-local-records.js";
import { locationStat, readLocationText } from "../storage/disk-locations.js";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import type { LegacyLocalRecords } from "../storage/legacy-local-records.js";

/** What one look at one place answers. `modifiedMs` is that place's OWN modification time. */
export interface ProjectStateProbe {
  isDirectory: boolean;
  isFile: boolean;
  modifiedMs: number;
}

/**
 * The looks the collector takes at a project. EVERY CALL IS A FRESH LOOK: an
 * implementation must not answer a later call from an earlier one (the
 * collector looks at `wiki` and at `sources` twice, once for presence and later
 * for the time).
 */
export interface ProjectStateProbes {
  /** The project root itself, exactly as the caller spelled it. `null` for every failure. Never rejects. */
  probeRoot(): Promise<ProjectStateProbe | null>;
  /** One place under the root, FOLLOWING links. `null` for every failure. Never rejects. */
  probe(relPath: string): Promise<ProjectStateProbe | null>;
  /** A directory's direct entries, each saying whether the ENTRY ITSELF is a regular file (no link followed). REJECTS raw. */
  listEntries(relDir: string): Promise<Array<{ name: string; isFile: boolean }>>;
  /** The whole text at a path, decoded as UTF-8. REJECTS raw. */
  readText(relPath: string): Promise<string>;
}

/** Everything `collectProjectStateFrom` reads. Nothing ties the five to one project; production builds all from one root. */
export interface ProjectStateSources {
  /** The root as the caller holds it. DISPLAY ONLY: the state's `root` and the unreadable-root message. */
  root: string;
  probes: ProjectStateProbes;
  /** Source entries, and the project configuration that selects them. Its rejection is NOT caught. */
  reads: LegacyLocalReads;
  /** The pending review queue, counted through the tolerant list. */
  candidateDirs: LegacyLocalRecordDirs;
  /** The compile state record. */
  records: LegacyLocalRecords;
}

/** LOCAL DISK. The sources for the project at `root`. Building them does no I/O. In no package index. */
export function diskProjectStateSources(root: string): ProjectStateSources {
  return {
    root,
    probes: {
      probeRoot: () => probeLocation(root),
      probe: (relPath) => probeLocation(path.join(root, relPath)),
      listEntries: async (relDir) =>
        (await listDirectoryEntries(path.join(root, relDir))).map((entry) => ({ name: entry.name, isFile: entry.isFile() })),
      readText: (relPath) => readLocationText(path.join(root, relPath)),
    },
    reads: diskLocalReads(root),
    candidateDirs: diskLocalRecordDirs(root),
    records: diskLocalRecords(root),
  };
}

/** LOCAL DISK. One FOLLOWING `stat` of `location`; `null` when it fails for any reason. */
async function probeLocation(location: string): Promise<ProjectStateProbe | null> {
  try {
    const stats = await locationStat(location);
    return { isDirectory: stats.isDirectory(), isFile: stats.isFile(), modifiedMs: stats.mtimeMs };
  } catch {
    return null;
  }
}
