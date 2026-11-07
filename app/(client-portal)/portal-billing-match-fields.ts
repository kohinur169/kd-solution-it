// path: app/(client-portal)/portal-billing-match-fields.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { PORTAL_PAYMENT_AUDIT_ENTITY } from "./portal-payment-fields.ts";
import {
  PORTAL_THREE_DS_REVIEW_AUDIT_ACTION,
  PORTAL_THREE_DS_REVIEW_OWNER,
} from "./portal-three-ds-fields.ts";

/**
 * The vocabulary of section 18's middle sentence: the billing match, and what happens when it fails.
 *
 * > "When 3DS is not completed, capture happens only when billing postal code and payer IP country both match
 * > the invoice data. When either does not match, nothing is captured and the payment goes to manual review by
 * > compliance_kyc."
 *
 * Three things have to agree to keep that sentence: the shape a postal code may take before it is compared, the
 * strictness of the comparison itself, and where a payment goes when the comparison fails. STEP 184 already
 * built the capture rule these two booleans feed (`portalThreeDsCaptureDecisionOf`, which is STEP 066's
 * `threeDsVerified`) and the review path's audit action; this module names the facts that rule reads, and the
 * routing that follows from it.
 *
 * ## Comparisons are normalised, and absence is a mismatch
 *
 * A postal code is typed by a person, so `SW1A 1AA`, `sw1a1aa` and `SW1A-1AA` are the same place to the post
 * office and must be the same place to this platform. The comparison therefore strips the separators a format
 * may contain and folds case, in one place, so no caller compares two strings its own way. What it does *not*
 * do is guess: a missing postal code on either side, an unreadable one, or an IP whose country cannot be
 * resolved is a mismatch rather than a pass. Section 18's rule is a condition of capture, and a condition whose
 * unknown answer counted as true would be a rule that lets exactly the payment it was written to stop.
 *
 * ## Where the review goes
 *
 * `0037_payments.sql` already carries both halves of the destination: `status = 'under_review'` is a state a
 * payment may hold, `risk_decision = 'review'` is the decision it may carry, and the migration keeps an index
 * on the first so the compliance desk's queue is a lookup rather than a scan. The desk itself is named
 * `compliance_kyc`, which is the role section 18 gives the review to and the owner STEP 184's audit entry
 * already records. This module names the same three values, so the queue a later screen reads is the queue this
 * rule writes.
 */

/** The body field a payer's billing postal code travels in, beside the provider's token. */
export const PORTAL_BILLING_POSTAL_FIELD = "billing_postal_code";

/**
 * The longest postal code this platform will compare.
 *
 * `clients_postal_code_check` allows two to sixteen characters, so the portal accepts the same range and
 * refuses anything longer before a comparison is attempted: a field that can hold a document is a field that
 * can make the platform hash a document to learn it is not a postal code.
 */
export const PORTAL_BILLING_POSTAL_MINIMUM_LENGTH = 2;
export const PORTAL_BILLING_POSTAL_MAXIMUM_LENGTH = 16;

/**
 * The shape a postal code has before it is normalised.
 *
 * The same alphabet `clients_postal_code_check` allows - letters, digits, spaces and hyphens - because a postal
 * code the client record may hold and the portal may not accept would be a mismatch no payer could fix.
 */
export const PORTAL_BILLING_POSTAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]*[A-Za-z0-9]$/u;

/** The country code shape the platform stores: ISO 3166-1 alpha-2, upper case. */
export const PORTAL_BILLING_COUNTRY_PATTERN = /^[A-Z]{2}$/u;

/** The billing facts read from a client record. Either may be absent, and an absent one never matches. */
export interface PortalBillingFacts {
  readonly postalCode: string | null;
  readonly country: string | null;
}

/**
 * The rules this comparison refuses with.
 *
 * A mismatch is not an error a payer sees: the payment is not captured and goes to review, which is the
 * sentence section 18 wrote. The rules exist for the audit chain and for the desk, so the entry says which of
 * the two facts failed and why - an absent postal code and a wrong one are different things to a reviewer.
 */
export const PORTAL_BILLING_RULES = deepFreeze({
  /** The payer's postal code is not a postal code this platform will compare. */
  postalCodeInvalid: "billing_postal_code_invalid",
  /** The payer sent no postal code at all. */
  postalCodeAbsent: "billing_postal_code_absent",
  /** The client record holds no postal code, so nothing can match it. */
  postalCodeUnknown: "billing_postal_code_unknown",
  /** Both are postal codes and they are not the same place. */
  postalCodeMismatch: "billing_postal_code_mismatch",
  /** The cardholder's connection resolves to no country. */
  countryUnknown: "billing_country_unknown",
  /** The client record holds no country, so nothing can match it. */
  countryAbsent: "billing_country_absent",
  /** Both are countries and they are not the same one. */
  countryMismatch: "billing_country_mismatch",
  /** No resolver exists in this deployment to answer where an address is. */
  countryUnresolved: "billing_country_unresolved",
  /** Both facts matched, so capture is allowed without 3D Secure. */
  matched: "billing_matched",
  /** No queue exists in this deployment to route a review to. */
  reviewQueueUnavailable: "review_queue_unavailable",
  /** The queue exists but cannot keep what it routes, so the routing is reported rather than claimed. */
  reviewQueueNotDurable: "review_queue_not_durable",
});

/** Why one of the two facts matched or did not: a closed vocabulary for the audit and the review queue. */
export type PortalBillingReason =
  | "matched"
  | "postal_code_invalid"
  | "postal_code_absent"
  | "postal_code_unknown"
  | "postal_code_mismatch"
  | "country_unknown"
  | "country_absent"
  | "country_mismatch"
  | "country_unresolved";

/** What the comparison decided. */
export type PortalBillingDecision = "capture" | "review";

/** The comparison, with the reasons a reviewer reads. */
export interface PortalBillingMatch {
  readonly postalCodeMatched: boolean;
  readonly ipCountryMatched: boolean;
  readonly decision: PortalBillingDecision;
  readonly postalCodeReason: PortalBillingReason;
  readonly countryReason: PortalBillingReason;
}

/** The audit action a decided match writes. */
export const PORTAL_BILLING_DECIDED_AUDIT_ACTION = "portal.billing_match_decided";

/** The audit action a routed review writes, and the one a refused routing writes. */
export const PORTAL_BILLING_REVIEW_ROUTED_AUDIT_ACTION = "portal.payment_review_routed";
export const PORTAL_BILLING_REVIEW_REFUSED_AUDIT_ACTION = "portal.payment_review_refused";

/** The audit entity: the same one every payment event uses, whichever page caused it. */
export const PORTAL_BILLING_AUDIT_ENTITY = PORTAL_PAYMENT_AUDIT_ENTITY;

/** The desk section 18 names, borrowed from STEP 184 so one sentence has one owner. */
export const PORTAL_BILLING_REVIEW_OWNER = PORTAL_THREE_DS_REVIEW_OWNER;

/** The audit action STEP 184 writes when it decides to review, reused rather than duplicated. */
export const PORTAL_BILLING_REVIEW_DECIDED_AUDIT_ACTION = PORTAL_THREE_DS_REVIEW_AUDIT_ACTION;

/**
 * The two values a routed review writes into the payment, as `0037` spells them.
 *
 * `payments_status_check` accepts `under_review`; `payments_risk_check` accepts `review`; and
 * `payments_three_ds_capture_check` is satisfied by neither, which is the point - a payment in this state holds
 * no captured money.
 */
export const PORTAL_BILLING_REVIEW_STATUS = "under_review";
export const PORTAL_BILLING_REVIEW_DECISION = "review";

/**
 * A postal code as this platform compares it: trimmed, upper cased, and with the separators a format may carry
 * removed.
 *
 * `SW1A 1AA`, `sw1a1aa` and `SW1A-1AA` are one place, so they are one string here. Returns null for a value that
 * is not a postal code at all, so the comparison never runs on something that only looks like one.
 */
export function portalBillingPostalCodeKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (
    trimmed.length < PORTAL_BILLING_POSTAL_MINIMUM_LENGTH ||
    trimmed.length > PORTAL_BILLING_POSTAL_MAXIMUM_LENGTH ||
    !PORTAL_BILLING_POSTAL_PATTERN.test(trimmed)
  ) {
    return null;
  }

  const key = trimmed.toUpperCase().replace(/[ -]/gu, "");

  // A postal code made entirely of separators would normalise to nothing; the pattern already refuses one that
  // starts or ends with a separator, so this is the belt to that brace rather than a second rule.
  return key.length === 0 ? null : key;
}

/** A country code as this platform compares it: trimmed and upper cased, or null. */
export function portalBillingCountryKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const upper = value.trim().toUpperCase();

  return PORTAL_BILLING_COUNTRY_PATTERN.test(upper) ? upper : null;
}

/** The postal half of the comparison, with the reason a reviewer reads. */
function postalCodeResult(
  payerPostalCode: string | null,
  facts: PortalBillingFacts | null,
): { readonly matched: boolean; readonly reason: PortalBillingReason } {
  const payer = portalBillingPostalCodeKey(payerPostalCode);

  if (payer === null) {
    return {
      matched: false,
      reason:
        payerPostalCode === null || payerPostalCode === ""
          ? "postal_code_absent"
          : "postal_code_invalid",
    };
  }

  const invoice = portalBillingPostalCodeKey(facts?.postalCode ?? null);

  if (invoice === null) {
    return { matched: false, reason: "postal_code_unknown" };
  }

  return payer === invoice
    ? { matched: true, reason: "matched" }
    : { matched: false, reason: "postal_code_mismatch" };
}

/**
 * The country half of the comparison.
 *
 * `payerCountry` is what the resolver answered about the cardholder's address, not what the browser claimed:
 * a header is a value the client chooses, and section 18 asks where the payer *is*. `null` means the resolver
 * could not say, which is a mismatch and never a pass.
 */
function countryResult(
  payerCountry: string | null,
  facts: PortalBillingFacts | null,
): { readonly matched: boolean; readonly reason: PortalBillingReason } {
  const payer = portalBillingCountryKey(payerCountry);

  if (payer === null) {
    return { matched: false, reason: "country_unknown" };
  }

  const invoice = portalBillingCountryKey(facts?.country ?? null);

  if (invoice === null) {
    return { matched: false, reason: "country_absent" };
  }

  return payer === invoice
    ? { matched: true, reason: "matched" }
    : { matched: false, reason: "country_mismatch" };
}

/**
 * Section 18's billing match, in one place.
 *
 * Two comparisons and an `and`, which is the whole sentence: a payment may be captured without 3D Secure only
 * when the billing postal code and the payer's IP country both match the invoice. Both reasons are carried even
 * when one of them matched, because a reviewer reading "the postal code was right and the country was not" can
 * act on that, while "review" alone cannot be acted on at all.
 */
export function portalBillingMatchOf(
  input: {
    readonly payerPostalCode: string | null;
    readonly payerCountry: string | null;
    readonly facts: PortalBillingFacts | null;
  },
  options: { readonly countryResolved: boolean } = { countryResolved: true },
): PortalBillingMatch {
  const postal = postalCodeResult(input.payerPostalCode, input.facts);
  const country = options.countryResolved
    ? countryResult(input.payerCountry, input.facts)
    : { matched: false, reason: "country_unresolved" as const };

  return {
    postalCodeMatched: postal.matched,
    ipCountryMatched: country.matched,
    decision: postal.matched && country.matched ? "capture" : "review",
    postalCodeReason: postal.reason,
    countryReason: country.reason,
  };
}

/**
 * The review payload a routed payment carries.
 *
 * It names both facts and both reasons, the amount, the invoice and the desk, and it names no card detail -
 * there is none in this platform to name. The shape is what a compliance screen would read, so the queue and
 * the audit say the same thing.
 */
export function portalBillingReviewPayloadOf(
  input: {
    readonly invoiceId: string;
    readonly amountMinor: string;
    readonly paymentId: string | null;
    readonly challengeId: string | null;
    readonly match: PortalBillingMatch;
  },
): Record<string, unknown> {
  return {
    invoice_id: input.invoiceId,
    amount_minor: input.amountMinor,
    payment_id: input.paymentId,
    challenge_id: input.challengeId,
    review_owner: PORTAL_BILLING_REVIEW_OWNER,
    status: PORTAL_BILLING_REVIEW_STATUS,
    risk_decision: PORTAL_BILLING_REVIEW_DECISION,
    postal_code_matched: input.match.postalCodeMatched,
    ip_country_matched: input.match.ipCountryMatched,
    postal_code_reason: input.match.postalCodeReason,
    country_reason: input.match.countryReason,
    captured: false,
  };
}
