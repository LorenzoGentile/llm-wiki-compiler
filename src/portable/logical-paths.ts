/**
 * @file src/portable/logical-paths.ts
 * @description The one rule a portable record id must satisfy before it becomes
 * a path segment.
 *
 * The registered-project gate scans the publication ledger by operation id;
 * every id is checked here before `disk-layout.ts` turns it into a file name,
 * so a hostile or malformed id can never address anything outside its ledger
 * directory.
 */

/** An operation or record id as it appears in a logical path. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/;

/** True when `id` can be used as one path segment of a record address. */
export function isSafeRecordId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..");
}
