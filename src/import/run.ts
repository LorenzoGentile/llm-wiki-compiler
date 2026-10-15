// src/import/run.ts
/**
 * @file Output-free OKF import core shared by CLI/SDK/MCP: read→map→collision→validate→stage/write/preview, returning a structured report. Owns the .llmwiki lock.
 *
 * THE DRY-RUN PREVIEW HAS ONE BODY, {@link previewOkfImportFrom}, over raw sources
 * ({@link OkfImportPreviewSources}): the import intake's sources and the effective
 * profile's sources for the bundle-profile comparison. It takes no lock and writes
 * nothing.
 *
 * THE APPLYING LEG HAS ONE BODY TOO, {@link applyOkfImportWith}, over
 * {@link OkfApplySteps}, none of which takes a project root: the quiet lock, the
 * queue-capacity refusal, the per-page stage or write (with the partial-success
 * refresh in a `finally`), the typed and relation legs, the promoted-typed refresh
 * and the report are decided there. {@link runOkfImport} hands it the disk steps,
 * which call the incumbent root forms with their old arguments.
 */
import path from "path";
import { diskOkfImportSources, importOkfBundle, importOkfBundleFrom, type OkfImportSources } from "./okf-import.js";
import { diskEffectiveProfileSources, type EffectiveProfileSources } from "../profile/load.js";
import { isWritable } from "../commands/import-core.js"; // leaf created in Task 4 Step 0
import { writeCandidate, listCandidates } from "../compiler/candidates.js";
import { atomicWrite } from "../utils/markdown.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { qualifiedPageId, type PageId } from "../utils/page-id.js";
import { refreshAfterImport } from "./okf-refresh.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { withQuiet } from "../utils/output.js";
import { LockUnavailableError, QueueFullError } from "./run-errors.js";
import { buildBundleSections, buildBundleSectionsFrom, type BundleReportSections, type ParsedBundleBlock } from "./bundle-block-read.js";
import { applyTypedDocs, previewTypedOutcomes } from "./profile-import.js";
import { applyBundleRelations, inertRelationOutcomes, type RelationImportOutcome } from "./relation-import.js";
import type { ImportedOkfBundle } from "./okf-import.js";
import type { MappedOkfPage, MappedTypedOkfDoc, TypedImportOutcome } from "./types.js";
import type { CandidateDraft } from "../compiler/candidates.js";
import type { BundleRelationEntry } from "../export/okf/bundle-block.js";
import type { ProfilePack } from "../profile/types.js";

export interface OkfImportSkip { slug: string; okfPath: string; reason: "live-page" | "pending-candidate" | "duplicate-in-bundle" | "invalid-page"; }
export interface OkfImportedPage { slug: string; okfPath: string; targetDirectory: "concepts" | "queries"; }
export interface OkfImportReport extends BundleReportSections {
  mode: "staged" | "written" | "dry-run";
  pages: OkfImportedPage[];
  skipped: OkfImportSkip[];
  warnings: string[];
  /**
   * Per-doc outcomes of the TYPED profile-entity leg (CLP 7.6): typed staging /
   * planner promotion / mismatch-fallback / collision skip. OMITTED (key absent)
   * when the bundle contributes no typed docs, so a default-profile import's
   * report stays byte-identical (D-7.6.10 parity).
   */
  typed?: TypedImportOutcome[];
  /**
   * Per-entry outcomes of the bundle-RELATION leg (CLP 7.6, D-7.6.6): trusted
   * apply through the validated store (`imported`/`deduplicated`/`skipped-invalid`),
   * or an inert `skipped-untrusted`/`skipped-no-profile`/`skipped-dry-run`. OMITTED
   * when the bundle carries no relations, so default-profile parity holds.
   */
  relationOutcomes?: RelationImportOutcome[];
  nextAction?: string;
}
export interface OkfImportOptions { trusted?: boolean; dryRun?: boolean; maxNewCandidates?: number; }

/**
 * Everything the applying leg touches, none taking a project root. Each is one
 * call; the order, the refusals and the report are {@link applyOkfImportWith}'s.
 */
export interface OkfApplySteps {
  /** Take the host mutation lock (false when another run holds it). */
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  /** The import intake over the operator-named bundle `dir`. */
  importBundle(dir: string, onWarn: (message: string) => void): Promise<ImportedOkfBundle>;
  /** The pending review candidates (only their count is read). */
  listCandidates(): Promise<readonly unknown[]>;
  writeCandidate(draft: CandidateDraft): Promise<unknown>;
  /** Write one live page at a project-relative path (e.g. `wiki/concepts/foo.md`). */
  writePage(relativePath: string, body: string): Promise<void>;
  /** The post-import refresh over the given pages. */
  refresh(pageIds: PageId[]): Promise<void>;
  applyTyped(typed: MappedTypedOkfDoc[], profile: ProfilePack, trusted: boolean): Promise<TypedImportOutcome[]>;
  bundleSections(block: ParsedBundleBlock): Promise<BundleReportSections>;
  applyRelations(profile: ProfilePack, entries: BundleRelationEntry[], trusted: boolean): Promise<RelationImportOutcome[]>;
}

/** LOCAL DISK. The apply steps for the project at `root`: the incumbent root forms, old arguments. */
function diskOkfApplySteps(root: string): OkfApplySteps {
  return {
    acquireLock: () => acquireMutationLock(root, "ordinary"),
    releaseLock: () => releaseLock(root),
    importBundle: (dir, onWarn) => importOkfBundle(dir, root, {}, onWarn),
    listCandidates: () => listCandidates(root),
    writeCandidate: (draft) => writeCandidate(root, draft),
    writePage: (relativePath, body) => atomicWrite(path.join(root, relativePath), body),
    refresh: (pageIds) => refreshAfterImport(root, pageIds),
    applyTyped: (typed, profile, trusted) => applyTypedDocs(root, typed, profile, trusted),
    bundleSections: (block) => buildBundleSections(root, block),
    applyRelations: (profile, entries, trusted) => applyBundleRelations(root, profile, entries, trusted),
  };
}

const toImported = (p: MappedOkfPage): OkfImportedPage => ({ slug: p.slug, okfPath: p.okfPath, targetDirectory: p.targetDirectory });

/** Partition mapped pages (single pass) + assemble the skip list (collisions ∪ invalid). */
function partition(pages: MappedOkfPage[], collisionSkips: OkfImportSkip[]): { valid: MappedOkfPage[]; skipped: OkfImportSkip[] } {
  const valid: MappedOkfPage[] = [];
  const invalid: OkfImportSkip[] = [];
  for (const p of pages) {
    if (isWritable(p)) valid.push(p);
    else invalid.push({ slug: p.slug, okfPath: p.okfPath, reason: "invalid-page" });
  }
  return { valid, skipped: [...collisionSkips, ...invalid] };
}

async function stageAll(steps: OkfApplySteps, valid: MappedOkfPage[]): Promise<void> {
  for (const page of valid) {
    await steps.writeCandidate({
      title: page.title, slug: page.slug, summary: page.summary, sources: page.sources, body: page.body,
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
      targetDirectory: page.targetDirectory, okfPath: page.okfPath,
    });
  }
}

async function writeAll(steps: OkfApplySteps, valid: MappedOkfPage[]): Promise<void> {
  // The namespace IS the targetDirectory basename ("concepts" / "queries"), so a
  // concept `foo` and a query `foo` imported together invalidate independently.
  const written: PageId[] = [];
  try {
    for (const page of valid) {
      const dir = page.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
      await steps.writePage(path.join(dir, `${page.slug}.md`), page.body);
      written.push(qualifiedPageId(page.targetDirectory, page.slug));
    }
  } finally {
    if (written.length) await steps.refresh(written);
  }
}

/** Wrap typed-leg outcomes into the report's optional `typed` key, OMITTING it when empty (default parity). */
function typedSection(outcomes: TypedImportOutcome[]): { typed?: TypedImportOutcome[] } {
  return outcomes.length > 0 ? { typed: outcomes } : {};
}

/**
 * Build the report's optional `relationOutcomes` (CLP 7.6 Task 5). OMITTED (parity)
 * when the bundle carries no relations. A default project (no active profile) reports
 * `skipped-no-profile`; a dry-run reports `skipped-dry-run` (no writes, no simulated
 * validation); otherwise relations apply through the validated store under the held
 * lock (untrusted → `skipped-untrusted`, D-7.6.6). No-profile precedes dry-run: a
 * default project can never apply relations, so it is the honest permanent status.
 */
async function relationSection(
  steps: Pick<OkfApplySteps, "applyRelations">, imported: ImportedOkfBundle, opts: OkfImportOptions,
): Promise<{ relationOutcomes?: RelationImportOutcome[] }> {
  const entries = imported.bundleBlock?.relations ?? [];
  if (entries.length === 0) return {};
  if (imported.profile === undefined) return { relationOutcomes: inertRelationOutcomes(entries, "skipped-no-profile") };
  if (opts.dryRun) return { relationOutcomes: inertRelationOutcomes(entries, "skipped-dry-run") };
  return { relationOutcomes: await steps.applyRelations(imported.profile.profile, entries, opts.trusted ?? false) };
}

/**
 * Re-run the post-import refresh over PROMOTED typed pages (CLP 7.6): the earlier
 * {@link writeAll} refresh covers only the untyped concepts/queries leg, which runs
 * BEFORE the typed promotion, so a freshly-promoted `wiki/<entityType>/<slug>.md`
 * would otherwise miss the index/MOC/link/embedding refresh. Idempotent (index/MOC
 * regenerate wholesale); a no-op when nothing promoted (untrusted / default-profile).
 */
async function refreshPromotedTyped(steps: OkfApplySteps, applied: TypedImportOutcome[]): Promise<void> {
  const promoted = applied.filter((o) => o.outcome === "promoted-typed" && o.entityType !== undefined);
  if (promoted.length === 0) return;
  await steps.refresh(promoted.map((o) => qualifiedPageId(o.entityType!, o.slug)));
}

/** Assert the untrusted candidate-queue cap counts native + typed candidates together (CLP 7.6). */
async function assertQueueCapacity(steps: OkfApplySteps, imported: ImportedOkfBundle, validCount: number, opts: OkfImportOptions): Promise<void> {
  if (opts.maxNewCandidates === undefined || opts.trusted) return;
  const pending = (await steps.listCandidates()).length;
  if (pending + validCount + imported.typed.length > opts.maxNewCandidates) throw new QueueFullError();
}

/** Everything {@link previewOkfImportFrom} reads: the import intake's sources and the effective profile's sources. */
export interface OkfImportPreviewSources {
  import: OkfImportSources;
  /** The local profile, loaded again (a separate snapshot) only when the bundle declares a profile. */
  profile: EffectiveProfileSources;
}

/** LOCAL DISK. The preview sources for the project at `root`. Building them does no I/O. In no package index. */
function diskOkfImportPreviewSources(root: string): OkfImportPreviewSources {
  return { import: diskOkfImportSources(root), profile: diskEffectiveProfileSources(root) };
}

/**
 * The dry-run leg of {@link runOkfImport}: THE ONE BODY. The intake, the partition,
 * the bundle sections, the typed preview and the relation outcomes (always the
 * inert dry-run statuses: no relation is applied); no lock, no write.
 */
export async function previewOkfImportFrom(sources: OkfImportPreviewSources, root: string, dir: string): Promise<OkfImportReport> {
  const warnings: string[] = [];
  const onWarn = (m: string): number => warnings.push(m);
  const imported = await importOkfBundleFrom(sources.import, dir, root, {}, onWarn);
  const { valid, skipped: allSkipped } = partition(imported.pages, imported.skipped as OkfImportSkip[]);
  const bundle = imported.bundleBlock ? await buildBundleSectionsFrom(sources.profile, imported.bundleBlock) : {};
  const typed = [...imported.typedSkipped, ...previewTypedOutcomes(imported.typed)];
  const relations = await relationSection(diskOkfApplySteps(root), imported, { dryRun: true });
  return { mode: "dry-run", pages: valid.map(toImported), skipped: allSkipped, warnings, ...bundle, ...typedSection(typed), ...relations, nextAction: "Re-run without dryRun to apply." };
}

/** Read→map→collision→validate→stage/write/preview an OKF bundle; output-free; returns a report. */
export async function runOkfImport(root: string, dir: string, opts: OkfImportOptions = {}): Promise<OkfImportReport> {
  if (opts.dryRun) return previewOkfImportFrom(diskOkfImportPreviewSources(root), root, dir);
  return applyOkfImportWith(diskOkfApplySteps(root), dir, opts);
}

/**
 * The applying leg of {@link runOkfImport} over {@link OkfApplySteps}: THE ONE BODY.
 * Takes the lock quietly (a busy lock is {@link LockUnavailableError}), applies
 * under it, and releases it on every exit after it was taken.
 */
export async function applyOkfImportWith(steps: OkfApplySteps, dir: string, opts: OkfImportOptions): Promise<OkfImportReport> {
  // withQuiet: acquireLock prints "Another compilation is running." on contention;
  // the typed LockUnavailableError is the signal, so the core stays output-free.
  const locked = await withQuiet(() => steps.acquireLock());
  if (!locked) throw new LockUnavailableError();
  try {
    return await applyLocked(steps, dir, opts);
  } finally {
    await steps.releaseLock();
  }
}

/** Intake, queue check, stage or write, typed leg, promoted refresh, sections, relations, then the report. */
async function applyLocked(steps: OkfApplySteps, dir: string, opts: OkfImportOptions): Promise<OkfImportReport> {
  const warnings: string[] = [];
  const imported = await steps.importBundle(dir, (m) => warnings.push(m));
  const { valid, skipped: allSkipped } = partition(imported.pages, imported.skipped as OkfImportSkip[]);
  await assertQueueCapacity(steps, imported, valid.length, opts);
  if (opts.trusted) await writeAll(steps, valid);
  else await stageAll(steps, valid);
  // The import lock is held, so promote typed candidates via the LOCK-FREE core
  // (applyTypedDocs); a self-locking promotion would deadlock here.
  const typedApplied = imported.profile
    ? await steps.applyTyped(imported.typed, imported.profile.profile, opts.trusted ?? false)
    : [];
  await refreshPromotedTyped(steps, typedApplied);
  const bundle = imported.bundleBlock ? await steps.bundleSections(imported.bundleBlock) : {};
  const relations = await relationSection(steps, imported, opts);
  return {
    mode: opts.trusted ? "written" : "staged",
    pages: valid.map(toImported),
    skipped: allSkipped,
    warnings,
    ...bundle,
    ...typedSection([...imported.typedSkipped, ...typedApplied]),
    ...relations,
    nextAction: opts.trusted ? `${valid.length} page(s) written live.` : "Review and approve before it goes live: llmwiki review list.",
  };
}
