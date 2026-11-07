// path: app/(client-portal)/portal-fraud-fields.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { FRAUD_FAILURE_CODE, type FraudProviderSignal } from "../../lib/security/fraud.ts";
import { NMI_RESPONSE_CODES } from "../../lib/payments/adapters/nmi-status-sync.ts";
import { PORTAL_PAYMENT_AUDIT_ENTITY } from "./portal-payment-fields.ts";
import { PORTAL_BILLING_REVIEW_OWNER } from "./portal-billing-match-fields.ts";

/**
 * The vocabulary of section 18's fraud sentence: "a provider fraud signal rejects the payment at once."
 *
 * ## What a provider fraud signal is, in this platform
 *
 * It is not a score and not a guess. The gateway answers a card charge with a `response_code`, and the
 * documentation at `https://docs.nmi.com/reference/response-codes` names four of those codes as the issuer
 * telling the merchant that the card itself is the problem:
 *
 *   - `250` Pick up card
 *   - `251` Lost card
 *   - `252` Stolen card
 *   - `253` Fraudulent card
 *
 * Those four are the signal, and nothing else is. A decline is a decline: `200` insufficient funds and `201`
 * do not honour are ordinary answers a payer can fix with another card, and treating them as fraud would refuse
 * honest customers and fill a blacklist with noise. Four more codes say the issuer wants the merchant to stop
 * and ask - `240` call issuer, `260` declined with further instructions, `261` and `262` stop the recurring
 * programme - and those are `suspicious`: worth a person's look, not worth a blacklist.
 *
 * ## Why the codes are checked against the adapter's own table
 *
 * `nmi-status-sync.ts` already carries every documented code with its description and category, transcribed
 * from the same documentation. A portal module that listed the numbers itself could one day disagree with it,
 * so the table below is asserted against that one in the gate, and the *description* travels with each code so
 * an operator reading the audit knows what the gateway actually said.
 *
 * ## What the signal does
 *
 * `fraud` - the payment is rejected at once: nothing is captured, the payment is `failed` with
 * `failure_code = 'risk_rejected'`, its `risk_decision` is `reject`, which is the only state
 * `payments_risk_reject_check` allows a rejection in, and the card is referred to the blacklist STEP 187 owns.
 * `suspicious` - nothing is captured and the payment goes to `under_review` for the desk section 18 names.
 * `clear` - the charge continues through the ordinary path, where a decline is a decline.
 */

/** The documented codes that name the card itself as the problem, in ascending order. */
export const PORTAL_FRAUD_CODES = deepFreeze(["250", "251", "252", "253"] as const);

/** The documented codes that ask the merchant to stop rather than the card being fraudulent. */
export const PORTAL_FRAUD_SUSPICIOUS_CODES = deepFreeze(["240", "260", "261", "262"] as const);

/** The four codes with the gateway's own words, so an audit entry can say what was answered. */
export const PORTAL_FRAUD_CODE_MEANINGS: Readonly<Record<string, string>> = deepFreeze(
  Object.fromEntries(
    (["250", "251", "252", "253"] as const).map((code) => [code, NMI_RESPONSE_CODES[code]?.description ?? ""]),
  ),
);

/**
 * The provider's answer, as section 18's signal.
 *
 * `declined` and `rejected` categories are otherwise ordinary failures: the platform's charge path already
 * turns them into a decline or an unknown outcome, and this function must not widen that. Only the eight codes
 * above move a payment onto the fraud path.
 */
export function portalProviderFraudSignalOf(answer: {
  readonly responseCode: string | null;
}): FraudProviderSignal {
  const code = (answer.responseCode ?? "").trim();

  if ((PORTAL_FRAUD_CODES as readonly string[]).includes(code)) {
    return "fraud";
  }

  if ((PORTAL_FRAUD_SUSPICIOUS_CODES as readonly string[]).includes(code)) {
    return "suspicious";
  }

  return "clear";
}

/**
 * The failure code a rejected payment carries.
 *
 * Borrowed from STEP 066 rather than spelled again: `risk_rejected` is the code its `fraudAuditEntry` and the
 * payments table's own bounds already use, and two spellings of it would be two answers to "was this money
 * refused for risk".
 */
export const PORTAL_FRAUD_FAILURE_CODE = FRAUD_FAILURE_CODE;

/** The values `0037_payments.sql` accepts for a rejection, named so no caller has to remember them. */
export const PORTAL_FRAUD_REJECT_DECISION = "reject";
export const PORTAL_FRAUD_REVIEW_DECISION = "review";
export const PORTAL_FRAUD_REJECTED_STATUS = "failed";
export const PORTAL_FRAUD_REVIEW_STATUS = "under_review";

/** The desk a suspicious payment goes to: section 18's own, borrowed from STEP 185. */
export const PORTAL_FRAUD_REVIEW_OWNER = PORTAL_BILLING_REVIEW_OWNER;

/** The rules this step refuses with. */
export const PORTAL_FRAUD_RULES = deepFreeze({
  /** The gateway named the card as fraudulent: the payment is refused and never retried. */
  rejected: "risk_rejected",
  /** The gateway asked the merchant to stop: nothing is captured and a person looks at it. */
  suspicious: "risk_suspicious",
  /** The card could not be referred to the blacklist, which is reported rather than hidden. */
  referralUnavailable: "card_referral_unavailable",
});

/** The audit actions of this step. */
export const PORTAL_FRAUD_REJECTED_AUDIT_ACTION = "portal.payment_rejected";
export const PORTAL_FRAUD_SUSPICIOUS_AUDIT_ACTION = "portal.payment_risk_review";
export const PORTAL_FRAUD_SIGNAL_AUDIT_ACTION = "portal.provider_signal_recorded";

/** The audit entity: a payment, whichever page it came from. */
export const PORTAL_FRAUD_AUDIT_ENTITY = PORTAL_PAYMENT_AUDIT_ENTITY;

/** What the platform decided to do with a payment the gateway flagged. */
export type PortalFraudDecision = "reject" | "review";

/**
 * The signal's decision, in one expression.
 *
 * A fraud signal rejects at once, which is the sentence; a suspicious one is held for review; a clear one is
 * not this step's business at all and answers `null`, so a caller cannot confuse "nothing to do" with "allowed".
 */
export function portalFraudDecisionOf(signal: FraudProviderSignal): PortalFraudDecision | null {
  if (signal === "fraud") {
    return "reject";
  }

  return signal === "suspicious" ? "review" : null;
}

/**
 * The payload a rejection or a review carries into the chain.
 *
 * It names the signal, the gateway's code and its documented meaning, the decision and the two values the
 * payments table would hold - and no card data, because there is none: the code is the gateway's answer about a
 * token this platform never saw the card behind.
 */
export function portalFraudPayloadOf(input: {
  readonly invoiceId: string;
  readonly paymentId: string | null;
  readonly signal: FraudProviderSignal;
  readonly decision: PortalFraudDecision;
  readonly responseCode: string | null;
  readonly amountMinor: string;
}): Record<string, unknown> {
  const code = (input.responseCode ?? "").trim();

  return {
    invoice_id: input.invoiceId,
    payment_id: input.paymentId,
    amount_minor: input.amountMinor,
    provider_signal: input.signal,
    signal_decision: input.decision,
    provider_response_code: code.length === 0 ? null : code,
    provider_response_meaning: PORTAL_FRAUD_CODE_MEANINGS[code] ?? null,
    failure_code: input.decision === "reject" ? PORTAL_FRAUD_FAILURE_CODE : null,
    risk_decision: input.decision === "reject" ? PORTAL_FRAUD_REJECT_DECISION : PORTAL_FRAUD_REVIEW_DECISION,
    status: input.decision === "reject" ? PORTAL_FRAUD_REJECTED_STATUS : PORTAL_FRAUD_REVIEW_STATUS,
    review_owner: input.decision === "review" ? PORTAL_FRAUD_REVIEW_OWNER : null,
    retry_permitted: false,
  };
}
