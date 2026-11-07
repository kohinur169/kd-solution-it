// path: components/payments/portal-form-refusal.ts
import { getMessage } from "../../lib/i18n/messages.ts";

/**
 * The sentence one refusal rule becomes, for the two portal forms.
 *
 * A route answers a refused write with the platform's error envelope, whose `details` carry a field and a
 * rule rather than a sentence - the rule is machine text and stays machine text on the wire. This module
 * is where a rule becomes English, so the confirmation form and the delivery form cannot describe the
 * same refusal two different ways, and so a rule added to a service surfaces as a marked field rather
 * than as "something went wrong".
 *
 * Nothing here reads the response body's message: that message is the catalog's own generic sentence for
 * the code, and it is deliberately less specific than the rule.
 */

/** The sentence for one rule name. An unknown rule is the field-level catch-all. */
export function portalRuleTextOf(rule: string): string {
  switch (rule) {
    case "required":
      return getMessage("portal.ruleRequired");
    case "too_short":
      return getMessage("portal.ruleTooShort");
    case "too_long":
      return getMessage("portal.ruleTooLong");
    case "too_large":
      return getMessage("portal.ruleTooLarge");
    case "too_small":
      return getMessage("portal.ruleTooSmall");
    case "unknown_field":
      return getMessage("portal.ruleUnknownField");
    case "not_found":
      return getMessage("portal.ruleNotFound");
    case "not_issued":
      return getMessage("portal.ruleNotIssued");
    case "invoice_void":
      return getMessage("portal.ruleInvoiceVoid");
    case "not_paid_yet":
      return getMessage("portal.ruleNotPaidYet");
    case "evidence_missing":
      return getMessage("portal.ruleEvidenceMissing");
    case "evidence_changed":
      return getMessage("portal.ruleEvidenceChanged");
    case "statement_mismatch":
      return getMessage("portal.ruleStatementMismatch");
    case "acceptance_exists":
      return getMessage("portal.ruleAlreadyUsed");
    case "evidence_confirmed":
      return getMessage("portal.ruleEvidenceConfirmed");
    case "self_confirmation":
      return getMessage("portal.ruleSelfConfirmation");
    case "stale_version":
    case "document_changed":
      return getMessage("portal.ruleAlreadyChanged");
    case "invalid_format":
      return getMessage("portal.ruleInvalidFormat");
    default:
      return getMessage("portal.fieldInvalid");
  }
}

/**
 * The sentence for a failed portal write, read from the envelope.
 *
 * `409` and `422` are told apart because the next step differs: a conflict means "reload and look", a
 * validation failure means "fix the marked field". `429` names the wait. `403` on this page can only mean
 * a merchant whose session does not own the invoice the link names. Everything else is the caller's own
 * fallback sentence, which is the one that says the write did not happen.
 *
 * `overrides` is how a second surface adds its own rules without a second parser: the entry form of an
 * estimate passes the rules that only a quote can refuse with (`already_accepted`, `expired`, and so on),
 * and every rule it does not name still becomes the sentence above. A rule answered here is a rule no
 * surface has to describe twice.
 */
/** One refusal, read once: the sentence a person reads, and the rule a caller may act on. */
export interface PortalRefusal {
  /** The HTTP status the write was refused with. */
  readonly status: number;
  /** The first rule the envelope named, or null when the answer carried none this reader understands. */
  readonly rule: string | null;
  /** The sentence for that rule. */
  readonly text: string;
}

/**
 * The same answer, naming the rule as well as its sentence.
 *
 * A form usually only needs the sentence, which `portalFailureTextOf` gives it. A form that has to *stop*
 * after one refusal - a card the provider has flagged is refused once and not offered again - needs the rule
 * to recognise it, and reading the body twice is not possible: the response is a stream.
 */
export async function portalRefusalOf(
  response: Response,
  fallback: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<PortalRefusal> {
  if (response.status === 401 || response.status === 403) {
    return { status: response.status, rule: null, text: getMessage("portal.merchantForbidden") };
  }

  if (response.status === 429) {
    return { status: response.status, rule: null, text: getMessage("portal.confirmationRateLimited") };
  }

  let rule: string | null = null;

  try {
    const parsed: unknown = JSON.parse(await response.text());

    if (typeof parsed === "object" && parsed !== null) {
      const envelope = parsed as { readonly error?: { readonly details?: unknown } };
      const details = envelope.error?.details;

      if (Array.isArray(details) && details.length > 0) {
        const first = details[0] as { readonly rule?: unknown };

        if (typeof first.rule === "string") {
          rule = first.rule;
        }
      }
    }
  } catch {
    rule = null;
  }

  if (rule === null) {
    return { status: response.status, rule: null, text: fallback };
  }

  return { status: response.status, rule, text: overrides?.[rule] ?? portalRuleTextOf(rule) };
}

/** The sentence for a failed portal write, read from the envelope. */
export async function portalFailureTextOf(
  response: Response,
  fallback: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  return (await portalRefusalOf(response, fallback, overrides)).text;
}
