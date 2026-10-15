/**
 * @file src/storage/legacy-local-records.ts
 * @description The LEGACY-COMPATIBILITY RECORD BINDING an ordinary,
 * unregistered local wiki reads and writes its small persisted records
 * through. The compile state (`.llmwiki/state.json`) is its first user.
 *
 * It is the write-capable sibling of {@link LegacyLocalReads}
 * (`./legacy-local-reads.ts`) and follows the same rule: each method is ONE
 * incumbent primitive over a project-relative path in today's on-disk layout,
 * owning that primitive's existing mechanics and safety behaviour, including
 * what it rejects with. It adds no NEW behaviour. What a missing, unreadable,
 * corrupt or too-new record MEANS, when a backup is taken, what is warned and
 * what is serialized are all decided by the record's own module above it.
 *
 * It is deliberately NOT the managed store contract. A registered or hosted
 * project publishes through `ProjectStore` (`src/portable/store/store.ts`),
 * with operation records, receipts and a publication protocol. This binding
 * carries none of that: no ledger, no intent, no recovery of its own. Nothing
 * hosted implements it.
 */

/** The record I/O an ordinary local project's persisted records are built from. */
export interface LegacyLocalRecords {
  /** Whether the path resolves, following links. Never rejects. */
  exists(relPath: string): Promise<boolean>;
  /**
   * A record's whole text as UTF-8, read WITHOUT following a link at the leaf
   * and only from a regular file. Rejects when it cannot be read that way.
   */
  readTextNoFollow(relPath: string): Promise<string>;
  /**
   * Copy one file's bytes over another path, replacing it. Rejects when it cannot.
   * It FOLLOWS a symbolic link at the source and at the destination, exactly as
   * the incumbent call does, and applies no confinement: a linked source has its
   * target's bytes copied, and a linked destination is written through. Unlike
   * the no-follow read and the confined atomic write beside it, this method
   * gives no safety guarantee of its own.
   */
  copy(fromRelPath: string, toRelPath: string): Promise<void>;
  /**
   * Replace a record with `text` so a reader sees the old or the new content,
   * never a partial one, and so the write cannot land outside the project.
   */
  writeAtomic(relPath: string, text: string): Promise<void>;
  /** Where an operator would find the path; for messages that name one. */
  locate(relPath: string): string;
}
