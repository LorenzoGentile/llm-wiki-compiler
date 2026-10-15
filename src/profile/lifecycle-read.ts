/**
 * @file src/profile/lifecycle-read.ts
 * @description Path-confined readers for a typed entity page: the PREVIOUS
 * lifecycle-field value the runtime transition validator
 * ({@link validateLifecycleTransition}) checks a write against, the confined page
 * path resolver the live-apply paths share, and the handle-bound frontmatter
 * reader the relation-precondition endpoint resolver uses as evidence input.
 *
 * A lifecycle transition is "from the value already on disk to the value in the
 * incoming body". This module supplies that prior value: it resolves the existing
 * `wiki/<entityType>/<slug>.md` through the SAME confined-regular-file primitive
 * the source/wiki readers use ({@link confinedRegularFile}), so a symlinked or
 * escaping page is treated as absent rather than followed. When the page does not
 * yet exist (a create) it returns `undefined`, which the validator treats as "not
 * a transition".
 *
 * ONE BODY for the frontmatter read: {@link readConfinedEntityFrontmatter} runs
 * {@link readConfinedEntityFrontmatterFrom} over local-disk
 * {@link EntityPageReads}. What a page that cannot be read, is not there, or
 * carries malformed frontmatter MEANS is decided in that body; the read only
 * looks. The confined path resolver above it still takes the root.
 *
 * ONE BODY for the previous-state read too: {@link readPrevLifecycleStateFrom}
 * over {@link PrevLifecyclePageReads}, whose local members are the two physical
 * calls the write side always made — {@link resolveConfinedEntityPage}, then a
 * `safeReadFile` that answers `""` for ANY read failure. That is deliberately NOT
 * {@link EntityPageReads}: the hardened endpoint read tells unreadable and
 * malformed apart, and the previous-state read never has.
 */

import path from "path";
import { confinedRegularFile, safeRealpath } from "../utils/path-confine.js";
import { readConfinedPageOutcome, type ConfinedPageRead } from "../utils/confined-read.js";
import { parseFrontmatter, parseFrontmatterStatus } from "../utils/markdown.js";
import type { EntityTypeDef } from "./types.js";

/**
 * The two physical looks the previous-state read takes. No member takes a
 * project root, and neither carries meaning: parsing and the field choice stay
 * in {@link readPrevLifecycleStateFrom}.
 */
export interface PrevLifecyclePageReads {
  /** The confined real path of the entity page, or `null` when absent or escaping. Local: `resolveConfinedEntityPage(root, def, slug)`. */
  resolvePage(def: EntityTypeDef, slug: string): Promise<string | null>;
  /** The page text at `real`; `""` on ANY read failure. Local: `safeReadFile(real)`. */
  readPage(real: string): Promise<string>;
}

/**
 * Read the previous lifecycle-field value of an entity page, or `undefined` when
 * the page does not exist (a create) or carries no string value for the
 * lifecycle field. Locally the page is resolved under `<root>/<def.directory>`
 * via {@link confinedRegularFile}, so a symlinked / out-of-tree page is treated
 * as absent (returns `undefined`) — never followed. THE ONE BODY.
 *
 * @param reads - The resolve-then-read looks.
 * @param def - The resolved entity type definition (supplies the directory).
 * @param slug - The page slug (the filename stem).
 * @param field - The lifecycle field name whose prior value is read.
 * @returns The prior lifecycle-field value as a string, or `undefined`.
 */
export async function readPrevLifecycleStateFrom(
  reads: PrevLifecyclePageReads,
  def: EntityTypeDef,
  slug: string,
  field: string,
): Promise<string | undefined> {
  const real = await reads.resolvePage(def, slug);
  if (real === null) return undefined;
  const { meta } = parseFrontmatter(await reads.readPage(real));
  const value = meta[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Resolve an entity page's confined real path: `<realpath(root)>/<def.directory>/<slug>.md`
 * via {@link confinedRegularFile}, or `null` when the page is absent or escapes
 * the project root (a symlinked / out-of-tree page is treated as absent — never
 * followed). The root is canonicalized FIRST so the directory base matches the
 * file's realpath (on macOS a temp/symlinked root would otherwise fail
 * confinement and spuriously report "no page"). Shared by the prev-state read and
 * the lifecycle-transition read so both confine identically.
 *
 * @param root - Absolute project root.
 * @param def - The resolved entity type definition (supplies the directory).
 * @param slug - The page slug (the filename stem).
 * @returns The confined real path, or `null` when the page is absent/escaping.
 */
export async function resolveConfinedEntityPage(
  root: string,
  def: EntityTypeDef,
  slug: string,
): Promise<string | null> {
  const dir = await confinedEntityDir(root, def);
  return confinedRegularFile(dir, `${slug}.md`);
}

/** The canonical confined directory of an entity type: `<realpath(root)>/<def.directory>`. */
async function confinedEntityDir(root: string, def: EntityTypeDef): Promise<string> {
  const canonicalRoot = (await safeRealpath(root)) ?? path.resolve(root);
  return path.join(canonicalRoot, def.directory);
}

/**
 * The discriminated outcome of {@link readConfinedEntityFrontmatter}: parsed
 * `frontmatter`, a clean `absent` (page not there / escaping / symlinked / open-
 * raced / MALFORMED YAML — none of which are trusted evidence), or `unreadable`
 * (a raw I/O fault — "cannot verify" rather than "does not qualify"). The split
 * lets the endpoint resolver PARK a healthy run on a transient read fault instead
 * of miscounting it as an unmet precondition.
 */
export type EntityFrontmatterRead =
  | { kind: "frontmatter"; meta: Record<string, unknown> }
  | { kind: "absent" }
  | { kind: "unreadable"; cause: NodeJS.ErrnoException };

/**
 * The one look the frontmatter reader takes at an entity page. OWNED BY THIS
 * READER: a narrow seam with one disk implementation; not `ProjectStore`, not a
 * hosted or access-control contract, and it selects no backend. It carries NO
 * meaning: parsing, "malformed is absent" and every use of the result stay with
 * the caller.
 */
export interface EntityPageReads {
  /**
   * The page `<slug>.md` of the entity directory `directory` (relative to the
   * project, as the profile spells it): its text, `absent` (not there, or not
   * provably the regular file at its confined place), or `unreadable` with the
   * raw I/O fault. Never rejects for those.
   */
  readEntityPage(directory: string, slug: string): Promise<ConfinedPageRead>;
}

/**
 * LOCAL DISK. The entity-page look for the project at `root`. Building it does
 * no I/O and no path work. The look is the three calls the reader always made,
 * in the same order: the canonical entity directory, the confined regular-file
 * look, then the handle-bound no-follow page read. In no package index.
 */
export function diskEntityPageReads(root: string): EntityPageReads {
  return {
    readEntityPage: async (directory, slug) => {
      const canonicalRoot = (await safeRealpath(root)) ?? path.resolve(root);
      const dir = path.join(canonicalRoot, directory);
      const real = await confinedRegularFile(dir, `${slug}.md`);
      if (real === null) return { kind: "absent" };
      return readConfinedPageOutcome(real, dir);
    },
  };
}

/**
 * Read + parse the FRONTMATTER of a confined entity page as a discriminated
 * {@link EntityFrontmatterRead}. The path resolves via {@link confinedRegularFile}
 * and the bytes come from the handle-bound, no-follow {@link readConfinedPageOutcome}
 * (the shared hardened single-page read), so a symlinked or open-raced page fails
 * CLOSED to `absent` rather than leaking an out-of-tree read, while a genuine I/O
 * fault surfaces as `unreadable`. MALFORMED frontmatter is `absent` (fail closed:
 * a page whose YAML cannot be parsed must not qualify as evidence via a coerced-
 * empty `{}` meta). LOCK-FREE — a bare confined read, safe inside a caller's
 * already-held project lock.
 *
 * @param root - Absolute project root.
 * @param def - The resolved entity type definition (supplies the directory).
 * @param slug - The page slug (the filename stem).
 * @returns The discriminated read outcome.
 */
export async function readConfinedEntityFrontmatter(
  root: string,
  def: EntityTypeDef,
  slug: string,
): Promise<EntityFrontmatterRead> {
  return readConfinedEntityFrontmatterFrom(diskEntityPageReads(root), def, slug);
}

/**
 * {@link readConfinedEntityFrontmatter} over {@link EntityPageReads}: THE ONE
 * BODY. One look at the page; an unreadable page keeps its cause, an absent one
 * and one whose frontmatter is malformed are both `absent`.
 */
export async function readConfinedEntityFrontmatterFrom(
  pages: EntityPageReads,
  def: EntityTypeDef,
  slug: string,
): Promise<EntityFrontmatterRead> {
  const read = await pages.readEntityPage(def.directory, slug);
  if (read.kind === "unreadable") return { kind: "unreadable", cause: read.cause };
  if (read.kind === "absent") return { kind: "absent" };
  const parsed = parseFrontmatterStatus(read.body);
  return parsed.malformedFrontmatter ? { kind: "absent" } : { kind: "frontmatter", meta: parsed.meta };
}
