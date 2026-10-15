/**
 * @file src/trust/journal-io.ts
 * @description The RAW local I/O contracts the page-store journal asks for, and
 * their incumbent local-disk implementations. Nothing here decides anything:
 * every member gives a physical answer only — refusals the primitives return as
 * values stay values, and every other failure REJECTS raw, errno kept. What an
 * answer MEANS (layout, parsing, status, confinement verdicts, revert, quarantine,
 * recovery, and every diagnostic) is decided by `./journal.ts`,
 * `./journal-classify.ts` and `./journal-recovery.ts`.
 *
 * Three nested contracts, each the smallest a body family needs:
 * {@link JournalBatchIo} for the batch lifecycle (open, capture, commit),
 * {@link JournalRestoreIo} for restoration and the trusted reads, and
 * {@link JournalReplayIo} for best-effort replay, quarantine and strict recovery.
 * The disk objects are frozen and stateless and call the imported primitives at
 * call time, so module spies and module mocks still intercept them. None of this
 * is a `ProjectStore`, hosted, access-controlled, or power-loss durable, and none
 * of it is in any package index.
 */

import {
  listDirectoryNames, makeDirectoryTree, readConfinedLeafBytes, readConfinedLeafText, readLeafTextNoFollow,
  removeLeaf, renameLeafUnguarded, replaceLeafAtomicWithin,
} from "../storage/disk-guarded-leaves.js";
import { locationRealPath } from "../storage/disk-locations.js";
import { safeRealpath } from "../utils/path-confine.js";
import type { CappedLeafRead, CappedLeafReadBuffer, ReadLeafOptions } from "../utils/confined-read.js";
import { diskPageTargetProbes, type PageTargetProbes } from "./checks.js";

/**
 * The RAW local I/O the batch lifecycle (open, capture, commit and their shared
 * persist) asks for. Every member gives a physical answer only and decides
 * nothing; refusals the primitives return as values stay values, and every
 * other failure REJECTS raw, errno kept. Replay, recovery, quarantine and
 * revert do not use this contract.
 */
export interface JournalBatchIo extends Pick<PageTargetProbes, "confineTarget"> {
  /** `location` with every link resolved. REJECTS raw. Disk: `locationRealPath(location)`. */
  realPath(location: string): Promise<string>;
  /** The root-anchored, handle-bound, capped no-follow text read; `absent`/`unavailable` are values. Disk: `readConfinedLeafText`. */
  readConfinedLeafText(root: string, leaf: string, expectedDir: string, maxBytes: number, opts: ReadLeafOptions): Promise<CappedLeafRead>;
  /** The bytes sibling of `readConfinedLeafText`, same refusals. Disk: `readConfinedLeafBytes`. */
  readConfinedLeafBytes(root: string, leaf: string, expectedDir: string, maxBytes: number, opts: ReadLeafOptions): Promise<CappedLeafReadBuffer>;
  /** Replace `leaf` with `text` atomically, confined to `confineRoot` as given; NOT durable. Disk: `replaceLeafAtomicWithin`. */
  replaceLeafAtomicWithin(confineRoot: string, leaf: string, text: string): Promise<void>;
  /** Unlink `leaf`, by path. REJECTS raw. Disk: `removeLeaf(leaf)`. */
  removeLeaf(leaf: string): Promise<void>;
}

/** LOCAL DISK. The incumbent primitives, called at call time; no state, frozen. In no package index. */
export const diskJournalBatchIo: JournalBatchIo = Object.freeze({
  confineTarget: diskPageTargetProbes.confineTarget,
  realPath: (location: string) => locationRealPath(location),
  readConfinedLeafText: (root: string, leaf: string, expectedDir: string, maxBytes: number, opts: ReadLeafOptions) =>
    readConfinedLeafText(root, leaf, expectedDir, maxBytes, opts),
  readConfinedLeafBytes: (root: string, leaf: string, expectedDir: string, maxBytes: number, opts: ReadLeafOptions) =>
    readConfinedLeafBytes(root, leaf, expectedDir, maxBytes, opts),
  replaceLeafAtomicWithin: (confineRoot: string, leaf: string, text: string) => replaceLeafAtomicWithin(confineRoot, leaf, text),
  removeLeaf: (leaf: string) => removeLeaf(leaf),
});

/**
 * The RAW local I/O the journal's restoration and trust reads ask for, beyond
 * the lifecycle's confinement, raw `realPath` and removal. Note the two realpath
 * answers: `realPath` REJECTS raw, while `safeRealPath` answers null on ANY
 * failure. Each member decides nothing.
 */
export interface JournalRestoreIo extends Pick<JournalBatchIo, "confineTarget" | "realPath" | "removeLeaf"> {
  /** `location` with every link resolved, or null on ANY failure. Disk: `safeRealpath(location)`, no options. */
  safeRealPath(location: string): Promise<string | null>;
  /** Replace `leaf` with text or bytes atomically, confined to `confineRoot` as given; NOT durable. Disk: `replaceLeafAtomicWithin`. */
  replaceLeafContentWithin(confineRoot: string, leaf: string, content: string | Uint8Array): Promise<void>;
  /** A no-follow, regular-file-only UTF-8 read; null on EVERY open or read failure, while a rejecting close propagates. Disk: `readLeafTextNoFollow`. */
  readLeafTextNoFollow(leaf: string): Promise<string | null>;
}

/** LOCAL DISK. The lifecycle's own members where the call is identical, plus three incumbent primitives; frozen. In no package index. */
export const diskJournalRestoreIo: JournalRestoreIo = Object.freeze({
  confineTarget: diskJournalBatchIo.confineTarget,
  realPath: diskJournalBatchIo.realPath,
  removeLeaf: diskJournalBatchIo.removeLeaf,
  safeRealPath: (location: string) => safeRealpath(location),
  replaceLeafContentWithin: (confineRoot: string, leaf: string, content: string | Uint8Array) => replaceLeafAtomicWithin(confineRoot, leaf, content),
  readLeafTextNoFollow: (leaf: string) => readLeafTextNoFollow(leaf),
});

/**
 * The RAW local I/O best-effort replay, quarantine and strict recovery ask for,
 * beyond restoration: one directory listing and the two quarantine moves. Each
 * REJECTS raw; none checks an identity, follows a policy or decides anything.
 */
export interface JournalReplayIo extends JournalRestoreIo {
  /** The names directly in `dir`, in the order the store returns them. REJECTS raw. Disk: `listDirectoryNames(dir)`. */
  listDirectoryNames(dir: string): Promise<string[]>;
  /** `dir` and any missing parents. REJECTS raw. Disk: `makeDirectoryTree(dir)`. */
  makeDirectoryTree(dir: string): Promise<void>;
  /** Move `from` to `to` BY PATH: no identity check, an existing `to` is REPLACED. REJECTS raw. Disk: `renameLeafUnguarded`. */
  renameLeafUnguarded(from: string, to: string): Promise<void>;
}

/** LOCAL DISK. Restoration's members plus three incumbent unguarded primitives; frozen. In no package index. */
export const diskJournalReplayIo: JournalReplayIo = Object.freeze({
  ...diskJournalRestoreIo,
  listDirectoryNames: (dir: string) => listDirectoryNames(dir),
  makeDirectoryTree: (dir: string) => makeDirectoryTree(dir),
  renameLeafUnguarded: (from: string, to: string) => renameLeafUnguarded(from, to),
});

/**
 * Where replay's diagnostics go: a SEPARATE port, REQUIRED by every bound replay
 * body, never a member of the storage contract. The root forms pass the
 * incumbent `note` from `../utils/output.ts`, read at call time.
 */
export type JournalNote = (message: string) => void;
