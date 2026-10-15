/**
 * @file src/portable/contracts.ts
 * @description The two shared vocabularies the registered-project gate needs:
 * the permissions a project control record grants, and the closed refusal codes
 * a portable refusal carries.
 *
 * Public builds ship only the read side of the portable path: the gate that
 * refuses ordinary mutations of a registered project while a publication
 * intent is unresolved. Registration, publication and hosting are not shipped,
 * so only the shapes that gate reads or reports live here. Changing a code or a
 * permission name is a format change for any existing registration.
 */

/** The verbs the prototype checks. Deferred domains have no verb here on purpose. */
export type Permission =
  | "project.open" | "page.read" | "page.list" | "source.read" | "source.write"
  | "query.run" | "model.invoke" | "export.run" | "compile.propose"
  | "candidate.read" | "candidate.approve" | "publication.apply"
  | "operation.read" | "operation.resolve" | "ticket.issue" | "project.admin";

/** Why an operation left no effect. */
const REFUSAL_CODES = [
  "stale_read_set", "target_precondition_failed", "policy_changed",
  "approval_invalid", "approval_reserved", "approval_consumed", "ticket_invalid",
  "candidate_drift", "permission_denied", "capability_unsupported",
  "operation_unsupported_on_portable_path", "limit_exceeded", "preimage_unavailable",
  "supersedes_invalid", "recovery_blocking", "recovered_no_effect",
  "publication_in_progress", "floor_blocked",
] as const;

/** One of the closed refusal codes. The list above is the set a client recognizes on the wire. */
export type RefusalCode = (typeof REFUSAL_CODES)[number];
