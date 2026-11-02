// path: lib/auth/step-up.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import { assertAccountUnlocked } from "./locks.ts";
import type { LoginAttemptRecorder } from "./login-attempts.ts";
import { verifyPasswordHash } from "./password.ts";
import type { RestClient } from "./rest.ts";
import type { SessionTokenStore } from "./session-rotation.ts";
import { isBackupCodeShaped, normalizeBackupCode, verifyTotpCode } from "./totp.ts";
import { openEnrolledSecret } from "./two-factor.ts";
import type { RequestActor } from "./types.ts";

/**
 * Step-up reauthentication: prove the second factor again, now, before a dangerous action.
 *
 * Section 22 lists the actions that a session alone may not perform - gateway keys, payouts, KYC
 * decisions and account unlocks - and line 244 lists the mechanism among the session protections.
 * Section 6 asks for the same thing on the super admin gateway page: "2FA and fresh
 * reauthentication".
 *
 * ## What "fresh" means, and where it is stored
 *
 * Two instants on the session row, in `public.sessions`:
 *
 *   - `mfa_verified_at` (`0010`) - when the second factor was satisfied at sign in. STEP 051 copies
 *     it into every rotation, so the family remembers it.
 *   - `reauthenticated_at` (`0091`, this STEP) - when the person proved it again inside the session,
 *     without signing in. Null until they do, and copied by a rotation for the same reason.
 *
 * The instant that counts is the **later** of the two, and it stops counting after
 * `STEP_UP_WINDOW_MS`. That is deliberately not "reauthentication only": a merchant who signed in
 * with the app two minutes ago has already proved exactly what the guard would ask for, and asking
 * again would teach people to treat the prompt as noise. What the window buys is the other case: a
 * session left open on an office machine all afternoon cannot unlock an account without somebody
 * standing there holding the app.
 *
 * ## Why the code, and not the password again
 *
 * The session already proved the password - that is what the sign in is. The second factor is the
 * part a stolen password cannot supply, and it is the part a stolen cookie cannot supply either,
 * because the secret is sealed in `users` and never sent to a browser. Asking for the password again
 * would put a credential through the network a second time to learn less. A backup code is accepted
 * for the reason section 22 built them: a person who still holds their codes but not their app.
 *
 * ## What a stale session gets, and what it does not learn
 *
 * `403 PERMISSION_DENIED` with `{ field: "session", rule: "reauth_required" }`. `403` and not `401`
 * because the caller is signed in and is allowed to do this - just not with a proof this old - and a
 * `401` would send them to the sign in form, which is a heavier answer that would not change the
 * session they already hold. The detail rule is the machine readable half a screen acts on; the
 * catalogue's sentence stays the one every 403 has.
 */

/** How long a proof counts. Ten minutes: long enough to finish what was started, short enough. */
export const STEP_UP_WINDOW_MS = 10 * 60_000;

/** The rule a stale session answers with, so a screen can tell it from a plain refusal. */
export const REAUTHENTICATION_REQUIRED_RULE = "reauth_required";

/** Where the proof that is still counting came from. */
export type StepUpProof = "reauthenticated" | "sign-in" | "none";

/** What one session's freshness is, as a value. */
export interface StepUpState {
  /** True when the proof is inside the window and the action may proceed. */
  readonly satisfied: boolean;
  /** The instant the proof was made - the later of the two - or null when there is none. */
  readonly provenAtEpochMs: number | null;
  /** When that proof stops counting, or null when there is none. */
  readonly freshUntilEpochMs: number | null;
  /** Which of the two instants produced it. */
  readonly proof: StepUpProof;
}

/**
 * Read one session's freshness.
 *
 * Pure, so the gate can hold the boundaries - one millisecond inside and outside the window - and so
 * a caller that only needs to know can ask without a throw.
 */
export function readStepUpState(
  actor: Pick<RequestActor, "mfaVerifiedAtEpochMs" | "reauthenticatedAtEpochMs">,
  instant: number,
  windowMs: number = STEP_UP_WINDOW_MS,
): StepUpState {
  const reauthenticatedAt = actor.reauthenticatedAtEpochMs;
  const signInAt = actor.mfaVerifiedAtEpochMs;

  const proof: StepUpProof =
    reauthenticatedAt !== null && (signInAt === null || reauthenticatedAt >= signInAt)
      ? "reauthenticated"
      : signInAt !== null
        ? "sign-in"
        : "none";
  const provenAtEpochMs = proof === "reauthenticated" ? reauthenticatedAt : signInAt;

  if (provenAtEpochMs === null) {
    return { satisfied: false, provenAtEpochMs: null, freshUntilEpochMs: null, proof };
  }

  const freshUntilEpochMs = provenAtEpochMs + windowMs;

  return {
    satisfied: instant < freshUntilEpochMs && instant >= provenAtEpochMs,
    provenAtEpochMs,
    freshUntilEpochMs,
    proof,
  };
}

/** The refusal a stale session answers. */
export function reauthenticationRequiredError(): AppError {
  return new AppError("PERMISSION_DENIED", {
    details: [{ field: "session", rule: REAUTHENTICATION_REQUIRED_RULE }],
  });
}

/**
 * Refuse an action whose session's proof has gone stale.
 *
 * One call, in every endpoint section 22 lists. The endpoints that exist today call it after the
 * proof of STEP 050 and the device trust of STEP 052, so the three answers stay distinguishable:
 * `401` means no session, `403` with `reauth_required` means prove it again, and `403` with nothing
 * else means the account may not do this at all.
 */
export function requireFreshReauthentication(
  actor: Pick<RequestActor, "mfaVerifiedAtEpochMs" | "reauthenticatedAtEpochMs">,
  instant: number = Date.now(),
  windowMs: number = STEP_UP_WINDOW_MS,
): StepUpState {
  const state = readStepUpState(actor, instant, windowMs);

  if (!state.satisfied) {
    throw reauthenticationRequiredError();
  }

  return state;
}

const accountSchema = z.object({
  id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  status: z.string().min(1).max(16),
  deleted_at: z.string().nullable(),
  totp_secret_ciphertext: z.string().max(512).nullable(),
  totp_confirmed_at: z.string().max(40).nullable(),
  backup_code_hashes: z.array(z.string().min(1).max(512)).max(20),
});

export interface StepUpDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly sessions: SessionTokenStore;
  readonly attempts: LoginAttemptRecorder;
  readonly masterKey: () => string;
  readonly now?: () => number;
}

export interface ReauthenticateInput {
  readonly userId: string;
  readonly companyId: string | null;
  /** The session row the cookie resolved to. A step-up is always inside a bound session. */
  readonly sessionId: string | null;
  readonly code: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface ReauthenticatedSession {
  readonly status: "reauthenticated";
  readonly proof: "totp" | "backup_code";
  readonly provenAtEpochMs: number;
  readonly freshUntilEpochMs: number;
  /** How many backup codes the account has left, or null when a code from the app was used. */
  readonly remainingBackupCodes: number | null;
}

/** The one refusal a person can act on: whatever they typed is not a code that works. */
function invalidCodeError(): AppError {
  return new AppError("VALIDATION_FAILED", { details: [{ field: "code", rule: "invalid_code" }] });
}

async function readAccount(
  dependencies: StepUpDependencies,
  userId: string,
): Promise<z.infer<typeof accountSchema> | null> {
  const rows = await dependencies.rest.select(
    "users",
    `select=id,company_id,status,deleted_at,totp_secret_ciphertext,totp_confirmed_at,backup_code_hashes` +
      `&id=eq.${encodeURIComponent(userId)}&deleted_at=is.null&limit=1`,
    accountSchema,
  );

  return rows[0] ?? null;
}

/** Remove the backup code that was just used, keeping the others. */
function withoutBackupCode(hashes: readonly string[], index: number): readonly string[] {
  return hashes.filter((_hash, position) => position !== index);
}

/**
 * Prove the second factor again, inside the session that is already signed in.
 *
 * The order is the security property: the session must exist and be live (the caller's cookie was
 * resolved before this runs), the account must not be locked - section 22's lock survives a correct
 * code, which is the whole point of it - the account must still be active and enrolled, and only
 * then is the code looked at.
 *
 * A wrong code is not free: it is recorded as a failed `totp` attempt through the same recorder the
 * sign in uses, so two wrong codes are a lock there too, and the audit entry says a step-up was
 * refused without saying what was typed. A correct backup code is spent, because a code is one use.
 */
export async function reauthenticateSession(
  input: ReauthenticateInput,
  dependencies: StepUpDependencies,
): Promise<ReauthenticatedSession> {
  const instant = (dependencies.now ?? Date.now)();

  if (input.sessionId === null) {
    throw new AppError("AUTHENTICATION_REQUIRED");
  }

  // Section 22: during the lock, even a correct second factor does nothing. Asked before the code,
  // so a locked account cannot be used to test codes.
  await assertAccountUnlocked(dependencies.rest, input.userId, instant);

  const account = await readAccount(dependencies, input.userId);

  if (account === null || account.status !== "active") {
    throw new AppError("AUTHENTICATION_REQUIRED");
  }

  if (account.totp_confirmed_at === null || account.totp_secret_ciphertext === null) {
    // An account with no second factor cannot step up. That is not a wrong code: it is a state the
    // enrolment of STEP 041 ends, and the screen says so rather than inviting another guess.
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "code", rule: "two_factor_required" }],
    });
  }

  const rejected = async (): Promise<never> => {
    await dependencies.attempts
      .record({
        factor: "totp",
        outcome: "failed",
        userId: account.id,
        companyId: account.company_id,
        emailHash: null,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      })
      .catch(() => false);

    await dependencies.audit
      .append({
        action: "session.reauth_rejected",
        actorUserId: account.id,
        entityType: "session",
        entityId: input.sessionId,
        companyId: account.company_id,
        ...(input.sessionId === null ? {} : { sessionId: input.sessionId }),
        payload: { reason: "invalid_code" },
        ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
      })
      .catch(() => undefined);

    throw invalidCodeError();
  };

  let method: "totp" | "backup_code" = "totp";
  let remainingHashes: readonly string[] | null = null;

  if (/^[0-9]{6}$/u.test(input.code.trim())) {
    const secret = openEnrolledSecret(
      account.totp_secret_ciphertext,
      account.id,
      dependencies.masterKey(),
    );

    if (verifyTotpCode(secret, input.code, instant) === null) {
      await rejected();
    }
  } else if (isBackupCodeShaped(input.code)) {
    const normalized = normalizeBackupCode(input.code);
    let matchedIndex = -1;

    // Every verifier is checked, not until the first match: the loop's shape must not depend on
    // which code matched, or its duration would say which position it was.
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

  const stampedAt = new Date(instant).toISOString();

  // The row is updated only while it is live: a session revoked between the cookie read and this
  // write must not come back to life with a fresh proof attached.
  await dependencies.sessions.update(input.sessionId, "revoked_at=is.null", {
    reauthenticated_at: stampedAt,
  });

  if (remainingHashes !== null) {
    await dependencies.rest.update("users", `id=eq.${encodeURIComponent(account.id)}`, {
      backup_code_hashes: remainingHashes,
    });
  }

  await dependencies.attempts
    .record({
      factor: "totp",
      outcome: "succeeded",
      userId: account.id,
      companyId: account.company_id,
      emailHash: null,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    })
    .catch(() => false);

  await dependencies.audit
    .append({
      action: "session.reauthenticated",
      actorUserId: account.id,
      entityType: "session",
      entityId: input.sessionId,
      companyId: account.company_id,
      sessionId: input.sessionId,
      payload: {
        method,
        proven_at: stampedAt,
        fresh_until: new Date(instant + STEP_UP_WINDOW_MS).toISOString(),
        remaining_backup_codes: remainingHashes === null ? null : remainingHashes.length,
      },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return {
    status: "reauthenticated",
    proof: method,
    provenAtEpochMs: instant,
    freshUntilEpochMs: instant + STEP_UP_WINDOW_MS,
    remainingBackupCodes: remainingHashes === null ? null : remainingHashes.length,
  };
}
