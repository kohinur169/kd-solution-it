// path: lib/auth/account-unlock.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import { sanitizeMultilineText } from "../security/text.ts";
import { getMessage } from "../i18n/messages.ts";
import type { Logger } from "../logger/logger.ts";
import type { AuditTrail } from "./audit.ts";
import type { RestClient } from "./rest.ts";
import { hasSatisfiedTwoFactor, requireAnyRole } from "./session.ts";
import type { PlatformRole, RequestActor } from "./types.ts";

/**
 * The office unlock of section 22.
 *
 * "Unlock is done only by an office role with unlock permission and only after contact with the
 * owner is confirmed by email. Every unlock is audit logged."
 *
 * Three sentences, three guards, and the order they run in is the design:
 *
 *   1. **an office role with unlock permission.** `requireAnyRole` against
 *      `ACCOUNT_UNLOCK_OFFICE_ROLES`, so a merchant - including the owner of the locked company -
 *      cannot unlock anything, and the check is in the service rather than in a route that a second
 *      caller could bypass. The actor must also have answered a second factor, because section 22
 *      makes TOTP mandatory for every account that holds a role; an office session that was issued
 *      before enrolment is not a session that may end a lock.
 *   2. **only after contact with the owner is confirmed by email.** The endpoint takes the officer's
 *      confirmation as an explicit field and refuses without it, the update stamps
 *      `owner_contact_confirmed_at`, `0012` refuses an unlock row without that instant, and `0087`
 *      refuses an unlock without the note of what the officer verified. The database is the second
 *      witness: a code path added later cannot close a lock quietly.
 *   3. **every unlock is audit logged.** `user.login_unlocked` names the officer, the account, the
 *      company and the lock window, with the length of the note rather than its text - the note stays
 *      on the row, where it can be erased with the account, and the immutable chain stays free of
 *      what an officer typed.
 *
 * ## What this module is not
 *
 * It is not the screen. Section 22's management screen for permitted office roles is STEP 078, and
 * it reads the open locks this module closes. It is not step-up reauthentication either, which is
 * STEP 053: this module checks who the caller is and what they may do, and STEP 053 adds the "prove
 * it again, now" requirement on top of the same call. The seam is deliberately one function call, so
 * that guard has one place to land.
 *
 * ## The merchant hears about it
 *
 * Section 23 lists "account unlock confirmation" among the activity emails the platform sends by
 * itself, and the queue row is written here, at the unlock, because nobody else is in a position to
 * know it happened. It uses the same `email_send_logs` table as the lock alert of STEP 046 and the
 * same rule: best effort. An office unlock that succeeds while the office has not configured a sender
 * is an unlock, not a failure; the row is what STEP 227 sends. The confirmation goes to the account
 * that was locked, because that is the person who can sign in again.
 *
 * It is also not a counter reset. Unlocking closes the lock row and touches nothing in
 * `login_attempts`: the failures that caused the lock are still history, and the next successful sign
 * in is what ends that streak. Section 22 lists exactly what clears a lock - an office unlock after
 * contact, or the clock - and this STEP adds no third way.
 */

/** The office roles that may end a lock. Merchants, finance and content roles are not among them. */
export const ACCOUNT_UNLOCK_OFFICE_ROLES: readonly PlatformRole[] = Object.freeze([
  "super_admin",
  "ceo",
  "compliance_kyc",
  "support",
] as const satisfies readonly PlatformRole[]);

/** `account_locks.unlock_note` is 1 to 280 characters, and `0087` requires it on an unlock. */
export const ACCOUNT_UNLOCK_NOTE_MAX_LENGTH = 280;

/** The section 23 template of the confirmation, already a legal key in `0060` and `0061`. */
export const ACCOUNT_UNLOCK_TEMPLATE_KEY = "account_unlock";

/** How many times the email system may try; the log defaults to three. */
export const ACCOUNT_UNLOCK_MAIL_MAX_ATTEMPTS = 3;

export interface UnlockDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface AccountUnlockRequest {
  readonly actor: RequestActor;
  /** The open lock to close. */
  readonly lockId: string;
  /** The officer's record of what was verified about the contact. Required, and never a secret. */
  readonly note: string;
  /** The officer confirms the owner was reached before the unlock, as section 22 requires. */
  readonly ownerContactConfirmed: boolean;
}

export interface AccountUnlockResult {
  readonly status: "unlocked";
  readonly lockId: string;
  readonly userId: string;
  readonly companyId: string | null;
  /** When the lock was closed by the officer. */
  readonly unlockedAt: string;
  /** When contact with the owner was recorded: before or at `unlockedAt`, never after it. */
  readonly ownerContactConfirmedAt: string;
}

const identifierSchema = z.string().uuid();

const noteSchema = z
  .string()
  .trim()
  .min(1)
  .max(ACCOUNT_UNLOCK_NOTE_MAX_LENGTH)
  .transform((value) => sanitizeMultilineText(value, ACCOUNT_UNLOCK_NOTE_MAX_LENGTH));

const lockRowSchema = z.object({
  id: z.string().min(1).max(64),
  user_id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  triggered_by: z.enum(["password", "totp"]),
  locked_at: z.string().min(1).max(40),
  expires_at: z.string().min(1).max(40),
  owner_alerted_at: z.string().min(1).max(40).nullable(),
  owner_contact_confirmed_at: z.string().min(1).max(40).nullable(),
  unlocked_at: z.string().min(1).max(40).nullable(),
  expired_at: z.string().min(1).max(40).nullable(),
});

const unlockedRowSchema = z.object({
  unlocked_at: z.string().min(1).max(40).nullable(),
  unlocked_by: z.string().min(1).max(64).nullable(),
});

const sendingMethodSchema = z.object({ method: z.enum(["smtp", "api"]) });

const addressSchema = z.object({ email: z.string().min(3).max(320) });

const sendRowSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * Queue the section 23 confirmation for the account that was unlocked.
 *
 * Three reads and one write, and not one of them may fail the unlock: the lock is already closed and
 * the office has already been told so. A platform with no active sending method, an account with no
 * address, and a queue that refuses the row are all logged answers, not exceptions - and the missing
 * row is exactly what an operator needs to see, because the merchant was not told.
 */
async function queueUnlockConfirmation(
  account: {
    readonly userId: string;
    readonly companyId: string | null;
    readonly unlockedAt: string;
  },
  dependencies: UnlockDependencies,
): Promise<string | null> {
  try {
    const methods = await dependencies.rest.select(
      "email_settings",
      "select=method&status=eq.active&deleted_at=is.null&limit=1",
      sendingMethodSchema,
    );
    const method = methods[0]?.method;

    if (method === undefined) {
      dependencies.logger.warn("no email sending method is active, so no unlock confirmation was queued", {
        accountId: account.userId,
        companyId: account.companyId,
      });

      return null;
    }

    const addresses = await dependencies.rest.select(
      "users",
      `select=email&id=eq.${encodeURIComponent(account.userId)}&deleted_at=is.null&limit=1`,
      addressSchema,
    );
    const recipient = addresses[0]?.email;

    if (recipient === undefined) {
      dependencies.logger.warn("the unlocked account has no address to confirm the unlock to", {
        accountId: account.userId,
        companyId: account.companyId,
      });

      return null;
    }

    const rows = await dependencies.rest.insertReturning(
      "email_send_logs",
      [
        {
          company_id: account.companyId,
          template_key: ACCOUNT_UNLOCK_TEMPLATE_KEY,
          recipient_email: recipient,
          recipient_user_id: account.userId,
          subject: getMessage("email.accountUnlock.subject"),
          provider: method,
          max_attempts: ACCOUNT_UNLOCK_MAIL_MAX_ATTEMPTS,
          reference_kind: "account",
          reference_id: account.userId,
          queued_at: account.unlockedAt,
        },
      ],
      sendRowSchema,
    );

    return rows[0]?.id ?? null;
  } catch (error) {
    dependencies.logger.warn("the unlock confirmation could not be queued", {
      accountId: account.userId,
      companyId: account.companyId,
      reason: error instanceof Error ? error.message : "unknown",
    });

    return null;
  }
}

/**
 * Close one open lock on behalf of the office.
 *
 * Read, refuse, write, read back, audit - and each step exists because of a way the previous one can
 * be wrong:
 *
 *   - the lock is read first so an unknown id is `404` and a settled lock is `409`, rather than an
 *     update that silently matched nothing;
 *   - a lock whose two hours are over is refused as `409` even when its row was never closed, because
 *     `readAccountLock` of STEP 045 already treats it as open and unlocking it would change nothing;
 *   - the write is a conditional update (`unlocked_at is null`, `expired_at is null`), so a second
 *     officer and the clock cannot both win; the read back is what turns a lost race into `409`
 *     instead of a success that never happened;
 *   - the audit entry is written after the row, uncaught: an unlock the platform cannot record is a
 *     failure the officer has to see, and section 22 says every unlock is logged;
 *   - the confirmation email of section 23 is queued last, and caught: the merchant hears about an
 *     unlock that did happen, never about one that did not.
 */
export async function unlockAccountLock(
  input: AccountUnlockRequest,
  dependencies: UnlockDependencies,
): Promise<AccountUnlockResult> {
  const actor = requireAnyRole(input.actor, ACCOUNT_UNLOCK_OFFICE_ROLES);

  if (!hasSatisfiedTwoFactor(actor)) {
    throw new AppError("PERMISSION_DENIED");
  }

  const parsedId = identifierSchema.safeParse(input.lockId);

  if (!parsedId.success) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (input.ownerContactConfirmed !== true) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "ownerContactConfirmed", rule: "not_confirmed" }],
    });
  }

  const parsedNote = noteSchema.safeParse(input.note);

  if (!parsedNote.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "note", rule: "invalid_format" }],
    });
  }

  const rows = await dependencies.rest.select(
    "account_locks",
    `select=id,user_id,company_id,triggered_by,locked_at,expires_at,owner_alerted_at` +
      `,owner_contact_confirmed_at,unlocked_at,expired_at` +
      `&id=eq.${encodeURIComponent(parsedId.data)}&deleted_at=is.null&limit=1`,
    lockRowSchema,
  );
  const lock = rows[0];

  if (lock === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const now = dependencies.now ?? ((): number => Date.now());
  const unlockedAt = new Date(now()).toISOString();

  // A lock that a person or the clock already ended is history. Deciding it again would rewrite a
  // record of who did what, and the two closures are mutually exclusive by `0012`'s check.
  if (lock.unlocked_at !== null || lock.expired_at !== null) {
    throw new AppError("CONFLICT");
  }

  const expiresAtMs = Date.parse(lock.expires_at);
  const instantMs = Date.parse(unlockedAt);

  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= instantMs) {
    throw new AppError("CONFLICT");
  }

  // A contact recorded earlier - by a screen that asks the officer first - keeps its own instant, so
  // the audit trail can still tell "contacted at" from "unlocked at".
  const contactConfirmedAt = lock.owner_contact_confirmed_at ?? unlockedAt;

  await dependencies.rest.update(
    "account_locks",
    `id=eq.${encodeURIComponent(lock.id)}&unlocked_at=is.null&expired_at=is.null&deleted_at=is.null`,
    {
      owner_contact_confirmed_at: contactConfirmedAt,
      unlocked_at: unlockedAt,
      unlocked_by: actor.userId,
      unlock_note: parsedNote.data,
    },
  );

  const claimed = await dependencies.rest.select(
    "account_locks",
    `select=unlocked_at,unlocked_by&id=eq.${encodeURIComponent(lock.id)}&limit=1`,
    unlockedRowSchema,
  );

  if (claimed[0]?.unlocked_at !== unlockedAt || claimed[0]?.unlocked_by !== actor.userId) {
    throw new AppError("CONFLICT");
  }

  await dependencies.audit.append({
    action: "user.login_unlocked",
    actorUserId: actor.userId,
    entityType: "user",
    entityId: lock.user_id,
    companyId: lock.company_id,
    payload: {
      lock_id: lock.id,
      triggered_by: lock.triggered_by,
      locked_at: lock.locked_at,
      expires_at: lock.expires_at,
      owner_alerted: lock.owner_alerted_at !== null,
      owner_contact_confirmed_at: contactConfirmedAt,
      lock_age_seconds: Math.max(0, Math.round((instantMs - Date.parse(lock.locked_at)) / 1_000)),
      note_length: parsedNote.data.length,
    },
  });

  await queueUnlockConfirmation(
    { userId: lock.user_id, companyId: lock.company_id, unlockedAt },
    dependencies,
  );

  return {
    status: "unlocked",
    lockId: lock.id,
    userId: lock.user_id,
    companyId: lock.company_id,
    unlockedAt,
    ownerContactConfirmedAt: contactConfirmedAt,
  };
}
