// path: lib/auth/locks.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import type { LockAlertNotifier } from "./lock-alert.ts";
import type {
  LoginAttemptFactor,
  LoginAttemptRecorder,
} from "./login-attempts.ts";
import type { RestClient } from "./rest.ts";

/**
 * The login lock of section 22.
 *
 * "Login lock: 2 consecutive failed password or failed 2FA attempts lock the account for 2 hours.
 * During the lock, a correct password does not log in, password reset is disabled, and changing the
 * password does not clear the lock."
 *
 * Three tables already existed before this module, and it invents none of them:
 *
 *   - `login_attempts` (`0011`) is the counter. An attempt is a row, so "two consecutive failures"
 *     is a query over the newest rows of one account and one factor, not a number a process keeps in
 *     memory - which is exactly the "survive server restarts" sentence of section 22;
 *   - `account_locks` (`0012`) is the lock. One row per lock, a check that no lock outlives two
 *     hours, a partial unique index that allows one open lock per account, and two mutually
 *     exclusive ways for a row to close: an office unlock and the clock;
 *   - `0085` indexes the streak query itself, because this module runs it on every failure.
 *
 * ## Why the counter is per factor
 *
 * `account_locks.triggered_by` is `'password'` or `'totp'`, and `0012` documents it as "which factor
 * reached two consecutive failures: password or totp". So the streak is counted within a factor: two
 * wrong passwords lock with `triggered_by = 'password'`, two wrong codes lock with `'totp'`. A
 * success of either factor is a success and a sign in ends the streak that belongs to it; a
 * `blocked` attempt (a refusal made *because* of a lock) and a `challenged` one (a Turnstile refusal)
 * are not credential checks at all, so they neither extend a streak nor break it.
 *
 * ## What is deliberately not here
 *
 * The email itself is `lib/auth/lock-alert.ts` of STEP 046, called once, after the row exists: this
 * module decides that a lock started, and that module decides who to tell and writes the queue row
 * of section 23. The two are split because a lock must not fail when the office has not configured
 * a sender. The office unlock is STEP 047's: the columns it needs
 * (`owner_contact_confirmed_at`, `unlocked_at`, `unlocked_by`, `unlock_note`) are in `0012` and this
 * module never writes them. The IP based rate limit is STEP 055's. This module is only the question
 * "is this account locked" and the transition "a failure just happened".
 *
 * ## Failing closed on the read, best effort on the count
 *
 * The two sides are not symmetrical on purpose. `readAccountLock` propagates a storage failure,
 * because "the database did not answer" must never be reported as "the account is open"; the route
 * turns it into a dependency failure and no sign in happens. `recordFailedSignIn` swallows one,
 * because the rejection it accompanies has already been decided: a counter that could not be written
 * must not turn "wrong password" into an outage sentence, and the attempt row of `0011` is the record
 * that the counter is behind.
 */

/** Two consecutive failures, from section 22. Not a tunable: the sentence names the number. */
export const LOGIN_LOCK_FAILURE_THRESHOLD = 2;

/** Two hours, from section 22, and `0012` refuses a row that outlives it. */
export const LOGIN_LOCK_DURATION_MS = 2 * 60 * 60 * 1_000;

/**
 * How many attempts the streak query reads.
 *
 * The threshold is two, so the query only has to look at the newest attempts until a success or the
 * threshold; ten is a bound that covers any run of `blocked` and `challenged` rows in between without
 * reading a history that has no bearing on the answer.
 */
export const LOGIN_LOCK_STREAK_LIMIT = 10;

/** The state of one account's lock, as of one instant. */
export interface AccountLockState {
  readonly locked: boolean;
  readonly triggeredBy: LoginAttemptFactor | null;
  readonly lockedAt: string | null;
  readonly expiresAt: string | null;
  /** Seconds until the lock ends by itself, or null when the account is not locked. */
  readonly remainingSeconds: number | null;
}

/** The state of an account with no open lock. Frozen so a caller cannot edit a shared answer. */
export const ACCOUNT_UNLOCKED: AccountLockState = Object.freeze({
  locked: false,
  triggeredBy: null,
  lockedAt: null,
  expiresAt: null,
  remainingSeconds: null,
});

const lockRowSchema = z.object({
  triggered_by: z.enum(["password", "totp"]),
  locked_at: z.string().min(1).max(40),
  expires_at: z.string().min(1).max(40),
});

const attemptOutcomeSchema = z.object({
  outcome: z.enum(["failed", "succeeded", "blocked", "challenged"]),
});

/**
 * Is there an open lock on this account?
 *
 * An open row whose `expires_at` has passed is *not* locked: the two hours are the lock, and the row
 * is closed by the clock the next time this module writes one (see `openLock`). Reading never writes,
 * so a page that asks this question on every render stays a read.
 */
export async function readAccountLock(
  rest: RestClient,
  userId: string,
  instant: number,
): Promise<AccountLockState> {
  const rows = await rest.select(
    "account_locks",
    `select=triggered_by,locked_at,expires_at&user_id=eq.${encodeURIComponent(userId)}` +
      "&unlocked_at=is.null&expired_at=is.null&deleted_at=is.null&order=locked_at.desc&limit=1",
    lockRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    return ACCOUNT_UNLOCKED;
  }

  const expiresAtMs = Date.parse(row.expires_at);

  // A row the platform cannot read a deadline from cannot be a lock either: it is not an instant the
  // platform can promise anything about, and `0012` would not have accepted it.
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= instant) {
    return ACCOUNT_UNLOCKED;
  }

  return {
    locked: true,
    triggeredBy: row.triggered_by,
    lockedAt: row.locked_at,
    expiresAt: row.expires_at,
    remainingSeconds: Math.max(1, Math.ceil((expiresAtMs - instant) / 1_000)),
  };
}

/**
 * How many consecutive failures of one factor this account just had.
 *
 * Newest first, and the loop stops at the first success. `blocked` and `challenged` rows are skipped
 * rather than counted or stopping the run: neither is a credential check, and letting a blocked
 * attempt reset the streak would let one locked sign in erase the evidence that caused the lock.
 */
export async function countConsecutiveFailures(
  rest: RestClient,
  userId: string,
  factor: LoginAttemptFactor,
): Promise<number> {
  const rows = await rest.select(
    "login_attempts",
    `select=outcome&user_id=eq.${encodeURIComponent(userId)}&factor=eq.${factor}` +
      `&deleted_at=is.null&order=created_at.desc,id.desc&limit=${LOGIN_LOCK_STREAK_LIMIT}`,
    attemptOutcomeSchema,
  );
  let streak = 0;

  for (const row of rows) {
    if (row.outcome === "failed") {
      streak += 1;
      continue;
    }

    if (row.outcome === "succeeded") {
      break;
    }
  }

  return streak;
}

/** The failure a locked account answers once the password is known to be right. */
export function accountLockError(lock: AccountLockState): AppError {
  return new AppError("ACCOUNT_LOCKED", {
    retryAfterSeconds: lock.remainingSeconds ?? Math.round(LOGIN_LOCK_DURATION_MS / 1_000),
  });
}

/**
 * Refuse a caller that must not proceed while the account is locked.
 *
 * Exported for the steps that read the same sentence rather than reimplementing it: password reset
 * (which section 22 disables during a lock), the office unlock screen of STEP 047, and any future
 * step-up check. A caller that only needs the state uses `readAccountLock`.
 */
export async function assertAccountUnlocked(
  rest: RestClient,
  userId: string,
  instant: number,
): Promise<AccountLockState> {
  const lock = await readAccountLock(rest, userId, instant);

  if (lock.locked) {
    throw accountLockError(lock);
  }

  return lock;
}

/** One failed sign in, as the counter needs it. */
export interface FailedSignIn {
  readonly userId: string;
  readonly companyId: string | null;
  readonly factor: LoginAttemptFactor;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface FailedSignInDependencies {
  readonly rest: RestClient;
  readonly attempts: LoginAttemptRecorder;
  readonly audit: AuditTrail;
  /** Tells the owner their account just locked. Best effort, and never a reason to fail the lock. */
  readonly alerts: LockAlertNotifier;
  readonly now?: () => number;
}

export interface FailedSignInResult {
  /** The state of the account after the attempt: locked when this very attempt started the lock. */
  readonly lock: AccountLockState;
  /** True when this attempt opened the lock - the event the owner is alerted about. */
  readonly opened: boolean;
  /** True when the attempt row was written, false when it could not be. */
  readonly recorded: boolean;
}

/**
 * Record a failed attempt and start the lock when the streak reaches two.
 *
 * Never throws: the caller has already decided to refuse the attempt, and a counter that could not be
 * consulted must not change the sentence a stranger reads. The answer says what happened, so a route
 * can log it, and the `user.login_locked` audit entry is written exactly once - when this call is the
 * one that created the row, not when it found one already there. The owner alert of STEP 046 goes out
 * on the same condition, for the same reason: a lock that started is a lock somebody must hear about,
 * and a lock that was already there must not send a second email.
 */
export async function recordFailedSignIn(
  input: FailedSignIn,
  dependencies: FailedSignInDependencies,
): Promise<FailedSignInResult> {
  const instant = (dependencies.now ?? ((): number => Date.now()))();
  let recorded = false;

  try {
    recorded = await dependencies.attempts.record({
      factor: input.factor,
      outcome: "failed",
      userId: input.userId,
      companyId: input.companyId,
      emailHash: null,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
  } catch {
    recorded = false;
  }

  // The whole lock step is caught, not only its inner writes: "never throws" is a promise to the
  // route, and a notifier that throws is a notifier that would otherwise turn a refusal into a 500.
  const opened = await openLockWhenStreakIsReached(input, {
    ...dependencies,
    now: () => instant,
  }).catch(() => false);
  const lock = await readAccountLock(dependencies.rest, input.userId, instant).catch(
    (): AccountLockState => ACCOUNT_UNLOCKED,
  );

  return { lock, opened, recorded };
}

/**
 * Create the lock when the streak is long enough, and only then.
 *
 * Two writes, in this order and for this reason: an open row whose two hours have passed is closed
 * first, because `account_locks_live_key` allows one open lock per account and an expired row that is
 * never closed would make the account impossible to lock again. Then the insert; a unique violation
 * means another request already opened the lock, which is the answer wanted either way, so it is not
 * an error.
 */
async function openLockWhenStreakIsReached(
  input: FailedSignIn,
  dependencies: FailedSignInDependencies,
): Promise<boolean> {
  const instant = (dependencies.now ?? ((): number => Date.now()))();
  const streak = await countConsecutiveFailures(
    dependencies.rest,
    input.userId,
    input.factor,
  ).catch(() => 0);

  if (streak < LOGIN_LOCK_FAILURE_THRESHOLD) {
    return false;
  }

  const lockedAt = new Date(instant).toISOString();
  const expiresAt = new Date(instant + LOGIN_LOCK_DURATION_MS).toISOString();

  await dependencies.rest
    .update(
      "account_locks",
      `user_id=eq.${encodeURIComponent(input.userId)}&unlocked_at=is.null&expired_at=is.null` +
        `&deleted_at=is.null&expires_at=lte.${encodeURIComponent(lockedAt)}`,
      { expired_at: lockedAt },
    )
    .catch(() => undefined);

  try {
    await dependencies.rest.insert("account_locks", [
      {
        company_id: input.companyId,
        user_id: input.userId,
        triggered_by: input.factor,
        locked_at: lockedAt,
        expires_at: expiresAt,
      },
    ]);
  } catch {
    // Either the account is locked already - `account_locks_live_key` refusing a second open row -
    // or the write failed. Neither is a second lock, and neither changes the refusal the caller
    // already owes the stranger.
    return false;
  }

  await dependencies.audit
    .append({
      action: "user.login_locked",
      actorUserId: null,
      entityType: "user",
      entityId: input.userId,
      companyId: input.companyId,
      payload: {
        triggered_by: input.factor,
        failed_attempts: streak,
        locked_at: lockedAt,
        locked_until: expiresAt,
        locked_for_seconds: Math.round(LOGIN_LOCK_DURATION_MS / 1_000),
      },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    })
    .catch(() => undefined);

  // Section 22: "The owner receives an email alert when the lock starts." The notifier writes the
  // queue row of section 23 and stamps `owner_alerted_at`; it answers with what happened instead of
  // throwing, and the catch is there for the one implementation that might forget.
  await dependencies.alerts
    .alertOnLock({
      userId: input.userId,
      companyId: input.companyId,
      factor: input.factor,
      lockedAt,
      expiresAt,
      failedAttempts: streak,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    })
    .catch(() => undefined);

  return true;
}
