/**
 * @file test/storage/project-config-projects.ts
 * @description The shared shape of the project-config binding suites (connector
 * config, local workflow grant): small projects held as files, the in-memory
 * `ProjectConfigLeaf` over those same files, and one pass that answers every
 * project through the root form on real disk and through the bound body over
 * memory, so the suites compare the two answers rather than re-deriving them.
 *
 * The leaf double answers only from the held files: no `.llmwiki` at all is
 * `dir-absent`, a private directory without the config leaf is `absent`, and a
 * held leaf is `ok` with its exact text. It has no links, caps or confinement.
 */

import type { ProjectConfigLeaf } from "../../src/utils/project-config-leaf.js";
import type { TempRootTrackerV1 } from "../temp-roots.js";
import { writeFiles } from "./copied-project.js";

/** The one config leaf every project-config suite plants, relative to the project. */
export const PROJECT_CONFIG = ".llmwiki/config.json";

/** A project's files by relative path, or `null` for a project with no `.llmwiki` at all. */
export type ConfigProjectFiles = Record<string, string> | null;

/** The shared leaf over a project's files, as the memory side holds them. */
export function projectConfigLeafOf(files: ConfigProjectFiles): ProjectConfigLeaf {
  return {
    readConfig: async () => (files === null ? { kind: "dir-absent" }
      : PROJECT_CONFIG in files ? { kind: "ok", body: files[PROJECT_CONFIG]! } : { kind: "absent" }),
  };
}

/** How one suite answers a project: through the root form on disk, and through the bound body over the leaf. */
export interface ConfigProjectAnswers<T> {
  readonly onDisk: (root: string) => Promise<T>;
  readonly inMemory: (leaf: ProjectConfigLeaf) => Promise<T>;
}

/**
 * Mint each project on real disk under `prefix`, and answer it both ways.
 *
 * @returns Every project's disk answer and memory answer, keyed by project name.
 */
export async function answerConfigProjects<T>(
  tracker: TempRootTrackerV1, prefix: string, projects: Record<string, ConfigProjectFiles>, answers: ConfigProjectAnswers<T>,
): Promise<{ onDisk: Record<string, T>; inMemory: Record<string, T> }> {
  const onDisk: Record<string, T> = {}, inMemory: Record<string, T> = {};
  for (const [name, files] of Object.entries(projects)) {
    const root = await tracker.create(prefix);
    if (files !== null) await writeFiles(root, files);
    onDisk[name] = await answers.onDisk(root);
    inMemory[name] = await answers.inMemory(projectConfigLeafOf(files));
  }
  return { onDisk, inMemory };
}
