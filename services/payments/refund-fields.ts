// path: services/payments/refund-fields.ts
import { z } from "zod";
import { AppError } from "../../lib/errors/app-error.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";
import type { PlatformRole } from "../../lib/auth/types.ts";
import { priceToMinor } from "../products/price.ts";

/**
 * The vocabulary of section 19's refund: the states a refund row moves through, the two things a person
 * types into it, the roles that may ask and decide, and the words a refusal names.
 *
 * ## Why this is a separate module from the service
 *
 * Two different runtimes need the same words. The merchant console and the platform's approval queue are
 * client components, so they can import a module that imports nothing but `zod` and a decimal parser; the
 * service imports the REST client, the audit trail and the session rules and must never reach a browser
 * bundle. Everything a screen has to know - the statuses, their labels, the field names, the limits, the
 * rule a refusal names - lives here, and everything that touches a database lives in `refund.ts`.
 *
 * ## Why the lifecycle is `0038`'s and not this module's
 *
 * `0038_refunds.sql` already carries the whole state machine: six statuses, `refunds_approval_check`
 * tying `approved_by` and `decided_at` to the statuses that follow a decision, `refunds_processed_check`
 * tying `processed_at` to the two the processor answers, and `refunds_guard_amount` capping the live
 * refunds of a payment against what was charged. This module therefore *reads* that machine rather than
 * inventing a second one, and the gate compares the two lists word for word.
 */

/** The column the audit chain names a refund under. */
export const REFUND_AUDIT_ENTITY = "refund";

/** The six statuses `refunds_status_check` allows, in the order a row moves through them. */
export const REFUND_STATUSES = deepFreeze([
  "requested",
  "approved",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
] as const);

export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * The statuses that hold money against a payment.
 *
 * `refunds_guard_amount` counts these three when it caps a refund, and `refunds_sync_payment` counts only
 * `succeeded` when it writes `payments.refunded_minor`. The difference is deliberate and it is why this
 * module asks two different questions: "how much of this payment may still be promised" (this list, plus
 * the merchants' open requests) and "how much has actually gone back" (`succeeded` alone).
 */
export const REFUND_LIVE_STATUSES = deepFreeze(["approved", "processing", "succeeded"] as const);

/** The statuses that are still somebody's desk: the merchant's, or the platform's. */
export const REFUND_OPEN_STATUSES = deepFreeze(["requested", "approved", "processing"] as const);

/** The statuses a payment must be in before any refund of it can be asked for. */
export const REFUNDABLE_PAYMENT_STATUSES = deepFreeze([
  "captured",
  "settled",
  "partially_refunded",
] as const);

/**
 * Who may ask for a refund, and who may decide one.
 *
 * The two lists are different on purpose. A refund is raised by the merchant whose money it is - the
 * `owner` role, the same role that voids an invoice or manages a payment link - and decided by the
 * platform's finance desk, because the platform is the payment facilitator and holds the funds. A
 * merchant that could approve its own refund would be the four-eyes rule signing its own form, and
 * `approved_by` is a person's id in `public.users`, not a company's.
 */
export const REFUND_REQUEST_ROLES: readonly PlatformRole[] = deepFreeze(["owner"] as const);
export const REFUND_DECISION_ROLES: readonly PlatformRole[] = deepFreeze(["finance_ops", "super_admin"] as const);

/** The three fields a request carries, in the order a refusal is reported against them. */
export const REFUND_REQUEST_FIELD_ORDER = deepFreeze(["payment_id", "amount", "reason"] as const);

/** The reason's bounds: `refunds_reason_check`, trimmed, a sentence and never a document. */
export const REFUND_REASON_MINIMUM_LENGTH = 1;
export const REFUND_REASON_MAXIMUM_LENGTH = 500;

/** A decision's note is optional and lives only in the chain; it is bounded for the same reason. */
export const REFUND_NOTE_MAXIMUM_LENGTH = 500;

/** A request's body ceiling in bytes: an id, an amount and a sentence. */
export const REFUND_REQUEST_MAXIMUM_BODY_BYTES = 2_048;

/** A decision's body ceiling: one word and an optional note. */
export const REFUND_DECISION_MAXIMUM_BODY_BYTES = 1_024;

/** How many rows a listing answers with: a merchant's own refunds, and the platform's queue. */
export const REFUND_LIST_LIMIT = 50;
export const REFUND_QUEUE_LIMIT = 100;

/** How many refundable payments a merchant's screen lists beside the refunds. */
export const REFUND_PAYMENT_LIST_LIMIT = 50;

/**
 * The rules this module refuses with.
 *
 * Each is the `rule` of an `AppError` detail, so a screen maps one word to one sentence and the gate can
 * assert the word rather than a sentence. They are not error codes: a refund of a payment that does not
 * exist is a `RESOURCE_NOT_FOUND`, one that asks for too much is a `VALIDATION_FAILED`, and one that
 * arrives too late is a `CONFLICT` - the code already says which, and the rule says why.
 */
export const REFUND_RULES = deepFreeze({
  /** No such payment, or a payment of another merchant. */
  paymentNotFound: "payment_not_found",
  /** The payment was never captured, or has already been refunded in full. */
  paymentNotRefundable: "payment_not_refundable",
  /** The amount is not a price this platform can read. */
  amountInvalid: "amount_invalid",
  /** Zero, or a fraction of a minor unit. */
  amountTooSmall: "amount_too_small",
  /** More than what is left of the payment. */
  exceedsRefundable: "exceeds_refundable",
  /** Nothing is left to return. */
  nothingToRefund: "nothing_to_refund",
  /** The reason is empty, too long, or not trimmed. */
  reasonInvalid: "reason_invalid",
  /** No such refund, or a refund of another merchant. */
  refundNotFound: "refund_not_found",
  /** The refund is no longer waiting for the decision this caller made. */
  refundNotPending: "refund_not_pending",
  /** The person deciding raised it. */
  selfDecision: "refund_self_decision",
  /** The confirmation carried a note this platform cannot keep. */
  noteInvalid: "note_invalid",
  /** The row moved between the read and the write. */
  refundMoved: "refund_moved",
} as const);

/** The four audit actions of this STEP, one per act a person performs. */
export const REFUND_REQUESTED_AUDIT_ACTION = "refund.requested";
export const REFUND_APPROVED_AUDIT_ACTION = "refund.approved";
export const REFUND_REJECTED_AUDIT_ACTION = "refund.rejected";
export const REFUND_CANCELLED_AUDIT_ACTION = "refund.cancelled";

/** The two decisions an approver makes. */
export const REFUND_DECISIONS = deepFreeze(["approve", "reject"] as const);

export type RefundDecision = (typeof REFUND_DECISIONS)[number];

/** A request's body: strict, so a field this platform does not take is a refusal rather than a shrug. */
const requestBodySchema = z
  .object({
    payment_id: z.string(),
    amount: z.string(),
    reason: z.string(),
  })
  .strict();

/** A decision's body: the decision and an optional note. */
const decisionBodySchema = z
  .object({
    decision: z.string(),
    note: z.string().nullish(),
  })
  .strict();

/** One refusal: a field and a rule, never the value that produced it. */
function refused(field: string, rule: string, code: "VALIDATION_FAILED" | "CONFLICT" | "RESOURCE_NOT_FOUND"): AppError {
  return new AppError(code, { details: [{ field, rule }] });
}

/** A state refusal: the row exists and will not take this act. */
export function refundStateRefused(rule: string): AppError {
  return refused("refund", rule, "CONFLICT");
}

/** A refund this caller may not see at all. */
export function refundNotFound(): AppError {
  return refused("refund", REFUND_RULES.refundNotFound, "RESOURCE_NOT_FOUND");
}

/** A payment this caller may not see at all. */
export function refundPaymentNotFound(): AppError {
  return refused("payment_id", REFUND_RULES.paymentNotFound, "RESOURCE_NOT_FOUND");
}

/** True when a value is one of `0038`'s six statuses. */
export function isRefundStatus(value: unknown): value is RefundStatus {
  return typeof value === "string" && (REFUND_STATUSES as readonly string[]).includes(value);
}

/** True when the status is one of the three that hold money. */
export function isRefundLiveStatus(status: string): boolean {
  return (REFUND_LIVE_STATUSES as readonly string[]).includes(status);
}

/** True when the status is still somebody's desk. */
export function isRefundOpenStatus(status: string): boolean {
  return (REFUND_OPEN_STATUSES as readonly string[]).includes(status);
}

/** True when a payment is in a state a refund can be asked for. */
export function isRefundablePaymentStatus(status: string): boolean {
  return (REFUNDABLE_PAYMENT_STATUSES as readonly string[]).includes(status);
}

/**
 * The amount a merchant asked for, in minor units.
 *
 * A refund is typed as a price, so it goes through the same parser an invoice line does: `1e3`, `12,50`
 * and a fifth decimal are refused rather than coerced, and the answer is a `bigint` all the way to the
 * row. Zero is not a refund and is refused before any read.
 */
export function refundAmountOf(text: string): bigint {
  const trimmed = text.trim();
  const minor = trimmed.length === 0 ? null : priceToMinor(trimmed);

  if (minor === null) {
    throw refused("amount", REFUND_RULES.amountInvalid, "VALIDATION_FAILED");
  }

  if (minor <= 0n) {
    throw refused("amount", REFUND_RULES.amountTooSmall, "VALIDATION_FAILED");
  }

  return minor;
}

/**
 * The reason, as the row stores it: trimmed, and `0038`'s own bounds.
 *
 * The trim is not cosmetic. `refunds_reason_check` requires `reason = btrim(reason)`, so a reason typed
 * with a trailing space would be a `check_violation` - a 500 for something a person can fix by reading
 * one sentence instead.
 */
export function refundReasonOf(text: string): string {
  const trimmed = text.trim();

  if (trimmed.length < REFUND_REASON_MINIMUM_LENGTH || trimmed.length > REFUND_REASON_MAXIMUM_LENGTH) {
    throw refused("reason", REFUND_RULES.reasonInvalid, "VALIDATION_FAILED");
  }

  return trimmed;
}

/** A decision's note: absent, or a bounded trimmed sentence. */
export function refundNoteOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > REFUND_NOTE_MAXIMUM_LENGTH) {
    throw refused("note", REFUND_RULES.noteInvalid, "VALIDATION_FAILED");
  }

  return trimmed;
}

/** What a parsed request carries. */
export interface ParsedRefundRequest {
  readonly paymentId: string;
  readonly amountMinor: bigint;
  readonly reason: string;
}

/** Parse a request body. Strict, bounded and trimmed, and every refusal names its field. */
export function parseRefundRequestBody(body: unknown): ParsedRefundRequest {
  const parsed = requestBodySchema.safeParse(body);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.code === "unrecognized_keys" ? issue.keys[0] : null;
    const field = key ?? String(issue?.path[0] ?? REFUND_REQUEST_FIELD_ORDER[0]);

    throw refused(field, REFUND_RULES.amountInvalid, "VALIDATION_FAILED");
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(parsed.data.payment_id)) {
    throw refused("payment_id", REFUND_RULES.paymentNotFound, "VALIDATION_FAILED");
  }

  return {
    paymentId: parsed.data.payment_id.toLowerCase(),
    amountMinor: refundAmountOf(parsed.data.amount),
    reason: refundReasonOf(parsed.data.reason),
  };
}

/** What a parsed decision carries. */
export interface ParsedRefundDecision {
  readonly decision: RefundDecision;
  readonly note: string | null;
}

/** Parse a decision body. An unknown decision word is a refusal, never a default. */
export function parseRefundDecisionBody(body: unknown): ParsedRefundDecision {
  const parsed = decisionBodySchema.safeParse(body);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.code === "unrecognized_keys" ? issue.keys[0] : null;

    throw refused(key ?? String(issue?.path[0] ?? "decision"), REFUND_RULES.amountInvalid, "VALIDATION_FAILED");
  }

  const decision = parsed.data.decision.trim().toLowerCase();

  if (!(REFUND_DECISIONS as readonly string[]).includes(decision)) {
    throw refused("decision", REFUND_RULES.amountInvalid, "VALIDATION_FAILED");
  }

  return { decision: decision as RefundDecision, note: refundNoteOf(parsed.data.note) };
}

/**
 * What a payment may still return, given what is already held against it.
 *
 * Two numbers, kept apart on purpose. `held` is what `refunds_guard_amount` counts - approved, processing
 * and succeeded - which is the money the database will refuse to exceed. `promised` additionally counts
 * the requests still waiting for a decision, because a merchant with 30 of 100 requested should not be
 * told it may ask for another 100 and then have the second request refused at the approval desk.
 */
export function refundRemainingOf(input: {
  readonly amountMinor: bigint;
  readonly heldMinor: bigint;
  readonly promisedMinor?: bigint;
}): bigint {
  const taken = input.heldMinor + (input.promisedMinor ?? 0n);

  return input.amountMinor > taken ? input.amountMinor - taken : 0n;
}
