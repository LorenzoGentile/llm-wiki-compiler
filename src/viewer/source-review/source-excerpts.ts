/**
 * Request-scoped, bounded source excerpts using the viewer's confined reader.
 * Only show bytes agreeing with this observation's source hash; old source
 * versions are not reconstructed from hashes or mistaken for retained text.
 *
 * ONE BODY. {@link sourceExcerptReaderFrom} owns the memo, the read ceiling,
 * the hash agreement and the excerpt over ONE source read; {@link sourceExcerptReader}
 * keeps its signature and reads through the incumbent `readViewerSource(root, …)`
 * at call time.
 */
import { createHash } from "node:crypto";
import { readViewerSource } from "../../viewer/source-access.js";

const MAX_READS = 100;
const MAX_CHARACTERS = 12_000;
const MAX_LINES = 200;
interface Excerpt { status: string; text?: string; truncated?: boolean; lineCount?: number }
/** One observed source's viewer read (always with its body), as `readViewerSource` answers it. */
type ReadSource = (file: string) => ReturnType<typeof readViewerSource>;

/** Memoize each observed source once and enforce a whole-request read ceiling. */
export function sourceExcerptReader(root: string, filenames: string[]) {
  return sourceExcerptReaderFrom((file) => readViewerSource(root, filenames, file, true));
}

/** {@link sourceExcerptReader} over `readSource`: THE ONE BODY. */
export function sourceExcerptReaderFrom(readSource: ReadSource) {
  const reads = new Map<string, Promise<Excerpt>>();
  return (file: string, expectedHash: string | null): Promise<Excerpt> => {
    const cached = reads.get(file);
    if (cached) return cached;
    if (reads.size >= MAX_READS) return Promise.resolve({ status: "preview limit reached" });
    const pending = readExcerpt(readSource, file, expectedHash);
    reads.set(file, pending);
    return pending;
  };
}

/** Refuse mismatched or unverified bytes rather than coupling them to old hashes. */
async function readExcerpt(readSource: ReadSource, file: string, expectedHash: string | null): Promise<Excerpt> {
  if (!expectedHash) return { status: "unavailable" };
  try {
    const read = await readSource(file);
    if (read.health !== "ok" || typeof read.body !== "string") return { status: String(read.health ?? "unavailable") };
    const hash = createHash("sha256").update(read.body).digest("hex");
    if (hash !== expectedHash) return { status: "changed during this check; check files again" };
    return excerpt(read.body);
  } catch { return { status: "unavailable" }; }
}

/** Preserve physical line numbers and visibly bound both long lines and documents. */
function excerpt(body: string): Excerpt {
  const lines = body.slice(0, MAX_CHARACTERS).split("\n");
  const shown = lines.slice(0, MAX_LINES);
  return { status: "available", text: shown.map((line, i) => `${i + 1}  ${line}`).join("\n"),
    lineCount: shown.length, truncated: body.length > MAX_CHARACTERS || lines.length > MAX_LINES };
}
