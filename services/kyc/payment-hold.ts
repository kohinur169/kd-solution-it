// path: services/kyc/payment-hold.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  readLargeTransactionHold,
  UNDERWRITING_MANAGE_ROLES,
  UNDERWRITING_READ_ROLES,
} from "./underwriting.ts";

/**
 * The unusual large transaction hold of FEATURE_LIST section 5 line 62, and the review that decides
 * it. The compliance team sets the switch and the threshold on the `0106` criteria row (STEP 090);
 * this file is the trigger and the queue: `holdLargeTransaction` is what the payment core calls per
 * transaction - at or above the threshold the transaction is recorded as a `0108` `payment_holds`
 * row in status `held` instead of settling - and `decidePaymentHold` is what the compliance desk
 * calls to release or reject it.
 *
 * ## The trigger
 *
 * `holdLargeTransaction` reads the criteria row, and only when the hold is enabled and the amount is
 * at or above the threshold does it write: one insert (status `held`, `held_at` now), audited
 * `payment_hold.created`. A `reference` (the payment's id or idempotency key) makes the trigger
 * idempotent - a repeated call with the same reference answers with the existing hold, never a
 * second row. Below the threshold, or with the switch off, it answers `{ held: false }` and writes
 * nothing. Amounts are numeric(18,4) strings compared in BigInt minor units, exactly as
 * `merchant-limit.ts` does - no float anywhere.
 *
 * ## The queue and the decision
 *
 * `readPaymentHoldQueue` is the office's waiting list, deliberately cross-company like the KYC
 * review queue, audited per read as `payment_hold.read_by_office`. `readMerchantPaymentHolds` is the
 * merchant's own list (section 20: a merchant sees their own holds). `decidePaymentHold` is
 * manage-roles only (manual payment review is the compliance desk's work): one conditional update by
 * id + `status=eq.held` + current version with the version bumped, the reviewer and instant named, the
 * reason required on a rejection (the same trimmed 1..280 rule `0049` sets), a re-read race check, and
 * one `payment_hold.decided` audit entry. A decided hold conflicts with `already_decided` instead of
 * being overwritten.
 */

/** The `0108` table: one row per held transaction. */
export const PAYMENT_HOLDS_TABLE = "payment_holds";

/** The audit action of a hold being created. */
export const PAYMENT_HOLD_CREATED_AUDIT_ACTION = "payment_hold.created";

/** The audit action of a hold being decided. */
export const PAYMENT_HOLD_DECIDED_AUDIT_ACTION = "payment_hold.decided";

/** The audit action of an office read of the queue. */
export const PAYMENT_HOLD_READ_AUDIT_ACTION = "payment_hold.read_by_office";

/** The audit entity of a hold row. */
export const PAYMENT_HOLD_ENTITY = "payment_hold";

/** The statuses of a hold: waiting, then exactly one terminal decision. */
export const PAYMENT_HOLD_STATUSES = ["held", "released", "rejected"] as const;

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

/** A money value from a body or from PostgREST, normalised to its string form. */
const moneyColumn = z.union([z.string(), z.number()]).transform((value) => String(value));

const holdRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  reference: z.string().nullable(),
  amount: moneyColumn,
  status: z.string(),
  held_at: z.string(),
  reviewed_by: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
  version: z.number().int(),
  updated_at: z.string(),
});

type HoldRow = z.infer<typeof holdRowSchema>;

/** The body of a hold decision: release or reject, with the reason a rejection must carry. */
export const decideHoldBodySchema = z
  .object({
    decision: z.enum(["release", "reject"]),
    reason: z.string().max(280).optional(),
  })
  .superRefine((value, ctx) => {
    const trimmed = value.reason?.trim() ?? "";

    if (value.decision === "reject" && (trimmed.length < 1 || trimmed.length > 280)) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "a rejection needs a reason of 1 to 280 characters" });
    }
  });

export interface PaymentHoldDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

export interface PaymentHoldSnapshot {
  readonly id: string;
  readonly companyId: string;
  readonly reference: string | null;
  readonly amount: string;
  readonly status: string;
  readonly heldAt: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly decisionReason: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

export interface PaymentHoldTriggerResult {
  readonly held: boolean;
  readonly amount: string;
  readonly threshold: string | null;
  readonly hold: PaymentHoldSnapshot | null;
}

export interface PaymentHoldQueue {
  readonly rows: readonly PaymentHoldSnapshot[];
}

function nowOf(dependencies: PaymentHoldDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

function isoOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function snapshotOf(row: HoldRow): PaymentHoldSnapshot {
  return {
    id: row.id,
    companyId: row.company_id,
    reference: row.reference,
    amount: row.amount,
    status: row.status,
    heldAt: row.held_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    decisionReason: row.decision_reason,
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

/** Parse and range-check a transaction amount, in minor units. */
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

/** Read one live hold row by id, or null. */
async function readHoldById(holdId: string, rest: RestClient): Promise<HoldRow | null> {
  const rows = await rest.select(
    PAYMENT_HOLDS_TABLE,
    `select=id,company_id,reference,amount,status,held_at,reviewed_by,reviewed_at,decision_reason,version,updated_at&id=eq.${encodeURIComponent(holdId)}&deleted_at=is.null&limit=1`,
    holdRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * The trigger the payment core calls per transaction. At or above the `0106` threshold (and with the
 * hold enabled) the transaction is held: one insert, audited, answered with the hold. A repeated
 * `reference` finds the existing hold instead of creating a second one. Otherwise `{ held: false }`
 * and nothing is written.
 */
export async function holdLargeTransaction(
  input: { readonly actor: RequestActor; readonly amount: unknown; readonly reference?: unknown },
  dependencies: PaymentHoldDependencies,
): Promise<PaymentHoldTriggerResult> {
  requireAnyRole(input.actor, ["owner"]);
  const companyId = requireCompanyId(input.actor);
  const amountMinor = amountMinorOf(input.amount);

  const reference =
    typeof input.reference === "string" && input.reference.trim().length > 0 && input.reference.length <= 120
      ? input.reference.trim()
      : null;

  const rest = dependencies.rest;
  const settings = await readLargeTransactionHold(rest);

  if (settings === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const thresholdMinor = moneyToMinor(settings.threshold);

  if (thresholdMinor === null) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (!settings.enabled || amountMinor < thresholdMinor) {
    return { held: false, amount: String(input.amount), threshold: settings.threshold, hold: null };
  }

  // Idempotent per reference: a repeated trigger answers with the hold that already exists.
  if (reference !== null) {
    const existing = await rest.select(
      PAYMENT_HOLDS_TABLE,
      `select=id,company_id,reference,amount,status,held_at,reviewed_by,reviewed_at,decision_reason,version,updated_at&company_id=eq.${encodeURIComponent(companyId)}&reference=eq.${encodeURIComponent(reference)}&deleted_at=is.null&limit=1`,
      holdRowSchema,
    );

    if (existing[0] !== undefined) {
      return { held: true, amount: String(input.amount), threshold: settings.threshold, hold: snapshotOf(existing[0]) };
    }
  }

  const now = nowOf(dependencies);
  const amount = (() => {
    const whole = amountMinor / MINOR_SCALE;
    const fraction = (amountMinor % MINOR_SCALE).toString().padStart(4, "0");

    return `${whole.toString()}.${fraction}`;
  })();

  await rest.insert(PAYMENT_HOLDS_TABLE, [
    {
      company_id: companyId,
      reference,
      amount,
      status: "held",
      held_at: isoOf(now),
      version: 1,
    },
  ]);

  // The just-inserted row is the newest of the merchant's holds, so the re-read finds it.
  const rows = await rest.select(
    PAYMENT_HOLDS_TABLE,
    `select=id,company_id,reference,amount,status,held_at,reviewed_by,reviewed_at,decision_reason,version,updated_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&order=held_at.desc&limit=1`,
    holdRowSchema,
  );
  const hold = rows[0];

  if (hold === undefined) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  await appendTolerated(dependencies.audit, {
    action: PAYMENT_HOLD_CREATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: PAYMENT_HOLD_ENTITY,
    entityId: hold.id,
    companyId,
    sessionId: input.actor.sessionId,
    payload: {
      company_id: companyId,
      reference,
      amount,
      threshold: settings.threshold,
      status: "held",
    },
  });

  return { held: true, amount, threshold: settings.threshold, hold: snapshotOf(hold) };
}

/** The office's waiting list: every live hold, oldest first, across companies on purpose. */
export async function readPaymentHoldQueue(
  input: { readonly actor: RequestActor },
  dependencies: PaymentHoldDependencies,
): Promise<PaymentHoldQueue> {
  requireAnyRole(input.actor, UNDERWRITING_READ_ROLES);

  const rows = await dependencies.rest.select(
    PAYMENT_HOLDS_TABLE,
    "select=id,company_id,reference,amount,status,held_at,reviewed_by,reviewed_at,decision_reason,version,updated_at&deleted_at=is.null&order=held_at.asc&limit=200",
    holdRowSchema,
  );

  await appendTolerated(dependencies.audit, {
    action: PAYMENT_HOLD_READ_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: PAYMENT_HOLD_ENTITY,
    entityId: null,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: { waiting: rows.length },
  });

  return { rows: rows.map(snapshotOf) };
}

/** The merchant's own holds, newest first. */
export async function readMerchantPaymentHolds(
  input: { readonly actor: RequestActor },
  dependencies: PaymentHoldDependencies,
): Promise<PaymentHoldQueue> {
  requireAnyRole(input.actor, ["owner"]);
  const companyId = requireCompanyId(input.actor);

  const rows = await dependencies.rest.select(
    PAYMENT_HOLDS_TABLE,
    `select=id,company_id,reference,amount,status,held_at,reviewed_by,reviewed_at,decision_reason,version,updated_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&order=held_at.desc&limit=100`,
    holdRowSchema,
  );

  return { rows: rows.map(snapshotOf) };
}

/**
 * Decide one held transaction: release it or reject it. Manage roles only; the hold id is validated
 * as a UUID before any query; a decided hold conflicts with `already_decided`; a rejection needs the
 * trimmed 1..280 reason. One conditional update by id + `status=eq.held` + current version, re-read
 * race check, one `payment_hold.decided` audit entry, the fresh hold as the answer.
 */
export async function decidePaymentHold(
  input: { readonly actor: RequestActor; readonly holdId: unknown; readonly body: unknown },
  dependencies: PaymentHoldDependencies,
): Promise<PaymentHoldSnapshot> {
  requireAnyRole(input.actor, UNDERWRITING_MANAGE_ROLES);

  const idParsed = z.string().uuid().safeParse(input.holdId);

  if (!idParsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "hold_id", rule: "invalid_format" }] });
  }

  const parsed = decideHoldBodySchema.safeParse(input.body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  const rest = dependencies.rest;
  const now = nowOf(dependencies);
  const row = await readHoldById(idParsed.data, rest);

  if (row === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (row.status !== "held") {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "already_decided" }] });
  }

  const reason = parsed.data.reason === undefined ? null : parsed.data.reason.trim();
  const nextStatus = parsed.data.decision === "release" ? "released" : "rejected";

  await rest.update(
    PAYMENT_HOLDS_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&status=eq.held&version=eq.${row.version}&deleted_at=is.null`,
    {
      status: nextStatus,
      reviewed_by: input.actor.userId,
      reviewed_at: isoOf(now),
      decision_reason: reason,
      updated_at: isoOf(now),
      version: row.version + 1,
    },
  );

  const after = await readHoldById(row.id, rest);

  if (after === null || after.version !== row.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  await appendTolerated(dependencies.audit, {
    action: PAYMENT_HOLD_DECIDED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: PAYMENT_HOLD_ENTITY,
    entityId: after.id,
    companyId: after.company_id,
    sessionId: input.actor.sessionId,
    payload: {
      hold_id: after.id,
      company_id: after.company_id,
      decision: parsed.data.decision,
      status: nextStatus,
      reason,
      amount: after.amount,
    },
  });

  return snapshotOf(after);
}
