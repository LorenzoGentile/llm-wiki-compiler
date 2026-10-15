/**
 * @file src/commands/product/init.ts
 * @description `llmwiki product init <sourceDir>` — the operator-facing cold-init
 * composition root: install a local product package, activate it as the
 * project's authority, and scaffold the directory tree the active product needs,
 * all in one authorized step.
 *
 * IT IS A COMPOSITION ROOT, NOT NEW SUBSTRATE. Each leg is an existing host seam
 * — `installLocalProductPackage`, `activateProductLocked`, `loadProfile`, and the
 * confined scaffolder — run in the order an operator would run them by hand
 * (`install` → `activate <digest>` → create the write targets). What this verb
 * adds is capturing the install's digest to activate it without a copy-paste,
 * and deriving the scaffold set from the just-activated profile.
 *
 * THE SCAFFOLD SET IS THE ACTIVE PROFILE'S OWN ENTITY DIRECTORIES, derived from
 * `profile.entities[*].directory` — never hand-listed and never product-specific
 * here. Core stays product-agnostic: it lays down exactly the `wiki/<class>`
 * write targets the activated product declares, so a fresh project has somewhere
 * for every entity class to land. A product's richer input conveniences (raw
 * inputs, config) are scaffolded by that product's own SDK helper, not by core.
 *
 * EVERY LEG IS CONFINED AND FAIL-CLOSED. Install/activate refuse a bad package
 * or binding through the shared {@link settleProduct} allowlist; the scaffolder
 * refuses any directory whose path escapes the project root (e.g. via a
 * pre-existing symlink) before creating it.
 *
 * ONE BODY. {@link productInitCommandWith} decides over {@link ProductInitSteps},
 * none of which takes a project root: install, then activate the installed
 * digest, then the re-resolve and its changed-identity refusal, then the scaffold
 * set derived from that one snapshot, then the report. Install, the self-locking
 * activation and the confined scaffolder are MECHANISM steps.
 */

import { activateProductLocked, type ActivateResultV1 } from "../../products/binding/activate.js";
import { ProductActivationError } from "../../products/binding/problems.js";
import {
  resolveActiveProduct, resolveActiveProductFrom, type ActiveProductResolution, type ActiveProductSources,
} from "../../products/binding/resolve.js";
import type { PrincipalRefV1 } from "../../products/binding/types.js";
import { withQuietJson } from "../../cli/shared.js";
import { installLocalProductPackage, type ProductInstallResultV1 } from "../../products/packages/install.js";
import type { Sha256Digest } from "../../products/ids.js";
import {
  scaffoldConfinedDirectories, type ScaffoldDirectoriesResultV1,
} from "../../utils/confined-scaffold.js";
import { CLI_ACTIVATION_PRINCIPAL } from "./host.js";
import type { ProductPackageOptions } from "./package.js";
import {
  emitProduct, refusalPresentation, settleProduct,
  type ProductPresentationV1, type ProductRefusalV1,
} from "./render.js";

/** What one settled cold init reports. */
interface ColdInitResultV1 {
  readonly status: "initialized";
  readonly productId: string;
  readonly productVersion: string;
  readonly packageDigest: Sha256Digest;
  readonly scaffold: ScaffoldDirectoriesResultV1;
}

/** What `product init` asks of the project. No member takes a project root. */
export interface ProductInitSteps {
  /** MECHANISM: install the operator's package directory. */
  install(sourceDir: string): Promise<ProductInstallResultV1>;
  /** MECHANISM: activate one installed digest; takes and releases the project lock itself. */
  activate(packageDigest: Sha256Digest, principal: PrincipalRefV1): Promise<ActivateResultV1>;
  /** The ONE active-product resolution. */
  resolveActive(): Promise<ActiveProductResolution>;
  /** MECHANISM: create each directory, confined, refusing any that escapes. */
  scaffold(relDirs: readonly string[]): Promise<ScaffoldDirectoriesResultV1>;
}

/** LOCAL DISK. The incumbent install, activation, resolution and scaffolder for `root`, each called when asked. */
function diskProductInitSteps(root: string): ProductInitSteps {
  return {
    install: (sourceDir) => installLocalProductPackage(root, sourceDir),
    activate: (packageDigest, principal) => activateProductLocked(root, packageDigest, principal),
    resolveActive: () => resolveActiveProduct(root),
    scaffold: (relDirs) => scaffoldConfinedDirectories(root, relDirs),
  };
}

/** The resolution over its own body and sources, with the caller's mechanisms. Building it does no I/O. */
export function productInitStepsOver(
  active: ActiveProductSources, mechanisms: Pick<ProductInitSteps, "install" | "activate" | "scaffold">,
): ProductInitSteps {
  return { ...mechanisms, resolveActive: () => resolveActiveProductFrom(active) };
}

/**
 * Install, activate, then scaffold the active profile's entity directories.
 *
 * `activateProductLocked` releases the project lock before it returns, so a
 * concurrent `product init` could re-activate a DIFFERENT package between our
 * activation and our read of "the active" profile. We therefore re-resolve the
 * authority from ONE consistent read and refuse if it is no longer the exact
 * digest we activated — otherwise we would scaffold that other product's
 * directories while reporting ours as the authority (Codex P2). Both the
 * scaffold set and the reported digest come from the same verified snapshot.
 *
 * Throws a typed product/binding problem the caller settles to a refusal, or a
 * hard fault if a scaffold target escapes the root.
 * @param steps - The project steps.
 * @param sourceDir - The operator-supplied package directory.
 * @param onActivated - Test-only seam run between activation and the re-verify,
 *   used to witness the concurrent-reactivation guard deterministically.
 */
async function coldInitProject(
  steps: ProductInitSteps, sourceDir: string, onActivated?: () => Promise<void>,
): Promise<ColdInitResultV1> {
  const install = await steps.install(sourceDir);
  const activation = await steps.activate(install.packageDigest, CLI_ACTIVATION_PRINCIPAL);
  if (onActivated !== undefined) await onActivated();
  const active = await steps.resolveActive();
  if (active.mode !== "product" || active.binding.packageDigest !== activation.packageDigest) {
    const now = active.mode === "product" ? active.binding.packageDigest : active.mode;
    throw new ProductActivationError(
      `active product changed during init (activated ${activation.packageDigest}, now ${now})`,
    );
  }
  const entityDirs = Object.values(active.loaded.profile.entities).map((entity) => entity.directory);
  const scaffold = await steps.scaffold(entityDirs);
  return {
    status: "initialized",
    productId: activation.productId,
    productVersion: activation.productVersion,
    packageDigest: activation.packageDigest,
    scaffold,
  };
}

/** What one settled cold init prints. */
function initPresentation(outcome: ColdInitResultV1 | ProductRefusalV1): ProductPresentationV1 {
  if (outcome.status === "refused") return refusalPresentation(outcome.reason);
  const { created, existing } = outcome.scaffold;
  return {
    lines: [
      `initialized: ${outcome.productId} ${outcome.productVersion}`,
      `package digest: ${outcome.packageDigest}`,
      "this product is now the project's knowledge and operations authority",
      `scaffolded ${created.length} new director${created.length === 1 ? "y" : "ies"}, ${existing.length} already present`,
    ],
    code: 0, refused: false,
  };
}

/**
 * `llmwiki product init <sourceDir>`. Returns the process exit code.
 *
 * @param root - The project root to initialize.
 * @param sourceDir - The operator-supplied package directory to install+activate.
 * @param options - `--json`.
 */
export async function productInitCommand(
  root: string, sourceDir: string, options: ProductPackageOptions = {},
): Promise<number> {
  return productInitCommandWith(diskProductInitSteps(root), sourceDir, options);
}

/** {@link productInitCommand} over {@link ProductInitSteps}: THE ONE BODY. */
export async function productInitCommandWith(
  steps: ProductInitSteps, sourceDir: string, options: ProductPackageOptions = {},
): Promise<number> {
  const json = options.json === true;
  return withQuietJson(json, async () => {
    const outcome = await settleProduct(() => coldInitProject(steps, sourceDir));
    return emitProduct(outcome, json, initPresentation(outcome));
  });
}
