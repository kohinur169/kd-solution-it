// path: services/estimates/estimates.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import { sanitizeMultilineText, sanitizeSingleLineText } from "../../lib/security/text.ts";
import { getClient } from "../clients/clients.ts";
import { priceColumnSchema, priceFromMinor, priceProblemOf, priceToMinor } from "../products/price.ts";
import {
  INVOICE_CLIENT_EMAIL_LIMITS,
  INVOICE_CLIENT_EMAIL_PATTERN,
  INVOICE_CLIENT_NAME_LIMITS,
  INVOICE_MAXIMUM_LINES,
  INVOICE_MEMO_LIMITS,
  INVOICE_UNITS,
  type InvoiceUnit,
} from "../invoices/invoice-fields.ts";
import {
  quantityToThousandths,
  subtotalOf,
  thousandthsToQuantity,
} from "../invoices/invoice-totals.ts";
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
} from "../invoices/invoice-discount.ts";
import {
  addressOf,
  INVOICE_LINE_FIELDS,
  invoiceLineInputSchema,
  orderDocumentDetails,
  parseDocumentLine,
  type ParsedLine,
} from "../invoices/invoices.ts";
import {
  ESTIMATE_COLUMNS,
  ESTIMATE_CREATED_STATUS,
  ESTIMATE_CURRENCIES,
  ESTIMATE_EXPIRY_MAXIMUM_DAYS,
  ESTIMATE_ITEMS_TABLE,
  ESTIMATE_ITEM_COLUMNS,
  ESTIMATE_TABLE,
  isEstimateStatus,
  isEstimateVoidReason,
  type EstimateStatus,
  type EstimateVoidReason,
} from "./estimate-fields.ts";

/**
 * Section 16's quote: the document of `0025` with the lines of `0026`, written as one draft.
 *
 * ## What this STEP owns, and what it deliberately does not
 *
 * The create form draws a client, a list of lines and an expiry, and stores a **draft**. Everything else
 * section 16 describes for a quote - the number, sending it, the signature that accepts it, declining,
 * expiring, withdrawing, and the conversion into an invoice with a payment link - belongs to STEP 120 and
 * STEP 121, and `0025` is written to allow exactly those moves: a draft is the only shape whose `number`
 * and `issued_at` are both null, so a create that wrote any other status would be inventing a number it
 * has no counter for and an issue instant that never happened. `estimates_issue_check` is the reason, and
 * it is quoted here rather than worked around.
 *
 * ## Why a quote is not a second document engine
 *
 * `0025` derives the quote's total with the invoice's own `public.invoices_derive_total()`, and `0026`
 * says of its table that it "mirrors `invoice_items` exactly". This module takes the schema at its word:
 * the line parser, the money arithmetic, the discount bases, the refusal ordering and the printed client
 * address are all the invoice's, imported rather than copied, because a line of a quote is judged by the
 * same seven rules as a line of an invoice and a total is one identity in this codebase. What is the
 * quote's own is what `0025` makes the quote's own: five statuses instead of seven, a decision instead of
 * a payment, an expiry instead of a due date, and a reason for ending.
 *
 * ## Why the lines are one insert and not a loop
 *
 * Rule 17 forbids a query in a loop, and a line list is the obvious place to break it. The quote row is
 * inserted first, because `estimate_items.estimate_id` is a foreign key that needs a parent; the lines
 * then go in **one** insert of N rows, with the parent's `subtotal_minor` left at its default and
 * recomputed by `estimate_items_sync_totals` on each row's insert. The trigger is the authority for the
 * subtotal, so this module never sends a money total the database did not derive.
 *
 * That means a create is not atomic across the two statements: if the lines insert fails, the quote row is
 * already there. It is removed rather than left behind, which is the next paragraph.
 *
 * ## Why a failed line insert removes the quote instead of leaving an empty draft
 *
 * PostgREST over HTTP has no transaction that spans two requests, so the compensating action is the only
 * honest option: a soft delete of the row just written, scoped to the company, with an audit entry that
 * says it happened. Leaving the row would put a quote with no lines in the merchant's list for a request
 * that reported failure, and a merchant who clicked save twice would collect two of them. `0025` keeps a
 * deleted quote readable because its signature and its converted invoice point at it, so a soft delete is
 * also the only kind this schema allows.
 *
 * ## The client is read, never trusted
 *
 * The body carries a `client_id`, and every printed field - name, email, address - is read from the
 * merchant's own client book through `getClient`, which applies the role and the company scope. So a
 * client id belonging to another merchant is the same not-found an unknown one gets, and the snapshot
 * columns of `0025` exist so an accepted quote keeps the bytes a client signed against. Letting the body
 * supply them would let a crafted request print a different name on the merchant's letterhead than the one
 * in their client book, on a document the client is about to accept.
 *
 * ## The expiry is required, and must be in the future
 *
 * `0025` declares `expires_at timestamptz not null`, so a quote always has a lifetime, draft or not; there
 * is no default to fall back on and no row to write without one. Its check bounds it from one side only -
 * `estimates_expiry_check` requires `expires_at > issued_at`, and a draft has no `issued_at` - so this
 * module supplies the other bound: an expiry at or before now is refused, because a quote born expired can
 * never be issued. Once a later STEP sets `issued_at` to an instant after this create, the column's own
 * check is satisfied by the refusal made here.
 *
 * ## The money
 *
 * Every amount is parsed by `price.ts` into `bigint` minor units with decimal string arithmetic and no
 * float, and the quantity by `invoice-totals.ts` into integer thousandths. The subtotal is computed for
 * the answer by the same engine that restates the generated column's rule; the stored values are the
 * database's, read back after the write rather than returned from a calculation made here.
 */

/** The audit action of a create. */
export const ESTIMATE_CREATED_AUDIT_ACTION = "estimate.created";

/**
 * The audit action of the compensating removal described above.
 *
 * Named for what happened rather than for the error that caused it: the trail records that this request
 * wrote a row and then took it back out, and the reason is the error code, which is a fact about the
 * platform and not a message that could carry a merchant's data.
 */
export const ESTIMATE_ABANDONED_AUDIT_ACTION = "estimate.abandoned";

/** The audit entity of both. */
export const ESTIMATE_AUDIT_ENTITY = "estimate";

/**
 * Who may write a quote.
 *
 * The same role that writes an invoice, because a quote is the same document one step earlier in the same
 * conversation with the same client: an account that may not bill a client must not be able to promise one
 * a price either. Section 25 gives the merchant's documents to its owner; the office roles act through the
 * approval chain, not by writing into a merchant's book.
 */
export const ESTIMATE_MANAGE_ROLES: readonly PlatformRole[] = Object.freeze([
  "owner",
] as const satisfies readonly PlatformRole[]);

/**
 * The rule vocabulary this service answers with, for the form's sentences.
 *
 * Every rule a refusal of this module can carry is listed here, and `verify.ts` asserts that: a rule the
 * service can emit and the list does not name is a box a form cannot mark and a merchant cannot read.
 * `expired_before_issue` is the quote's own - the invoice's `due_before_issue` is the same idea on the
 * other side of the document, a deadline that precedes the instant the document exists.
 */
export const ESTIMATE_RULES = [
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
  "already_used",
  "expired_before_issue",
  // Emitted by the line editor of `estimate-lines.ts`, not by a create: a quote that was issued while the
  // merchant was editing it is no longer a draft, and the screen has to say that rather than show a form.
  "already_changed",
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
export interface EstimateLineSnapshot {
  readonly id: string;
  /** The quote the line belongs to, so an editor holding one line still knows which document it is on. */
  readonly estimateId: string;
  /** One based, dense, and the order the quote prints in. */
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
  /**
   * The line's own optimistic lock.
   *
   * `0026` gives every row a `version` that `estimate_items_set_row_metadata` moves on each write, and an
   * editor with two tabs open is the case it exists for. A printed line that hid its version would leave a
   * screen unable to say which of two edits landed, so it travels with the money - exactly as an invoice's
   * printed line carries its own.
   */
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/**
 * One quote as a screen sees it.
 *
 * The decision fields are here from the start and are null on every draft, because `getEstimate` is the
 * read path for the whole life of a quote and not for the state this STEP can write: STEP 120 fills
 * `acceptedAt` with the signature that accepted it, and STEP 121 fills `convertedInvoiceId` with the
 * invoice it became. A read that hid them would have to grow a second snapshot type the moment a quote
 * could be decided.
 */
export interface EstimateSnapshot {
  readonly id: string;
  readonly companyId: string;
  readonly clientId: string;
  /** Null while the quote is a draft, then the issued number, unique per merchant and never reused. */
  readonly number: string | null;
  readonly status: EstimateStatus;
  /** Why a void quote ended: declined by the client, expired, or withdrawn by the merchant. */
  readonly voidReason: EstimateVoidReason | null;
  readonly currency: string;
  readonly client: {
    readonly name: string;
    readonly email: string | null;
    readonly address: string | null;
  };
  readonly memo: string | null;
  /** When the offer ends. Always set: `0025` declares the column not null. */
  readonly expiresAt: string;
  readonly issuedAt: string | null;
  readonly acceptedAt: string | null;
  readonly voidedAt: string | null;
  /** The invoice an accepted quote became, written once by STEP 121 and never by this module. */
  readonly convertedInvoiceId: string | null;
  readonly lines: readonly EstimateLineSnapshot[];
  /** Each amount as decimal minor units beside its printed form, for the same reason a line does. */
  readonly totals: {
    readonly subtotal: string;
    readonly subtotalMinor: string;
    readonly discount: string;
    readonly discountMinor: string;
    /** How the discount was expressed, so an editor can reopen the box the merchant actually filled. */
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

export interface EstimateDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/**
 * The row shape of `0025` as `0117` left it, validated on every read.
 *
 * The two discount columns `0117` added are read like the invoice's, and `expires_at` is the one instant
 * a quote always has. There is no `amount_paid_minor` and no `paid_at`, because nothing is paid on a
 * quote: it is accepted and becomes an invoice, and the invoice is where the payment columns live.
 */
export const estimateRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  client_id: z.string().uuid(),
  number: z.string().nullable(),
  status: z.string().min(1),
  void_reason: z.string().nullable(),
  currency: z.string().length(3),
  subtotal_minor: priceColumnSchema,
  discount_minor: priceColumnSchema,
  discount_basis: z.string(),
  discount_percent_bp: z.number().int(),
  tax_minor: priceColumnSchema,
  total_minor: priceColumnSchema,
  client_name: z.string().min(1).max(160),
  client_email: z.string().max(254).nullable(),
  client_address: z.string().max(600).nullable(),
  memo: z.string().max(2_000).nullable(),
  issued_at: z.string().nullable(),
  expires_at: z.string().min(1),
  accepted_at: z.string().nullable(),
  voided_at: z.string().nullable(),
  converted_invoice_id: z.string().uuid().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullable(),
  version: z.number().int().min(1),
});

export type EstimateRow = z.infer<typeof estimateRowSchema>;

/**
 * The row shape of `0026`, validated on every read.
 *
 * `quantity` arrives as the decimal text of `numeric(12,3)` and `line_total_minor` is a generated column
 * the database computes, so both are read rather than written. `product_id` and `service_id` are
 * `num_nonnulls(...) <= 1` by the migration, which the schema states as the same rule.
 */
export const estimateItemRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  estimate_id: z.string().uuid(),
  position: z.number().int().min(1),
  description: z.string().min(1).max(300),
  // `0026`'s `estimate_items_unit_check` is `0023`'s: the same seven words, so the same enum reads them
  // and the snapshot needs no cast to say which one a line counted in.
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

export type EstimateItemRow = z.infer<typeof estimateItemRowSchema>;

/**
 * The body of a create.
 *
 * `client_id` and `expires_at` are required, the currency defaults to the only one the platform quotes in,
 * and the lines are required and bounded. `status` is deliberately absent: a create writes a draft, and
 * accepting a status from the body would let a caller mark a quote accepted with no signature behind it -
 * the one thing `0027` and STEP 120 exist to prevent. `number`, `issued_at`, `accepted_at`, `voided_at`
 * and `converted_invoice_id` are absent for the same reason: each is written by a transition, never by a
 * caller, and `.strict()` means a body that sends one is refused rather than quietly stripped.
 */
export const estimateCreateSchema = z
  .object({
    client_id: z.string(),
    currency: z.string().nullish(),
    expires_at: z.string(),
    memo: z.string().nullish(),
    discount: z.string().nullish(),
    // `percent` makes `discount` a percentage rather than money. Omitted means `amount`, which is what
    // every caller of the invoice's create has always sent, so one client can write either document.
    discount_basis: z.string().nullish(),
    tax: z.string().nullish(),
    lines: z.array(invoiceLineInputSchema),
  })
  .strict();

/** The parsed body, with every amount already converted. */
interface EstimateInput {
  readonly clientId: string;
  readonly currency: string;
  readonly expiresAt: string;
  readonly memo: string | null;
  /**
   * The discount as the body expressed it: minor units of money when the basis is `amount`, and **basis
   * points** when it is `percent`, because a percentage is not money until there is a subtotal to take it
   * from. `discountBasisPoints` carries the same number under a name that says what it is, and the two
   * travel together so a row is never written holding one without the other.
   */
  readonly discountMinor: bigint;
  readonly discountBasis: DiscountBasis;
  readonly discountBasisPoints: bigint;
  readonly taxMinor: bigint;
  readonly lines: readonly ParsedLine[];
}

/** The order a quote's fields are reported in, so a form marks the boxes top to bottom. */
const FIELD_ORDER = [
  "client_id",
  "currency",
  "expires_at",
  "memo",
  "discount_basis",
  "discount",
  "tax",
  "lines",
] as const;

/**
 * The field name a detail is reported under.
 *
 * A line's problem is named `lines[2].unit_price`, so the form can mark the right box on the right row
 * instead of a single "line items" error above a list of twenty. Index zero is included: the dots are what
 * the screen splits on, and a first row that read `lines.unit_price` would need a second rule.
 */
function detailPath(index: number | null, field: string): string {
  return index === null ? field : `lines[${String(index)}].${field}`;
}

/** The currency a body asked for, or the only one the platform quotes in when it asked for none. */
function currencyOf(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();

  if (value.length === 0) {
    return ESTIMATE_CURRENCIES[0];
  }

  return (ESTIMATE_CURRENCIES as readonly string[]).includes(value) ? value : null;
}

/**
 * Parse a whole body into the values the rows are written with, naming every broken field at once.
 *
 * One pass, deliberately. The shape is checked first, because a body that is not an object cannot be read
 * field by field; after that every field is judged independently and the first rule per field wins, so a
 * mistyped client id and a mistyped price are reported together instead of one per save. The order of the
 * answer is the order the screen reads, and the sorting is the invoice's.
 */
function parseBody(body: unknown, now: number): EstimateInput {
  const attempt = estimateCreateSchema.safeParse(body);

  if (!attempt.success) {
    // Only a shape failure reaches here: a key a quote does not have, or a field that is not a string at
    // all. Everything else is judged below, so this branch is narrow by construction.
    const problems = new Map<string, string>();

    for (const issue of attempt.error.issues) {
      const [head, second, third] = issue.path;

      const path =
        head === "lines"
          ? detailPath(typeof second === "number" ? second : null, typeof third === "string" ? third : "line")
          : String(head ?? "estimate");

      if (!problems.has(path)) {
        problems.set(path, "invalid_format");
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

  // The client the quote is written for. A body with no client is a body that named none, which is a
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

  // The expiry, which `0025` requires on every quote and which this module requires to be in the future:
  // a quote that expires before it is issued can never be sent, and `estimates_expiry_check` would refuse
  // the issue rather than tell the merchant which box to fix.
  const expiryRaw = value.expires_at.trim();
  const expiresAtEpochMs = expiryRaw.length === 0 ? Number.NaN : Date.parse(expiryRaw);

  if (!Number.isFinite(expiresAtEpochMs)) {
    problems.push({ field: "expires_at", rule: expiryRaw.length === 0 ? "required" : "invalid_format" });
  } else if (expiresAtEpochMs <= now) {
    problems.push({ field: "expires_at", rule: "expired_before_issue" });
  } else if (expiresAtEpochMs - now > ESTIMATE_EXPIRY_MAXIMUM_DAYS * 86_400_000) {
    problems.push({ field: "expires_at", rule: "too_large" });
  }

  // The basis decides how `discount` is read: a flat amount of money, or a percentage of the subtotal. A
  // body that sends a basis this build does not know is malformed rather than defaulted, because silently
  // reading a percentage as dollars would quote every client of that merchant a wrong price.
  const basisRaw = (value.discount_basis ?? "").trim();
  const discountBasis: DiscountBasis =
    basisRaw.length === 0 ? DISCOUNT_DEFAULT_BASIS : (basisRaw as DiscountBasis);

  if (basisRaw.length > 0 && !isDiscountBasis(basisRaw)) {
    problems.push({ field: "discount_basis", rule: "invalid_format" });
  }

  const discountRaw = (value.discount ?? "").trim();
  const estimateDiscount =
    discountRaw.length === 0
      ? 0n
      : discountBasis === "percent"
        ? percentToBasisPoints(discountRaw)
        : priceToMinor(discountRaw);

  if (estimateDiscount === null) {
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
  // here; the basis points are.
  const discountBasisPoints = discountBasis === "percent" ? (estimateDiscount ?? 0n) : 0n;

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

  if (problems.length === 0 && estimateDiscount !== null && taxMinor !== null) {
    const subtotal = subtotalOf(lines);

    // `estimates_discount_check`: a quote-level discount never exceeds what the lines add up to. A
    // percentage is resolved first, because the resolved money is what the check actually sees; at most a
    // hundred percent it can never exceed the subtotal, but it goes through the same function the invoice
    // uses so there is exactly one answer to what a percentage is worth.
    const resolvedDiscount = resolveDiscount({
      basis: discountBasis,
      basisPoints: discountBasisPoints,
      amountMinor: estimateDiscount,
      subtotalMinor: subtotal,
    });

    if (resolvedDiscount > subtotal) {
      problems.push({ field: "discount", rule: "too_large" });
    } else if (subtotal - resolvedDiscount + taxMinor < 0n) {
      problems.push({ field: "discount", rule: "too_large" });
    }
  }

  if (problems.length > 0 || estimateDiscount === null || taxMinor === null || currency === null) {
    throw new AppError("VALIDATION_FAILED", {
      details: orderDocumentDetails(problems, FIELD_ORDER, INVOICE_LINE_FIELDS),
    });
  }

  const memo = (value.memo ?? "").trim();
  const sanitisedMemo = memo.length === 0 ? null : sanitizeMultilineText(memo, INVOICE_MEMO_LIMITS.max);

  return {
    clientId,
    currency,
    expiresAt: new Date(expiresAtEpochMs).toISOString(),
    memo: sanitisedMemo === null || sanitisedMemo.length === 0 ? null : sanitisedMemo,
    discountMinor: estimateDiscount,
    discountBasis,
    discountBasisPoints,
    taxMinor,
    lines,
  };
}

/**
 * Create one draft quote for one of the actor's own clients.
 *
 * The steps, in order, because the order is the security:
 *
 *   1. the role and the company, from the session;
 *   2. the body, validated with Zod and every amount converted without a float;
 *   3. the client, read from the book through `getClient`, which applies the same role and scope - so a
 *      client id belonging to another merchant is the same 404 an unknown one gets;
 *   4. the quote row, inserted with the client's snapshot, the currency and the expiry;
 *   5. the lines, in one insert, with the parent's subtotal left to the trigger;
 *   6. the quote-level discount, in a second write, because the check that bounds it compares it to a
 *      subtotal that only exists once the lines do (the note beside the write explains this);
 *   7. the audit entry, then the re-read that returns what the database actually stored.
 *
 * A failure at step 5 or 6 removes the row from step 4 and rethrows, because a draft with no lines is not
 * a document and must not sit in the merchant's list behind an error message.
 */
export async function createEstimate(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: EstimateDependencies,
): Promise<EstimateSnapshot> {
  const companyId = requireEstimateActor(input.actor);
  const now = dependencies.now?.() ?? Date.now();
  const values = parseBody(input.body, now);

  // The client comes from the book, never from the body: the printed name is the book's name.
  const client = await getClient(
    { actor: input.actor, clientId: values.clientId },
    {
      rest: dependencies.rest,
      audit: dependencies.audit,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    },
  );
  const clientEmail = client.values["email"];
  const clientName = client.values["name"];
  const clientAddress = addressOf(client.values);

  // `0019` requires a name, so a book row without one is a row this service will not print rather than a
  // cast to satisfy the type. It is reported against the client the form chose, which is the box a
  // merchant can act on: the quote is not broken, the client they picked cannot be quoted.
  if (clientName === null || clientName.length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "client_id", rule: "invalid_format" }] });
  }

  if (
    clientEmail !== null &&
    (clientEmail.length < INVOICE_CLIENT_EMAIL_LIMITS.min ||
      clientEmail.length > INVOICE_CLIENT_EMAIL_LIMITS.max ||
      !INVOICE_CLIENT_EMAIL_PATTERN.test(clientEmail))
  ) {
    // `estimates_client_email_check` is stricter than the client book's optional email, so an address the
    // book holds but a quote cannot print is refused before the insert rather than as a 422 from PostgREST
    // with no field to point at.
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "client_id", rule: "invalid_format" }],
    });
  }

  const newRow: Record<string, unknown> = {
    company_id: companyId,
    client_id: values.clientId,
    status: ESTIMATE_CREATED_STATUS,
    currency: values.currency,
    // The quote-level discount is deliberately **not** written here; see the note below the lines.
    discount_minor: 0n,
    tax_minor: values.taxMinor,
    client_name: sanitizeSingleLineText(clientName, INVOICE_CLIENT_NAME_LIMITS.max),
    client_email: clientEmail,
    client_address: clientAddress,
    memo: values.memo,
    expires_at: values.expiresAt,
  };

  let estimate: EstimateRow;

  try {
    const [row] = await dependencies.rest.insertReturning(ESTIMATE_TABLE, [newRow], estimateRowSchema);

    if (row === undefined) {
      throw new AppError("INTERNAL_ERROR", { cause: { rule: "estimate", reason: "insert_returned_no_row" } });
    }

    estimate = row;
  } catch (error) {
    if (isConflictError(error)) {
      throw new AppError("CONFLICT", { details: [{ field: "client_id", rule: "already_used" }] });
    }

    throw error;
  }

  const lineRows = values.lines.map((line, index) => ({
    company_id: companyId,
    estimate_id: estimate.id,
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
    await dependencies.rest.insert(ESTIMATE_ITEMS_TABLE, lineRows);
  } catch (error) {
    await abandon(dependencies, {
      companyId,
      actor: input.actor,
      estimateId: estimate.id,
      reason: error instanceof AppError ? error.code.toLowerCase() : "unknown",
    });

    // A catalogue reference from another merchant is refused by `estimate_items_guard_catalogue` as an
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

  // The quote-level discount is a second write, and the schema is why.
  //
  // `0025` states `estimates_discount_check: discount_minor <= subtotal_minor`, and a row is checked on
  // insert. At that moment the quote has no lines, so `subtotal_minor` is still its default of zero -
  // which means any discount at all would violate the check. The subtotal only becomes non-zero after
  // `estimate_items_sync_totals` has fired for the lines. So the discount is applied once the lines exist,
  // which is the only order in which it can be both bounded by the subtotal and set on the same document.
  //
  // The basis and its points travel in the same update as the money, so a row never holds one without the
  // other and `0117`'s `estimates_discount_basis_coherent_check` is satisfied by construction rather than
  // by a second statement that could fail alone. Once they are on the row, that same `0117` trigger is what
  // keeps a percentage honest when a later STEP edits the lines: ten percent follows the subtotal rather
  // than staying the money it was worth before a line was removed.
  if (values.discountMinor > 0n) {
    // A percentage is resolved against the subtotal the trigger has just written, so the money stored is
    // the share the merchant asked for on the lines as they actually landed. A flat amount is the money the
    // merchant typed.
    const resolvedDiscount =
      values.discountBasis === "percent"
        ? percentDiscountMinor({
            subtotalMinor: await readSubtotalMinor(dependencies.rest, estimate.id, companyId),
            basisPoints: values.discountBasisPoints,
          })
        : values.discountMinor;

    try {
      await dependencies.rest.update(
        ESTIMATE_TABLE,
        `id=eq.${estimate.id}&company_id=eq.${companyId}&status=eq.${ESTIMATE_CREATED_STATUS}`,
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
        estimateId: estimate.id,
        reason: error instanceof AppError ? error.code.toLowerCase() : "unknown",
      });

      throw error;
    }
  }

  // The subtotal, discount and total are the database's; the re-read is what returns them rather than a
  // number computed here.
  const stored = await getEstimate({ actor: input.actor, estimateId: estimate.id }, dependencies);

  await appendTolerated(dependencies.audit, {
    action: ESTIMATE_CREATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: ESTIMATE_AUDIT_ENTITY,
    entityId: estimate.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      // Field names and counts, never the client's name, the memo or a line's description: a quote is a
      // commercial document and the trail is not the place to copy it.
      fields: ["client_id", "currency", "expires_at", "memo", "discount", "tax", "lines"],
      line_count: lineRows.length,
      total_minor: stored.totals.totalMinor,
      currency: stored.currency,
    },
  });

  return stored;
}

/**
 * Remove a quote row this request wrote, because its lines or its discount could not be written.
 *
 * A soft delete rather than a hard one: `0025` keeps a deleted quote readable because its signature and
 * its converted invoice point at it, and the same reasoning applies to a row an investigator may need to
 * see. Scoped to the company and to the draft status like every other statement in this module, so a
 * compensating action can never touch a quote that has since been issued by another request.
 */
async function abandon(
  dependencies: EstimateDependencies,
  input: {
    readonly companyId: string;
    readonly actor: RequestActor;
    readonly estimateId: string;
    readonly reason: string;
  },
): Promise<void> {
  try {
    await dependencies.rest.update(
      ESTIMATE_TABLE,
      `id=eq.${input.estimateId}&company_id=eq.${input.companyId}&status=eq.${ESTIMATE_CREATED_STATUS}`,
      { deleted_at: new Date(dependencies.now?.() ?? Date.now()).toISOString() },
    );
  } catch {
    // The compensating action failing must not replace the original failure the caller needs to see.
  }

  await appendTolerated(dependencies.audit, {
    action: ESTIMATE_ABANDONED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: ESTIMATE_AUDIT_ENTITY,
    entityId: input.estimateId,
    companyId: input.companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: { reason: input.reason },
  });
}

/**
 * Read one live quote of the actor's own company, with its lines.
 *
 * The role and the company are applied before the query is built and the query is scoped to both, so a
 * quote of another merchant is the same not-found as one that does not exist: an id is not a credential.
 */
export async function getEstimate(
  input: { readonly actor: RequestActor; readonly estimateId: string },
  dependencies: EstimateDependencies,
): Promise<EstimateSnapshot> {
  const companyId = requireEstimateActor(input.actor);
  const rows = await dependencies.rest.select(
    ESTIMATE_TABLE,
    `${ESTIMATE_COLUMNS}&id=eq.${input.estimateId}&company_id=eq.${companyId}&deleted_at=is.null`,
    estimateRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate", reason: "not_found" } });
  }

  const lines = await readEstimateLines(dependencies.rest, companyId, row.id);

  return estimateSnapshotOf(row, lines);
}

/**
 * The rows of `0026` for one quote, in print order, live only.
 *
 * Exported because the signature evidence hashes the same document `getEstimate` reads: one reader for one
 * fact, rather than a second query that could disagree about what "live" or "print order" means.
 */
export async function readEstimateLines(
  rest: RestClient,
  companyId: string,
  estimateId: string,
): Promise<readonly EstimateItemRow[]> {
  return rest.select(
    ESTIMATE_ITEMS_TABLE,
    `${ESTIMATE_ITEM_COLUMNS}&estimate_id=eq.${estimateId}&company_id=eq.${companyId}&deleted_at=is.null&order=position.asc`,
    estimateItemRowSchema,
  );
}

/**
 * The `subtotal_minor` a stored quote currently holds.
 *
 * Read rather than computed, and deliberately so: after `estimate_items_sync_totals` has run it is the
 * database's answer to what the lines add up to, and a percentage discount must be a share of that number
 * rather than of a second opinion. The read is scoped to the company as well as the id, so it cannot
 * describe another merchant's document.
 */
async function readSubtotalMinor(rest: RestClient, estimateId: string, companyId: string): Promise<bigint> {
  const rows = await rest.select(
    ESTIMATE_TABLE,
    `select=id,subtotal_minor&id=eq.${estimateId}&company_id=eq.${companyId}&deleted_at=is.null`,
    estimateSubtotalRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate", reason: "not_found" } });
  }

  return row.subtotal_minor;
}

/** The one column the discount resolution needs from the parent row. */
const estimateSubtotalRowSchema = z.object({
  id: z.string().uuid(),
  subtotal_minor: priceColumnSchema,
});

export function estimateLineSnapshotOf(row: EstimateItemRow): EstimateLineSnapshot {
  return {
    id: row.id,
    estimateId: row.estimate_id,
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
    version: row.version,
    createdAtEpochMs: Date.parse(row.created_at),
    updatedAtEpochMs: Date.parse(row.updated_at),
  };
}

/**
 * The four amounts of one row, printed.
 *
 * Its own function because two paths answer with a quote's totals: a read of the whole document, and the
 * discount write of `estimate-lines.ts`, which changes two of the four and has to report what all four
 * became. Both read the row back after the write rather than computing the answer, so this mapper is the
 * only place the printed form of a total is built.
 */
/** The six columns the totals are printed from, so a totals write can print them without a whole row. */
export type EstimateTotalsRow = Pick<
  EstimateRow,
  "subtotal_minor" | "discount_minor" | "tax_minor" | "total_minor" | "discount_basis" | "discount_percent_bp"
>;

export function estimateTotalsOf(row: EstimateTotalsRow): EstimateSnapshot["totals"] {
  return {
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
  };
}

/**
 * The document one quote is, as every reader prints it.
 *
 * Exported for the same reason as the line reader: the evidence hash has to be taken over the snapshot a
 * merchant and a client both see, and a second mapper would be a second idea of what the document holds.
 */
export function estimateSnapshotOf(row: EstimateRow, lines: readonly EstimateItemRow[]): EstimateSnapshot {
  return {
    id: row.id,
    companyId: row.company_id,
    clientId: row.client_id,
    // The status and the reason are narrowed rather than cast: a row the database stored outside the
    // vocabulary `0025` allows is a row this service will not describe, and `isEstimateStatus` is the same
    // question the column's check asks.
    number: row.number,
    status: isEstimateStatus(row.status) ? row.status : ESTIMATE_CREATED_STATUS,
    voidReason: isEstimateVoidReason(row.void_reason) ? row.void_reason : null,
    currency: row.currency,
    client: { name: row.client_name, email: row.client_email, address: row.client_address },
    memo: row.memo,
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
    acceptedAt: row.accepted_at,
    voidedAt: row.voided_at,
    convertedInvoiceId: row.converted_invoice_id,
    lines: lines.map((line) => estimateLineSnapshotOf(line)),
    totals: estimateTotalsOf(row),
    version: row.version,
    createdAtEpochMs: Date.parse(row.created_at),
    updatedAtEpochMs: Date.parse(row.updated_at),
  };
}

/** The role and the company, read from the session and never from the body. */
function requireEstimateActor(actor: RequestActor): string {
  requireAnyRole(actor, ESTIMATE_MANAGE_ROLES);

  return requireCompanyId(actor);
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}
