// path: app/(client-portal)/portal-part-payment.ts
import { AppError } from "../../lib/errors/app-error.ts";
import { priceToMinor } from "../../services/products/price.ts";
import { portalMoneyTextOf } from "./portal-invoice-money.ts";
import type { PortalInvoiceView } from "./portal-invoice.ts";
import { portalPaymentChargeAmountOf } from "./portal-payment-fields.ts";
import {
  PORTAL_PART_PAYMENT_FIELD,
  PORTAL_PART_PAYMENT_INPUT_MAXIMUM_LENGTH,
  PORTAL_PART_PAYMENT_RULES,
  PORTAL_PART_PAYMENT_UNREPRESENTABLE_RULE,
  portalPartPaymentNoneOf,
  portalPartPaymentTextOf,
  type PortalPartPaymentAmount,
  type PortalPartPaymentLimits,
} from "./portal-part-payment-fields.ts";
import { PORTAL_PAYMENT_CARD_NUMBER_PATTERN, PORTAL_PAYMENT_RULES } from "./portal-payment-fields.ts";

/**
 * Part payment on the invoice link, limited to the remaining amount.
 *
 * ## One rule, three places, and the reason it is written once
 *
 * The amount a payer picks is decided in exactly one function (`portalPartPaymentAmountOf`), and every path
 * that charges - the plain card charge, the 3D Secure start, the 3D Secure completion - goes through it. A page
 * that resolved the amount in three places would be a page where one of the three eventually forgot the
 * ceiling, and the ceiling is the sentence section 18 states: a partly paid link accepts only the remaining.
 *
 * ## What "remaining" means here
 *
 * `view.payment.amountMinor` is the document's own remaining due, read in this request: total minus what is
 * already paid. It is the ceiling, it is read rather than requested, and a browser that sends a larger number
 * is refused rather than clamped - a payer who is told "this link accepts 100.00" and is charged 100.00 knows
 * what happened, while one silently charged a different number does not.
 *
 * ## The floor, and the payment that is not a partial
 *
 * Section 16's twenty dollar floor is a floor on *partial* payments: a payment that leaves the document open
 * is one, and a payment that settles it is not. So a forty dollar remainder may be paid as twenty, and a
 * fifteen dollar remainder may only be paid whole. `view.payment.minimumMinor` already carries that folding
 * (STEP 181 does it, in one function the invoice page prints too), so this module reads it rather than
 * recomputing a floor of its own.
 *
 * ## Why the amount arrives as text
 *
 * Because the payer types it. `priceToMinor` is the platform's one parser for typed money - decimal string
 * arithmetic, no float, and `1e3`, `12,50` and a fifth decimal refused rather than coerced - so the amount a
 * browser sends is held to the same rules as a catalogue price and a merchant's recorded payment.
 */

/** The refusal an amount produces: one field, one rule, and never the value that produced it. */
function refused(rule: string): AppError {
  return new AppError("VALIDATION_FAILED", { details: [{ field: PORTAL_PART_PAYMENT_FIELD, rule }] });
}

/** The amount field, taken out of a body so STEP 183's strict parser still sees the body it knows. */
export function splitPortalPartPaymentAmountField(body: unknown): {
  readonly amount: string | null;
  readonly rest: unknown;
} {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { amount: null, rest: body };
  }

  const record = body as Record<string, unknown>;

  if (!Object.hasOwn(record, PORTAL_PART_PAYMENT_FIELD)) {
    return { amount: null, rest: body };
  }

  const value = record[PORTAL_PART_PAYMENT_FIELD];
  const rest: Record<string, unknown> = { ...record };

  delete rest[PORTAL_PART_PAYMENT_FIELD];

  if (typeof value !== "string") {
    // A number is not money: JSON `50.1` is a float before this platform ever sees it, and the one form money
    // is accepted in is the text a person typed.
    throw refused(PORTAL_PART_PAYMENT_RULES.invalidFormat);
  }

  const text = value.trim();

  if (text.length > PORTAL_PART_PAYMENT_INPUT_MAXIMUM_LENGTH) {
    throw refused(PORTAL_PART_PAYMENT_RULES.invalidFormat);
  }

  if (PORTAL_PAYMENT_CARD_NUMBER_PATTERN.test(text)) {
    // A card number typed into the amount box is card data on a page that never accepts it. It is refused by
    // the rule that refuses one anywhere else in a payment body, and it is never parsed as an amount.
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: PORTAL_PART_PAYMENT_FIELD, rule: PORTAL_PAYMENT_RULES.cardDataRefused }],
    });
  }

  return { amount: text, rest };
}

/** What this document will take, in the numbers the page prints and the form offers. */
export function portalPartPaymentLimitsOf(view: PortalInvoiceView): PortalPartPaymentLimits {
  if (!view.payment.open || view.payment.amountMinor === null) {
    return portalPartPaymentNoneOf(view.currency);
  }

  const remaining = BigInt(view.payment.amountMinor);
  const minimum = view.payment.minimumMinor;
  const minimumMinor = minimum === null ? null : BigInt(minimum);

  return {
    remainingMinor: remaining.toString(),
    minimumMinor: minimum,
    // A choice exists only when something smaller than the whole remainder is still a legal payment.
    allowPartial: minimumMinor !== null && minimumMinor < remaining,
    remainingText: portalMoneyTextOf(view.currency, remaining.toString()),
    minimumText: minimum === null ? null : portalMoneyTextOf(view.currency, minimum),
    currency: view.currency,
  };
}

/**
 * The amount this attempt will charge, or the refusal that says why it may not.
 *
 * An absent amount is the whole remainder, which is what every caller before this STEP sent and what a payer
 * who does not touch the field is choosing. Everything else is held to the ceiling, the floor, the parser and
 * the provider's cents, in that order - the order a payer can act on: "too much", "too little to be a part",
 * "not an amount", "not a number of cents".
 */
export function portalPartPaymentAmountOf(input: {
  readonly requested: string | null;
  readonly view: PortalInvoiceView;
}): PortalPartPaymentAmount {
  if (!input.view.payment.open || input.view.payment.amountMinor === null) {
    throw new AppError("CONFLICT", {
      details: [{ field: "payment", rule: PORTAL_PAYMENT_RULES.notPayable }],
    });
  }

  const remaining = BigInt(input.view.payment.amountMinor);
  let chosen = remaining;
  let chosenByPayer = false;

  if (input.requested !== null) {
    chosenByPayer = true;
    const text = input.requested.trim();

    if (text.length === 0) {
      throw refused(PORTAL_PART_PAYMENT_RULES.invalidFormat);
    }

    const parsed = priceToMinor(text);

    if (parsed === null) {
      throw refused(PORTAL_PART_PAYMENT_RULES.invalidFormat);
    }

    if (parsed <= 0n) {
      throw refused(PORTAL_PART_PAYMENT_RULES.zeroAmount);
    }

    if (parsed > remaining) {
      throw refused(PORTAL_PART_PAYMENT_RULES.exceedsRemaining);
    }

    const minimum = input.view.payment.minimumMinor;

    if (parsed < remaining && (minimum === null || parsed < BigInt(minimum))) {
      // The payment leaves the document open, so it is a partial payment and section 16's floor applies. A
      // remainder at or below the floor folds into the remainder itself (STEP 181), which is why this branch
      // also refuses a smaller-than-the-remainder payment when the remainder is tiny: the only legal amount
      // left is the whole of it. A currency with no floor at all (`minimumMinor === null`) offers no part
      // payment either, because section 16's floor is written for the platform's currency and a partial with no
      // floor is a payment this page cannot hold to any rule.
      throw refused(PORTAL_PART_PAYMENT_RULES.belowMinimum);
    }

    chosen = parsed;
  }

  const chargeAmount = portalPaymentChargeAmountOf(chosen.toString());

  if (chargeAmount === null) {
    // The platform holds four decimals and the provider takes two: an amount with a sub-cent part cannot be
    // charged exactly, and rounding it would be the platform charging a number the invoice does not say.
    //
    // Whose number it is decides who is told what: a document whose own remainder cannot be written is a
    // conflict with the document (`CONFLICT`, STEP 183's answer, unchanged for every caller that sends no
    // amount), while a payer's own chosen amount is a value the payer can fix (`VALIDATION_FAILED`).
    throw chosenByPayer
      ? refused(PORTAL_PART_PAYMENT_UNREPRESENTABLE_RULE)
      : new AppError("CONFLICT", {
          details: [{ field: "payment", rule: PORTAL_PART_PAYMENT_UNREPRESENTABLE_RULE }],
        });
  }

  return {
    amountMinor: chosen.toString(),
    chargeAmount,
    amountText: portalMoneyTextOf(input.view.currency, chosen.toString()),
    partial: chosen < remaining,
    remainingAfterMinor: (remaining - chosen).toString(),
  };
}

/**
 * True when a chosen amount that was legal at the start can no longer be taken.
 *
 * This is the 3D Secure step's question, and it is not the same question as "did the document change": a payer
 * at their bank for two minutes may return to an invoice that took another payment, and the chosen amount is
 * still payable as long as the document still owes at least that much. What it cannot survive is a remaining
 * that fell below it - the money has moved, and charging it would take more than the document says.
 */
export function portalPartPaymentMovedOf(input: {
  readonly chosenMinor: string;
  readonly view: PortalInvoiceView;
}): boolean {
  if (!input.view.payment.open || input.view.payment.amountMinor === null) {
    return true;
  }

  return BigInt(input.chosenMinor) > BigInt(input.view.payment.amountMinor);
}

/** The text a chosen amount travels back in, for a step that has to re-post the body it holds. */
export function portalPartPaymentRequestBodyOf(chosenMinor: string): string {
  return portalPartPaymentTextOf(chosenMinor);
}
