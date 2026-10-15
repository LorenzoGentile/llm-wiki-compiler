/**
 * @file src/portable/store/disk-intent.ts
 * @description Which portable publication intents are unresolved, as the
 * registered-project gate reads them.
 *
 * A portable publication records its intent under the ledger before its first
 * write, and settles it with a commit receipt or a recorded close. An intent
 * with neither is unresolved: its writes may be half done, so the gate refuses
 * ordinary mutations of the project until it is settled. This module only
 * reads the ledger; it never writes or recovers anything.
 */

import { listFileNames, readProjectFile } from "./disk-io.js";
import { ledgerDir, ledgerFile } from "./disk-layout.js";

/** Bound on one ledger record read while scanning for unresolved intents. */
const MAX_LEDGER_RECORD_BYTES = 16 * 1024 * 1024;

/** True when `operationId` has a commit receipt or a recorded close. */
async function isSettled(root: string, operationId: string): Promise<boolean> {
  for (const kind of ["receipts", "closed"] as const) {
    if ((await readProjectFile(root, ledgerFile(kind, operationId), MAX_LEDGER_RECORD_BYTES)) !== null) return true;
  }
  return false;
}

/**
 * Ids of intents with neither a commit receipt nor a recorded close.
 * The legacy mutation gate reads this too, without opening a store.
 */
export async function unresolvedDiskIntents(root: string): Promise<string[]> {
  const unresolved: string[] = [];
  for (const name of await listFileNames(root, ledgerDir("intents"))) {
    const operationId = name.replace(/\.json$/u, "");
    if (!(await isSettled(root, operationId))) unresolved.push(operationId);
  }
  return unresolved;
}
