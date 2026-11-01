// path: lib/auth/login-attempts.ts
import type { RestClient } from "./rest.ts";

/**
 * The writer of `public.login_attempts`.
 *
 * Section 22 says the failed attempt counters and the lock state are stored in the database and
 * survive a restart. `0011` is that storage: every authentication attempt is a row, and "two
 * consecutive failures" is a query over the last two rows rather than a number a process remembers.
 * STEP 045 builds the lock on that query. This file exists so that STEP 039, and every later
 * authentication route, writes the row the same way.
 *
 * ## The two identity columns
 *
 * A row names the account when the platform knows it, and the hash of the address when it does not.
 * `login_attempts_identity_known_check` forbids both at once and
 * `login_attempts_identity_check` forbids neither, so an attempt is never ambiguous about whether an
 * account was known. That is also what keeps the table from becoming a list of strangers' emails.
 *
 * ## Why a record may be absent
 *
 * `login_attempts.ip_address` is `inet NOT NULL`, because section 22's rate limiting is per address
 * and a row without an address cannot answer it. A request that reaches the origin without a usable
 * forwarding header therefore cannot be recorded, and the writer says so by returning false rather
 * than inventing an address. The caller still answers the merchant with one generic rejection; the
 * gap is visible in the returned value, and STEP 055 makes the address a requirement of the route.
 */

/** Which credential was checked. */
export type LoginAttemptFactor = "password" | "totp";

/** What happened. `challenged` is a Turnstile refusal, `blocked` a lock. */
export type LoginAttemptOutcome = "failed" | "succeeded" | "blocked" | "challenged";

export interface LoginAttempt {
  readonly factor: LoginAttemptFactor;
  readonly outcome: LoginAttemptOutcome;
  /** The account, when the platform knows it. */
  readonly userId: string | null;
  readonly companyId: string | null;
  /** The hash of the submitted address, when the account is not known. */
  readonly emailHash: string | null;
  /** The address of the request, or null when the request carried none. */
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface LoginAttemptRecorder {
  /** True when the row was written, false when the attempt had no address to record it with. */
  record(attempt: LoginAttempt): Promise<boolean>;
}

/** The reader STEP 045 will build on, kept here so both STEPs share one query shape. */
export const loginAttemptProjection = "select=id,factor,outcome,created_at";

function attemptRow(attempt: LoginAttempt): Record<string, unknown> {
  // The database decides whether the identity pair is legal; this function only refuses to send an
  // address hash for an account it knows, because that would be two claims about one row.
  return {
    company_id: attempt.companyId,
    user_id: attempt.userId,
    email_hash: attempt.userId === null ? attempt.emailHash : null,
    factor: attempt.factor,
    outcome: attempt.outcome,
    ip_address: attempt.ipAddress,
    user_agent: attempt.userAgent,
  };
}

export function createRestLoginAttemptRecorder(rest: RestClient): LoginAttemptRecorder {
  return {
    async record(attempt: LoginAttempt): Promise<boolean> {
      if (attempt.ipAddress === null) {
        return false;
      }

      await rest.insert("login_attempts", [attemptRow(attempt)]);

      return true;
    },
  };
}

/** The recorder of the gate: it keeps what it was given and writes nothing. */
export interface InMemoryLoginAttemptRecorder extends LoginAttemptRecorder {
  readonly attempts: readonly LoginAttempt[];
}

export function createInMemoryLoginAttemptRecorder(): InMemoryLoginAttemptRecorder {
  const attempts: LoginAttempt[] = [];

  return {
    attempts,
    record(attempt: LoginAttempt): Promise<boolean> {
      attempts.push(attempt);

      return Promise.resolve(true);
    },
  };
}
