/**
 * @file test/embeddings-disabled.test.ts
 * @description Environment opt-out coverage for all shared embedding refresh callers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { mkdtemp } from "fs/promises";
import { refreshEmbeddingsDrainingPending } from "../src/utils/embeddings-refresh.js";
import { ENV_EMBEDDINGS, PENDING_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import * as embeddings from "../src/utils/embeddings.js";
import * as output from "../src/utils/output.js";
import type { PageId } from "../src/utils/page-id.js";

const PAGE_ID = "concepts/alpha" as PageId;
const PENDING_CONTENT = '[{"pageId":"concepts/prior","attempts":2}]\n';
let root = "";
let originalEmbeddingsSetting: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "embeddings-disabled-"));
  originalEmbeddingsSetting = process.env[ENV_EMBEDDINGS];
  delete process.env[ENV_EMBEDDINGS];
  vi.spyOn(output, "verbose").mockImplementation(() => {});
});

afterEach(async () => {
  if (originalEmbeddingsSetting === undefined) delete process.env[ENV_EMBEDDINGS];
  else process.env[ENV_EMBEDDINGS] = originalEmbeddingsSetting;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Return the path to the durable pending-embeddings marker. */
function pendingPath(): string {
  return path.join(root, PENDING_EMBEDDINGS_FILE);
}

/** Exercise an enabled refresh and report its provider call. */
async function expectRefreshRuns(value: string | undefined): Promise<void> {
  if (value === undefined) delete process.env[ENV_EMBEDDINGS];
  else process.env[ENV_EMBEDDINGS] = value;
  const provider = vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockResolvedValue({
    embedded: [PAGE_ID],
    eligible: [PAGE_ID],
  });

  await refreshEmbeddingsDrainingPending(root, [PAGE_ID]);

  expect(provider).toHaveBeenCalledOnce();
}

describe("LLMWIKI_EMBEDDINGS", () => {
  it("leaves pending state untouched and calls no provider when set to off", async () => {
    await mkdir(path.dirname(pendingPath()), { recursive: true });
    await writeFile(pendingPath(), PENDING_CONTENT, "utf-8");
    process.env[ENV_EMBEDDINGS] = " OfF ";
    const provider = vi.spyOn(embeddings, "updateEmbeddingsLockedCore");

    await refreshEmbeddingsDrainingPending(root, [PAGE_ID]);

    expect(provider).not.toHaveBeenCalled();
    expect(await readFile(pendingPath(), "utf-8")).toBe(PENDING_CONTENT);
    expect(output.verbose).toHaveBeenCalledWith(expect.stringContaining("LLMWIKI_EMBEDDINGS=off"));
  });

  it("preserves embedding refresh when unset", async () => {
    await expectRefreshRuns(undefined);
  });

  it("preserves embedding refresh for values other than off", async () => {
    await expectRefreshRuns("on");
  });
});
