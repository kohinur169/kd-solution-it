// path: app/(client-portal)/portal-part-payment-fields.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { priceFromMinor } from "../../services/products/price.ts";
import { portalMoneyTextOf } from "./portal-invoice-money.ts";

/**
 * The vocabulary of part payment on an invoice link: a payer may pay less than the remainder, never more.
 *
 * ## The two sentences this module keeps
 *
 * FEATURE_LIST section 18, last line: "A partly paid invoice link accepts only the remaining amount." So the
 * document's **remaining** is the ceiling - not the total, not a number a browser sent - and STEP 124's
 * merchant-side service answers an overpayment with `exceeds_remaining` for the same reason.
 *
 * Section 16's partial-payment floor (`money.minimumPartialPayment`, twenty dollars) is the second: a payment
 * that leaves the document open is a partial payment and is held to it; the payment that settles the document
 * is not a partial and is taken at whatever the remainder is, however small. That exception is what makes a
 * nine dollar remainder payable at all.
 *
 * ## Where the rules are spelled, and why they are spelled here
 *
 * `below_minimum`, `exceeds_remaining` and `invalid_format` are STEP 124's words, and this module repeats
 * them rather than importing them, because `services/invoices/invoice-status.ts` reaches the REST client and
 * the audit trail and this module is read by a **client** component (the amount field on the card form). The
 * gate asserts the two spellings are one string, so a rename in the service is a failing gate rather than a
 * page that refuses with a word nobody maps to a sentence.
 *
 * ## What lives elsewhere
 *
 * The arithmetic: `portalPartPaymentAmountOf` and `portalPartPaymentLimitsOf` are in `portal-part-payment.ts`,
 * which is server code. This module holds the names, the shapes and the printing - the parts a browser needs
 * and nothing more.
 */

/** The body field the payer's chosen amount travels in. Not one of STEP 183's two, so it is split out first. */
export const PORTAL_PART_PAYMENT_FIELD = "amount";

/** The id of the amount input, so the label, the hint and the form agree on one field. */
export const PORTAL_PART_PAYMENT_INPUT_ID = "portal-pay-amount";

/**
 * The longest amount the field accepts.
 *
 * A platform amount is `numeric(18,4)`, so the text a payer types is at most twelve digits, a point and four
 * decimals - seventeen characters. Eighteen is that plus the point a browser may add while typing, and a body
 * past it is refused before the parser is asked rather than read.
 */
export const PORTAL_PART_PAYMENT_INPUT_MAXIMUM_LENGTH = 18;

/**
 * The rules a chosen amount is refused with.
 *
 * The two that decide the money are STEP 124's words, kept identical on purpose: the merchant recording a
 * payment and the client paying on the link are the same question about the same document, and two
 * vocabularies would be two answers to it. The gate asserts the strings are the service's own.
 *
 * The first two are the page's own names, because a sentence about **one form field** must not be a sentence
 * about something else. STEP 124 answers "not an amount" with `invalid_format`, which is also the rule a bad
 * token or a bad handle produces; the card form maps a rule to a sentence without knowing the field, so a
 * shared word would tell a payer to fix their amount when the problem was their card token.
 */
export const PORTAL_PART_PAYMENT_RULES = deepFreeze({
  /** Not an amount at all: `1e3`, `12,50`, a negative, an empty text, a fifth decimal. */
  invalidFormat: "amount_invalid",
  /** Zero is not a payment, however it is spelled. */
  zeroAmount: "amount_zero",
  /** A partial below the platform's twenty dollar floor, which section 16 refuses. STEP 124's word. */
  belowMinimum: "below_minimum",
  /** More than the document still owes, which section 18 refuses. STEP 124's word. */
  exceedsRemaining: "exceeds_remaining",
});

/** STEP 183's rule for an amount the provider's cents cannot express, borrowed so one refusal is one word. */
export const PORTAL_PART_PAYMENT_UNREPRESENTABLE_RULE = "amount_unrepresentable";

/** STEP 184's rule for a document that moved while the payer was at their bank. */
export const PORTAL_PART_PAYMENT_STALE_RULE = "stale_document";

/**
 * What this document will take, in the three numbers a payer needs.
 *
 * `remainingMinor` is the ceiling and `minimumMinor` the floor of a *partial*; when the remainder is at or
 * below the floor the only payment left is the whole remainder, which is why `allowPartial` is false there
 * and the form shows no amount to choose.
 */
export interface PortalPartPaymentLimits {
  /** The most this link accepts, in minor units, as decimal text. */
  readonly remainingMinor: string;
  /** The smallest partial payment, in minor units, or null when this currency has no floor. */
  readonly minimumMinor: string | null;
  /** True when more than one legal amount exists, so the form should offer a choice. */
  readonly allowPartial: boolean;
  /** The ceiling printed for a person: `100.0000 USD`. */
  readonly remainingText: string;
  /** The floor printed the same way, or null when there is none. */
  readonly minimumText: string | null;
  readonly currency: string;
}

/** A chosen amount, once it is legal: what will be charged, and whether it leaves the document open. */
export interface PortalPartPaymentAmount {
  /** The amount in the platform's minor units, as decimal text - what the record and the ledger hold. */
  readonly amountMinor: string;
  /** The same amount in the provider's own spelling (`50.00`), which is what the gateway is asked for. */
  readonly chargeAmount: string;
  /** The amount printed for a person. */
  readonly amountText: string;
  /** True when this payment leaves the document open, which is what makes the floor apply to it. */
  readonly partial: boolean;
  /** What the document still owes after this payment, in minor units, as decimal text. */
  readonly remainingAfterMinor: string;
}

/** The limits of a document that takes no money at all, so a refusal and a closed link read one way. */
export function portalPartPaymentNoneOf(currency: string): PortalPartPaymentLimits {
  return {
    remainingMinor: "0",
    minimumMinor: null,
    allowPartial: false,
    remainingText: portalMoneyTextOf(currency, "0"),
    minimumText: null,
    currency,
  };
}

/**
 * An amount as the text an input holds: `50.0000`.
 *
 * Four decimals rather than the provider's two, because this is the platform's own number and the payer may
 * legitimately type a fourth place - the provider's cents are checked later, and an amount that cannot be
 * charged exactly is refused rather than rounded.
 */
export function portalPartPaymentTextOf(minor: string): string {
  return priceFromMinor(BigInt(minor));
}
