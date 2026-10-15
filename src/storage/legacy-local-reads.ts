/**
 * @file src/storage/legacy-local-reads.ts
 * @description The LEGACY-COMPATIBILITY READ BINDING an ordinary, unregistered
 * local wiki reads its content and configuration through.
 *
 * The compile used to import `fs` at each place it read a source, a page, the
 * schema or the project configuration. {@link LegacyLocalReads} names those
 * reads once. Each method is ONE incumbent primitive over a project-relative
 * path in today's on-disk layout, and it owns that primitive's existing
 * mechanics and safety behaviour, including what it rejects with. It adds no
 * NEW behaviour: no error is normalized, no default is supplied for an absent
 * path and no confinement rule is introduced. Every catch, lookup order,
 * default and warning stays in the caller that had it before.
 *
 * This is deliberately NOT the managed store contract. A hosted or registered
 * project is published through `ProjectStore` / `ReadView`
 * (`src/portable/store/store.ts`), which deal in logical object paths, return
 * bytes or `null`, list sorted, and carry labels, receipts and a publication
 * protocol. This binding keeps exactly what that contract normalizes away:
 * physical layout paths, the backend's listing order, each call's own link
 * behaviour and raw errors. Nothing hosted implements it.
 */

/** What a directory entry is, without following a link. */
export type LocalEntryKind = "file" | "directory" | "link" | "other";

/** One entry of a directory listing. */
export interface LocalEntry {
  name: string;
  kind: LocalEntryKind;
}

/** A directory that was verified to be a real directory, and listings beneath it. */
export interface LocalDirectory {
  /**
   * Entries of the directory itself (`""`) or of a `/`-joined path beneath it,
   * in the backend's listing order. Rejects when that path cannot be listed.
   */
  listEntries(relative: string): Promise<LocalEntry[]>;
}

/** A confined read: the text, or a short machine-readable reason and NO bytes. */
export type ConfinedReadResult = { content: string } | { dropped: string };

/** Every content and configuration read an ordinary local project makes. */
export interface LegacyLocalReads {
  /** A file's whole text as UTF-8, following links. Rejects when it cannot be read. */
  readText(relPath: string): Promise<string>;
  /** Whether the path resolves, following links. Never rejects. */
  exists(relPath: string): Promise<boolean>;
  /** What is at the path WITHOUT following a final link. Rejects when nothing is there. */
  statNoFollow(relPath: string): Promise<LocalEntryKind>;
  /** Entry names of a directory in the backend's listing order. Rejects when it cannot be listed. */
  listNames(relDir: string): Promise<string[]>;
  /**
   * The directory, only when the project resolves and the directory is itself
   * a real directory rather than a link or another kind of entry; otherwise
   * `null`. Listings through the result stay anchored where it resolved.
   */
  realDirectory(relDir: string): Promise<LocalDirectory | null>;
  /** `<relDir>/<slug>.md`, only when it resolves inside `relDir`. */
  readConfinedPage(relDir: string, slug: string): Promise<ConfinedReadResult>;
  /** One file, only when it resolves inside its own parent directory. */
  readConfinedFile(relPath: string): Promise<ConfinedReadResult>;
  /** Where an operator would find the path; for messages that name one. */
  locate(relPath: string): string;
}

/**
 * The outcome of a bounded, confined read. `ok` carries the whole text.
 * `absent` is a POSITIVE answer: the binding could vouch for the place the
 * file would be in the project, and no file is there. `unavailable` is every
 * other case, INCLUDING a project that cannot be resolved, a place that could
 * not be vouched for, something that is not a regular file, more than the cap,
 * and text that is not valid UTF-8. Neither refusal carries any bytes.
 */
export type CappedTextRead = { kind: "ok"; body: string } | { kind: "absent" } | { kind: "unavailable" };

/**
 * Bounded reads an ordinary local project serves from a PROJECT-RELATIVE path.
 *
 * Kept apart from {@link LegacyLocalReads} so that binding's existing
 * implementations are untouched. Like that binding it is the internal legacy
 * local binding: NOT `ProjectStore`, and not a hosted or public contract. It
 * decides nothing about who may read: the caller owns the id rule, any
 * allowlist, any loopback gate and every trust decision about the result.
 */
export interface LegacyLocalCappedReads {
  /**
   * The file at `relPath`, relative to the project, as text of at most
   * `maxBytes` bytes; see {@link CappedTextRead} for the three outcomes.
   */
  readCappedText(relPath: string, maxBytes: number): Promise<CappedTextRead>;
}

/**
 * One entity directory that {@link LegacyLocalEntityScans} found at its exact
 * expected place. Each method is ONE incumbent read, with no cap, sort, filter
 * or decoding choice of its own.
 *
 * An ENTRY LOCATOR is the string `resolveEntry` hands back and the two reads
 * take. On disk it is the entry's ABSOLUTE RESOLVED PATH, and callers of the
 * scan depend on that: they report it as a page's `filePath`, key sets by it
 * and take its basename. A link inside the directory therefore yields its
 * target's locator. Nothing is checked again between resolving an entry and
 * reading it.
 */
export interface LocalEntityDirectory {
  /** Entry names in the backend's listing order. REJECTS raw when the directory cannot be listed. */
  listNames(): Promise<string[]>;
  /** The locator of the named entry, only when it resolves inside this directory; otherwise `null`. Never rejects. */
  resolveEntry(name: string): Promise<string | null>;
  /**
   * At most `maxBytes` leading bytes of a resolved entry, from ONE read that is
   * not topped up. A Node `Buffer`, kept because that is what the scan already
   * decodes and measures; a plain byte array would have served. REJECTS raw.
   */
  readPrefix(entry: string, maxBytes: number): Promise<Buffer>;
  /** The whole entry decoded as UTF-8 LENIENTLY: invalid bytes become replacement characters. REJECTS raw. */
  readText(entry: string): Promise<string>;
}

/**
 * What opening an entity directory found. `ok` lends the directory. `missing`
 * means nothing is at the expected place. `invalid` means the project could
 * not be resolved, or something is there that does not resolve to exactly the
 * expected place (a linked directory, even one that stays inside the project).
 */
export type EntityDirectoryOpen =
  | { status: "ok"; directory: LocalEntityDirectory }
  | { status: "missing" }
  | { status: "invalid" };

/**
 * The directory scans an ordinary local project serves: the reads behind the
 * shared entity scan (`scanEntityDir`).
 *
 * PHYSICAL AND LEGACY, like the bindings above, and kept apart from
 * {@link LegacyLocalReads} so that binding's implementations are untouched. It
 * is internal: NOT `ProjectStore`, and not a hosted, public or access-control
 * contract. The scan keeps every decision about content: which names are
 * pages, the prefix cap and when to fall back to the whole entry, what a
 * failed listing or read means, and all parsing.
 */
export interface LegacyLocalEntityScans {
  /**
   * Open the entity directory at `relDir`, relative to the project and used
   * EXACTLY as the caller spells it. Never rejects: every failure is `missing`
   * or `invalid`.
   */
  openEntityDirectory(relDir: string): Promise<EntityDirectoryOpen>;
}
