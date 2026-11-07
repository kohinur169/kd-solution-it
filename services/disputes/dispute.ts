// path: services/disputes/dispute.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { priceColumnSchema, priceFromMinor } from "../products/price.ts";
import { appendTolerated } from "../payments/refund.ts";
import type { DisputeEvent } from "./dispute-events.ts";
import {
  DISPUTE_AUDIT,
  DISPUTE_AUDIT_ENTITY,
  DISPUTE_DEFAULT_WINDOW_HOURS,
  DISPUTE_LIST_LIMIT,
  DISPUTE_OFFICE_ROLES,
  DISPUTE_QUEUE_LIMIT,
  DISPUTE_REASON_MAXIMUM_LENGTH,
  DISPUTE_REQUEST_ROLES,
  DISPUTE_RULES,
  disputeDueAt,
  disputeStatusMayMove,
  isDisputeStatus,
  isProviderWritableDisputeStatus,
  isResolvedDisputeStatus,
  type DisputeStatus,
} from "./dispute-fields.ts";

/**
 * Section 19's disputes: the list a merchant reads, the queue the office reads, and the one write a
 * provider delivery performs on a row.
 *
 * ## What `0039` already answered, and what this module therefore does not
 *
 * `0039_disputes.sql` created the table, its six statuses, its deadline arithmetic
 * (`response_due_at > opened_at` and `<= opened_at + window`), its evidence rule (`submitted_at` only with
 * `evidence_ready`), its resolution rule (`won`/`lost`/`closed` exactly when `resolved_at` exists and with a
 * note), its unique index `disputes_processor_key` on `(company_id, processor_dispute_id)` and its
 * `disputes_guard_deadline` trigger, which freezes the payment and the opening instant and refuses to
 * reopen a resolved dispute. **This STEP adds no migration**, and the gate proves it by reading the schema
 * rather than by promise: the columns this module writes are the columns `0039` already has, and the five
 * invariants above are the five it leans on.
 *
 * ## The one write, and why it is a state machine rather than an upsert
 *
 * A provider delivery says what the *provider* thinks the dispute is. It arrives out of order, more than
 * once, and after the platform has already answered. So the write is not "set the status to what the body
 * says"; it is "move the row forward to the status the body asks for, or do nothing and say why". The four
 * answers are all normal: `opened` (a row appeared), `moved` (a row advanced), and two kinds of `ignored` -
 * a status at or behind the row's own, and a row already decided. Only a missing payment is a refusal, and
 * the event row records it so a later delivery can try again.
 *
 * ## Why every write is guarded and then read back
 *
 * PostgREST reports a zero-row update as success. Each update therefore carries the status and the version
 * the caller read, and the row is read back afterwards: two deliveries of two different events for one
 * dispute cannot both land, and the loser is told the row moved rather than being shown a change it did
 * not make. That is `refund.ts`'s rule, applied to the table section 19 gave a version column for.
 */

/** What the service needs: the gateway to the database, the signed chain, and a clock. */
export interface DisputeDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/**
 * How close to its deadline a dispute is.
 *
 * `resolved` is history, `overdue` is past the instant section 19 gave the merchant, `due_soon` is inside
 * the last sixth of the window (four hours of a 24-hour window) and `open` is everything else. The office
 * queue sorts by the instant itself, so this is what a screen prints, not what a query filters on.
 */
export const DISPUTE_DUE_STATES = Object.freeze(["open", "due_soon", "overdue", "resolved"] as const);

export type DisputeDueState = (typeof DISPUTE_DUE_STATES)[number];

/** One dispute, as a screen prints it. */
export interface DisputeView {
  readonly id: string;
  readonly companyId: string;
  readonly paymentId: string;
  readonly processorDisputeId: string | null;
  readonly status: DisputeStatus;
  readonly reasonCode: string;
  /** The disputed amount in minor units, as decimal text. */
  readonly amountMinor: string;
  /** The same amount printed for a person: `20.0000 USD`. */
  readonly amountText: string;
  readonly currency: string;
  readonly feeMinor: string;
  readonly feeText: string;
  readonly openedAt: string;
  readonly responseWindowHours: number;
  readonly responseDueAt: string;
  readonly dueState: DisputeDueState;
  readonly evidenceReady: boolean;
  readonly responseSubmittedAt: string | null;
  readonly resolvedAt: string | null;
  readonly outcomeNote: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** The columns every read names, one by one. Never `select=*`. */
export const DISPUTE_ROW_COLUMNS =
  "select=id,company_id,payment_id,processor_dispute_id,status,reason_code,amount_minor,currency,fee_minor" +
  ",opened_at,response_window_hours,response_due_at,evidence_ready,submitted_at,resolved_at,outcome_note" +
  ",created_at,updated_at,version";

export const disputeRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  processor_dispute_id: z.string().nullable(),
  status: z.string(),
  reason_code: z.string(),
  amount_minor: priceColumnSchema,
  currency: z.string(),
  fee_minor: priceColumnSchema,
  opened_at: z.string(),
  response_window_hours: z.number(),
  response_due_at: z.string(),
  evidence_ready: z.boolean(),
  submitted_at: z.string().nullable(),
  resolved_at: z.string().nullable(),
  outcome_note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number(),
});

export type DisputeRow = z.infer<typeof disputeRowSchema>;

/** The payment a dispute hangs on, as the webhook needs it. */
export const DISPUTE_PAYMENT_COLUMNS =
  "select=id,company_id,provider_id,mode,provider_transaction_id,amount_minor,currency,status";

export const disputePaymentRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  provider_id: z.string().uuid(),
  mode: z.string(),
  provider_transaction_id: z.string().nullable(),
  amount_minor: priceColumnSchema,
  currency: z.string(),
  status: z.string(),
});

export type DisputePaymentRow = z.infer<typeof disputePaymentRowSchema>;

/** The provider row a delivery names: `payment_providers` is platform-wide, so `company_id` is null. */
const providerRowSchema = z.object({
  id: z.string().uuid(),
  provider_key: z.string(),
  status: z.string(),
});

export type DisputeProviderRow = z.infer<typeof providerRowSchema>;

/** The four hours of a 24-hour window that count as "due soon". */
export const DISPUTE_DUE_SOON_HOURS = 4;

/** How close one row is to the deadline section 19 gave it. */
export function dueStateOf(resolvedAt: string | null, responseDueAt: string, nowMs: number): DisputeDueState {
  if (resolvedAt !== null) {
    return "resolved";
  }

  const due = Date.parse(responseDueAt);

  if (!Number.isFinite(due)) {
    return "open";
  }

  if (nowMs > due) {
    return "overdue";
  }

  return due - nowMs <= DISPUTE_DUE_SOON_HOURS * 3_600_000 ? "due_soon" : "open";
}

/** A dispute row as a screen prints it. One function, so the service and the routes agree. */
export function disputeViewOf(row: DisputeRow, nowMs: number): DisputeView {
  return {
    id: row.id,
    companyId: row.company_id,
    paymentId: row.payment_id,
    processorDisputeId: row.processor_dispute_id,
    status: isDisputeStatus(row.status) ? row.status : "open",
    reasonCode: row.reason_code,
    amountMinor: row.amount_minor.toString(),
    amountText: `${priceFromMinor(row.amount_minor)} ${row.currency}`,
    currency: row.currency,
    feeMinor: row.fee_minor.toString(),
    feeText: `${priceFromMinor(row.fee_minor)} ${row.currency}`,
    openedAt: row.opened_at,
    responseWindowHours: row.response_window_hours,
    responseDueAt: row.response_due_at,
    dueState: dueStateOf(row.resolved_at, row.response_due_at, nowMs),
    evidenceReady: row.evidence_ready,
    responseSubmittedAt: row.submitted_at,
    resolvedAt: row.resolved_at,
    outcomeNote: row.outcome_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/** The clock of one call, defaulting to the wall clock. */
function nowOf(dependencies: DisputeDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

/* -------------------------------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------------------------------- */

/**
 * One merchant's disputes, newest first.
 *
 * Newest first because this is a list of things that happened to a merchant's money, not a queue: the
 * screen prints the deadline state of every row, and a merchant scanning it wants the dispute that arrived
 * this morning at the top. The office's queue below is the opposite order for the opposite reason.
 */
export async function listCompanyDisputes(
  input: { readonly actor: RequestActor; readonly limit?: number },
  dependencies: DisputeDependencies,
): Promise<readonly DisputeView[]> {
  requireAnyRole(input.actor, DISPUTE_REQUEST_ROLES);
  const companyId = requireCompanyId(input.actor);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DISPUTE_LIST_LIMIT), 1), DISPUTE_LIST_LIMIT);
  const rows = await dependencies.rest.select(
    "disputes",
    `${DISPUTE_ROW_COLUMNS}&company_id=eq.${companyId}&deleted_at=is.null&order=opened_at.desc&limit=${limit}`,
    disputeRowSchema,
  );
  const nowMs = nowOf(dependencies);

  return rows.map((row) => disputeViewOf(row, nowMs));
}

/**
 * The platform's dispute queue: every row still waiting on somebody, nearest deadline first.
 *
 * Nearest deadline first because the deadline *is* the work: section 19 gives the merchant 24 hours and the
 * compliance desk sends the pack, so the row whose window closes first is the one that must be read first.
 * The whole platform is visible, because the compliance desk answers for every merchant, and the tenant
 * travels back on each row so an act can be traced to the company it was about.
 */
export async function listDisputeQueue(
  input: { readonly actor: RequestActor; readonly limit?: number },
  dependencies: DisputeDependencies,
): Promise<readonly DisputeView[]> {
  requireAnyRole(input.actor, DISPUTE_OFFICE_ROLES);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DISPUTE_QUEUE_LIMIT), 1), DISPUTE_QUEUE_LIMIT);
  const rows = await dependencies.rest.select(
    "disputes",
    `${DISPUTE_ROW_COLUMNS}&resolved_at=is.null&deleted_at=is.null&order=response_due_at.asc&limit=${limit}`,
    disputeRowSchema,
  );
  const nowMs = nowOf(dependencies);

  return rows.map((row) => disputeViewOf(row, nowMs));
}

/** The `payment_providers` row a delivery names, or null when this build knows no such provider. */
export async function findDisputeProvider(
  dependencies: DisputeDependencies,
  providerKey: string,
): Promise<DisputeProviderRow | null> {
  const rows = await dependencies.rest.select(
    "payment_providers",
    `select=id,provider_key,status&provider_key=eq.${encodeURIComponent(providerKey)}` +
      "&company_id=is.null&deleted_at=is.null&limit=1",
    providerRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * The payment a delivery names, or null.
 *
 * The join is `(provider_id, mode, provider_transaction_id)`: the processor's own reference for the charge
 * is what a dispute names, and `payments.provider_transaction_id` is where the capture path records it. The
 * mode matters twice over - a sandbox dispute must never touch a live payment, and a live dispute must
 * never be matched to a test row that happens to carry the same reference.
 */
export async function findDisputePayment(
  dependencies: DisputeDependencies,
  input: { readonly providerId: string; readonly mode: string; readonly reference: string },
): Promise<DisputePaymentRow | null> {
  const rows = await dependencies.rest.select(
    "payments",
    `${DISPUTE_PAYMENT_COLUMNS}&provider_id=eq.${input.providerId}` +
      `&mode=eq.${encodeURIComponent(input.mode)}` +
      `&provider_transaction_id=eq.${encodeURIComponent(input.reference)}` +
      "&deleted_at=is.null&limit=1",
    disputePaymentRowSchema,
  );

  return rows[0] ?? null;
}

/** One dispute by the processor's id inside a merchant, which is the idempotency key a delivery carries. */
export async function findDisputeByProcessorId(
  dependencies: DisputeDependencies,
  input: { readonly companyId: string; readonly processorDisputeId: string },
): Promise<DisputeRow | null> {
  const rows = await dependencies.rest.select(
    "disputes",
    `${DISPUTE_ROW_COLUMNS}&company_id=eq.${input.companyId}` +
      `&processor_dispute_id=eq.${encodeURIComponent(input.processorDisputeId)}` +
      "&deleted_at=is.null&limit=1",
    disputeRowSchema,
  );

  return rows[0] ?? null;
}

/** One dispute by its own id. */
export async function findDispute(dependencies: DisputeDependencies, disputeId: string): Promise<DisputeRow | null> {
  const rows = await dependencies.rest.select(
    "disputes",
    `${DISPUTE_ROW_COLUMNS}&id=eq.${encodeURIComponent(disputeId)}&deleted_at=is.null&limit=1`,
    disputeRowSchema,
  );

  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------------------------------
 * The one write a delivery performs
 * ---------------------------------------------------------------------------------------------- */

/** What one delivery did, in the words the audit chain and the route both use. */
export interface DisputeEventOutcome {
  readonly kind: "opened" | "moved" | "ignored" | "refused";
  /** The status the row had, or null when there was no row yet. */
  readonly from: DisputeStatus | null;
  /** The status the row now has, or null when nothing was written. */
  readonly to: DisputeStatus | null;
  /** The rule behind an `ignored` or `refused` outcome, and null for a write. */
  readonly rule: string | null;
  readonly dispute: DisputeRow | null;
}

/** One delivery, the payment it names and the `webhook_events` row that recorded it. */
export interface DisputeEventInput {
  readonly event: DisputeEvent;
  readonly payment: DisputePaymentRow;
  readonly webhookEventId: string;
}

/**
 * Move one dispute forward, or say why the delivery changed nothing.
 *
 * The five guards, in the order they are asked:
 *
 *   1. the delivery must ask for a status, and for one a provider may write (`evidence_submitted` is the
 *      compliance desk's, and `0039` requires an evidence pack before it);
 *   2. the delivery must name a dispute, because without the processor's id the second delivery of the
 *      same event would write a second row;
 *   3. the disputed amount must be a positive whole number of minor units and the currency must be the
 *      payment's - a dispute in another currency is not a smaller dispute, it is a mis-paired delivery;
 *   4. the row must not already be decided, and must not already be at or past the status the delivery
 *      asks for;
 *   5. the write must carry the version the caller read, so a race loses rather than overwrites.
 */
export async function applyDisputeEvent(
  dependencies: DisputeDependencies,
  input: DisputeEventInput,
): Promise<DisputeEventOutcome> {
  const { event, payment } = input;

  if (event.status === null) {
    return { kind: "ignored", from: null, to: null, rule: null, dispute: null };
  }

  if (!isProviderWritableDisputeStatus(event.status)) {
    return { kind: "refused", from: null, to: null, rule: DISPUTE_RULES.statusNotFromProvider, dispute: null };
  }

  if (event.processorDisputeId === null || event.processorDisputeId.length === 0) {
    return { kind: "refused", from: null, to: null, rule: DISPUTE_RULES.eventIdInvalid, dispute: null };
  }

  const existing = await findDisputeByProcessorId(dependencies, {
    companyId: payment.company_id,
    processorDisputeId: event.processorDisputeId,
  });

  if (existing === null) {
    return insertOpenedDispute(dependencies, input);
  }

  const from = isDisputeStatus(existing.status) ? existing.status : "open";

  if (isResolvedDisputeStatus(from)) {
    return { kind: "ignored", from, to: null, rule: DISPUTE_RULES.resolved, dispute: existing };
  }

  if (!disputeStatusMayMove(from, event.status)) {
    return { kind: "ignored", from, to: null, rule: DISPUTE_RULES.statusStale, dispute: existing };
  }

  return moveDispute(dependencies, existing, event.status, event, input.webhookEventId);
}

/** Write a dispute this platform has not seen before. */
async function insertOpenedDispute(
  dependencies: DisputeDependencies,
  input: DisputeEventInput,
): Promise<DisputeEventOutcome> {
  const { event, payment } = input;
  const target = event.status;

  if (target === null) {
    return { kind: "ignored", from: null, to: null, rule: null, dispute: null };
  }

  const reason = (event.reasonCode ?? "").trim().slice(0, DISPUTE_REASON_MAXIMUM_LENGTH);

  if (reason.length === 0) {
    return { kind: "refused", from: null, to: null, rule: DISPUTE_RULES.reasonInvalid, dispute: null };
  }

  // The provider's own number when it sends one, and the payment's when it does not: a dispute cannot be
  // for more than was charged, and `payments_amount_check` is the only place that number is authoritative.
  const amount = event.amountMinor === null ? payment.amount_minor : event.amountMinor;

  if (amount <= 0n) {
    return { kind: "refused", from: null, to: null, rule: DISPUTE_RULES.amountInvalid, dispute: null };
  }

  const currency = event.currency ?? payment.currency;

  if (currency !== payment.currency) {
    return { kind: "refused", from: null, to: null, rule: DISPUTE_RULES.currencyMismatch, dispute: null };
  }

  const nowMs = nowOf(dependencies);
  const openedAtMs = event.openedAtEpochMs === null ? nowMs : event.openedAtEpochMs;
  const resolved = isResolvedDisputeStatus(target);
  const windowHours = DISPUTE_DEFAULT_WINDOW_HOURS;

  let inserted: DisputeRow;

  try {
    const rows = await dependencies.rest.insertReturning(
      "disputes",
      [
        {
          company_id: payment.company_id,
          payment_id: payment.id,
          processor_dispute_id: event.processorDisputeId,
          status: target,
          reason_code: reason,
          amount_minor: amount.toString(),
          currency,
          // Section 18's chargeback fee is `super_admin`'s number, set by the STEP that owns that rule and
          // posted by the ledger. A webhook never writes it: 0 is the column's own default and means "the
          // platform has not answered the fee question for this dispute yet".
          fee_minor: "0",
          opened_at: new Date(openedAtMs).toISOString(),
          response_window_hours: windowHours,
          response_due_at: new Date(disputeDueAt(openedAtMs, windowHours)).toISOString(),
          evidence_ready: false,
          submitted_at: null,
          resolved_at: resolved ? new Date(nowMs).toISOString() : null,
          outcome_note: resolved ? (event.outcomeNote ?? `The processor closed the dispute: ${target}.`) : null,
        },
      ],
      disputeRowSchema,
    );

    inserted = rows[0] as DisputeRow;
  } catch (error) {
    if (isConflictError(error)) {
      // Another delivery of the same dispute won the race between the read above and this insert. The
      // honest answer is the one the read would have given a moment later.
      return { kind: "ignored", from: null, to: null, rule: DISPUTE_RULES.disputeMoved, dispute: null };
    }

    throw error;
  }

  await note(dependencies, DISPUTE_AUDIT.opened, inserted, input.webhookEventId, {
    from: null,
    to: inserted.status,
    reason_code: inserted.reason_code,
    amount_minor: inserted.amount_minor.toString(),
    currency: inserted.currency,
    response_window_hours: inserted.response_window_hours,
    response_due_at: inserted.response_due_at,
  });

  return { kind: "opened", from: null, to: target, rule: null, dispute: inserted };
}

/** Advance a dispute this platform already has, guarded by the status and the version it was read at. */
async function moveDispute(
  dependencies: DisputeDependencies,
  row: DisputeRow,
  target: DisputeStatus,
  event: DisputeEvent,
  webhookEventId: string,
): Promise<DisputeEventOutcome> {
  const resolved = isResolvedDisputeStatus(target);
  const nowMs = nowOf(dependencies);
  const outcomeNote = resolved ? (event.outcomeNote ?? `The processor closed the dispute: ${target}.`) : null;

  await dependencies.rest.update(
    "disputes",
    `id=eq.${row.id}&status=eq.${row.status}&version=eq.${row.version}&deleted_at=is.null`,
    {
      status: target,
      resolved_at: resolved ? new Date(nowMs).toISOString() : null,
      outcome_note: outcomeNote,
    },
  );

  const moved = await findDispute(dependencies, row.id);

  if (moved === null || moved.status !== target || moved.version !== row.version + 1) {
    // Another delivery landed between this reading and this write, or the database refused one of its own
    // constraints. Either way this delivery did not move the row and must not be recorded as if it did.
    return { kind: "ignored", from: row.status as DisputeStatus, to: null, rule: DISPUTE_RULES.disputeMoved, dispute: moved };
  }

  await note(dependencies, DISPUTE_AUDIT.moved, moved, webhookEventId, {
    from: row.status,
    to: target,
    resolved: resolved,
    resolved_at: moved.resolved_at,
  });

  return { kind: "moved", from: row.status as DisputeStatus, to: target, rule: null, dispute: moved };
}

/** One audit entry for one delivery, written or not: a chain that is down never blocks a provider's event. */
async function note(
  dependencies: DisputeDependencies,
  action: string,
  row: DisputeRow,
  webhookEventId: string,
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  const entry: AuditEntry = {
    action,
    // No person: a provider delivery is the platform's own record of somebody else's act. The event row the
    // caller already wrote is the attribution, and its id travels here so the two can be joined by reading.
    actorUserId: null,
    entityType: DISPUTE_AUDIT_ENTITY,
    entityId: row.id,
    payload: {
      payment_id: row.payment_id,
      webhook_event_id: webhookEventId,
      processor_dispute_id: row.processor_dispute_id,
      status: row.status,
      ...detail,
    },
    companyId: row.company_id,
    sessionId: null,
    ipAddress: null,
    userAgent: null,
  };

  await appendTolerated(dependencies.audit, entry);
}

/** One ignored delivery, recorded in the chain by the webhook module. */
export async function noteIgnoredDispute(
  dependencies: DisputeDependencies,
  input: {
    readonly action: string;
    readonly rule: string;
    readonly webhookEventId: string;
    readonly companyId: string | null;
    readonly disputeId: string | null;
  },
): Promise<void> {
  await appendTolerated(dependencies.audit, {
    action: input.action,
    actorUserId: null,
    entityType: input.disputeId === null ? "webhook_event" : DISPUTE_AUDIT_ENTITY,
    entityId: input.disputeId ?? input.webhookEventId,
    payload: { rule: input.rule, webhook_event_id: input.webhookEventId },
    companyId: input.companyId,
    sessionId: null,
    ipAddress: null,
    userAgent: null,
  });
}
