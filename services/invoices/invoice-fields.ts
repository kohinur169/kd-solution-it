// path: services/invoices/invoice-fields.ts
import { PRICE_SCALE } from "../products/price.ts";

/**
 * The vocabulary of section 16's invoice, as `0022` and `0023` declare it.
 *
 * Every constant here is copied from a migration and names the file it came from, because a limit that
 * lives in two places drifts: the check constraint is what the database enforces, and this module is
 * what lets the form refuse the same value before the merchant waits for a round trip. The comment
 * beside each one says which line of which migration it repeats.
 */

/** The seven status words of section 16, in the order the workflow moves through them. */
export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "partially_paid",
  "paid",
  "overdue",
  "void",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * The status every invoice this STEP writes is in.
 *
 * A create form produces a draft: `0022`'s `invoices_issue_check` requires a draft to carry no number
 * and no issue instant, so nothing here can accidentally issue a document. Sending, the number and the
 * rest of the workflow are STEP 116's (`invoices_issue_check` is written to allow exactly that move).
 */
export const INVOICE_CREATED_STATUS: InvoiceStatus = "draft";

/** The currencies a merchant may bill in. Rule 2 and section 16: all prices are displayed in USD. */
export const INVOICE_CURRENCIES = ["USD"] as const;

export type InvoiceCurrency = (typeof INVOICE_CURRENCIES)[number];

/** `invoices_client_name_check`: one to 160 characters, already trimmed. */
export const INVOICE_CLIENT_NAME_LIMITS = Object.freeze({ min: 1, max: 160 });

/** `invoices_client_email_check`: three to 254 characters, trimmed, and the address pattern below. */
export const INVOICE_CLIENT_EMAIL_LIMITS = Object.freeze({ min: 3, max: 254 });

/** The pattern `invoices_client_email_check` states, character for character. */
export const INVOICE_CLIENT_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$/u;

/** `invoices_client_address_check`: one to 600 characters, trimmed. */
export const INVOICE_CLIENT_ADDRESS_LIMITS = Object.freeze({ min: 1, max: 600 });

/** `invoices_memo_check`: one to 2000 characters, trimmed. */
export const INVOICE_MEMO_LIMITS = Object.freeze({ min: 1, max: 2_000 });

/** `invoice_items_description_check`: one to 300 characters, trimmed. */
export const INVOICE_ITEM_DESCRIPTION_LIMITS = Object.freeze({ min: 1, max: 300 });

/** `invoice_items_unit_check`: the same seven units as the catalogue, from `0020`. */
export const INVOICE_UNITS = ["item", "unit", "hour", "day", "week", "month", "project"] as const;

export type InvoiceUnit = (typeof INVOICE_UNITS)[number];

/** The unit a line takes when the merchant names none. */
export const INVOICE_DEFAULT_UNIT: InvoiceUnit = "item";

/** `invoice_items_quantity_check`: greater than zero and at most one million. */
export const INVOICE_QUANTITY_MINIMUM = 1_000; // one unit, in thousandths
export const INVOICE_QUANTITY_MAXIMUM = 1_000_000_000; // one million units, in thousandths

/**
 * How many decimals a quantity may carry.
 *
 * `0023` declares `quantity numeric(12,3)`, so three is the column's scale and a fourth decimal would
 * be silently rounded by the database into a quantity the merchant never typed. It is refused instead.
 */
export const INVOICE_QUANTITY_SCALE = 3;

/** One thousand: the factor between a quantity's typed decimal and its integer thousandths. */
export const INVOICE_QUANTITY_UNITS_PER_ONE = 1_000n;

/** `^\d{1,7}([.]\d{1,3})?$`: what a typed quantity may look like. Seven integer digits holds a million. */
export const INVOICE_QUANTITY_PATTERN = /^\d{1,7}([.]\d{1,3})?$/u;

/**
 * How many lines one invoice may carry in one request.
 *
 * A ceiling rather than a promise: every line is one row of one insert, and an invoice with a thousand
 * lines is a data import, not a document a person fills in. The number is generous for a real invoice
 * and small enough that the whole body stays inside the route's limit.
 */
export const INVOICE_MAXIMUM_LINES = 200;

/** How far in the future a due date may be: ten years, so a mistyped year is refused. */
export const INVOICE_DUE_MAXIMUM_DAYS = 3_650;

/** The tables of `0022` and `0023`. */
export const INVOICE_TABLE = "invoices";
export const INVOICE_ITEMS_TABLE = "invoice_items";

/** The money scale the price parser uses, restated here so the rounding rule is visible at the line. */
export const INVOICE_PRICE_SCALE = PRICE_SCALE;

/** True when `value` is one of the seven units. */
export function isInvoiceUnit(value: unknown): value is InvoiceUnit {
  return typeof value === "string" && (INVOICE_UNITS as readonly string[]).includes(value);
}

/** True when `value` is one of the statuses. */
export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === "string" && (INVOICE_STATUSES as readonly string[]).includes(value);
}
