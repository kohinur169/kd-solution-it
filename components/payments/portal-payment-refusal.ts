// path: components/payments/portal-payment-refusal.ts
import { getMessage } from "../../lib/i18n/messages.ts";

/**
 * The sentence each payment refusal becomes, for the card form and the payment page.
 *
 * The shared portal vocabulary in `portal-form-refusal.ts` already words every rule the portal forms have in
 * common. A card payment adds the ones only it can produce - a declined card, a spent token, a gateway that
 * is not connected yet, an outcome the provider never answered - and they live here so the form (which reads
 * a refusal out of an HTTP answer) and the page (which meets the same refusal as a thrown error before it
 * renders) cannot describe one rule two different ways.
 *
 * A rule this module does not know is not a sentence: the caller falls back to its own, because a rule
 * invented by a later STEP must not be silently described as something it is not.
 */

/** The sentence for one payment rule, or null when this module does not know it. */
export function portalPaymentRuleTextOf(rule: string): string | null {
  switch (rule) {
    case "not_payable":
      return getMessage("portal.paymentRuleNotPayable");
    case "invoice_void":
      return getMessage("portal.paymentRuleInvoiceVoid");
    case "not_issued":
      return getMessage("portal.paymentRuleNotIssued");
    case "self_payment":
      return getMessage("portal.paymentRuleSelfPayment");
    case "card_data_refused":
      return getMessage("portal.paymentRuleCardDataRefused");
    case "invalid_token":
      return getMessage("portal.paymentRuleInvalidToken");
    case "card_declined":
      return getMessage("portal.paymentRuleCardDeclined");
    case "provider_unavailable":
      return getMessage("portal.paymentRuleProviderUnavailable");
    case "recorder_unavailable":
      return getMessage("portal.paymentRuleRecorderUnavailable");
    case "outcome_unknown":
      return getMessage("portal.paymentRuleOutcomeUnknown");
    case "amount_unrepresentable":
      return getMessage("portal.paymentRuleAmountUnrepresentable");
    case "card_blacklisted":
      return getMessage("portal.ruleCardBlacklisted");
    case "card_blacklist_unavailable":
      return getMessage("portal.ruleCardBlacklistUnavailable");
    case "risk_rejected":
      return getMessage("portal.ruleRiskRejected");
    case "risk_suspicious":
      return getMessage("portal.ruleRiskSuspicious");
    case "stale_document":
      return getMessage("portal.paymentRuleStaleDocument");
    default:
      return null;
  }
}

/**
 * Whether a refusal ends the page rather than marking a field to fix.
 *
 * Two rules do: `risk_rejected` (STEP 186's, `PORTAL_FRAUD_RULES.rejected`) and `card_blacklisted` (STEP 187's,
 * `PORTAL_BLACKLIST_RULES.blocked`). They are spelled here rather than imported because this module is a client
 * component's and both vocabularies reach the gateway adapter's table; each gate checks its own spelling.
 */
export function portalPaymentRefusalIsFinal(rule: string | null): boolean {
  // `risk_rejected` is STEP 186's (the gateway named the card) and `card_blacklisted` is STEP 187's (the
  // platform already knew). Both end the page: re-offering the fields would invite the same card again.
  return rule === "risk_rejected" || rule === "card_blacklisted";
}

/**
 * The same answers as a lookup table, for the shared failure reader.
 *
 * `portalFailureTextOf` takes overrides in exactly this shape, so the form passes this table and every rule
 * the portal vocabulary already knows still resolves to its own sentence.
 */
export function portalPaymentRuleSentences(): Readonly<Record<string, string>> {
  const rules = [
    "not_payable",
    "invoice_void",
    "not_issued",
    "self_payment",
    "card_data_refused",
    "invalid_token",
    "card_declined",
    "provider_unavailable",
    "recorder_unavailable",
    "outcome_unknown",
    "amount_unrepresentable",
    "stale_document",
    "risk_rejected",
    "risk_suspicious",
    "card_blacklisted",
    "card_blacklist_unavailable",
  ];

  const sentences: Record<string, string> = {};

  for (const rule of rules) {
    const sentence = portalPaymentRuleTextOf(rule);

    if (sentence !== null) {
      sentences[rule] = sentence;
    }
  }

  return sentences;
}
