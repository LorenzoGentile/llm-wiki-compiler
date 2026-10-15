/**
 * @file test/fixtures/t1-journey.ts
 * @description The ONE driver behind the transparent-disk (lane T, T1)
 * compatibility witnesses.
 *
 * It seeds an ordinary, unregistered local wiki, runs a named scenario of the
 * review journey against a BUILT distribution chosen by the caller, and returns
 * an observation: each command's exit code and output, a SHA-256 for every
 * resulting file, and a digest of every provider request in arrival order.
 *
 * The same driver is run against a build of the pinned incumbent and against
 * the candidate build, so the two observations are comparable by equality. It
 * imports nothing from `src/`, so it cannot make the two sides agree by sharing
 * code with one of them. Model answers come from the local aimock server.
 *
 * Each command runs in an ISOLATED environment built by
 * {@link journeyEnvironment}: nothing is inherited from the caller except the
 * search path, and chat AND embedding provider, model, endpoint and key are all
 * bound to this scenario's local mock, so no inherited variable can send a
 * call anywhere else.
 *
 * Generated metadata is tokenized position by position in
 * `t1-journey-compare.ts`; everything else, including provider requests, is
 * compared byte for byte.
 */

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startMockClaude, stopMockClaude, type MockClaudeHandle } from "./aimock-helper.js";
import {
  comparableFile, comparableLink, comparableOutput, comparablePath,
  EMBEDDING_BACKEND, EMBEDDING_MODEL, sha256, type RunIdentity,
} from "./t1-journey-compare.js";

const exec = promisify(execFile);

/** A built distribution to drive: its CLI and its package entry. */
export interface JourneyTarget {
  cli: string;
  sdk: string;
}

/** The scenarios the witnesses cover. */
export const T1_SCENARIOS = [
  "cli-journey", "sdk-review-compile", "lock-held", "pending-journal",
  "escaping-page-link", "linked-sources", "linked-root",
] as const;
export type T1Scenario = (typeof T1_SCENARIOS)[number];

/** One command's outcome. */
interface StepObservation {
  step: string;
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything one scenario left behind. */
export interface JourneyObservation {
  steps: StepObservation[];
  /** Project-relative path to SHA-256 of its bytes, or `link:<target>`. */
  files: Record<string, string>;
  /** SHA-256 of each provider request body, in arrival order. */
  requests: string[];
  /** How many of those requests carried the hand-edited page's marker text. */
  requestsCarryingHandEdit: number;
}

/** Text only the hand-edited page contains, so a prompt that carries it read that page. */
const HAND_EDIT_MARKER = "HAND-EDIT-MARKER";

/** The concept the canned model returns. It is the hand-edited page's own title, so the compile regenerates that page. */
const REGENERATED_CONCEPT = "Existing Topic";

/**
 * Prose that only LOOKS like generated metadata: a clock reading and a
 * candidate id. It is seeded into a source and into the generated page body so
 * the recording itself proves such text is compared, not tokenized.
 */
const LOOKALIKE_PROSE = "The event of 2026-01-01T01:02:03.000Z is filed as existing-topic-12345678.";

const HAND_EDITED_PAGE = [
  "---", `title: ${REGENERATED_CONCEPT}`, "summary: Written by hand.", "---", "",
  `A page a person edited by hand. ${HAND_EDIT_MARKER} stays exactly as typed.`, "",
].join("\n");

/** The key the mock accepts; it authenticates nothing. */
const MOCK_KEY = "mock-key-for-aimock";

/**
 * The complete environment of every command a scenario runs.
 *
 * Only the search path comes from the caller. Provider selection, model,
 * endpoint and key are stated for chat and, separately, for embeddings, using
 * the most specific variable the compiler honours for each, so an inherited
 * `LLMWIKI_EMBEDDING_PROVIDER`, `OPENAI_EMBEDDINGS_BASE_URL` or key cannot
 * redirect a call. `HOME` is a directory inside the run's temp directory.
 *
 * @param endpoint - The scenario's mock endpoint, `http://127.0.0.1:<port>/v1`.
 * @param home - An empty directory to stand in for the user's home.
 */
export function journeyEnvironment(endpoint: string, home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    LLMWIKI_PROVIDER: "openai",
    LLMWIKI_MODEL: "gpt-4o",
    OPENAI_BASE_URL: endpoint,
    OPENAI_API_KEY: MOCK_KEY,
    LLMWIKI_EMBEDDING_PROVIDER: EMBEDDING_BACKEND,
    LLMWIKI_EMBEDDING_MODEL: EMBEDDING_MODEL,
    OPENAI_EMBEDDINGS_BASE_URL: endpoint,
    OPENAI_EMBEDDINGS_API_KEY: MOCK_KEY,
  };
}

/** Program the mock's two answers: one concept per source, and a page body carrying the look-alike prose. */
function stubModel(handle: MockClaudeHandle): void {
  const concept = { concept: REGENERATED_CONCEPT, summary: `Concept emitted by aimock for ${REGENERATED_CONCEPT}.`, is_new: true, tags: ["canned"], confidence: 0.9 };
  handle.mock.onToolCall("extract_concepts", { toolCalls: [{ name: "extract_concepts", arguments: { concepts: [concept] } }] });
  handle.mock.onMessage(/.*/u, { content: `Page body produced for ${REGENERATED_CONCEPT}. ${LOOKALIKE_PROSE}` });
}

const COMPILE_REVIEW = ["compile", "--review", "--concurrency", "1"];

/** The pre-operation bytes every scenario starts from. */
async function seedProject(root: string): Promise<void> {
  const files: Record<string, string> = {
    "sources/alpha.md": `# Alpha\n\nAlpha describes the first idea. ${LOOKALIKE_PROSE}\n`,
    "sources/beta.md": "# Beta\n\nBeta describes the second idea. Ünïcode stays.\n",
    "sources/skip.md": "# Skip\n\nExcluded by configuration.\n",
    ".llmwiki/config.json": `${JSON.stringify({ version: 1, sources: { exclude: ["skip.md"] } })}\n`,
    "wiki/concepts/existing-topic.md": HAND_EDITED_PAGE,
    "wiki/concepts/untouched-page.md": "---\ntitle: Untouched Page\nsummary: Never regenerated.\n---\n\nLeft alone.\n",
    "wiki/index.md": "# Index\n\n- [[existing-topic|Existing Topic]]\n- [[untouched-page|Untouched Page]]\n",
  };
  for (const [relative, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), body, "utf-8");
  }
}

/** What a scenario needs to run: where, against what, and how to reach the model. */
interface Run {
  root: string;
  outside: string;
  target: JourneyTarget;
  env: NodeJS.ProcessEnv;
  steps: StepObservation[];
  /** Ids of candidates this run generated, as the store named their files. */
  candidateIds: string[];
}

/** Run one command and record its outcome; a non-zero exit is an outcome, not a throw. */
async function step(run: Run, name: string, file: string, args: string[], cwd = run.root): Promise<void> {
  const outcome = await exec(process.execPath, [file, ...args], { cwd, env: run.env }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "",
    }),
  );
  run.steps.push({ step: name, ...outcome });
}

/** Run one CLI command of the target build; `label` names the step when an argument is a generated id. */
function cli(run: Run, args: string[], cwd?: string, label = args.join(" ")): Promise<void> {
  return step(run, label, run.target.cli, args, cwd);
}

/** Note the ids of the candidates now pending, read from the store's own file names. */
async function notePendingCandidates(run: Run): Promise<void> {
  const names = await readdir(path.join(run.root, ".llmwiki", "candidates")).catch(() => []);
  const ids = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
  run.candidateIds.push(...ids.filter((id) => !run.candidateIds.includes(id)));
}

/** Open, review-mode compile, inspect, approve, reopen. */
async function cliJourney(run: Run): Promise<void> {
  await cli(run, COMPILE_REVIEW);
  await notePendingCandidates(run);
  const [id] = run.candidateIds;
  await cli(run, ["review", "list"]);
  await cli(run, ["review", "show", id], undefined, "review show <candidate>");
  await cli(run, ["review", "approve", id], undefined, "review approve <candidate>");
  await cli(run, ["status"]);
  await cli(run, COMPILE_REVIEW);
}

/** The SDK consumer: `createWiki({ root }).compile({ review: true })` from the built entry. */
async function sdkReviewCompile(run: Run): Promise<void> {
  const script = [
    `const { createWiki } = await import(${JSON.stringify(run.target.sdk)});`,
    `const result = await createWiki({ root: ${JSON.stringify(run.root)} }).compile({ review: true, concurrency: 1 });`,
    "console.log(JSON.stringify(result));",
  ].join("\n");
  await step(run, "sdk compile({review:true})", "--input-type=module", ["-e", script]);
}

/** Per-scenario setup beyond the common seed, then the commands to run. */
const SCENARIOS: Record<T1Scenario, (run: Run) => Promise<void>> = {
  "cli-journey": cliJourney,
  "sdk-review-compile": sdkReviewCompile,
  "lock-held": async (run) => {
    await writeFile(path.join(run.root, ".llmwiki", "lock"), String(process.pid), "utf-8");
    await cli(run, COMPILE_REVIEW);
  },
  "pending-journal": async (run) => {
    const page = path.join(run.root, "wiki", "concepts", "existing-topic.md");
    await writeFile(page, "HALF-WRITTEN", "utf-8");
    const batch = { batchId: "interrupted", status: "pending", entries: [{ targetPath: page, preState: { absent: false, content: HAND_EDITED_PAGE } }] };
    await mkdir(path.join(run.root, ".llmwiki", "journal"), { recursive: true });
    await writeFile(path.join(run.root, ".llmwiki", "journal", "interrupted.json"), JSON.stringify(batch), "utf-8");
    await cli(run, COMPILE_REVIEW);
  },
  "escaping-page-link": async (run) => {
    await writeFile(path.join(run.outside, "secret.md"), "---\ntitle: Outside Secret\n---\nOUTSIDE-BYTES\n", "utf-8");
    await symlink(path.join(run.outside, "secret.md"), path.join(run.root, "wiki", "concepts", "escape.md"));
    await cli(run, COMPILE_REVIEW);
  },
  "linked-sources": async (run) => {
    await rm(path.join(run.root, "sources"), { recursive: true });
    await writeFile(path.join(run.outside, "foreign.md"), "# Foreign\n\nNot a project source.\n", "utf-8");
    await symlink(run.outside, path.join(run.root, "sources"));
    await cli(run, COMPILE_REVIEW);
  },
  "linked-root": async (run) => {
    const alias = path.join(run.outside, "alias");
    await symlink(run.root, alias);
    await cli(run, COMPILE_REVIEW, alias);
  },
};

/** Every file under the project, as comparable path to digest of its comparable text; links are named, not followed. */
async function digestTree(identity: RunIdentity, root: string, relative = ""): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const child = relative ? `${relative}/${name}` : name;
    const stat = await lstat(path.join(root, child));
    if (stat.isDirectory()) Object.assign(found, await digestTree(identity, root, child));
    else if (stat.isSymbolicLink()) found[child] = `link:${comparableLink(await readlink(path.join(root, child)), identity)}`;
    else found[comparablePath(child)] = sha256(comparableFile(child, await readFile(path.join(root, child), "utf-8"), identity));
  }
  return found;
}

/** Each provider request body as text, in the order the mock received them. */
function requestBodies(handle: MockClaudeHandle): string[] {
  return handle.mock.getRequests().map((request) => JSON.stringify(request.body));
}

/** What one finished run left behind, in comparable form. */
async function observe(run: Run, identity: RunIdentity, handle: MockClaudeHandle): Promise<JourneyObservation> {
  const bodies = requestBodies(handle);
  return {
    steps: run.steps.map((taken) => ({
      step: taken.step, code: taken.code,
      stdout: comparableOutput(taken.stdout, identity), stderr: comparableOutput(taken.stderr, identity),
    })),
    files: await digestTree(identity, run.root),
    requests: bodies.map(sha256),
    requestsCarryingHandEdit: bodies.filter((body) => body.includes(HAND_EDIT_MARKER)).length,
  };
}

/**
 * Run one scenario against one built distribution.
 *
 * @param target - The distribution to drive.
 * @param scenario - Which part of the journey to run.
 * @returns The observation in comparable form.
 */
export async function observeJourney(target: JourneyTarget, scenario: T1Scenario): Promise<JourneyObservation> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-t1-")));
  const handle = await startMockClaude();
  try {
    const embeddingEndpoint = `${handle.url}/v1`;
    const home = path.join(base, "home");
    const run: Run = {
      root: path.join(base, "project"), outside: path.join(base, "outside"), target,
      env: journeyEnvironment(embeddingEndpoint, home), steps: [], candidateIds: [],
    };
    await mkdir(run.outside, { recursive: true });
    await mkdir(home, { recursive: true });
    await seedProject(run.root);
    stubModel(handle);
    await SCENARIOS[scenario](run);
    await notePendingCandidates(run);
    return await observe(run, { base, candidateIds: run.candidateIds, embeddingEndpoint, driverPid: process.pid }, handle);
  } finally {
    await stopMockClaude(handle);
    await rm(base, { recursive: true, force: true });
  }
}
