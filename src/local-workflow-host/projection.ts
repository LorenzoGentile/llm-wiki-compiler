/**
 * @file src/local-workflow-host/projection.ts
 * @description Core-owned derived projection persistence. The active profile owns
 * the target; callers supply rendered text, never a writable filesystem path.
 *
 * ONE BODY: {@link writeLocalWorkflowProjectionWith} keeps the workflow lookup, the
 * derived-marker requirement, the escape refusal and the overwrite rule (missing,
 * or a regular file whose head carries the marker) over {@link ProjectionSteps}.
 * The root form passes {@link localProjectionSteps}, whose target is the incumbent
 * {@link confineProjectionPath}, `lstat` probe (ANY lstat error reads as missing),
 * plain `"r"` head read and confined `atomicWrite`, unchanged and NOT hardened here.
 */
import path from "node:path";
import { lstat, open } from "node:fs/promises";
import { loadProfile } from "../profile/load.js";
import { lookupWorkflowDef } from "../workflow-history/definition.js";
import { atomicWrite } from "../utils/markdown.js";
import { confineUnderRoot, safeRealpath, isInsideDir } from "../utils/path-confine.js";

/** The single `wiki/` output root a projection target must resolve inside. */
const WIKI_ROOT = "wiki";

/** The stable marker prefix that identifies a file as a workflow-run projection. */
const DERIVED_MARKER = "<!-- DERIVED from the workflow run JSON";

/**
 * Bytes read (no-follow) from an existing target to recognize a prior projection.
 * A real projection carries the {@link DERIVED_MARKER} just after its (small)
 * frontmatter, well within this window; an authored page never does.
 */
const MARKER_PROBE_BYTES = 2048;

/** The outcome of {@link writeProjection}: written, no declared target, or fail-visible. */
export type ProjectionResult =
  | { status: "written"; path: string }
  | { status: "no-target" }
  | { status: "unavailable"; detail: string };

/**
 * Re-confine a profile-supplied `projectionFile` under `<root>/wiki/`, returning
 * the absolute write path. Fails CLOSED (throws) when the resolved path escapes
 * the `wiki/` output root — defense in depth, never trusting the path into
 * {@link atomicWrite} even though profile-load already validated it.
 *
 * @param root - Absolute project root.
 * @param projectionFile - The declared project-relative `wiki/...` target.
 * @returns The confined absolute write path under `<root>/wiki/`.
 * @throws When the resolved path escapes `<root>/wiki/`.
 */
export async function confineProjectionPath(root: string, projectionFile: string): Promise<string> {
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  const wikiRoot = path.join(realRoot, WIKI_ROOT);
  const writePath = await confineUnderRoot(projectionFile, realRoot, { mustExist: false });
  if (!isInsideDir(writePath, wikiRoot)) {
    throw new Error(`projection path escapes wiki/: ${projectionFile}`);
  }
  return writePath;
}

/** What a probe of an existing projection target saw. */
export type ProjectionTargetProbe =
  | { kind: "missing" }
  | { kind: "not-file" }
  | { kind: "file"; head: string };

/** One confined projection target: its probe and its write. */
export interface ProjectionTarget {
  /** Look at what is there now, reading at most `maxBytes` of a regular file's head. */
  probe(maxBytes: number): Promise<ProjectionTargetProbe>;
  /** Write the rendered projection. */
  write(body: string): Promise<void>;
}

/** What the projection write asks of the project. No member takes a project root. */
export interface ProjectionSteps {
  /** The active profile's declared workflows. */
  loadWorkflows(): Promise<Parameters<typeof lookupWorkflowDef>[0]>;
  /** Confine a declared target under `wiki/`; rejects when it escapes. */
  confineTarget(projectionFile: string): Promise<ProjectionTarget>;
}

/** LOCAL DISK: the incumbent profile load, confinement, probe and write for one root, built per call. In no package index. */
function localProjectionSteps(root: string): ProjectionSteps {
  return {
    loadWorkflows: async () => (await loadProfile(root)).profile.workflows,
    confineTarget: async (projectionFile) => {
      const writePath = await confineProjectionPath(root, projectionFile);
      return {
        probe: (maxBytes) => probeProjectionTarget(writePath, maxBytes),
        write: async (body) => {
          const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
          await atomicWrite(writePath, body, { confineRoot: realRoot });
        },
      };
    },
  };
}

/**
 * Whether a probed target is OK to overwrite with a projection: a regular file
 * ONLY when its head carries the {@link DERIVED_MARKER} (it IS a prior projection
 * — the normal re-project); a symlink, a directory or anything else NOT; a missing
 * target yes (nothing to clobber). Defense in depth behind the reserved-subtree
 * load gate. What counts as "missing" and how the head is read are the probe's.
 */
function projectionTargetWritable(probe: ProjectionTargetProbe): boolean {
  if (probe.kind === "missing") return true; // missing target — nothing to clobber
  if (probe.kind === "not-file") return false; // symlink / directory / other → refuse
  return probe.head.includes(DERIVED_MARKER);
}

/** The incumbent disk probe: `lstat` (any error is "missing"), then a plain `"r"` open and a head read. */
async function probeProjectionTarget(writePath: string, maxBytes: number): Promise<ProjectionTargetProbe> {
  let st;
  try {
    st = await lstat(writePath); // a symlink is never a projection
  } catch {
    return { kind: "missing" };
  }
  if (!st.isFile()) return { kind: "not-file" };
  const handle = await open(writePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return { kind: "file", head: buf.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
}

/** Write rendered workflow text only to the active profile declared projection target. */
export async function writeLocalWorkflowProjection(root: string, workflowId: string, body: string): Promise<ProjectionResult> {
  return writeLocalWorkflowProjectionWith(localProjectionSteps(root), workflowId, body);
}

/** {@link writeLocalWorkflowProjection} over {@link ProjectionSteps}: THE ONE BODY. */
export async function writeLocalWorkflowProjectionWith(
  steps: ProjectionSteps, workflowId: string, body: string,
): Promise<ProjectionResult> {
  const def = lookupWorkflowDef(await steps.loadWorkflows(), workflowId);
  if (def?.projectionFile === undefined) return { status: "no-target" };
  // Rendered frontmatter includes inputs and can exceed the existing overwrite
  // probe window. Do not impose a new size limit on valid first-time projections.
  if (!body.includes(DERIVED_MARKER)) {
    return { status: "unavailable", detail: "projection body is not a derived projection page" };
  }
  let target: ProjectionTarget;
  try {
    target = await steps.confineTarget(def.projectionFile);
  } catch {
    return { status: "unavailable", detail: "projection path escapes wiki/" };
  }
  if (!projectionTargetWritable(await target.probe(MARKER_PROBE_BYTES))) {
    return { status: "unavailable", detail: "projection target is not a projection page" };
  }
  await target.write(body);
  return { status: "written", path: def.projectionFile };
}
