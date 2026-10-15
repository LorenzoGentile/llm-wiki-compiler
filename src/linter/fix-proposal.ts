/**
 * @file src/linter/fix-proposal.ts
 * @description The PLAN half of `lint --fix-propose <n>`: which fix the number
 * names, whether its page can be routed, and the exact candidate draft the
 * proposal would stage. It decides and builds DATA. It stages nothing, takes no
 * lock and prints nothing.
 *
 * The one body, {@link proposeLintFixFrom}, reads through
 * {@link LintFixProposalSources} and names no project root. In this order: the
 * link plan; the index check; the routing check; ONE read of the target page's
 * current text; the draft. A refusal is returned as data with the exact message
 * the command prints. A rejecting read rejects, untouched.
 *
 * WHAT IS NOT HERE. The project lock, the recovery gate and the candidate
 * store. Staging a draft is the root-taking command's own step
 * (`commands/lint-fix-propose.ts`), through the existing candidate writer.
 * Those stay root-only and are not migrated by this module.
 *
 * PATHS ARE NAMES HERE, NOT A ROOT. A fix's `file` is the located path the plan
 * reported. It is used three ways: printed in a message, compared with the
 * located `wiki` directory to decide routing, and handed back to the sources to
 * read the page. None of those opens anything from this module.
 */

import path from "path";
import type { CandidateDraft } from "../compiler/candidates.js";
import { sha256Text } from "../connectors/hash.js";
import { readLocationText } from "../storage/disk-locations.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { planLintFixesFrom, type LintFixEditV1 } from "./fix-plan.js";
import { diskLintLinkSources, type LintLinkSources } from "./rules-shared.js";

/** The directory every routable page lives under, as the page sources locate it. */
const WIKI_SUBDIR = "wiki";

/** What a fix proposal reads through: the link plan's own sources, and the target page as the plan located it. */
export interface LintFixProposalSources {
  /**
   * The link plan's sources, the SAME ones `--fix-preview` numbers fixes from.
   * `links.pages.locate` also names where the `wiki` directory is, which is
   * compared with a fix's located file to route it; nothing is read for that.
   */
  links: LintLinkSources;
  /** A page's whole current text, by the LOCATED path a fix names. Follows links and is NOT confined to the project. Rejects with the backend's own error. */
  readLocatedPage(file: string): Promise<string>;
}

/** LOCAL DISK. The proposal sources for the project at `root`. Building them does no I/O. The page read is the unconfined read the command always made. In no package index. */
export function diskLintFixProposalSources(root: string): LintFixProposalSources {
  return { links: diskLintLinkSources(root), readLocatedPage: (file) => readLocationText(file) };
}

/** What `--fix-propose <n>` decided: the draft to stage with the fix it applies, or why nothing is staged. */
export type LintFixProposal =
  | { readonly kind: "draft"; readonly edit: LintFixEditV1; readonly draft: CandidateDraft }
  | { readonly kind: "refused"; readonly message: string };

/** Where an approved candidate lands: one generic directory, or one typed-entity directory. */
type TargetRoute = Pick<CandidateDraft, "targetDirectory" | "targetEntityType">;

type TargetRouting =
  | { ok: true; meta: TargetRoute }
  | { ok: false; reason: string };

/** The fixable findings, in the stable order `--fix-preview` numbers them. */
async function fixableFindings(links: LintLinkSources): Promise<LintFixEditV1[]> {
  const plans = await planLintFixesFrom(links);
  return plans.flatMap((plan) => (plan.kind === "fix" ? [plan.edit] : []));
}

/** Apply one wikilink edit to the page content, on its own line. */
function applyEdit(content: string, edit: LintFixEditV1): string {
  const lines = content.split("\n");
  const index = edit.line - 1;
  if (index < 0 || index >= lines.length) return content.replace(edit.from, edit.to);
  lines[index] = lines[index]!.replace(edit.from, edit.to);
  return lines.join("\n");
}

/**
 * Map the target page's wiki subdir to the candidate's routing metadata. The
 * candidate model addresses exactly one level under `wiki/`: `concepts`,
 * `queries`, or a single typed-entity directory. A page directly in `wiki/` or
 * nested deeper (e.g. `wiki/research/papers/foo.md`) cannot be faithfully
 * routed — the approval write would land at the WRONG path — so it is REFUSED
 * rather than silently mis-routed (fail closed). Full nested support is a
 * separate routing-model change.
 *
 * @param wikiDir - The located `wiki` directory, as a name to compare with.
 * @param file - The located page a fix names.
 */
function targetMetadata(wikiDir: string, file: string): TargetRouting {
  const rel = path.relative(wikiDir, file);
  const dir = path.dirname(rel);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: "the target page is outside wiki/" };
  }
  if (dir === "queries" || dir === "concepts") return { ok: true, meta: { targetDirectory: dir } };
  if (dir === "." || dir.includes(path.sep)) {
    return { ok: false, reason: `cannot route ${dir}/ — only wiki/concepts, wiki/queries, or a single typed-entity directory are supported` };
  }
  return { ok: true, meta: { targetEntityType: dir } };
}

/** The candidate draft for one fix over the page's current text: the edited body, held for manual review, guarded by the hash of the text that was read. */
function draftFor(edit: LintFixEditV1, current: string, route: TargetRoute): CandidateDraft {
  const meta = parseFrontmatter(current).meta as { title?: unknown; summary?: unknown };
  const slug = path.basename(edit.file, ".md");
  return {
    title: typeof meta.title === "string" ? meta.title : slug,
    slug,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    sources: [],
    body: applyEdit(current, edit),
    reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
    expectedTargetHash: sha256Text(current),
    ...route,
  };
}

/**
 * Decide the nth deterministic fix's proposal: THE ONE BODY. A number that
 * names no fix, and a page that cannot be routed, are refused BEFORE the page
 * is read. Otherwise the page is read once and the draft is built from that
 * text alone.
 *
 * @param sources - The link plan's sources and the located page read.
 * @param n - 1-based index into the fixable findings (as `--fix-preview` numbers them).
 * @returns The draft and its fix, or the refusal message the command prints.
 */
export async function proposeLintFixFrom(sources: LintFixProposalSources, n: number): Promise<LintFixProposal> {
  const fixes = await fixableFindings(sources.links);
  if (!Number.isInteger(n) || n < 1 || n > fixes.length) {
    return { kind: "refused", message: `No fixable finding #${n}. Run \`llmwiki lint --fix-preview\` to see the ${fixes.length} numbered fix(es).` };
  }
  const edit = fixes[n - 1]!;
  const routing = targetMetadata(sources.links.pages.locate(WIKI_SUBDIR), edit.file);
  if (!routing.ok) {
    return { kind: "refused", message: `Cannot propose a fix for ${edit.file}:${edit.line}: ${routing.reason}.` };
  }
  const current = await sources.readLocatedPage(edit.file);
  return { kind: "draft", edit, draft: draftFor(edit, current, routing.meta) };
}
