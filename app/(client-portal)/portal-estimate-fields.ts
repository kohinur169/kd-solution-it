// path: app/(client-portal)/portal-estimate-fields.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import {
  ESTIMATE_SIGNATURE_DECISIONS,
  ESTIMATE_SIGNATURE_LIMITS,
} from "../../services/estimates/estimate-signature-fields.ts";

/**
 * The vocabulary of the tokenized estimate page, in one place.
 *
 * STEP 182 owns the page under `e/[token]`, the payment components it shares with STEP 181's invoice page,
 * and nothing else. This module holds the words, the counts and the closed lists that the page, its one
 * write and its gate agree on, so no sentence is spelled twice and no limit is remembered in two places.
 *
 * ## What it borrows rather than repeats
 *
 * The signature's own limits are `0027`'s, and STEP 022 owns them in
 * `services/estimates/estimate-signature-fields.ts`. A second copy of "a name is at most one hundred and
 * sixty characters" would be a second number that one day disagrees with the column, so the two are
 * imported. The decisions are the same two words for the same reason: a quote is accepted or declined, and
 * the sentence a client ticks is not a second vocabulary.
 *
 * ## What is different from the invoice page
 *
 * An invoice has money arriving at it, so its page has five states and a receipt. A quote has a decision:
 * it is open until somebody accepts it, declines it or lets it expire, and both endings are `void` in
 * `0025` with a reason that says which one happened. So the fold here is five statuses plus one reason into
 * six client facing states, and the only write is the decision itself.
 */

/** The tables this page reads, named once so a query string cannot drift from the migration. */
export const PORTAL_ESTIMATE_TABLE = "estimates";
export const PORTAL_ESTIMATE_ITEM_TABLE = "estimate_items";
export const PORTAL_ESTIMATE_SIGNATURE_TABLE = "estimate_signatures";

/** The kind of portal link this page opens, and the capability it must carry: a quote is signed. */
export const PORTAL_ESTIMATE_TOKEN_KIND = "estimate";
export const PORTAL_ESTIMATE_TOKEN_CAPABILITY = "sign";

/** The path prefix every estimate link starts with. `/e/` beside the invoice's `/i/`, and just as short. */
export const PORTAL_ESTIMATE_PATH_PREFIX = "/e/";

/**
 * The six states a client facing quote can be in.
 *
 * `0025` has five statuses and `void` carries the reason it ended, which is what makes six: a quote that
 * expired and a quote the client declined are two different things to the person reading it, even though
 * the merchant's workflow records both as the one terminal state section 16 describes. The fold is total
 * over every status and reason the database can hold, and an unknown value answers `null` rather than a
 * guess - a quote this module cannot describe is a quote it does not render.
 */
export const PORTAL_ESTIMATE_STATES = deepFreeze([
  "not_issued",
  "open",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
] as const);

export type PortalEstimateState = (typeof PORTAL_ESTIMATE_STATES)[number];

/**
 * The statuses in which a client may still decide.
 *
 * `0027`'s trigger refuses a signature unless the quote is `sent` or `viewed`, and the page offers the
 * form under exactly this test, so a button the database would refuse never appears.
 */
export const PORTAL_ESTIMATE_OPEN_STATUSES = deepFreeze(["sent", "viewed"] as const);

/** The two decisions, borrowed from the signature vocabulary rather than restated. */
export const PORTAL_ESTIMATE_DECISIONS = ESTIMATE_SIGNATURE_DECISIONS;

export type PortalEstimateDecision = (typeof PORTAL_ESTIMATE_DECISIONS)[number];

/** True when a value names a decision this page can record. */
export function isPortalEstimateDecision(value: unknown): value is PortalEstimateDecision {
  return typeof value === "string" && (PORTAL_ESTIMATE_DECISIONS as readonly string[]).includes(value);
}

/**
 * The reason a quote ended, as `0025` stores it, which is what tells the six states apart.
 *
 * A `void` quote with no reason is not a state this page invents an answer for: `0025`'s
 * `estimates_void_pair_check` requires a reason exactly when the status is `void`, so a row without one is
 * a row the database does not allow and this module refuses to render.
 */
export const PORTAL_ESTIMATE_VOID_REASONS = deepFreeze(["declined", "expired", "withdrawn"] as const);

/** The lengths the decision body is held to: `0027`'s own, imported so the two cannot drift. */
export const PORTAL_ESTIMATE_LIMITS = ESTIMATE_SIGNATURE_LIMITS;

/** The sentence a client ticks, as a catalog key: read on both sides so the stored sentence is the shown one. */
export const PORTAL_ESTIMATE_CONSENT_KEY = "portal.signatureConsent";

/**
 * The refusal rules this STEP adds.
 *
 * Each is the `rule` of an `AppError` detail, so a screen maps one word to one sentence. They are not error
 * codes: a decision that cannot be recorded is a `CONFLICT` or a `VALIDATION_FAILED`, and the code already
 * names that; what the rule adds is which refusal, because "the quote expired while you were reading it" and
 * "somebody else already accepted it" are different things to tell a client.
 */
export const PORTAL_ESTIMATE_RULES = deepFreeze({
  /** The quote is a draft: a working copy with no number, so there is nothing to sign. */
  notIssued: "not_issued",
  /** The offer's lifetime has passed, and the quote was voided by this page as it was opened. */
  expired: "expired",
  /** Somebody already accepted it. */
  alreadyAccepted: "already_accepted",
  /** Somebody already declined it. */
  alreadyDeclined: "already_declined",
  /** The merchant withdrew it. */
  withdrawn: "withdrawn",
  /** The record moved while the form was open. */
  staleVersion: "stale_version",
  /** A session belonging to the quote's own company tried to decide it. */
  selfDecision: "self_decision",
  /** The evidence a decision would point at is not there. */
  evidenceMissing: "evidence_missing",
});

/** The order a refusal lists its fields in, which is the order a signer meets the boxes. */
export const PORTAL_ESTIMATE_FIELD_ORDER = deepFreeze([
  "decision",
  "signer_name",
  "signer_email",
  "consent_accepted",
  "device_fingerprint",
  "geo_location",
] as const);

/**
 * The audit actions of this STEP.
 *
 * The signature's own entry (`estimate.signature_recorded`) is written by STEP 022's service and is not
 * duplicated here. These four are the ones this page adds: the decision applied to the quote, the expiry it
 * applied, and the view it recorded - the last because a merchant learning that their client opened the
 * offer is the one thing a tokenized quote link can tell them that the invoice link cannot.
 */
export const PORTAL_ESTIMATE_ACCEPTED_AUDIT_ACTION = "portal.estimate_accepted";
export const PORTAL_ESTIMATE_DECLINED_AUDIT_ACTION = "portal.estimate_declined";
export const PORTAL_ESTIMATE_EXPIRED_AUDIT_ACTION = "portal.estimate_expired";
export const PORTAL_ESTIMATE_VIEWED_AUDIT_ACTION = "portal.estimate_viewed";

/** The audit entities, so a chain can be read by subject. */
export const PORTAL_ESTIMATE_AUDIT_ENTITY = "estimate";

/**
 * The body ceiling of the decision, in bytes.
 *
 * Four kilobytes is a name, an address, a decision word and two optional short values. It is checked
 * before the body is read, so a caller cannot make the process hold a document to learn it is refused.
 */
export const PORTAL_ESTIMATE_MAXIMUM_BODY_BYTES = 4_096;

/**
 * The signature's own rate limit, on the platform's own counter.
 *
 * Ten attempts per address per ten minutes, counted apart from the invoice confirmation: a client may sign
 * one quote and confirm one invoice from the same desk without either closing the other. Ten chances cover
 * a mistyped name, a reload and a second browser, and stop a script that holds a link from writing
 * evidence in a loop.
 */
export const PORTAL_SIGNATURE_RATE_LIMIT = deepFreeze({
  scope: "portal_signature",
  limit: 10,
  windowSeconds: 600,
});

/**
 * The document digest an accepted quote binds itself to.
 *
 * Re-exported from STEP 022's module rather than computed again: the evidence row a signature writes and
 * the digest this page prints must be the same value over the same bytes, and two encoders would be two
 * answers to "what did the client sign".
 */
export const PORTAL_ESTIMATE_DOCUMENT_HASH_ENCODING = "kd-estimate-document-hash/1";
