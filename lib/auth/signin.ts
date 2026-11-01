// path: lib/auth/signin.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import type { AuthClient } from "./client.ts";
import {
  encodeSessionCookies,
  type AuthCookiePolicy,
  type SessionCookiePayload,
} from "./cookies.ts";
import { emailHash, readDeviceContext, type DeviceContext } from "./device-context.ts";
import { credentialRejectionError } from "./failures.ts";
import { decodeSessionClaims } from "./jwt.ts";
import type { LoginAttemptRecorder } from "./login-attempts.ts";
import { accountLockError, readAccountLock, recordFailedSignIn } from "./locks.ts";
import type { RestClient } from "./rest.ts";
import type { TurnstileGuard } from "./turnstile.ts";
import type { AuthFailure } from "./types.ts";
import { issueTwoFactorChallenge } from "./two-factor-login.ts";

/**
 * Sign in with a password, a challenge and nothing else.
 *
 * Section 22 asks for three things of this endpoint and one prohibition:
 *
 *   - Turnstile runs on sign in, not only on signup (line 245);
 *   - the session cookie is written only after the exchange, and the attempt is a row in the
 *     database so a restart cannot reset a counter (line 243);
 *   - the device the sign in came from is recorded, and the account is told whether it still needs
 *     a device proof key (line 244);
 *   - and the answer never says whether an account exists (line 250).
 *
 * ## One failure for five causes
 *
 * A wrong password, an unknown address, an unconfirmed address, a closed account and an account the
 * platform has no row for all answer `AUTHENTICATION_REQUIRED` from `credentialRejectionError()`,
 * which is the only constructor of that answer in this module. The difference lives in the attempt
 * row, which is a fact about a request and not a message to a stranger, and in the structured log of
 * the route. Uniformity is not politeness here: an endpoint that answers "no such account" in
 * 200 ms and "wrong password" in 600 ms is an account directory.
 *
 * ## The lock, and why the address is read first
 *
 * STEP 045 needs two facts this file could not answer before: which account a failed password
 * belongs to, and whether that account is locked.
 *
 * The account is resolved from the address *before* the exchange - one lookup on `users_email_key` -
 * because a failure recorded by an address hash alone can never count toward the two consecutive
 * failures of section 22. The lookup changes no answer: it decides what the attempt row says, not
 * what the stranger reads, and an unknown address simply has no row to attribute.
 *
 * The lock is asked *after* the exchange, and that order is the security property. A locked account
 * answering before the password is checked would confirm to anybody that the address exists, which
 * section 22 forbids; once the password is known to be right, the person in front of the screen is
 * the owner and "locked until 14:05" is the only useful sentence - and the provider session this
 * exchange created is signed out again rather than left alive for a sign in that did not happen.
 *
 * What is still not here: the owner alert (STEP 046), the office unlock (STEP 047), the IP rate
 * limiter (STEP 055), the device proof key (STEP 049) and the rotating session (STEP 051).
 */

/** The sign in form. An address is not shape checked beyond a bound, to avoid a shape oracle. */
export const signinInputSchema = z
  .object({
    email: z.string().trim().toLowerCase().min(3).max(254),
    password: z.string().min(1).max(128),
    turnstileToken: z
      .string()
      .max(2_048)
      .nullable()
      .default(null),
  })
  .strict();

export type SigninRequest = z.infer<typeof signinInputSchema>;

export interface SigninInput {
  readonly request: unknown;
  readonly remoteIp: string | null;
  readonly userAgent: string | null;
}

/**
 * The two answers a correct password can produce.
 *
 * `signed_in` is a session: the account has no confirmed second factor, or the caller already went
 * through the code step. `two_factor_required` is not a session and carries no cookie - it names a
 * challenge the browser presents to `/api/auth/2fa/verify` together with a code. Section 22 makes
 * the distinction necessary: an account holding a role must not be signed in by a password alone,
 * so the password step has to be able to stop half way.
 */
export interface SignedInResult {
  readonly outcome: "signed_in";
  readonly userId: string;
  readonly companyId: string | null;
  /** True when the account has no live device proof key, so STEP 049 must enrol this browser. */
  readonly deviceProofRequired: boolean;
  readonly device: DeviceContext;
  readonly cookies: readonly string[];
}

export interface TwoFactorRequiredResult {
  readonly outcome: "two_factor_required";
  readonly userId: string;
  readonly companyId: string | null;
  readonly deviceProofRequired: boolean;
  readonly device: DeviceContext;
  /** The handle the browser presents with the code. Not a session, and useless without one. */
  readonly challengeToken: string;
  readonly expiresAtEpochMs: number;
}

export type SigninResult = SignedInResult | TwoFactorRequiredResult;

export interface SigninDependencies {
  readonly auth: AuthClient;
  readonly rest: RestClient;
  readonly turnstile: TurnstileGuard;
  readonly attempts: LoginAttemptRecorder;
  readonly audit: AuditTrail;
  readonly cookiePolicy: AuthCookiePolicy;
  /** The key that seals a pending session while the code is asked for. */
  readonly masterKey: () => string;
  readonly now?: () => number;
}

const userRowSchema = z.object({
  id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  status: z.string().min(1).max(16),
  email_verified_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  totp_confirmed_at: z.string().nullable(),
});

const deviceKeyRowSchema = z.object({ id: z.string().min(1).max(64) });

function turnstileError(failure: AuthFailure): AppError {
  switch (failure.kind) {
    case "rejected":
      return new AppError("VALIDATION_FAILED", {
        details: [{ field: "turnstileToken", rule: "challenge_failed" }],
      });
    case "timeout":
      return new AppError("TIMEOUT");
    case "rate-limited":
      return failure.retryAfterSeconds === null
        ? new AppError("RATE_LIMITED")
        : new AppError("RATE_LIMITED", { retryAfterSeconds: failure.retryAfterSeconds });
    case "network":
    case "upstream":
    case "malformed-response":
      return new AppError("DEPENDENCY_FAILED");
  }
}

/**
 * A provider failure at sign in.
 *
 * A rejection is the one generic answer, because the provider is the party that knows why and the
 * stranger is the party that must not. Everything else is the deployment's problem and keeps its
 * own catalogue code, so an outage is never reported as a wrong password.
 */
function providerError(failure: AuthFailure): AppError {
  switch (failure.kind) {
    case "rejected":
      return credentialRejectionError();
    case "timeout":
      return new AppError("TIMEOUT");
    case "rate-limited":
      return failure.retryAfterSeconds === null
        ? new AppError("RATE_LIMITED")
        : new AppError("RATE_LIMITED", { retryAfterSeconds: failure.retryAfterSeconds });
    case "network":
    case "upstream":
    case "malformed-response":
      return new AppError("DEPENDENCY_FAILED");
  }
}

/** Why the platform refused an account it does own. Never leaves the process. */
type AccountRefusal = "missing" | "closed" | "unverified";

export async function signInMerchant(
  input: SigninInput,
  dependencies: SigninDependencies,
): Promise<SigninResult> {
  const parsed = signinInputSchema.safeParse(input.request);

  if (!parsed.success) {
    // A form that is not a form is not a fact about an account either.
    throw credentialRejectionError();
  }

  const request = parsed.data;
  const now = dependencies.now ?? ((): number => Date.now());
  const device = readDeviceContext(input.userAgent);

  const challenge = await dependencies.turnstile.check({
    token: request.turnstileToken,
    remoteIp: input.remoteIp,
  });

  if (!challenge.ok) {
    await recordAttempt(dependencies, {
      factor: "password",
      outcome: "challenged",
      companyId: null,
      ...identityOf(null, request.email),
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });

    throw turnstileError(challenge.failure);
  }

  // The account behind the address, if there is one. Read here and not after the exchange because a
  // failure has to be attributed to an account for the lock of section 22 to count it.
  const knownAccount = await readAccountByEmail(dependencies.rest, request.email);

  const provider = await dependencies.auth.signInWithPassword({
    email: request.email,
    password: request.password,
  });

  if (!provider.ok) {
    if (knownAccount === null) {
      // No account to attribute the failure to: the row names the address by its hash, which is what
      // lets STEP 055 throttle one address without learning whose it is.
      await recordAttempt(dependencies, {
        factor: "password",
        outcome: "failed",
        companyId: null,
        ...identityOf(null, request.email),
        ipAddress: input.remoteIp,
        userAgent: input.userAgent,
      });
    } else {
      // A known account: the row names it, and the second consecutive failure locks it.
      await recordFailedSignIn(
        {
          userId: knownAccount.id,
          companyId: knownAccount.company_id,
          factor: "password",
          ipAddress: input.remoteIp,
          userAgent: input.userAgent,
        },
        {
          rest: dependencies.rest,
          attempts: dependencies.attempts,
          audit: dependencies.audit,
          now,
        },
      );
    }

    throw providerError(provider.failure);
  }

  const session = provider.value;
  const claims = decodeSessionClaims(session.accessToken);

  if (claims === null || session.user.id !== claims.subject) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  // The row found by address is used when it is the account the provider signed in; otherwise the
  // provider's subject is read directly, so an address that changed mid flight still resolves.
  const user =
    knownAccount !== null && knownAccount.id === claims.subject
      ? knownAccount
      : await readAccountById(dependencies.rest, claims.subject);
  const refusal = readRefusal(user);

  if (refusal !== null) {
    await recordAttempt(dependencies, {
      factor: "password",
      outcome: "failed",
      companyId: user?.company_id ?? null,
      ...identityOf(user?.id ?? null, request.email),
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });

    throw credentialRejectionError();
  }

  const account = user as z.infer<typeof userRowSchema>;

  // The account is open, verified and owned by the person with the correct password. If the two hour
  // lock of section 22 is running, that password still does not sign in: the provider session is
  // ended, the attempt is recorded as `blocked`, and the answer names the lock rather than the
  // account - a stranger without the password reaches the generic rejection above instead.
  const lock = await readAccountLock(dependencies.rest, account.id, now());

  if (lock.locked) {
    await dependencies.auth.signOut(session.accessToken).catch(() => undefined);
    await recordAttempt(dependencies, {
      factor: "password",
      outcome: "blocked",
      companyId: account.company_id,
      userId: account.id,
      emailHash: null,
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });
    await dependencies.audit
      .append({
        action: "user.signin_blocked",
        actorUserId: account.id,
        entityType: "user",
        entityId: account.id,
        companyId: account.company_id,
        payload: {
          locked_until: lock.expiresAt,
          remaining_seconds: lock.remainingSeconds,
          triggered_by: lock.triggeredBy,
        },
        ipAddress: input.remoteIp,
        userAgent: input.userAgent,
      })
      .catch(() => undefined);

    throw accountLockError(lock);
  }

  const proofKeys = await dependencies.rest.select(
    "device_proof_keys",
    `select=id&user_id=eq.${encodeURIComponent(account.id)}&revoked_at=is.null&deleted_at=is.null&limit=1`,
    deviceKeyRowSchema,
  );
  const deviceProofRequired = proofKeys.length === 0;

  const recorded = await recordAttempt(dependencies, {
    factor: "password",
    outcome: "succeeded",
    companyId: account.company_id,
    ...identityOf(account.id, request.email),
    ipAddress: input.remoteIp,
    userAgent: input.userAgent,
  });

  // The password is right and the account is open. If the account has confirmed a second factor,
  // this is where the session stops: the provider's pair is sealed into a challenge, the browser
  // receives a handle instead of a cookie, and `user.signed_in` is written only after the code.
  if (account.totp_confirmed_at !== null) {
    const challenge = await issueTwoFactorChallenge(
      {
        userId: account.id,
        companyId: account.company_id,
        session: {
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          expiresAtEpochMs: session.expiresAtEpochMs,
          sessionId: claims.sessionId,
        },
        device,
        remoteIp: input.remoteIp,
        userAgent: input.userAgent,
      },
      {
        rest: dependencies.rest,
        audit: dependencies.audit,
        attempts: dependencies.attempts,
        cookiePolicy: dependencies.cookiePolicy,
        masterKey: dependencies.masterKey,
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      },
    );

    await dependencies.audit.append({
      action: "user.two_factor_challenged",
      actorUserId: account.id,
      entityType: "user",
      entityId: account.id,
      companyId: account.company_id,
      sessionId: claims.sessionId,
      payload: {
        device: device.label,
        challenge_expires_at: new Date(challenge.expiresAtEpochMs).toISOString(),
        assurance_level: claims.assuranceLevel,
        attempt_recorded: recorded,
      },
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });

    return {
      outcome: "two_factor_required",
      userId: account.id,
      companyId: account.company_id,
      deviceProofRequired,
      device,
      challengeToken: challenge.token,
      expiresAtEpochMs: challenge.expiresAtEpochMs,
    };
  }

  await dependencies.audit.append({
    action: "user.signed_in",
    actorUserId: account.id,
    entityType: "user",
    entityId: account.id,
    companyId: account.company_id,
    sessionId: claims.sessionId,
    payload: {
      device: device.label,
      device_proof_present: !deviceProofRequired,
      assurance_level: claims.assuranceLevel,
      attempt_recorded: recorded,
    },
    ipAddress: input.remoteIp,
    userAgent: input.userAgent,
  });

  const payload: SessionCookiePayload = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAtEpochMs: session.expiresAtEpochMs,
    userId: account.id,
    sessionId: claims.sessionId,
  };

  return {
    outcome: "signed_in",
    userId: account.id,
    companyId: account.company_id,
    deviceProofRequired,
    device,
    cookies: encodeSessionCookies(dependencies.cookiePolicy, payload, now()),
  };
}

/**
 * The identity columns of an attempt row.
 *
 * `0011` allows the account or the hash of the address, never both and never neither, so the choice
 * is made once, here: a known account is counted by id, and an address the platform has no row for
 * is counted by its hash. Building the pair in one place is what keeps a caller from sending both.
 */
function identityOf(
  userId: string | null,
  email: string,
): { readonly userId: string | null; readonly emailHash: string | null } {
  return userId === null
    ? { userId: null, emailHash: emailHash(email) }
    : { userId, emailHash: null };
}

/** The account behind an address, or null. `users_email_key` makes this one index lookup. */
async function readAccountByEmail(
  rest: RestClient,
  email: string,
): Promise<z.infer<typeof userRowSchema> | null> {
  const rows = await rest.select(
    "users",
    `select=id,company_id,status,email_verified_at,deleted_at,totp_confirmed_at&email=eq.${encodeURIComponent(email)}&limit=1`,
    userRowSchema,
  );

  return rows[0] ?? null;
}

/** The account the provider's token names. */
async function readAccountById(
  rest: RestClient,
  userId: string,
): Promise<z.infer<typeof userRowSchema> | undefined> {
  const rows = await rest.select(
    "users",
    `select=id,company_id,status,email_verified_at,deleted_at,totp_confirmed_at&id=eq.${encodeURIComponent(userId)}&limit=1`,
    userRowSchema,
  );

  return rows[0];
}

function readRefusal(user: z.infer<typeof userRowSchema> | undefined): AccountRefusal | null {
  if (user === undefined || user.deleted_at !== null) {
    return "missing";
  }

  if (user.status !== "active") {
    return "closed";
  }

  if (user.email_verified_at === null) {
    return "unverified";
  }

  return null;
}

/**
 * Record the attempt, and never let the record hide the answer.
 *
 * A rejection has already been decided when this runs, so a failed insert must not turn one generic
 * sentence into a platform error; `0011` will simply miss one row. A successful sign in takes the
 * same path: the session is valid, and the audit entry that follows says whether the row landed.
 */
async function recordAttempt(
  dependencies: SigninDependencies,
  attempt: Parameters<LoginAttemptRecorder["record"]>[0],
): Promise<boolean> {
  try {
    return await dependencies.attempts.record(attempt);
  } catch {
    return false;
  }
}
