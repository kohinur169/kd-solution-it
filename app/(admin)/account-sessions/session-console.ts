// path: app/(admin)/account-sessions/session-console.ts
import { z } from "zod";
import type { AuditTrail } from "../../../lib/auth/audit.ts";
import type { RestClient } from "../../../lib/auth/rest.ts";
import type { SessionTokenStore } from "../../../lib/auth/session-rotation.ts";
import {
  SESSION_MANAGEMENT_OFFICE_ROLES,
  listAccountSessions,
  type SessionView,
} from "../../../lib/auth/session-list.ts";
import { requireAnyRole } from "../../../lib/auth/session.ts";
import type { RequestActor } from "../../../lib/auth/types.ts";
import { AppError } from "../../../lib/errors/app-error.ts";

/**
 * The account a session console is opened for, and the sessions it holds.
 *
 * ## What already exists, and what this module is
 *
 * `lib/auth/session-list.ts` of STEP 054 is the whole rule: `listAccountSessions` asks
 * `SESSION_MANAGEMENT_OFFICE_ROLES` before its first query and appends
 * `session.list_read_by_office` naming the officer and the account; `revokeAccountSession` ends one
 * row with `ADMIN_REVOKED` and the officer as its actor; `0010_sessions.sql` is the table and
 * `sessions_user_idx` is the read. None of that is repeated here.
 *
 * What was missing is the question before it: *which* account. The deep screen of STEP 054 takes an
 * identifier, and a support worker holding a merchant's email - the only thing a merchant ever sends -
 * had no way in. This module turns what a person can type into the identifier the service needs, and
 * then hands the act to the service unchanged.
 *
 * ## Why a uuid or an email and nothing else
 *
 * An exact address is a lookup on `users_email_key`, which `0003` makes unique: one row or none, on an
 * index, with no scan and no list. A name search would be a different permission - finding people,
 * rather than helping one - so it is not offered, and the query string is bounded and shaped before it
 * reaches the database.
 *
 * ## Why the role is asked here as well
 *
 * The resolution reads `users` before the session service is called, so a role that may not manage
 * sessions would otherwise learn from the "no account" sentence whether an address exists. The check
 * is the same constant the service uses, imported rather than restated, and it runs before the first
 * query - so the office console refuses exactly the accounts the deep screen refuses.
 *
 * ## Why the counts are computed here
 *
 * A list of fifty rows does not tell an officer what they are looking at: whether the device was ever
 * confirmed, whether it was dropped, and how many doors are open in total. The snapshot answers those
 * in one place, from the rows the service returned, so the screen prints no arithmetic of its own.
 */

/** The longest a search may be: `users.email` is at most 254 characters. */
export const SESSION_SEARCH_MAXIMUM_LENGTH = 254;

/** What the search box was given. */
export type SessionSubjectKind = "uuid" | "email" | "empty" | "invalid";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** `0003`'s `users_email_format_check`, as a test rather than a constraint. */
const emailPattern = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/u;

/** What the search box holds: an identifier, an address, nothing, or something this screen refuses. */
export function subjectKindOf(value: string): SessionSubjectKind {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return "empty";
  }

  if (uuidPattern.test(trimmed.toLowerCase())) {
    return "uuid";
  }

  const lower = trimmed.toLowerCase();

  if (lower.length <= SESSION_SEARCH_MAXIMUM_LENGTH && emailPattern.test(lower)) {
    return "email";
  }

  return "invalid";
}

/** The account the console was opened for. */
export interface SessionSubject {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly companyId: string | null;
}

/** How the sessions of one account divide, so the screen prints no arithmetic of its own. */
export interface SessionCounts {
  readonly live: number;
  readonly trustedDevices: number;
  readonly unconfirmedDevices: number;
  readonly droppedDevices: number;
}

export interface AccountSessionsSnapshot {
  readonly subject: SessionSubject;
  readonly sessions: readonly SessionView[];
  readonly counts: SessionCounts;
  readonly readAtEpochMs: number;
}

export interface SessionConsoleDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly sessions: SessionTokenStore;
  readonly now?: () => number;
}

const subjectRowSchema = z.object({
  id: z.string().min(1).max(64),
  email: z.string().min(5).max(254),
  full_name: z.string().min(1).max(120),
  company_id: z.string().min(1).max(64).nullable(),
});

function countsOf(sessions: readonly SessionView[]): SessionCounts {
  return {
    live: sessions.length,
    trustedDevices: sessions.filter((session) => session.deviceTrusted && !session.deviceRevoked).length,
    unconfirmedDevices: sessions.filter((session) => !session.deviceTrusted && !session.deviceRevoked).length,
    droppedDevices: sessions.filter((session) => session.deviceRevoked).length,
  };
}

/** One account by identifier or by exact address, or null when nothing carries it. */
async function resolveSubject(
  kind: SessionSubjectKind,
  query: string,
  dependencies: SessionConsoleDependencies,
): Promise<SessionSubject | null> {
  const trimmed = query.trim();
  const filter =
    kind === "uuid"
      ? `id=eq.${encodeURIComponent(trimmed.toLowerCase())}`
      : `email=eq.${encodeURIComponent(trimmed.toLowerCase())}`;
  const rows = await dependencies.rest.select(
    "users",
    `select=id,email,full_name,company_id&${filter}&deleted_at=is.null&limit=1`,
    subjectRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  return { userId: row.id, email: row.email, fullName: row.full_name, companyId: row.company_id };
}

/**
 * The account and its live sessions, or null when the search names nobody.
 *
 * An empty search is a validation failure and a search of the wrong shape is one too, because both
 * are things the person can fix from the bar they typed in. A search that names no row is null, which
 * the page words as "no account" - the office is allowed to learn that an address it already holds is
 * not an account here, which is the answer it needs to hand the ticket back.
 */
export async function readAccountSessions(
  input: { readonly actor: RequestActor; readonly query: string },
  dependencies: SessionConsoleDependencies,
): Promise<AccountSessionsSnapshot | null> {
  requireAnyRole(input.actor, SESSION_MANAGEMENT_OFFICE_ROLES);

  const kind = subjectKindOf(input.query);

  if (kind === "empty") {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "account", rule: "required" }],
    });
  }

  if (kind === "invalid") {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "account", rule: "invalid_format" }],
    });
  }

  const subject = await resolveSubject(kind, input.query, dependencies);

  if (subject === null) {
    return null;
  }

  // STEP 054's read: the role check, the live filter and the audit entry all live inside it.
  const sessions = await listAccountSessions(
    { actor: input.actor, userId: subject.userId },
    dependencies,
  );

  return {
    subject,
    sessions,
    counts: countsOf(sessions),
    readAtEpochMs: dependencies.now?.() ?? Date.now(),
  };
}
