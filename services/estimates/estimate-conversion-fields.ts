// path: services/estimates/estimate-conversion-fields.ts
/**
 * The vocabulary of section 16's conversion: an accepted quote becomes an invoice, and the invoice is shared
 * as a payment link.
 *
 * ## Why this file holds no behaviour
 *
 * Every constant here is a number, a word or a frozen list, and the one function starts with `is`. That is
 * the same promise `estimate-fields.ts` and `invoice-fields.ts` make, and it is what lets a browser file
 * import one of them without dragging a database client into the bundle. The portal token's own vocabulary
 * belongs to `lib/security/portal-token.ts`, which is a security module and not this STEP's to edit; this
 * file therefore names the kind and the capability a link of this family needs, and `verify.ts` asserts
 * that both are still members of the security module's lists rather than restating them as facts.
 *
 * ## The payment link is a capability, not a document
 *
 * Section 16 says an accepted estimate converts "automatically into an invoice and a payment link is
 * generated". The link is not a row this STEP invents: the security module mints a signed, readable token
 * naming the invoice, the merchant and what the holder may do, and its own header states that a link "is
 * not stored". So a conversion leaves two facts behind - an invoice, which is a document, and a token id,
 * which is the name of one link a revocation store can later refuse. The id is why the mint is given one
 * rather than generating its own: a caller that must be able to revoke a link has to know its name before
 * the link exists, which is exactly what that module's interface says.
 */

/** The status `0025` requires before a quote may be converted, and the only one that can be. */
export const ESTIMATE_CONVERSION_SOURCE_STATUS = "accepted";

/**
 * The status a converted invoice is written with.
 *
 * `0022`'s `invoices_issue_check` forbids a number and an issue instant on a `draft`, and the conversion
 * takes a number because the client has just agreed to pay. An invoice that is payable but still a draft
 * would be a document the merchant cannot send and the client cannot settle, so the conversion issues it.
 * `take_invoice_number` allocates the number, and this STEP is its first production caller.
 */
export const ESTIMATE_CONVERSION_INVOICE_STATUS = "sent";

/**
 * The audit action of a conversion.
 *
 * The house `entity.verb` shape `0013` accepts. It is an invoice action rather than an estimate action
 * because the document created is an invoice, and an invoice's trail should name every way it came to
 * exist in one place.
 */
export const INVOICE_CONVERTED_AUDIT_ACTION = "invoice.converted";

/** The entity a conversion's audit entry names: the invoice it created. */
export const INVOICE_CONVERSION_AUDIT_ENTITY = "invoice";

/**
 * Every way a conversion can be refused, as a rule a caller maps to a sentence.
 *
 * `already_used` is the database's own answer and is kept under that name rather than given a private one:
 * `0025` puts a unique partial index on `converted_invoice_id`, two requests racing on one quote make the
 * second fail with `23505`, and the REST layer reports that as a conflict with no detail. Naming it
 * `already_used` means a screen that already words that rule for a draft's optimistic lock words this one
 * too, instead of needing a sentence nobody wrote.
 */
export const ESTIMATE_CONVERSION_RULES = [
  "not_accepted",
  "already_converted",
  "expired",
  "client_incomplete",
  "empty",
  "invalid_format",
  "already_used",
] as const;

export type EstimateConversionRule = (typeof ESTIMATE_CONVERSION_RULES)[number];

/**
 * How long a conversion's payment link lives, in seconds.
 *
 * Thirty days, which is the ceiling the token module allows (`PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS`). The
 * module takes a lifetime and never an expiry date, and the reason the ceiling is the right choice here is
 * that the link is not the deadline: the invoice's own `due_at` is, and a client who is late should be
 * invoiced again rather than pointed at a link that quietly still works a year later. A shorter lifetime
 * would be a second deadline nobody set, so the module's ceiling is taken and the invoice's date governs.
 * `verify.ts` asserts the value is inside the module's band rather than trusting the literal.
 */
export const ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS = 2_592_000;

/** The portal token kind a converted invoice is shared under. `payment_link` as a kind is STEP 190's general link. */
export const ESTIMATE_PAYMENT_LINK_KIND = "invoice";

/**
 * The capability the link carries: paying. A token names one capability, and `pay` is what the client is
 * invited to do, so that is the one minted.
 */
export const ESTIMATE_PAYMENT_LINK_CAPABILITY = "pay";

/**
 * Where a tokenized invoice is opened.
 *
 * Section 2 states client access as "tokenized link access only under `i/[token]` and `e/[token]`, no
 * login", and `APP_URL` is the manifest's one canonical base for "absolute links in email, payment pages
 * and tokenized client links". The page itself is STEP 181; this constant names the path so the service has
 * one place to change it and the gate can compare it against the feature list.
 */
export const ESTIMATE_PAYMENT_LINK_PATH_PREFIX = "/i/";

/**
 * How many bytes the token id is drawn from.
 *
 * The security module's `PORTAL_TOKEN_ID_BYTES` is sixteen, and a caller that supplies an id must supply one
 * that module accepts - twenty-two canonical base64url characters. This is the same number, named here
 * because a caller generating the id owes the reader an explanation of its size rather than a bare literal.
 */
export const ESTIMATE_PAYMENT_LINK_ID_BYTES = 16;

/**
 * The status a compensating action leaves a draft in.
 *
 * `0022` allows a void row to hold neither a number nor an issue instant, which is the state a draft is
 * already in, so voiding is always available to a conversion that could not finish. The word is named here
 * rather than typed at the call site so the gate can prove it is a status `0022`'s vocabulary contains.
 */
export const INVOICE_VOID_STATUS = "void";

/** The smallest number of whole days between a converted invoice's issue and its due date. */
export const ESTIMATE_CONVERSION_MINIMUM_TERM_DAYS = 1;

/**
 * Whether a conversion rule is one this family names.
 *
 * Exported so a route or a screen validating a rule from a payload can refuse an unknown word rather than
 * build a catalogue key from it.
 */
export function isEstimateConversionRule(value: unknown): value is EstimateConversionRule {
  return typeof value === "string" && (ESTIMATE_CONVERSION_RULES as readonly string[]).includes(value);
}
