// path: lib/tax/taxcloud-invoice-tax.ts
import { AppError } from "../errors/app-error.ts";
import type { ErrorCode } from "../errors/codes.ts";
import { deepFreeze } from "../utils/freeze.ts";
import {
  TAXCLOUD_PROVIDER_KEY,
  taxCloudFailureOf,
  taxCloudMinorOfAmount,
  taxCloudPriceOf,
  taxCloudProblemOf,
  taxCloudRequestOf,
} from "./taxcloud.ts";
import {
  taxCloudApiKeyScope,
  taxCloudConnectionIdScope,
} from "./taxcloud-connect.ts";
import type {
  TaxCloudConnectionRow,
  TaxCloudConnectionStore,
  TaxCloudSecretSealer,
  TaxCloudTransport,
  TaxCloudTransportAnswer,
} from "./taxcloud-connect.ts";
import { taxCloudCollectionGateOf, taxCloudUsableRowOf } from "./taxcloud-collection.ts";
import type { TaxCloudCollectionDecision } from "./taxcloud-collection.ts";

/**
 * The invoice calculation of FEATURE_LIST section 7: "When enabled, sales tax is collected automatically
 * on invoices", for United States transactions, through the merchant's own TaxCloud connection.
 *
 * ## What this file is, and what it is not
 *
 * It is the one place an invoice's tax is *asked for*: it turns an invoice's lines and two addresses
 * into the documented `POST /tax/connections/{connectionId}/carts` call, reads the per-line amounts
 * back, and answers the invoice writer with minor units it can store. It is not the invoice: the
 * writer owns `invoices.tax_minor` and `invoice_items`, and STEP 180 owns the stored tax line and the
 * totals view. Nothing here writes a row, so nothing here writes an audit entry either; the invoice's
 * own mutation is audited by its own service, and this module's part is the amount it returns.
 *
 * ## Five answers, because an invoice has five different things to say
 *
 *   - `calculated`: TaxCloud priced the lines, and every line's tax is in minor units here.
 *   - `not_collected`: the merchant chose not to collect, or has no verified connection, or the
 *     transaction is outside the United States. The decision is STEP 178's `taxCloudCollectionGateOf`
 *     and it is returned whole, so the sentence a merchant sees for a missing tax line comes from the
 *     same vocabulary as the settings panel.
 *   - `refused`: the invoice cannot be priced at all - an empty cart, an address TaxCloud could not
 *     accept, a quantity past the invoice's bounds, a discount larger than the line. Nothing was sent.
 *     An invoice is still a valid invoice with zero tax; a merchant whose client address is incomplete
 *     gets a sentence, not a failed invoice.
 *   - `rejected`: TaxCloud answered a documented refusal (`400`, `401`, `403`, `404`, `422`), read
 *     through STEP 176's failure table, so the caller knows a `401` means the key stopped working and a
 *     `422` means the content was unusable.
 *   - `unavailable`: `429`, `500`, `503` or a network failure survived the retries. Nothing is known
 *     about the amounts, so the invoice cannot be issued with a tax line until the caller tries again.
 *
 * ## Idempotency, because a retry must not create a second cart
 *
 * `POST /carts` is an **upsert on `cartId`**, which TaxCloud's page states outright. So the cart id is
 * the invoice's own id: two attempts for one invoice write the same cart, and a merchant who saves a
 * draft twice does not accumulate carts. The same id is the `orderId` when the cart is completed, which
 * TaxCloud requires to be unique per connection, so completion is idempotent by construction as well -
 * and a completion that may have landed is checked with the documented `GET /orders/{orderId}` before
 * it is reported as a failure.
 *
 * ## Money, exactly
 *
 * The request sends `price` and discount values as JSON numbers produced by STEP 176's
 * `taxCloudPriceOf`, which refuses a sub-cent price rather than rounding one. The response's
 * `tax.amount` is read by `taxCloudMinorOfAmount`, which parses decimal dollars as text into
 * ten-thousandths of a unit and refuses more than four decimals. The invoice's tax is the **sum of the
 * line amounts TaxCloud returned**, not a rate multiplied by anything: the documented `rate` is kept
 * as information for a screen and is never turned into money here.
 *
 * ## The retry policy, and the header that bounds it
 *
 * `429`, `500` and `503` are the statuses STEP 176's table calls retryable, and a network failure is
 * treated the same way. Two retries, with the documented `Retry-After` honoured when the answer carries
 * one (seconds or an HTTP date), capped at three seconds, and a doubling delay otherwise. A gate on the
 * invoice path cannot hang: the wait is bounded, the attempts are counted, and `sleep` is injected so
 * the gate can prove the schedule without waiting.
 */

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** The one currency this platform bills in, and the one TaxCloud documents first. */
export const TAXCLOUD_INVOICE_CURRENCY = "USD" as const;

/** The quantity scale of `invoice_items.quantity`, restated so a thousandth count converts exactly. */
export const TAXCLOUD_QUANTITY_THOUSANDTHS_PER_ONE = 1_000n;

/** `invoice_items` quantity bounds: greater than zero and at most one million units. */
export const TAXCLOUD_INVOICE_MAXIMUM_QUANTITY_THOUSANDTHS = 1_000_000_000n;

/** The widest unit price `services/products/price.ts` accepts, in minor units. */
export const TAXCLOUD_INVOICE_MAXIMUM_UNIT_PRICE_MINOR = 1_000_000_000_000n;

/** Retries after the first attempt, and the delay schedule: 250 ms, then 500 ms. */
export const TAXCLOUD_INVOICE_RETRY_ATTEMPTS = 2;
export const TAXCLOUD_INVOICE_RETRY_BASE_MS = 250;

/** The longest this module will wait between attempts, whatever a server asks for. */
export const TAXCLOUD_INVOICE_MAXIMUM_WAIT_MS = 3_000;

/** The statuses STEP 176's table calls retryable. */
export const TAXCLOUD_INVOICE_RETRYABLE_STATUSES: readonly number[] = deepFreeze([429, 500, 503] as const);

/** The six answers a calculation can have. */
export const TAXCLOUD_INVOICE_TAX_STATUSES = deepFreeze([
  "calculated",
  "not_collected",
  "refused",
  "rejected",
  "unavailable",
  "failed",
] as const);

export type TaxCloudInvoiceTaxStatus = (typeof TAXCLOUD_INVOICE_TAX_STATUSES)[number];

/** The statuses whose content is worth reading back: a body TaxCloud could not use, or a duplicate order. */
export const TAXCLOUD_INVOICE_READBACK_STATUSES: readonly number[] = deepFreeze([400, 409, 422] as const);

/* -------------------------------------------------------------------------------------------------
 * Input
 * ---------------------------------------------------------------------------------------------- */

/** One address in TaxCloud's documented shape. `state` is a two letter code and `zip` a postal code. */
export interface TaxCloudInvoiceAddress {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly state: string;
  /** The invoice's `postal_code`; TaxCloud documents a five digit ZIP or a ZIP+4 for the United States. */
  readonly zip: string;
  /** The invoice's `country_code`. Only the United States is in scope. */
  readonly countryCode: string;
}

/** One invoice line, as the invoice stores it: quantity in thousandths, money in minor units. */
export interface TaxCloudInvoiceLine {
  /** `invoice_items.id`, which is TaxCloud's `itemId`. */
  readonly itemId: string;
  /** The line's position in the invoice, which with `itemId` identifies one cart line. */
  readonly index: number;
  readonly quantityThousandths: bigint;
  /** The **unit** price before discounts, which is what TaxCloud's `price` means. */
  readonly unitPriceMinor: bigint;
  /** The line's discount in minor units; sent as an amount discount. */
  readonly discountMinor: bigint;
  /** The TIC the merchant assigned, when one is known; omitted otherwise and TaxCloud defaults it to 0. */
  readonly tic?: number;
}

/** What the invoice writer hands over. */
export interface TaxCloudInvoiceCalculationInput {
  readonly companyId: string;
  /** The invoice's id, used as the cart id and later as the order id, so a retry cannot duplicate. */
  readonly invoiceId: string;
  /** The client's id, which is TaxCloud's `customerId`. */
  readonly clientId: string;
  readonly destination: TaxCloudInvoiceAddress;
  /** The merchant's registered address, from `business_profiles`, as the origin. */
  readonly origin: TaxCloudInvoiceAddress;
  readonly lines: readonly TaxCloudInvoiceLine[];
  /** The invoice's own discount in minor units, applied after the line discounts. */
  readonly invoiceDiscountMinor: bigint;
}

/* -------------------------------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------------------------------- */

const TAXCLOUD_IDENTIFIER_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/u;
const TAXCLOUD_STATE_PATTERN = /^[A-Z]{2}$/u;
const TAXCLOUD_COUNTRY_PATTERN = /^[A-Za-z]{2}$/u;
const TAXCLOUD_ZIP_PATTERN = /^[0-9]{5}(-[0-9]{4})?$/u;

function addressProblemOf(address: TaxCloudInvoiceAddress, field: string): string | null {
  const line1 = address.line1.trim();

  if (line1.length < 1 || line1.length > 160) return `the ${field} street address is one to 160 characters`;
  if (address.city.trim().length < 1 || address.city.trim().length > 120) return `the ${field} city is one to 120 characters`;
  if (TAXCLOUD_COUNTRY_PATTERN.test(address.countryCode.trim()) === false) return `the ${field} country is a two letter code`;

  // Only a United States address is ever sent, so only a United States address is held to TaxCloud's
  // shape. Another country's postcode and province are the invoice's own business: the scope decision
  // refuses the transaction before a request is built, and refusing a valid Toronto address here would
  // report a malformed invoice where the truth is that the platform does not collect there.
  if (address.countryCode.trim().toUpperCase() === "US") {
    if (TAXCLOUD_STATE_PATTERN.test(address.state.trim().toUpperCase()) === false) {
      return `the ${field} state is a two letter code`;
    }
    if (TAXCLOUD_ZIP_PATTERN.test(address.zip.trim()) === false) {
      return `the ${field} ZIP code is five digits or a five plus four`;
    }

    return null;
  }

  if (address.state.trim().length < 1 || address.state.trim().length > 40) return `the ${field} state or province is one to 40 characters`;
  if (address.zip.trim().length < 1 || address.zip.trim().length > 20) return `the ${field} postal code is one to 20 characters`;

  return null;
}

/**
 * Why an invoice cannot be priced, or null when it can.
 *
 * This runs before anything is sealed or sent, so an invoice that cannot be priced costs no encryption
 * work and reaches no network. The checks are the invoice's own bounds (`0023`'s quantity and price),
 * TaxCloud's documented address shape, and the identity values a cart line needs. A TIC is optional
 * because TaxCloud defaults it, and a wrong TIC is the merchant's decision to make, not this module's.
 */
export function taxCloudInvoiceTaxProblemOf(input: TaxCloudInvoiceCalculationInput): string | null {
  if (TAXCLOUD_IDENTIFIER_PATTERN.test(input.invoiceId) === false) return "an invoice id is 1 to 200 letters, digits, dots, underscores, tildes or hyphens";
  if (TAXCLOUD_IDENTIFIER_PATTERN.test(input.clientId) === false) return "a client id is 1 to 200 letters, digits, dots, underscores, tildes or hyphens";
  if (input.lines.length === 0) return "an invoice with no line has nothing to price";

  const originProblem = addressProblemOf(input.origin, "merchant");

  if (originProblem !== null) return originProblem;

  const destinationProblem = addressProblemOf(input.destination, "client");

  if (destinationProblem !== null) return destinationProblem;

  if (input.invoiceDiscountMinor < 0n) return "an invoice discount is not negative";

  const seen = new Set<string>();
  // The invoice's own bound: `invoices_discount_check` holds the invoice discount to the subtotal, and
  // the subtotal is each line's stored total, `((quantity * unit_price)::bigint - discount)`, summed.
  let netMinor = 0n;

  for (const line of input.lines) {
    if (TAXCLOUD_IDENTIFIER_PATTERN.test(line.itemId) === false) return "a line id is 1 to 200 letters, digits, dots, underscores, tildes or hyphens";
    if (Number.isSafeInteger(line.index) === false || line.index < 0) return "a line index is a whole number of at least zero";

    const key = `${line.itemId}#${String(line.index)}`;

    if (seen.has(key)) return "two lines share an item id and an index";
    seen.add(key);

    if (line.quantityThousandths <= 0n) return "a line quantity is greater than zero";
    if (line.quantityThousandths > TAXCLOUD_INVOICE_MAXIMUM_QUANTITY_THOUSANDTHS) return "a line quantity is at most one million units";
    if (line.unitPriceMinor < 0n) return "a line price is not negative";
    if (line.unitPriceMinor > TAXCLOUD_INVOICE_MAXIMUM_UNIT_PRICE_MINOR) return "a line price is inside the price ceiling";
    if (line.discountMinor < 0n) return "a line discount is not negative";
    if (line.tic !== undefined && (Number.isSafeInteger(line.tic) === false || line.tic < 0 || line.tic > 99_999)) {
      return "a TIC is a whole number between zero and 99999";
    }

    const gross = (line.quantityThousandths * line.unitPriceMinor) / TAXCLOUD_QUANTITY_THOUSANDTHS_PER_ONE;

    if (line.discountMinor > gross) return "a line discount is at most the line's gross amount";
    netMinor += gross - line.discountMinor;
  }

  if (input.invoiceDiscountMinor > netMinor) return "an invoice discount is at most the invoice's subtotal";

  return null;
}

/* -------------------------------------------------------------------------------------------------
 * The request
 * ---------------------------------------------------------------------------------------------- */

/** A quantity as a JSON number that round-trips its decimal spelling exactly, or a refusal. */
export function taxCloudQuantityNumberOf(quantityThousandths: bigint): number {
  if (quantityThousandths <= 0n) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "quantity", rule: "a quantity is greater than zero" }] });
  }

  const whole = quantityThousandths / TAXCLOUD_QUANTITY_THOUSANDTHS_PER_ONE;
  const fraction = quantityThousandths % TAXCLOUD_QUANTITY_THOUSANDTHS_PER_ONE;
  const text = `${whole.toString()}.${fraction.toString().padStart(3, "0")}`;
  const value = Number(text);
  // The shortest spelling of the double must be the decimal we started from, or the request would carry a
  // quantity that is not the invoice's: `2.5` round-trips, and a value that does not is refused.
  const canonical = text.replace(/0+$/u, "").replace(/\.$/u, "");

  if (Number.isFinite(value) === false || (String(value) !== text && String(value) !== canonical)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "quantity", rule: "the quantity cannot be sent as an exact JSON number" }],
    });
  }

  return value;
}

function addressBodyOf(address: TaxCloudInvoiceAddress): Readonly<Record<string, string>> {
  const body: Record<string, string> = {
    line1: address.line1.trim(),
    city: address.city.trim(),
    state: address.state.trim().toUpperCase(),
    zip: address.zip.trim(),
    countryCode: address.countryCode.trim().toUpperCase(),
  };

  if (address.line2 !== undefined && address.line2.trim().length > 0) body["line2"] = address.line2.trim();

  return body;
}

/** The cart body, built exactly to the documented shape so a `400` is never this module's syntax. */
export interface TaxCloudCartBody {
  readonly items: readonly Readonly<Record<string, unknown>>[];
}

export function taxCloudCartBodyOf(
  input: TaxCloudInvoiceCalculationInput,
  rows: readonly TaxCloudConnectionRow[],
): TaxCloudCartBody {
  const usable = taxCloudUsableRowOf(rows);

  if (usable === null) {
    throw new AppError("CONFLICT", { details: [{ field: "connection", rule: "a cart needs a usable connection" }] });
  }

  const lineItems = input.lines.map((line) => {
    const item: Record<string, unknown> = {
      index: line.index,
      itemId: line.itemId,
      price: taxCloudPriceOf(line.unitPriceMinor),
      quantity: taxCloudQuantityNumberOf(line.quantityThousandths),
    };

    if (line.tic !== undefined) item["tic"] = line.tic;

    return item;
  });
  const item: Record<string, unknown> = {
    cartId: input.invoiceId,
    currency: { currencyCode: TAXCLOUD_INVOICE_CURRENCY },
    customerId: input.clientId,
    destination: addressBodyOf(input.destination),
    origin: addressBodyOf(input.origin),
    lineItems,
  };
  const lineDiscounts = input.lines
    .filter((line) => line.discountMinor > 0n)
    .map((line) => ({
      itemId: line.itemId,
      type: "amount" as const,
      value: taxCloudPriceOf(line.discountMinor),
      cartItemIndex: line.index,
    }));

  if (lineDiscounts.length > 0 || input.invoiceDiscountMinor > 0n) {
    item["discounts"] = {
      ...(lineDiscounts.length === 0 ? {} : { lineItemDiscounts: lineDiscounts }),
      ...(input.invoiceDiscountMinor === 0n
        ? {}
        : { orderDiscount: { type: "amount", value: taxCloudPriceOf(input.invoiceDiscountMinor) } }),
    };
  }

  return { items: [item] };
}

/* -------------------------------------------------------------------------------------------------
 * The answer
 * ---------------------------------------------------------------------------------------------- */

/** One line's tax, in minor units, with the documented rate kept as information only. */
export interface TaxCloudLineTax {
  readonly itemId: string;
  readonly index: number;
  /** The invoice's tax for this line, in ten-thousandths of a unit. */
  readonly taxMinor: bigint;
  /** The documented rate, a decimal fraction such as 0.08125, or null when the answer carried none. */
  readonly rate: number | null;
}

/** What a calculated invoice carries. */
export interface TaxCloudInvoiceTax {
  /** The cart id, which is the invoice's own id. */
  readonly cartId: string;
  readonly currency: typeof TAXCLOUD_INVOICE_CURRENCY;
  readonly lines: readonly TaxCloudLineTax[];
  /** The sum of the line amounts, which is the invoice's tax. */
  readonly totalTaxMinor: bigint;
  /** TaxCloud's echo of the transaction instant, kept for the record when present. */
  readonly transactionDate: string | null;
}

/** The six answers. */
export type TaxCloudInvoiceTaxResult =
  | { readonly status: "calculated"; readonly tax: TaxCloudInvoiceTax }
  | { readonly status: "not_collected"; readonly decision: TaxCloudCollectionDecision }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string; readonly code: ErrorCode; readonly httpStatus: number }
  | { readonly status: "unavailable"; readonly reason: string; readonly attempts: number }
  | { readonly status: "failed"; readonly reason: string };

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function parseJson(body: string): unknown {
  if (body.trim().length === 0) return null;

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read one cart answer, or say why it cannot be believed.
 *
 * Every number here comes from a remote server, so the shape is checked before it is used: one item for
 * our cart id, one line for every line we sent, no line we did not send, no duplicate key, no negative
 * amount and no amount with more than four decimals. A mismatch is a failure rather than a repaired
 * invoice, because a silently dropped line would tax the wrong total.
 */
export function taxCloudCartAnswerOf(
  body: string,
  input: TaxCloudInvoiceCalculationInput,
): { readonly tax: TaxCloudInvoiceTax } | { readonly reason: string } {
  const parsed = recordOf(parseJson(body));

  if (parsed === null) return { reason: "TaxCloud answered with a body that is not a cart" };

  const items = parsed["items"];

  if (Array.isArray(items) === false || items.length === 0) return { reason: "TaxCloud answered a cart with no items" };

  const carts = items.map(recordOf).filter((entry): entry is Readonly<Record<string, unknown>> => entry !== null);
  const cart = carts.find((entry) => entry["cartId"] === input.invoiceId) ?? (carts.length === 1 ? carts[0] : undefined);

  if (cart === undefined) return { reason: "TaxCloud answered a cart this invoice did not ask for" };

  const lineItems = cart["lineItems"];

  if (Array.isArray(lineItems) === false) return { reason: "the cart answer carries no line items" };

  const requested = new Map(input.lines.map((line) => [`${line.itemId}#${String(line.index)}`, line]));
  const lines: TaxCloudLineTax[] = [];
  let totalTaxMinor = 0n;

  for (const entry of lineItems) {
    const line = recordOf(entry);

    if (line === null) return { reason: "a cart line is not an object" };

    const itemId = line["itemId"];
    const rawIndex = line["index"];
    const index = typeof rawIndex === "number" && Number.isSafeInteger(rawIndex) ? rawIndex : null;

    if (typeof itemId !== "string" || index === null) {
      return { reason: "a cart line has no item id or no index" };
    }

    const key = `${itemId}#${String(index)}`;
    const asked = requested.get(key);

    if (asked === undefined) return { reason: "TaxCloud answered a line this invoice did not send" };

    requested.delete(key);

    const tax = recordOf(line["tax"]);

    if (tax === null) return { reason: `the cart line ${key} carries no tax` };

    const rawAmount = tax["amount"];

    if (typeof rawAmount !== "number" && typeof rawAmount !== "string") {
      return { reason: `the cart line ${key} carries no tax amount` };
    }

    let taxMinor: bigint;

    try {
      taxMinor = taxCloudMinorOfAmount(rawAmount);
    } catch {
      return { reason: `the cart line ${key} carries a tax amount this platform cannot hold` };
    }

    // A negative amount never reaches here: STEP 176's parser refuses a sign, so the reader only has to
    // believe a non-negative number. The gate proves the refusal at the parser's door.
    const rawRate = tax["rate"];
    const rate = typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate >= 0 && rawRate <= 1 ? rawRate : null;

    lines.push({ itemId, index, taxMinor, rate });
    totalTaxMinor += taxMinor;
  }

  if (requested.size > 0) return { reason: "TaxCloud answered fewer lines than this invoice sent" };

  const rawDate = parsed["transactionDate"];
  const transactionDate = typeof rawDate === "string" && rawDate.trim().length > 0 ? rawDate.trim() : null;

  return {
    tax: {
      cartId: input.invoiceId,
      currency: TAXCLOUD_INVOICE_CURRENCY,
      lines,
      totalTaxMinor,
      transactionDate,
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The call
 * ---------------------------------------------------------------------------------------------- */

export interface TaxCloudInvoiceTaxOptions {
  readonly store: TaxCloudConnectionStore;
  readonly sealer: TaxCloudSecretSealer;
  readonly transport: TaxCloudTransport;
  readonly now?: () => number;
  /** Injected so the gate can prove the retry schedule without waiting for it. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** A `Retry-After` in milliseconds, from seconds or an HTTP date, capped at this module's ceiling. */
export function taxCloudRetryAfterMsOf(
  headers: Readonly<Record<string, string>> | undefined,
  nowEpochMs: number,
): number | null {
  const raw = headers === undefined ? undefined : headers["retry-after"];

  if (raw === undefined || raw.trim().length === 0) return null;

  const trimmed = raw.trim();

  if (/^[0-9]{1,5}$/u.test(trimmed)) {
    return Math.min(Number(trimmed) * 1_000, TAXCLOUD_INVOICE_MAXIMUM_WAIT_MS);
  }

  const instant = Date.parse(trimmed);

  if (Number.isFinite(instant) === false) return null;

  return Math.min(Math.max(instant - nowEpochMs, 0), TAXCLOUD_INVOICE_MAXIMUM_WAIT_MS);
}

interface SentCall {
  readonly attempt: number;
  readonly answer: TaxCloudTransportAnswer | null;
}

/** Send one request with the bounded retry, honouring `Retry-After` when an answer carries one. */
async function sendWithRetry(
  call: { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body: string | null },
  options: TaxCloudInvoiceTaxOptions,
): Promise<SentCall> {
  const sleep = options.sleep ?? ((milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let attempt = 0;

  for (;;) {
    attempt += 1;

    try {
      const answer = await options.transport(call);

      if (TAXCLOUD_INVOICE_RETRYABLE_STATUSES.includes(answer.status) === false) return { attempt, answer };
      if (attempt > TAXCLOUD_INVOICE_RETRY_ATTEMPTS) return { attempt, answer };

      const instant = options.now?.() ?? Date.now();
      const header = taxCloudRetryAfterMsOf(answer.headers, instant);
      const delay = header ?? TAXCLOUD_INVOICE_RETRY_BASE_MS * 2 ** (attempt - 1);

      await sleep(Math.min(delay, TAXCLOUD_INVOICE_MAXIMUM_WAIT_MS));
    } catch {
      if (attempt > TAXCLOUD_INVOICE_RETRY_ATTEMPTS) return { attempt, answer: null };

      await sleep(Math.min(TAXCLOUD_INVOICE_RETRY_BASE_MS * 2 ** (attempt - 1), TAXCLOUD_INVOICE_MAXIMUM_WAIT_MS));
    }
  }
}

/**
 * The two values a call needs, opened for exactly as long as that call takes.
 *
 * The plaintexts live in this object and nowhere else: they are not returned to the caller, not logged,
 * and not part of any result this module answers with.
 */
function openConnection(
  companyId: string,
  row: TaxCloudConnectionRow,
  options: TaxCloudInvoiceTaxOptions,
): { readonly status: "ready"; readonly apiKey: string; readonly connectionId: string } | { readonly status: "failed"; readonly reason: string } {
  try {
    return {
      status: "ready",
      apiKey: options.sealer.open(row.apiKeyBox, taxCloudApiKeyScope(companyId)),
      connectionId: options.sealer.open(row.connectionIdBox, taxCloudConnectionIdScope(companyId)),
    };
  } catch {
    return { status: "failed", reason: "the stored credentials cannot be opened with the current encryption key" };
  }
}

/**
 * Price one invoice.
 *
 * The order is the one that keeps a failure cheap: the input is checked first (an address that cannot
 * be priced costs nothing), then the merchant's own switch and connection (a merchant who has not
 * switched collection on is not sent anywhere), then the credentials are opened for exactly as long as
 * the two calls take, then the cart is asked for and its answer is read strictly.
 */
export async function calculateInvoiceTax(
  input: TaxCloudInvoiceCalculationInput,
  options: TaxCloudInvoiceTaxOptions,
): Promise<TaxCloudInvoiceTaxResult> {
  const problem = taxCloudInvoiceTaxProblemOf(input);

  if (problem !== null) return { status: "refused", reason: problem };

  const rows = await options.store.listByCompany(input.companyId);
  const decision = taxCloudCollectionGateOf(rows, input.destination.countryCode);
  const usable = taxCloudUsableRowOf(rows);

  // The gate is STEP 178's, so the reason a merchant sees here is the reason the settings panel gives.
  if (decision.collect === false || usable === null) return { status: "not_collected", decision };

  const connection = openConnection(input.companyId, usable, options);

  if (connection.status === "failed") return { status: "failed", reason: connection.reason };

  const body = taxCloudCartBodyOf(input, [usable]);
  // A stored connection id that is not one cannot build a URL. STEP 176 refuses to build it, and the
  // refusal becomes a failure here rather than an exception on the invoice path.
  let request: ReturnType<typeof taxCloudRequestOf>;

  try {
    request = taxCloudRequestOf({
      endpoint: "carts",
      params: { connectionId: connection.connectionId },
      apiKey: connection.apiKey,
      body,
    });
  } catch {
    return { status: "failed", reason: "the stored connection cannot be addressed" };
  }

  const sent = await sendWithRetry(
    { method: request.method, url: request.url, headers: request.headers, body: request.body },
    options,
  );

  if (sent.answer === null) {
    return {
      status: "unavailable",
      reason: "TaxCloud could not be reached, so this invoice has no tax amount yet",
      attempts: sent.attempt,
    };
  }

  if (sent.answer.status >= 200 && sent.answer.status < 300) {
    const parsed = taxCloudCartAnswerOf(sent.answer.body, input);

    if ("reason" in parsed) return { status: "failed", reason: parsed.reason };

    return { status: "calculated", tax: parsed.tax };
  }

  const failure = taxCloudFailureOf(sent.answer.status, parseJson(sent.answer.body));

  if (failure.retryable) {
    return {
      status: "unavailable",
      reason: `${failure.officeMessage} (HTTP ${String(sent.answer.status)})`,
      attempts: sent.attempt,
    };
  }

  return {
    status: "rejected",
    reason: failure.detail ?? failure.officeMessage,
    code: failure.code,
    httpStatus: sent.answer.status,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Completing the order
 * ---------------------------------------------------------------------------------------------- */

/** What a completion hands over: the invoice, the transaction instant, and the country of the client. */
export interface TaxCloudOrderCompletionInput {
  readonly companyId: string;
  readonly invoiceId: string;
  readonly countryCode: string;
  /** When the sale was completed, which must not be in the future. */
  readonly completedAtEpochMs: number;
}

/** The three answers a completion can have, plus the two refusals. */
export type TaxCloudOrderCompletionResult =
  | { readonly status: "completed"; readonly orderId: string; readonly alreadyExisted: boolean }
  | { readonly status: "not_collected"; readonly decision: TaxCloudCollectionDecision }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string; readonly code: ErrorCode; readonly httpStatus: number }
  | { readonly status: "unavailable"; readonly reason: string; readonly attempts: number }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Whether an order exists, through the documented read.
 *
 * Used when a completion's answer is one TaxCloud uses for content it could not use or for a duplicate:
 * the order may have landed on an earlier attempt, and reporting a failure for an order that exists
 * would leave an invoice that is filed and a screen that says it is not.
 */
async function orderExists(
  call: { readonly connectionId: string; readonly apiKey: string; readonly orderId: string },
  options: TaxCloudInvoiceTaxOptions,
): Promise<boolean> {
  let request: ReturnType<typeof taxCloudRequestOf>;

  try {
    request = taxCloudRequestOf({
      endpoint: "order",
      params: { connectionId: call.connectionId, orderId: call.orderId },
      apiKey: call.apiKey,
    });
  } catch {
    return false;
  }

  const sent = await sendWithRetry(
    { method: request.method, url: request.url, headers: request.headers, body: request.body },
    options,
  );

  return sent.answer !== null && sent.answer.status === 200;
}

/**
 * Complete the order a calculated cart became.
 *
 * `POST /carts/orders` with `completedDate` is what puts the sale into TaxCloud's liability; a future
 * date is documented as a `422`, so it is refused here before the call. `orderId` and `cartId` are both
 * the invoice's id, which makes a retry the same order rather than a second one, and a `400`, `409` or
 * `422` is read back with `GET /orders/{orderId}` before it is reported: an order that exists is a
 * completed order, whichever attempt created it.
 */
export async function completeInvoiceTaxOrder(
  input: TaxCloudOrderCompletionInput,
  options: TaxCloudInvoiceTaxOptions,
): Promise<TaxCloudOrderCompletionResult> {
  if (TAXCLOUD_IDENTIFIER_PATTERN.test(input.invoiceId) === false) {
    return { status: "refused", reason: "an invoice id is 1 to 200 letters, digits, dots, underscores, tildes or hyphens" };
  }

  const instant = options.now?.() ?? Date.now();

  if (Number.isSafeInteger(input.completedAtEpochMs) === false || input.completedAtEpochMs <= 0) {
    return { status: "refused", reason: "a completed date is a positive whole number of milliseconds" };
  }

  if (input.completedAtEpochMs > instant) {
    return { status: "refused", reason: "a completed date cannot be in the future, which TaxCloud answers with a 422" };
  }

  const rows = await options.store.listByCompany(input.companyId);
  const decision = taxCloudCollectionGateOf(rows, input.countryCode);
  const usable = taxCloudUsableRowOf(rows);

  if (decision.collect === false || usable === null) return { status: "not_collected", decision };

  const connection = openConnection(input.companyId, usable, options);

  if (connection.status === "failed") return { status: "failed", reason: connection.reason };

  let request: ReturnType<typeof taxCloudRequestOf>;

  try {
    request = taxCloudRequestOf({
      endpoint: "cartOrders",
      params: { connectionId: connection.connectionId },
      apiKey: connection.apiKey,
      body: {
        orderId: input.invoiceId,
        cartId: input.invoiceId,
        completedDate: new Date(input.completedAtEpochMs).toISOString(),
      },
    });
  } catch {
    return { status: "failed", reason: "the stored connection cannot be addressed" };
  }

  const sent = await sendWithRetry(
    { method: request.method, url: request.url, headers: request.headers, body: request.body },
    options,
  );

  if (sent.answer === null) {
    return {
      status: "unavailable",
      reason: "TaxCloud could not be reached, so this order is not known to be completed",
      attempts: sent.attempt,
    };
  }

  if (sent.answer.status >= 200 && sent.answer.status < 300) {
    return { status: "completed", orderId: input.invoiceId, alreadyExisted: false };
  }

  const failure = taxCloudFailureOf(sent.answer.status, parseJson(sent.answer.body));

  if (failure.retryable) {
    return {
      status: "unavailable",
      reason: `${failure.officeMessage} (HTTP ${String(sent.answer.status)})`,
      attempts: sent.attempt,
    };
  }

  if (TAXCLOUD_INVOICE_READBACK_STATUSES.includes(sent.answer.status)) {
    const exists = await orderExists(
      { connectionId: connection.connectionId, apiKey: connection.apiKey, orderId: input.invoiceId },
      options,
    );

    if (exists) return { status: "completed", orderId: input.invoiceId, alreadyExisted: true };
  }

  return {
    status: "rejected",
    reason: failure.detail ?? failure.officeMessage,
    code: failure.code,
    httpStatus: sent.answer.status,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The totals a screen shows
 * ---------------------------------------------------------------------------------------------- */

/**
 * The invoice's tax as one number, refused when the lines and the total disagree.
 *
 * The invoice writer stores `invoices.tax_minor` and, in STEP 180, one row per line. This function is how
 * the two are kept one number: a caller that passes a total that is not the sum of the lines gets a
 * refusal rather than an invoice whose parts do not add up.
 */
export function taxCloudInvoiceTaxTotalOf(tax: TaxCloudInvoiceTax): { readonly totalTaxMinor: bigint } {
  const sum = tax.lines.reduce((total, line) => total + line.taxMinor, 0n);

  if (sum !== tax.totalTaxMinor) {
    throw new AppError("INTERNAL_ERROR", {
      details: [{ field: "tax", rule: "the line amounts do not add up to the invoice's tax" }],
    });
  }

  return { totalTaxMinor: sum };
}

/** The provider this module's calls belong to, for a caller that records which provider priced an invoice. */
export const TAXCLOUD_INVOICE_TAX_PROVIDER_KEY = TAXCLOUD_PROVIDER_KEY;

/** Every status a calculation can answer, for a caller that switches on one. */
export function isTaxCloudInvoiceTaxStatus(value: string): value is TaxCloudInvoiceTaxStatus {
  return (TAXCLOUD_INVOICE_TAX_STATUSES as readonly string[]).includes(value);
}

/** The problem body of a rejection, read through STEP 176's reader, for a caller that wants the fields. */
export function taxCloudInvoiceProblemsOf(body: string): ReturnType<typeof taxCloudProblemOf> {
  let parsed: unknown = null;

  try {
    parsed = body.trim().length === 0 ? null : (JSON.parse(body) as unknown);
  } catch {
    parsed = null;
  }

  return taxCloudProblemOf(parsed);
}
