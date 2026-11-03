// path: services/kyc/merchant-limit.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  readStartingMonthlyLimit,
  STARTING_MONTHLY_LIMIT_MAX,
  UNDERWRITING_MANAGE_ROLES,
} from "./underwriting.ts";

/**
 * The starting transaction limit enforcement of FEATURE_LIST section 5, for new merchants. The
 * compliance team sets the platform's starting monthly limit on the `0106` criteria row (STEP 090);
 * this file gives it a per-merchant home and enforces it: `0107`'s `merchant_transaction_limits` holds
 * one row per company with the assigned `monthly_limit`, the UTC calendar `month_key` and
 * `used_amount`, and the column check `used_amount <= monthly_limit` is the database backstop.
 *
 * ## The lifecycle of a new merchant's row
 *
 * The row is created lazily, the first time the merchant reads their limit or the office sets it:
 * the limit is copied from the criteria row, `used_amount` starts at zero in the current month, and
 * the partial unique index on `company_id` makes a second row impossible - a concurrent first read
 * that loses the insert race re-reads the row the winner created. Every creation is audited
 * (`merchant_limit.assigned`).
 *
 * ## The enforcement point
 *
 * `checkTransactionAgainstLimit` and `recordTransactionUsage` are the two functions the payment core
 * will call per transaction: the first answers whether an amount fits in what is left this month
 * (CONFLICT `monthly_limit_exceeded` when it does not, before anything is written), the second
 * records a settled amount with one conditional update. A month rollover resets `used_amount` in the
 * same conditional update that moves `month_key`, so usage never crosses months. Both are owner-only
 * and company-scoped: the company always comes from the session.
 *
 * ## Money math
 *
 * `package.json` is owned by the integrator, so no decimal package is added here. Money is handled
 * as integer minor units (scale 10^4) in BigInt - exact decimal arithmetic, no binary float anywhere -
 * and formatted back to the numeric(18,4) string on the way out. Values are bounded by 10^14 USD, so
 * the minor-unit integer never approaches 2^63.
 *
 * ## The office write
 *
 * `updateMerchantLimit` lets compliance_kyc and super_admin raise or lower one merchant's limit after
 * review; it is one conditional update with a version bump, a re-read race check and an audit entry
 * (`merchant_limit.updated`). A merchant with no row yet has not read their limit; the office read
 * path answers not found for them until the row is born.
 */

/** The `0107` table: one row per merchant. */
export const MERCHANT_LIMITS_TABLE = "merchant_transaction_limits";

/** The audit action of a limit row being created from the criteria. */
export const MERCHANT_LIMIT_ASSIGNED_AUDIT_ACTION = "merchant_limit.assigned";

/** The audit action of the office changing a merchant's limit. */
export const MERCHANT_LIMIT_UPDATED_AUDIT_ACTION = "merchant_limit.updated";

/** The audit action of usage being recorded (including a month rollover). */
export const MERCHANT_LIMIT_USAGE_AUDIT_ACTION = "merchant_limit.usage_recorded";

/** The audit entity of a limit row. */
export const MERCHANT_LIMIT_ENTITY = "merchant_transaction_limit";

/** Money as the API carries it: digits with at most four decimals, numeric(18,4). */
const MONEY_PATTERN = /^\d{1,14}(\.\d{1,4})?$/u;

/** The scale of minor units: numeric(18,4). */
const MINOR_SCALE = 10_000n;

/** The hard ceiling of any single amount here, in USD. */
const MONEY_MAX_USD = 100_000_000_000_000n;

/** Parse a numeric(18,4) string into minor units, or null when it is not a money string. */
function moneyToMinor(value: string): bigint | null {
  if (!MONEY_PATTERN.test(value)) {
    return null;
  }

  const parts = value.split(".");
  const whole = parts[0] ?? "0";
  const fraction = parts[1] ?? "";

  return BigInt(whole) * MINOR_SCALE + BigInt(`${fraction}0000`.slice(0, 4));
}

/** Format minor units back to the numeric(18,4) string. */
function minorToMoney(minor: bigint): string {
  const whole = minor / MINOR_SCALE;
  const fraction = (minor % MINOR_SCALE).toString().padStart(4, "0");

  return `${whole.toString()}.${fraction}`;
}

/** The UTC calendar month key of a timestamp, `YYYY-MM` - what `0107`'s `month_key` check accepts. */
export function monthKeyOf(epochMs: number): string {
  const date = new Date(epochMs);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");

  return `${date.getUTCFullYear()}-${month}`;
}

/** A money value from a body or from PostgREST, normalised to its string form. */
const moneyColumn = z.union([z.string(), z.number()]).transform((value) => String(value));

const limitRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  month_key: z.string(),
  monthly_limit: moneyColumn,
  used_amount: moneyColumn,
  updated_by: z.string().nullable(),
  version: z.number().int(),
  updated_at: z.string(),
});

type LimitRow = z.infer<typeof limitRowSchema>;

/** The body of the office's limit change: which merchant, and the new limit. */
export const updateMerchantLimitBodySchema = z.object({
  company_id: z.string().uuid(),
  monthly_limit: z
    .string()
    .regex(MONEY_PATTERN, "a money value is digits with at most four decimals")
    .transform((value) => moneyToMinor(value))
    .refine(
      (minor) => minor !== null && minor > 0n && minor <= BigInt(STARTING_MONTHLY_LIMIT_MAX) * MINOR_SCALE,
      "out of range",
    ),
});

export interface MerchantLimitDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

export interface MerchantLimitSnapshot {
  readonly companyId: string;
  readonly monthKey: string;
  readonly monthlyLimit: string;
  readonly usedAmount: string;
  readonly remainingAmount: string;
  readonly version: number;
  readonly updatedAt: string;
}

function nowOf(dependencies: MerchantLimitDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

function isoOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function snapshotOf(row: LimitRow): MerchantLimitSnapshot {
  const limit = moneyToMinor(row.monthly_limit) ?? 0n;
  const used = moneyToMinor(row.used_amount) ?? 0n;

  return {
    companyId: row.company_id,
    monthKey: row.month_key,
    monthlyLimit: row.monthly_limit,
    usedAmount: row.used_amount,
    remainingAmount: minorToMoney(limit - used),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

/** Map a zod issue to the field and rule the refusal names. */
function detailsOf(issues: readonly z.ZodIssue[]): readonly ErrorDetail[] {
  return issues.map((issue) => ({
    field: issue.path.join("."),
    rule:
      issue.code === "too_small" || issue.code === "too_big" || issue.code === "custom"
        ? "out_of_range"
        : "invalid_format",
  }));
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}

/** Read one live limit row by company, or null. */
async function readLimitRowByCompany(companyId: string, rest: RestClient): Promise<LimitRow | null> {
  const rows = await rest.select(
    MERCHANT_LIMITS_TABLE,
    `select=id,company_id,month_key,monthly_limit,used_amount,updated_by,version,updated_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    limitRowSchema,
  );

  return rows[0] ?? null;
}

/** Parse and range-check a transaction amount from a request, in minor units. */
function amountMinorOf(amount: unknown): bigint {
  const parsed = z
    .union([z.string(), z.number()])
    .transform(String)
    .pipe(z.string().regex(MONEY_PATTERN))
    .safeParse(amount);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "amount", rule: "invalid_format" }] });
  }

  const minor = moneyToMinor(parsed.data);

  if (minor === null || minor <= 0n || minor > MONEY_MAX_USD * MINOR_SCALE) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "amount", rule: "out_of_range" }] });
  }

  return minor;
}

/**
 * The merchant's limit row, created from the criteria on first use. The insert carries the partial
 * unique index's protection: a lost race raises a conflict, which is answered by re-reading the row
 * the winner created, so two concurrent first reads converge on one row.
 */
async function ensureLimitRow(
  actor: RequestActor,
  companyId: string,
  rest: RestClient,
  audit: AuditTrail,
  now: number,
): Promise<LimitRow> {
  const existing = await readLimitRowByCompany(companyId, rest);

  if (existing !== null) {
    return existing;
  }

  const startingLimit = await readStartingMonthlyLimit(rest);

  if (startingLimit === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  try {
    await rest.insert(MERCHANT_LIMITS_TABLE, [
      {
        company_id: companyId,
        month_key: monthKeyOf(now),
        monthly_limit: startingLimit,
        used_amount: "0.0000",
        updated_by: null,
        version: 1,
      },
    ]);
  } catch (error) {
    if (!(error instanceof AppError && error.code === "CONFLICT")) {
      throw error;
    }

    // Another request created the row first; the re-read below answers with it.
  }

  const row = await readLimitRowByCompany(companyId, rest);

  if (row === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  await appendTolerated(audit, {
    action: MERCHANT_LIMIT_ASSIGNED_AUDIT_ACTION,
    actorUserId: actor.userId,
    entityType: MERCHANT_LIMIT_ENTITY,
    entityId: row.id,
    companyId,
    sessionId: actor.sessionId,
    payload: {
      company_id: companyId,
      monthly_limit: row.monthly_limit,
      month_key: row.month_key,
      source: "underwriting_criteria",
    },
  });

  return row;
}

/**
 * Roll the row into the current month when its key has moved on: one conditional update, keyed by id,
 * company, current version AND the old month key, resetting usage to zero. Returns the fresh row.
 */
async function rollMonthIfNeeded(
  actor: RequestActor,
  row: LimitRow,
  rest: RestClient,
  audit: AuditTrail,
  now: number,
): Promise<LimitRow> {
  const currentKey = monthKeyOf(now);

  if (row.month_key === currentKey) {
    return row;
  }

  await rest.update(
    MERCHANT_LIMITS_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&company_id=eq.${encodeURIComponent(row.company_id)}&version=eq.${row.version}&month_key=eq.${encodeURIComponent(row.month_key)}&deleted_at=is.null`,
    {
      month_key: currentKey,
      used_amount: "0.0000",
      updated_at: isoOf(now),
      version: row.version + 1,
    },
  );

  const after = await readLimitRowByCompany(row.company_id, rest);

  if (after === null || after.version !== row.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  await appendTolerated(audit, {
    action: MERCHANT_LIMIT_USAGE_AUDIT_ACTION,
    actorUserId: actor.userId,
    entityType: MERCHANT_LIMIT_ENTITY,
    entityId: after.id,
    companyId: row.company_id,
    sessionId: actor.sessionId,
    payload: { company_id: row.company_id, month_key: currentKey, used_amount: "0.0000", month_rollover: true },
  });

  return after;
}

/** The owner's own limit: the row is created from the criteria the first time it is read. */
export async function readMerchantLimit(
  input: { readonly actor: RequestActor },
  dependencies: MerchantLimitDependencies,
): Promise<MerchantLimitSnapshot> {
  requireAnyRole(input.actor, ["owner"]);
  const companyId = requireCompanyId(input.actor);
  const row = await ensureLimitRow(input.actor, companyId, dependencies.rest, dependencies.audit, nowOf(dependencies));

  return snapshotOf(row);
}

/**
 * Whether one transaction amount fits in the merchant's remaining monthly limit. The month rolls
 * over first when needed. Over the limit is a conflict named `monthly_limit_exceeded`, thrown before
 * anything is written - this is the function the payment core calls per transaction.
 */
export async function checkTransactionAgainstLimit(
  input: { readonly actor: RequestActor; readonly amount: unknown },
  dependencies: MerchantLimitDependencies,
): Promise<MerchantLimitSnapshot> {
  requireAnyRole(input.actor, ["owner"]);
  const companyId = requireCompanyId(input.actor);
  const amountMinor = amountMinorOf(input.amount);

  const rest = dependencies.rest;
  const now = nowOf(dependencies);
  let row = await ensureLimitRow(input.actor, companyId, rest, dependencies.audit, now);
  row = await rollMonthIfNeeded(input.actor, row, rest, dependencies.audit, now);

  const limit = moneyToMinor(row.monthly_limit) ?? 0n;
  const used = moneyToMinor(row.used_amount) ?? 0n;

  if (used + amountMinor > limit) {
    throw new AppError("CONFLICT", { details: [{ field: "amount", rule: "monthly_limit_exceeded" }] });
  }

  return snapshotOf(row);
}

/**
 * Record one settled transaction amount against the month's usage: one conditional update by id,
 * company, current version and current month key, with the month rolled over first when needed, the
 * sum written as a numeric(18,4) string computed in minor units, a re-read race check, and one
 * `usage_recorded` audit entry. An amount that would cross the limit is refused before any write -
 * the `0107` column check is the backstop.
 */
export async function recordTransactionUsage(
  input: { readonly actor: RequestActor; readonly amount: unknown },
  dependencies: MerchantLimitDependencies,
): Promise<MerchantLimitSnapshot> {
  requireAnyRole(input.actor, ["owner"]);
  const companyId = requireCompanyId(input.actor);
  const amountMinor = amountMinorOf(input.amount);

  const rest = dependencies.rest;
  const now = nowOf(dependencies);
  let row = await ensureLimitRow(input.actor, companyId, rest, dependencies.audit, now);
  row = await rollMonthIfNeeded(input.actor, row, rest, dependencies.audit, now);

  const limit = moneyToMinor(row.monthly_limit) ?? 0n;
  const used = moneyToMinor(row.used_amount) ?? 0n;
  const newUsed = used + amountMinor;

  if (newUsed > limit) {
    throw new AppError("CONFLICT", { details: [{ field: "amount", rule: "monthly_limit_exceeded" }] });
  }

  await rest.update(
    MERCHANT_LIMITS_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&company_id=eq.${encodeURIComponent(companyId)}&version=eq.${row.version}&month_key=eq.${encodeURIComponent(row.month_key)}&deleted_at=is.null`,
    {
      used_amount: minorToMoney(newUsed),
      updated_at: isoOf(now),
      version: row.version + 1,
    },
  );

  const after = await readLimitRowByCompany(companyId, rest);

  if (after === null || after.version !== row.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  await appendTolerated(dependencies.audit, {
    action: MERCHANT_LIMIT_USAGE_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: MERCHANT_LIMIT_ENTITY,
    entityId: after.id,
    companyId,
    sessionId: input.actor.sessionId,
    payload: {
      company_id: companyId,
      amount: minorToMoney(amountMinor),
      used_amount: minorToMoney(newUsed),
      month_key: after.month_key,
      monthly_limit: after.monthly_limit,
    },
  });

  return snapshotOf(after);
}

/**
 * The office sets one merchant's limit after review: manage roles only, body `{ "company_id": uuid,
 * "monthly_limit": "5000.00" }`, one conditional update by id + company + current version with the
 * version bumped and `updated_by` named, a re-read race check, and one `merchant_limit.updated` audit
 * entry. A merchant with no row yet (they never read their limit) is not found.
 */
export async function updateMerchantLimit(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: MerchantLimitDependencies,
): Promise<MerchantLimitSnapshot> {
  requireAnyRole(input.actor, UNDERWRITING_MANAGE_ROLES);

  const parsed = updateMerchantLimitBodySchema.safeParse(input.body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  const companyId = parsed.data.company_id;
  const newLimit = parsed.data.monthly_limit;

  if (newLimit === null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "monthly_limit", rule: "invalid_format" }] });
  }

  const rest = dependencies.rest;
  const row = await readLimitRowByCompany(companyId, rest);

  if (row === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  await rest.update(
    MERCHANT_LIMITS_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&company_id=eq.${encodeURIComponent(companyId)}&version=eq.${row.version}&deleted_at=is.null`,
    {
      monthly_limit: minorToMoney(newLimit),
      updated_by: input.actor.userId,
      updated_at: isoOf(nowOf(dependencies)),
      version: row.version + 1,
    },
  );

  const after = await readLimitRowByCompany(companyId, rest);

  if (after === null || after.version !== row.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  await appendTolerated(dependencies.audit, {
    action: MERCHANT_LIMIT_UPDATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: MERCHANT_LIMIT_ENTITY,
    entityId: after.id,
    companyId,
    sessionId: input.actor.sessionId,
    payload: { company_id: companyId, monthly_limit: after.monthly_limit },
  });

  return snapshotOf(after);
}
