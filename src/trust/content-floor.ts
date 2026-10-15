/**
 * @file src/trust/content-floor.ts
 * @description The PATH-FREE part of the mandatory page floor: the checks that
 * depend only on a page's identity and bytes, never on where a project lives.
 *
 * The planner and the page-apply primitive both run the floor against a project
 * root, because on disk a target must also be confined and collision-probed.
 * Those two checks are storage concerns. The remaining checks — safe identity,
 * the resource cap and a parseable frontmatter block — are the same question on
 * any backend, so they live here once and are called from two places: the
 * planner (through its mandatory checks) and the page-apply primitive at the
 * byte-writing boundary.
 */

import { isSafeFilenameComponent } from "../profile/identity.js";
import { checkFrontmatter, checkResourceLimit } from "./checks.js";
import type { TrustCheckResult } from "./decision.js";

/**
 * The default-page identity floor: both components must be safe filename
 * components, so a slug can never name a different location once joined.
 */
export function checkDefaultIdentitySafe(directory: string, slug: string): TrustCheckResult {
  const code = "invalid-identity";
  if (isSafeFilenameComponent(directory) && isSafeFilenameComponent(slug)) {
    return { code, verdict: "pass", message: "directory and slug are safe filename components" };
  }
  return { code, verdict: "block", message: `directory/slug is not a safe filename component: ${directory}/${slug}` };
}

/**
 * The byte-only floor checks: resource cap and frontmatter shape. Shared by the
 * page-apply primitive so the disk path and a path-free host cannot drift.
 */
export async function runContentChecks(body: string, maxBodyChars: number): Promise<TrustCheckResult[]> {
  const ctx = { root: "", targetPath: "", body, maxBodyChars };
  return Promise.all([checkResourceLimit(ctx), checkFrontmatter(ctx)]);
}
