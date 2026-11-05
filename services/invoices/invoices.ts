// path: services/invoices/invoices.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import { sanitizeMultilineText, sanitizeSingleLineText } from "../../lib/security/text.ts";
import { CLIENT_MANAGE_ROLES, getClient } from "../clients/clients.ts";
import { priceColumnSchema, priceFromMinor, priceProblemOf, priceToMinor } from "../products/price.ts";
import {
  INVOICE_CLIENT_ADDRESS_LIMITS,
  INVOICE_CLIENT_EMAIL_LIMITS,
  INVOICE_CLIENT_EMAIL_PATTERN,
  INVOICE_CLIENT_NAME_LIMITS,
  INVOICE_CREATED_STATUS,
  INVOICE_CURRENCIES,
  INVOICE_DEFAULT_UNIT,
  INVOICE_DUE_MAXIMUM_DAYS,
  INVOICE_ITEM_DESCRIPTION_LIMITS,
  INVOICE_ITEMS_TABLE,
  INVOICE_MAXIMUM_LINES,
  INVOICE_MEMO_LIMITS,
  INVOICE_QUANTITY_MAXIMUM,
  INVOICE_QUANTITY_MINIMUM,
  INVOICE_QUANTITY_PATTERN,
  INVOICE_TABLE,
  INVOICE_UNITS,
  isInvoiceUnit,
  type InvoiceUnit,
} from "./invoice-fields.ts";
import {
  grossLineMinor,
  quantityToThousandths,
  subtotalOf,
  thousandthsToQuantity,
} from "./invoice-totals.ts";
import {
  basisPointsToColumn,
  basisPointsToPercent,
  DISCOUNT_DEFAULT_BASIS,
  discountStateOf,
  isDiscountBasis,
  percentDiscountMinor,
  percentToBasisPoints,
  resolveDiscount,
  type DiscountBasis,
} from "./invoice-discount.ts";

/**
 * Section 16's invoice create: the document of `0022` with the lines of `0023`, written as one draft.
 *
 * ## What this STEP owns, and what it deliberately does not
 *
 * The create form draws a client and a list of lines and stores a **draft**. Everything else section 16
 * describes - the number, the seven-status workflow, sending, voiding, editing a draft's lines, the PDF -
 * belongs to a later STEP, and `0022` is written to allow exactly that: a draft is the only shape whose
 * `number` and `issued_at` are both null, so a create that wrote any other status would be inventing a
 * number it has no counter for. `invoices_issue_check` is quoted in the handoff as the reason.
 *
 * ## Why the lines are one insert and not a loop
 *
 * Rule 17 forbids a query in a loop, and a line list is the obvious place to break it. The invoice row
 * is inserted first, because `invoice_items.invoice_id` is a foreign key that needs a parent; the lines
 * then go in **one** insert of N rows, with the parent's `subtotal_minor` left at its default and
 * recomputed by `invoice_items_sync_totals` on each row's insert. The trigger is the authority for the
 * subtotal, so this module never sends a money total the database did not derive.
 *
 * That means a create is not atomic across the two statements: if the lines insert fails, the invoice
 * row is already there. It is removed rather than left behind, which is the next paragraph.
 *
 * ## Why a failed line insert removes the invoice instead of leaving an empty draft
 *
 * PostgREST over HTTP has no transaction that spans two requests, so the compensating action is the
 * only honest option: a soft delete of the row just written, scoped to the company, with an audit entry
 * that says it happened. Leaving the row would put an invoice with no lines in the merchant's list for
 * a request that reported failure, and a merchant who clicked save twice would collect two of them.
 * A soft delete keeps the row readable for an investigation, which a hard delete would not.
 *
 * ## The client is read, never trusted
 *
 * The body carries a `client_id`, and every printed field - name, email, address - is read from the
 * merchant's own client book through `getClient`, which applies the role and the company scope. The
 * snapshot columns of `0022` exist so a sent invoice keeps the bytes it printed; letting the body supply
 * them would let a crafted request print a different name on the merchant's letterhead than the one in
 * their client book.
 *
 * ## The money
 *
 * Every amount is parsed by `price.ts` into `bigint` minor units with decimal string arithmetic and no
 * float, and the quantity by `invoice-totals.ts` into integer thousandths. The line total, the subtotal
 * and the total are computed for the answer by `invoice-totals.ts`, which restates the generated column's
 * rule; the stored values are the database's.
 */

/** The audit action of a create. */
export const INVOICE_CREATED_AUDIT_ACTION = "invoice.created";

/** The audit action of the compensating removal described above. */
export const INVOICE_ABANDONED_AUDIT_ACTION = "invoice.abandoned";

/** The audit entity of both. */
export const INVOICE_AUDIT_ENTITY = "invoice";

/**
 * Who may write an invoice.
 *
 * The same role that manages the client book and the catalogue, because an invoice is a document made
 * out of those two: an account that may not read a client must not be able to bill one either. Section
 * 25 gives the merchant's invoices to its owner; the office roles act through the approval chain, not
 * by writing into a merchant's book.
 */
export const INVOICE_MANAGE_ROLES: readonly PlatformRole[] = Object.freeze([
  "owner",
] as const satisfies readonly PlatformRole[]);

/** The rule vocabulary this service answers with, for the form's sentences. */
export const INVOICE_RULES = [
  "required",
  "too_short",
  "too_long",
  "invalid_format",
  "too_large",
  "too_small",
  "unknown_field",
  "not_found",
  "too_many",
  "empty",
  "due_before_issue",
] as const;

/**
 * One printed line, as the screen sees it.
 *
 * ## Why every money field is text
 *
 * A `bigint` is not JSON. `JSON.stringify` throws on one, so a document that carried its amounts as
 * `bigint` would answer every successful create with a 500 - a failure the stub-free gates cannot reach,
 * because they never serialise a response. So the snapshot carries each amount twice: the exact count of
 * minor units as a decimal **string**, which is what a caller does arithmetic on, and the printed major
 * units, which is what the screen shows. Nothing is rounded on the way out; `priceFromMinor` prints the
 * scale the column stores.
 */
export interface InvoiceLineSnapshot {
  readonly id: string;
  /** One based, and the order the invoice prints in. */
  readonly position: number;
  readonly description: string;
  readonly unit: InvoiceUnit;
  /** The typed quantity, printed back the way it was typed: `2.5`, `1`, `0.25`. */
  readonly quantity: string;
  readonly unitPrice: string;
  /** Minor units as decimal text, because a `bigint` cannot cross JSON. */
  readonly unitPriceMinor: string;
  readonly discount: string;
  readonly discountMinor: string;
  /** `(quantity * unit_price)::bigint - discount`, in minor units, as decimal text. */
  readonly lineTotalMinor: string;
  /** The catalogue entry the line quoted, if any. At most one of the two is set. */
  readonly productId: string | null;
  readonly serviceId: string | null;
}

/** One invoice as a screen sees it. */
export interface InvoiceSnapshot {
  readonly id: string;
  readonly companyId: string;
  readonly clientId: string;
  /** Always a draft: this STEP writes no other status. */
  readonly status: string;
  readonly currency: string;
  readonly client: {
    readonly name: string;
    readonly email: string | null;
    readonly address: string | null;
  };
  readonly memo: string | null;
  readonly dueAt: string;
  readonly lines: readonly InvoiceLineSnapshot[];
  /** Each amount as decimal minor units beside its printed form, for the same reason a line does. */
  readonly totals: {
    readonly subtotal: string;
    readonly subtotalMinor: string;
    readonly discount: string;
    readonly discountMinor: string;
    /** How the discount was expressed, so the editor can reopen the box the merchant actually filled. */
    readonly discountBasis: DiscountBasis;
    /** The percentage in basis points; zero unless the basis is `percent`. */
    readonly discountPercentBasisPoints: number;
    /** The same percentage as the text the screen prints: `12.5`, `10`, `1.25`. */
    readonly discountPercent: string;
    readonly tax: string;
    readonly taxMinor: string;
    readonly total: string;
    readonly totalMinor: string;
  };
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

export interface InvoiceDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** The row shape of `0022`, validated on every read. */
export const invoiceRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  client_id: z.string().uuid(),
  number: z.string().nullable(),
  status: z.string().min(1),
  currency: z.string().length(3),
  subtotal_minor: priceColumnSchema,
  discount_minor: priceColumnSchema,
  discount_basis: z.string(),
  discount_percent_bp: z.number().int(),
  tax_minor: priceColumnSchema,
  total_minor: priceColumnSchema,
  amount_paid_minor: priceColumnSchema,
  client_name: z.string().min(1).max(160),
  client_email: z.string().max(254).nullable(),
  client_address: z.string().max(600).nullable(),
  memo: z.string().max(2_000).nullable(),
  issued_at: z.string().nullable(),
  due_at: z.string().min(1),
  first_viewed_at: z.string().nullable(),
  paid_at: z.string().nullable(),
  voided_at: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullable(),
  version: z.number().int().min(1),
});

type InvoiceRow = z.infer<typeof invoiceRowSchema>;

/**
 * The row shape of `0023`, validated on every read.
 *
 * `quantity` arrives as the decimal text of `numeric(12,3)` and `line_total_minor` is a generated column
 * the database computes, so both are read rather than written. `product_id` and `service_id` are
 * `num_nonnulls(...) <= 1` by the migration, which the schema states as the same rule.
 */
export const invoiceItemRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  position: z.number().int().min(1),
  description: z.string().min(1).max(300),
  unit: z.enum(INVOICE_UNITS),
  quantity: z.string().min(1),
  unit_price_minor: priceColumnSchema,
  discount_minor: priceColumnSchema,
  line_total_minor: priceColumnSchema,
  product_id: z.string().uuid().nullable(),
  service_id: z.string().uuid().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullable(),
  version: z.number().int().min(1),
});

type InvoiceItemRow = z.infer<typeof invoiceItemRowSchema>;

/** The columns a read selects, listed one by one: rule 17, and never a `*`. */
const INVOICE_ROW_COLUMNS =
  "select=id,company_id,client_id,number,status,currency,subtotal_minor,discount_minor,discount_basis,discount_percent_bp,tax_minor,total_minor,amount_paid_minor,client_name,client_email,client_address,memo,issued_at,due_at,first_viewed_at,paid_at,voided_at,created_at,updated_at,deleted_at,version";

const INVOICE_ITEM_COLUMNS =
  "select=id,company_id,invoice_id,position,description,unit,quantity,unit_price_minor,discount_minor,line_total_minor,product_id,service_id,created_at,updated_at,deleted_at,version";

/**
 * One line of the body, by *shape* only.
 *
 * Every field is a string and nothing here judges one, because the semantic pass below must see all
 * seven of them at once: a schema that refused a blank description would stop before the quantity was
 * checked, and the merchant would fix one box per save on a list of twenty rows. Strict, so a key an
 * invoice does not have is reported rather than silently dropped.
 */
export const invoiceLineInputSchema = z
  .object({
    description: z.string(),
    unit: z.string(),
    quantity: z.string(),
    unit_price: z.string(),
    discount: z.string().nullish(),
    product_id: z.string().nullish(),
    service_id: z.string().nullish(),
  })
  .strict();

/**
 * The body of a create.
 *
 * `client_id` and `due_at` are required, the currency defaults to the only one the platform bills in,
 * and the lines are required and bounded. `status` is deliberately absent: a create writes a draft, and
 * accepting a status from the body would let a caller skip the workflow it has no number for.
 */
export const invoiceCreateSchema = z
  .object({
    client_id: z.string(),
    currency: z.string().nullish(),
    due_at: z.string(),
    memo: z.string().nullish(),
    discount: z.string().nullish(),
    // `percent` makes `discount` a percentage rather than money. Omitted means `amount`, which is what
    // every caller before STEP 114 sent.
    discount_basis: z.string().nullish(),
    tax: z.string().nullish(),
    lines: z.array(invoiceLineInputSchema),
  })
  .strict();

/** The parsed body, with every amount already converted. */
interface InvoiceInput {
  readonly clientId: string;
  readonly currency: string;
  readonly dueAt: string;
  readonly memo: string | null;
  readonly discountMinor: bigint;
  /** `amount` keeps `discountMinor` as the money; `percent` makes `discountBasisPoints` the instruction. */
  readonly discountBasis: DiscountBasis;
  readonly discountBasisPoints: bigint;
  readonly taxMinor: bigint;
  readonly lines: readonly ParsedLine[];
}

/**
 * One line's values, parsed and converted.
 *
 * Exported, with `parseInvoiceLine` below, for the line editor: an edited line must be judged by exactly
 * these seven rules, and a second parser in `invoice-lines.ts` would be the drift this codebase keeps
 * designing away from. The type is the seam - it carries thousandths and minor units, never text.
 */
export interface ParsedLine {
  readonly description: string;
  readonly unit: InvoiceUnit;
  readonly quantityThousandths: bigint;
  readonly unitPriceMinor: bigint;
  readonly discountMinor: bigint;
  readonly productId: string | null;
  readonly serviceId: string | null;
}

/** The order fields are reported in, so a form marks the boxes top to bottom. */
const FIELD_ORDER = [
  "client_id",
  "currency",
  "due_at",
  "memo",
  "discount_basis",
  "discount",
  "tax",
  "lines",
] as const;

/** One line's fields, in the order the line reads left to right on the screen. */
const LINE_FIELD_ORDER = [
  "description",
  "unit",
  "quantity",
  "unit_price",
  "discount",
  "product_id",
  "service_id",
] as const;

/**
 * The field name a detail is reported under.
 *
 * A line's problem is named `lines[2].unit_price`, so the form can mark the right box on the right row
 * instead of a single "line items" error above a list of twenty. Index zero is included: the dots are
 * what the screen splits on, and a first row that read `lines.unit_price` would need a second rule.
 */
function detailPath(index: number | null, field: string): string {
  return index === null ? field : `lines[${String(index)}].${field}`;
}

/**
 * Parse one line of a document body, naming every broken field of that line.
 *
 * A line is seven independent judgements - the description, the unit, the quantity, the price, the
 * discount and the two catalogue references - and stopping at the first would make the merchant fix
 * one box per save on a list of twenty rows. Each is evaluated, the first rule per field wins.
 *
 * ## Why a quote parses its lines here
 *
 * Exported for `services/estimates/`, which writes the quote of the same section. `0026` mirrors `0023`
 * exactly - the same seven columns under the same checks, down to the generated `line_total_minor` - so
 * a quote's line is judged by these seven rules and not by a copy of them. This repository states that
 * rule as a check: `verify.ts` asserts the line service defines no second parser, and a parser in another
 * folder for the same columns is the drift that assertion exists to prevent. The name says "document"
 * rather than "invoice" because both documents are what it parses a line of.
 */
export function parseDocumentLine(
  raw: z.infer<typeof invoiceLineInputSchema>,
  index: number,
): { readonly line: ParsedLine | null; readonly problems: readonly ErrorDetail[] } {
  const problems: ErrorDetail[] = [];
  const description = sanitizeSingleLineText(raw.description.trim(), INVOICE_ITEM_DESCRIPTION_LIMITS.max);

  if (description.length < INVOICE_ITEM_DESCRIPTION_LIMITS.min) {
    problems.push({ field: detailPath(index, "description"), rule: "required" });
  }

  if (!isInvoiceUnit(raw.unit)) {
    problems.push({ field: detailPath(index, "unit"), rule: "invalid_format" });
  }

  const quantityRaw = raw.quantity.trim();
  const quantityThousandths = quantityToThousandths(quantityRaw);

  if (quantityThousandths === null) {
    problems.push({ field: detailPath(index, "quantity"), rule: "invalid_format" });
  } else if (quantityThousandths < INVOICE_QUANTITY_MINIMUM) {
    // `invoice_items_quantity_check` is `> 0`, so a zero quantity is refused as too small rather than as
    // a malformed number: the merchant typed a number, it just is not one an invoice can print.
    problems.push({ field: detailPath(index, "quantity"), rule: "too_small" });
  } else if (quantityThousandths > INVOICE_QUANTITY_MAXIMUM) {
    problems.push({ field: detailPath(index, "quantity"), rule: "too_large" });
  }

  const priceRaw = raw.unit_price.trim();
  const unitPriceMinor = priceToMinor(priceRaw);

  if (unitPriceMinor === null) {
    problems.push({
      field: detailPath(index, "unit_price"),
      rule: priceProblemOf(priceRaw) === "too_large" ? "too_large" : "invalid_format",
    });
  }

  const discountRaw = (raw.discount ?? "").trim();
  const discountMinor = discountRaw.length === 0 ? 0n : priceToMinor(discountRaw);

  if (discountMinor === null) {
    problems.push({
      field: detailPath(index, "discount"),
      rule: priceProblemOf(discountRaw) === "too_large" ? "too_large" : "invalid_format",
    });
  }

  for (const key of ["product_id", "service_id"] as const) {
    const value = (raw[key] ?? "").trim();

    if (value.length > 0 && !z.string().uuid().safeParse(value).success) {
      problems.push({ field: detailPath(index, key), rule: "invalid_format" });
    }
  }

  const productId = (raw.product_id ?? "").trim();
  const serviceId = (raw.service_id ?? "").trim();

  if (productId.length > 0 && serviceId.length > 0) {
    // `invoice_items_source_check`: at most one catalogue reference per line.
    problems.push({ field: detailPath(index, "service_id"), rule: "invalid_format" });
  }

  if (quantityThousandths === null || unitPriceMinor === null || discountMinor === null || !isInvoiceUnit(raw.unit)) {
    return { line: null, problems };
  }

  // The discount ceiling is the rounded gross, which is what the generated column subtracts from - the
  // same function the totals use, so the ceiling and the total can never be computed two ways.
  if (discountMinor > grossLineMinor({ quantityThousandths, unitPriceMinor })) {
    problems.push({ field: detailPath(index, "discount"), rule: "too_large" });
  }

  if (problems.length > 0) {
    return { line: null, problems };
  }

  return {
    line: {
      description,
      unit: raw.unit,
      quantityThousandths,
      unitPriceMinor,
      discountMinor,
      productId: productId.length === 0 ? null : productId,
      serviceId: serviceId.length === 0 ? null : serviceId,
    },
    problems: [],
  };
}

/**
 * Parse one line from an editor's body, naming every broken field of it.
 *
 * The field names are bare - `unit_price`, not `lines[0].unit_price` - because an editor writes one line
 * and the screen has only one set of boxes to mark. The rules are `parseLine`'s, unchanged: the same
 * helper the create path runs over every line of a new invoice.
 */
export function parseInvoiceLine(body: unknown): ParsedLine {
  return parseDocumentLineBody(body);
}

/**
 * Parse one line of either document family from an editor's body.
 *
 * The invoice's `parseInvoiceLine` is this function, and a quote's editor calls it directly: the seven
 * fields, their ceilings and their rules are one definition (`invoiceLineInputSchema` and
 * `parseDocumentLine`), so an edited line of a quote is judged exactly as a created line of an invoice is.
 * A second parser for the second document would be the drift this codebase keeps designing away from.
 */
export function parseDocumentLineBody(body: unknown): ParsedLine {
  const attempt = invoiceLineInputSchema.safeParse(body);

  if (!attempt.success) {
    const problems: ErrorDetail[] = [];

    for (const issue of attempt.error.issues) {
      const field = String(issue.path[0] ?? "line");

      if (!problems.some((problem) => problem.field === field)) {
        problems.push({ field, rule: "invalid_format" });
      }
    }

    throw new AppError("VALIDATION_FAILED", { details: problems });
  }

  const parsed = parseDocumentLine(attempt.data, 0);

  if (parsed.line === null) {
    // The problems came back under `lines[0].field`; the editor wants the bare field, so the prefix is
    // stripped here rather than making the caller know how the create path names its rows.
    throw new AppError("VALIDATION_FAILED", {
      details: parsed.problems.map((problem) => ({
        field: problem.field.replace(/^lines\[0\][.]/u, ""),
        rule: problem.rule,
      })),
    });
  }

  return parsed.line;
}

/** The currency a body names, or the only one the platform bills in when it names none. */
function currencyOf(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();

  if (value.length === 0) {
    return INVOICE_CURRENCIES[0];
  }

  return (INVOICE_CURRENCIES as readonly string[]).includes(value) ? value : null;
}

/**
 * Parse a whole body into the values the rows are written with, naming every broken field at once.
 *
 * One pass, deliberately. The shape is checked first, because a body that is not an object cannot be
 * read field by field; after that every field is judged independently and the first rule per field
 * wins, so a mistyped client id and a mistyped price are reported together instead of one per save.
 * The order of the answer is the order the screen reads.
 */
function parseBody(body: unknown, now: number): InvoiceInput {
  const attempt = invoiceCreateSchema.safeParse(body);

  if (!attempt.success) {
    // Only a shape failure reaches here: a key an invoice does not have, or a field that is not a
    // string at all. Everything else is judged below, so this branch is narrow by construction.
    const problems = new Map<string, string>();

    for (const issue of attempt.error.issues) {
      const [head, second, third] = issue.path;

      const path =
        head === "lines"
          ? detailPath(typeof second === "number" ? second : null, typeof third === "string" ? third : "line")
          : String(head ?? "invoice");

      const rule = issue.code === "invalid_type" ? "invalid_format" : "invalid_format";

      if (!problems.has(path)) {
        problems.set(path, rule);
      }
    }

    const ordered: ErrorDetail[] = [];
    const remaining = [...problems.entries()].sort(([left], [right]) =>
      left.localeCompare(right, "en", { numeric: true }),
    );

    for (const [field, rule] of remaining) {
      ordered.push({ field, rule });
    }

    throw new AppError("VALIDATION_FAILED", { details: ordered });
  }

  const value = attempt.data;
  const problems: ErrorDetail[] = [];

  // The client the invoice is written for. A body with no client is a body that named none, which is a
  // refusal of its own rather than a malformed one.
  const clientId = value.client_id.trim();

  if (clientId.length === 0) {
    problems.push({ field: "client_id", rule: "required" });
  } else if (!z.string().uuid().safeParse(clientId).success) {
    problems.push({ field: "client_id", rule: "invalid_format" });
  }

  const currency = currencyOf(value.currency);

  if (currency === null) {
    problems.push({ field: "currency", rule: "invalid_format" });
  }

  const dueRaw = value.due_at.trim();
  const dueAtEpochMs = dueRaw.length === 0 ? Number.NaN : Date.parse(dueRaw);

  if (!Number.isFinite(dueAtEpochMs)) {
    problems.push({ field: "due_at", rule: dueRaw.length === 0 ? "required" : "invalid_format" });
  } else if (dueAtEpochMs - now > INVOICE_DUE_MAXIMUM_DAYS * 86_400_000) {
    problems.push({ field: "due_at", rule: "too_large" });
  }

  // The basis decides how `discount` is read: a flat amount of money, or a percentage of the subtotal.
  // A body that sends a basis this build does not know is malformed rather than defaulted, because
  // silently reading a percentage as dollars would overcharge every client of that merchant.
  const basisRaw = (value.discount_basis ?? "").trim();
  const discountBasis: DiscountBasis = basisRaw.length === 0 ? DISCOUNT_DEFAULT_BASIS : (basisRaw as DiscountBasis);

  if (basisRaw.length > 0 && !isDiscountBasis(basisRaw)) {
    problems.push({ field: "discount_basis", rule: "invalid_format" });
  }

  const discountRaw = (value.discount ?? "").trim();
  const invoiceDiscount =
    discountRaw.length === 0
      ? 0n
      : discountBasis === "percent"
        ? percentToBasisPoints(discountRaw)
        : priceToMinor(discountRaw);

  if (invoiceDiscount === null) {
    problems.push({
      field: "discount",
      rule:
        discountBasis === "percent"
          ? "invalid_format"
          : priceProblemOf(discountRaw) === "too_large"
            ? "too_large"
            : "invalid_format",
    });
  }

  // A percentage is resolved against the subtotal once the lines are known, so the money is not carried
  // here; the basis points are. The two travel together so a row is never written with one but not the
  // other.
  const discountBasisPoints = discountBasis === "percent" ? (invoiceDiscount ?? 0n) : 0n;

  const taxRaw = (value.tax ?? "").trim();
  const taxMinor = taxRaw.length === 0 ? 0n : priceToMinor(taxRaw);

  if (taxMinor === null) {
    problems.push({
      field: "tax",
      rule: priceProblemOf(taxRaw) === "too_large" ? "too_large" : "invalid_format",
    });
  }

  if (value.lines.length === 0) {
    // A merchant who has not added a line needs a sentence about adding one, not a rule about arrays.
    problems.push({ field: "lines", rule: "empty" });
  } else if (value.lines.length > INVOICE_MAXIMUM_LINES) {
    problems.push({ field: "lines", rule: "too_many" });
  }

  const lines: ParsedLine[] = [];

  for (const [index, raw] of value.lines.entries()) {
    const parsed = parseDocumentLine(raw, index);

    problems.push(...parsed.problems);

    if (parsed.line !== null) {
      lines.push(parsed.line);
    }
  }

  if (problems.length === 0 && invoiceDiscount !== null && taxMinor !== null) {
    const subtotal = subtotalOf(lines);

    // `invoices_discount_check`: an invoice-level discount never exceeds what the lines add up to. A
    // percentage is resolved first, because the resolved money is what the check actually sees; at most a
    // hundred percent it can never exceed the subtotal, but it goes through the same function the service
    // uses so there is exactly one answer to what a percentage is worth.
    const resolvedDiscount = resolveDiscount({
      basis: discountBasis,
      basisPoints: discountBasisPoints,
      amountMinor: invoiceDiscount,
      subtotalMinor: subtotal,
    });

    if (resolvedDiscount > subtotal) {
      problems.push({ field: "discount", rule: "too_large" });
    } else if (subtotal - resolvedDiscount + taxMinor < 0n) {
      problems.push({ field: "discount", rule: "too_large" });
    }
  }

  if (problems.length > 0 || invoiceDiscount === null || taxMinor === null || currency === null) {
    throw new AppError("VALIDATION_FAILED", { details: orderDetails(problems) });
  }

  const memo = (value.memo ?? "").trim();
  const sanitisedMemo = memo.length === 0 ? null : sanitizeMultilineText(memo, INVOICE_MEMO_LIMITS.max);

  return {
    clientId,
    currency,
    dueAt: new Date(dueAtEpochMs).toISOString(),
    memo: sanitisedMemo === null || sanitisedMemo.length === 0 ? null : sanitisedMemo,
    discountMinor: invoiceDiscount,
    discountBasis,
    discountBasisPoints,
    taxMinor,
    lines,
  };
}

/**
 * Sort a document's refusals the way its screen reads them.
 *
 * The document's own fields first, in the order they appear on the page, then the lines in the order they
 * were typed with each line's boxes left to right. A plain string sort would put `lines[10]` before
 * `lines[2]`, so the comparison is numeric on the index.
 *
 * ## Why the two orders are parameters
 *
 * Exported for `services/estimates/`, which reports a quote's refusals the same way and differs only in
 * the field list - `expires_at` where an invoice has `due_at`. The sorting rule is one fact and the field
 * order is each document's, so the rule is written once and each document passes its own list.
 */
export function orderDocumentDetails(
  problems: readonly ErrorDetail[],
  fieldOrder: readonly string[],
  lineFieldOrder: readonly string[],
): readonly ErrorDetail[] {
  const rankOf = (field: string): number => {
    const index = fieldOrder.indexOf(field);

    return index === -1 ? fieldOrder.length : index;
  };

  const lineRankOf = (field: string): readonly [number, number] => {
    const match = /^lines\[(\d+)\][.]([A-Za-z_]+)$/u.exec(field);

    if (match === null) {
      return [Number.MAX_SAFE_INTEGER, 0];
    }

    const position = lineFieldOrder.indexOf(match[2] ?? "");

    return [Number.parseInt(match[1] ?? "0", 10), position === -1 ? lineFieldOrder.length : position];
  };

  return [...problems].sort((left, right) => {
    const leftIsLine = left.field.startsWith("lines[");
    const rightIsLine = right.field.startsWith("lines[");

    if (leftIsLine !== rightIsLine) {
      return leftIsLine ? 1 : -1;
    }

    if (leftIsLine) {
      const [leftIndex, leftPosition] = lineRankOf(left.field);
      const [rightIndex, rightPosition] = lineRankOf(right.field);

      return leftIndex === rightIndex ? leftPosition - rightPosition : leftIndex - rightIndex;
    }

    return rankOf(left.field) - rankOf(right.field);
  });
}

/** The invoice's own order: `0022`'s fields as the create form reads them, then the lines. */
function orderDetails(problems: readonly ErrorDetail[]): readonly ErrorDetail[] {
  return orderDocumentDetails(problems, FIELD_ORDER, LINE_FIELD_ORDER);
}

/**
 * The `subtotal_minor` a stored invoice currently holds.
 *
 * Read rather than computed, and deliberately so: after `invoice_items_sync_totals` has run it is the
 * database's answer to what the lines add up to, and a percentage discount must be a share of that number
 * rather than of a second opinion. The read is scoped to the company as well as the id, so it cannot
 * describe another merchant's document.
 */
async function readSubtotalMinor(rest: RestClient, invoiceId: string, companyId: string): Promise<bigint> {
  const rows = await rest.select(
    INVOICE_TABLE,
    `select=id,subtotal_minor&id=eq.${invoiceId}&company_id=eq.${companyId}&deleted_at=is.null`,
    invoiceSubtotalRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice", reason: "not_found" } });
  }

  return row.subtotal_minor;
}

/** The one column the discount resolution needs from the parent row. */
const invoiceSubtotalRowSchema = z.object({
  id: z.string().uuid(),
  subtotal_minor: priceColumnSchema,
});

/** The client snapshot's single address line, joined from the book's five address columns. */
/**
 * The printed address of a client book row, as one document snapshot column.
 *
 * Exported for `services/estimates/`, because `0025`'s `estimates_client_address_check` states `0022`'s
 * `invoices_client_address_check` character for character - one to 600 characters, trimmed - and a quote
 * prints the same client through the same six columns in the same order. Two ways of assembling one
 * address is two documents that disagree about what a client's address looks like.
 */
export function addressOf(values: Readonly<Record<string, string | null>>): string | null {
  const parts = [
    values["address_line1"],
    values["address_line2"],
    values["city"],
    values["region"],
    values["postal_code"],
    values["country"],
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  const joined = parts.join(", ");

  return joined.length === 0 ? null : sanitizeMultilineText(joined, INVOICE_CLIENT_ADDRESS_LIMITS.max);
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}

/** The role and the company, read from the session and never from the body. */
function requireInvoiceActor(actor: RequestActor): string {
  requireAnyRole(actor, INVOICE_MANAGE_ROLES);

  return requireCompanyId(actor);
}

function lineSnapshotOf(row: InvoiceItemRow): InvoiceLineSnapshot {
  return {
    id: row.id,
    position: row.position,
    description: row.description,
    unit: row.unit,
    // The stored decimal printed back without its trailing zeros: 2.500 becomes 2.5, 1.000 becomes 1.
    quantity: thousandthsToQuantity(quantityToThousandths(row.quantity) ?? 0n),
    unitPrice: priceFromMinor(row.unit_price_minor),
    unitPriceMinor: row.unit_price_minor.toString(),
    discount: priceFromMinor(row.discount_minor),
    discountMinor: row.discount_minor.toString(),
    lineTotalMinor: row.line_total_minor.toString(),
    productId: row.product_id,
    serviceId: row.service_id,
  };
}

function snapshotOf(row: InvoiceRow, lines: readonly InvoiceItemRow[]): InvoiceSnapshot {
  return {
    id: row.id,
    companyId: row.company_id,
    clientId: row.client_id,
    status: row.status,
    currency: row.currency,
    client: { name: row.client_name, email: row.client_email, address: row.client_address },
    memo: row.memo,
    dueAt: row.due_at,
    lines: lines.map((line) => lineSnapshotOf(line)),
    totals: {
      subtotal: priceFromMinor(row.subtotal_minor),
      subtotalMinor: row.subtotal_minor.toString(),
      discount: priceFromMinor(row.discount_minor),
      discountMinor: row.discount_minor.toString(),
      discountBasis: discountStateOf(row).basis,
      discountPercentBasisPoints: row.discount_percent_bp,
      discountPercent: basisPointsToPercent(BigInt(row.discount_percent_bp)),
      tax: priceFromMinor(row.tax_minor),
      taxMinor: row.tax_minor.toString(),
      total: priceFromMinor(row.total_minor),
      totalMinor: row.total_minor.toString(),
    },
    version: row.version,
    createdAtEpochMs: Date.parse(row.created_at),
    updatedAtEpochMs: Date.parse(row.updated_at),
  };
}

/** The rows of `0023` for one invoice, newest position last, live only. */
async function readLines(
  rest: RestClient,
  companyId: string,
  invoiceId: string,
): Promise<readonly InvoiceItemRow[]> {
  return rest.select(
    INVOICE_ITEMS_TABLE,
    `${INVOICE_ITEM_COLUMNS}&invoice_id=eq.${invoiceId}&company_id=eq.${companyId}&deleted_at=is.null&order=position.asc`,
    invoiceItemRowSchema,
  );
}

/**
 * Create one draft invoice for one of the actor's own clients.
 *
 * The steps, in order, because the order is the security:
 *
 *   1. the role and the company, from the session;
 *   2. the body, validated with Zod and every amount converted without a float;
 *   3. the client, read from the book through `getClient`, which applies the same role and scope - so a
 *      client id belonging to another merchant is the same 404 an unknown one gets;
 *   4. the invoice row, inserted with the client's snapshot and the currency;
 *   5. the lines, in one insert, with the parent's subtotal left to the trigger;
 *   6. the invoice-level discount, in a second write, because the check that bounds it compares it to a
 *      subtotal that only exists once the lines do (the note beside the write explains this);
 *   7. the audit entry, then the re-read that returns what the database actually stored.
 *
 * A failure at step 5 removes the row from step 4 and rethrows, because a draft with no lines is not a
 * document and must not sit in the merchant's list behind an error message.
 */
export async function createInvoice(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: InvoiceDependencies,
): Promise<InvoiceSnapshot> {
  const companyId = requireInvoiceActor(input.actor);
  const now = dependencies.now?.() ?? Date.now();
  const values = parseBody(input.body, now);

  // The client comes from the book, never from the body: the printed name is the book's name.
  const client = await getClient(
    { actor: input.actor, clientId: values.clientId },
    { rest: dependencies.rest, audit: dependencies.audit, ...(dependencies.now === undefined ? {} : { now: dependencies.now }) },
  );
  const clientEmail = client.values["email"];
  const clientName = client.values["name"];
  const clientAddress = addressOf(client.values);

  // `0019` requires a name, so a book row without one is a row this service will not print rather than
  // a cast to satisfy the type. It is reported against the client the form chose.
  if (clientName === null || clientName.length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "client_id", rule: "invalid_format" }] });
  }

  if (
    clientEmail !== null &&
    (clientEmail.length < INVOICE_CLIENT_EMAIL_LIMITS.min ||
      clientEmail.length > INVOICE_CLIENT_EMAIL_LIMITS.max ||
      !INVOICE_CLIENT_EMAIL_PATTERN.test(clientEmail))
  ) {
    // `invoices_client_email_check` is stricter than the client book's optional email, so an address
    // the book holds but the invoice cannot print is refused before the insert rather than as a 422
    // from PostgREST with no field to point at.
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "client_id", rule: "invalid_format" }],
    });
  }

  const newRow: Record<string, unknown> = {
    company_id: companyId,
    client_id: values.clientId,
    status: INVOICE_CREATED_STATUS,
    currency: values.currency,
    // The invoice-level discount is deliberately **not** written here; see the note below the insert.
    discount_minor: 0n,
    tax_minor: values.taxMinor,
    client_name: sanitizeSingleLineText(clientName, INVOICE_CLIENT_NAME_LIMITS.max),
    client_email: clientEmail,
    client_address: clientAddress,
    memo: values.memo,
    due_at: values.dueAt,
  };

  let invoice: InvoiceRow;

  try {
    const [row] = await dependencies.rest.insertReturning(INVOICE_TABLE, [newRow], invoiceRowSchema);

    if (row === undefined) {
      throw new AppError("INTERNAL_ERROR", { cause: { rule: "invoice", reason: "insert_returned_no_row" } });
    }

    invoice = row;
  } catch (error) {
    if (isConflictError(error)) {
      throw new AppError("CONFLICT", { details: [{ field: "client_id", rule: "already_used" }] });
    }

    throw error;
  }

  const lineRows = values.lines.map((line, index) => ({
    company_id: companyId,
    invoice_id: invoice.id,
    position: index + 1,
    description: line.description,
    unit: line.unit,
    // `numeric(12,3)` takes a decimal quantity, not the integer thousandths this module carries: the
    // column would read 2500 as two thousand five hundred units, not as two and a half. The conversion is
    // the engine's, so the text sent is the text the form typed.
    quantity: thousandthsToQuantity(line.quantityThousandths),
    unit_price_minor: line.unitPriceMinor,
    discount_minor: line.discountMinor,
    product_id: line.productId,
    service_id: line.serviceId,
  }));

  try {
    await dependencies.rest.insert(INVOICE_ITEMS_TABLE, lineRows);
  } catch (error) {
    await abandon(dependencies, {
      companyId,
      actor: input.actor,
      invoiceId: invoice.id,
      reason: error instanceof AppError ? error.code.toLowerCase() : "unknown",
    });

    // A catalogue reference from another merchant is refused by `invoice_items_guard_catalogue` as an
    // integrity violation, which the REST layer reports as VALIDATION_FAILED. Naming the line is this
    // module's job because the trigger cannot: it raises one exception for the whole statement.
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      throw new AppError("VALIDATION_FAILED", {
        details: lineRows.map((row, index) => ({
          field: detailPath(index, row.product_id === null ? "service_id" : "product_id"),
          rule: "not_found" as const,
        })),
      });
    }

    throw error;
  }

  // The invoice-level discount is a second write, and the schema is why.
  //
  // `0022` states `invoices_discount_check: discount_minor <= subtotal_minor`, and a row is checked on
  // insert. At that moment the invoice has no lines, so `subtotal_minor` is still its default of zero -
  // which means any discount at all would violate the check. The subtotal only becomes non-zero after
  // `invoice_items_sync_totals` has fired for the lines. So the discount is applied once the lines
  // exist, which is the only order in which the discount can be both bounded by the subtotal and set
  // on the same document. Applying it here also means `invoices_derive_total` recomputes the total
  // from the two values that are now both correct.
  if (values.discountMinor > 0n) {
    // A percentage is resolved against the subtotal the trigger has just written, so the money stored is
    // the share the merchant asked for on the lines as they actually landed. A flat amount is the money
    // the merchant typed. Either way the basis travels in the same update as the money, so a row never
    // holds one without the other and `invoices_discount_basis_coherent_check` is satisfied by
    // construction rather than by a second statement that could fail alone.
    const resolvedDiscount =
      values.discountBasis === "percent"
        ? percentDiscountMinor({
            subtotalMinor: await readSubtotalMinor(dependencies.rest, invoice.id, companyId),
            basisPoints: values.discountBasisPoints,
          })
        : values.discountMinor;

    try {
      await dependencies.rest.update(
        INVOICE_TABLE,
        `id=eq.${invoice.id}&company_id=eq.${companyId}&status=eq.${INVOICE_CREATED_STATUS}`,
        {
          discount_minor: resolvedDiscount,
          discount_basis: values.discountBasis,
          discount_percent_bp: basisPointsToColumn(values.discountBasisPoints),
        },
      );
    } catch (error) {
      await abandon(dependencies, {
        companyId,
        actor: input.actor,
        invoiceId: invoice.id,
        reason: error instanceof AppError ? error.code.toLowerCase() : "unknown",
      });

      throw error;
    }
  }

  // The subtotal, discount and total are the database's; the re-read is what returns them rather than a
  // number computed here.
  const stored = await getInvoice({ actor: input.actor, invoiceId: invoice.id }, dependencies);

  await appendTolerated(dependencies.audit, {
    action: INVOICE_CREATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: INVOICE_AUDIT_ENTITY,
    entityId: invoice.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      // Field names and counts, never the client's name, the memo or a line's description: an invoice
      // is a commercial document and the trail is not the place to copy it.
      fields: ["client_id", "currency", "due_at", "memo", "discount", "tax", "lines"],
      line_count: lineRows.length,
      total_minor: stored.totals.totalMinor,
      currency: stored.currency,
    },
  });

  return stored;
}

/**
 * Remove an invoice row this request wrote, because its lines could not be written.
 *
 * A soft delete rather than a hard one: `0022` keeps a deleted invoice readable because payments point
 * at it, and the same reasoning applies to a row an investigator may need to see. Scoped to the company
 * like every other statement in this module, and audited, because it is a write.
 */
async function abandon(
  dependencies: InvoiceDependencies,
  input: {
    readonly companyId: string;
    readonly actor: RequestActor;
    readonly invoiceId: string;
    readonly reason: string;
  },
): Promise<void> {
  try {
    await dependencies.rest.update(
      INVOICE_TABLE,
      `id=eq.${input.invoiceId}&company_id=eq.${input.companyId}&status=eq.${INVOICE_CREATED_STATUS}`,
      { deleted_at: new Date(dependencies.now?.() ?? Date.now()).toISOString() },
    );
  } catch {
    // The compensating action failing must not replace the original failure the caller needs to see.
  }

  await appendTolerated(dependencies.audit, {
    action: INVOICE_ABANDONED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: INVOICE_AUDIT_ENTITY,
    entityId: input.invoiceId,
    companyId: input.companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: { reason: input.reason },
  });
}

/** Read one live invoice of the actor's own company, with its lines. */
export async function getInvoice(
  input: { readonly actor: RequestActor; readonly invoiceId: string },
  dependencies: InvoiceDependencies,
): Promise<InvoiceSnapshot> {
  const companyId = requireInvoiceActor(input.actor);

  if (!z.string().uuid().safeParse(input.invoiceId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
  }

  const rows = await dependencies.rest.select(
    INVOICE_TABLE,
    `${INVOICE_ROW_COLUMNS}&id=eq.${input.invoiceId}&company_id=eq.${companyId}&deleted_at=is.null`,
    invoiceRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice", reason: "not_found" } });
  }

  const lines = await readLines(dependencies.rest, companyId, row.id);

  return snapshotOf(row, lines);
}

/** A client the create form may bill: the id and the three facts the invoice prints. */
export interface InvoiceClientOption {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly city: string | null;
}

export interface InvoiceClientOptions {
  readonly clients: readonly InvoiceClientOption[];
  /** True when the book has more rows than this selector reads. */
  readonly truncated: boolean;
}

/**
 * How many clients the create form's selector reads.
 *
 * A select box is not a list screen: the merchant picks one client and wants the recent ones, and a
 * book of ten thousand names is a search problem the client list already solves. The ceiling is stated
 * to the merchant when it is reached rather than failing, and the client list is one link away.
 */
export const INVOICE_CLIENT_OPTION_LIMIT = 200;

const CLIENT_OPTION_COLUMNS = "select=id,name,email,city,created_at";

const clientOptionRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  email: z.string().max(254).nullable(),
  city: z.string().max(80).nullable(),
  created_at: z.string().min(1),
});

/**
 * The clients the create form may offer, newest first, capped.
 *
 * This reads one page of the merchant's own book and nothing else: the company comes from the session,
 * the deleted rows are excluded, and only the four columns the selector prints are selected. The role
 * is the client book's own, so an account that may not read the book is not offered a client to bill.
 */
export async function listInvoiceClientOptions(
  input: { readonly actor: RequestActor },
  dependencies: Pick<InvoiceDependencies, "rest">,
): Promise<InvoiceClientOptions> {
  requireAnyRole(input.actor, CLIENT_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);

  // One row more than the ceiling: that row is how the screen knows the book continues.
  const rows = await dependencies.rest.select(
    "clients",
    `${CLIENT_OPTION_COLUMNS}&company_id=eq.${companyId}&deleted_at=is.null&order=created_at.desc&limit=${String(INVOICE_CLIENT_OPTION_LIMIT + 1)}`,
    clientOptionRowSchema,
  );

  return {
    clients: rows.slice(0, INVOICE_CLIENT_OPTION_LIMIT).map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      city: row.city,
    })),
    truncated: rows.length > INVOICE_CLIENT_OPTION_LIMIT,
  };
}

/** What a line needs from the catalogue to be filled in one click. */
export interface InvoiceCatalogueOption {
  readonly id: string;
  readonly kind: "product" | "service";
  readonly name: string;
  readonly unit: string;
  readonly unitPrice: string;
}

export interface InvoiceCatalogueOptions {
  readonly entries: readonly InvoiceCatalogueOption[];
  readonly truncated: boolean;
}

/** How many catalogue entries the form's picker reads, per catalogue. */
export const INVOICE_CATALOGUE_OPTION_LIMIT = 100;

const catalogueOptionRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(160),
  unit_price_minor: priceColumnSchema,
  unit: z.string().min(1),
});

/**
 * The catalogue entries a line may quote, per kind, newest first, capped.
 *
 * A line may quote a product or a service and carries the id so reporting can follow the link; the
 * printed description, unit and price are the merchant's to change, which is why this returns them as
 * suggestions rather than as a stored reference. Read through the catalogue's own table and scoped to
 * the session's company, exactly as the catalogue screens read it.
 */
export async function listInvoiceCatalogueOptions(
  dependencies: Pick<InvoiceDependencies, "rest">,
  input: { readonly actor: RequestActor; readonly kind: "product" | "service" },
): Promise<InvoiceCatalogueOptions> {
  requireAnyRole(input.actor, CLIENT_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);
  const table = input.kind === "product" ? "products" : "services";

  const rows = await dependencies.rest.select(
    table,
    `select=id,name,unit_price_minor,unit&company_id=eq.${companyId}&deleted_at=is.null&order=created_at.desc&limit=${String(INVOICE_CATALOGUE_OPTION_LIMIT + 1)}`,
    catalogueOptionRowSchema,
  );

  return {
    entries: rows.slice(0, INVOICE_CATALOGUE_OPTION_LIMIT).map((row) => ({
      id: row.id,
      kind: input.kind,
      name: row.name,
      unit: row.unit,
      unitPrice: priceFromMinor(row.unit_price_minor),
    })),
    truncated: rows.length > INVOICE_CATALOGUE_OPTION_LIMIT,
  };
}

/** The line fields, exported so the gate can assert the form and the service agree on their order. */
export const INVOICE_LINE_FIELDS = LINE_FIELD_ORDER;

/** The money rules this module restates from the migrations, exported for the gate's assertions. */
export const INVOICE_MONEY_RULES = Object.freeze({
  quantityMinimum: INVOICE_QUANTITY_MINIMUM,
  quantityMaximum: INVOICE_QUANTITY_MAXIMUM,
  quantityPattern: INVOICE_QUANTITY_PATTERN,
  units: INVOICE_UNITS,
  defaultUnit: INVOICE_DEFAULT_UNIT,
});
