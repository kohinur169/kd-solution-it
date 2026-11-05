// path: services/estimates/estimate-signature-fields.ts
/**
 * The vocabulary of a quote's signature evidence: what `0027_estimate_signatures` accepts, restated once.
 *
 * ## Why this module exists
 *
 * `FEATURE_LIST.md:175` names eight things that must be stored when a client decides a quote: signer name,
 * email, consent checkbox record, time, IP address, geo location, device fingerprint and document hash.
 * `0027` already stores all eight as columns, each with a CHECK that says exactly how long, how shaped and
 * how trimmed the value has to be. The service that writes a row therefore has two choices: repeat those
 * numbers inline where they are used, or name them once here. Repeating them is how a service ends up
 * refusing an email of 255 characters that the database would have taken, or accepting a fingerprint the
 * database then rejects with a constraint name instead of a sentence. So the numbers live here, and the
 * estimate gate reads `0027` and asserts the two agree - which is what keeps this module honest rather than
 * a second, drifting source of truth.
 *
 * ## Why there are no new rule names
 *
 * Every refusal this evidence path can make is a fact the quote's own vocabulary already has a word for. An
 * unticked consent box is a **required** field that was not filled, not a new kind of wrong; a quote that is
 * still a draft cannot be signed, which is the same "the document is not in the state this write needs"
 * fact that a line edit meets, and it is called **already_changed** there too; a second decision on one
 * quote meets the unique index, which is **already_used**. Inventing `consent_required` or
 * `not_open_for_signing` would give one document family two vocabularies for one set of facts, and a screen
 * would need two maps to word them. `ESTIMATE_SIGNATURE_RULES` is therefore a subset of `ESTIMATE_RULES`,
 * and the gate asserts the subset relation rather than trusting this comment.
 *
 * ## Why the consent wording is not a constant here
 *
 * `0027` stores `consent_text` as "the exact consent wording shown beside the checkbox". Shown means a
 * user-facing string, and MASTER_PROMPT rule 1 puts every one of those in `lib/i18n/strings/en.ts`. A
 * constant in a service module would be a second copy of a sentence a client reads, and the day the two
 * differ the evidence would record words nobody was shown. The wording is read from the catalogue at
 * capture time and stored as it was read.
 *
 * ## What this module deliberately does not contain
 *
 * No write path, no route and no status transition. `0027`'s `estimate_signatures_guard_decision` refuses an
 * insert unless the quote is `sent` or `viewed`, and `0025`'s `estimates_issue_check` refuses those statuses
 * without a `number` and an `issued_at`. Nothing in this build writes either, so no signature row can be
 * inserted yet; the send workflow that would make one insertable is not this STEP's and is not invented
 * here. `ESTIMATE_SIGNATURE_OPEN_STATUSES` names the two statuses the trigger requires so that the capture
 * path can **demand** one rather than manufacture it.
 *
 * This module imports nothing, so a browser file may use it - the same reason `estimate-fields.ts` is
 * import-free.
 */

/** The two decisions a client may make on a quote: `estimate_signatures_decision_check`. */
export const ESTIMATE_SIGNATURE_DECISIONS = ["accepted", "declined"] as const;

export type EstimateSignatureDecision = (typeof ESTIMATE_SIGNATURE_DECISIONS)[number];

/**
 * True when a stored decision is one of the two.
 *
 * A reader narrows with this rather than casting, because a row the database stored outside its own CHECK
 * is a broken platform and not a document to print. There is no safe fallback here: guessing `accepted`
 * would claim a client agreed to something, and guessing `declined` would claim they refused. Both are
 * worse than refusing to answer, which is why the reader that meets one reports an internal error.
 */
export function isEstimateSignatureDecision(value: unknown): value is EstimateSignatureDecision {
  return typeof value === "string" && (ESTIMATE_SIGNATURE_DECISIONS as readonly string[]).includes(value);
}

/**
 * The statuses in which a signature may be written at all.
 *
 * This is `estimate_signatures_guard_decision`'s own list, restated: the trigger reads the quote's status
 * and raises unless it is one of these two. A capture path checks the same list before it writes so that a
 * refusal arrives as a sentence with a field and a rule instead of as a database exception, and so that the
 * two lists cannot drift apart without the gate noticing.
 */
export const ESTIMATE_SIGNATURE_OPEN_STATUSES = ["sent", "viewed"] as const;

export type EstimateSignatureOpenStatus = (typeof ESTIMATE_SIGNATURE_OPEN_STATUSES)[number];

/**
 * How long each element of the evidence may be, as `0027` says.
 *
 * Every one of these is a column CHECK, and every CHECK also requires the value to equal its own `btrim`,
 * which is why a capture path trims before it measures rather than after: an untrimmed value is refused by
 * the database even when its trimmed length would have fitted.
 */
export const ESTIMATE_SIGNATURE_LIMITS = Object.freeze({
  /** `estimate_signatures_signer_name_check`: 1 to 160, trimmed. */
  signerName: Object.freeze({ min: 1, max: 160 }),
  /** `estimate_signatures_signer_email_check`: 3 to 254, trimmed, and a shaped address. */
  signerEmail: Object.freeze({ min: 3, max: 254 }),
  /** `estimate_signatures_consent_text_check`: 1 to 2000, trimmed. The wording that was shown. */
  consentText: Object.freeze({ min: 1, max: 2000 }),
  /** `estimate_signatures_geo_check`: null, or 1 to 200 trimmed. */
  geoLocation: Object.freeze({ min: 1, max: 200 }),
  /** `estimate_signatures_fingerprint_check`: null, or 8 to 128 printable ASCII characters. */
  deviceFingerprint: Object.freeze({ min: 8, max: 128 }),
  /** `estimate_signatures_path_check`: null, or 1 to 300 trimmed. A storage key, never an image. */
  signaturePath: Object.freeze({ min: 1, max: 300 }),
});

/**
 * The address shape `estimate_signatures_signer_email_check` enforces.
 *
 * It is the client table's shape, which is deliberate: the address a signing link was sent to and the
 * address in the client book are the same kind of thing, and two different ideas of a valid address in one
 * product is how a merchant ends up unable to sign a quote for a client they were able to save.
 */
export const ESTIMATE_SIGNATURE_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$/u;

/**
 * Printable ASCII, 8 to 128 of it: `estimate_signatures_fingerprint_check`.
 *
 * `!-~` is every printable ASCII character except the space, which is what makes a fingerprint safe to put
 * in a log line, a CSV cell and a URL without quoting it. A fingerprint that is not this is not stored.
 */
export const ESTIMATE_SIGNATURE_FINGERPRINT_PATTERN = /^[!-~]{8,128}$/u;

/**
 * The shape of a stored document hash: `estimate_signatures_hash_check`.
 *
 * 64 lower case hex characters, which is SHA-256 and nothing else. Upper case is refused by the CHECK, so
 * the writer must lower case rather than hope: a hash stored in upper case would be a row the database
 * rejects, and a hash compared case-insensitively would be a comparison that admits two spellings of one
 * value.
 */
export const ESTIMATE_DOCUMENT_HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** How many characters a stored document hash has, which the pattern above already implies. */
export const ESTIMATE_DOCUMENT_HASH_LENGTH = 64;

/**
 * The rules this evidence path may refuse with.
 *
 * A subset of `ESTIMATE_RULES` on purpose - see the module comment. Nothing here is new, so no screen needs
 * a second map to word a signature refusal.
 */
export const ESTIMATE_SIGNATURE_RULES = Object.freeze([
  /** An element of the eight is missing, or the consent box was not ticked. */
  "required",
  /** A value shorter than its column's floor: an empty name, a two-character address. */
  "too_short",
  /** A value longer than its column's ceiling. */
  "too_long",
  /** A value of the wrong shape: an address that is not one, a fingerprint with a space in it. */
  "invalid_format",
  /** No quote at that id in this merchant's scope, or no signature on a quote that has one. */
  "not_found",
  /** The quote already carries a decision, and the first one ends the question. */
  "already_used",
  /** The quote is not open for signing: it is a draft, or it has already been accepted or voided. */
  "already_changed",
] as const);

export type EstimateSignatureRule = (typeof ESTIMATE_SIGNATURE_RULES)[number];

/** The audit action one evidence row earns, in the house `entity.verb` shape. */
export const ESTIMATE_SIGNATURE_RECORDED_AUDIT_ACTION = "estimate.signature_recorded";

/** The entity the audit entry names: the evidence row, not the quote it belongs to. */
export const ESTIMATE_SIGNATURE_AUDIT_ENTITY = "estimate_signature";

/** The table `0027` created. One name, so no query in this family spells it two ways. */
export const ESTIMATE_SIGNATURES_TABLE = "estimate_signatures";
