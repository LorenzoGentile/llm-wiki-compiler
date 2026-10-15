/**
 * @file test/storage/artifact-store-double.ts
 * @description One raw-leaf double for the artifact store's reads
 * (`ArtifactStoreReads`), shared by the two storage tests that run the REAL
 * artifact resolver under the artifact health check with no project directory:
 * `artifact-health-binding.test.ts`, which serves leaves copied off a real
 * project, and `profile-summary-binding.test.ts`, which serves leaves it makes
 * up per artifact.
 *
 * WHAT IT IS. A lookup from a project-relative leaf path to that leaf's text,
 * and a call log. `artifactAt` logs the artifact and the body file name it was
 * asked for. The sidecar read and the body read each log their artifact and
 * the cap they were given, BEFORE they answer: `ok` with the held text,
 * `absent` when the lookup holds nothing, or a rejection with the held
 * `Error` itself.
 *
 * WHAT IT DECIDES. Nothing about health. It holds no verdict, hashes nothing,
 * parses nothing and compares nothing: the resolver does all of that with what
 * these reads serve.
 *
 * WHAT IT DOES NOT DO. It never answers `unavailable` or `oversize`, and it
 * does not apply the cap it logs. The member sweep and the member read fail
 * the case if asked; `artifact-resolver-binding.test.ts` shows those. It
 * validates no type, slug or file name, so it never throws from `artifactAt`.
 * It is not a store, not an access-control layer and not `ProjectStore`, and
 * it shows nothing about confinement, links or no-follow opens on disk.
 */

import type { ArtifactStoreReads } from "../../src/artifacts/resolve.js";
import { unasked, type Note } from "./copied-project.js";

/** What the double reads from: a leaf's text, an `Error` its read rejects with, or nothing. A `Map` of copied files is one. */
export interface ArtifactLeafLookup {
  get(rel: string): string | Error | undefined;
}

/** Where the store keeps an artifact's body leaf, project-relative. Its sidecar is the same path with `.manifest.json` added. */
export const artifactBodyLeaf = (artifactType: string, slug: string, fileName: string): string => `artifacts/${artifactType}/${slug}/${fileName}`;

/**
 * The artifact store's reads over a leaf lookup.
 *
 * @param leaves - What each leaf path holds.
 * @param note - Records each call line, before the call answers.
 * @returns Reads that serve exactly what `leaves` holds.
 */
export function artifactStoreOver(leaves: ArtifactLeafLookup, note: Note): ArtifactStoreReads {
  const served = async (call: string, rel: string): Promise<{ kind: "ok"; body: string } | { kind: "absent" }> => {
    note(call);
    const held = leaves.get(rel);
    if (held instanceof Error) throw held;
    return held === undefined ? { kind: "absent" } : { kind: "ok", body: held };
  };
  return { artifactAt: (artifactType, slug, fileName) => {
    const at = `${artifactType}/${slug}`;
    const bodyLeaf = artifactBodyLeaf(artifactType, slug, fileName);
    note(`artifacts.artifactAt ${at} ${fileName}`);
    return {
      readManifestText: (maxBytes) => served(`artifacts.manifest ${at} max=${maxBytes}`, `${bodyLeaf}.manifest.json`),
      readBodyText: (maxBytes) => served(`artifacts.body ${at} max=${maxBytes}`, bodyLeaf),
      listEntries: unasked("artifacts.listEntries"),
      readMemberBytes: unasked("artifacts.readMemberBytes"),
    };
  } };
}
