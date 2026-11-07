// path: app/(client-portal)/portal-three-ds-fields.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { threeDsVerified, type FraudThreeDsOutcome } from "../../lib/security/fraud.ts";
import { PORTAL_PAYMENT_AUDIT_ENTITY } from "./portal-payment-fields.ts";

/**
 * The vocabulary of the 3D Secure step, in one place.
 *
 * STEP 184 owns section 18's two sentences about authentication: "3D Secure is requested on every payment
 * where possible" and "when 3DS is not completed, capture happens only when billing postal code and payer IP
 * country both match the invoice data. When either does not match, nothing is captured and the payment goes
 * to manual review by compliance_kyc."
 *
 * ## Where this module sits
 *
 * STEP 183 built the payment page and the one charge it makes; this STEP puts the authentication in front of
 * that charge. The pieces that have to agree - the handle the browser carries to the issuer and back, the
 * fields that handle travels in, how long a challenge lives, how many attempts an address gets, which
 * outcome means capture and which means review - are collected here, because a number remembered in two
 * places is a number that one day disagrees.
 *
 * ## What it borrows rather than restates
 *
 * The capture rule is `lib/security/fraud.ts`'s `threeDsVerified`, which is STEP 066's single statement of
 * section 18's rule and the twin of `payments_three_ds_capture_check` in `0037_payments.sql`. A second copy
 * here would be a second answer to "may this payment be captured", and the two would drift. The audit entity
 * is STEP 183's, because a payment is a payment whichever page made it.
 *
 * ## What this module never holds
 *
 * A card number, an expiry, a CVV or a keystroke. The only things a 3DS step ever sees are the provider's
 * token, the issuer's challenge text, the payer's answer to that challenge and the outcome - and the
 * challenge text is opaque base64 that this platform passes through without reading.
 */

/** The segment a challenge starts under, after `i/[token]/pay`. */
export const PORTAL_THREE_DS_START_PATH = "/pay/3ds";

/** The segment the issuer returns the payer to. It is the `TermUrl` of the challenge form. */
export const PORTAL_THREE_DS_COMPLETE_PATH = "/3ds/complete";

/**
 * The segment that says what the return meant.
 *
 * The issuer posts to the completion route, which settles the payment and then redirects here, because a
 * bank's page is no place to end a cardholder's journey with a JSON body. The state in the query selects the
 * page's words and nothing else: the amount and the paid state are read from the invoice on that page, so a
 * payer who edited the query would only change the sentence, never the money.
 */
export const PORTAL_THREE_DS_RESULT_PATH = "/3ds/result";

/** The states the result page knows. A closed vocabulary, so an invented one gets the generic answer. */
export const PORTAL_THREE_DS_RESULT_STATES = deepFreeze([
  "captured",
  "review",
  "declined",
  "unknown",
  "expired",
] as const);

export type PortalThreeDsResultState = (typeof PORTAL_THREE_DS_RESULT_STATES)[number];

/** True when a value names a state the result page can show. */
export function isPortalThreeDsResultState(value: unknown): value is PortalThreeDsResultState {
  return typeof value === "string" && (PORTAL_THREE_DS_RESULT_STATES as readonly string[]).includes(value);
}

/**
 * Which page the return lands on, from the rule the flow refused with.
 *
 * The mapping is the page's vocabulary rather than the flow's: a rule says what was wrong, and a state says
 * what a cardholder should read. A challenge that expired, one that was replayed and a handle that never
 * verified are one sentence - "this payment could not be completed here, start again" - because the
 * difference between them tells a cardholder nothing they can act on and tells an attacker which handle is
 * worth editing.
 */
export function portalThreeDsResultStateOf(rule: string): PortalThreeDsResultState {
  switch (rule) {
    case "three_ds_authentication_failed":
      return "declined";
    case "three_ds_under_review":
      return "review";
    case "outcome_unknown":
    case "three_ds_unavailable":
    case "three_ds_recorder_unavailable":
      return "unknown";
    default:
      return "expired";
  }
}

/**
 * The fields of the challenge form, as the redirect 3D Secure protocol names them.
 *
 * `PaReq` is the issuer's request, `MD` is the merchant's own data - this platform's sealed handle, which
 * comes back untouched - and `TermUrl` is where the issuer sends the payer afterwards. The three are the
 * whole form: there is nothing else in it, and nothing in it is card data.
 */
export const PORTAL_THREE_DS_CHALLENGE_FIELDS = deepFreeze(["PaReq", "MD", "TermUrl"] as const);

/** What the issuer posts back: its result, and the handle it was given. Nothing else is read. */
export const PORTAL_THREE_DS_RESULT_FIELDS = deepFreeze(["PaRes", "MD"] as const);

/** The one field a payer's browser sends to start a challenge: the same two fields the charge takes. */
export const PORTAL_THREE_DS_START_FIELDS = deepFreeze(["collectjs_token", "idempotency_key"] as const);

/** The purpose written inside the handle, so a handle cannot be mistaken for another sealed value. */
export const PORTAL_THREE_DS_HANDLE_PURPOSE = "portal-three-ds";

/**
 * The context the handle is sealed under.
 *
 * The additional authenticated data binds one handle to one challenge: a handle moved to another challenge's
 * context does not open, so a value copied out of one browser session cannot be replayed into another.
 */
export function portalThreeDsHandleContext(challengeId: string): string {
  return `${PORTAL_THREE_DS_HANDLE_PURPOSE}|${challengeId}`;
}

/** A sealed handle is a box and an envelope around a small claim; this bounds it. */
export const PORTAL_THREE_DS_HANDLE_MAXIMUM_LENGTH = 2_048;

/** The issuer's request, passed through unread. Four kilobytes is the widest a challenge gets. */
export const PORTAL_THREE_DS_CHALLENGE_MAXIMUM_LENGTH = 4_096;

/** The issuer's result, likewise. */
export const PORTAL_THREE_DS_RESULT_MAXIMUM_LENGTH = 4_096;

/** The body ceiling at the issuer's return: two base64 fields. */
export const PORTAL_THREE_DS_MAXIMUM_BODY_BYTES = 16_384;

/**
 * How long a challenge lives.
 *
 * Fifteen minutes is the window a bank's own page gives a cardholder before it expires, so a handle that
 * outlived it would only ever be used for a challenge the issuer has already forgotten. The bounds exist so
 * no caller can mint a handle that lives forever, and the clock is passed in rather than read here.
 */
export const PORTAL_THREE_DS_HANDLE_LIFETIME_SECONDS = 900;
export const PORTAL_THREE_DS_MINIMUM_LIFETIME_SECONDS = 60;
export const PORTAL_THREE_DS_MAXIMUM_LIFETIME_SECONDS = 1_800;

/** The longest a redirect target may be, which is the shape of a URL rather than a document. */
export const PORTAL_THREE_DS_ACS_URL_MAXIMUM_LENGTH = 512;

/**
 * The counter a 3DS step spends, per address.
 *
 * Ten attempts per ten minutes: a payer who fails a challenge and reloads may reasonably try three or four
 * times, and an attacker testing stolen cards through a link must not get more than a handful. It is counted
 * apart from the charge's five, because a challenge that never reaches a charge is not a charge attempt.
 */
export const PORTAL_THREE_DS_RATE_LIMIT = deepFreeze({
  scope: "portal_3ds",
  limit: 10,
  windowSeconds: 600,
});

/**
 * The rules this step refuses with.
 *
 * Each is the `rule` of an `AppError` detail, so a screen maps one word to one sentence. They are not error
 * codes: a challenge that cannot be started is a `SERVICE_UNAVAILABLE`, a replayed handle is a `CONFLICT`,
 * and the code already says which.
 */
export const PORTAL_THREE_DS_RULES = deepFreeze({
  /** No provider operation exists to request authentication through, so no card can be taken. */
  unavailable: "three_ds_unavailable",
  /** The platform can authenticate but not record the challenge durably, so it must not start one. */
  recorderUnavailable: "three_ds_recorder_unavailable",
  /** The issuer said the cardholder failed authentication. */
  authenticationFailed: "three_ds_authentication_failed",
  /** The handle names a challenge this platform no longer holds. */
  challengeUnknown: "three_ds_challenge_unknown",
  /** The handle was already used: a 3DS result is spent once. */
  challengeReplayed: "three_ds_challenge_replayed",
  /** The handle, the link and the record do not describe the same payment. */
  challengeInvalid: "three_ds_challenge_invalid",
  /** The handle outlived the window the issuer gives a cardholder. */
  challengeExpired: "three_ds_challenge_expired",
  /** The issuer's result or the handle is not the shape this platform wrote. */
  resultInvalid: "three_ds_result_invalid",
  /** The invoice moved between the challenge and its result. */
  staleDocument: "stale_document",
  /** Authentication was not completed, so nothing is captured and compliance_kyc reviews the attempt. */
  underReview: "three_ds_under_review",
});

/** The audit actions of this step, one per outcome a payer can produce. */
export const PORTAL_THREE_DS_CHALLENGED_AUDIT_ACTION = "portal.three_ds_challenged";
export const PORTAL_THREE_DS_AUTHENTICATED_AUDIT_ACTION = "portal.three_ds_authenticated";
export const PORTAL_THREE_DS_NOT_COMPLETED_AUDIT_ACTION = "portal.three_ds_not_completed";
export const PORTAL_THREE_DS_REVIEW_AUDIT_ACTION = "portal.three_ds_review";
export const PORTAL_THREE_DS_REFUSED_AUDIT_ACTION = "portal.three_ds_refused";

/** The entity a chain link names, borrowed from STEP 183: a 3DS attempt is part of a payment. */
export const PORTAL_THREE_DS_AUDIT_ENTITY = PORTAL_PAYMENT_AUDIT_ENTITY;

/**
 * Who the review belongs to, in section 18's words.
 *
 * A payment that was not authenticated and whose billing details did not match is not captured and is
 * reviewed by the compliance team; naming the desk in the audit payload is what makes the queue findable
 * without a second table of who owns what.
 */
export const PORTAL_THREE_DS_REVIEW_OWNER = "compliance_kyc";

/**
 * What the provider's authentication answered, in the four words `payments_three_ds_check` allows.
 *
 * `not_requested` is deliberately absent from this module's mapping: a card payment on this platform always
 * requests authentication, so a payment that says it did not request any is one this page did not make.
 */
export type PortalThreeDsOutcome = Extract<
  FraudThreeDsOutcome,
  "authenticated" | "attempted" | "not_completed"
>;

/**
 * The provider's answer, mapped to the platform's vocabulary.
 *
 * `authenticated` is the only answer that captures on its own. A challenge that was started and never
 * finished is `attempted` - the payer reached the issuer's page and left it - and a challenge the issuer
 * refused or a card the issuer could not authenticate is `not_completed`. Both of the latter are held to the
 * billing-match rule below, which is why they are distinct from `authenticated` and not merged into it.
 */
export function portalThreeDsOutcomeOf(answer: "authenticated" | "abandoned" | "failed"): PortalThreeDsOutcome {
  if (answer === "authenticated") {
    return "authenticated";
  }

  return answer === "abandoned" ? "attempted" : "not_completed";
}

/** What may be done with the money once authentication has answered. */
export type PortalThreeDsDecision = "capture" | "review";

/**
 * Section 18's capture rule, as this module reads it.
 *
 * A payment may be captured when the issuer authenticated it, and otherwise only when the billing postal
 * code and the payer's IP country both matched the invoice. Anything else is not captured and goes to
 * manual review - which is the whole point of the sentence: the platform never guesses at a payment it could
 * not authenticate.
 *
 * The rule itself is `threeDsVerified`, STEP 066's one statement of it and the twin of
 * `payments_three_ds_capture_check`. This function is only the vocabulary the portal speaks, and the gate
 * compares the two so the page and the schema cannot disagree.
 */
export function portalThreeDsCaptureDecisionOf(attempt: {
  readonly outcome: PortalThreeDsOutcome;
  readonly postalCodeMatched: boolean;
  readonly ipCountryMatched: boolean;
}): PortalThreeDsDecision {
  return threeDsVerified({
    threeDsOutcome: attempt.outcome,
    postalCodeMatched: attempt.postalCodeMatched,
    ipCountryMatched: attempt.ipCountryMatched,
  })
    ? "capture"
    : "review";
}

const httpsScheme = "https:";

/**
 * A redirect target this page will send a payer's browser to.
 *
 * The address comes from the issuer through the provider, so it is a value from outside that this page
 * reflects into a form action - exactly the shape of an open redirect if it were trusted. It is checked
 * rather than trusted: `https` only, a host, no credentials in the authority, no fragment, no whitespace and
 * no length beyond a URL. `javascript:`, `data:` and a plain-`http` address are refused by the scheme check
 * before anything else is looked at.
 */
export function portalThreeDsAcsUrlOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > PORTAL_THREE_DS_ACS_URL_MAXIMUM_LENGTH) {
    return null;
  }

  if (value !== value.trim() || /\s/u.test(value)) {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== httpsScheme) {
    return null;
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return null;
  }

  if (parsed.hash !== "") {
    return null;
  }

  if (parsed.hostname.length === 0 || parsed.hostname.includes("..")) {
    return null;
  }

  return parsed.toString();
}

/**
 * Where the issuer sends the payer back to.
 *
 * The origin is the deployment's own, taken from the request rather than from a header, and the path is the
 * link's: a challenge minted for one invoice cannot be completed under another invoice's link, because the
 * two disagree about which payment they are about.
 */
export function portalThreeDsTermUrlOf(origin: string, token: string): string {
  return `${origin}/i/${encodeURIComponent(token)}${PORTAL_THREE_DS_COMPLETE_PATH}`;
}
