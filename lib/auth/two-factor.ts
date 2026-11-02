// path: lib/auth/two-factor.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import { hashPassword } from "./password.ts";
import { encodeQr, type QrMatrix } from "../qr/qr.ts";
import { qrPath, type QrPath } from "../qr/path.ts";
import type { RestClient } from "./rest.ts";
import { openSecret, packSecretBox, sealSecret, unpackSecretBox } from "./secrets.ts";
import {
  BACKUP_CODE_COUNT,
  formatSecretForEntry,
  generateBackupCodes,
  generateTotpSecret,
  normalizeBackupCode,
  totpUri,
  verifyTotpCode,
} from "./totp.ts";

/**
 * TOTP enrolment: the secret, the QR code, the first code and the backup codes.
 *
 * Section 22 makes 2FA mandatory for every account holding a role, and `0003` is the storage:
 * `totp_secret_ciphertext`, `totp_confirmed_at` and `backup_code_hashes`. This file is the two
 * halves of enrolment and nothing else - verifying a code at sign in is STEP 042, the reset after a
 * lost device is STEP 044 - and it is written as one state machine, because a half enrolled account
 * is the state that locks people out:
 *
 *   1. `start` writes a fresh sealed secret and leaves `totp_confirmed_at` null. An account in this
 *      state has a secret nobody has proved they can read, so nothing else may treat it as two
 *      factor protected.
 *   2. `confirm` accepts the first code, stamps the confirmation instant and replaces the backup
 *      codes with ten fresh ones. Only then does the account hold a second factor.
 *
 * ## The secret at rest
 *
 * Sealed with AES-256-GCM and the same `ENCRYPTION_MASTER_KEY` that protects the Turnstile secret,
 * with associated data naming the account, so a ciphertext copied from one row to another does not
 * open. `0003` bounds the column at 512 characters and the packed box is under a hundred, which
 * leaves room for a longer tag later.
 *
 * ## The backup codes
 *
 * Ten, shown once, never stored in clear: the column holds scrypt verifiers, one per code, and the
 * comparison is `password.ts`'s. They are ten characters from an alphabet without look-alikes,
 * because they are read off a screen and typed on a phone.
 */

const userRowSchema = z.object({
  id: z.string().min(1).max(64),
  email: z.string().min(3).max(254),
  company_id: z.string().min(1).max(64).nullable(),
  totp_secret_ciphertext: z.string().max(512).nullable(),
  totp_confirmed_at: z.string().nullable(),
});

const codeSchema = z.string().trim().min(6).max(10);

/** The associated data of one account's secret. */
export function twoFactorContext(userId: string): string {
  return `users.totp:${userId}`;
}

export interface TwoFactorDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  /** Read lazily: the module never touches the environment at import time. */
  readonly masterKey: () => string;
  /** The name an authenticator app shows, taken from the platform's own strings. */
  readonly issuer: string;
  readonly now?: () => number;
}

export interface StartEnrolmentInput {
  readonly userId: string;
}

export interface StartEnrolmentResult {
  /** The base32 secret, for the manual entry path beside the QR code. */
  readonly secret: string;
  /** The secret in four character groups, easier to type than the raw string. */
  readonly secretForEntry: string;
  readonly uri: string;
  /** The symbol, or null when the URI is longer than this encoder's largest version. */
  readonly qr: QrMatrix | null;
  /** The drawing of that symbol, or null for the same reason. */
  readonly symbol: QrPath | null;
}

export interface ConfirmEnrolmentInput {
  readonly userId: string;
  readonly code: string;
}

export interface ConfirmEnrolmentResult {
  readonly backupCodes: readonly string[];
}

async function readAccount(
  dependencies: TwoFactorDependencies,
  userId: string,
): Promise<z.infer<typeof userRowSchema>> {
  const rows = await dependencies.rest.select(
    "users",
    `select=id,email,company_id,totp_secret_ciphertext,totp_confirmed_at&id=eq.${encodeURIComponent(userId)}&deleted_at=is.null&limit=1`,
    userRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    // The actor record said this person exists; a missing row is an account the platform cannot
    // offer 2FA to, which is an authentication answer and not a form problem.
    throw new AppError("AUTHENTICATION_REQUIRED");
  }

  return row;
}

export async function startTotpEnrolment(
  input: StartEnrolmentInput,
  dependencies: TwoFactorDependencies,
): Promise<StartEnrolmentResult> {
  const account = await readAccount(dependencies, input.userId);

  if (account.totp_confirmed_at !== null) {
    // Replacing a confirmed secret is a reset, which needs the identity checks of STEP 044.
    throw new AppError("CONFLICT");
  }

  const secret = generateTotpSecret();
  const sealed = packSecretBox(
    sealSecret(dependencies.masterKey(), secret, twoFactorContext(account.id)),
  );

  await dependencies.rest.update("users", `id=eq.${encodeURIComponent(account.id)}`, {
    totp_secret_ciphertext: sealed,
    totp_confirmed_at: null,
  });

  await dependencies.audit.append({
    action: "user.totp_enrolment_started",
    actorUserId: account.id,
    entityType: "user",
    entityId: account.id,
    companyId: account.company_id,
    payload: { method: "totp" },
  });

  const uri = totpUri(dependencies.issuer, account.email, secret);
  const qr = encodeQr(uri);

  return {
    secret,
    secretForEntry: formatSecretForEntry(secret),
    uri,
    qr,
    symbol: qr === null ? null : qrPath(qr, { moduleSize: 4, quietZone: 4 }),
  };
}

export async function confirmTotpEnrolment(
  input: ConfirmEnrolmentInput,
  dependencies: TwoFactorDependencies,
): Promise<ConfirmEnrolmentResult> {
  const parsedCode = codeSchema.safeParse(input.code);

  if (!parsedCode.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "code", rule: "invalid_format" }],
    });
  }

  const account = await readAccount(dependencies, input.userId);

  if (account.totp_confirmed_at !== null) {
    throw new AppError("CONFLICT");
  }

  if (account.totp_secret_ciphertext === null) {
    // A confirmation without a started enrolment is a request out of order, not a wrong code.
    throw new AppError("CONFLICT");
  }

  const box = unpackSecretBox(account.totp_secret_ciphertext);

  if (box === null) {
    throw new AppError("INTERNAL_ERROR");
  }

  const secret = openSecret(dependencies.masterKey(), box, twoFactorContext(account.id));
  const now = dependencies.now ?? ((): number => Date.now());
  const instant = now();
  const step = verifyTotpCode(secret, parsedCode.data, instant);

  if (step === null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "code", rule: "invalid_code" }],
    });
  }

  const backupCodes = generateBackupCodes(BACKUP_CODE_COUNT);
  const hashes: string[] = [];

  for (const code of backupCodes) {
    hashes.push(await hashPassword(normalizeBackupCode(code)));
  }

  await dependencies.rest.update("users", `id=eq.${encodeURIComponent(account.id)}`, {
    totp_confirmed_at: new Date(instant).toISOString(),
    backup_code_hashes: hashes,
  });

  await dependencies.audit.append({
    action: "user.totp_enrolled",
    actorUserId: account.id,
    entityType: "user",
    entityId: account.id,
    companyId: account.company_id,
    payload: { method: "totp", backup_codes: backupCodes.length, step },
  });

  return { backupCodes };
}

/** True when an account holds a confirmed second factor. */
export function hasConfirmedTwoFactor(account: {
  readonly totp_confirmed_at: string | null;
}): boolean {
  return account.totp_confirmed_at !== null;
}

/** The secret of a confirmed account, for STEP 042's verification step. */
export function openEnrolledSecret(
  ciphertext: string,
  userId: string,
  masterKey: string,
): string {
  const box = unpackSecretBox(ciphertext);

  if (box === null) {
    throw new AppError("INTERNAL_ERROR");
  }

  return openSecret(masterKey, box, twoFactorContext(userId));
}
