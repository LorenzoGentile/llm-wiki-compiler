/**
 * Prototype-only fault isolation around the shared freshness reader. Preserve
 * its normal single-pass behavior, but isolate a source read failure so other
 * pages remain inspectable. Unreadable is never asserted to mean deleted.
 *
 * ONE BODY. {@link reviewFreshnessFrom} owns the isolation over any way of
 * building one snapshot; {@link reviewFreshness} keeps its signature and builds
 * with the incumbent `buildFreshnessSnapshot(root, …)` at call time.
 */
import { buildFreshnessSnapshot } from "../../freshness/index.js";
import type { ClassifiedState } from "../../utils/state.js";
import type { FreshnessSnapshot } from "../../freshness/types.js";

/** Reuse core hashing/confinement, degrading failed individual reads explicitly. */
export async function reviewFreshness(root: string, classified: ClassifiedState): Promise<FreshnessSnapshot> {
  return reviewFreshnessFrom((one) => buildFreshnessSnapshot(root, one), classified);
}

/** {@link reviewFreshness} over `build`: THE ONE BODY. The whole snapshot first; on a fault, one source at a time. */
export async function reviewFreshnessFrom(
  build: (classified: ClassifiedState) => Promise<FreshnessSnapshot>, classified: ClassifiedState,
): Promise<FreshnessSnapshot> {
  try { return await build(classified); }
  catch {
    const sources: FreshnessSnapshot["sources"] = {};
    for (const [file, entry] of Object.entries(classified.state.sources)) {
      try {
        const one = { ...classified, state: { ...classified.state, sources: { [file]: entry } } };
        Object.assign(sources, (await build(one)).sources);
      } catch {
        sources[file] = { recordedHash: entry.hash, currentHash: null, exists: false, concepts: entry.concepts };
      }
    }
    return { stateStatus: classified.status, sources };
  }
}
