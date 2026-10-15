/**
 * @file src/portable/store/disk-layout.ts
 * @description Where a registered project's publication ledger lives inside an
 * ordinary project directory.
 *
 * The ledger is under `.llmwiki/portable/`, a directory no legacy command
 * lists: legacy review reads only `.llmwiki/candidates/`, and legacy journal
 * replay reads only `.llmwiki/journal/`. The directory's presence is how the
 * gate discovers a registered project at all; on every other project it is
 * absent and the gate does nothing more.
 */

import path from "node:path";
import { PortableRefusal } from "../errors.js";
import { isSafeRecordId } from "../logical-paths.js";

/** The portable directory inside a project. Its presence is feature discovery, never authority. */
export const PORTABLE_DIR = path.join(".llmwiki", "portable");

/** The adapter-private publication ledger. */
const LEDGER_DIR = path.join(PORTABLE_DIR, "ledger");

/** The kinds of ledger record, each in its own directory. */
export type LedgerKind =
  | "identity" | "intents" | "started" | "receipts" | "closed" | "preimages" | "labels" | "reservations";

/** Project-relative path of one ledger record. */
export function ledgerFile(kind: LedgerKind, name: string): string {
  if (!isSafeRecordId(name)) throw new PortableRefusal("operation_unsupported_on_portable_path", "unsafe ledger key");
  return path.join(LEDGER_DIR, kind, kind === "preimages" || kind === "started" ? name : `${name}.json`);
}

/** Project-relative directory holding one kind of ledger record. */
export function ledgerDir(kind: LedgerKind): string {
  return path.join(LEDGER_DIR, kind);
}
