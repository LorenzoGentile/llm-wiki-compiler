/**
 * @file test/storage/fs-taps.ts
 * @description The one `fs` module tap the disk-call suites (`project-lock-binding`,
 * `reset-disk-calls`) install through `vi.mock`. A suite imports this module
 * DYNAMICALLY inside one hoisted block, so the mocks stay hoisted above every
 * import, and binds its own hoisted trace state once with {@link fsTapper}: what a
 * call notes and any fault it answers with stay the suite's, stated where they are
 * asserted. Each of the suite's `vi.mock` factories then taps its module with the
 * one bound tapper.
 *
 * This module imports nothing, so loading it inside an `fs` mock factory cannot
 * cycle back through `fs`.
 */

/** What a tap does with one call of a tapped function. */
interface FsTapHooks {
  /** Note one call of `name` with its arguments (a suite notes only while its trace is on). */
  note(name: string, args: unknown[]): void;
  /** An answer to return INSTEAD of calling the real function, or `undefined` to call it. Asked after `note`. */
  answer?(name: string, args: unknown[]): unknown;
}

/** A copy of one `fs` module object whose `names` are tapped through `hooks`, as named exports and on `default`. */
function tappedModule<T extends object>(actual: T, names: readonly string[], hooks: FsTapHooks): T {
  const real = actual as unknown as Record<string, (...args: unknown[]) => unknown>;
  const tap = (name: string) => (...args: unknown[]): unknown => {
    hooks.note(name, args);
    const answered = hooks.answer?.(name, args);
    return answered !== undefined ? answered : real[name]!(...args);
  };
  const wrapped = Object.fromEntries(names.map((name) => [name, tap(name)]));
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
}

/** One suite's tapper: `hooks` bound once, then applied to each `fs` module object a `vi.mock` factory loads. */
export function fsTapper(hooks: FsTapHooks): <T extends object>(actual: T, names: readonly string[]) => T {
  return (actual, names) => tappedModule(actual, names, hooks);
}
