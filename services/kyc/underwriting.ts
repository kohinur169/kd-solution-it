// path: services/kyc/underwriting.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { BUSINESS_PROFILE_TABLE } from "./business-profile.ts";
import { MCC_CODES_TABLE, MCC_CODE_PATTERN } from "./merchant-category.ts";

/**
 * The underwriting criteria of FEATURE_LIST section 5, set by the compliance team: the starting
 * monthly transaction limit for new merchants, the MCC based risk tiers with their extra reserve
 * or longer hold, the required bank statement period, and the hold on unusually large
 * transactions. The tables are `0106`'s `underwriting_criteria` (one platform row) and
 * `underwriting_risk_tiers` (one row per tier); the tier a code carries stays on
 * `mcc_codes.risk_tier` of `0077`, which only these same roles may write.
 *
 * ## Who may use it
 *
 * `UNDERWRITING_MANAGE_ROLES` - super_admin and compliance_kyc - may change the criteria, the
 * tier costs and a code's tier; any other actor is `PERMISSION_DENIED` before a single query runs,
 * and the gate proves that. `UNDERWRITING_READ_ROLES` - the two above plus ceo and finance_ops -
 * may read the settings and the MCC overview, because the CEO decides pricing with the super
 * admin and finance runs the holds. The merchant never reads this file's settings directly; the
 * one criterion that governs their own upload, the required bank statement period, is answered by
 * `readMerchantUnderwritingSummary` alone.
 *
 * ## The writes
 *
 * Every write is one conditional update (by id and current version, over live rows only) with the
 * version bumped, re-read to detect a lost race (`CONFLICT` stale when the version moved), and one
 * audit entry under its own action. Re-saving the values a row already holds is idempotent: it
 * writes nothing and audits nothing. Setting a retired code's tier conflicts, because `0104`
 * leaves the service the job of refusing a retired code. The company is never in any body: the
 * criteria are platform scoped (`company_id` is null), and the MCC overview reads profiles across
 * companies on purpose, which the `0106` policy `business_profiles_underwriting_read` allows.
 *
 * ## Money
 *
 * Money columns are numeric(18,4) and travel as strings; PostgREST may answer them as JSON numbers,
 * so the row schemas accept both and normalise to string. A range check converts to a JS number
 * only to compare against the ceiling - every value here is at most 10^14, far below 2^53, so the
 * comparison is exact - and the stored value is always the string the caller sent. No ledger math
 * happens in this file.
 */

/** The one platform row of global underwriting criteria (`0106`). */
export const UNDERWRITING_CRITERIA_TABLE = "underwriting_criteria";

/** The per-tier costs (`0106`). */
export const UNDERWRITING_RISK_TIERS_TABLE = "underwriting_risk_tiers";

/** The roles that may change the criteria, a tier's cost or a code's tier. */
export const UNDERWRITING_MANAGE_ROLES: readonly PlatformRole[] = Object.freeze([
  "super_admin",
  "compliance_kyc",
] as const satisfies readonly PlatformRole[]);

/** The roles that may read the settings and the MCC overview. */
export const UNDERWRITING_READ_ROLES: readonly PlatformRole[] = Object.freeze([
  "ceo",
  "compliance_kyc",
  "finance_ops",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The audit action of a criteria change. */
export const UNDERWRITING_CRITERIA_AUDIT_ACTION = "underwriting.criteria_updated";

/** The audit action of a tier cost change. */
export const UNDERWRITING_RISK_TIER_AUDIT_ACTION = "underwriting.risk_tier_updated";

/** The audit action of a code's tier being set. */
export const UNDERWRITING_MCC_TIER_AUDIT_ACTION = "underwriting.mcc_tier_set";

/** The audit action of an office read of the settings. */
export const UNDERWRITING_READ_AUDIT_ACTION = "underwriting.criteria_read_by_office";

/** The audit entity of the criteria row. */
export const UNDERWRITING_CRITERIA_ENTITY = "underwriting_criteria";

/** The audit entity of a tier row. */
export const UNDERWRITING_RISK_TIER_ENTITY = "underwriting_risk_tier";

/** The audit entity of a code's tier change. */
export const MCC_CODE_ENTITY = "mcc_code";

/** The tiers a code can carry, as `0077`'s check allows. */
export const MCC_RISK_TIERS = ["unassigned", "low", "medium", "high"] as const;

/** The tiers that have a cost row in `0106`. */
export const RISK_TIERS = ["low", "medium", "high"] as const;

/** The ceilings the `0106` column checks also enforce; the service refuses them before a write. */
export const STARTING_MONTHLY_LIMIT_MAX = 100_000_000;
export const HOLD_THRESHOLD_MAX = 1_000_000_000;
export const BANK_STATEMENT_MONTHS_MIN = 1;
export const BANK_STATEMENT_MONTHS_MAX = 36;
export const RESERVE_PERCENT_MAX = 100;
export const HOLD_DAYS_MAX = 90;

/** Money as the API carries it: a string of digits with at most four decimals, numeric(18,4). */
const MONEY_PATTERN = /^\d{1,14}(\.\d{1,4})?$/u;

/** A percent with at most two decimals. */
const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/u;

/** A money value from a body or from PostgREST, normalised to its string form. */
const moneyValue = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .pipe(z.string().regex(MONEY_PATTERN, "a money value is digits with at most four decimals"));

const percentValue = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .pipe(z.string().regex(PERCENT_PATTERN, "a percent is digits with at most two decimals"));

/** The body of a criteria save. */
export const updateCriteriaBodySchema = z
  .object({
    starting_monthly_limit: moneyValue,
    bank_statement_months: z.number().int().min(BANK_STATEMENT_MONTHS_MIN).max(BANK_STATEMENT_MONTHS_MAX),
    large_transaction_hold_enabled: z.boolean(),
    large_transaction_hold_threshold: moneyValue,
  })
  .superRefine((value, ctx) => {
    const limit = Number(value.starting_monthly_limit);
    const threshold = Number(value.large_transaction_hold_threshold);

    if (!(limit > 0) || limit > STARTING_MONTHLY_LIMIT_MAX) {
      ctx.addIssue({ code: "custom", path: ["starting_monthly_limit"], message: "out of range" });
    }

    if (!(threshold > 0) || threshold > HOLD_THRESHOLD_MAX) {
      ctx.addIssue({ code: "custom", path: ["large_transaction_hold_threshold"], message: "out of range" });
    }
  });

/** The body of a tier cost save. */
export const updateRiskTierBodySchema = z
  .object({
    tier: z.enum(RISK_TIERS),
    extra_reserve_percent: percentValue,
    hold_days: z.number().int().min(0).max(HOLD_DAYS_MAX),
  })
  .superRefine((value, ctx) => {
    if (Number(value.extra_reserve_percent) > RESERVE_PERCENT_MAX) {
      ctx.addIssue({ code: "custom", path: ["extra_reserve_percent"], message: "out of range" });
    }
  });

/** The body of a code tier save. */
export const mccTierBodySchema = z.object({
  code: z.string().regex(MCC_CODE_PATTERN, "a merchant category code is four digits"),
  tier: z.enum(MCC_RISK_TIERS),
});

export interface UnderwritingDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

export interface UnderwritingCriteriaSnapshot {
  readonly startingMonthlyLimit: string;
  readonly bankStatementMonths: number;
  readonly largeHoldEnabled: boolean;
  readonly largeHoldThreshold: string;
  readonly updatedBy: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

export interface UnderwritingRiskTierSnapshot {
  readonly tier: string;
  readonly extraReservePercent: string;
  readonly holdDays: number;
  readonly version: number;
  readonly updatedAt: string;
}

export interface UnderwritingSettings {
  readonly criteria: UnderwritingCriteriaSnapshot;
  readonly tiers: readonly UnderwritingRiskTierSnapshot[];
}

export interface UnderwritingMccRow {
  readonly code: string;
  readonly title: string;
  readonly tier: string;
  readonly profileCount: number;
}

export interface UnderwritingMccOverview {
  readonly rows: readonly UnderwritingMccRow[];
}

/** The one criterion a merchant may read: the bank statement period their upload must cover. */
export interface MerchantUnderwritingSummary {
  readonly bankStatementPeriodMonths: number;
}

function nowOf(dependencies: UnderwritingDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

function isoOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function requireManageActor(actor: RequestActor): void {
  requireAnyRole(actor, UNDERWRITING_MANAGE_ROLES);
}

function requireReadActor(actor: RequestActor): void {
  requireAnyRole(actor, UNDERWRITING_READ_ROLES);
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

/** PostgREST answers a numeric column as a string or a number; both mean the same value here. */
const moneyColumn = z.union([z.string(), z.number()]).transform((value) => String(value));

const criteriaRowSchema = z.object({
  id: z.string(),
  starting_monthly_limit: moneyColumn,
  bank_statement_months: z.number().int(),
  large_transaction_hold_enabled: z.boolean(),
  large_transaction_hold_threshold: moneyColumn,
  updated_by: z.string().nullable(),
  version: z.number().int(),
  updated_at: z.string(),
});

const tierRowSchema = z.object({
  id: z.string(),
  tier: z.string(),
  extra_reserve_percent: moneyColumn,
  hold_days: z.number().int(),
  version: z.number().int(),
  updated_at: z.string(),
});

const mccTierRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  risk_tier: z.string(),
  is_active: z.boolean(),
  version: z.number().int(),
});

type CriteriaRow = z.infer<typeof criteriaRowSchema>;
type TierRow = z.infer<typeof tierRowSchema>;

/** The one live criteria row, or null when the table has none (a deployment that never ran 0106). */
async function readCriteriaRow(rest: RestClient): Promise<CriteriaRow | null> {
  const rows = await rest.select(
    UNDERWRITING_CRITERIA_TABLE,
    "select=id,starting_monthly_limit,bank_statement_months,large_transaction_hold_enabled,large_transaction_hold_threshold,updated_by,version,updated_at&deleted_at=is.null&limit=1",
    criteriaRowSchema,
  );

  return rows[0] ?? null;
}

async function readTierRows(rest: RestClient): Promise<readonly TierRow[]> {
  return rest.select(
    UNDERWRITING_RISK_TIERS_TABLE,
    "select=id,tier,extra_reserve_percent,hold_days,version,updated_at&deleted_at=is.null&order=tier.asc&limit=10",
    tierRowSchema,
  );
}

function criteriaSnapshot(row: CriteriaRow): UnderwritingCriteriaSnapshot {
  return {
    startingMonthlyLimit: row.starting_monthly_limit,
    bankStatementMonths: row.bank_statement_months,
    largeHoldEnabled: row.large_transaction_hold_enabled,
    largeHoldThreshold: row.large_transaction_hold_threshold,
    updatedBy: row.updated_by,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function tierSnapshot(row: TierRow): UnderwritingRiskTierSnapshot {
  return {
    tier: row.tier,
    extraReservePercent: row.extra_reserve_percent,
    holdDays: row.hold_days,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

/** An audit sink that is down never fails a read. */
async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Same rule as every other tolerated audit write.
  }
}

/**
 * Read the criteria row and the tier rows. Office read roles only; the read is audited as an
 * office read of the settings, and an audit sink that is down never fails it.
 */
export async function readUnderwritingSettings(
  input: { readonly actor: RequestActor },
  dependencies: UnderwritingDependencies,
): Promise<UnderwritingSettings> {
  requireReadActor(input.actor);

  const rest = dependencies.rest;
  const [criteria, tiers] = await Promise.all([readCriteriaRow(rest), readTierRows(rest)]);

  if (criteria === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  await appendTolerated(dependencies.audit, {
    action: UNDERWRITING_READ_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: UNDERWRITING_CRITERIA_ENTITY,
    entityId: criteria.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: { tiers: tiers.length },
  });

  return { criteria: criteriaSnapshot(criteria), tiers: tiers.map(tierSnapshot) };
}

/**
 * The starting monthly limit of the `0106` criteria row, as a money string - what a new merchant's
 * limit row is created with (STEP 091). Null when the deployment never ran `0106`.
 */
export async function readStartingMonthlyLimit(rest: RestClient): Promise<string | null> {
  const row = await readCriteriaRow(rest);

  return row === null ? null : row.starting_monthly_limit;
}

/**
 * The large-transaction hold switch of the `0106` criteria row, as the STEP 092 hold trigger reads
 * it: whether the hold is on, and the threshold amount. Null when the deployment never ran `0106`.
 */
export async function readLargeTransactionHold(
  rest: RestClient,
): Promise<{ readonly enabled: boolean; readonly threshold: string } | null> {
  const row = await readCriteriaRow(rest);

  if (row === null) {
    return null;
  }

  return {
    enabled: row.large_transaction_hold_enabled,
    threshold: row.large_transaction_hold_threshold,
  };
}

/**
 * The merchant-safe summary: the required bank statement period, and nothing else. The owner of a
 * company may read it - their upload has to satisfy it - while the starting limit, the hold
 * threshold and the tier costs stay with the office.
 */
export async function readMerchantUnderwritingSummary(
  input: { readonly actor: RequestActor },
  dependencies: UnderwritingDependencies,
): Promise<MerchantUnderwritingSummary> {
  requireAnyRole(input.actor, ["owner"]);
  requireCompanyId(input.actor);

  const row = await readCriteriaRow(dependencies.rest);

  if (row === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  return { bankStatementPeriodMonths: row.bank_statement_months };
}

/**
 * Save the four criteria. Manage roles only. One conditional update by id and current version with
 * the version bumped, a re-read race check, one audit entry with the new values, and the fresh
 * settings as the answer.
 */
export async function updateUnderwritingCriteria(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: UnderwritingDependencies,
): Promise<UnderwritingSettings> {
  requireManageActor(input.actor);

  const parsed = updateCriteriaBodySchema.safeParse(input.body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  const rest = dependencies.rest;
  const row = await readCriteriaRow(rest);

  if (row === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  await rest.update(
    UNDERWRITING_CRITERIA_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&version=eq.${row.version}&deleted_at=is.null`,
    {
      starting_monthly_limit: parsed.data.starting_monthly_limit,
      bank_statement_months: parsed.data.bank_statement_months,
      large_transaction_hold_enabled: parsed.data.large_transaction_hold_enabled,
      large_transaction_hold_threshold: parsed.data.large_transaction_hold_threshold,
      updated_by: input.actor.userId,
      updated_at: isoOf(nowOf(dependencies)),
      version: row.version + 1,
    },
  );

  const after = await readCriteriaRow(rest);

  if (after === null || after.version !== row.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  await appendTolerated(dependencies.audit, {
    action: UNDERWRITING_CRITERIA_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: UNDERWRITING_CRITERIA_ENTITY,
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      starting_monthly_limit: parsed.data.starting_monthly_limit,
      bank_statement_months: parsed.data.bank_statement_months,
      large_transaction_hold_enabled: parsed.data.large_transaction_hold_enabled,
      large_transaction_hold_threshold: parsed.data.large_transaction_hold_threshold,
    },
  });

  return readUnderwritingSettings({ actor: input.actor }, dependencies);
}

/**
 * Save one tier's cost (extra reserve percent, hold days). Manage roles only. Re-saving the values
 * the row already holds is idempotent - no write, no audit; otherwise one conditional update, a
 * re-read race check, one audit entry.
 */
export async function updateUnderwritingRiskTier(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: UnderwritingDependencies,
): Promise<UnderwritingSettings> {
  requireManageActor(input.actor);

  const parsed = updateRiskTierBodySchema.safeParse(input.body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  const rest = dependencies.rest;
  const rows = await rest.select(
    UNDERWRITING_RISK_TIERS_TABLE,
    `select=id,tier,extra_reserve_percent,hold_days,version,updated_at&tier=eq.${encodeURIComponent(parsed.data.tier)}&deleted_at=is.null&limit=1`,
    tierRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const sameValues =
    Number(row.extra_reserve_percent) === Number(parsed.data.extra_reserve_percent) &&
    row.hold_days === parsed.data.hold_days;

  if (sameValues) {
    return readUnderwritingSettings({ actor: input.actor }, dependencies);
  }

  await rest.update(
    UNDERWRITING_RISK_TIERS_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&version=eq.${row.version}&deleted_at=is.null`,
    {
      extra_reserve_percent: parsed.data.extra_reserve_percent,
      hold_days: parsed.data.hold_days,
      updated_by: input.actor.userId,
      updated_at: isoOf(nowOf(dependencies)),
      version: row.version + 1,
    },
  );

  const afterRows = await rest.select(
    UNDERWRITING_RISK_TIERS_TABLE,
    `select=id,tier,extra_reserve_percent,hold_days,version,updated_at&tier=eq.${encodeURIComponent(parsed.data.tier)}&deleted_at=is.null&limit=1`,
    tierRowSchema,
  );
  const after = afterRows[0];

  if (after === undefined || after.version !== row.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  await appendTolerated(dependencies.audit, {
    action: UNDERWRITING_RISK_TIER_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: UNDERWRITING_RISK_TIER_ENTITY,
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      tier: parsed.data.tier,
      extra_reserve_percent: parsed.data.extra_reserve_percent,
      hold_days: parsed.data.hold_days,
    },
  });

  return readUnderwritingSettings({ actor: input.actor }, dependencies);
}

/**
 * The underwriting screen's MCC list: every active code with its title, the tier compliance set on
 * it, and how many live business profiles carry it - the `business_profiles_mcc_idx` query of
 * `0104`. Office read roles only; the profile read is deliberately across companies, and the gate
 * asserts no other profile query is. Ordered by profile count descending, then code, so the codes
 * that actually matter are at the top.
 */
export async function readUnderwritingMccOverview(
  input: { readonly actor: RequestActor },
  dependencies: UnderwritingDependencies,
): Promise<UnderwritingMccOverview> {
  requireReadActor(input.actor);

  const rest = dependencies.rest;
  const [codes, profiles] = await Promise.all([
    rest.select(
      MCC_CODES_TABLE,
      "select=code,title,risk_tier&is_active=is.true&deleted_at=is.null&order=code.asc&limit=1000",
      z.object({ code: z.string(), title: z.string(), risk_tier: z.string() }),
    ),
    rest.select(
      BUSINESS_PROFILE_TABLE,
      "select=mcc_code&mcc_code=not.is.null&deleted_at=is.null&limit=5000",
      z.object({ mcc_code: z.string() }),
    ),
  ]);

  const counts = new Map<string, number>();

  for (const profile of profiles) {
    counts.set(profile.mcc_code, (counts.get(profile.mcc_code) ?? 0) + 1);
  }

  await appendTolerated(dependencies.audit, {
    action: UNDERWRITING_READ_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: MCC_CODE_ENTITY,
    entityId: null,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: { codes: codes.length, profiles: profiles.length },
  });

  const rows = codes
    .map((code) => ({
      code: code.code,
      title: code.title,
      tier: code.risk_tier,
      profileCount: counts.get(code.code) ?? 0,
    }))
    .sort((left, right) => right.profileCount - left.profileCount || left.code.localeCompare(right.code));

  return { rows };
}

/**
 * Set the risk tier of one MCC code - the `risk_tier` column `0077` reserved for these roles.
 * Manage roles only. A retired code conflicts (`0104` leaves the refusal of a retired code to the
 * service), an unknown code is not found, a code whose tier is already the requested one is
 * idempotent, and anything else is one conditional update with a re-read race check and one audit
 * entry.
 */
export async function setMccRiskTier(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: UnderwritingDependencies,
): Promise<UnderwritingMccOverview> {
  requireManageActor(input.actor);

  const parsed = mccTierBodySchema.safeParse(input.body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  const rest = dependencies.rest;
  const code = parsed.data.code;
  const readRow = (): Promise<readonly z.infer<typeof mccTierRowSchema>[]> =>
    rest.select(
      MCC_CODES_TABLE,
      `select=id,code,title,risk_tier,is_active,version&code=eq.${encodeURIComponent(code)}&deleted_at=is.null&limit=1`,
      mccTierRowSchema,
    );

  const rows = await readRow();
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (!row.is_active) {
    throw new AppError("CONFLICT", { details: [{ field: "code", rule: "retired_code" }] });
  }

  if (row.risk_tier === parsed.data.tier) {
    return readUnderwritingMccOverview({ actor: input.actor }, dependencies);
  }

  await rest.update(
    MCC_CODES_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&version=eq.${row.version}&deleted_at=is.null`,
    {
      risk_tier: parsed.data.tier,
      updated_at: isoOf(nowOf(dependencies)),
      version: row.version + 1,
    },
  );

  const after = (await readRow())[0];

  if (after === undefined || after.version !== row.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  await appendTolerated(dependencies.audit, {
    action: UNDERWRITING_MCC_TIER_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: MCC_CODE_ENTITY,
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: { code, tier: parsed.data.tier },
  });

  return readUnderwritingMccOverview({ actor: input.actor }, dependencies);
}
