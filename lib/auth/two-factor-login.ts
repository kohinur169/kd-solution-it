// path: lib/auth/two-factor-login.ts
import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import { encodeSessionCookies, type AuthCookiePolicy, type SessionCookiePayload } from "./cookies.ts";
import { credentialRejectionError } from "./failures.ts";
import type { DeviceContext } from "./device-context.ts";
import type { LoginAttemptRecorder } from "./login-attempts.ts";
import { verifyPasswordHash } from "./password.ts";
import type { RestClient } from "./rest.ts";
import { openSecret, packSecretBox, sealSecret, unpackSecretBox } from "./secrets.ts";
import { isBackupCodeShaped, normalizeBackupCode, verifyTotpCode } from "./totp.ts";
import { openEnrolledSecret } from "./two-factor.ts";

/**
 * The second factor at sign in: the challenge that holds a session, and the code that releases it.
 *
 * ## Why a row exists at all
 *
 * The password exchange happens with the identity provider, and it returns a token pair. Section 22
 * makes a second factor mandatory, and a session is the thing "signed in" means, so that pair must
 * not reach the browser until the code is accepted. It cannot wait in memory - a restart would sign
 * everyone out mid step - and it cannot travel in a cookie, because the browser would then hold the
 * session it is not entitled to. `0082` is the answer: a row per challenge, the pair sealed inside
 * it, and an opaque random handle for the browser.
 *
 * ## What the browser holds, and what it proves
 *
 * The handle is 32 random bytes in base64url. Only its SHA-256 is stored, so a database leak yields
 * nothing usable, and the same rule as `0010` applies: a comparison never touches plaintext. A
 * challenge expires in ten minutes, holds one account, is scoped to one sign in, and is consumed the
 * instant it produces a session. Five rejected codes retire it, so a stranger holding a password has
 * five guesses at a million, and `0011` records every rejection as `factor = 'totp'` for the two
 * consecutive failures that lock an account in STEP 045.
 *
 * ## The code, or a backup code
 *
 * The code is RFC 6238, checked in the same one step window as enrolment. A backup code is accepted
 * if it has the shape of one, and a match consumes it: the stored verifier is removed and the array
 * is written back, so ten codes are ten sign ins and no more. Both paths answer the same way on
 * failure, because the difference between "wrong code" and "wrong backup code" is a difference
 * between two guesses and no help at all.
 */

/** Ten minutes: long enough to fetch a phone, short enough to be debris. */
export const TWO_FACTOR_CHALLENGE_TTL_MS = 10 * 60_000;

/** Rejected codes a single challenge allows before it retires. */
export const TWO_FACTOR_MAXIMUM_ATTEMPTS = 5;

/** How the session was produced, recorded in the audit entry and answered to the screen. */
export type SecondFactorMethod = "totp" | "backup_code";

const handleBytes = 32;

const tokenHashPattern = /^[0-9a-f]{64}$/u;

const challengeRowSchema = z.object({
  id: z.string().min(1).max(64),
  user_id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  secret_ciphertext: z.string().min(32).max(4_096),
  attempt_count: z.number().int().nonnegative(),
  expires_at: z.string().min(1),
  consumed_at: z.string().nullable(),
});

const accountRowSchema = z.object({
  id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  status: z.string().min(1).max(16),
  email_verified_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  totp_secret_ciphertext: z.string().max(512).nullable(),
  totp_confirmed_at: z.string().nullable(),
  backup_code_hashes: z.array(z.string().min(1).max(512)).max(20),
});

const sealedSessionSchema = z.object({
  accessToken: z.string().min(1).max(4_096),
  refreshToken: z.string().min(1).max(2_048),
  expiresAtEpochMs: z.number().int().positive(),
  sessionId: z.string().min(1).max(64).nullable(),
});

const completeInputSchema = z
  .object({
    challengeToken: z.string().trim().min(20).max(128),
    code: z.string().trim().min(6).max(16),
  })
  .strict();

export interface ProviderSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAtEpochMs: number;
  readonly sessionId: string | null;
}

export interface IssueChallengeInput {
  readonly userId: string;
  readonly companyId: string | null;
  readonly session: ProviderSession;
  readonly device: DeviceContext;
  readonly remoteIp: string | null;
  readonly userAgent: string | null;
}

export interface IssuedChallenge {
  readonly token: string;
  readonly expiresAtEpochMs: number;
}

export interface CompleteChallengeInput {
  readonly challengeToken: string;
  readonly code: string;
  readonly remoteIp: string | null;
  readonly userAgent: string | null;
}

export interface CompletedChallenge {
  readonly userId: string;
  readonly companyId: string | null;
  readonly deviceProofRequired: boolean;
  readonly method: SecondFactorMethod;
  readonly cookies: readonly string[];
}

export interface TwoFactorLoginDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly attempts: LoginAttemptRecorder;
  readonly cookiePolicy: AuthCookiePolicy;
  /** Read lazily: the module never touches the environment at import time. */
  readonly masterKey: () => string;
  readonly now?: () => number;
}

/** The associated data of one challenge's sealed session. */
export function challengeContext(tokenHash: string): string {
  return `auth.challenge:${tokenHash}`;
}

/** The stored form of the handle. Never the handle itself. */
export function hashChallengeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");

  return (
    leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
  );
}

/**
 * Sealed session of one challenge, or the refusal when the row cannot be opened.
 *
 * A row that does not open is not a wrong code: it is a value this build did not write, and the
 * only honest answer is a platform error rather than a second invitation to guess.
 */
function openSealedSession(
  ciphertext: string,
  tokenHash: string,
  masterKey: string,
): z.infer<typeof sealedSessionSchema> {
  const box = unpackSecretBox(ciphertext);

  if (box === null || !tokenHashPattern.test(tokenHash)) {
    throw new AppError("INTERNAL_ERROR");
  }

  let plaintext: string;

  try {
    plaintext = openSecret(masterKey, box, challengeContext(tokenHash));
  } catch {
    throw new AppError("INTERNAL_ERROR");
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(plaintext);
  } catch {
    throw new AppError("INTERNAL_ERROR");
  }

  const parsed = sealedSessionSchema.safeParse(parsedJson);

  if (!parsed.success) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed.data;
}

/**
 * Create the challenge that stands between a correct password and a session.
 *
 * Called by the sign in service after the provider accepted the password and the platform accepted
 * the account. The pair is sealed, the handle is hashed, and the row is written in one insert; a
 * failure here is a failure to sign in, which is why the caller lets the error travel rather than
 * inventing a session.
 */
export async function issueTwoFactorChallenge(
  input: IssueChallengeInput,
  dependencies: TwoFactorLoginDependencies,
): Promise<IssuedChallenge> {
  const now = dependencies.now ?? ((): number => Date.now());
  const instant = now();
  const token = randomBytes(handleBytes).toString("base64url");
  const tokenHash = hashChallengeToken(token);
  const expiresAtEpochMs = instant + TWO_FACTOR_CHALLENGE_TTL_MS;

  const sealed = packSecretBox(
    sealSecret(
      dependencies.masterKey(),
      JSON.stringify({
        accessToken: input.session.accessToken,
        refreshToken: input.session.refreshToken,
        expiresAtEpochMs: input.session.expiresAtEpochMs,
        sessionId: input.session.sessionId,
      }),
      challengeContext(tokenHash),
    ),
  );

  await dependencies.rest.insert("auth_challenges", [
    {
      company_id: input.companyId,
      user_id: input.userId,
      purpose: "two_factor",
      token_hash: tokenHash,
      secret_ciphertext: sealed,
      expires_at: new Date(expiresAtEpochMs).toISOString(),
    },
  ]);

  return { token, expiresAtEpochMs };
}

async function readChallenge(
  dependencies: TwoFactorLoginDependencies,
  tokenHash: string,
): Promise<z.infer<typeof challengeRowSchema> | null> {
  const rows = await dependencies.rest.select(
    "auth_challenges",
    `select=id,user_id,company_id,secret_ciphertext,attempt_count,expires_at,consumed_at&token_hash=eq.${tokenHash}&purpose=eq.two_factor&deleted_at=is.null&limit=1`,
    challengeRowSchema,
  );

  return rows[0] ?? null;
}

async function readAccount(
  dependencies: TwoFactorLoginDependencies,
  userId: string,
): Promise<z.infer<typeof accountRowSchema> | null> {
  const rows = await dependencies.rest.select(
    "users",
    `select=id,company_id,status,email_verified_at,deleted_at,totp_secret_ciphertext,totp_confirmed_at,backup_code_hashes&id=eq.${encodeURIComponent(userId)}&limit=1`,
    accountRowSchema,
  );

  return rows[0] ?? null;
}

/** Retire a challenge: it either produced a session, or it has used its last guess. */
async function retireChallenge(
  dependencies: TwoFactorLoginDependencies,
  challengeId: string,
  instant: number,
  attempts: number | null,
): Promise<void> {
  await dependencies.rest.update("auth_challenges", `id=eq.${encodeURIComponent(challengeId)}`, {
    consumed_at: new Date(instant).toISOString(),
    ...(attempts === null ? {} : { attempt_count: attempts }),
  });
}

async function recordAttempt(
  dependencies: TwoFactorLoginDependencies,
  attempt: Parameters<LoginAttemptRecorder["record"]>[0],
): Promise<boolean> {
  try {
    return await dependencies.attempts.record(attempt);
  } catch {
    // A refusal has already been decided; a missing counter row must not change the answer.
    return false;
  }
}

/** Remove the backup code that was just used, keeping the others. */
function withoutBackupCode(hashes: readonly string[], index: number): readonly string[] {
  return hashes.filter((_hash, position) => position !== index);
}

/**
 * Complete a challenge with a code, or refuse it.
 *
 * The order is the security property: the challenge first, then the account, then the code. A
 * challenge that is missing, expired, consumed or retired answers the same generic sentence a wrong
 * password answers, because an attacker who can tell "this handle expired" from "this handle never
 * existed" learns which sign in attempts reached the second factor.
 */
export async function completeTwoFactorChallenge(
  input: CompleteChallengeInput,
  dependencies: TwoFactorLoginDependencies,
): Promise<CompletedChallenge> {
  // The schema describes the two fields a stranger controls; the address and the agent are facts
  // about the request, not part of the payload, and validating them as one object would let a
  // caller's extra field decide whether a correct code is looked at.
  const parsed = completeInputSchema.safeParse({
    challengeToken: input.challengeToken,
    code: input.code,
  });

  if (!parsed.success) {
    throw credentialRejectionError();
  }

  const now = dependencies.now ?? ((): number => Date.now());
  const instant = now();
  const tokenHash = hashChallengeToken(parsed.data.challengeToken);
  const challenge = await readChallenge(dependencies, tokenHash);

  if (challenge === null) {
    throw credentialRejectionError();
  }

  if (challenge.consumed_at !== null) {
    throw credentialRejectionError();
  }

  if (Date.parse(challenge.expires_at) <= instant) {
    throw credentialRejectionError();
  }

  if (challenge.attempt_count >= TWO_FACTOR_MAXIMUM_ATTEMPTS) {
    await retireChallenge(dependencies, challenge.id, instant, challenge.attempt_count);
    throw credentialRejectionError();
  }

  const account = await readAccount(dependencies, challenge.user_id);

  // An account that closed, lost its verification or deleted itself between the password and the
  // code is not a sign in, whatever code follows.
  if (
    account === null ||
    account.deleted_at !== null ||
    account.status !== "active" ||
    account.email_verified_at === null ||
    account.totp_confirmed_at === null
  ) {
    throw credentialRejectionError();
  }

  const secret = account.totp_secret_ciphertext;
  const rejected = async (): Promise<never> => {
    const attempts = challenge.attempt_count + 1;

    await dependencies.rest.update(
      "auth_challenges",
      `id=eq.${encodeURIComponent(challenge.id)}`,
      attempts >= TWO_FACTOR_MAXIMUM_ATTEMPTS
        ? { attempt_count: attempts, consumed_at: new Date(instant).toISOString() }
        : { attempt_count: attempts },
    );

    await recordAttempt(dependencies, {
      factor: "totp",
      outcome: "failed",
      companyId: account.company_id,
      userId: account.id,
      emailHash: null,
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });

    throw credentialRejectionError();
  };

  let method: SecondFactorMethod = "totp";
  let remainingHashes: readonly string[] | null = null;

  if (/^[0-9]{6}$/u.test(parsed.data.code)) {
    const step =
      secret === null
        ? null
        : verifyTotpCode(
            openEnrolledSecret(secret, account.id, dependencies.masterKey()),
            parsed.data.code,
            instant,
          );

    if (step === null) {
      await rejected();
    }
  } else if (isBackupCodeShaped(parsed.data.code)) {
    const normalized = normalizeBackupCode(parsed.data.code);
    let matchedIndex = -1;

    // Every stored verifier is checked, not until the first match: the loop's shape must not
    // depend on which code matched, or its duration would say which position it was.
    for (const [index, hash] of account.backup_code_hashes.entries()) {
      if (await verifyPasswordHash(normalized, hash)) {
        matchedIndex = index;
      }
    }

    if (matchedIndex < 0) {
      await rejected();
    }

    method = "backup_code";
    remainingHashes = withoutBackupCode(account.backup_code_hashes, matchedIndex);
  } else {
    await rejected();
  }

  const sealed = openSealedSession(challenge.secret_ciphertext, tokenHash, dependencies.masterKey());
  const proofKeys = await dependencies.rest.select(
    "device_proof_keys",
    `select=id&user_id=eq.${encodeURIComponent(account.id)}&revoked_at=is.null&deleted_at=is.null&limit=1`,
    z.object({ id: z.string().min(1).max(64) }),
  );
  const deviceProofRequired = proofKeys.length === 0;

  await retireChallenge(dependencies, challenge.id, instant, null);

  if (remainingHashes !== null) {
    // A backup code is one sign in. The array is rewritten without the verifier that matched, and
    // the audit entry says how many are left, so a merchant who runs out knows before they do.
    await dependencies.rest.update("users", `id=eq.${encodeURIComponent(account.id)}`, {
      backup_code_hashes: remainingHashes,
    });

    await dependencies.audit.append({
      action: "user.backup_code_used",
      actorUserId: account.id,
      entityType: "user",
      entityId: account.id,
      companyId: account.company_id,
      payload: { remaining: remainingHashes.length },
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });
  }

  const recorded = await recordAttempt(dependencies, {
    factor: "totp",
    outcome: "succeeded",
    companyId: account.company_id,
    userId: account.id,
    emailHash: null,
    ipAddress: input.remoteIp,
    userAgent: input.userAgent,
  });

  await dependencies.audit.append({
    action: "user.signed_in",
    actorUserId: account.id,
    entityType: "user",
    entityId: account.id,
    companyId: account.company_id,
    sessionId: sealed.sessionId,
    payload: {
      method,
      assurance_level: "aal2",
      device_proof_present: !deviceProofRequired,
      attempt_recorded: recorded,
    },
    ipAddress: input.remoteIp,
    userAgent: input.userAgent,
  });

  const payload: SessionCookiePayload = {
    accessToken: sealed.accessToken,
    refreshToken: sealed.refreshToken,
    expiresAtEpochMs: sealed.expiresAtEpochMs,
    userId: account.id,
    sessionId: sealed.sessionId,
    assuranceLevel: "aal2",
  };

  return {
    userId: account.id,
    companyId: account.company_id,
    deviceProofRequired,
    method,
    cookies: encodeSessionCookies(dependencies.cookiePolicy, payload, instant),
  };
}

/** True when the two hashes a caller holds describe the same handle. Exported for the gate. */
export function isSameChallengeToken(left: string, right: string): boolean {
  return constantTimeEquals(left, right);
}
