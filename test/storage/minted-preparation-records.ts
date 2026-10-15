/**
 * @file test/storage/minted-preparation-records.ts
 * @description One mint shared by the storage tests that run real bodies FROM
 * MEMORY OVER RECORDS THE REAL WRITER MINTED ON DISK:
 * `preparation-record-reads-binding.test.ts` and
 * `preparation-list-show-binding.test.ts`. Signing a run needs the real writer
 * and the real key, so each of those tests stages one preparation in a
 * directory it owns, copies what was written into memory, and has the
 * directory removed before any case runs. What is copied, how, and when the
 * directory goes, is stated once here.
 *
 * WHAT IT DOES. In a directory the CALLING TEST'S OWN tracker creates under the
 * calling test's own prefix, it stages one preparation with the shared
 * lifecycle fixture and copies out: the run's binding and manifest, the
 * manifest's bytes, the run leaf's text and its parsed form, the key (read and
 * as text), the result of one real active-store scan, and the store's own
 * ENTRIES below `.llmwiki/workspaces` as plain names, kinds, sizes and inode
 * numbers. Those entries are listed with `readdir` and `lstat` and have NEVER
 * been through the scanner, so a test can run the real walk over them and is
 * not replaying a scan. The run and the key
 * are read through the real root-taking readers, so a fixture that did not
 * stage a readable run fails here and not in a case. A test that needs
 * something else from the live directory asks for it in `whileOnDisk`. Then
 * the tracker's cleanup runs, whatever happened.
 *
 * WHAT IT IS NOT. It names no path for removal: the tracker in
 * `test/temp-roots.ts` removes only the directories that same tracker created.
 * The copy is a snapshot of one moment; nothing here keeps it in step with the
 * disk. It is not a general test framework: it holds this one mint and its
 * result type.
 */

import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readPreparationKey, type PreparationKeyRead } from "../../src/preparations/key-epoch.js";
import type { PreparationManifestV1 } from "../../src/preparations/manifest-parse.js";
import { scanActivePreparationStore, type PreparationOrphanScan } from "../../src/preparations/orphan-scan.js";
import { preparationKeyFile, preparationPaths } from "../../src/preparations/paths.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import type { PreparationRunBinding, PreparationRunV1 } from "../../src/preparations/run-types.js";
import { stagePreparation } from "../preparations/lifecycle-fixture.js";
import type { TempRootTrackerV1 } from "../temp-roots.js";
import type { TreeDirectory, TreeNode } from "./memory-store-tree.js";

const STORE_DIRECTORY = ".llmwiki";
const WALK_ROOT = "workspaces";

/** Everything copied into memory from the one staged preparation. */
export interface MintedPreparationRecords {
  dir: string;
  binding: PreparationRunBinding;
  manifest: PreparationManifestV1;
  manifestBytes: Buffer;
  runText: string;
  run: PreparationRunV1;
  key: Extract<PreparationKeyRead, { status: "ok" }>;
  keyText: string;
  activeScan: PreparationOrphanScan;
  /** The store's entries from `workspaces` down, as listed. Not a scan result. */
  storeTree: TreeDirectory;
}

/** Copy one directory's entries into memory, in listing order: names, kinds, and each leaf's size and inode. */
async function copyStoreEntries(directory: string): Promise<TreeDirectory> {
  const entries: Record<string, TreeNode> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      entries[entry.name] = await copyStoreEntries(child);
      continue;
    }
    const { size, ino } = await lstat(child);
    entries[entry.name] = { type: entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other", size, ino };
  }
  return { type: "directory", entries };
}

/** Stage one preparation in `dir` and copy its records into memory, through the real readers and plain file reads. */
async function copyStagedPreparationRecords(dir: string): Promise<MintedPreparationRecords> {
  const { binding, manifest } = await stagePreparation(dir);
  const paths = preparationPaths(dir, binding.workspaceId);
  const key = await readPreparationKey(dir);
  const read = await readPreparationRun(dir, binding);
  if (key.status !== "ok" || read.status !== "ok") throw new Error("the fixture did not stage a readable run");
  return {
    dir, binding, manifest, key, run: read.run,
    manifestBytes: await readFile(paths.manifestFile(binding.preparationId)),
    runText: await readFile(paths.runFile(binding.runId), "utf8"),
    keyText: await readFile(preparationKeyFile(dir), "utf8"),
    activeScan: await scanActivePreparationStore(dir),
    storeTree: { type: "directory", entries: { [WALK_ROOT]: await copyStoreEntries(path.join(dir, STORE_DIRECTORY, WALK_ROOT)) } },
  };
}

/**
 * Mint one staged preparation's records in a directory `roots` creates, and
 * have `roots` remove it again before this returns or rejects.
 *
 * @param roots - The calling test's own tracker; its cleanup is what removes.
 * @param prefix - The calling test's own directory prefix.
 * @param whileOnDisk - Anything else the test needs from the live directory.
 * @returns The records, as they were on disk before the directory was removed.
 */
export async function mintPreparationRecords(
  roots: TempRootTrackerV1, prefix: string,
  whileOnDisk: (records: MintedPreparationRecords) => Promise<void> = async () => {},
): Promise<MintedPreparationRecords> {
  const dir = await roots.create(prefix);
  try {
    const records = await copyStagedPreparationRecords(dir);
    await whileOnDisk(records);
    return records;
  } finally {
    await roots.cleanup();
  }
}
