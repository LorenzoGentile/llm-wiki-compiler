/**
 * @file test/storage/journal-paths.ts
 * @description The path spellings and the one confinement check the journal and
 * page binding suites (`journal-batch`, `journal-restore`, `journal-replay`,
 * `page-apply`) share over their memory projects.
 *
 * - {@link target} / {@link rootShown}: a journal entry's target as JSON writes
 *   it, and a text with its root shown as `<root>`.
 * - {@link toReal} / {@link realKey} / {@link aliasShown}: the realpath-aware
 *   suites' memory project, where {@link MEM_ROOT} is an alias of {@link MEM_REAL}.
 * - {@link confinedUnder}: the confinement a memory `confineTarget` applies.
 *
 * Each suite keeps its own log lines, faults and assertions; nothing here logs.
 */

import path from "node:path";

/** The memory project's root as callers name it. */
export const MEM_ROOT = path.resolve("/memory/project");
/** The real directory {@link MEM_ROOT} resolves to, in the realpath-aware suites. */
export const MEM_REAL = path.resolve("/memory/real/project");

/** A native path in POSIX spelling. */
export const posix = (native: string): string => native.split(path.sep).join("/");

/** A target under `<root>`, joined natively and escaped as `JSON.stringify` writes it inside a string. */
export const target = (...parts: string[]): string => JSON.stringify(["<root>", ...parts].join(path.sep)).slice(1, -1);
/** `text` with `root` (in its JSON-escaped spelling) shown as `<root>`; nothing else is rewritten. */
export const rootShown = (text: string, root: string): string => text.split(JSON.stringify(root).slice(1, -1)).join("<root>");

/** A path under {@link MEM_ROOT} moved onto {@link MEM_REAL}; any other path unchanged. */
export const toReal = (p: string): string => (p === MEM_ROOT || p.startsWith(MEM_ROOT + path.sep) ? MEM_REAL + p.slice(MEM_ROOT.length) : p);
/** The POSIX key of an absolute memory path, relative to the real root, through the alias. */
export const realKey = (abs: string): string => posix(path.relative(MEM_REAL, toReal(abs)));
/** A memory path as a log shows it: `<real>…` under the real root, `<root>…` under the alias, else POSIX. */
export const aliasShown = (p: string): string =>
  (p.startsWith(MEM_REAL) ? `<real>${posix(p.slice(MEM_REAL.length))}` : p.startsWith(MEM_ROOT) ? `<root>${posix(p.slice(MEM_ROOT.length))}` : posix(p));

/** `targetPath` resolved under `root`, refusing a target whose relative path escapes it; the refusal spells the target through `shown`. */
export function confinedUnder(root: string, targetPath: string, shown: (p: string) => string = (p) => p): string {
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`escapes: ${shown(targetPath)}`);
  return resolved;
}
