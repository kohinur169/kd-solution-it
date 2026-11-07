// path: app/(client-portal)/portal-payment-fields.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { COLLECT_JS_SCRIPT_URL } from "../../lib/payments/adapters/nmi-collectjs.ts";
import {
  PORTAL_INVOICE_TOKEN_CAPABILITY,
  PORTAL_INVOICE_TOKEN_KIND,
} from "./portal-invoice-fields.ts";

/**
 * The vocabulary of the payment page, in one place.
 *
 * STEP 183 owns the page that takes card details - and the rule the whole page exists to keep: section 18's
 * "card number, expiry and CVV are entered only inside the provider hosted secure fields. Platform code and
 * servers never read, store or track card data or keystrokes."
 *
 * ## Why this module exists at all
 *
 * The page, its one write and its gate have to agree on a dozen small facts: which body is acceptable, which
 * keys must never appear in one, how many attempts an address gets, what an amount looks like when it is
 * handed to the provider, which audit actions record what. A number remembered in two places is a number
 * that one day disagrees, so every one of them is here and the other files import it.
 *
 * ## What it borrows rather than restates
 *
 * The link's own kind and capability come from STEP 181's module, because a payment page and an invoice page
 * are two views of one credential and a second copy of `"pay"` would be a second answer to "what may this
 * link do". The Collect.js script URL comes from STEP 149's adapter, which is the one place that knows the
 * provider's address: a page that hard coded it would be a page that kept working after the provider moved.
 */

/** The path a payment page lives under, after the link. `i/[token]` + this = the page. */
export const PORTAL_PAYMENT_PATH = "/pay";

/** The token kind and capability a payment page requires, borrowed from the invoice page's own. */
export const PORTAL_PAYMENT_TOKEN_KIND = PORTAL_INVOICE_TOKEN_KIND;
export const PORTAL_PAYMENT_TOKEN_CAPABILITY = PORTAL_INVOICE_TOKEN_CAPABILITY;

/** The provider whose hosted fields this page embeds. STEP 149's adapter is the only one with hosted fields. */
export const PORTAL_PAYMENT_PROVIDER = "nmi";

/** The provider's own script, re-exported so no file in this STEP spells the URL itself. */
export const PORTAL_PAYMENT_SCRIPT_URL = COLLECT_JS_SCRIPT_URL;

/**
 * The one payment method this page takes.
 *
 * `payments.payment_method` holds `card`, `bank_transfer` or `e_wallet`. Hosted card fields take a card;
 * the other two are STEP 190's hosted checkout and the bank transfer flow, which is why this page names one
 * method rather than offering three it cannot collect.
 */
export const PORTAL_PAYMENT_METHOD = "card";

/** The capability a card charge asks the routing engine for: `acceptance`, the money-in capability. */
export const PORTAL_PAYMENT_CAPABILITY = "acceptance";

/**
 * The body a payment page accepts: a token and an idempotency key.
 *
 * Nothing else, and the emptiness is the feature. There is no field for a card number, an expiry, a CVV or a
 * holder name, so a body carrying one is refused rather than quietly ignored - and the refusal is the
 * evidence that the platform never took the data.
 */
export const PORTAL_PAYMENT_BODY_FIELDS = deepFreeze(["collectjs_token", "idempotency_key"] as const);

/**
 * The keys that must never appear in a payment body, in the spellings a form or a script might use.
 *
 * A refusal list rather than a mention: if a body carries any of these, the platform was handed card data,
 * and the only safe answer is to refuse the request, audit the fact and tell the client to reload. Matching
 * is done on the key name of an object at any depth, lower cased and stripped of underscores and hyphens, so
 * `card-number`, `card_number`, `CardNumber` and `cardnumber` are one key here.
 */
export const PORTAL_PAYMENT_FORBIDDEN_KEYS = deepFreeze([
  "cardnumber",
  "cardno",
  "cardnum",
  "ccnumber",
  "pan",
  "primaryaccountnumber",
  "cvv",
  "cvv2",
  "cvc",
  "cvc2",
  "cid",
  "securitycode",
  "expiry",
  "expirymonth",
  "expiryyear",
  "expdate",
  "cardexpiry",
  "cardholder",
  "cardholdername",
  "holder",
  "accountnumber",
  "routingnumber",
  "iban",
  "trackdata",
  "magstripe",
  "pin",
] as const);

/**
 * The shape a Collect.js token has, checked before the provider's own validator sees it.
 *
 * STEP 149's `validateCollectJsToken` accepts letters, digits, underscores and hyphens, which means it also
 * accepts a string of sixteen digits - a card number somebody pasted into the wrong box. This pattern refuses
 * a digit run that long, so a PAN can never reach the provider as if it were a token, and the page can tell
 * the client what went wrong without ever echoing the value.
 */
export const PORTAL_PAYMENT_CARD_NUMBER_PATTERN = /^[0-9][0-9 ]{11,21}[0-9]$/u;

/** The longest token this page will look at, so a body cannot carry a document where a token belongs. */
export const PORTAL_PAYMENT_TOKEN_MAXIMUM_LENGTH = 256;

/** The body ceiling, in bytes. Two short strings and their JSON punctuation. */
export const PORTAL_PAYMENT_MAXIMUM_BODY_BYTES = 2_048;

/**
 * The counter a payment page spends, per address.
 *
 * Five attempts per ten minutes. A client who mistypes a card is told by the provider's own fields before a
 * request is ever made, so five covers a retry after a decline, a reload and a second browser - and it stops
 * a script that holds a link from testing stolen cards through this page. It is counted apart from the
 * invoice confirmation and the estimate signature, because the three answer different questions.
 */
export const PORTAL_PAYMENT_RATE_LIMIT = deepFreeze({
  scope: "portal_payment",
  limit: 5,
  windowSeconds: 600,
});

/**
 * The rules this page refuses with.
 *
 * Each is the `rule` of an `AppError` detail, so a screen maps one word to one sentence. They are not error
 * codes: a payment that cannot be taken is a `CONFLICT` or a `VALIDATION_FAILED`, and the code already says
 * which; the rule says which refusal, because "this invoice was already paid" and "this browser is signed in
 * to the account that sent the invoice" are different things to tell a payer.
 */
export const PORTAL_PAYMENT_RULES = deepFreeze({
  /** The link is not open for payment: a draft, a cancelled invoice, or one already settled. */
  notPayable: "not_payable",
  /** The invoice was cancelled, which the page says in its own words rather than as a generic refusal. */
  invoiceVoid: "invoice_void",
  /** The invoice is a working copy with no number. */
  notIssued: "not_issued",
  /** A session belonging to the invoice's own company tried to pay it. */
  selfPayment: "self_payment",
  /** The body carried a card field, which this platform never accepts. */
  cardDataRefused: "card_data_refused",
  /** The token is empty, too long, oddly shaped or looks like a card number. */
  invalidToken: "invalid_token",
  /** No provider is configured for this company, so there is nothing to charge through. */
  providerUnavailable: "provider_unavailable",
  /** The platform can create a payment but cannot yet record it durably, so it must not charge. */
  recorderUnavailable: "recorder_unavailable",
  /** The provider's answer was ambiguous: the outcome is unknown and must be reconciled, never retried. */
  outcomeUnknown: "outcome_unknown",
  /** The amount cannot be written as the dollars and cents the provider takes. */
  amountUnrepresentable: "amount_unrepresentable",
  /** The invoice moved between the page's read and the charge. */
  staleDocument: "stale_document",
});

/** The order a refusal lists its fields in. */
export const PORTAL_PAYMENT_FIELD_ORDER = deepFreeze(["collectjs_token", "idempotency_key"] as const);

/** The audit actions of this page, one per outcome a payer can produce. */
export const PORTAL_PAYMENT_CAPTURED_AUDIT_ACTION = "portal.payment_captured";
export const PORTAL_PAYMENT_DECLINED_AUDIT_ACTION = "portal.payment_declined";
export const PORTAL_PAYMENT_UNKNOWN_AUDIT_ACTION = "portal.payment_unknown";
export const PORTAL_PAYMENT_REFUSED_AUDIT_ACTION = "portal.payment_refused";

/** The audit entity, so a chain can be read by subject: a payment is a payment, whichever page made it. */
export const PORTAL_PAYMENT_AUDIT_ENTITY = "payment";

/** The scale the platform keeps money at, and the scale the provider takes it at. */
const PLATFORM_MINOR_PER_UNIT = 10_000n;
const PROVIDER_MINOR_PER_UNIT = 100n;

/**
 * An amount as the provider's own text: dollars and cents, exactly two decimals.
 *
 * The platform holds money at four decimals of a dollar in minor units (`1000000` is one hundred), and NMI's
 * API takes `100.00`. The conversion is therefore a division by a hundred with the remainder checked rather
 * than rounded: an amount with a sub-cent part cannot be charged exactly, and silently sending the rounded
 * figure would be the platform charging a number the invoice does not say. `null` is that refusal.
 */
export function portalPaymentChargeAmountOf(minorUnits: string): string | null {
  let minor: bigint;

  try {
    minor = BigInt(minorUnits);
  } catch {
    return null;
  }

  if (minor <= 0n) {
    return null;
  }

  const cents = minor / PROVIDER_MINOR_PER_UNIT;

  if (cents * PROVIDER_MINOR_PER_UNIT !== minor) {
    return null;
  }

  const dollars = cents / PROVIDER_MINOR_PER_UNIT;
  const remainder = cents % PROVIDER_MINOR_PER_UNIT;

  if (dollars * PLATFORM_MINOR_PER_UNIT + remainder * 100n !== minor) {
    return null;
  }

  return `${dollars.toString()}.${remainder.toString().padStart(2, "0")}`;
}
