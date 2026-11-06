// path: services/estimates/estimate-fields.ts
/**
 * The vocabulary of section 16's quote, as `0025`, `0026` and `0117` declare it.
 *
 * Every constant here is copied from a migration and names the constraint it repeats, because a limit
 * that lives in two places drifts: the check is what the database enforces, and this module is what lets
 * a form refuse the same value before a merchant waits for a round trip.
 *
 * ## What is deliberately not here
 *
 * The quote's client snapshot, its lines and its money are the invoice's, and their constants stay in
 * `services/invoices/invoice-fields.ts` and `services/products/price.ts`. `0025` states
 * `estimates_client_name_check`, `estimates_client_email_check`, `estimates_client_address_check` and
 * `estimates_memo_check` character for character as `0022` states the invoice's, and `0026` says of its
 * own table that it "mirrors `invoice_items` exactly". So this module holds what a quote has that an
 * invoice does not - a decision instead of a payment, an expiry instead of a due date, and a reason for
 * ending - and imports the rest. A second copy of `160` in another folder is not a quote's own limit; it
 * is a number that will one day disagree with the column it claims to repeat.
 */

/**
 * The five status words of a quote, in the order a quote moves through them.
 *
 * `0025`'s `estimates_status_check`. Section 16 gives a quote no paid states, because nothing is paid on
 * a quote: it is accepted and becomes an invoice, which is where the payment workflow begins.
 */
export const ESTIMATE_STATUSES = ["draft", "sent", "viewed", "accepted", "void"] as const;

export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

/**
 * The status every quote this STEP writes is in.
 *
 * A create form produces a draft: `0025`'s `estimates_issue_check` requires a draft to carry no number
 * and no issue instant, so nothing here can accidentally issue a document a client has not been sent.
 * Sending, the number and the decision are later STEPs - `0025` is written to allow exactly those moves.
 */
export const ESTIMATE_CREATED_STATUS: EstimateStatus = "draft";

/**
 * The three ways a quote ends, which section 16 deliberately reports as one status.
 *
 * `0025`'s `estimates_void_reason_check`, with `estimates_void_pair_check` requiring a reason exactly
 * when the status is `void` and never otherwise: a client declined it, it expired, or the merchant
 * withdrew it. Section 16 names the first two as paths to void and the merchant's own withdrawal is the
 * third, so the reason is what tells a merchant which of the three happened to a document.
 */
export const ESTIMATE_VOID_REASONS = ["declined", "expired", "withdrawn"] as const;

export type EstimateVoidReason = (typeof ESTIMATE_VOID_REASONS)[number];

/** The currencies a merchant may quote in. Rule 2 and section 16: all prices are displayed in USD. */
export const ESTIMATE_CURRENCIES = ["USD"] as const;

export type EstimateCurrency = (typeof ESTIMATE_CURRENCIES)[number];

/**
 * How far ahead a quote may be set to expire: one year.
 *
 * `0025` bounds the expiry from below only - `estimates_expiry_check` requires `expires_at > issued_at`
 * once a quote is issued, and says nothing about a draft, whose `issued_at` is null. So the ceiling is a
 * business limit and not a column's, and it lives here for the same reason the invoice's ten-year due-date
 * ceiling lives in `invoice-fields.ts`: a quote is an offer with a lifetime, and a lifetime of ten years is
 * a mistyped year rather than an offer. One year is longer than any trade in section 16 waits for a
 * signature and short enough that a typo is refused.
 */
export const ESTIMATE_EXPIRY_MAXIMUM_DAYS = 365;

/** The tables of `0025` and `0026`. */
export const ESTIMATE_TABLE = "estimates";
export const ESTIMATE_ITEMS_TABLE = "estimate_items";

/**
 * The columns a quote is read with, because rule 17 says selected columns only and never `*`.
 *
 * The `select=` prefix is part of the value and not of the query that uses it, which is how the invoice's
 * own column list is written: a PostgREST query string without it asks for every column, and a list that
 * looked complete in the module and arrived bare in the request is exactly the kind of mistake a reader
 * cannot see from either file alone.
 */
export const ESTIMATE_COLUMNS = `select=${[
  "id",
  "company_id",
  "client_id",
  "number",
  "status",
  "void_reason",
  "currency",
  "subtotal_minor",
  "discount_minor",
  "discount_basis",
  "discount_percent_bp",
  "tax_minor",
  "total_minor",
  "client_name",
  "client_email",
  "client_address",
  "memo",
  "issued_at",
  "expires_at",
  "accepted_at",
  "voided_at",
  "converted_invoice_id",
  "created_at",
  "updated_at",
  "deleted_at",
  "version",
].join(",")}`;

/** The columns a quote line is read with. `line_total_minor` is generated, so it is read and never written. */
export const ESTIMATE_ITEM_COLUMNS = `select=${[
  "id",
  "company_id",
  "estimate_id",
  "position",
  "description",
  "unit",
  "quantity",
  "unit_price_minor",
  "discount_minor",
  "line_total_minor",
  "product_id",
  "service_id",
  "created_at",
  "updated_at",
  "deleted_at",
  "version",
].join(",")}`;

/** True when `value` is one of the five statuses. */
export function isEstimateStatus(value: unknown): value is EstimateStatus {
  return typeof value === "string" && (ESTIMATE_STATUSES as readonly string[]).includes(value);
}

/** True when `value` is one of the three reasons a quote ends. */
export function isEstimateVoidReason(value: unknown): value is EstimateVoidReason {
  return typeof value === "string" && (ESTIMATE_VOID_REASONS as readonly string[]).includes(value);
}
