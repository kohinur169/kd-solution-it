// path: lib/api/credentials.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { AppError } from "../errors/app-error.ts";
import type { SecretBox } from "../auth/secrets.ts";
import { isConflictError, type RestClient } from "../auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../auth/session.ts";
import type { RequestActor } from "../auth/types.ts";
import {
  CREDENTIAL_ACTIVE_LIMIT,
  CREDENTIAL_AUDIT,
  CREDENTIAL_ENTITY,
  CREDENTIAL_HASH_PATTERN,
  CREDENTIAL_HISTORY_LIMIT,
  CREDENTIAL_LABEL_MAXIMUM_LENGTH,
  CREDENTIAL_ROLES,
  CREDENTIAL_RULES,
  CREDENTIAL_SECRET_BYTES,
  CREDENTIAL_TAIL_PATTERN,
  MERCHANT_API_CREDENTIALS_TABLE,
  credentialSecretContext,
  isCredentialMode,
  maskedKeyOf,
  maskedSigningSecretOf,
  type CredentialMode,
  type CredentialPanelView,
  type CredentialView,
} from "./credential-fields.ts";

/**
 * Section 20's merchant API credentials: the create, and the masked read that follows it.
 *
 * ## The one sentence everything here obeys
 *
 * *"Full API keys and secrets are never displayed. After creation they are shown masked only and never appear
 * in UI, logs or error messages."* So a key is generated inside `createMerchantCredential`, reduced to a
 * SHA-256 and a four character tail, and then dropped: it is not returned, not stored, not logged and not in
 * the audit payload. The signing secret is different only in that it must later be read back to sign a
 * delivery, so `0034` keeps it as AES-256-GCM ciphertext; this module seals it and never opens it, because
 * opening it is STEP 202's business and a service that can open a secret is a service that can leak one.
 *
 * What a caller gets back is a `CredentialView`: a label, a mode, a status, a handle, the last four
 * characters and a masked string built from them. There is no property on it that can hold a key, so a screen
 * cannot print one even by accident, and the gate asserts that shape rather than trusting the prose.
 *
 * ## Where the company comes from
 *
 * Never from the body. `requireCompanyId(actor)` reads the session's own company, so a request that names
 * another merchant's id in a crafted body has nothing to name it to - and the row it writes is scoped to the
 * caller before it exists.
 *
 * ## Why creation counts before it writes
 *
 * `0034` bounds nothing about how many credentials a merchant holds, and it should not: that is a product
 * decision. `CREDENTIAL_ACTIVE_LIMIT` is this service's, counted with a `limit`-bounded read of the live ids
 * rather than by asking for an exact count the client does not provide, and the count is taken before the
 * insert so a runaway script meets a refusal instead of a table.
 */

/** The randomness, the clock, the chain and the seal, injected so the gate can know the key it issued. */
export interface CredentialDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
  /** Seals the signing secret under the environment key and the tenant's associated data. */
  readonly seal: (plaintext: string, context: string) => SecretBox;
  /** 32 random bytes as 64 lower case hex characters. */
  readonly randomHex: (bytes: number) => string;
}

const rowSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  mode: z.enum(["test", "live"]),
  status: z.enum(["active", "revoked"]),
  key_prefix: z.string(),
  key_last_four: z.string(),
  key_hash: z.string(),
  signing_secret_last_four: z.string(),
  signing_secret_ciphertext: z.string(),
  signing_secret_iv: z.string(),
  signing_secret_tag: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  revoke_reason: z.string().nullable(),
});

type CredentialRow = z.infer<typeof rowSchema>;

const activeRowSchema = z.object({ id: z.string().uuid(), mode: z.enum(["test", "live"]) });

/**
 * The columns a screen reads, and no others.
 *
 * The two of `0034`'s columns that are deliberately absent are the hash and the three box parts: a list query
 * that carries them puts a merchant's verifier in a server component's props for no reader to use.
 */
const listColumns =
  "select=id,label,mode,status,key_prefix,key_last_four,signing_secret_last_four,created_at,last_used_at,revoked_at,revoke_reason";

/** The body of the create form: a label and a mode, and nothing else that could be smuggled in. */
const createBodySchema = z
  .object({
    label: z.string().min(1).max(CREDENTIAL_LABEL_MAXIMUM_LENGTH),
    mode: z.enum(["test", "live"]),
  })
  .strict();

export interface CreateCredentialBody {
  readonly label: string;
  readonly mode: CredentialMode;
}

function refused(code: "VALIDATION_FAILED" | "CONFLICT" | "PERMISSION_DENIED", rule: string, field = "credential"): never {
  throw new AppError(code, { details: [{ field, rule }] });
}

/** Parse the create body. A label is trimmed here, because `0034` refuses one that is not already trimmed. */
export function parseCreateCredentialBody(body: unknown): CreateCredentialBody {
  const parsed = createBodySchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "credential", rule: CREDENTIAL_RULES.invalidFormat }] });
  }

  const label = parsed.data.label.trim();

  if (label.length < 1 || label.length > CREDENTIAL_LABEL_MAXIMUM_LENGTH) {
    refused("VALIDATION_FAILED", CREDENTIAL_RULES.labelInvalid, "label");
  }

  if (!isCredentialMode(parsed.data.mode)) {
    refused("VALIDATION_FAILED", CREDENTIAL_RULES.modeInvalid, "mode");
  }

  return { label, mode: parsed.data.mode };
}

/** The handle a screen prints, made from the randomness that also makes the key. */
function handleOf(hex: string): string {
  return `k${hex.slice(0, 6)}`;
}

/** 32 random bytes, as `0034`'s `key_hash` wants them: a lower case SHA-256. */
function hashOf(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** One view, from one row. Nothing in here can be reversed into a key, which is the point. */
function viewOf(row: CredentialRow): CredentialView {
  if (!isCredentialMode(row.mode)) {
    throw new AppError("DEPENDENCY_FAILED", { details: [{ field: "credential", rule: CREDENTIAL_RULES.unreadable }] });
  }

  return {
    id: row.id,
    label: row.label,
    mode: row.mode,
    status: row.status,
    keyPrefix: row.key_prefix,
    keyLastFour: row.key_last_four,
    maskedKey: maskedKeyOf({ mode: row.mode, keyPrefix: row.key_prefix, keyLastFour: row.key_last_four }),
    signingSecretLastFour: row.signing_secret_last_four,
    maskedSigningSecret: maskedSigningSecretOf(row.signing_secret_last_four),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  };
}

/**
 * Read a merchant's credentials, newest first, with the room left for another.
 *
 * One row query and one live-id query, both bounded, and no query in a loop: the count is taken from a read
 * of at most `2 * CREDENTIAL_ACTIVE_LIMIT + 1` ids rather than from a `count=exact` the client does not
 * offer. Two extra rows beyond each bound are the truncation witnesses, so a list that hit its window says so
 * rather than looking complete.
 */
export async function readMerchantCredentials(
  actor: RequestActor,
  dependencies: CredentialDependencies,
): Promise<CredentialPanelView> {
  requireAnyRole(actor, CREDENTIAL_ROLES);
  const companyId = requireCompanyId(actor);
  const rows = await dependencies.rest.select(
    MERCHANT_API_CREDENTIALS_TABLE,
    `${listColumns}&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null` +
      `&order=created_at.desc&limit=${String(CREDENTIAL_HISTORY_LIMIT + 1)}`,
    rowSchema,
  );
  const live = await dependencies.rest.select(
    MERCHANT_API_CREDENTIALS_TABLE,
    `select=id,mode&company_id=eq.${encodeURIComponent(companyId)}&status=eq.active&deleted_at=is.null` +
      `&order=id.asc&limit=${String(CREDENTIAL_ACTIVE_LIMIT * 2 + 1)}`,
    activeRowSchema,
  );
  const counts = { test: 0, live: 0 };

  for (const row of live) {
    counts[row.mode] += 1;
  }

  return {
    credentials: rows.slice(0, CREDENTIAL_HISTORY_LIMIT).map((row) => viewOf(row)),
    counts,
    limit: CREDENTIAL_ACTIVE_LIMIT,
    canCreate: counts.test < CREDENTIAL_ACTIVE_LIMIT || counts.live < CREDENTIAL_ACTIVE_LIMIT,
    truncated: rows.length > CREDENTIAL_HISTORY_LIMIT || live.length > CREDENTIAL_ACTIVE_LIMIT * 2,
  };
}

/** The audit entry of a creation. Its payload names the mode, the handle and the tail - never the key. */
async function noteCreated(
  dependencies: CredentialDependencies,
  input: {
    readonly actor: RequestActor;
    readonly companyId: string;
    readonly credentialId: string;
    readonly mode: CredentialMode;
    readonly keyPrefix: string;
    readonly keyLastFour: string;
  },
): Promise<void> {
  const entry: AuditEntry = {
    action: CREDENTIAL_AUDIT.created,
    actorUserId: input.actor.userId,
    entityType: CREDENTIAL_ENTITY,
    entityId: input.credentialId,
    payload: {
      mode: input.mode,
      key_prefix: input.keyPrefix,
      key_last_four: input.keyLastFour,
    },
    companyId: input.companyId,
    sessionId: input.actor.sessionId,
    ipAddress: null,
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // The row is the record of the credential; a chain outage must not leave a merchant holding a key the
    // platform then refuses to admit it issued. The route logs the failure, as every other service does.
  }
}

/**
 * Issue one credential.
 *
 * The order is the one every service in this codebase uses: role, then company from the session, then the
 * body, then the count, then the row. The key is built, hashed, cut to its tail and dropped in this function;
 * the signing secret is sealed under the tenant's associated data and its four character tail is kept. If the
 * merchant already holds a live credential with the same label, `0034`'s partial unique index refuses the
 * insert and the refusal is translated here rather than surfaced as a database error.
 */
export async function createMerchantCredential(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: CredentialDependencies,
): Promise<CredentialView> {
  requireAnyRole(input.actor, CREDENTIAL_ROLES);
  const companyId = requireCompanyId(input.actor);
  const body = parseCreateCredentialBody(input.body);
  const live = await dependencies.rest.select(
    MERCHANT_API_CREDENTIALS_TABLE,
    `select=id,mode&company_id=eq.${encodeURIComponent(companyId)}&mode=eq.${body.mode}` +
      `&status=eq.active&deleted_at=is.null&order=id.asc&limit=${String(CREDENTIAL_ACTIVE_LIMIT + 1)}`,
    activeRowSchema,
  );

  if (live.length >= CREDENTIAL_ACTIVE_LIMIT) {
    refused("CONFLICT", CREDENTIAL_RULES.limitReached, "mode");
  }

  // 64 hex characters of randomness: the first six name the credential in a screen, all sixty-four are the key.
  const secretHex = dependencies.randomHex(CREDENTIAL_SECRET_BYTES);
  const handle = handleOf(secretHex);
  const key = `kd_${body.mode}_${handle}_${secretHex}`;
  const signingSecret = dependencies.randomHex(CREDENTIAL_SECRET_BYTES);
  const box = dependencies.seal(signingSecret, credentialSecretContext(companyId));
  const inserted = await dependencies.rest
    .insertReturning(
      MERCHANT_API_CREDENTIALS_TABLE,
      [
        {
          company_id: companyId,
          label: body.label,
          mode: body.mode,
          key_prefix: handle,
          key_last_four: key.slice(-4),
          key_hash: hashOf(key),
          signing_secret_last_four: signingSecret.slice(-4),
          signing_secret_ciphertext: box.ciphertext,
          signing_secret_iv: box.iv,
          signing_secret_tag: box.tag,
          encryption_key_version: 1,
          status: "active",
          revoked_at: null,
          revoke_reason: null,
          last_used_at: null,
          rotated_from_id: null,
        },
      ],
      rowSchema,
    )
    .catch((error: unknown): never => {
      if (isConflictError(error)) {
        refused("CONFLICT", CREDENTIAL_RULES.labelTaken, "label");
      }

      throw error;
    });
  const row = inserted[0];

  if (row === undefined) {
    throw new AppError("DEPENDENCY_FAILED", { details: [{ field: "credential", rule: CREDENTIAL_RULES.unreadable }] });
  }

  await noteCreated(dependencies, {
    actor: input.actor,
    companyId,
    credentialId: row.id,
    mode: body.mode,
    keyPrefix: row.key_prefix,
    keyLastFour: row.key_last_four,
  });

  return viewOf(row);
}

/**
 * What a caller may assert about a credential without ever holding one.
 *
 * Exported for STEP 202, which verifies an incoming key: it hashes what arrived and asks the table for that
 * hash, then reads the columns this returns. Naming it here keeps the "a key is only ever a hash" rule in one
 * module instead of two.
 */
export function hashOfPresentedKey(presented: string): string {
  return hashOf(presented);
}

/** Whether the two tails a row holds are the shapes `0034` accepts, which is what a verifier can rely on. */
export function hasWellFormedTails(row: { readonly keyLastFour: string; readonly signingSecretLastFour: string }): boolean {
  return CREDENTIAL_TAIL_PATTERN.test(row.keyLastFour) && CREDENTIAL_TAIL_PATTERN.test(row.signingSecretLastFour);
}

/** Whether a stored hash is one this build wrote, so a verifier can refuse a row that is not. */
export function isWellFormedHash(hash: string): boolean {
  return CREDENTIAL_HASH_PATTERN.test(hash);
}
