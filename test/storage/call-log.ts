/**
 * @file test/storage/call-log.ts
 * @description One reader for the ORDERED CALL LOGS the storage binding tests
 * keep. Those tests run a real body over in-memory doubles, and each double
 * appends one entry per call to a shared log before it answers: the call's
 * kind first, then whatever arguments the test wants to assert. A case then
 * asserts WHICH reads the body made and IN WHAT ORDER.
 *
 * Reading the kinds back out of such a log is the same job in every one of
 * those tests, so it is named once here. It is used by
 * `preparation-record-reads-binding.test.ts`,
 * `preparation-inventory-binding.test.ts` and
 * `preparation-evidence-read-binding.test.ts`, the first two of which each had
 * their own identical copy.
 *
 * WHAT IT IS NOT. It decides nothing about any read, and it knows no shape
 * beyond "the first element of an entry is its kind". It is not a general test
 * framework: it holds {@link kindsOf} and {@link orderedStubs}, the recorder the
 * preparation root-form witnesses use to pin the order of incumbent calls.
 */

/**
 * The kinds of call in a log, in order: the first element of each entry.
 *
 * @param log - The entries a test's doubles appended, one per call.
 * @returns Each entry's kind, in the order the calls were made.
 */
export function kindsOf(log: readonly unknown[][]): unknown[] {
  return log.map((call) => call[0]);
}

/**
 * A shared order log and its stub maker: `note(name, value)` is an async stub
 * that appends `name` to `order` when called and resolves `value`. Used as a
 * spy's implementation, it pins WHICH incumbents a root form reached, in order.
 *
 * @returns The order log and the stub maker that writes to it.
 */
export function orderedStubs(): { order: string[]; note: <T>(name: string, value: T) => () => Promise<T> } {
  const order: string[] = [];
  return { order, note: <T>(name: string, value: T) => async () => { order.push(name); return value; } };
}
