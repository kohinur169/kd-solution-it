// path: app/(client-portal)/portal-invoice.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { appConfig } from "../../config/app.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  openPortalToken,
  type PortalTokenClaim,
  type PortalTokenKeys,
} from "../../lib/security/portal-token.ts";
import { priceColumnSchema, priceToMinor } from "../../services/products/price.ts";
import {
  invoiceItemRowSchema,
  invoiceRowSchema,
} from "../../services/invoices/invoices.ts";
import {
  PORTAL_ACCEPTANCE_STATEMENTS,
  PORTAL_DOCUMENT_HASH_ENCODING,
  PORTAL_FULFILMENT_EVIDENCE_TABLE,
  PORTAL_FULFILMENT_KINDS,
  PORTAL_FULFILMENT_METHODS,
  PORTAL_INVOICE_ITEM_TABLE,
  PORTAL_INVOICE_TABLE,
  PORTAL_INVOICE_TOKEN_CAPABILITY,
  PORTAL_INVOICE_TOKEN_KIND,
  PORTAL_PAYABLE_STATES,
  PORTAL_PAYMENT_TABLE,
  PORTAL_RECEIPT_MAXIMUM_ENTRIES,
  PORTAL_RECEIPT_PAYMENT_STATUSES,
  PORTAL_ACCEPTANCE_TABLE,
  type PortalAcceptanceStatement,
  type PortalFulfilmentKind,
  type PortalFulfilmentMethod,
  type PortalInvoiceState,
  type PortalReceiptPaymentStatus,
  type PortalReleaseBlocker,
} from "./portal-invoice-fields.ts";
import { portalQuantityTextOf } from "./portal-invoice-money.ts";

/**
 * The read model of the tokenized invoice page.
 *
 * ## What a reader has to be able to answer without a session
 *
 * Section 16 gives the link four jobs: show the invoice, show what has been paid, stop taking money once
 * it is paid, and show a receipt. Section 18 adds the fifth: a payout waits until the buyer has confirmed
 * the fulfilment. So one read has to answer six questions - what the document says, what the money did,
 * what the merchant recorded, what the buyer already confirmed, whether the link still takes payment, and
 * whether a release is allowed - and it must answer them from the token alone, because a buyer has no
 * account.
 *
 * ## Why the token is the only input
 *
 * `openPortalToken` verifies the signature, the clock and the claim, and it answers the company and the
 * invoice the token names. Every query below is then scoped by *both* of those ids, never by the invoice
 * id alone: a valid token for invoice A cannot be made to read invoice B's payment by changing a digit,
 * and a token minted for one merchant cannot read another merchant's row even if the ids collided.
 *
 * ## Money leaves this module as text
 *
 * Every amount is a `bigint` inside and a decimal **string** on the view. A `bigint` is not JSON -
 * `JSON.stringify` throws on one - so a view carrying exact counts would turn a page render into a 500.
 * The view therefore carries the exact count as a string, and the printer (`portal-invoice-money.ts`) is
 * the only thing that formats it.
 *
 * ## The digest
 *
 * `portalInvoiceDocumentHashOf` is what a confirmation binds itself to: the invoice as the buyer saw it,
 * the lines, the totals and the identity, and deliberately *not* the status, the paid total or any
 * timestamp. A payment that arrives after the buyer opened the page must not invalidate a confirmation
 * given a minute earlier - the buyer confirmed a document, and the document did not change - while a
 * changed line, price or address must. The exclusion is the whole design, so it is stated here rather
 * than left to whoever reads the digest next.
 */

/** The columns a portal read selects: named one by one, never `*`. */
const PORTAL_INVOICE_COLUMNS =
  "select=id,company_id,client_id,number,status,currency,subtotal_minor,discount_minor,discount_basis,discount_percent_bp,tax_minor,total_minor,amount_paid_minor,client_name,client_email,client_address,memo,issued_at,due_at,first_viewed_at,paid_at,voided_at,created_at,updated_at,deleted_at,version";

const PORTAL_INVOICE_ITEM_COLUMNS =
  "select=id,company_id,invoice_id,position,description,unit,quantity,unit_price_minor,discount_minor,line_total_minor,product_id,service_id,created_at,updated_at,deleted_at,version";

const PORTAL_PAYMENT_COLUMNS =
  "select=id,company_id,invoice_id,mode,payment_method,amount_minor,currency,fee_minor,refunded_minor,card_brand,card_last_four,status,captured_at,settled_at,refunded_at,created_at";

/**
 * One payment, as the receipt reads it.
 *
 * `net_minor` is generated as `amount_minor - fee_minor`, which is the merchant's money rather than the
 * buyer's, so the receipt does not read it: what a buyer is shown is what they paid and what came back.
 */
export const portalPaymentRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  invoice_id: z.string().uuid().nullable(),
  mode: z.enum(["test", "live"]),
  payment_method: z.enum(["card", "bank_transfer", "e_wallet"]),
  amount_minor: priceColumnSchema,
  currency: z.string().length(3),
  fee_minor: priceColumnSchema,
  refunded_minor: priceColumnSchema,
  card_brand: z.string().nullable(),
  card_last_four: z.string().nullable(),
  status: z.string().min(1),
  captured_at: z.string().nullable(),
  settled_at: z.string().nullable(),
  refunded_at: z.string().nullable(),
  created_at: z.string().min(1),
});

type PortalPaymentRow = z.infer<typeof portalPaymentRowSchema>;

/** One fulfilment record, as the page reads it. */
export const portalFulfilmentRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  kind: z.enum(PORTAL_FULFILMENT_KINDS),
  method: z.enum(PORTAL_FULFILMENT_METHODS),
  occurred_at: z.string().min(1),
  reference: z.string().nullable(),
  description: z.string().nullable(),
  recorded_at: z.string().min(1),
  version: z.number().int().min(1),
});

export type PortalFulfilmentRow = z.infer<typeof portalFulfilmentRowSchema>;

/** One buyer confirmation, as the page reads it. */
export const portalAcceptanceRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  fulfilment_evidence_id: z.string().uuid(),
  statement: z.enum(PORTAL_ACCEPTANCE_STATEMENTS),
  signer_name: z.string().min(1).max(160),
  accepted_at: z.string().min(1),
  document_hash: z.string().length(64),
  version: z.number().int().min(1),
});

export type PortalAcceptanceRow = z.infer<typeof portalAcceptanceRowSchema>;

/** The columns each of the two evidence reads selects. */
const PORTAL_FULFILMENT_COLUMNS =
  "select=id,company_id,invoice_id,kind,method,occurred_at,reference,description,recorded_at,version";

const PORTAL_ACCEPTANCE_COLUMNS =
  "select=id,company_id,invoice_id,fulfilment_evidence_id,statement,signer_name,accepted_at,document_hash,version";

/** One printed line. */
export interface PortalInvoiceLineView {
  readonly id: string;
  readonly position: number;
  /** The quantity as the column stores it, so a screen can print it its own way. */
  readonly quantityText: string;
  readonly unit: string;
  readonly description: string;
  readonly unitPriceMinor: string;
  readonly discountMinor: string;
  readonly lineTotalMinor: string;
}

/** The document's money, before and after what has been paid. */
export interface PortalInvoiceTotalsView {
  readonly subtotalMinor: string;
  readonly discountMinor: string;
  /** `percent`, `fixed` or `none`, as `0112` stores the merchant's choice. */
  readonly discountBasis: string;
  readonly discountPercentBp: number;
  readonly taxMinor: string;
  readonly totalMinor: string;
  readonly paidMinor: string;
  readonly remainingMinor: string;
}

/** One line of the receipt. */
export interface PortalReceiptEntryView {
  readonly paymentId: string;
  readonly status: PortalReceiptPaymentStatus;
  readonly method: string;
  readonly mode: "test" | "live";
  readonly cardBrand: string | null;
  readonly cardLastFour: string | null;
  readonly amountMinor: string;
  readonly refundedMinor: string;
  readonly capturedAt: string | null;
  readonly settledAt: string | null;
}

/**
 * The receipt.
 *
 * `refundedMinor` and `netMinor` are null when the entry list was cut short, because the sums of a list
 * that names only its newest entries would be a number no document supports. `receivedMinor` is always
 * exact: it is the invoice's own `amount_paid_minor`, which is the figure the ledger wrote.
 */
export interface PortalReceiptView {
  readonly entries: readonly PortalReceiptEntryView[];
  readonly receivedMinor: string;
  readonly refundedMinor: string | null;
  readonly netMinor: string | null;
  /** How many older entries the page did not print. */
  readonly omitted: number;
  readonly truncated: boolean;
}

/** What the merchant recorded as having happened. */
export interface PortalFulfilmentView {
  readonly id: string;
  readonly kind: PortalFulfilmentKind;
  readonly method: PortalFulfilmentMethod;
  readonly occurredAt: string;
  readonly reference: string | null;
  readonly description: string | null;
  readonly recordedAt: string;
  readonly version: number;
}

/** What the buyer already confirmed. */
export interface PortalAcceptanceView {
  readonly id: string;
  readonly statement: PortalAcceptanceStatement;
  readonly signerName: string;
  readonly acceptedAt: string;
  readonly documentHash: string;
  readonly fulfilmentEvidenceId: string;
}

/**
 * What the link would take.
 *
 * `open` is the question the page asks, and `minimumMinor` is the floor that applies to *this* document:
 * the platform's twenty, or the whole remainder when the remainder is smaller than the floor, because a
 * buyer who owes less than the minimum cannot be asked for a partial payment that the database would
 * refuse anyway.
 */
export interface PortalPaymentView {
  readonly open: boolean;
  readonly amountMinor: string | null;
  readonly minimumMinor: string | null;
}

/** Whether a release is allowed, and what is missing when it is not. */
export interface PortalReleaseView {
  readonly ok: boolean;
  readonly blockers: readonly PortalReleaseBlocker[];
}

/** Everything the page prints, in one object. */
export interface PortalInvoiceView {
  readonly invoiceId: string;
  readonly companyId: string;
  readonly tokenId: string;
  /**
   * The client the invoice was issued to.
   *
   * Read for one reason: STEP 185 compares the payer's billing postal code and IP country with the billing
   * details on this client, and section 18's fallback capture rule is a comparison of the two. It is an id, not
   * a name, so the page that prints the document still prints only what section 16 allows.
   */
  readonly clientId: string;
  readonly number: string | null;
  readonly state: PortalInvoiceState;
  readonly currency: string;
  readonly clientName: string;
  readonly clientEmail: string | null;
  readonly clientAddress: string | null;
  readonly memo: string | null;
  readonly issuedAt: string | null;
  readonly dueAt: string;
  readonly firstViewedAt: string | null;
  readonly paidAt: string | null;
  readonly voidedAt: string | null;
  readonly totals: PortalInvoiceTotalsView;
  readonly lines: readonly PortalInvoiceLineView[];
  readonly receipt: PortalReceiptView;
  readonly payment: PortalPaymentView;
  readonly fulfilment: PortalFulfilmentView | null;
  readonly acceptance: PortalAcceptanceView | null;
  readonly release: PortalReleaseView;
}

/** What a read needs: a client, a key ring and a clock. */
export interface PortalInvoiceDependencies {
  readonly rest: RestClient;
  readonly tokenKeys: PortalTokenKeys;
  readonly now?: () => number;
}

/**
 * `0022`'s seven statuses folded into the five a buyer meets.
 *
 * Total by construction: the four that are states of their own are named, and the three that mean "issued,
 * not yet settled" - `sent`, `viewed`, `overdue` - all answer `open`. An unknown status is not folded at
 * all; the read refuses it below, because a status this function does not know is a status the page has no
 * sentence for.
 */
export function portalInvoiceStateOf(status: string): PortalInvoiceState | null {
  switch (status) {
    case "draft":
      return "not_issued";
    case "sent":
    case "viewed":
    case "overdue":
      return "open";
    case "partially_paid":
      return "partially_paid";
    case "paid":
      return "paid";
    case "void":
      return "void";
    default:
      return null;
  }
}

/**
 * The smallest partial payment this document would accept, in minor units.
 *
 * The platform's floor is twenty dollars, and it is a floor on *partial* payments: the payment that
 * settles a document is never a partial, whatever its size. So when the remainder is at or below the
 * floor, the only payment left is the remainder itself and the floor becomes the remainder - which is
 * what `invoices_partial_minimum_check` also implies, because a nine dollar remainder can never leave
 * the document in `partially_paid`.
 */
export function portalMinimumPartialMinor(remainingMinor: bigint, currency: string): bigint | null {
  if (remainingMinor <= 0n) {
    return null;
  }

  if (currency !== appConfig.money.currencyCode) {
    return null;
  }

  const floor = priceToMinor(appConfig.money.minimumPartialPayment);

  if (floor === null) {
    return null;
  }

  return remainingMinor <= floor ? remainingMinor : floor;
}

/** True when the state a document is in still takes money. */
function portalPayable(state: PortalInvoiceState): boolean {
  return (PORTAL_PAYABLE_STATES as readonly string[]).includes(state);
}

/** The receipt entries, newest first, cut at the ceiling with the remainder counted. */
function portalReceiptViewOf(
  rows: readonly PortalPaymentRow[],
  receivedMinor: bigint,
): PortalReceiptView {
  const printed = rows.slice(0, PORTAL_RECEIPT_MAXIMUM_ENTRIES);
  const truncated = rows.length > PORTAL_RECEIPT_MAXIMUM_ENTRIES;

  let refundedMinor = 0n;

  for (const row of printed) {
    refundedMinor += row.refunded_minor;
  }

  return {
    entries: printed.map((row) => ({
      paymentId: row.id,
      status: row.status as PortalReceiptPaymentStatus,
      method: row.payment_method,
      mode: row.mode,
      cardBrand: row.card_brand,
      cardLastFour: row.card_last_four,
      amountMinor: row.amount_minor.toString(),
      refundedMinor: row.refunded_minor.toString(),
      capturedAt: row.captured_at,
      settledAt: row.settled_at,
    })),
    receivedMinor: receivedMinor.toString(),
    refundedMinor: truncated ? null : refundedMinor.toString(),
    netMinor: truncated ? null : (receivedMinor - refundedMinor).toString(),
    omitted: Math.max(0, rows.length - printed.length),
    truncated,
  };
}

/**
 * What the link would accept, given the state and the money.
 *
 * A settled or cancelled document answers `open: false` with no amounts at all rather than a zero: a page
 * that printed "0.0000 USD due" beside "paid in full" would be two sentences disagreeing, and the
 * component keys its whole "no further payment" block off `open`.
 */
function portalPaymentViewOf(
  state: PortalInvoiceState,
  currency: string,
  totalMinor: bigint,
  paidMinor: bigint,
): PortalPaymentView {
  if (!portalPayable(state)) {
    return { open: false, amountMinor: null, minimumMinor: null };
  }

  const remainingMinor = totalMinor - paidMinor;

  if (remainingMinor <= 0n) {
    return { open: false, amountMinor: null, minimumMinor: null };
  }

  const minimum = portalMinimumPartialMinor(remainingMinor, currency);

  return {
    open: true,
    amountMinor: remainingMinor.toString(),
    minimumMinor: minimum === null ? null : minimum.toString(),
  };
}

/** The release question, answered the way `invoice_release_evidence_ok` answers it in SQL. */
function portalReleaseViewOf(
  state: PortalInvoiceState,
  fulfilment: PortalFulfilmentView | null,
  acceptance: PortalAcceptanceView | null,
): PortalReleaseView {
  const blockers: PortalReleaseBlocker[] = [];

  if (state === "void") {
    blockers.push("invoice_void");
  }

  if (state !== "paid") {
    blockers.push("invoice_not_paid");
  }

  if (fulfilment === null) {
    blockers.push("fulfilment_missing");
  }

  if (acceptance === null) {
    blockers.push("acceptance_missing");
  }

  return { ok: blockers.length === 0, blockers };
}

export function portalFulfilmentViewOf(row: PortalFulfilmentRow): PortalFulfilmentView {
  return {
    id: row.id,
    kind: row.kind,
    method: row.method,
    occurredAt: row.occurred_at,
    reference: row.reference,
    description: row.description,
    recordedAt: row.recorded_at,
    version: row.version,
  };
}

export function portalAcceptanceViewOf(row: PortalAcceptanceRow): PortalAcceptanceView {
  return {
    id: row.id,
    statement: row.statement,
    signerName: row.signer_name,
    acceptedAt: row.accepted_at,
    documentHash: row.document_hash,
    fulfilmentEvidenceId: row.fulfilment_evidence_id,
  };
}

/**
 * The document a confirmation binds itself to, in one canonical string.
 *
 * Key order is fixed by the literal below rather than by the object's own, so the same document digests
 * to the same value in every process. The encoding line comes first and names this page, so a digest from
 * here can never be confused with the one `0027`'s signatures store for a quote.
 */
export function portalInvoiceDocumentEncoding(view: PortalInvoiceView): string {
  const document = {
    encoding: PORTAL_DOCUMENT_HASH_ENCODING,
    invoice_id: view.invoiceId,
    company_id: view.companyId,
    number: view.number,
    currency: view.currency,
    client_name: view.clientName,
    client_email: view.clientEmail,
    client_address: view.clientAddress,
    memo: view.memo,
    issued_at: view.issuedAt,
    due_at: view.dueAt,
    subtotal_minor: view.totals.subtotalMinor,
    discount_minor: view.totals.discountMinor,
    discount_basis: view.totals.discountBasis,
    discount_percent_bp: view.totals.discountPercentBp,
    tax_minor: view.totals.taxMinor,
    total_minor: view.totals.totalMinor,
    lines: view.lines.map((line) => ({
      position: line.position,
      description: line.description,
      unit: line.unit,
      quantity: line.quantityText,
      unit_price_minor: line.unitPriceMinor,
      discount_minor: line.discountMinor,
      line_total_minor: line.lineTotalMinor,
    })),
  };

  return JSON.stringify(document);
}

/** SHA-256 of the canonical document, as 64 lower case hex characters. */
export function portalInvoiceDocumentHashOf(view: PortalInvoiceView): string {
  return createHash("sha256").update(portalInvoiceDocumentEncoding(view), "utf8").digest("hex");
}

/**
 * Open a tokenized invoice link and read everything the page prints.
 *
 * Five reads, each scoped by the token's company *and* its invoice: the document, its lines, the payments
 * a receipt prints, the live fulfilment record and the live confirmation. They are issued together
 * because none of them depends on another's answer, and the page needs all five before it can print a
 * sentence.
 *
 * A document that is a draft is answered rather than refused, with `state: not_issued`, so the page can
 * say "not ready yet" instead of "this link is broken". A document that does not exist, belongs to another
 * merchant, is soft deleted or carries a status this module does not know is `RESOURCE_NOT_FOUND`, which is
 * also what a bad signature answers - a visitor must not be able to tell those two apart.
 */
export async function openPortalInvoice(
  input: { readonly token: string },
  dependencies: PortalInvoiceDependencies,
): Promise<PortalInvoiceView> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);

  const claim: PortalTokenClaim = openPortalToken(input.token, {
    keys: dependencies.tokenKeys,
    now: nowSeconds,
    expect: {
      kind: PORTAL_INVOICE_TOKEN_KIND,
      capability: PORTAL_INVOICE_TOKEN_CAPABILITY,
    },
  });

  const scope =
    `&id=eq.${claim.resourceId}&company_id=eq.${claim.companyId}&deleted_at=is.null&limit=1`;

  const invoices = await dependencies.rest.select(
    PORTAL_INVOICE_TABLE,
    `${PORTAL_INVOICE_COLUMNS}${scope}`,
    invoiceRowSchema,
  );

  const invoice = invoices[0];

  if (invoice === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const state = portalInvoiceStateOf(invoice.status);

  if (state === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const tenant =
    `&invoice_id=eq.${claim.resourceId}&company_id=eq.${claim.companyId}` +
    "&deleted_at=is.null";

  const [items, payments, fulfilments, acceptances] = await Promise.all([
    dependencies.rest.select(
      PORTAL_INVOICE_ITEM_TABLE,
      `${PORTAL_INVOICE_ITEM_COLUMNS}${tenant}&order=position.asc`,
      invoiceItemRowSchema,
    ),
    dependencies.rest.select(
      PORTAL_PAYMENT_TABLE,
      `${PORTAL_PAYMENT_COLUMNS}&invoice_id=eq.${claim.resourceId}` +
        `&company_id=eq.${claim.companyId}&deleted_at=is.null` +
        `&status=in.(${PORTAL_RECEIPT_PAYMENT_STATUSES.join(",")})` +
        `&order=created_at.desc&limit=${PORTAL_RECEIPT_MAXIMUM_ENTRIES + 1}`,
      portalPaymentRowSchema,
    ),
    dependencies.rest.select(
      PORTAL_FULFILMENT_EVIDENCE_TABLE,
      `${PORTAL_FULFILMENT_COLUMNS}${tenant}&limit=1`,
      portalFulfilmentRowSchema,
    ),
    dependencies.rest.select(
      PORTAL_ACCEPTANCE_TABLE,
      `${PORTAL_ACCEPTANCE_COLUMNS}${tenant}&limit=1`,
      portalAcceptanceRowSchema,
    ),
  ]);

  const fulfilment = fulfilments[0] === undefined ? null : portalFulfilmentViewOf(fulfilments[0]);
  const acceptance = acceptances[0] === undefined ? null : portalAcceptanceViewOf(acceptances[0]);

  const totalMinor = invoice.total_minor;
  const paidMinor = invoice.amount_paid_minor;

  return {
    invoiceId: invoice.id,
    companyId: invoice.company_id,
    tokenId: claim.tokenId,
    clientId: invoice.client_id,
    number: invoice.number,
    state,
    currency: invoice.currency,
    clientName: invoice.client_name,
    clientEmail: invoice.client_email,
    clientAddress: invoice.client_address,
    memo: invoice.memo,
    issuedAt: invoice.issued_at,
    dueAt: invoice.due_at,
    firstViewedAt: invoice.first_viewed_at,
    paidAt: invoice.paid_at,
    voidedAt: invoice.voided_at,
    totals: {
      subtotalMinor: invoice.subtotal_minor.toString(),
      discountMinor: invoice.discount_minor.toString(),
      discountBasis: invoice.discount_basis,
      discountPercentBp: invoice.discount_percent_bp,
      taxMinor: invoice.tax_minor.toString(),
      totalMinor: totalMinor.toString(),
      paidMinor: paidMinor.toString(),
      remainingMinor: (totalMinor > paidMinor ? totalMinor - paidMinor : 0n).toString(),
    },
    lines: items.map((item) => ({
      id: item.id,
      position: item.position,
      quantityText: portalQuantityTextOf(item.quantity),
      unit: item.unit,
      description: item.description,
      unitPriceMinor: item.unit_price_minor.toString(),
      discountMinor: item.discount_minor.toString(),
      lineTotalMinor: item.line_total_minor.toString(),
    })),
    receipt: portalReceiptViewOf(payments, paidMinor),
    payment: portalPaymentViewOf(state, invoice.currency, totalMinor, paidMinor),
    fulfilment,
    acceptance,
    release: portalReleaseViewOf(state, fulfilment, acceptance),
  };
}
