// path: lib/auth/backup-codes.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import { hashPassword } from "./password.ts";
import type { RestClient } from "./rest.ts";
import { BACKUP_CODE_COUNT, generateBackupCodes, normalizeBackupCode, verifyTotpCode } from "./totp.ts";
import { openEnrolledSecret } from "./two-factor.ts";

/**
 * Fresh backup codes, and the state of the second factor, for a signed in account.
 *
 * Section 22 lists two sentences next to each other, and this file is the second of them:
 *
 *   - "2FA TOTP is mandatory for every account holding role, with backup codes";
 *   - "Merchants can generate fresh backup codes in advance."
 *
 * "In advance" is the whole design. A backup code is spent one per sign in, and the person who
 * discovers on the day they lose their phone that the last code went a month ago is a person who
 * needs the recovery process of STEP 044 instead. So the settings screen shows how many are left and
 * replaces the set on demand.
 *
 * ## Why the second factor is asked for
 *
 * Generating a set of codes is generating ten new ways into the account. A signed in browser is not
 * enough proof for that: the session may be an old one on a machine the owner walked away from, and
 * a code set is not something an attacker should be able to mint from a session they stole. The
 * current TOTP code proves the authenticator is still in the owner's hand, which is exactly the
 * assurance this action needs, and it needs no password to be typed again.
 *
 * ## The replacement is total
 *
 * `backup_code_hashes` is replaced whole, never appended to. An old code that still worked after a
 * regeneration would make the screen a lie: the person believes the codes they printed last year are
 * dead, and they are not. The audit entry records how many were replaced, so the history answers
 * "when did the set change" without recording a single code.
 */

/** A pair of readings the settings screen needs, and nothing else. */
export interface TwoFactorStatus {
  readonly enrolled: boolean;
  readonly confirmedAt: string | null;
  readonly backupCodesRemaining: number;
}

export interface RegeneratedBackupCodes {
  readonly backupCodes: readonly string[];
  /** How many verifiers were replaced, so the screen can say what stopped working. */
  readonly replaced: number;
}

export interface BackupCodeDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  /** Read lazily: the module never touches the environment at import time. */
  readonly masterKey: () => string;
  readonly now?: () => number;
}

export interface RegenerateInput {
  readonly userId: string;
  /** The current code from the authenticator app. */
  readonly code: string;
}

const accountRowSchema = z.object({
  id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  status: z.string().min(1).max(16),
  deleted_at: z.string().nullable(),
  totp_secret_ciphertext: z.string().max(512).nullable(),
  totp_confirmed_at: z.string().nullable(),
  backup_code_hashes: z.array(z.string().min(1).max(512)).max(20),
});

const regenerateInputSchema = z
  .object({
    userId: z.string().min(1).max(64),
    code: z.string().trim().min(6).max(10),
  })
  .strict();

async function readAccount(
  dependencies: BackupCodeDependencies,
  userId: string,
): Promise<z.infer<typeof accountRowSchema> | null> {
  const rows = await dependencies.rest.select(
    "users",
    `select=id,company_id,status,deleted_at,totp_secret_ciphertext,totp_confirmed_at,backup_code_hashes&id=eq.${encodeURIComponent(userId)}&limit=1`,
    accountRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * What the settings screen may know about the account's second factor.
 *
 * It answers the count, never the codes: the stored values are scrypt verifiers and there is no
 * operation anywhere that turns one back into a code.
 */
export async function readTwoFactorStatus(
  input: { readonly userId: string },
  dependencies: BackupCodeDependencies,
): Promise<TwoFactorStatus> {
  const account = await readAccount(dependencies, input.userId);

  if (account === null || account.deleted_at !== null || account.status !== "active") {
    throw new AppError("AUTHENTICATION_REQUIRED");
  }

  if (account.totp_confirmed_at === null) {
    return { enrolled: false, confirmedAt: null, backupCodesRemaining: 0 };
  }

  return {
    enrolled: true,
    confirmedAt: account.totp_confirmed_at,
    backupCodesRemaining: account.backup_code_hashes.length,
  };
}

/**
 * Replace every backup code with ten fresh ones.
 *
 * The order is the one the rest of the auth area follows: the account, then the proof, then the
 * write. A wrong code is a form failure with a field a screen can point at - the only refusal in
 * this module a person can act on - and an account that never enrolled is `CONFLICT`, because there
 * is nothing to regenerate and the way forward is the enrolment screen.
 */
export async function regenerateBackupCodes(
  input: RegenerateInput,
  dependencies: BackupCodeDependencies,
): Promise<RegeneratedBackupCodes> {
  const parsed = regenerateInputSchema.safeParse({ userId: input.userId, code: input.code });

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "code", rule: "invalid_format" }],
    });
  }

  const account = await readAccount(dependencies, parsed.data.userId);

  if (account === null || account.deleted_at !== null || account.status !== "active") {
    throw new AppError("AUTHENTICATION_REQUIRED");
  }

  if (account.totp_confirmed_at === null || account.totp_secret_ciphertext === null) {
    throw new AppError("CONFLICT");
  }

  const secret = openEnrolledSecret(
    account.totp_secret_ciphertext,
    account.id,
    dependencies.masterKey(),
  );
  const now = dependencies.now ?? ((): number => Date.now());
  const step = verifyTotpCode(secret, parsed.data.code, now());

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
    backup_code_hashes: hashes,
  });

  await dependencies.audit.append({
    action: "user.backup_codes_regenerated",
    actorUserId: account.id,
    entityType: "user",
    entityId: account.id,
    companyId: account.company_id,
    payload: {
      issued: backupCodes.length,
      replaced: account.backup_code_hashes.length,
      step,
    },
  });

  return { backupCodes, replaced: account.backup_code_hashes.length };
}
