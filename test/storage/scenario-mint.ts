/**
 * @file test/storage/scenario-mint.ts
 * @description The scenario scaffolding the copied-project binding suites share.
 * Each suite mints every named scenario once on a real disk (in the scenario
 * record's key order), keeps the copy each minting left behind, and removes
 * every minting directory before any test runs. It then settles scripted steps
 * in order, exactly once each, rendering each outcome as text so the disk run and
 * the in-memory run can be compared literally.
 *
 * Only the scaffolding is shared. Every suite keeps its own scenarios, steps,
 * memory doubles and assertions; nothing here decides what a step means.
 */

import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { mintCopied, mintCopiedBeforeAsk, mintOnceThenRemove, writeFiles, type Copy, type Minted } from "./copied-project.js";
import { tempRootTracker, type TempRootTrackerV1 } from "../temp-roots.js";

/** A rejection as an outcome shows it: the error's name and message. */
export const failureText = (error: Error): string => `${error.name}: ${error.message}`;

/** Settle `pending` once: a fulfilment as its JSON text, a rejection as {@link failureText}. */
const settledJson = (pending: Promise<unknown>): Promise<string> => pending.then((value) => JSON.stringify(value), failureText);

/** Settle each step in order, exactly once, each through {@link settledJson}; a later step starts only after the earlier settled. */
export async function settleInOrder<Step>(steps: readonly Step[], run: (step: Step) => Promise<unknown>): Promise<string[]> {
  const outcomes: string[] = [];
  for (const step of steps) outcomes.push(await settledJson(run(step)));
  return outcomes;
}

/**
 * Mint every scenario in `names` order, once, before the suite, through the
 * shared once-then-remove hooks registered where this is called. The returned
 * record fills in as each scenario is minted.
 *
 * @param names - The scenario names, in minting order.
 * @param mint - Mints one scenario with the suite's tracker.
 */
export function mintEachScenario<Name extends string, Answer>(
  names: readonly Name[], mint: (tracker: TempRootTrackerV1, name: Name) => Promise<Minted<Answer>>,
): Partial<Record<Name, Minted<Answer>>> {
  const tracker = tempRootTracker();
  const minted: Partial<Record<Name, Minted<Answer>>> = {};
  mintOnceThenRemove(tracker, async () => {
    for (const name of names) minted[name] = await mint(tracker, name);
  });
  return minted;
}

/** A scenario's seed: the files to write under the root, or a function that writes the project. */
type ScenarioSeed = Readonly<Record<string, string>> | ((root: string) => Promise<void>);

/**
 * {@link mintEachScenario} over a scenario record whose entries carry their own
 * `seed`: each project is seeded, then asked (`ask`) and copied. `copyFirst`
 * copies the SEEDED tree before the ask, for an ask that writes; otherwise the
 * copy is taken after the ask, of what the ask left.
 *
 * @param prefix - The suite's minting-directory prefix.
 * @param scenarios - The scenarios, minted in key order.
 * @param ask - The disk consumer's answer for one minted project.
 * @param copyFirst - Whether to copy before asking.
 */
export function mintSeededScenarios<Name extends string, Answer>(
  prefix: string, scenarios: Record<Name, { seed: ScenarioSeed }>, ask: (root: string, name: Name) => Promise<Answer>, copyFirst = false,
): Partial<Record<Name, Minted<Answer>>> {
  return mintEachScenario(Object.keys(scenarios) as Name[], (tracker, name) => {
    const seed = scenarios[name].seed;
    const write = (root: string): Promise<void> => (typeof seed === "function" ? seed(root) : writeFiles(root, seed as Record<string, string>));
    return copyFirst ? mintCopiedBeforeAsk(tracker, prefix, write, (root) => ask(root, name)) : mintCopied(tracker, prefix, write, (root) => ask(root, name));
  });
}

/** Every minting directory carries `prefix` and is gone; then each named copy passes the suite's own seed check. */
export function expectMintsRemovedThenSeeded<Name extends string>(
  minted: Partial<Record<Name, Minted<unknown>>>, prefix: string, names: readonly Name[], seededCopy: (name: Name) => Copy,
): void {
  for (const one of Object.values(minted) as (Minted<unknown> | undefined)[]) expectMintingDirectoryRemoved(one!.dir, prefix);
  for (const name of names) seededCopy(name);
}
