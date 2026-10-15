/**
 * @file test/fixtures/no-binding-leaf-double.ts
 * @description The in-memory double for an active-product binding that has NO
 * binding leaf, shared by the storage suites that load a legacy profile over
 * in-memory sources (`typed-viewer-binding`, `profile-summary-binding`).
 *
 * It decides nothing. Each method logs its call through the caller's `note`
 * BEFORE it answers, under the group name `binding`, so a suite can assert one
 * shared, ordered log. The log lines are part of what those suites assert and
 * must not change: `binding.readBindingLeaf max=<n>` and
 * `binding.resolvePrivateDir`.
 *
 * It is not a hosted store, not an access-control layer and not `ProjectStore`.
 * It carries only the two methods a legacy-profile load calls; a suite that
 * needs the other binding reads builds its own double.
 */

/**
 * A binding with no leaf: the leaf read answers `absent` and the private
 * directory resolves to the fixed locator `mem:private`.
 *
 * @param note - Records one call line in the caller's shared log.
 * @returns The two binding reads a legacy-profile load makes, each logging first.
 */
export function noBindingLeafDouble(note: (call: string) => void) {
  return {
    readBindingLeaf: async (maxBytes: number) => { note(`binding.readBindingLeaf max=${maxBytes}`); return { kind: "absent" }; },
    resolvePrivateDir: async () => { note("binding.resolvePrivateDir"); return "mem:private"; },
  };
}
