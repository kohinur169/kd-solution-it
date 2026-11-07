// path: components/payments/portal-three-ds-refusal.ts
import { getMessage } from "../../lib/i18n/messages.ts";

/**
 * The sentence each 3D Secure refusal becomes, for the payment form.
 *
 * STEP 183's table words every rule a card payment can produce before it reaches a bank; this one words the
 * rules the bank's step adds - a verification that was never switched on, one that expired, one that was
 * already used, one that could not be matched to its payment, a bank that would not confirm. They live in
 * their own module for the same reason: a refusal the payer reads at the end of an issuer's redirect should
 * be one sentence, written once, and not a sentence the form improvises from an HTTP status.
 *
 * A rule this module does not know is not a sentence: the caller keeps its own fallback, because a rule
 * invented by a later STEP must not be described as something it is not.
 */

/** The sentence for one 3DS rule, or null when this module does not know it. */
export function portalThreeDsRuleTextOf(rule: string): string | null {
  switch (rule) {
    case "billing_postal_code_invalid":
      return getMessage("portal.ruleBillingPostalInvalid");
    case "three_ds_unavailable":
      return getMessage("portal.ruleThreeDsUnavailable");
    case "three_ds_recorder_unavailable":
      return getMessage("portal.ruleThreeDsRecorderUnavailable");
    case "three_ds_authentication_failed":
      return getMessage("portal.ruleThreeDsAuthenticationFailed");
    case "three_ds_challenge_expired":
      return getMessage("portal.ruleThreeDsChallengeExpired");
    case "three_ds_challenge_replayed":
      return getMessage("portal.ruleThreeDsChallengeReplayed");
    case "three_ds_challenge_invalid":
      return getMessage("portal.ruleThreeDsChallengeInvalid");
    case "three_ds_challenge_unknown":
      return getMessage("portal.ruleThreeDsChallengeUnknown");
    case "three_ds_under_review":
      return getMessage("portal.ruleThreeDsUnderReview");
    case "three_ds_result_invalid":
      return getMessage("portal.ruleThreeDsResultInvalid");
    default:
      return null;
  }
}

/**
 * The same answers as a lookup table, for the shared failure reader.
 *
 * `portalFailureTextOf` takes overrides in exactly this shape, so the card form merges this table into STEP
 * 183's and every rule either STEP can produce still resolves to its own sentence.
 */
export function portalThreeDsRuleSentences(): Readonly<Record<string, string>> {
  const rules = [
    "billing_postal_code_invalid",
    "three_ds_unavailable",
    "three_ds_recorder_unavailable",
    "three_ds_authentication_failed",
    "three_ds_challenge_expired",
    "three_ds_challenge_replayed",
    "three_ds_challenge_invalid",
    "three_ds_challenge_unknown",
    "three_ds_under_review",
    "three_ds_result_invalid",
  ];

  const sentences: Record<string, string> = {};

  for (const rule of rules) {
    const sentence = portalThreeDsRuleTextOf(rule);

    if (sentence !== null) {
      sentences[rule] = sentence;
    }
  }

  return sentences;
}
