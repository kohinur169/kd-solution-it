// path: services/payments/refund.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { isConflictError } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { priceColumnSchema, priceFromMinor } from "../products/price.ts";
import {
  REFUND_APPROVED_AUDIT_ACTION,
  REFUND_AUDIT_ENTITY,
  REFUND_CANCELLED_AUDIT_ACTION,
  REFUND_DECISION_ROLES,
  REFUND_LIST_LIMIT,
  REFUND_LIVE_STATUSES,
  REFUND_OPEN_STATUSES,
  REFUND_PAYMENT_LIST_LIMIT,
  REFUND_QUEUE_LIMIT,
  REFUND_REJECTED_AUDIT_ACTION,
  REFUND_REQUESTED_AUDIT_ACTION,
  REFUND_REQUEST_ROLES,
  REFUND_RULES,
  isRefundablePaymentStatus,
  parseRefundDecisionBody,
  parseRefundRequestBody,
  refundPaymentNotFound,
  refundNotFound,
  refundRemainingOf,
  refundStateRefused,
  type RefundStatus,
} from "./refund-fields.ts";

/**
 * Section 19's refund: the request, the decision and the status that records both.
 *
 * ## What `0038` already decides, and what was missing
 *
 * `0038_refunds.sql` carries the row, its six statuses and three triggers. `refunds_guard_amount` refuses
 * a refund of money that was never captured, one in another currency, one of another merchant's payment
 * and one that would take the live refunds past what was charged; `refunds_approval_check` says that
 * `approved_by` and `decided_at` exist exactly on the statuses that follow a decision; `refunds_sync_payment`
 * writes `payments.refunded_minor` and the `partially_refunded`/`refunded` status and refuses any other
 * writer of them. **Nothing in the application could raise, approve, reject or cancel a refund**, which is
 * the half of the feature section 19 asks for first: "request, approval and status tracking".
 *
 * This module is that half. It does not move money: `processing` and the processor's answer are STEP 192's
 * and the rule for returning the platform fee is STEP 193's, so every act here ends on a row and a chain
 * entry, never on a gateway call.
 *
 * ## The three acts and their guards
 *
 *   - **request** - the merchant's `owner`, the payment's own company, a captured or partly refunded
 *     payment, an amount inside what is left, and a trimmed reason. The amount is capped twice: by the
 *     service against what is left *and* by the database against what was charged, and the service's
 *     number is the stricter of the two because it also counts the requests still waiting for a decision.
 *   - **decide** - the platform's finance desk, on a refund that is still `requested`, never on one this
 *     account raised. Approval writes `approved_by` and `decided_at` and re-checks the cap, because another
 *     approval may have landed between the request and the decision; a rejection writes `cancelled`, which
 *     is where `0038` puts a refund that was decided against - the row has no column for "rejected", and a
 *     `failed` refund is the processor's answer rather than a person's.
 *   - **cancel** - the merchant that raised it, while it is still `requested`.
 *
 * ## Why every write is guarded and then read back
 *
 * PostgREST reports a zero-row update as success, so each update carries the status and the version the
 * caller read and the row is read again afterwards. Two decisions on one refund therefore cannot both
 * land, and the loser is told the refund moved rather than being shown a success it did not get.
 */

/** What the service needs: the gateway to the database, the signed chain, and a clock. */
export interface RefundDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/**
 * One refund, as a screen prints it.
 *
 * STEP 192 reads and moves the same rows from `refund-execution.ts`, so the projection, the column list, the
 * tenant-scoped read and the guarded write below are exported rather than copied: a second copy of the guard is
 * how one caller ends up able to move a row another caller cannot.
 */
export interface RefundView {
  readonly id: string;
  readonly companyId: string;
  readonly paymentId: string;
  /** The amount in minor units, as decimal text. */
  readonly amountMinor: string;
  /** The same amount printed for a person: `20.0000 USD`. */
  readonly amountText: string;
  readonly currency: string;
  readonly status: RefundStatus;
  readonly reason: string;
  readonly requestedBy: string;
  readonly approvedBy: string | null;
  readonly decidedAt: string | null;
  readonly processedAt: string | null;
  readonly providerRefundId: string | null;
  readonly platformFeeReturned: boolean;
  readonly platformFeeReturnedMinor: string;
  readonly failureDetail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One payment a merchant can still ask a refund for. */
export interface RefundablePaymentView {
  readonly paymentId: string;
  readonly invoiceId: string | null;
  readonly amountMinor: string;
  readonly amountText: string;
  readonly refundedMinor: string;
  /** What is left to promise: the charge, less everything held and everything still requested. */
  readonly remainingMinor: string;
  readonly remainingText: string;
  readonly currency: string;
  readonly status: string;
  readonly capturedAt: string | null;
}

/**
 * The columns every read names, one by one.
 *
 * `refunds_guard_amount` reads the payment's own amount and currency at the database, so this module never
 * needs a `*` anywhere: a refund view is these sixteen columns and nothing else.
 */
export const REFUND_ROW_COLUMNS =
  "select=id,company_id,payment_id,amount_minor,currency,status,reason,requested_by,approved_by,decided_at" +
  ",processed_at,provider_refund_id,platform_fee_returned,platform_fee_returned_minor,failure_detail" +
  ",created_at,updated_at,version";

const PAYMENT_ROW_COLUMNS =
  "select=id,company_id,invoice_id,amount_minor,currency,refunded_minor,status,captured_at,settled_at,created_at";

export const refundRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  amount_minor: priceColumnSchema,
  currency: z.string(),
  status: z.string(),
  reason: z.string(),
  requested_by: z.string().uuid(),
  approved_by: z.string().uuid().nullable(),
  decided_at: z.string().nullable(),
  processed_at: z.string().nullable(),
  provider_refund_id: z.string().nullable(),
  platform_fee_returned: z.boolean(),
  platform_fee_returned_minor: priceColumnSchema,
  failure_detail: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number(),
});

export type RefundRow = z.infer<typeof refundRowSchema>;

const paymentRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  invoice_id: z.string().uuid().nullable(),
  amount_minor: priceColumnSchema,
  currency: z.string(),
  refunded_minor: priceColumnSchema,
  status: z.string(),
  captured_at: z.string().nullable(),
  settled_at: z.string().nullable(),
  created_at: z.string(),
});

type PaymentRow = z.infer<typeof paymentRowSchema>;

/** The two numbers a refund read needs: what is held against a payment, and what is still asked for. */
const heldRowSchema = z.object({
  amount_minor: priceColumnSchema,
  status: z.string(),
});

/** A refund row as a screen prints it. One function, so the service and the routes agree. */
export function viewOf(row: RefundRow): RefundView {
  return {
    id: row.id,
    companyId: row.company_id,
    paymentId: row.payment_id,
    amountMinor: row.amount_minor.toString(),
    amountText: `${priceFromMinor(row.amount_minor)} ${row.currency}`,
    currency: row.currency,
    status: row.status as RefundStatus,
    reason: row.reason,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    decidedAt: row.decided_at,
    processedAt: row.processed_at,
    providerRefundId: row.provider_refund_id,
    platformFeeReturned: row.platform_fee_returned,
    platformFeeReturnedMinor: row.platform_fee_returned_minor.toString(),
    failureDetail: row.failure_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** One audit entry, written or not: a chain that is down never fails the act it records. */
export async function appendTolerated(audit: AuditTrail, entry: AuditEntry): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate, and the same bargain every write in this repository makes: the row is the fact.
  }
}

/** The status list PostgREST reads as `in.(...)`. */
function listOf(statuses: readonly string[]): string {
  return `in.(${statuses.join(",")})`;
}

/** Read one refund by id, optionally scoped to a merchant. */
export async function findRefund(
  dependencies: RefundDependencies,
  id: string,
  companyId: string | null,
): Promise<RefundRow | null> {
  const scope = companyId === null ? "" : `&company_id=eq.${companyId}`;
  const rows = await dependencies.rest.select(
    "refunds",
    `${REFUND_ROW_COLUMNS}&id=eq.${id}&deleted_at=is.null${scope}&limit=1`,
    refundRowSchema,
  );

  return rows[0] ?? null;
}

/** Read one payment by id, with the merchant's scope when the caller has one. */
async function findPayment(
  dependencies: RefundDependencies,
  id: string,
  companyId: string,
): Promise<PaymentRow | null> {
  const rows = await dependencies.rest.select(
    "payments",
    `${PAYMENT_ROW_COLUMNS}&id=eq.${id}&company_id=eq.${companyId}&deleted_at=is.null&limit=1`,
    paymentRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * What a payment already owes: the money held against it, and the money still asked for.
 *
 * Two reads rather than one aggregate, because PostgREST cannot sum with a filter and because the two
 * numbers answer two different questions - the cap the database enforces, and the headroom the merchant's
 * screen should print. `excludeRefundId` is how an approval asks the same question about the row it is
 * about to move: a refund does not compete with itself.
 */
async function heldOf(
  dependencies: RefundDependencies,
  paymentId: string,
  excludeRefundId: string | null,
): Promise<{ readonly heldMinor: bigint; readonly promisedMinor: bigint }> {
  const exclusion = excludeRefundId === null ? "" : `&id=not.eq.${excludeRefundId}`;
  const rows = await dependencies.rest.select(
    "refunds",
    `select=amount_minor,status&payment_id=eq.${paymentId}&status=${listOf([
      ...REFUND_LIVE_STATUSES,
      "requested",
    ])}&deleted_at=is.null${exclusion}`,
    heldRowSchema,
  );

  let heldMinor = 0n;
  let promisedMinor = 0n;

  for (const row of rows) {
    if (row.status === "requested") {
      promisedMinor += row.amount_minor;

      continue;
    }

    heldMinor += row.amount_minor;
  }

  return { heldMinor, promisedMinor };
}

/**
 * Ask for a refund.
 *
 * The order is the one a person can act on: the role, the merchant's tenant, the body, then the payment -
 * which must exist, belong to this merchant and be in a state money can come back from - then the amount
 * against what is left, then the insert. A refusal names a field and a rule, and never the amount somebody
 * else has already taken.
 */
export async function requestRefund(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: RefundDependencies,
): Promise<RefundView> {
  requireAnyRole(input.actor, REFUND_REQUEST_ROLES);
  const companyId = requireCompanyId(input.actor);
  const parsed = parseRefundRequestBody(input.body);
  const payment = await findPayment(dependencies, parsed.paymentId, companyId);

  if (payment === null) {
    throw refundPaymentNotFound();
  }

  if (payment.status === "refunded") {
    throw refundStateRefused(REFUND_RULES.nothingToRefund);
  }

  if (!isRefundablePaymentStatus(payment.status)) {
    throw refundStateRefused(REFUND_RULES.paymentNotRefundable);
  }

  const { heldMinor, promisedMinor } = await heldOf(dependencies, payment.id, null);
  const remaining = refundRemainingOf({
    amountMinor: payment.amount_minor,
    heldMinor,
    promisedMinor,
  });

  if (remaining === 0n) {
    throw refundStateRefused(REFUND_RULES.nothingToRefund);
  }

  if (parsed.amountMinor > remaining) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "amount", rule: REFUND_RULES.exceedsRefundable }],
    });
  }

  const nowMs = dependencies.now?.() ?? Date.now();
  let inserted: RefundRow;

  try {
    const rows = await dependencies.rest.insertReturning(
      "refunds",
      [
        {
          company_id: companyId,
          payment_id: payment.id,
          amount_minor: parsed.amountMinor.toString(),
          currency: payment.currency,
          status: "requested",
          reason: parsed.reason,
          requested_by: input.actor.userId,
        },
      ],
      refundRowSchema,
    );

    const row = rows[0];

    if (row === undefined) {
      throw new AppError("DEPENDENCY_FAILED");
    }

    inserted = row;
  } catch (error) {
    if (isConflictError(error)) {
      // The database's own cap, hit by a refund approved between this module's read and its write: the
      // honest answer is the same one the read would have given a moment later.
      throw refundStateRefused(REFUND_RULES.exceedsRefundable);
    }

    throw error;
  }

  await appendTolerated(dependencies.audit, {
    action: REFUND_REQUESTED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: REFUND_AUDIT_ENTITY,
    entityId: inserted.id,
    payload: {
      payment_id: inserted.payment_id,
      amount_minor: inserted.amount_minor.toString(),
      currency: inserted.currency,
      status: inserted.status,
      remaining_minor: remaining.toString(),
      // The words a merchant wrote about their own money stay on the row; the chain records that there
      // was a reason and how long it is, which is what an investigator needs to know it exists.
      reason_length: parsed.reason.length,
      requested_at: new Date(nowMs).toISOString(),
    },
    companyId,
    sessionId: input.actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
  });

  return viewOf(inserted);
}

/**
 * Move one refund row through one guarded step, and read it back.
 *
 * The write names the status *and* the version the caller read; the read-back then has to show the status
 * that was asked for *and* the next version. The version is what makes this exact: another decision that
 * won the race has already spent this version, so a caller whose update matched nothing is told the refund
 * moved rather than being handed a row somebody else decided.
 */
export async function moveRefund(
  dependencies: RefundDependencies,
  row: RefundRow,
  values: Readonly<Record<string, unknown>>,
  confirmed: ((next: RefundRow) => boolean) | null = null,
): Promise<RefundRow> {
  await dependencies.rest.update(
    "refunds",
    `id=eq.${row.id}&status=eq.${row.status}&version=eq.${row.version}`,
    values,
  );

  const moved = await findRefund(dependencies, row.id, null);

  if (moved === null) {
    throw refundNotFound();
  }

  const expected = String(values["status"] ?? "");

  if (moved.status !== expected || moved.version !== row.version + 1 || (confirmed !== null && !confirmed(moved))) {
    // Another decision landed between the read and the write, or the database refused one of its own
    // constraints: either way this caller did not move the row and must not be told it did.
    throw refundStateRefused(REFUND_RULES.refundMoved);
  }

  return moved;
}

/**
 * Decide a refund: approve it, or reject it.
 *
 * The finance desk acts, and never on a refund it raised itself. An approval re-reads the payment's
 * headroom first, because a request is a promise and the money may have been promised twice by the time a
 * decision arrives; a rejection writes `cancelled`, which is the only status `0038` leaves for a refund
 * that was decided against - `failed` needs the processor's own answer and the instant it arrived.
 */
export async function decideRefund(
  input: { readonly actor: RequestActor; readonly refundId: string; readonly body: unknown },
  dependencies: RefundDependencies,
): Promise<RefundView> {
  requireAnyRole(input.actor, REFUND_DECISION_ROLES);
  const parsed = parseRefundDecisionBody(input.body);
  const row = await findRefund(dependencies, input.refundId, null);

  if (row === null) {
    throw refundNotFound();
  }

  if (row.status !== "requested") {
    throw refundStateRefused(REFUND_RULES.refundNotPending);
  }

  if (row.requested_by === input.actor.userId) {
    // Four eyes, at the one desk where it can be checked by a person's own id.
    throw refundStateRefused(REFUND_RULES.selfDecision);
  }

  const nowMs = dependencies.now?.() ?? Date.now();
  const decidedAt = new Date(nowMs).toISOString();

  if (parsed.decision === "approve") {
    const payment = await findPayment(dependencies, row.payment_id, row.company_id);

    if (payment === null) {
      throw refundPaymentNotFound();
    }

    const { heldMinor } = await heldOf(dependencies, row.payment_id, row.id);

    if (row.amount_minor > payment.amount_minor - heldMinor) {
      throw refundStateRefused(REFUND_RULES.exceedsRefundable);
    }

    const approved = await moveRefund(
      dependencies,
      row,
      {
        status: "approved",
        approved_by: input.actor.userId,
        decided_at: decidedAt,
      },
      (next) => next.approved_by === input.actor.userId && next.decided_at === decidedAt,
    );

    await appendTolerated(dependencies.audit, {
      action: REFUND_APPROVED_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: REFUND_AUDIT_ENTITY,
      entityId: approved.id,
      payload: auditPayloadOf(approved, {
        decision: "approve",
        note_present: parsed.note !== null,
        note_length: parsed.note?.length ?? 0,
        decided_at: decidedAt,
      }),
      companyId: approved.company_id,
      sessionId: input.actor.sessionId ?? null,
      ipAddress: null,
      userAgent: null,
    });

    return viewOf(approved);
  }

  const rejected = await moveRefund(dependencies, row, { status: "cancelled" });

  await appendTolerated(dependencies.audit, {
    action: REFUND_REJECTED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: REFUND_AUDIT_ENTITY,
    entityId: rejected.id,
    payload: auditPayloadOf(rejected, {
      decision: "reject",
      note_present: parsed.note !== null,
      note_length: parsed.note?.length ?? 0,
      decided_at: decidedAt,
      // `refunds_approval_check` refuses an approver or a decision instant on a cancelled row, so the
      // rejection is a status and a chain entry rather than a column pair.
      recorded_as: "cancelled",
    }),
    companyId: rejected.company_id,
    sessionId: input.actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
  });

  return viewOf(rejected);
}

/**
 * Withdraw a request the merchant raised, while nobody has decided it yet.
 *
 * The merchant's own act, on the merchant's own row: an approval that arrives afterwards finds no
 * `requested` row and is told the refund moved.
 */
export async function cancelRefund(
  input: { readonly actor: RequestActor; readonly refundId: string },
  dependencies: RefundDependencies,
): Promise<RefundView> {
  requireAnyRole(input.actor, REFUND_REQUEST_ROLES);
  const companyId = requireCompanyId(input.actor);
  const row = await findRefund(dependencies, input.refundId, companyId);

  if (row === null) {
    throw refundNotFound();
  }

  if (row.status !== "requested") {
    throw refundStateRefused(REFUND_RULES.refundNotPending);
  }

  const cancelled = await moveRefund(dependencies, row, { status: "cancelled" });

  await appendTolerated(dependencies.audit, {
    action: REFUND_CANCELLED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: REFUND_AUDIT_ENTITY,
    entityId: cancelled.id,
    payload: auditPayloadOf(cancelled, { by: "merchant" }),
    companyId: cancelled.company_id,
    sessionId: input.actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
  });

  return viewOf(cancelled);
}

/** The payload every decision entry carries: the row's own identifiers and never its free text. */
function auditPayloadOf(row: RefundRow, detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    payment_id: row.payment_id,
    amount_minor: row.amount_minor.toString(),
    currency: row.currency,
    status_before: "requested",
    status_after: row.status,
    requested_by: row.requested_by,
    ...detail,
  };
}

/** One refund, for the merchant that owns it or the desk that decides it. */
export async function readRefund(
  input: { readonly actor: RequestActor; readonly refundId: string },
  dependencies: RefundDependencies,
): Promise<RefundView> {
  const isDesk = input.actor.roles.some((role) => (REFUND_DECISION_ROLES as readonly string[]).includes(role));

  if (isDesk) {
    const row = await findRefund(dependencies, input.refundId, null);

    if (row === null) {
      throw refundNotFound();
    }

    return viewOf(row);
  }

  requireAnyRole(input.actor, REFUND_REQUEST_ROLES);
  const companyId = requireCompanyId(input.actor);
  const row = await findRefund(dependencies, input.refundId, companyId);

  if (row === null) {
    throw refundNotFound();
  }

  return viewOf(row);
}

/** The merchant's own refunds, newest first. */
export async function listRefunds(
  input: { readonly actor: RequestActor; readonly limit?: number },
  dependencies: RefundDependencies,
): Promise<readonly RefundView[]> {
  requireAnyRole(input.actor, REFUND_REQUEST_ROLES);
  const companyId = requireCompanyId(input.actor);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? REFUND_LIST_LIMIT), 1), REFUND_LIST_LIMIT);
  const rows = await dependencies.rest.select(
    "refunds",
    `${REFUND_ROW_COLUMNS}&company_id=eq.${companyId}&deleted_at=is.null&order=created_at.desc&limit=${limit}`,
    refundRowSchema,
  );

  return rows.map(viewOf);
}

/**
 * The platform's refund queue: everything still waiting for a person, oldest first.
 *
 * Oldest first because this is a queue and not a report: the refund somebody has been waiting longest for
 * is the one at the top. The whole platform is visible here, because a finance desk decides for every
 * merchant, and the tenant goes back onto the row so a decision can be traced to the company it was about.
 */
export async function listRefundQueue(
  input: { readonly actor: RequestActor; readonly limit?: number },
  dependencies: RefundDependencies,
): Promise<readonly RefundView[]> {
  requireAnyRole(input.actor, REFUND_DECISION_ROLES);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? REFUND_QUEUE_LIMIT), 1), REFUND_QUEUE_LIMIT);
  const rows = await dependencies.rest.select(
    "refunds",
    `${REFUND_ROW_COLUMNS}&status=${listOf(REFUND_OPEN_STATUSES)}&deleted_at=is.null&order=created_at.asc&limit=${limit}`,
    refundRowSchema,
  );

  return rows.map(viewOf);
}

/**
 * The payments a merchant can still refund, with the headroom on each.
 *
 * The screen needs this to be a screen: a merchant cannot type a payment id it has never seen. Every row
 * is the merchant's own, in a state a refund starts from, with two numbers the service computed the same
 * way the request will - so the button the screen offers and the write it sends cannot disagree.
 */
export async function listRefundablePayments(
  input: { readonly actor: RequestActor; readonly limit?: number },
  dependencies: RefundDependencies,
): Promise<readonly RefundablePaymentView[]> {
  requireAnyRole(input.actor, REFUND_REQUEST_ROLES);
  const companyId = requireCompanyId(input.actor);
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? REFUND_PAYMENT_LIST_LIMIT), 1),
    REFUND_PAYMENT_LIST_LIMIT,
  );
  const payments = await dependencies.rest.select(
    "payments",
    `${PAYMENT_ROW_COLUMNS}&company_id=eq.${companyId}&status=${listOf([
      "captured",
      "settled",
      "partially_refunded",
    ])}&deleted_at=is.null&order=created_at.desc&limit=${limit}`,
    paymentRowSchema,
  );

  const views: RefundablePaymentView[] = [];

  for (const payment of payments) {
    const { heldMinor, promisedMinor } = await heldOf(dependencies, payment.id, null);
    const remaining = refundRemainingOf({
      amountMinor: payment.amount_minor,
      heldMinor,
      promisedMinor,
    });

    if (remaining === 0n) {
      continue;
    }

    views.push({
      paymentId: payment.id,
      invoiceId: payment.invoice_id,
      amountMinor: payment.amount_minor.toString(),
      amountText: `${priceFromMinor(payment.amount_minor)} ${payment.currency}`,
      refundedMinor: payment.refunded_minor.toString(),
      remainingMinor: remaining.toString(),
      remainingText: `${priceFromMinor(remaining)} ${payment.currency}`,
      currency: payment.currency,
      status: payment.status,
      capturedAt: payment.captured_at ?? payment.settled_at,
    });
  }

  return views;
}

/** Re-export the two body parsers, so a route imports the service and the vocabulary it uses once. */
export { parseRefundRequestBody, parseRefundDecisionBody } from "./refund-fields.ts";
