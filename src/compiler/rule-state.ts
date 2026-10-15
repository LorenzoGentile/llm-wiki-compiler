/**
 * Rule-extraction change-detection state (rule pipeline).
 *
 * `llmwiki rules extract` must decide which sources to (re)process on its own
 * cadence, independent of the concept compiler. If it reused `.llmwiki/state.json`
 * a source already compiled into pages would be considered "unchanged" and
 * yield zero rule candidates, while a source not yet compiled would be
 * re-extracted on every run. This module persists a parallel per-source hash
 * map in `.llmwiki/rule-state.json` so rule extraction advances its own cursor.
 *
 * The shape mirrors {@link WikiState} (so `detectChanges` can compare against
 * it directly), with a per-source output language for prompt invalidation.
 * `concepts` is always empty because rule extraction produces candidates, not pages.
 *
 * ONE BODY EACH, OVER ONE LEAF. {@link readRuleStateFrom} and
 * {@link updateRuleSourceStateFrom} decide over {@link RuleStateLeaf}, the
 * cursor's one leaf; the root forms keep their signatures and pass the local
 * leaf, built per call, which calls the incumbent presence look, text read and
 * hardened atomic replacement when asked.
 */

import path from "path";
import { replaceLeafAtomicWithin } from "../storage/disk-guarded-leaves.js";
import { locationExistsSync, readLocationText } from "../storage/disk-locations.js";
import { RULE_STATE_FILE } from "../utils/constants.js";
import type { WikiState, SourceState } from "../utils/types.js";

/** A source advances only under the language that successfully processed it. */
interface RuleSourceState extends SourceState {
  /** Missing in older cursors; equivalent to the default language (empty string). */
  outputLanguage?: string;
}

/** Independent rule cursor, structurally compatible with source change detection. */
interface RuleState extends WikiState {
  sources: Record<string, RuleSourceState>;
}

/** The cursor's one leaf, `.llmwiki/rule-state.json`, as the bodies ask it. No member takes a project root. */
export interface RuleStateLeaf {
  /** Whether anything is at the leaf (following links). */
  present(): Promise<boolean>;
  /** The leaf's whole text; rejects when it cannot be read. */
  readText(): Promise<string>;
  /** Replace the leaf with `text`, atomically. */
  replace(text: string): Promise<void>;
}

/** LOCAL DISK. The incumbent presence look, read and hardened replacement for `root`'s cursor leaf, each called when asked. */
function diskRuleStateLeaf(root: string): RuleStateLeaf {
  const filePath = path.join(root, RULE_STATE_FILE);
  return {
    present: async () => locationExistsSync(filePath),
    readText: () => readLocationText(filePath),
    replace: (text) => replaceLeafAtomicWithin(root, filePath, text),
  };
}

/** A fresh, empty rule-extraction state. */
function emptyRuleState(): RuleState {
  return { version: 1, indexHash: "", sources: {} };
}

/**
 * Read `.llmwiki/rule-state.json`, returning an empty state when it is missing
 * or unreadable (a corrupt cursor must never block extraction — it just means
 * everything looks new).
 * @param root - Project root directory.
 */
export async function readRuleState(root: string): Promise<RuleState> {
  return readRuleStateFrom(diskRuleStateLeaf(root));
}

/** {@link readRuleState} over {@link RuleStateLeaf}: THE ONE BODY. Absent, unreadable or unparsable is an empty cursor. */
export async function readRuleStateFrom(leaf: RuleStateLeaf): Promise<RuleState> {
  if (!(await leaf.present())) return emptyRuleState();
  try {
    return JSON.parse(await leaf.readText()) as RuleState;
  } catch {
    return emptyRuleState();
  }
}

/**
 * Record that a source was processed by rule extraction at the given hash, so
 * a subsequent `rules extract` skips it until the source or language changes.
 * @param root - Project root directory.
 * @param sourceFile - Source filename within `sources/`.
 * @param entry - The source's hash, selected language and processing timestamp.
 */
export async function updateRuleSourceState(
  root: string,
  sourceFile: string,
  entry: RuleSourceState,
): Promise<void> {
  return updateRuleSourceStateFrom(diskRuleStateLeaf(root), sourceFile, entry);
}

/**
 * {@link updateRuleSourceState} over {@link RuleStateLeaf}: THE ONE BODY. Read the
 * cursor afresh, set this source's entry, and replace the leaf atomically (on
 * disk, the shared hardened {@link replaceLeafAtomicWithin}: random O_EXCL temp +
 * rename, with its leaf-symlink write-escape defenses).
 */
export async function updateRuleSourceStateFrom(leaf: RuleStateLeaf, sourceFile: string, entry: RuleSourceState): Promise<void> {
  const state = await readRuleStateFrom(leaf);
  state.sources[sourceFile] = entry;
  await leaf.replace(JSON.stringify(state, null, 2));
}
