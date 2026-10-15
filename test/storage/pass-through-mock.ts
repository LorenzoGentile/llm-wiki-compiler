/**
 * @file test/storage/pass-through-mock.ts
 * @description The pass-through module mock the whole-consumer binding suites use
 * to show that a ROOT route still reaches its root-taking functions and a BOUND
 * route reaches none (`context-pack-binding.test.ts`,
 * `query-answer-binding.test.ts`).
 *
 * `vi.mock(path, (original) => passThrough(name)(original))` keeps every export
 * of the module real and wraps the one named export in a `vi.fn` that calls the
 * real function, so the suite can count its calls without changing what it does.
 * The hoisted `vi.mock` call runs BEFORE any import is initialized, so a suite
 * must name `passThrough` only inside the factory BODY (which runs when the
 * mocked module is first imported, after this module, imported first, is
 * ready), never as the factory argument itself.
 */

import { vi } from "vitest";

/** A `vi.mock` factory: the real module, with export `name` wrapped in a pass-through spy. */
export function passThrough(name: string) {
  return async (original: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    const actual = await original();
    return { ...actual, [name]: vi.fn(actual[name] as (...args: never[]) => unknown) };
  };
}
