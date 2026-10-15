/**
 * @file src/local-workflow-host/live-target.ts
 * @description Core observation of exact live page bytes under the current
 * profile's namespace and existing confined-read checks.
 *
 * ONE BODY. {@link readLiveTargetDigest} keeps its signature and runs
 * {@link readLiveTargetDigestFrom} over the incumbent root readers. The body owns
 * the namespace selection, both unavailability refusals and the digest. The page
 * itself is reached through TWO PHYSICAL LEAVES, kept separate exactly as the
 * incumbent makes them: the confined capture of the page's canonical realpath
 * (`buildLiveRegistryEntry`, which reads the page once to build its entry), then
 * the confined re-read of the captured path (`readConfinedPage`). Neither has a
 * root-free body; they are physical selector and read mechanics, not a hosted
 * store. {@link liveTargetReadsOver} binds only the profile to its loader's
 * sources and passes those two leaves through.
 */
import { createHash } from "node:crypto";
import { readConfinedPage } from "../utils/confined-read.js";
import { buildLiveRegistryEntry, buildNamespaceDirs, type LiveRegistryEntry } from "../utils/page-registry.js";
import { loadProfile, loadProfileFrom, type EffectiveProfileSources } from "../profile/load.js";
import type { LoadedProfile } from "../profile/types.js";
import type { VerifierLiveTargetV1 } from "../workflow-history/types.js";
import { WorkflowVerifierError } from "./verifier-error.js";

/** What one live-target read asks: the profile, then the two physical page leaves. No member takes a project root. */
export interface LiveTargetReads {
  /** The effective profile, whose namespaces select the page's directory. */
  profile(): Promise<LoadedProfile>;
  /** PHYSICAL CAPTURE: the page's confined entry under its namespace directory, or `null`; refuses a malformed id or unknown namespace. */
  captureEntry(pageId: string, namespaceDirs: Map<string, string>): Promise<LiveRegistryEntry | null>;
  /** PHYSICAL READ: the captured page's raw text, re-confined at read time, or `null`. */
  readCapturedPage(entry: LiveRegistryEntry): Promise<string | null>;
}

/** LOCAL DISK. The incumbent root readers, each called when asked. */
function diskLiveTargetReads(root: string): LiveTargetReads {
  return {
    profile: () => loadProfile(root),
    captureEntry: (pageId, namespaceDirs) => buildLiveRegistryEntry(root, pageId, namespaceDirs),
    readCapturedPage: (entry) => readConfinedPage(entry.capturedRealpath, entry.expectedCanonicalDir),
  };
}

/** The profile over its loader's sources; the two physical leaves are the caller's. */
export function liveTargetReadsOver(profile: EffectiveProfileSources, leaves: Pick<LiveTargetReads, "captureEntry" | "readCapturedPage">): LiveTargetReads {
  return { profile: () => loadProfileFrom(profile), captureEntry: leaves.captureEntry, readCapturedPage: leaves.readCapturedPage };
}

/** Exact SHA-256 digest of one confined live page's raw Markdown bytes. */
export async function readLiveTargetDigest(root: string, pageId: string): Promise<VerifierLiveTargetV1> {
  return readLiveTargetDigestFrom(diskLiveTargetReads(root), pageId);
}

/** THE ONE BODY: the profile's namespaces, the capture, the re-read, then the digest; either missing leaf is unavailable. */
export async function readLiveTargetDigestFrom(reads: LiveTargetReads, pageId: string): Promise<VerifierLiveTargetV1> {
  const loaded = await reads.profile();
  const entry = await reads.captureEntry(pageId, buildNamespaceDirs(loaded.profile));
  if (entry === null) throw new WorkflowVerifierError("live-target-unavailable");
  const text = await reads.readCapturedPage(entry);
  if (text === null) throw new WorkflowVerifierError("live-target-unavailable");
  const contentDigest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  return { pageId, contentDigest };
}
