// path: services/payments/refund-execution-fields.ts
import { AppError } from "../../lib/errors/app-error.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";

/**
 * The vocabulary of STEP 192: taking an approved refund to the provider that took the money.
 *
 * ## Where the boundary is
 *
 * STEP 191 ends with a refund `approved` - money the platform has promised. This STEP is the one that asks
 * the provider to send it back, records what the provider answered, and lets `0038`'s `refunds_sync_payment`
 * write the payment's refunded total once the money has actually moved. Nothing here decides *whether* the
 * money goes back; that decision was a person's, and it is already on the row.
 *
 * ## The five answers a provider can give, and why each has its own status
 *
 * A provider call is not a boolean. It can succeed, refuse, accept and settle later, accept and never
 * answer, or never be made at all because this build cannot reach it. `0038` has exactly three statuses for
 * the middle of a refund's life - `processing`, `succeeded`, `failed` - so the five answers fold onto four
 * rows and one refusal:
 *
 *   - `succeeded` -> `succeeded`, with the provider's own refund identifier (`refunds_provider_required_check`
 *     makes that identifier mandatory, so an answer without one cannot be recorded as a success);
 *   - `declined` -> `failed`, with a detail `refunds_failure_check` allows (1-280, trimmed);
 *   - `pending` -> stays `processing`, with the provider's identifier if it gave one, because the answer is
 *     coming from somewhere else;
 *   - `unanswered` -> stays `processing`, because a call that timed out may or may not have moved money and
 *     calling it failed would be a lie the merchant would read;
 *   - `not_sent` -> back to `approved`, because no money moved and no provider was asked: the desk fixes the
 *     configuration and presses again, with the same refund and the same audit chain.
 *
 * ## Why the amount is converted here and not at the adapter
 *
 * The platform counts money in ten-thousandths (`priceFromMinor` prints four decimals) and the card networks
 * count it in hundredths. A refund of an amount that is not a whole number of cents cannot be asked for at
 * all, so `providerAmountOf` answers `null` and the service refuses *before* it moves the row - rather than
 * sending a rounded amount and discovering the difference in a reconciliation a week later.
 */

/** The one status a refund must be in before this STEP may ask a provider about it. */
export const REFUND_EXECUTABLE_STATUS = "approved";

/** What a provider call can answer, in the order the service handles them. */
export const REFUND_PROVIDER_OUTCOMES = deepFreeze([
  "succeeded",
  "declined",
  "pending",
  "unanswered",
  "not_sent",
] as const);

export type RefundProviderOutcomeKind = (typeof REFUND_PROVIDER_OUTCOMES)[number];

/**
 * The longest detail a failed refund may carry.
 *
 * `refunds_failure_check` allows 1 to 280 trimmed characters, so a provider's message is cut here before it
 * is written rather than being refused by the database after the money already moved.
 */
export const REFUND_DETAIL_MAXIMUM_LENGTH = 280;

/** The longest provider refund identifier `refunds_provider_id_check` allows. */
export const REFUND_PROVIDER_ID_MAXIMUM_LENGTH = 120;

/** A provider's own reference for the payment being refunded, from `payments.provider_transaction_id`. */
export const REFUND_PROVIDER_REFERENCE_MAXIMUM_LENGTH = 120;

/** The body an execution carries: nothing but a CSRF header and, at most, a note of intent. */
export const REFUND_EXECUTION_MAXIMUM_BODY_BYTES = 512;

/** How long one provider call may take before it is treated as unanswered. */
export const REFUND_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * Why an execution was refused, or why no provider was asked.
 *
 * Each word is a sentence on the desk's screen and a rule in the error envelope; none of them is a status a
 * refund is left in.
 */
export const REFUND_EXECUTION_RULES = deepFreeze({
  /** No such refund. */
  refundNotFound: "refund_not_found",
  /** The refund is not `approved`: nobody decided it, or somebody already executed it. */
  refundNotExecutable: "refund_not_executable",
  /** The payment the refund belongs to is gone. */
  paymentNotFound: "payment_not_found",
  /** `payment_providers` has no row for the payment's provider, or this build cannot read it. */
  providerNotFound: "refund_provider_not_found",
  /** The provider took this payment but this build has no refund path for it yet. */
  providerUnsupported: "refund_provider_unsupported",
  /** The payment row carries no provider transaction to refund against. */
  referenceMissing: "refund_provider_reference_missing",
  /** The amount is not a whole number of the provider's minor units. */
  amountUnrepresentable: "refund_amount_unrepresentable",
  /** The provider's own API refused the request before it was sent: a defect, not a decline. */
  providerRefused: "refund_provider_refused",
  /** No usable key for the provider and mode the payment was taken in. */
  credentialMissing: "refund_provider_key_missing",
  /** The row moved between this caller's read and its write. */
  refundMoved: "refund_moved",
} as const);

/** The six audit actions of this STEP, one per thing that can happen to an approved refund. */
export const REFUND_PROCESSING_AUDIT_ACTION = "refund.processing";
export const REFUND_SUCCEEDED_AUDIT_ACTION = "refund.succeeded";
export const REFUND_FAILED_AUDIT_ACTION = "refund.failed";
export const REFUND_PROVIDER_PENDING_AUDIT_ACTION = "refund.provider_pending";
export const REFUND_PROVIDER_UNANSWERED_AUDIT_ACTION = "refund.provider_unanswered";
export const REFUND_EXECUTION_REFUSED_AUDIT_ACTION = "refund.execution_refused";

/**
 * The amount as the card networks write it: hundredths, never a float.
 *
 * The platform's minor unit is a ten-thousandth, so an amount is representable exactly when it is a whole
 * number of cents. `null` is the honest answer for the rest, and the service refuses with
 * `refund_amount_unrepresentable` rather than rounding somebody's money.
 */
export function providerAmountOf(amountMinor: bigint): string | null {
  if (amountMinor <= 0n || amountMinor % 100n !== 0n) {
    return null;
  }

  const hundredths = amountMinor / 100n;
  const whole = hundredths / 100n;
  const cents = hundredths % 100n;

  return `${whole.toString()}.${cents.toString().padStart(2, "0")}`;
}

/** True when an outcome means "the provider was asked and the money is on its way". */
export function isSettledOutcome(kind: RefundProviderOutcomeKind): boolean {
  return kind === "succeeded";
}

/** A provider's message, cut to what `refunds_failure_check` allows and never empty. */
export function failureDetailOf(message: string, fallback: string): string {
  const trimmed = message.trim();
  const chosen = trimmed.length === 0 ? fallback : trimmed;

  return chosen.length <= REFUND_DETAIL_MAXIMUM_LENGTH
    ? chosen
    : `${chosen.slice(0, REFUND_DETAIL_MAXIMUM_LENGTH - 1)}…`;
}

/** A refusal about an execution, in the shape every screen already reads. */
export function refundExecutionRefused(rule: string, code: "CONFLICT" | "SERVICE_UNAVAILABLE" | "VALIDATION_FAILED"): AppError {
  return new AppError(
    code,
    { details: [{ field: "refund", rule }] },
  );
}

/** No such refund, or a refund this caller may not see. */
export function refundExecutionNotFound(): AppError {
  return new AppError("RESOURCE_NOT_FOUND", {
    details: [{ field: "refund", rule: REFUND_EXECUTION_RULES.refundNotFound }],
  });
}
