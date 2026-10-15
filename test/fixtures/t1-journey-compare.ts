/**
 * @file test/fixtures/t1-journey-compare.ts
 * @description How the transparent-disk (lane T, T1) journey driver turns what
 * one run left behind into text that two runs can be compared by equality.
 *
 * Nothing here is a pattern applied to arbitrary text. Each treatment names
 * ONE generated-metadata position in ONE known format and leaves every other
 * byte alone, so source prose, page prose, candidate body prose and stable
 * record data stay under comparison even when they look like a clock reading,
 * a candidate id or a path:
 *
 *  - clock readings: the named JSON keys of each record, the `createdAt` /
 *    `updatedAt` lines INSIDE a page's frontmatter block, and the index footer;
 *  - the random candidate id: the record's own `id` key and its file name, and
 *    only when the two agree;
 *  - the temp directory: the start of a link target and the approved-path line;
 *  - the embeddings fingerprint: a digest of backend, model and endpoint. The
 *    endpoint is this run's mock port, so the value is RECOMPUTED from that
 *    identity and replaced only on an exact match. A wrong or constant
 *    fingerprint throws instead of disappearing;
 *  - the driver's own process id, when it is the whole content of the lock.
 *
 * It imports nothing from `src/`.
 */

import { createHash } from "node:crypto";
import path from "node:path";

/** What is specific to one run and known to the driver that made it. */
export interface RunIdentity {
  /** The run's temp directory. */
  base: string;
  /** Ids of the candidates this run generated, read from the store's own file names. */
  candidateIds: readonly string[];
  /** The embedding endpoint the scenario bound its commands to. */
  embeddingEndpoint: string;
  /** The process id the driver wrote into the lock it planted. */
  driverPid: number;
}

/** The embedding backend and model every scenario pins. */
export const EMBEDDING_BACKEND = "openai";
export const EMBEDDING_MODEL = "text-embedding-3-small";

const TIME_TOKEN = "<TIME>";
const ID_TOKEN = "existing-topic-<ID>";
const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
const GENERATED_ID = /^existing-topic-[0-9a-f]{8}$/u;
const CANDIDATES_DIR = ".llmwiki/candidates";
const FRONTMATTER_TIME = new RegExp(String.raw`^((?:createdAt|updatedAt): ")${ISO}(")$`, "gmu");
const INDEX_FOOTER = new RegExp(String.raw`^(_\d+ pages \| Generated )${ISO}(_)$`, "mu");

/** SHA-256 hex of a string. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The fingerprint the compiler must stamp for this endpoint: backend, model and endpoint, NUL-separated. */
export function expectedEmbeddingFingerprint(endpoint: string): string {
  return sha256([EMBEDDING_BACKEND, EMBEDDING_MODEL, endpoint].join("\0"));
}

/** Replace `from` with `to`, requiring exactly one occurrence so a treatment can never silently miss or spread. */
function replaceOnce(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`expected exactly one ${JSON.stringify(from.slice(0, 60))}`);
  return text.replace(from, () => to);
}

/**
 * Tokenize clock readings held by the named keys of a pretty-printed JSON
 * record. Inside a JSON string every quote is escaped, so an unescaped
 * `"key": "` can only be a real key, never prose.
 */
function tokenizeJsonTimes(text: string, keys: readonly string[]): string {
  return text.replace(new RegExp(String.raw`("(?:${keys.join("|")})": ")${ISO}(")`, "gu"), `$1${TIME_TOKEN}$2`);
}

/** Tokenize `createdAt` / `updatedAt` inside a page's frontmatter block; the prose after it is untouched. */
export function tokenizeFrontmatterTimes(page: string): string {
  const block = /^---\n[\s\S]*?\n---\n/u.exec(page);
  if (block === null) return page;
  return block[0].replace(FRONTMATTER_TIME, `$1${TIME_TOKEN}$2`) + page.slice(block[0].length);
}

/** A candidate record: its clock keys, its own id, and the frontmatter clocks of the page it proposes. */
function comparableCandidate(stem: string, text: string): string {
  const record = JSON.parse(text) as { id?: unknown; body?: unknown };
  const withBody = typeof record.body === "string"
    ? replaceOnce(text, JSON.stringify(record.body), JSON.stringify(tokenizeFrontmatterTimes(record.body)))
    : text;
  const timed = tokenizeJsonTimes(withBody, ["generatedAt", "compiledAt"]);
  return record.id === stem && GENERATED_ID.test(stem) ? replaceOnce(timed, `"id": "${stem}"`, `"id": "${ID_TOKEN}"`) : timed;
}

/** The embeddings store: its clock keys, and its fingerprint only once it is proven to be this run's mock identity. */
function comparableEmbeddings(text: string, endpoint: string): string {
  const expected = expectedEmbeddingFingerprint(endpoint);
  const stored = (JSON.parse(text) as { fingerprint?: unknown }).fingerprint;
  if (stored !== expected) {
    throw new Error(`embeddings fingerprint ${String(stored)} is not ${expected}, the identity of ${EMBEDDING_BACKEND}/${EMBEDDING_MODEL} at ${endpoint}`);
  }
  return replaceOnce(tokenizeJsonTimes(text, ["updatedAt"]), `"fingerprint": "${expected}"`, '"fingerprint": "<MOCK-ENDPOINT-IDENTITY>"');
}

/**
 * The text of one project file as it is compared.
 *
 * @param relative - Project-relative path, `/`-joined.
 * @param text - The file's content.
 * @param identity - What is specific to the run that wrote it.
 */
export function comparableFile(relative: string, text: string, identity: RunIdentity): string {
  if (path.dirname(relative) === CANDIDATES_DIR) return comparableCandidate(path.basename(relative, ".json"), text);
  if (relative === ".llmwiki/embeddings.json") return comparableEmbeddings(text, identity.embeddingEndpoint);
  if (relative === ".llmwiki/state.json") return tokenizeJsonTimes(text, ["compiledAt"]);
  if (relative === ".llmwiki/lock") return text === String(identity.driverPid) ? "<DRIVER-PID>" : text;
  if (relative === "wiki/index.md") return text.replace(INDEX_FOOTER, `$1${TIME_TOKEN}$2`);
  if (path.dirname(relative) === "wiki/concepts") return tokenizeFrontmatterTimes(text);
  return text;
}

/** A project file's name as it is compared: only a generated candidate file name carries a random id. */
export function comparablePath(relative: string): string {
  const stem = path.basename(relative, ".json");
  const isGenerated = path.dirname(relative) === CANDIDATES_DIR && GENERATED_ID.test(stem);
  return isGenerated ? `${CANDIDATES_DIR}/${ID_TOKEN}.json` : relative;
}

/** A link target as it is compared: only a leading temp directory is replaced. */
export function comparableLink(target: string, identity: RunIdentity): string {
  return target.startsWith(`${identity.base}/`) ? `<BASE>${target.slice(identity.base.length)}` : target;
}

/** Replace every occurrence of a literal on one line. */
function replaceLiteral(line: string, literal: string, token: string): string {
  return line.split(literal).join(token);
}

/** Tokenize this run's generated candidate ids on a line known to print one. */
function withoutIds(line: string, identity: RunIdentity): string {
  return identity.candidateIds.reduce((kept, id) => replaceLiteral(kept, id, ID_TOKEN), line);
}

/** Tokenize a clock reading on a line known to print one. */
function withoutTime(line: string): string {
  return line.replace(new RegExp(ISO, "u"), TIME_TOKEN);
}

/**
 * The known output positions that print generated metadata, each matched by
 * the literal text (and colour codes) the command writes before it. A line
 * that matches none of them is compared as written.
 */
const OUTPUT_POSITIONS: ReadonlyArray<{ at: RegExp; treat: (line: string, identity: RunIdentity) => string }> = [
  { at: /^\? \u001b\[34mCandidate ready: /u, treat: withoutIds },
  { at: /^\? \u001b\[34mexisting-topic-[0-9a-f]{8}\u001b\[0m → /u, treat: (line, identity) => withoutTime(withoutIds(line, identity)) },
  { at: /^\u001b\[1mCandidate /u, treat: withoutIds },
  { at: /^✓ \u001b\[2mCandidate .* cleared\.\u001b\[0m$/u, treat: withoutIds },
  { at: /^i \u001b\[2m(?:generated: {2}|Last compiled: )/u, treat: withoutTime },
  { at: /^\+ \u001b\[32mApproved → /u, treat: (line, identity) => replaceLiteral(line, `${identity.base}/`, "<BASE>/") },
  { at: /^\{"compiled":/u, treat: (line, identity) => identity.candidateIds.reduce((kept, id) => replaceLiteral(kept, `"${id}"`, `"${ID_TOKEN}"`), line) },
];

/**
 * One command's output as it is compared. Besides the positions above, the
 * page `review show` prints has its frontmatter clocks tokenized, by the same
 * rule as the page file itself.
 */
export function comparableOutput(output: string, identity: RunIdentity): string {
  const pageAt = output.indexOf("\n---\n");
  const head = pageAt < 0 ? output : output.slice(0, pageAt + 1);
  const printedPage = pageAt < 0 ? "" : tokenizeFrontmatterTimes(output.slice(pageAt + 1));
  const treated = head.split("\n").map((line) => {
    const position = OUTPUT_POSITIONS.find((known) => known.at.test(line));
    return position === undefined ? line : position.treat(line, identity);
  });
  return treated.join("\n") + printedPage;
}
