/**
 * @file src/commands/query-save.ts
 * @description The `query --save` write path — persists a generated answer as a
 * `wiki/queries/<slug>.md` page and refreshes the index/embeddings so the answer
 * is immediately retrievable.
 *
 * Split out of `query.ts` to keep that command file within the project size
 * budget; the answer-generation pipeline stays in `query.ts` and calls
 * {@link maybeSaveQueryPage} once the answer is produced.
 */

import path from "path";
import { slugify } from "../utils/markdown.js";
import { writeLeafAtomicUnconfined } from "../storage/disk-guarded-leaves.js";
export { summarizeAnswer } from "./query-document.js";
import { generateIndex } from "../compiler/indexgen.js";
import { updateEmbeddingsLockedCore } from "../utils/embeddings.js";
import { qualifiedPageId, type PageId } from "../utils/page-id.js";
import { handleSafeEmbeddingFailure } from "../utils/embeddings-batch.js";
import { QUERIES_DIR } from "../utils/constants.js";
import * as output from "../utils/output.js";

/** The four steps a direct save takes, in order. No member takes a project root. */
export interface QuerySaveSteps {
  /** Write the page at the project-relative `relPath` (local: an unconfined atomic leaf write). */
  writePage(relPath: string, document: string): Promise<void>;
  /** Where an operator finds `relPath`, for the saved notice. */
  locate(relPath: string): string;
  /** Regenerate the wiki index. */
  regenerateIndex(): Promise<void>;
  /** Refresh the saved page's embedding under the already-held lock; a failure is handled by the body. */
  refreshEmbedding(pageId: PageId): Promise<unknown>;
}

/**
 * Save a query answer as a wiki page in the queries/ directory,
 * then regenerate the wiki index so the answer is immediately retrievable.
 *
 * NOTE: This path writes directly to wiki/queries/ with NO trust-routed planner
 * evaluation. It is gated by {@link maybeSaveQueryPage}, which DISABLES the save
 * in profile-enabled (non-default-profile) projects and holds the project lock
 * around the default-profile decision and write. Do not call this directly from
 * an unlocked or profile-enabled context — route through {@link maybeSaveQueryPage}.
 *
 * @param root - Absolute path to the project root directory.
 * @param question - The original question used as the page title.
 * @param document - The canonical serialized query document.
 */
export async function saveQueryPageLocked(root: string, question: string, document: string): Promise<string> {
  return saveQueryPageLockedFrom({
    writePage: (relPath, text) => writeLeafAtomicUnconfined(path.join(root, relPath), text),
    locate: (relPath) => path.join(root, relPath),
    regenerateIndex: () => generateIndex(root),
    refreshEmbedding: (pageId) => updateEmbeddingsLockedCore(root, [pageId]),
  }, question, document);
}

/**
 * {@link saveQueryPageLocked} over {@link QuerySaveSteps}: THE ONE BODY. Write,
 * notice, index, then the embedding refresh, whose failure never blocks the save.
 */
export async function saveQueryPageLockedFrom(steps: QuerySaveSteps, question: string, document: string): Promise<string> {
  const slug = slugify(question);
  const relPath = path.join(QUERIES_DIR, `${slug}.md`);

  await steps.writePage(relPath, document);

  output.status("+", output.success(`Saved query → ${output.source(steps.locate(relPath))}`));

  // Regenerate the index so the saved query is immediately discoverable
  // by the next query's page-selection step.
  await steps.regenerateIndex();

  // Index the new query so semantic search retrieves it on the next question.
  // maybeSaveQueryPage already holds the project lock, so call the lock-free
  // core. The saved page lives under wiki/queries/, so qualify it under `queries/`.
  // Non-critical: embedding failures (e.g. missing VOYAGE_API_KEY) don't block save.
  try {
    await steps.refreshEmbedding(qualifiedPageId(path.basename(QUERIES_DIR), slug));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    handleSafeEmbeddingFailure(err, `Skipped embeddings update: ${message}`);
  }

  return slug;
}
