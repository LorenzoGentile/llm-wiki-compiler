/**
 * @file Collision policy for OKF import (v1: skip + warn, never overwrite). A mapped
 * slug clashes with an existing live page, a pending review candidate, or an earlier
 * doc in the same import. First (path-sorted) wins; later clashes are dropped.
 *
 * {@link filterCollisions} handles the untyped concepts/queries leg; the CLP-7.6
 * typed leg ({@link filterTypedCollisionsFrom}) applies the SAME first-wins policy over
 * the `wiki/<entityType>/<slug>.md` namespace and typed pending candidates.
 *
 * ONE BODY EACH, over {@link OkfCollisionSources}: the existing candidate
 * directory port (each leg lists the pending queue ONCE, through the store's own
 * reader) and a raw accessibility probe for the live page paths. Every choice
 * (first-wins, the reason order, the fallback pass-through) is the body's.
 */
import path from "path";
import { locationAccessible } from "../storage/disk-bundle-tree.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { listCandidatesFrom } from "../compiler/candidate-read.js";
import type { MappedOkfPage, MappedTypedOkfDoc, TypedImportOutcome } from "./types.js";

/** A dropped doc + why, for caller reporting. */
export interface SkippedOkfPage { slug: string; okfPath: string; reason: "live-page" | "pending-candidate" | "duplicate-in-bundle"; }

/** Everything the collision bodies read: the candidate store's directory port and a raw accessibility probe. */
export interface OkfCollisionSources {
  /** The pending candidate store, read through its own reader. */
  candidates: LegacyLocalRecordDirs;
  /** Resolves when the path resolves to anything (links followed); REJECTS otherwise. */
  accessible(location: string): Promise<void>;
}

/** LOCAL DISK. The collision sources for the project at `root`. Building them does no I/O. In no package index. */
export function diskOkfCollisionSources(root: string): OkfCollisionSources {
  return { candidates: diskLocalRecordDirs(root), accessible: locationAccessible };
}

async function fileExists(sources: OkfCollisionSources, p: string): Promise<boolean> {
  try { await sources.accessible(p); return true; } catch { return false; }
}

/** Partition mapped pages into those safe to import and those skipped for a collision. */
export async function filterCollisions(
  root: string,
  pages: MappedOkfPage[],
): Promise<{ kept: MappedOkfPage[]; skipped: SkippedOkfPage[] }> {
  return filterCollisionsFrom(diskOkfCollisionSources(root), root, pages);
}

/** {@link filterCollisions} over {@link OkfCollisionSources}: THE ONE BODY. */
export async function filterCollisionsFrom(
  sources: OkfCollisionSources,
  root: string,
  pages: MappedOkfPage[],
): Promise<{ kept: MappedOkfPage[]; skipped: SkippedOkfPage[] }> {
  const pendingSlugs = new Set((await listCandidatesFrom(sources.candidates)).map((c) => c.slug));
  const claimed = new Set<string>();
  const kept: MappedOkfPage[] = [];
  const skipped: SkippedOkfPage[] = [];
  for (const page of pages) {
    let reason: SkippedOkfPage["reason"] | null = null;
    if (claimed.has(page.slug)) reason = "duplicate-in-bundle";
    else if (pendingSlugs.has(page.slug)) reason = "pending-candidate";
    else if (await fileExists(sources, path.join(root, CONCEPTS_DIR, `${page.slug}.md`)) ||
             await fileExists(sources, path.join(root, QUERIES_DIR, `${page.slug}.md`))) reason = "live-page";
    if (reason) {
      skipped.push({ slug: page.slug, okfPath: page.okfPath, reason });
    } else { claimed.add(page.slug); kept.push(page); }
  }
  return { kept, skipped };
}

/** The full typed target key (`<entityType>/<slug>`) two docs/candidates collide on. */
function typedKey(entityType: string, slug: string): string {
  return `${entityType}/${slug}`;
}

/** The typed collision reason for a doc, or `null` when it is safe to import. */
async function typedSkipReason(
  sources: OkfCollisionSources,
  root: string,
  doc: MappedTypedOkfDoc & { entityType: string; directory: string },
  claimed: Set<string>,
  pendingKeys: Set<string>,
): Promise<TypedImportOutcome["reason"] | null> {
  const key = typedKey(doc.entityType, doc.slug);
  if (claimed.has(key)) return "duplicate-in-bundle";
  if (pendingKeys.has(key)) return "pending-candidate";
  if (await fileExists(sources, path.join(root, doc.directory, `${doc.slug}.md`))) return "live-page";
  return null;
}

/**
 * Partition typed docs into those safe to stage and those skipped for a collision,
 * applying the SAME first-wins policy as {@link filterCollisionsFrom} over the typed
 * `wiki/<entityType>/<slug>.md` namespace: skip when a live typed page exists at
 * that path, a pending review candidate already targets that `entityType`+`slug`,
 * or an earlier doc in this bundle already claimed it. A FALLBACK doc (no declared
 * `entityType`) is never typed-collision-checked here — it stages untyped, where
 * `writeCandidate` dedups on its own target key — so it always passes through.
 *
 * THE ONE BODY, over {@link OkfCollisionSources}, and its only form: its one
 * caller, the import orchestration, hands it the sources (the root-taking form
 * had no other importer).
 *
 * @param sources - The candidate store and the live-page probe.
 * @param root - Absolute project root directory.
 * @param typed - The typed docs mapped from this bundle.
 * @returns The docs kept for staging and the collision-skip outcomes.
 */
export async function filterTypedCollisionsFrom(
  sources: OkfCollisionSources,
  root: string,
  typed: MappedTypedOkfDoc[],
): Promise<{ kept: MappedTypedOkfDoc[]; skipped: TypedImportOutcome[] }> {
  const pending = await listCandidatesFrom(sources.candidates);
  const pendingKeys = new Set(
    pending.filter((c) => c.targetEntityType).map((c) => typedKey(c.targetEntityType!, c.slug)),
  );
  const claimed = new Set<string>();
  const kept: MappedTypedOkfDoc[] = [];
  const skipped: TypedImportOutcome[] = [];
  for (const doc of typed) {
    if (doc.entityType === undefined || doc.directory === undefined) { kept.push(doc); continue; }
    const declared = doc as MappedTypedOkfDoc & { entityType: string; directory: string };
    const reason = await typedSkipReason(sources, root, declared, claimed, pendingKeys);
    if (reason) {
      skipped.push({ okfPath: doc.okfPath, slug: doc.slug, entityType: doc.entityType, outcome: "skipped", reason });
    } else { claimed.add(typedKey(doc.entityType, doc.slug)); kept.push(doc); }
  }
  return { kept, skipped };
}
