/**
 * @file test/storage/compiled-seed.ts
 * @description The small pieces the compiled-project binding suites seed with:
 * a source text whose hash the state records as current, a page with given
 * frontmatter, and one compiled source entry in the state schema's own shape
 * (`hash`, `concepts`, `compiledAt`; an entry without `compiledAt` classifies
 * the whole state as corrupt).
 *
 * Each suite keeps its own project layout and expectations; this holds no
 * policy. Hash a text with `sha256Hex` from `test/fixtures/state-json.ts`.
 */

/** A source text the seeded state records as unchanged (its hash is the recorded one). */
export const KEPT_TEXT = "Kept source.\n";

/** A page with `frontmatter` and a fixed body. */
export const page = (frontmatter: string): string => `---\n${frontmatter}\n---\n\nBody.\n`;

/** One compiled source entry as the state schema requires it. */
export const compiledEntry = (hash: string, concepts: string[], compiledAt = "2026-01-01T00:00:00.000Z") => ({ hash, concepts, compiledAt });
