/**
 * @file test/storage/preparation-key-run-doubles.ts
 * @description The two in-memory doubles that BOTH preparation seams ask for:
 * the key-epoch read and the run read. The run lookup
 * (`preparation-run-lookup-binding.test.ts`) and the inventory scan
 * (`preparation-inventory-binding.test.ts`) each declare their own reads
 * interface, and both interfaces contain these two reads with the same shape.
 * Their doubles had the same job in both files, so that job is named once here.
 *
 * WHAT THE DOUBLES DO. Each logs its call, then returns the answer the case
 * scripted, or a plain ok answer when the case scripted none. They decide
 * nothing, hold no project root and touch no file.
 *
 * WHAT THEY ARE NOT. They are NOT evidence of authentication or of key health:
 * on disk the run read authenticates the leaf against the key and the key read
 * refuses an unhealthy key file; these answer `ok` for whatever they are given.
 * The key answer's type has no field for key bytes; that is a fact about the
 * type, not something a double can show about the disk.
 *
 * This is not a general test framework: it holds these two doubles and the one
 * epoch constant they answer with, and nothing else.
 */

import type { PreparationKeyEpochRead } from "../../src/preparations/key-epoch.js";
import type { PreparationRunRead } from "../../src/preparations/run-store.js";
import type { PreparationRunBinding, PreparationRunV1 } from "../../src/preparations/run-types.js";

/** The one key epoch every unscripted ok key answer carries. */
export const EPOCH = `sha256:${"e".repeat(64)}` as PreparationRunBinding["keyEpochId"];

/** What a case may script for the key read and the run read. */
export interface KeyAndRunScript {
  key?: PreparationKeyEpochRead;
  run?: PreparationRunRead;
  /** Runs inside the key read, before it answers. */
  duringKeyRead?: () => void;
}

/** The two reads, in the shape both seams declare them. */
interface KeyAndRunReads {
  readKeyEpoch(): Promise<PreparationKeyEpochRead>;
  readRun(binding: PreparationRunBinding): Promise<PreparationRunRead>;
}

/**
 * The key-epoch and run doubles over `script`. Each appends its call to `log`
 * before it answers; an unscripted run read answers ok with `defaultRun`.
 */
export function keyAndRunDoubles(
  log: unknown[][], script: KeyAndRunScript, defaultRun: PreparationRunV1,
): KeyAndRunReads {
  return {
    readKeyEpoch: async () => {
      log.push(["key"]);
      script.duringKeyRead?.();
      return script.key ?? { status: "ok", keyEpochId: EPOCH };
    },
    readRun: async (binding) => {
      log.push(["run", binding]);
      return script.run ?? { status: "ok", run: defaultRun };
    },
  };
}
