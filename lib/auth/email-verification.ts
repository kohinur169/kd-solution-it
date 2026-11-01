// path: lib/auth/email-verification.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import type { AuthClient, EmailTokenType } from "./client.ts";
import {
  encodeSessionCookies,
  type AuthCookiePolicy,
  type SessionCookiePayload,
} from "./cookies.ts";
import { decodeSessionClaims } from "./jwt.ts";
import type { RestClient } from "./rest.ts";
import type { AuthFailure } from "./types.ts";

/**
 * The second half of signup: a merchant follows the link in the mail and gets a session.
 *
 * The provider verifies the token and answers with a session, and that session is the only proof
 * that the person controls the mailbox. Two things happen here, in this order:
 *
 *   1. the platform row records `email_verified_at`, because section 22 verifies an address and
 *      every later screen asks whether the address was proved;
 *   2. the session cookie is written, so the merchant arrives signed in rather than at a second
 *      form.
 *
 * The audit entry is written between them: a verification that could not be recorded must not
 * leave a session behind, and a failure before the cookie is written means the merchant sees the
 * link expired rather than a half signed in state.
 *
 * ## What the link may not do
 *
 * The token type is a closed set. An `email_change` token verifies a new address on an existing
 * account and is deliberately not accepted here: that flow belongs to the account settings STEP and
 * accepting it on the signup route would let one link mean two different things.
 */

/** The token types the verification link accepts. */
export const SIGNUP_VERIFICATION_TYPES = ["signup", "email"] as const satisfies readonly EmailTokenType[];

const acceptedTypes: ReadonlySet<string> = new Set<string>(SIGNUP_VERIFICATION_TYPES);

/** The shape of a confirmation token hash. A link that does not have it never reaches the provider. */
export const verificationTokenSchema = z.string().min(10).max(512).regex(/^[A-Za-z0-9_-]+$/u);

export interface EmailVerificationInput {
  readonly tokenHash: string;
  readonly type: string;
  readonly remoteIp: string | null;
  readonly userAgent: string | null;
}

export interface EmailVerificationDependencies {
  readonly auth: AuthClient;
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly cookiePolicy: AuthCookiePolicy;
  readonly now?: () => number;
}

export interface EmailVerificationResult {
  readonly userId: string;
  readonly companyId: string | null;
  /** The `Set-Cookie` values of the session this verification established. */
  readonly cookies: readonly string[];
}

const userRowSchema = z.object({
  id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  email_verified_at: z.string().nullable(),
});

function verificationFailure(rule: string): AppError {
  return new AppError("VALIDATION_FAILED", { details: [{ field: "token", rule }] });
}

function providerError(failure: AuthFailure): AppError {
  switch (failure.kind) {
    case "rejected":
      return verificationFailure("invalid_or_expired");
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

export async function completeEmailVerification(
  input: EmailVerificationInput,
  dependencies: EmailVerificationDependencies,
): Promise<EmailVerificationResult> {
  if (!acceptedTypes.has(input.type)) {
    throw verificationFailure("unsupported_type");
  }

  const parsedToken = verificationTokenSchema.safeParse(input.tokenHash);

  if (!parsedToken.success) {
    throw verificationFailure("malformed");
  }

  const verified = await dependencies.auth.verifyEmailToken({
    tokenHash: parsedToken.data,
    type: input.type as EmailTokenType,
  });

  if (!verified.ok) {
    throw providerError(verified.failure);
  }

  const session = verified.value;
  const claims = decodeSessionClaims(session.accessToken);

  if (claims === null) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  const rows = await dependencies.rest.select(
    "users",
    `select=id,company_id,email_verified_at&id=eq.${encodeURIComponent(claims.subject)}&deleted_at=is.null&limit=1`,
    userRowSchema,
  );
  const user = rows[0];

  if (user === undefined) {
    // A provider identity with no platform row is an account the platform does not know, which is
    // the same answer as an unknown account and never a statement about the address.
    throw new AppError("AUTHENTICATION_REQUIRED");
  }

  const now = dependencies.now ?? ((): number => Date.now());
  const instantIso = new Date(now()).toISOString();

  if (user.email_verified_at === null) {
    await dependencies.rest.update("users", `id=eq.${encodeURIComponent(user.id)}`, {
      email_verified_at: instantIso,
    });
  }

  await dependencies.audit.append({
    action: "user.email_verified",
    actorUserId: user.id,
    entityType: "user",
    entityId: user.id,
    companyId: user.company_id,
    sessionId: claims.sessionId,
    payload: {
      method: input.type,
      already_verified: user.email_verified_at !== null,
    },
    ipAddress: input.remoteIp,
    userAgent: input.userAgent,
  });

  const payload: SessionCookiePayload = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAtEpochMs: session.expiresAtEpochMs,
    userId: user.id,
    sessionId: claims.sessionId,
  };

  return {
    userId: user.id,
    companyId: user.company_id,
    cookies: encodeSessionCookies(dependencies.cookiePolicy, payload, now()),
  };
}
