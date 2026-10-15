/**
 * @file src/storage/legacy-local-record-dirs.ts
 * @description The LEGACY-COMPATIBILITY RECORD-DIRECTORY BINDING an ordinary,
 * unregistered local wiki resolves and reads a directory of record leaves
 * through. The pending review-candidate queue's tolerant reads are its first
 * user.
 *
 * It is a sibling of {@link LegacyLocalReads} (`./legacy-local-reads.ts`) and
 * `LegacyLocalRecords` (`./legacy-local-records.ts`) and follows the same rule:
 * each method is an incumbent primitive, or an incumbent compound sequence
 * moved unchanged, owning its existing mechanics and safety behaviour,
 * including what it rejects with. It adds no NEW behaviour.
 *
 * Resolution and reading are TWO steps on purpose. Callers let a resolution
 * failure propagate but decide for themselves what a failed read means
 * (absent, skipped, or an error), so the binding must never fold a resolution
 * failure into a read result.
 *
 * It is READ-ONLY and carries no custody: no file identity, no handle, no
 * receipt, no write, rename or delete. The guarded candidate mutations and the
 * bounded mutation enumeration do not go through it. Its listing is the
 * tolerant listing only.
 *
 * It is deliberately NOT the managed store contract. A registered or hosted
 * project holds proposals as operation records behind `ProjectStore`
 * (`src/portable/store/store.ts`). This binding exposes today's physical queue
 * layout to the local path only. Nothing hosted implements it.
 */

import type { LocalEntry } from "./legacy-local-reads.js";

/** A directory of record leaves that resolved inside the project. */
export interface LocalRecordDirectory {
  /** Whether the resolved directory still exists, following links. Never rejects. */
  exists(): Promise<boolean>;
  /** Its entries with their kinds, in the backend's listing order. Rejects with the backend's error. */
  listEntries(): Promise<LocalEntry[]>;
}

/** One leaf whose location was confined inside the project when it was resolved. */
export interface LocalRecordLeaf {
  /** Where the leaf is, for callers and messages that still hold a path. */
  readonly location: string;
  /** Its whole text as UTF-8, following links. Rejects with the backend's error. */
  readText(): Promise<string>;
}

/** Resolution of, and tolerant reads beneath, an ordinary local project's record directories. */
export interface LegacyLocalRecordDirs {
  /**
   * The directory when every component from the project root resolves inside
   * the project and is a directory; `null` when a component is absent. Rejects
   * with the store's typed unsafe-directory error otherwise.
   */
  directory(relDir: string): Promise<LocalRecordDirectory | null>;
  /**
   * The leaf `<relDir>/<fileName>`, after the same directory check and after
   * confining its location under the project. Rejects with the typed
   * unsafe-directory error when either fails. Does not read the leaf.
   */
  leaf(relDir: string, fileName: string): Promise<LocalRecordLeaf>;
}
