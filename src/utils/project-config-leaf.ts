/**
 * @file src/utils/project-config-leaf.ts
 * @description The ONE physical read of the project's `.llmwiki/config.json`
 * that the config readers (connector etiquette, local workflow grants) decide
 * over. It resolves the EXISTING private directory without creating it (a
 * confinement fault on it is reported, never thrown), then reads the leaf through
 * the shared capped, no-follow, regular-file read. Each physical outcome stays
 * distinct, so every reader keeps its own refusal reasons. It decides nothing:
 * parsing, defaults and fail-closed policy belong to the readers. In no package
 * index.
 */

import path from "node:path";
import { MAX_LOCAL_CONFIG_BYTES } from "./constants.js";
import { readCappedNoFollow } from "./confined-read.js";
import { resolveExistingConfinedPrivateDir } from "./private-dir.js";

/** One physical read of the project config leaf, each outcome distinct. */
export type ProjectConfigLeafRead =
  | { kind: "dir-absent" }
  | { kind: "dir-unavailable" }
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "ok"; body: string };

/** The project config leaf as a config reader asks it. No member takes a project root. */
export interface ProjectConfigLeaf {
  /** No private directory; a confinement fault on it; then the leaf: absent, unreadable or over the cap, or its text. */
  readConfig(): Promise<ProjectConfigLeafRead>;
}

/** LOCAL DISK. The incumbent confined directory resolution and capped no-follow read for `root`, called when asked. */
export function diskProjectConfigLeaf(root: string): ProjectConfigLeaf {
  return {
    readConfig: async () => {
      let dir: string | null;
      try {
        dir = await resolveExistingConfinedPrivateDir(root);
      } catch {
        return { kind: "dir-unavailable" };
      }
      if (dir === null) return { kind: "dir-absent" };
      const read = await readCappedNoFollow(path.join(dir, "config.json"), MAX_LOCAL_CONFIG_BYTES);
      return read.kind === "ok" ? { kind: "ok", body: read.body } : { kind: read.kind };
    },
  };
}
