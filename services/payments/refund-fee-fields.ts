// path: services/payments/refund-fee-fields.ts
import { createHash } from "node:crypto";
import { AppError } from "../../lib/errors/app-error.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";

/**
 * The vocabulary of STEP 193: the platform fee on a refund, and the switch that decides it.
 *
 * ## The sentence this STEP applies
 *
 * Section 18: "whether the platform fee is returned on a refund is set by super_admin." Section 10 says the
 * fee is a percentage of every transaction which the platform keeps when the payment is captured, and section
 * 11 says the ledger covers a refund. A refund therefore raises a question the refund itself does not answer:
 * the money goes back to the payer, and the fee the platform took on that money - does it go back to the
 * merchant, or stay with the platform? One person answers it for the whole platform, once, in a setting.
 *
 * ## Why "how much" is a proportion and not the whole fee
 *
 * A payment can be refunded in parts. Returning the whole fee on a partial refund would hand back the fee on
 * money the merchant still keeps, and returning nothing until the payment is fully refunded would mean a
 * merchant who refunds 99% of a payment gets nothing back. So the return is the same proportion of the fee as
 * the refund is of the payment - `floor(fee * refund / payment)` - and the refund that completes the payment
 * takes the remainder rather than its own share, because rounding down on each part would otherwise leave a
 * fee's worth of dust the platform kept from a merchant who refunded everything. Two properties follow, and
 * both are what a person would expect: no part ever returns more than its proportion, and a payment refunded
 * in full returns the fee in full, exactly.
 *
 * ## Why the answer is three states and two columns cannot hold them
 *
 * The rule has three answers, and the two columns `0038` built can hold only the first:
 *
 *   - the fee came back: `platform_fee_returned` true and a positive `platform_fee_returned_minor`;
 *   - the rule was open and there was nothing to return: a payment whose fee is zero, or a part whose share
 *     rounds to zero;
 *   - the rule was closed: the platform keeps its fee, deliberately.
 *
 * The last two both read as `false / 0`, which is also what a refund nobody has asked about reads as. So
 * `0123` adds `platform_fee_settled_at` - when the rule was applied - and a null there is the only state that
 * means "not answered yet". The sweep looks for those nulls, a repeat pass cannot apply the rule twice, and a
 * super administrator who opens the switch later does not retroactively reopen every refund the platform
 * already settled under the old answer.
 *
 * ## What this file is not
 *
 * It is not the reading of the switch, the writing of the row, the posting of the ledger group, the API route
 * or the screen; `refund-fee.ts` is those. It is not the fee itself either - the fee a payment carried is
 * `payments.platform_fee_minor`, computed when the payment was captured (STEP 135 owns that calculation), and
 * this file only decides how much of it goes back.
 */

/** The `platform_settings.setting_key` of the section 18 switch. */
export const REFUND_FEE_RULE_KEY = "refunds.platform_fee_returned";

/**
 * What a fresh deployment does, and the only answer a missing row can mean.
 *
 * Seeded closed by `0123` for the reason the file gives: returning money the platform never decided to return
 * is worse than keeping money an operator forgot to hand back, because the first is silent and the second shows
 * up in the queue. A missing row reads the same way, so a rollback leaves the platform on the safe side.
 */
export const REFUND_FEE_RULE_DEFAULT = false;

/** The one status a refund must be in for the rule to apply: the money went back. */
export const REFUND_FEE_SETTLED_STATUS = "succeeded";

/**
 * Why the rule produced no return, or why it was not applied.
 *
 * Two of these are the rule's own answers (`rule_closed`, `fee_zero`, `share_zero`, `fee_exhausted`) and mean
 * "the question was asked and the answer is nothing"; the rest mean the question was not asked of this row.
 * A screen prints one sentence per code, and none of them is a status a refund is left in.
 */
export const REFUND_FEE_RULES = deepFreeze({
  /** The switch is closed: the platform keeps its fee. */
  ruleClosed: "refund_fee_rule_closed",
  /** The payment carried no fee, so there is nothing to return. */
  feeZero: "refund_fee_zero",
  /** This part's proportion of the fee rounds to zero minor units. */
  shareZero: "refund_fee_share_zero",
  /** Earlier refunds of the same payment already returned the whole fee. */
  feeExhausted: "refund_fee_exhausted",
  /** A payment amount of zero, which the schema refuses: a defect, not a rule. */
  paymentInvalid: "refund_fee_payment_invalid",
  /** The refund is not `succeeded`, so no money went back and no fee can. */
  refundNotSettled: "refund_not_succeeded",
  /** The rule was already applied to this refund. */
  alreadySettled: "refund_fee_already_settled",
  /** The provider's fee return could not be posted, so nothing was written and the sweep may try again. */
  ledgerRefused: "refund_fee_ledger_refused",
  /** No such refund. */
  refundNotFound: "refund_not_found",
  /** The payment the refund belongs to is gone. */
  paymentNotFound: "payment_not_found",
  /** The row moved between this caller's read and its write. */
  refundMoved: "refund_moved",
} as const);

/** The three audit actions: the rule, its two answers, and the change to the switch itself. */
export const REFUND_FEE_RETURNED_AUDIT_ACTION = "refund.fee_returned";
export const REFUND_FEE_RETAINED_AUDIT_ACTION = "refund.fee_retained";
export const REFUND_FEE_RULE_UPDATED_AUDIT_ACTION = "refund.fee_rule_updated";

/** Every audit name this STEP writes, so the gate can walk them. */
export const REFUND_FEE_AUDIT_ACTIONS: readonly string[] = deepFreeze([
  REFUND_FEE_RETURNED_AUDIT_ACTION,
  REFUND_FEE_RETAINED_AUDIT_ACTION,
  REFUND_FEE_RULE_UPDATED_AUDIT_ACTION,
]);

/** How many refunds one sweep applies the rule to, so one pass is bounded work. */
export const REFUND_FEE_SWEEP_LIMIT = 50;

/** How many unsettled refunds the screen counts before it says "at least". */
export const REFUND_FEE_BACKLOG_LIMIT = 100;

/** The body a save or a sweep carries: a boolean, an optional instant, a CSRF header. */
export const REFUND_FEE_MAXIMUM_BODY_BYTES = 512;

/**
 * The platform's share of the fee for one part of a payment, rounded down.
 *
 * Integer arithmetic throughout: the platform counts money in ten-thousandths and a float would lose one.
 * A caller passes numbers the database already guarantees (`refund <= payment`, `fee >= 0`), and the two
 * defensive branches return zero rather than a fractional answer.
 */
export function feeShareOf(feeMinor: bigint, refundMinor: bigint, paymentMinor: bigint): bigint {
  if (feeMinor <= 0n || refundMinor <= 0n || paymentMinor <= 0n) {
    return 0n;
  }

  return (feeMinor * refundMinor) / paymentMinor;
}

/** What one refund's fee return would be, and why it is nothing when it is nothing. */
export interface FeeReturnPlan {
  /** How much of the fee goes back, in minor units: zero when the rule returns nothing. */
  readonly returnMinor: bigint;
  /** The fee the payment carried. */
  readonly feeMinor: bigint;
  /** What earlier refunds of the same payment already returned. */
  readonly alreadyReturnedMinor: bigint;
  /** What is left of the fee for this and any later refund. */
  readonly remainingMinor: bigint;
  /** True when this refund completes the payment, which is when the remainder goes back. */
  readonly completes: boolean;
  /** Why nothing is returned, or null when something is. */
  readonly rule: string | null;
}

/**
 * The whole calculation, as one function, so the service and the gate cannot disagree.
 *
 * `refundedMinor` is the payment's own total (`payments.refunded_minor`), which `refunds_sync_payment` writes
 * the instant a refund becomes `succeeded`. Reading it rather than summing the sibling rows is deliberate: it
 * is the database's number, written by the trigger that owns it, and it already includes this refund.
 */
export function feeReturnPlanOf(input: {
  readonly feeMinor: bigint;
  readonly paymentMinor: bigint;
  readonly refundedMinor: bigint;
  readonly refundMinor: bigint;
  readonly alreadyReturnedMinor: bigint;
}): FeeReturnPlan {
  const remaining = input.feeMinor - input.alreadyReturnedMinor;
  const completes = input.paymentMinor > 0n && input.refundedMinor >= input.paymentMinor;
  const base = {
    feeMinor: input.feeMinor,
    alreadyReturnedMinor: input.alreadyReturnedMinor,
    remainingMinor: remaining > 0n ? remaining : 0n,
    completes,
  };

  if (input.paymentMinor <= 0n) {
    return { ...base, returnMinor: 0n, rule: REFUND_FEE_RULES.paymentInvalid };
  }

  if (input.feeMinor <= 0n) {
    return { ...base, returnMinor: 0n, rule: REFUND_FEE_RULES.feeZero };
  }

  if (remaining <= 0n) {
    return { ...base, returnMinor: 0n, rule: REFUND_FEE_RULES.feeExhausted };
  }

  const share = feeShareOf(input.feeMinor, input.refundMinor, input.paymentMinor);
  const wanted = completes ? remaining : share < remaining ? share : remaining;

  if (wanted <= 0n) {
    return { ...base, returnMinor: 0n, rule: REFUND_FEE_RULES.shareZero };
  }

  return { ...base, returnMinor: wanted, rule: null };
}

/**
 * The ledger group a fee return posts, derived from the refund rather than drawn at random.
 *
 * The group is written before the refund row says the fee came back, because the ledger is the money and the
 * row is the record of it. A process that dies between the two leaves a group nobody has recorded; the next
 * pass derives the *same* group id, `postLedgerEntries` refuses to post a group that exists, and the pass reads
 * the posted amount back from the ledger and writes it. A random id would post a second group instead, which
 * is a merchant paid twice - the exact failure a deterministic id makes impossible.
 *
 * The shape is a version 5 UUID built from a SHA-256 digest: 8-4-4-4-12 hex, the version nibble 5, the variant
 * nibble 8 to b. No database function is involved, so the same refund id in any process yields the same group.
 */
export function feeReturnGroupIdOf(refundId: string): string {
  const hex = createHash("sha256").update(`refund_fee_return:${refundId}`, "utf8").digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/** True when a UUID is the shape `feeReturnGroupIdOf` produces, so the gate can hold the two together. */
export function isFeeReturnGroupId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

/** A refusal about the rule, in the shape every screen already reads. */
export function refundFeeRefused(
  rule: string,
  code: "CONFLICT" | "PERMISSION_DENIED" | "SERVICE_UNAVAILABLE" | "VALIDATION_FAILED",
): AppError {
  return new AppError(code, { details: [{ field: "refund", rule }] });
}

/** No such refund, or a refund this caller may not see. */
export function refundFeeNotFound(): AppError {
  return new AppError("RESOURCE_NOT_FOUND", {
    details: [{ field: "refund", rule: REFUND_FEE_RULES.refundNotFound }],
  });
}
