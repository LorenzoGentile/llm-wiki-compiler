/**
 * @file src/local-workflow-host/entity-digest.ts
 * @description Existing confined entity postimage observation used by lifecycle
 * recovery. The engine receives a digest, not a writable or readable file handle.
 *
 * ONE BODY: {@link readLocalWorkflowEntityDigestFrom} owns the digest form over
 * {@link EntityPageBytesReads}; the root form passes {@link diskEntityPageBytesReads},
 * the incumbent confined page resolution and byte read, called when asked.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveConfinedEntityPage } from "../profile/lifecycle-read.js";
import type { EntityTypeDef } from "../profile/types.js";

/** What the digest asks of the project. No member takes a project root. */
export interface EntityPageBytesReads {
  /** The confined page's current bytes, or null when there is no such page. */
  readPageBytes(def: EntityTypeDef, slug: string): Promise<Buffer | null>;
}

/** LOCAL DISK: the incumbent confined resolution, then the byte read, for one root. In no package index. */
function diskEntityPageBytesReads(root: string): EntityPageBytesReads {
  return {
    readPageBytes: async (def, slug) => {
      const file = await resolveConfinedEntityPage(root, def, slug);
      return file === null ? null : readFile(file);
    },
  };
}

/** Resolve the same confined page and hash its current bytes, or report absence. */
export async function readLocalWorkflowEntityDigest(root: string, def: EntityTypeDef, slug: string): Promise<string | null> {
  return readLocalWorkflowEntityDigestFrom(diskEntityPageBytesReads(root), def, slug);
}

/** {@link readLocalWorkflowEntityDigest} over {@link EntityPageBytesReads}: THE ONE BODY. */
export async function readLocalWorkflowEntityDigestFrom(
  reads: EntityPageBytesReads, def: EntityTypeDef, slug: string,
): Promise<string | null> {
  const bytes = await reads.readPageBytes(def, slug);
  if (bytes === null) return null;
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
