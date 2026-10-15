/**
 * @file src/profile/templates/update.ts
 * @description Read-only compatibility planning for template profile updates.
 * It never writes and treats every unverifiable profile-owned store as unsafe.
 *
 * ONE PLAN BODY: {@link planTemplateUpdateFrom} owns identity BEFORE any read,
 * then drift, the diff and its dispositions, lint filtering and its catch, pending
 * candidates before the archive audit, the workflow audit, then the artifact audit
 * and the contract-change check, with every message unchanged, over
 * {@link TemplateUpdateReads}. The root form builds the reads per call.
 *
 * The builtin entry is one body too: {@link planBuiltinTemplateUpdateWith} reads the
 * provenance lock, resolves the installed and candidate releases from the in-process
 * builtin registry, loads the active profile and runs the plan body, in the
 * incumbent order and with the incumbent messages, over {@link BuiltinPlanSteps}.
 */
import canonicalize from "canonicalize";
import { CANDIDATES_DIR } from "../../utils/constants.js";
import { diffProfiles, type PageDisposition, type ProfileDiffReport } from "../diff.js";
import { profileDigest } from "../digest.js";
import { loadProfile } from "../load.js";
import { lintProfileEntities } from "../lint.js";
import type { LintResult } from "../../linter/types.js";
import type { LoadedProfile, ProfilePack } from "../types.js";
import type { ProfileTemplatePackage } from "./types.js";
import { confinedEntries, firstFileUnder } from "./corpus.js";
import { auditArtifactStore } from "./artifact-audit.js";
import { auditCandidateArchive, auditWorkflowHistory } from "./history-audit.js";
import { readTemplateLock, type TemplateLockRead } from "./lock.js";
import { getBuiltinTemplate, getBuiltinTemplateRelease } from "./registry.js";

const MAX_PENDING_CANDIDATE_ENTRIES = 10_000;

/** One structured refusal reason from the corpus-wide compatibility audit. */
export interface TemplateUpdateReason {
  kind: "drift" | "page" | "lint" | "candidate" | "workflow" | "artifact" | "store";
  message: string;
  path?: string;
}

/**
 * Complete advisory dry-run result. `compatible` describes this read snapshot;
 * it cannot authorize a later write because project state may change afterward.
 */
export interface TemplateUpdatePlan {
  schemaVersion: 1;
  authority: "advisory";
  compatible: boolean;
  from: string;
  to: string;
  oldProfileDigest: string;
  newProfileDigest: string;
  diff: ProfileDiffReport;
  reasons: TemplateUpdateReason[];
}

/** What the builtin plan asks of the project. No member takes a project root. */
export interface BuiltinPlanSteps {
  /** The advisory provenance lock. Local: `readTemplateLock(root)`. */
  readTemplateLock(): Promise<TemplateLockRead>;
  /** The active profile. Local: `loadProfile(root)`. */
  loadProfile(): Promise<LoadedProfile>;
  /** The plan body's reads. Local: this module's local plan reads. */
  plan: TemplateUpdateReads;
}

/** Plan a builtin update using an independently resolved installed release. */
export async function planBuiltinTemplateUpdate(root: string, requestedId?: string): Promise<TemplateUpdatePlan> {
  return planBuiltinTemplateUpdateWith({
    readTemplateLock: () => readTemplateLock(root),
    loadProfile: () => loadProfile(root),
    plan: localTemplateUpdateReads(root),
  }, requestedId);
}

/** {@link planBuiltinTemplateUpdate} over {@link BuiltinPlanSteps}: THE ONE BODY. */
export async function planBuiltinTemplateUpdateWith(steps: BuiltinPlanSteps, requestedId?: string): Promise<TemplateUpdatePlan> {
  const lockRead = await steps.readTemplateLock();
  if (lockRead.kind !== "ok") throw new Error(`cannot plan update: template provenance is ${lockRead.kind}`);
  const lock = lockRead.lock;
  if (lock.sourceType !== "builtin") throw new Error("R1 update dry-run supports builtin installs only");
  const base = getBuiltinTemplateRelease(lock.templateId, lock.version, lock.publisher);
  if (!base) {
    throw new Error(`cannot independently resolve installed builtin ${lock.templateId}@${lock.version}`);
  }
  const candidateId = requestedId ?? lock.templateId;
  if (candidateId !== lock.templateId) throw new Error("template update cannot change template identity");
  const candidate = getBuiltinTemplate(candidateId);
  if (!candidate) throw new Error(`unknown builtin template: ${candidateId}`);
  return planTemplateUpdateFrom(steps.plan, (await steps.loadProfile()).profile, base, candidate);
}

/** What the update plan reads. No member takes a project root. */
export interface TemplateUpdateReads {
  /** The page-by-page diff. Local: `diffProfiles(root, active, candidate)`. */
  diff(active: ProfilePack, candidate: ProfilePack): Promise<ProfileDiffReport>;
  /** The candidate profile's entity lint; may reject. Local: `lintProfileEntities(root, profile)`. */
  lintEntities(profile: ProfilePack): Promise<LintResult[]>;
  /** One project-relative directory's entry names. Local: {@link confinedEntries}. */
  entries(relativeDir: string): Promise<string[] | "absent" | "unavailable">;
  /** Whether any file sits below a project-relative store. Local: {@link firstFileUnder}. */
  firstFileUnder(relativeDir: string): Promise<"absent" | "present" | "unavailable">;
  /** DOMAIN. The archived-candidate audit. Local: `auditCandidateArchive(root)`. */
  auditCandidateArchive(): Promise<string[]>;
  /** DOMAIN. The workflow-history audit. Local: `auditWorkflowHistory(root)`. */
  auditWorkflowHistory(): Promise<Array<{ kind: "store" | "workflow"; message: string }>>;
  /** DOMAIN. The complete artifact-store audit under `profile`. Local: `auditArtifactStore(root, profile)`. */
  auditArtifactStore(profile: ProfilePack): Promise<string[]>;
}

/** LOCAL DISK. The incumbent reads and audits for one root, built per call; each called when asked. */
function localTemplateUpdateReads(root: string): TemplateUpdateReads {
  return {
    diff: (active, candidate) => diffProfiles(root, active, candidate),
    lintEntities: (profile) => lintProfileEntities(root, profile),
    entries: (relativeDir) => confinedEntries(root, relativeDir),
    firstFileUnder: (relativeDir) => firstFileUnder(root, relativeDir),
    auditCandidateArchive: () => auditCandidateArchive(root),
    auditWorkflowHistory: () => auditWorkflowHistory(root),
    auditArtifactStore: (profile) => auditArtifactStore(root, profile),
  };
}

/** Plan an update from independently verified base and candidate packages. */
export async function planTemplateUpdate(
  root: string,
  active: ProfilePack,
  base: ProfileTemplatePackage,
  candidate: ProfileTemplatePackage,
): Promise<TemplateUpdatePlan> {
  return planTemplateUpdateFrom(localTemplateUpdateReads(root), active, base, candidate);
}

/** {@link planTemplateUpdate} over {@link TemplateUpdateReads}: THE ONE BODY. */
export async function planTemplateUpdateFrom(
  reads: TemplateUpdateReads,
  active: ProfilePack,
  base: ProfileTemplatePackage,
  candidate: ProfileTemplatePackage,
): Promise<TemplateUpdatePlan> {
  assertUpdateIdentity(active, base, candidate);
  const reasons: TemplateUpdateReason[] = [];
  const activeDigest = profileDigest(active);
  const baseDigest = profileDigest(base.profile);
  if (activeDigest !== baseDigest) reasons.push({ kind: "drift", message: "active profile has local modifications" });
  const diff = await reads.diff(active, candidate.profile);
  reasons.push(...diffReasons(diff));
  reasons.push(...await lintReasons(reads, candidate.profile));
  reasons.push(...await candidateReasons(reads));
  reasons.push(...await workflowReasons(reads));
  reasons.push(...await artifactReasons(reads, active, candidate.profile));
  return {
    schemaVersion: 1,
    authority: "advisory",
    compatible: reasons.length === 0,
    from: `${base.templateId}@${base.version}`,
    to: `${candidate.templateId}@${candidate.version}`,
    oldProfileDigest: activeDigest,
    newProfileDigest: profileDigest(candidate.profile),
    diff,
    reasons,
  };
}

function assertUpdateIdentity(
  active: ProfilePack,
  base: ProfileTemplatePackage,
  candidate: ProfileTemplatePackage,
): void {
  if (base.templateId !== candidate.templateId) throw new Error("template update cannot change template identity");
  if (base.publisher !== candidate.publisher) throw new Error("template update cannot change publisher identity");
  if (base.sourceType !== candidate.sourceType) throw new Error("template update cannot change source identity");
  if (active.profileId !== base.profile.profileId || candidate.profile.profileId !== base.profile.profileId) {
    throw new Error("template update cannot change profile identity");
  }
}

function diffReasons(diff: ProfileDiffReport): TemplateUpdateReason[] {
  const reasons: TemplateUpdateReason[] = diff.problems.map((problem) => ({ kind: "store", message: problem.message, path: problem.directory }));
  for (const page of diff.pages) {
    if (isSafeDisposition(page)) continue;
    reasons.push({ kind: "page", message: `page is ${page.disposition}`, path: `${page.directory}/${page.stem}.md` });
  }
  return reasons;
}

function isSafeDisposition(page: PageDisposition): boolean {
  return page.disposition === "unchanged" || page.disposition === "newly-supported";
}

async function lintReasons(reads: TemplateUpdateReads, profile: ProfilePack): Promise<TemplateUpdateReason[]> {
  try {
    const findings = await reads.lintEntities(profile);
    return findings
      .filter((finding) => !isContentOnlyFinding(finding.rule))
      .map((finding) => ({ kind: "lint", message: `${finding.rule}: ${finding.message}`, path: finding.file }));
  } catch (error) {
    return [{ kind: "store", message: `candidate-profile validation is unavailable: ${errorMessage(error)}` }];
  }
}

function isContentOnlyFinding(rule: string): boolean {
  return rule === "empty-page" || rule === "malformed-claim-citation" || rule === "low-confidence";
}

async function candidateReasons(reads: TemplateUpdateReads): Promise<TemplateUpdateReason[]> {
  const pending = await reads.entries(CANDIDATES_DIR);
  if (pending === "unavailable") return [{ kind: "store", message: "candidate store is unreadable or unsafe" }];
  if (Array.isArray(pending)) {
    if (pending.length > MAX_PENDING_CANDIDATE_ENTRIES) {
      return [{ kind: "store", message: "candidate store exceeds its entry cap" }];
    }
    if (pending.some((entry) => entry !== "archive" && !isJsonFile(entry))) {
      return [{ kind: "store", message: "candidate store contains unexpected entries" }];
    }
    if (pending.some(isJsonFile)) {
      return [{ kind: "candidate", message: "pending review candidates must be resolved before update" }];
    }
  }
  return (await reads.auditCandidateArchive()).map((message) => ({ kind: "store", message }));
}

async function workflowReasons(reads: TemplateUpdateReads): Promise<TemplateUpdateReason[]> {
  return reads.auditWorkflowHistory();
}

async function artifactReasons(reads: TemplateUpdateReads, active: ProfilePack, candidate: ProfilePack): Promise<TemplateUpdateReason[]> {
  const audit = (await reads.auditArtifactStore(candidate)).map((message) => ({ kind: "artifact" as const, message }));
  if (canonicalize(active.artifacts ?? {}) === canonicalize(candidate.artifacts ?? {})) return audit;
  const state = await reads.firstFileUnder("artifacts");
  if (state === "unavailable") return [...audit, { kind: "store", message: "artifact store is unreadable or unsafe" }];
  if (state === "present") return [...audit, { kind: "artifact", message: "artifact contracts changed while stored artifacts exist" }];
  return audit;
}

function isJsonFile(name: string): boolean {
  return name.endsWith(".json");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
