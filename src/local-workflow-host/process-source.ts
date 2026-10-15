/**
 * @file src/local-workflow-host/process-source.ts
 * @description Read the active package's retained process-definition bytes with
 * existing binding, digest and size checks. Interpretation remains engine-owned.
 *
 * ONE BODY. {@link readLocalWorkflowProcessSource} keeps its signature and runs
 * {@link readLocalWorkflowProcessSourceFrom} over the incumbent root readers;
 * {@link workflowProcessSourceReadsOver} is the same three reads over the
 * product binding's and the package store's own seams. Neither is a hosted
 * store, and neither is in a package index.
 */
import { MAX_PROCESS_DEFINITION_BYTES } from "../products/constants.js";
import type { Sha256Digest } from "../products/ids.js";
import { resolveActiveProduct, resolveActiveProductFrom, type ActiveProductResolution, type ActiveProductSources } from "../products/binding/resolve.js";
import { readStoredMemberText, readStoredMemberTextFrom } from "../products/binding/manifest-authority.js";
import { readInstalledProductPackage, readInstalledProductPackageFrom, type InstalledPackageRead, type ProductPackageReads } from "../products/packages/store.js";
import type { PackageMemberRefV1 } from "../products/types.js";
import { WorkflowProcessAuthorityError } from "../workflow-history/process-authority.js";

/** The three reads one process-source lookup makes. No member takes a project root. */
export interface WorkflowProcessSourceReads {
  /** The active product binding's resolution. */
  activeProduct(): Promise<ActiveProductResolution>;
  /** The installed package at `packageDigest`. */
  installedPackage(packageDigest: Sha256Digest): Promise<InstalledPackageRead>;
  /** One declared member's strict UTF-8 text within `maxBytes`. */
  memberText(packageDigest: Sha256Digest, member: PackageMemberRefV1, maxBytes: number): Promise<string>;
}

/** LOCAL DISK. The incumbent root readers, each called when asked. */
function diskWorkflowProcessSourceReads(root: string): WorkflowProcessSourceReads {
  return {
    activeProduct: () => resolveActiveProduct(root),
    installedPackage: (packageDigest) => readInstalledProductPackage(root, packageDigest),
    memberText: (packageDigest, member, maxBytes) => readStoredMemberText(root, packageDigest, member, maxBytes),
  };
}

/** The same reads over the binding's sources and the package store's reads. */
export function workflowProcessSourceReadsOver(product: ActiveProductSources, packages: ProductPackageReads): WorkflowProcessSourceReads {
  return {
    activeProduct: () => resolveActiveProductFrom(product),
    installedPackage: (packageDigest) => readInstalledProductPackageFrom(packages, packageDigest),
    memberText: (packageDigest, member, maxBytes) => readStoredMemberTextFrom(packages, packageDigest, member, maxBytes),
  };
}

/** Read only the declared process member, never a caller-selected member path. */
export async function readLocalWorkflowProcessSource(root: string, expectedDigest: string | undefined): Promise<string> {
  return readLocalWorkflowProcessSourceFrom(diskWorkflowProcessSourceReads(root), expectedDigest);
}

/** THE ONE BODY: the active product, its installed package, the declared member's digest, then the member's text. */
export async function readLocalWorkflowProcessSourceFrom(reads: WorkflowProcessSourceReads, expectedDigest: string | undefined): Promise<string> {
  const active = await reads.activeProduct();
  if (active.mode !== "product") throw new WorkflowProcessAuthorityError("unavailable");
  const stored = await reads.installedPackage(active.binding.packageDigest);
  if (stored.status !== "ok") throw new WorkflowProcessAuthorityError("unavailable");
  const member = stored.manifest.processDefinition;
  if (member === undefined || member.digest !== expectedDigest) {
    throw new WorkflowProcessAuthorityError("stale-or-invalid");
  }
  return reads.memberText(active.binding.packageDigest, member, MAX_PROCESS_DEFINITION_BYTES);
}
