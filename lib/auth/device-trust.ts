// path: lib/auth/device-trust.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import { getMessage } from "../i18n/messages.ts";
import type { Logger } from "../logger/logger.ts";
import type { AuditTrail } from "./audit.ts";
import type { RestClient } from "./rest.ts";
import { openSecret, unpackSecretBox } from "./secrets.ts";
import { twoFactorContext } from "./two-factor.ts";
import { verifyTotpCode } from "./totp.ts";

/**
 * New device detection: the alert of section 23 and the second factor step of section 22.
 *
 * ## What a new device is
 *
 * `0009` answers it in one column: a `device_proof_keys` row whose `trusted_at` is null. STEP 049
 * writes every enrolment that way, on purpose, so nothing is trusted because a browser asked; STEP
 * 051 binds a session to that row and reports the flag without enforcing it. This module is the STEP
 * that (a) tells the owner, (b) refuses the dangerous parts of the platform until the device is
 * confirmed, and (c) turns the flag over.
 *
 * ## Why the confirmation is the second factor, and not a code by email
 *
 * `email_send_logs` (0061) carries a template key, a recipient and a reference; the body of a send is
 * rendered by the email system of section 23 from `email_templates`. There is no field for a per-send
 * secret, and adding one would be a change to STEP 032's table for STEP 227's worker to honour. So
 * the platform does not pretend to email a code it cannot email. What it does instead is exactly
 * what the feature list asks for:
 *
 *   - section 23's **new device alert** goes to the account's own address the moment a session binds
 *     to a device nobody has confirmed, so the owner learns even if they are not looking;
 *   - section 22's **extra verification** is the authenticator code, which is the part a stolen
 *     password cannot supply.
 *
 * A merchant who has lost their authenticator uses the reset flow of STEP 044 and confirms the new
 * device afterwards; that is the same route the platform already documents for a lost second factor.
 *
 * ## Four decisions, and where each one lives
 *
 *   - **detect** - `challengeDeviceTrust` is called when a session *starts* on an untrusted device,
 *     and only then: a rotation of an existing session is not a new device.
 *   - **tell** - one `new_device_alert` row per challenge. `0090` refuses two challenges sharing an
 *     alert and two live challenges for one device, so a reload cannot mail the owner twice.
 *   - **refuse** - `verifySensitiveRequest` (STEP 050) answers `untrusted-device` until the row is
 *     confirmed; the enrolment of the second factor stays reachable, or a brand new account could
 *     never satisfy the step that would trust its first device.
 *   - **confirm** - `confirmDeviceTrust` accepts the authenticator code, spends an attempt when it is
 *     wrong, and stamps `trusted_at` once, with the audit entry the platform expects of a security
 *     decision.
 *
 * Nothing here throws for a deployment problem: a queue that is down, a sender that is not
 * configured and an account with no address are answered as values, and the challenge is recorded
 * either way. Only a caller's own mistake - a code that is not a code - is a refusal.
 */

/** The section 23 template key this alert uses. `0060` and `0061` both accept it. */
export const NEW_DEVICE_TEMPLATE_KEY = "new_device_alert";

/** What the email is about, in the vocabulary of `email_send_logs.reference_kind`. */
export const NEW_DEVICE_REFERENCE_KIND = "account";

/** How many codes one challenge accepts. `0090` bounds the same number. */
export const DEVICE_TRUST_MAXIMUM_ATTEMPTS = 5;

/** How long a challenge can be answered. `0090` refuses a window longer than a day. */
export const DEVICE_TRUST_WINDOW_MS = 24 * 60 * 60_000;

/** The retry budget of the alert, matching the log's default. */
export const DEVICE_TRUST_ALERT_MAX_ATTEMPTS = 3;

/** The reason a losing race writes. `0061` requires a dropped row to carry one. */
const DUPLICATE_ALERT_REASON = "The device challenge was already recorded.";

const deviceRowSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80).nullable(),
  trusted_at: z.string().min(20).max(40).nullable(),
});

const challengeRowSchema = z.object({
  id: z.string().min(1).max(64),
  alert_send_id: z.string().min(1).max(64).nullable(),
  attempts: z.number().int().min(0).max(10),
  max_attempts: z.number().int().min(1).max(10),
  expires_at: z.string().min(20).max(40),
  consumed_at: z.string().min(20).max(40).nullable(),
});

const accountSchema = z.object({
  email: z.string().min(3).max(320),
  totp_secret_ciphertext: z.string().max(512).nullable(),
  totp_confirmed_at: z.string().min(20).max(40).nullable(),
});

const sendingMethodSchema = z.object({ method: z.enum(["smtp", "api"]) });

const sendRowSchema = z.object({ id: z.string().min(1).max(64) });

/** What every read needs: the data access of this module and the clock a test may replace. */
export interface DeviceTrustReadDependencies {
  readonly rest: RestClient;
  readonly now?: () => number;
}

export interface DeviceTrustDependencies extends DeviceTrustReadDependencies {
  readonly audit: AuditTrail;
  readonly logger: Logger;
  /** Read lazily: the module never touches the environment at import time. */
  readonly masterKey: () => string;
}

function clock(dependencies: { readonly now?: () => number }): number {
  return (dependencies.now ?? Date.now)();
}

/** What a challenge attempt produced. */
export type ChallengeOutcome =
  | {
      readonly status: "challenged";
      readonly challengeId: string;
      readonly alertSendId: string | null;
      readonly expiresAtEpochMs: number;
    }
  | { readonly status: "already_open"; readonly challengeId: string; readonly expiresAtEpochMs: number }
  | { readonly status: "already_trusted" }
  | { readonly status: "no_device" }
  | { readonly status: "failed" };

export interface ChallengeInput {
  readonly userId: string;
  readonly companyId: string | null;
  readonly deviceId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/** The trust facts a screen or a route needs about one device. */
export interface DeviceTrustState {
  readonly deviceId: string;
  readonly label: string | null;
  readonly trustedAtEpochMs: number | null;
  readonly challengeExpiresAtEpochMs: number | null;
  readonly attemptsRemaining: number | null;
}

/** The sending method the office made active, or null when section 23 has none configured. */
async function readSendingMethod(
  dependencies: DeviceTrustReadDependencies,
): Promise<"smtp" | "api" | null> {
  const rows = await dependencies.rest.select(
    "email_settings",
    "select=method&status=eq.active&deleted_at=is.null&limit=1",
    sendingMethodSchema,
  );

  return rows[0]?.method ?? null;
}

/** The device row, if it is this account's and still live. */
async function readDevice(
  dependencies: DeviceTrustReadDependencies,
  userId: string,
  deviceId: string,
): Promise<z.infer<typeof deviceRowSchema> | null> {
  const rows = await dependencies.rest.select(
    "device_proof_keys",
    `select=id,label,trusted_at&id=eq.${encodeURIComponent(deviceId)}` +
      `&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&deleted_at=is.null&limit=1`,
    deviceRowSchema,
  );

  return rows[0] ?? null;
}

async function readLiveChallenge(
  dependencies: DeviceTrustReadDependencies,
  deviceId: string,
): Promise<z.infer<typeof challengeRowSchema> | null> {
  const rows = await dependencies.rest.select(
    "device_trust_challenges",
    "select=id,alert_send_id,attempts,max_attempts,expires_at,consumed_at" +
      `&device_proof_key_id=eq.${encodeURIComponent(deviceId)}` +
      "&consumed_at=is.null&revoked_at=is.null&deleted_at=is.null&limit=1",
    challengeRowSchema,
  );

  return rows[0] ?? null;
}

/** The account's own address, which is where a new device alert goes. */
async function readRecipient(
  dependencies: DeviceTrustReadDependencies,
  userId: string,
): Promise<z.infer<typeof accountSchema> | null> {
  const rows = await dependencies.rest.select(
    "users",
    `select=email,totp_secret_ciphertext,totp_confirmed_at&id=eq.${encodeURIComponent(userId)}` +
      "&deleted_at=is.null&limit=1",
    accountSchema,
  );

  return rows[0] ?? null;
}

/**
 * Queue the section 23 alert for one new device.
 *
 * The row is written before the challenge points at it, and a lost race marks the extra row
 * `dropped` - the state `0061` already has, with a reason - so the owner receives one email and the
 * log still tells the whole story. A deployment without a sending method answers `null`, and the
 * challenge is still recorded: a device nobody could be told about is still a device to confirm.
 */
async function queueAlert(
  input: ChallengeInput,
  account: z.infer<typeof accountSchema>,
  dependencies: DeviceTrustDependencies,
): Promise<string | null> {
  const method = await readSendingMethod(dependencies);

  if (method === null) {
    dependencies.logger.warn("no email sending method is active, so no new device alert was queued", {
      accountId: input.userId,
      deviceId: input.deviceId,
    });

    return null;
  }

  try {
    const rows = await dependencies.rest.insertReturning(
      "email_send_logs",
      [
        {
          company_id: input.companyId,
          template_key: NEW_DEVICE_TEMPLATE_KEY,
          recipient_email: account.email,
          recipient_user_id: input.userId,
          subject: getMessage("email.newDevice.subject"),
          provider: method,
          max_attempts: DEVICE_TRUST_ALERT_MAX_ATTEMPTS,
          reference_kind: NEW_DEVICE_REFERENCE_KIND,
          reference_id: input.userId,
          queued_at: new Date(clock(dependencies)).toISOString(),
        },
      ],
      sendRowSchema,
    );

    return rows[0]?.id ?? null;
  } catch (error) {
    dependencies.logger.warn("the new device alert could not be queued", {
      accountId: input.userId,
      deviceId: input.deviceId,
      reason: error instanceof Error ? error.message : "unknown",
    });

    return null;
  }
}

/**
 * Record that a session started on a device nobody has confirmed, and tell the owner.
 *
 * Called once per session that binds to an untrusted device. A device that is already trusted, a
 * device that is not this account's, and a challenge that is still open are all answers rather than
 * errors: the caller's job is to say `trusted: false` in its own answer, not to handle a failure.
 */
export async function challengeDeviceTrust(
  input: ChallengeInput,
  dependencies: DeviceTrustDependencies,
): Promise<ChallengeOutcome> {
  const device = await readDevice(dependencies, input.userId, input.deviceId);

  if (device === null) {
    return { status: "no_device" };
  }

  if (device.trusted_at !== null) {
    return { status: "already_trusted" };
  }

  const open = await readLiveChallenge(dependencies, device.id);
  const nowEpochMs = clock(dependencies);

  if (open !== null && Date.parse(open.expires_at) > nowEpochMs) {
    // One live challenge is enough: the owner already has an alert about this device, and a second
    // one would be a second email about the same machine.
    return {
      status: "already_open",
      challengeId: open.id,
      expiresAtEpochMs: Date.parse(open.expires_at),
    };
  }

  if (open !== null) {
    // An expired challenge is closed rather than left to be answered late; `0090` allows one live
    // row per device, so the new one cannot be written until this one ends.
    await dependencies.rest
      .update(
        "device_trust_challenges",
        `id=eq.${encodeURIComponent(open.id)}&consumed_at=is.null&revoked_at=is.null`,
        { revoked_at: new Date(nowEpochMs).toISOString() },
      )
      .catch(() => undefined);
  }

  const account = await readRecipient(dependencies, input.userId);

  if (account === null) {
    return { status: "failed" };
  }

  const alertSendId = await queueAlert(input, account, dependencies);
  const expiresAtEpochMs = nowEpochMs + DEVICE_TRUST_WINDOW_MS;

  let challengeId: string | null = null;

  try {
    const inserted = await dependencies.rest.insertReturning(
      "device_trust_challenges",
      [
        {
          company_id: input.companyId,
          user_id: input.userId,
          device_proof_key_id: device.id,
          alert_send_id: alertSendId,
          attempts: 0,
          max_attempts: DEVICE_TRUST_MAXIMUM_ATTEMPTS,
          issued_at: new Date(nowEpochMs).toISOString(),
          expires_at: new Date(expiresAtEpochMs).toISOString(),
        },
      ],
      z.object({ id: z.string().min(1).max(64) }),
    );
    challengeId = inserted[0]?.id ?? null;
  } catch {
    // `device_trust_challenges_live_device_key` refused a second live row, which means another
    // request opened the challenge while this one was reading. That is the answer, not a failure.
    const raced = await readLiveChallenge(dependencies, device.id);

    if (alertSendId !== null) {
      await dependencies.rest
        .update(
          "email_send_logs",
          `id=eq.${encodeURIComponent(alertSendId)}&status=eq.queued`,
          { status: "dropped", failure_reason: DUPLICATE_ALERT_REASON },
        )
        .catch(() => undefined);
    }

    return raced === null
      ? { status: "failed" }
      : {
          status: "already_open",
          challengeId: raced.id,
          expiresAtEpochMs: Date.parse(raced.expires_at),
        };
  }

  if (challengeId === null) {
    return { status: "failed" };
  }

  await dependencies.audit
    .append({
      action: "device.trust_challenged",
      actorUserId: input.userId,
      entityType: "device_proof_key",
      entityId: device.id,
      companyId: input.companyId,
      payload: {
        challenge_id: challengeId,
        alert_send_id: alertSendId,
        label: device.label,
        expires_at: new Date(expiresAtEpochMs).toISOString(),
        alert_queued: alertSendId !== null,
      },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return { status: "challenged", challengeId, alertSendId, expiresAtEpochMs };
}

/** The trust state of one device, or null when it is not this account's. */
export async function readDeviceTrust(
  input: { readonly userId: string; readonly deviceId: string },
  dependencies: DeviceTrustReadDependencies,
): Promise<DeviceTrustState | null> {
  const device = await readDevice(dependencies, input.userId, input.deviceId);

  if (device === null) {
    return null;
  }

  const challenge = await readLiveChallenge(dependencies, device.id);
  const expiresAt = challenge === null ? null : Date.parse(challenge.expires_at);
  const live = expiresAt !== null && expiresAt > clock(dependencies) && challenge?.consumed_at === null;

  return {
    deviceId: device.id,
    label: device.label,
    trustedAtEpochMs: device.trusted_at === null ? null : Date.parse(device.trusted_at),
    challengeExpiresAtEpochMs: live ? expiresAt : null,
    attemptsRemaining:
      live && challenge !== null ? Math.max(0, challenge.max_attempts - challenge.attempts) : null,
  };
}

export interface ConfirmInput {
  readonly userId: string;
  readonly companyId: string | null;
  readonly deviceId: string;
  /** The device this session is bound to. Confirming another device is not this step's business. */
  readonly sessionDeviceId: string | null;
  readonly code: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface ConfirmOutcome {
  readonly status: "trusted" | "already_trusted";
  readonly deviceId: string;
  readonly trustedAtEpochMs: number;
}

/**
 * The account's authenticator secret, opened for one user.
 *
 * A row that does not open is not a wrong code: it is a value this build did not write, and the only
 * honest answer is a platform error rather than another invitation to guess. `packSecretBox` and
 * `unpackSecretBox` are the storage form `two-factor.ts` already writes, so the same sealed value is
 * read here without a second format.
 */
function readTotpSecret(
  account: z.infer<typeof accountSchema>,
  userId: string,
  dependencies: DeviceTrustDependencies,
): string {
  const ciphertext = account.totp_secret_ciphertext;

  if (ciphertext === null) {
    throw new AppError("INTERNAL_ERROR");
  }

  const box = unpackSecretBox(ciphertext);

  if (box === null) {
    throw new AppError("INTERNAL_ERROR");
  }

  let secret: string;

  try {
    secret = openSecret(dependencies.masterKey(), box, twoFactorContext(userId));
  } catch {
    throw new AppError("INTERNAL_ERROR");
  }

  if (secret.trim().length === 0) {
    throw new AppError("INTERNAL_ERROR");
  }

  return secret;
}

function formRefusal(field: string, rule: string): AppError {
  return new AppError("VALIDATION_FAILED", { details: [{ field, rule }] });
}

/**
 * Confirm one new device with the account's second factor.
 *
 * The order of the checks is the security property:
 *
 *   1. the device must be a live key of the caller - the composite key in `0009` would refuse the
 *      write anyway, but a form-shaped answer keeps that from surfacing as a dependency failure;
 *   2. the session must be bound to *that* device, so a session on a trusted machine cannot be used
 *      to trust a machine somebody else holds;
 *   3. a live challenge must exist, unexpired and under its attempt budget;
 *   4. the code must be the account's authenticator code, verified against the sealed secret;
 *   5. only then is `trusted_at` written, the challenge consumed, and the decision audited.
 *
 * A wrong code spends an attempt before the refusal, so a guess costs something even when the
 * caller ignores the answer.
 */
export async function confirmDeviceTrust(
  input: ConfirmInput,
  dependencies: DeviceTrustDependencies,
): Promise<ConfirmOutcome> {
  const device = await readDevice(dependencies, input.userId, input.deviceId);

  if (device === null) {
    throw formRefusal("deviceId", "unknown_device");
  }

  if (input.sessionDeviceId === null || input.sessionDeviceId !== device.id) {
    // 403 and not 401: the caller proved an account and is not allowed to do this from here.
    throw new AppError("PERMISSION_DENIED");
  }

  if (device.trusted_at !== null) {
    return {
      status: "already_trusted",
      deviceId: device.id,
      trustedAtEpochMs: Date.parse(device.trusted_at),
    };
  }

  const challenge = await readLiveChallenge(dependencies, device.id);
  const nowEpochMs = clock(dependencies);

  if (challenge === null) {
    throw formRefusal("deviceId", "no_live_challenge");
  }

  if (Date.parse(challenge.expires_at) <= nowEpochMs) {
    throw formRefusal("code", "challenge_expired");
  }

  if (challenge.attempts >= challenge.max_attempts) {
    throw formRefusal("code", "attempts_exhausted");
  }

  const account = await readRecipient(dependencies, input.userId);

  if (account === null) {
    throw new AppError("AUTHENTICATION_REQUIRED");
  }

  if (account.totp_confirmed_at === null || account.totp_secret_ciphertext === null) {
    throw formRefusal("code", "two_factor_required");
  }

  const step =
    verifyTotpCode(readTotpSecret(account, input.userId, dependencies), input.code, nowEpochMs);

  if (step === null) {
    const attempts = challenge.attempts + 1;

    await dependencies.rest
      .update(
        "device_trust_challenges",
        `id=eq.${encodeURIComponent(challenge.id)}&consumed_at=is.null&revoked_at=is.null`,
        { attempts },
      )
      .catch(() => undefined);

    await dependencies.audit
      .append({
        action: "device.trust_rejected",
        actorUserId: input.userId,
        entityType: "device_proof_key",
        entityId: device.id,
        companyId: input.companyId,
        payload: {
          challenge_id: challenge.id,
          attempts,
          max_attempts: challenge.max_attempts,
        },
        ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
      })
      .catch(() => undefined);

    throw formRefusal("code", "invalid_code");
  }

  const instant = new Date(nowEpochMs).toISOString();

  await dependencies.rest.update(
    "device_proof_keys",
    `id=eq.${encodeURIComponent(device.id)}&user_id=eq.${encodeURIComponent(input.userId)}` +
      "&trusted_at=is.null&revoked_at=is.null&deleted_at=is.null",
    { trusted_at: instant },
  );

  await dependencies.rest.update(
    "device_trust_challenges",
    `id=eq.${encodeURIComponent(challenge.id)}&consumed_at=is.null&revoked_at=is.null`,
    { consumed_at: instant, attempts: challenge.attempts + 1 },
  );

  await dependencies.audit
    .append({
      action: "device.trusted",
      actorUserId: input.userId,
      entityType: "device_proof_key",
      entityId: device.id,
      companyId: input.companyId,
      payload: {
        challenge_id: challenge.id,
        label: device.label,
        trusted_at: instant,
        attempts: challenge.attempts + 1,
      },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return { status: "trusted", deviceId: device.id, trustedAtEpochMs: nowEpochMs };
}
