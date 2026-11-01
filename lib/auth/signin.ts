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
import type { RestClient } from "./rest.ts";
import type { TurnstileGuard } from "./turnstile.ts";
import type { AuthFailure } from "./types.ts";

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
 * ## What this STEP does not do
 *
 * The lock (STEP 045) sits before the exchange and answers `blocked`; the rate limiter (STEP 055)
 * sits before the route; the device proof key (STEP 049) and the rotating session (STEP 051) change
 * what the cookie means and add the `sessions` row. Each of them reads the same attempt row this
 * file writes, so none of them needs a new recorder.
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

export interface SigninResult {
  readonly userId: string;
  readonly companyId: string | null;
  /** True when the account has no live device proof key, so STEP 049 must enrol this browser. */
  readonly deviceProofRequired: boolean;
  readonly device: DeviceContext;
  readonly cookies: readonly string[];
}

export interface SigninDependencies {
  readonly auth: AuthClient;
  readonly rest: RestClient;
  readonly turnstile: TurnstileGuard;
  readonly attempts: LoginAttemptRecorder;
  readonly audit: AuditTrail;
  readonly cookiePolicy: AuthCookiePolicy;
  readonly now?: () => number;
}

const userRowSchema = z.object({
  id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  status: z.string().min(1).max(16),
  email_verified_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
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

  // STEP 045 inserts the lock question here: a locked account answers `blocked` before the exchange
  // and never reaches the provider, so a correct password during a lock proves nothing.
  const provider = await dependencies.auth.signInWithPassword({
    email: request.email,
    password: request.password,
  });

  if (!provider.ok) {
    await recordAttempt(dependencies, {
      factor: "password",
      outcome: "failed",
      companyId: null,
      ...identityOf(null, request.email),
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });

    throw providerError(provider.failure);
  }

  const session = provider.value;
  const claims = decodeSessionClaims(session.accessToken);

  if (claims === null || session.user.id !== claims.subject) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  const rows = await dependencies.rest.select(
    "users",
    `select=id,company_id,status,email_verified_at,deleted_at&id=eq.${encodeURIComponent(claims.subject)}&limit=1`,
    userRowSchema,
  );
  const user = rows[0];
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
