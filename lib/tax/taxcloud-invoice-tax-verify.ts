// path: lib/tax/taxcloud-invoice-tax-verify.ts

/**
 * The gate for the invoice tax calculation.
 *
 * Run directly, because the TaxCloud block owns `lib/tax/` and not `package.json`:
 *
 *   node lib/tax/taxcloud-invoice-tax-verify.ts
 *
 * Ten sections: the constants against the migrations and the price module, the validation, the two
 * conversions, the cart body, the answer reader, the calculation, the retry schedule, the completion,
 * the totals, and the source.
 *
 * Nothing reaches the network: the transport is a scripted function, the sleep is a recorder, and the
 * connection rows are built through STEP 177's store with the real cipher, so a fixture cannot describe a
 * row the database would refuse.
 */

import { readFileSync } from "node:fs";
import { AppError } from "../errors/app-error.ts";
import { openSecret, sealSecret } from "../auth/secrets.ts";
import type { SecretBox } from "../auth/secrets.ts";
import { TAXCLOUD_API_BASE, taxCloudPriceOf } from "./taxcloud.ts";
import {
  InMemoryTaxCloudConnectionStore,
  taxCloudApiKeyScope,
  taxCloudConnectionIdScope,
} from "./taxcloud-connect.ts";
import type {
  TaxCloudConnectionRow,
  TaxCloudSecretSealer,
  TaxCloudTransport,
  TaxCloudTransportAnswer,
  TaxCloudTransportCall,
} from "./taxcloud-connect.ts";
import { TAXCLOUD_COLLECTION_COUNTRIES } from "./taxcloud-collection.ts";
import {
  TAXCLOUD_INVOICE_CURRENCY,
  TAXCLOUD_INVOICE_MAXIMUM_QUANTITY_THOUSANDTHS,
  TAXCLOUD_INVOICE_MAXIMUM_UNIT_PRICE_MINOR,
  TAXCLOUD_INVOICE_MAXIMUM_WAIT_MS,
  TAXCLOUD_INVOICE_READBACK_STATUSES,
  TAXCLOUD_INVOICE_RETRY_ATTEMPTS,
  TAXCLOUD_INVOICE_RETRY_BASE_MS,
  TAXCLOUD_INVOICE_RETRYABLE_STATUSES,
  TAXCLOUD_INVOICE_TAX_STATUSES,
  TAXCLOUD_QUANTITY_THOUSANDTHS_PER_ONE,
  calculateInvoiceTax,
  completeInvoiceTaxOrder,
  isTaxCloudInvoiceTaxStatus,
  taxCloudCartAnswerOf,
  taxCloudCartBodyOf,
  taxCloudInvoiceTaxProblemOf,
  taxCloudInvoiceTaxTotalOf,
  taxCloudInvoiceProblemsOf,
  taxCloudQuantityNumberOf,
  taxCloudRetryAfterMsOf,
} from "./taxcloud-invoice-tax.ts";
import type {
  TaxCloudInvoiceAddress,
  TaxCloudInvoiceCalculationInput,
  TaxCloudInvoiceTax,
  TaxCloudInvoiceTaxOptions,
  TaxCloudInvoiceTaxResult,
} from "./taxcloud-invoice-tax.ts";

/* ---- the checking harness, the shape STEPs 170 to 178 used ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, name: string): void {
  checks += 1;
  if (condition !== true) failures.push(name);
}

function expectEqual(actual: unknown, expected: unknown, name: string): void {
  checks += 1;
  if (actual !== expected) failures.push(`${name} (read ${asText(actual)}, wanted ${asText(expected)})`);
}

/** JSON with bigints written as their digits, so a result can be searched for a secret. */
function jsonOf(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item)) ?? "";
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (typeof value === "bigint") return value.toString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorCodeOf(action: () => void): string {
  try {
    action();
    return "no_error";
  } catch (error) {
    return error instanceof AppError ? error.code : "not_an_app_error";
  }
}

/* ---- fixtures ---- */

const NOW = 1_782_000_000_000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPANY = "company_kd_tax_invoice_gate";
const CONNECTION_ID = "8f3a6c4e-5d71-4e0c-9f29-3a4b5c6d7e8f";
const INVOICE_ID = "0c5b2a19-7d4e-4f3a-8b6c-5d4e3f2a1b0c";
const CLIENT_ID = "1d6c3b20-8e5f-4a4b-9c7d-6e5f4a3b2c1d";
const API_KEY = "eyJhbGciOiJIUzI1NiJ9.taxcloud.invoice.gate.9fa1b2c";

const MASTER_KEY = Buffer.alloc(32, 17).toString("base64");

const sealer: TaxCloudSecretSealer = {
  seal: (plaintext: string, context: string) => sealSecret(MASTER_KEY, plaintext, context),
  open: (box: SecretBox, context: string) => openSecret(MASTER_KEY, box, context),
};

const ORIGIN: TaxCloudInvoiceAddress = {
  line1: "323 Washington Ave N",
  city: "Minneapolis",
  state: "MN",
  zip: "55401-2427",
  countryCode: "US",
};

const DESTINATION: TaxCloudInvoiceAddress = {
  line1: "1 Main Street",
  line2: "Suite 4",
  city: "Austin",
  state: "TX",
  zip: "78701",
  countryCode: "US",
};

/** A placeholder for a call that was not made, so a missing call is one failed check rather than a crash. */
const NO_CALL: TaxCloudTransportCall = { method: "", url: "", headers: {}, body: null };

function inputOf(patch: Partial<TaxCloudInvoiceCalculationInput> = {}): TaxCloudInvoiceCalculationInput {
  return {
    companyId: COMPANY,
    invoiceId: INVOICE_ID,
    clientId: CLIENT_ID,
    destination: DESTINATION,
    origin: ORIGIN,
    invoiceDiscountMinor: 0n,
    lines: [
      {
        itemId: "line-1",
        index: 0,
        quantityThousandths: 1_500n,
        unitPriceMinor: 107_500n,
        discountMinor: 0n,
      },
    ],
    ...patch,
  };
}

interface Scripted {
  readonly transport: TaxCloudTransport;
  readonly calls: TaxCloudTransportCall[];
}

function scriptedOf(answers: readonly (TaxCloudTransportAnswer | Error)[]): Scripted {
  const calls: TaxCloudTransportCall[] = [];
  let index = 0;

  return {
    calls,
    transport: async (call: TaxCloudTransportCall): Promise<TaxCloudTransportAnswer> => {
      calls.push(call);

      const answer = answers[Math.min(index, answers.length - 1)];

      index += 1;

      if (answer instanceof Error) throw answer;

      if (answer === undefined) throw new Error("the script ran out of answers");

      return answer;
    },
  };
}

interface Fixture {
  readonly store: InMemoryTaxCloudConnectionStore;
  readonly row: TaxCloudConnectionRow;
  readonly options: (script: Scripted, sleeps?: number[]) => TaxCloudInvoiceTaxOptions;
}

/** A merchant with one verified, switched-on connection: the state an invoice may be priced in. */
async function fixtureOf(overrides: { readonly enabled?: boolean; readonly status?: "pending" | "active" } = {}): Promise<Fixture> {
  const store = new InMemoryTaxCloudConnectionStore({ now: () => NOW });
  const inserted = await store.insert({
    companyId: COMPANY,
    connectionIdLastFour: CONNECTION_ID.slice(-4),
    connectionIdBox: sealer.seal(CONNECTION_ID, taxCloudConnectionIdScope(COMPANY)),
    apiKeyLastFour: API_KEY.slice(-4),
    apiKeyBox: sealer.seal(API_KEY, taxCloudApiKeyScope(COMPANY)),
    encryptionKeyVersion: 1,
    status: "pending",
    collectionEnabled: false,
    verifiedAtEpochMs: null,
    lastError: null,
  });
  const wanted = overrides.status ?? "active";
  let row = inserted;

  if (wanted === "active") {
    row = await move(store, row, { status: "active", verifiedAtEpochMs: NOW - MINUTE_MS });
  }

  if ((overrides.enabled ?? true) && wanted === "active") {
    row = await move(store, row, { collectionEnabled: true });
  }

  const finalRow = row;

  return {
    store,
    row: finalRow,
    options: (script: Scripted, sleeps: number[] = []): TaxCloudInvoiceTaxOptions => ({
      store,
      sealer,
      transport: script.transport,
      now: () => NOW,
      sleep: async (milliseconds: number): Promise<void> => {
        sleeps.push(milliseconds);
      },
    }),
  };
}

async function move(
  store: InMemoryTaxCloudConnectionStore,
  row: TaxCloudConnectionRow,
  patch: Partial<TaxCloudConnectionRow>,
): Promise<TaxCloudConnectionRow> {
  const next: TaxCloudConnectionRow = { ...row, ...patch, updatedAtEpochMs: NOW, version: row.version + 1 };
  const saved = await store.save(next, row.version);

  if (saved === false) throw new Error("the fixture could not move its row");

  return next;
}

/** A cart answer with the documented envelope and one line per entry. */
function cartAnswerOf(
  lines: readonly { readonly itemId: string; readonly index: number; readonly amount: number | string; readonly rate?: number }[],
  patch: Readonly<Record<string, unknown>> = {},
): TaxCloudTransportAnswer {
  return {
    status: 200,
    body: JSON.stringify({
      connectionId: CONNECTION_ID,
      transactionDate: "2026-11-07T10:00:00Z",
      items: [
        {
          cartId: INVOICE_ID,
          currency: { currencyCode: "USD" },
          customerId: CLIENT_ID,
          destination: { ...DESTINATION },
          origin: { ...ORIGIN },
          lineItems: lines.map((line) => ({
            index: line.index,
            itemId: line.itemId,
            originalPrice: 10.75,
            price: 10.75,
            quantity: 1.5,
            tax: { amount: line.amount, ...(line.rate === undefined ? { rate: 0.08125 } : { rate: line.rate }) },
            tic: 0,
          })),
          ...patch,
        },
      ],
      ...patch,
    }),
  };
}

/* ---- section 1: the constants ---- */

function checkConstants(): void {
  expectEqual(TAXCLOUD_INVOICE_CURRENCY, "USD", "the platform bills in one currency");
  expectEqual(TAXCLOUD_QUANTITY_THOUSANDTHS_PER_ONE, 1_000n, "a quantity has three decimals");
  expectEqual(TAXCLOUD_INVOICE_MAXIMUM_QUANTITY_THOUSANDTHS, 1_000_000_000n, "a quantity is at most one million units");
  expectEqual(TAXCLOUD_INVOICE_MAXIMUM_UNIT_PRICE_MINOR, 1_000_000_000_000n, "the price ceiling is the price module's");
  expectEqual(TAXCLOUD_INVOICE_RETRY_ATTEMPTS, 2, "two retries after the first attempt");
  expectEqual(TAXCLOUD_INVOICE_RETRY_BASE_MS, 250, "the first wait is a quarter of a second");
  expectEqual(TAXCLOUD_INVOICE_MAXIMUM_WAIT_MS, 3_000, "no wait is longer than three seconds");
  expectEqual(TAXCLOUD_INVOICE_RETRYABLE_STATUSES.join(","), "429,500,503", "the retryable statuses are STEP 176's");
  expectEqual(TAXCLOUD_INVOICE_READBACK_STATUSES.join(","), "400,409,422", "the statuses that are read back");
  expectEqual(TAXCLOUD_INVOICE_TAX_STATUSES.join(","), "calculated,not_collected,refused,rejected,unavailable,failed", "six answers");
  expectEqual(TAXCLOUD_COLLECTION_COUNTRIES.join(","), "US", "the scope is STEP 178's");

  // The invoice's own bounds, read from the migration rather than restated.
  const lineItems = readFileSync(new URL("../../migrations/0023_invoice_items.sql", import.meta.url), "utf8");
  const invoices = readFileSync(new URL("../../migrations/0022_invoices.sql", import.meta.url), "utf8");
  const products = readFileSync(new URL("../../services/products/price.ts", import.meta.url), "utf8");

  expect(lineItems.includes("quantity > 0 and quantity <= 1000000"), "the line migration bounds a quantity above zero and at one million units");
  expect(lineItems.includes("numeric(12,3)"), "and stores three decimals, which is what thousandths are");
  expect(lineItems.includes("((quantity * unit_price_minor)::bigint - discount_minor)"), "the line total truncates the product, which is the gross this module mirrors");
  expect(invoices.includes("discount_minor >= 0 and discount_minor <= subtotal_minor"), "the invoice discount is bounded by the subtotal");
  expect(invoices.includes("total_minor = subtotal_minor - discount_minor + tax_minor"), "and the invoice total is the database's own arithmetic");
  expect(products.includes("PRICE_MAXIMUM_MINOR = 1_000_000_000_000n"), "the price ceiling is the price module's own");
  expect(products.includes("PRICE_SCALE = 4"), "and its money scale is the one these minor units use");

  for (const status of TAXCLOUD_INVOICE_TAX_STATUSES) {
    expect(isTaxCloudInvoiceTaxStatus(status), `the status reader accepts ${status}`);
  }

  expectEqual(isTaxCloudInvoiceTaxStatus("priced"), false, "and refuses a word outside the six");
}

/* ---- section 2: the validation ---- */

function checkValidation(): void {
  expectEqual(taxCloudInvoiceTaxProblemOf(inputOf()), null, "a complete invoice is priceable");

  const refusals: readonly (readonly [string, Partial<TaxCloudInvoiceCalculationInput>])[] = [
    ["an invoice id with a space", { invoiceId: "invoice 1" }],
    ["an empty invoice id", { invoiceId: "" }],
    ["a client id with a slash", { clientId: "client/1" }],
    ["no lines", { lines: [] }],
    ["an origin with no city", { origin: { ...ORIGIN, city: " " } }],
    ["an origin state that is a word", { origin: { ...ORIGIN, state: "Minnesota" } }],
    ["an origin ZIP of four digits", { origin: { ...ORIGIN, zip: "5540" } }],
    ["a destination with no street", { destination: { ...DESTINATION, line1: "" } }],
    ["a United States destination ZIP with letters", { destination: { ...DESTINATION, zip: "TX78701" } }],
    ["a destination country with no name", { destination: { ...DESTINATION, countryCode: "" } }],
    ["a negative invoice discount", { invoiceDiscountMinor: -1n }],
    ["two lines with one key", {
      lines: [
        { itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: 0n },
        { itemId: "line-1", index: 0, quantityThousandths: 2_000n, unitPriceMinor: 100n, discountMinor: 0n },
      ],
    }],
    ["a zero quantity", { lines: [{ itemId: "line-1", index: 0, quantityThousandths: 0n, unitPriceMinor: 100n, discountMinor: 0n }] }],
    ["a quantity past the ceiling", {
      lines: [{ itemId: "line-1", index: 0, quantityThousandths: TAXCLOUD_INVOICE_MAXIMUM_QUANTITY_THOUSANDTHS + 1n, unitPriceMinor: 1n, discountMinor: 0n }],
    }],
    ["a negative price", { lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: -1n, discountMinor: 0n }] }],
    ["a price past the ceiling", {
      lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: TAXCLOUD_INVOICE_MAXIMUM_UNIT_PRICE_MINOR + 1n, discountMinor: 0n }],
    }],
    ["a negative line discount", { lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: -1n }] }],
    ["a line discount past the gross", { lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: 101n }] }],
    ["an invoice discount past the subtotal", {
      invoiceDiscountMinor: 101n,
      lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: 0n }],
    }],
    ["a TIC past the range", { lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: 0n, tic: 100_000 }] }],
    ["a fractional TIC", { lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: 0n, tic: 1.5 }] }],
    ["a negative line index", { lines: [{ itemId: "line-1", index: -1, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: 0n }] }],
  ];

  for (const [name, patch] of refusals) {
    expect(taxCloudInvoiceTaxProblemOf(inputOf(patch)) !== null, `the validation refuses ${name}`);
  }

  expectEqual(
    taxCloudInvoiceTaxProblemOf(
      inputOf({ lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: 100n, tic: 0 }] }),
    ),
    null,
    "a fully discounted line is still priceable",
  );
  expectEqual(
    taxCloudInvoiceTaxProblemOf(
      inputOf({ lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: 101n }] }),
    ),
    "a line discount is at most the line's gross amount",
    "a discount past one line is refused for that line, not for the invoice",
  );
  expectEqual(
    taxCloudInvoiceTaxProblemOf(inputOf({ invoiceDiscountMinor: 161_251n })),
    "an invoice discount is at most the invoice's subtotal",
    "an invoice discount past the subtotal names the subtotal",
  );
  expectEqual(
    taxCloudInvoiceTaxProblemOf(inputOf({ invoiceDiscountMinor: 100_000n })),
    null,
    "an invoice discount equal to the subtotal is the invoice's own bound",
  );
  expectEqual(
    taxCloudInvoiceTaxProblemOf(
      inputOf({ lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: 0n, tic: 99_999 }] }),
    ),
    null,
    "the highest TIC is priceable",
  );
}

/* ---- section 3: the two conversions ---- */

function checkConversions(): void {
  expectEqual(taxCloudQuantityNumberOf(1_000n), 1, "one unit is 1");
  expectEqual(taxCloudQuantityNumberOf(2_500n), 2.5, "two and a half units is 2.5");
  expectEqual(taxCloudQuantityNumberOf(333n), 0.333, "a third of a unit keeps its three decimals");
  expectEqual(taxCloudQuantityNumberOf(1n), 0.001, "one thousandth is 0.001");
  expectEqual(taxCloudQuantityNumberOf(1_000_000_000n), 1_000_000, "the ceiling round-trips");
  expectEqual(String(taxCloudQuantityNumberOf(2_500n)), "2.5", "the number's own spelling is the decimal sent");

  for (const thousandths of [1n, 7n, 99n, 333n, 1_001n, 12_345n, 999_999n, 1_234_567n]) {
    const value = taxCloudQuantityNumberOf(thousandths);
    const expected = `${(thousandths / 1_000n).toString()}.${(thousandths % 1_000n).toString().padStart(3, "0")}`;

    expectEqual(String(value), expected.replace(/\.?0+$/u, ""), `the quantity ${String(thousandths)} round-trips exactly`);
  }

  expectEqual(errorCodeOf(() => taxCloudQuantityNumberOf(0n)), "VALIDATION_FAILED", "a zero quantity is refused");
  expectEqual(errorCodeOf(() => taxCloudQuantityNumberOf(-1n)), "VALIDATION_FAILED", "a negative quantity is refused");

  // The price side is STEP 176's, and this proves the invoice's minor units are the ones it expects.
  expectEqual(taxCloudPriceOf(107_500n), 10.75, "ten dollars seventy five converts exactly");
  expectEqual(taxCloudPriceOf(131_000n), 13.1, "a whole cent value converts exactly");
  expectEqual(errorCodeOf(() => taxCloudPriceOf(107_550n)), "VALIDATION_FAILED", "a sub-cent price is refused, not rounded");
  expectEqual(String(taxCloudPriceOf(1n * 10_000n)), "1", "one dollar converts to 1");
}

/* ---- section 4: the cart body ---- */

async function checkCartBody(): Promise<void> {
  const fixture = await fixtureOf();
  const body = taxCloudCartBodyOf(inputOf(), [fixture.row]);
  const item = (body.items[0] ?? {}) as Readonly<Record<string, unknown>>;
  const lineItems = item["lineItems"] as readonly Readonly<Record<string, unknown>>[];
  const line = lineItems[0] as Readonly<Record<string, unknown>>;
  const destination = item["destination"] as Readonly<Record<string, unknown>>;
  const origin = item["origin"] as Readonly<Record<string, unknown>>;

  expectEqual(body.items.length, 1, "one cart per invoice");
  expectEqual(item["cartId"], INVOICE_ID, "the cart id is the invoice id, so a retry upserts");
  expectEqual(item["customerId"], CLIENT_ID, "the customer is the client");
  expectEqual((item["currency"] as Readonly<Record<string, unknown>>)["currencyCode"], "USD", "the currency is dollars");
  expectEqual(line["index"], 0, "the line carries its index");
  expectEqual(line["itemId"], "line-1", "the line carries its id");
  expectEqual(line["price"], 10.75, "the price is the unit price as a JSON number");
  expectEqual(typeof line["price"], "number", "the price is a number, never a string");
  expectEqual(line["quantity"], 1.5, "the quantity is a JSON number");
  expectEqual(line["tic"], undefined, "a line without a TIC sends none");
  expectEqual(destination["state"], "TX", "the destination state is kept");
  expectEqual(destination["zip"], "78701", "the destination ZIP is kept");
  expectEqual(destination["line2"], "Suite 4", "the second line is sent when there is one");
  expectEqual(destination["countryCode"], "US", "the destination names its country");
  expectEqual(origin["line1"], ORIGIN.line1, "the origin is the merchant's address");
  expectEqual(item["discounts"], undefined, "an invoice with no discount sends none");
  expectEqual(JSON.stringify(body).includes(API_KEY), false, "the body holds no key");
  expectEqual(JSON.stringify(body).includes("Bearer"), false, "the body holds no token");

  const lowered = taxCloudCartBodyOf(
    inputOf({
      destination: { ...DESTINATION, state: "tx", countryCode: "us", line1: "  1 Main Street  " },
      lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 100n, discountMinor: 0n, tic: 11_015 }],
    }),
    [fixture.row],
  );
  const loweredItem = (lowered.items[0] ?? {}) as Readonly<Record<string, unknown>>;
  const loweredLine = (loweredItem["lineItems"] as readonly Readonly<Record<string, unknown>>[])[0] as Readonly<Record<string, unknown>>;

  expectEqual((loweredItem["destination"] as Readonly<Record<string, unknown>>)["state"], "TX", "a state is sent upper case");
  expectEqual((loweredItem["destination"] as Readonly<Record<string, unknown>>)["countryCode"], "US", "a country is sent upper case");
  expectEqual((loweredItem["destination"] as Readonly<Record<string, unknown>>)["line1"], "1 Main Street", "a street is trimmed");
  expectEqual(loweredLine["tic"], 11_015, "a TIC is sent when the merchant assigned one");
  expectEqual(loweredLine["price"], 0.01, "a one cent price is 0.01");

  const discounted = taxCloudCartBodyOf(
    inputOf({
      invoiceDiscountMinor: 5_000n,
      lines: [
        { itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 10_000n, discountMinor: 1_000n },
        { itemId: "line-2", index: 1, quantityThousandths: 1_000n, unitPriceMinor: 10_000n, discountMinor: 0n },
      ],
    }),
    [fixture.row],
  );
  const discounts = ((discounted.items[0] ?? {}) as Readonly<Record<string, unknown>>)["discounts"] as Readonly<Record<string, unknown>>;
  const lineDiscounts = discounts["lineItemDiscounts"] as readonly Readonly<Record<string, unknown>>[];

  expectEqual(lineDiscounts.length, 1, "only the discounted line carries a line discount");
  expectEqual(lineDiscounts[0]?.["itemId"], "line-1", "the discount names its line");
  expectEqual(lineDiscounts[0]?.["type"], "amount", "the discount is an amount");
  expectEqual(lineDiscounts[0]?.["value"], 0.1, "the discount is a dollar amount");
  expectEqual(lineDiscounts[0]?.["cartItemIndex"], 0, "the discount names the line's index");
  expectEqual((discounts["orderDiscount"] as Readonly<Record<string, unknown>>)["value"], 0.5, "the invoice discount is an order discount");

  const noDiscounts = taxCloudCartBodyOf(
    inputOf({ lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 10_000n, discountMinor: 0n }] }),
    [fixture.row],
  );

  expectEqual(((noDiscounts.items[0] ?? {}) as Readonly<Record<string, unknown>>)["discounts"], undefined, "no discount means no field");

  // A cart needs a usable connection to belong to.
  expectEqual(
    errorCodeOf(() => taxCloudCartBodyOf(inputOf(), [{ ...fixture.row, deletedAtEpochMs: NOW }])),
    "CONFLICT",
    "a deleted connection cannot belong to a cart",
  );
}

/* ---- section 5: the answer reader ---- */

function checkAnswer(): void {
  const one = taxCloudCartAnswerOf(cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1.31 }]).body, inputOf());

  const tax = "tax" in one ? one.tax : null;

  expect(tax !== null, "a well-formed answer is read");
  expectEqual(tax === null ? null : tax.totalTaxMinor, 13_100n, "one dollar thirty one is thirteen thousand one hundred minor units");
  expectEqual(tax?.lines[0]?.rate, 0.08125, "the documented rate is kept as information");
  expectEqual(tax?.totalTaxMinor, 13_100n, "one line's tax is the total");
  expectEqual(tax?.cartId, INVOICE_ID, "the cart id is the invoice's");
  expectEqual(tax?.currency, "USD", "the answer is a dollar answer");
  expectEqual(tax?.transactionDate, "2026-11-07T10:00:00Z", "the transaction instant is kept");

  const two = taxCloudCartAnswerOf(
    cartAnswerOf([
      { itemId: "line-1", index: 0, amount: 1.31 },
      { itemId: "line-2", index: 1, amount: 2.5 },
    ]).body,
    inputOf({
      lines: [
        { itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 10_000n, discountMinor: 0n },
        { itemId: "line-2", index: 1, quantityThousandths: 1_000n, unitPriceMinor: 10_000n, discountMinor: 0n },
      ],
    }),
  );

  expectEqual("tax" in two ? two.tax.totalTaxMinor : null, 38_100n, "the total is the sum of the lines");
  expectEqual("tax" in two ? two.tax.lines.length : null, 2, "both lines are read");

  const asString = taxCloudCartAnswerOf(cartAnswerOf([{ itemId: "line-1", index: 0, amount: "8.4375" }]).body, inputOf());

  expectEqual("tax" in asString ? asString.tax.lines[0]?.taxMinor : null, 84_375n, "a string amount is read exactly");

  const noRate = taxCloudCartAnswerOf(cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1, rate: 81.25 }]).body, inputOf());

  expectEqual("tax" in noRate ? noRate.tax.lines[0]?.rate : "tax" in noRate ? null : "unread", null, "a rate outside zero to one is not information");

  const refusals: readonly (readonly [string, string])[] = [
    ["an empty body", ""],
    ["a body that is not JSON", "not json"],
    ["an answer that is not an object", "[]"],
    ["an answer with no items", JSON.stringify({ connectionId: CONNECTION_ID })],
    ["an answer with an empty items list", JSON.stringify({ items: [] })],
    ["an answer for another cart", JSON.stringify({ items: [{ cartId: "another", lineItems: [] }] })],
    ["an answer with no line items", JSON.stringify({ items: [{ cartId: INVOICE_ID }] })],
    ["a line that is not an object", JSON.stringify({ items: [{ cartId: INVOICE_ID, lineItems: [3] }] })],
    ["a line with no id", JSON.stringify({ items: [{ cartId: INVOICE_ID, lineItems: [{ index: 0, tax: { amount: 1 } }] }] })],
    ["a line with a fractional index", JSON.stringify({ items: [{ cartId: INVOICE_ID, lineItems: [{ itemId: "line-1", index: 0.5, tax: { amount: 1 } }] }] })],
    ["a line this invoice did not send", JSON.stringify({ items: [{ cartId: INVOICE_ID, lineItems: [{ itemId: "line-9", index: 9, tax: { amount: 1 } }] }] })],
    ["a line with no tax", JSON.stringify({ items: [{ cartId: INVOICE_ID, lineItems: [{ itemId: "line-1", index: 0 }] }] })],
    ["a line with no amount", JSON.stringify({ items: [{ cartId: INVOICE_ID, lineItems: [{ itemId: "line-1", index: 0, tax: { rate: 0.08 } }] }] })],
    ["a negative amount", JSON.stringify({ items: [{ cartId: INVOICE_ID, lineItems: [{ itemId: "line-1", index: 0, tax: { amount: -1 } }] }] })],
    ["an amount with five decimals", JSON.stringify({ items: [{ cartId: INVOICE_ID, lineItems: [{ itemId: "line-1", index: 0, tax: { amount: "1.31234" } }] }] })],
    ["an amount that is not a number", JSON.stringify({ items: [{ cartId: INVOICE_ID, lineItems: [{ itemId: "line-1", index: 0, tax: { amount: true } }] }] })],
    ["fewer lines than the invoice", JSON.stringify({ items: [{ cartId: INVOICE_ID, lineItems: [] }] })],
  ];

  for (const [name, body] of refusals) {
    const answer = taxCloudCartAnswerOf(body, inputOf());

    expect("reason" in answer, `the reader refuses ${name}`);
  }

  const duplicate = taxCloudCartAnswerOf(
    JSON.stringify({
      items: [
        {
          cartId: INVOICE_ID,
          lineItems: [
            { itemId: "line-1", index: 0, tax: { amount: 1 } },
            { itemId: "line-1", index: 0, tax: { amount: 2 } },
          ],
        },
      ],
    }),
    inputOf(),
  );

  expect("reason" in duplicate, "a duplicated line is refused rather than summed twice");

  const oneOfTwo = taxCloudCartAnswerOf(
    JSON.stringify({
      items: [
        { cartId: "another-cart", lineItems: [{ itemId: "line-1", index: 0, tax: { amount: 99 } }] },
        { cartId: INVOICE_ID, lineItems: [{ itemId: "line-1", index: 0, tax: { amount: 1 } }] },
      ],
    }),
    inputOf(),
  );

  expectEqual("tax" in oneOfTwo ? oneOfTwo.tax.totalTaxMinor : null, 10_000n, "the cart with our id is read, not the first in the list");

  const problems = taxCloudInvoiceProblemsOf(JSON.stringify({ title: "Unprocessable", detail: "the address is incomplete", status: 422 }));

  expectEqual(problems.detail, "the address is incomplete", "the problem reader keeps TaxCloud's detail");
  expectEqual(taxCloudInvoiceProblemsOf("not json").detail, null, "and reads a body that is not JSON as nothing");
}

/* ---- section 6: the calculation ---- */

async function checkCalculate(): Promise<void> {
  const fixture = await fixtureOf();
  const script = scriptedOf([cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1.31 }])]);
  const answered = await calculateInvoiceTax(inputOf(), fixture.options(script));

  expectEqual(answered.status, "calculated", "a verified switched-on merchant is priced");
  expectEqual(answered.status === "calculated" ? answered.tax.totalTaxMinor : null, 13_100n, "the tax is in minor units");
  expectEqual(script.calls.length, 1, "one call is enough when it succeeds");

  // A mutation that stops the call must be reported as a check, not a crash, so the first call is read
  // through a placeholder when there is none.
  const call = script.calls[0] ?? NO_CALL;

  expectEqual(call.method, "POST", "a cart is created with POST");
  expectEqual(call.url, `${TAXCLOUD_API_BASE}/tax/connections/${CONNECTION_ID}/carts`, "the URL is the documented cart");
  expectEqual(call.headers["X-API-KEY"], API_KEY, "the key travels in the one header");
  expectEqual(call.headers["Content-Type"], "application/json", "a body carries its content type");
  expectEqual(Object.keys(call.headers).includes("Authorization"), false, "no Authorization header is built");
  expectEqual(call.url.includes(API_KEY), false, "the key is not in the URL");
  expect(call.body !== null && call.body.includes(INVOICE_ID), "the body names the invoice as its cart id");
  expectEqual(call.body !== null && call.body.includes(API_KEY), false, "the body holds no key");

  const switchedOff = await fixtureOf({ enabled: false });
  const offScript = scriptedOf([cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1.31 }])]);
  const off = await calculateInvoiceTax(inputOf(), switchedOff.options(offScript));

  expectEqual(off.status, "not_collected", "a merchant who switched collection off is not priced");
  expectEqual(off.status === "not_collected" ? off.decision.reason : "", "switched_off", "and the decision says why");
  expectEqual(offScript.calls.length, 0, "no call is made for a switched-off merchant");

  const pending = await fixtureOf({ status: "pending" });
  const pendingScript = scriptedOf([cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1.31 }])]);
  const unverified = await calculateInvoiceTax(inputOf(), pending.options(pendingScript));

  expectEqual(unverified.status, "not_collected", "an unverified connection is not priced");
  expectEqual(unverified.status === "not_collected" ? unverified.decision.reason : "", "unverified", "and the decision says why");
  expectEqual(pendingScript.calls.length, 0, "no call is made without a verified connection");

  const canadian = await calculateInvoiceTax(
    inputOf({ destination: { ...DESTINATION, countryCode: "CA", zip: "K1A 0B1" } }),
    fixture.options(scriptedOf([cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1.31 }])])),
  );

  expectEqual(canadian.status, "not_collected", "a Canadian destination is not priced");
  expectEqual(canadian.status === "not_collected" ? canadian.decision.reason : "", "outside_united_states", "the decision names the scope");

  const refused = await calculateInvoiceTax(inputOf({ lines: [] }), fixture.options(scriptedOf([{ status: 200, body: "{}" }])));

  expectEqual(refused.status, "refused", "an invoice with no line is refused before any call");
  expectEqual(refused.status === "refused" ? refused.reason : "", "an invoice with no line has nothing to price", "the reason is the validation's");

  const brokenBox = await fixtureOf();
  const brokenScript = scriptedOf([{ status: 200, body: "{}" }]);
  const brokenOptions: TaxCloudInvoiceTaxOptions = {
    ...brokenScriptedOptions(brokenBox, brokenScript),
    sealer: {
      seal: (plaintext: string, context: string) => sealSecret(MASTER_KEY, plaintext, context),
      open: () => {
        throw new AppError("INTERNAL_ERROR");
      },
    },
  };
  const failed = await calculateInvoiceTax(inputOf(), brokenOptions);

  expectEqual(failed.status, "failed", "an unopenable credential is a failure");
  expectEqual(brokenScript.calls.length, 0, "and no call is made with nothing to open");

  const rejectedFixture = await fixtureOf();
  const rejected = await calculateInvoiceTax(
    inputOf(),
    rejectedFixture.options(scriptedOf([{ status: 422, body: JSON.stringify({ title: "Unprocessable Entity", detail: "the destination address is incomplete", status: 422 }) }])),
  );

  expectEqual(rejected.status, "rejected", "a 422 is a rejection");
  expectEqual(rejected.status === "rejected" ? rejected.reason : "", "the destination address is incomplete", "TaxCloud's detail is kept");
  expectEqual(rejected.status === "rejected" ? rejected.code : "", "VALIDATION_FAILED", "and mapped onto this platform's code");
  expectEqual(rejected.status === "rejected" ? rejected.httpStatus : null, 422, "with the status for the record");

  const unauthorized = await calculateTaxWith(401, "{}");

  expectEqual(unauthorized.status, "rejected", "a 401 is a rejection");
  expectEqual(unauthorized.status === "rejected" ? unauthorized.code : "", "DEPENDENCY_FAILED", "a dead key is a dependency failure");
  expectEqual(unauthorized.status === "rejected" ? unauthorized.httpStatus : null, 401, "and says which status");

  const notFound = await calculateTaxWith(404, "{}");

  expectEqual(notFound.status === "rejected" ? notFound.code : "", "RESOURCE_NOT_FOUND", "a 404 is a resource refusal");

  const malformed = await fixtureOf();
  const malformedScript = scriptedOf([{ status: 200, body: "{}" }]);
  const brokenStore = {
    listByCompany: async () => [{ ...malformed.row, connectionIdBox: sealer.seal("not-a-connection", taxCloudConnectionIdScope(COMPANY)) }],
    findById: malformed.store.findById.bind(malformed.store),
    insert: malformed.store.insert.bind(malformed.store),
    save: malformed.store.save.bind(malformed.store),
  } as unknown as typeof malformed.store;
  const unaddressable = await calculateInvoiceTax(inputOf(), { ...malformed.options(malformedScript), store: brokenStore });

  expectEqual(unaddressable.status, "failed", "a stored connection id that is not one is a failure, not an exception");
  expectEqual(malformedScript.calls.length, 0, "and no request is built");

  const failedShape = await calculateTaxWith(200, "{}");

  expectEqual(failedShape.status, "failed", "a 200 that is not a cart is a failure");
  expectEqual(failedShape.status === "failed" ? failedShape.reason : "", "TaxCloud answered a cart with no items", "the reason names the shape");
}

async function calculateTaxWith(status: number, body: string): Promise<TaxCloudInvoiceTaxResult> {
  const fixture = await fixtureOf();

  return calculateInvoiceTax(inputOf(), fixture.options(scriptedOf([{ status, body }])));
}

function brokenScriptedOptions(
  fixture: Fixture,
  script: Scripted,
): TaxCloudInvoiceTaxOptions {
  void fixture;

  return {
    store: fixture.store,
    sealer,
    transport: script.transport,
    now: () => NOW,
    sleep: async (): Promise<void> => undefined,
  };
}

/* ---- section 7: the retry schedule ---- */

async function checkRetry(): Promise<void> {
  const fixture = await fixtureOf();

  for (const status of [429, 500, 503]) {
    const sleeps: number[] = [];
    const script = scriptedOf([{ status, body: "{}" }]);
    const answered = await calculateInvoiceTax(inputOf(), fixture.options(script, sleeps));

    expectEqual(answered.status, "unavailable", `a ${String(status)} is unavailable after the retries`);
    expectEqual(answered.status === "unavailable" ? answered.attempts : null, TAXCLOUD_INVOICE_RETRY_ATTEMPTS + 1, `a ${String(status)} is tried three times`);
    expectEqual(script.calls.length, TAXCLOUD_INVOICE_RETRY_ATTEMPTS + 1, `a ${String(status)} makes three calls`);
    expectEqual(sleeps.join(","), "250,500", `the ${String(status)} waits double`);
  }

  const sleeps: number[] = [];
  const recovered = await calculateInvoiceTax(
    inputOf(),
    fixture.options(
      scriptedOf([{ status: 500, body: "{}" }, cartAnswerOf([{ itemId: "line-1", index: 0, amount: 2 }])]),
      sleeps,
    ),
  );

  expectEqual(recovered.status, "calculated", "a second attempt can succeed");
  expectEqual(recovered.status === "calculated" ? recovered.tax.totalTaxMinor : null, 20_000n, "and the answer is read");
  expectEqual(sleeps.join(","), "250", "one wait for one retry");

  const networkSleeps: number[] = [];
  const unreachable = await calculateInvoiceTax(
    inputOf(),
    fixture.options(scriptedOf([new Error("socket hang up")]), networkSleeps),
  );

  expectEqual(unreachable.status, "unavailable", "a network failure is unavailable");
  expectEqual(unreachable.status === "unavailable" ? unreachable.attempts : null, 3, "after three attempts");
  expectEqual(networkSleeps.join(","), "250,500", "with the same schedule");

  const retryAfterSleeps: number[] = [];
  const honoured = await calculateInvoiceTax(
    inputOf(),
    fixture.options(
      scriptedOf([
        { status: 429, body: "{}", headers: { "retry-after": "2" } },
        cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1 }]),
      ]),
      retryAfterSleeps,
    ),
  );

  expectEqual(honoured.status, "calculated", "a rate limited call can recover");
  expectEqual(retryAfterSleeps.join(","), "2000", "the documented Retry-After is honoured in seconds");

  expectEqual(taxCloudRetryAfterMsOf({ "retry-after": "2" }, NOW), 2_000, "two seconds is two thousand milliseconds");
  expectEqual(taxCloudRetryAfterMsOf({ "retry-after": "900" }, NOW), TAXCLOUD_INVOICE_MAXIMUM_WAIT_MS, "a long wait is capped");
  expectEqual(
    taxCloudRetryAfterMsOf({ "retry-after": new Date(NOW + 1_500).toISOString() }, NOW),
    1_500,
    "an HTTP date is read against the clock",
  );
  expectEqual(taxCloudRetryAfterMsOf({ "retry-after": new Date(NOW - 5_000).toISOString() }, NOW), 0, "a past date is no wait");
  expectEqual(taxCloudRetryAfterMsOf({ "retry-after": "soon" }, NOW), null, "a value that is neither is ignored");
  expectEqual(taxCloudRetryAfterMsOf(undefined, NOW), null, "no headers is no wait");
  expectEqual(taxCloudRetryAfterMsOf({}, NOW), null, "another header is no wait");
}

/* ---- section 8: the completion ---- */

async function checkCompletion(): Promise<void> {
  const fixture = await fixtureOf();
  const completed = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(scriptedOf([{ status: 201, body: "{}" }])),
  );

  expectEqual(completed.status, "completed", "a 201 completes the order");
  expectEqual(completed.status === "completed" ? completed.orderId : null, INVOICE_ID, "the order id is the invoice's");
  expectEqual(completed.status === "completed" ? completed.alreadyExisted : null, false, "and it is new");

  const completionScript = scriptedOf([{ status: 201, body: "{}" }]);

  await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(completionScript),
  );

  const call = completionScript.calls[0] ?? NO_CALL;

  expectEqual(call.url, `${TAXCLOUD_API_BASE}/tax/connections/${CONNECTION_ID}/carts/orders`, "the URL is the documented conversion");
  expect(call.body !== null && call.body.includes(`"orderId":"${INVOICE_ID}"`), "the body names the order with the invoice's id");
  expect(call.body !== null && call.body.includes(`"cartId":"${INVOICE_ID}"`), "and the same cart, so a retry is one order");
  expect(call.body !== null && call.body.includes(`"completedDate":"${new Date(NOW - MINUTE_MS).toISOString()}"`), "the body carries the completed date");
  expect(call.body !== null && call.body.includes('"completed"') === false, "the body sends the date rather than the flag");

  const future = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW + DAY_MS },
    fixture.options(scriptedOf([{ status: 201, body: "{}" }])),
  );

  expectEqual(future.status, "refused", "a future completion is refused");
  expectEqual(
    future.status === "refused" ? future.reason : "",
    "a completed date cannot be in the future, which TaxCloud answers with a 422",
    "and the refusal quotes the documented status",
  );

  const zero = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: 0 },
    fixture.options(scriptedOf([{ status: 201, body: "{}" }])),
  );

  expectEqual(zero.status, "refused", "a completion instant of zero is refused");

  // A duplicate on TaxCloud's side is read back, and an order that exists is a completed order.
  const duplicateScript = scriptedOf([{ status: 422, body: "{}" }, { status: 200, body: JSON.stringify({ orderId: INVOICE_ID }) }]);
  const duplicate = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(duplicateScript),
  );

  expectEqual(duplicate.status, "completed", "a 422 that reads back as an order is a completion");
  expectEqual(duplicate.status === "completed" ? duplicate.alreadyExisted : null, true, "and says the order already existed");
  expectEqual(duplicateScript.calls.length, 2, "the read is a second call");
  expectEqual(
    duplicateScript.calls[1]?.url ?? "",
    `${TAXCLOUD_API_BASE}/tax/connections/${CONNECTION_ID}/orders/${INVOICE_ID}`,
    "the read is the documented order fetch",
  );

  const notThere = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(scriptedOf([{ status: 422, body: "{}" }, { status: 404, body: "{}" }])),
  );

  expectEqual(notThere.status, "rejected", "a 422 whose order is not there is a rejection");
  expectEqual(notThere.status === "rejected" ? notThere.httpStatus : null, 422, "and names the original status");

  const unauthorized = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(scriptedOf([{ status: 401, body: "{}" }])),
  );

  expectEqual(unauthorized.status, "rejected", "a 401 is a rejection");
  expectEqual(unauthorized.status === "rejected" ? unauthorized.code : "", "DEPENDENCY_FAILED", "and a dead key is a dependency failure");

  const outage = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(scriptedOf([{ status: 503, body: "{}" }])),
  );

  expectEqual(outage.status, "unavailable", "a 503 leaves the order unknown");
  expectEqual(outage.status === "unavailable" ? outage.attempts : null, 3, "after the same three attempts");

  const switchedOff = await fixtureOf({ enabled: false });
  const off = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    switchedOff.options(scriptedOf([{ status: 201, body: "{}" }])),
  );

  expectEqual(off.status, "not_collected", "a switched-off merchant completes nothing");

  const canadian = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "CA", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(scriptedOf([{ status: 201, body: "{}" }])),
  );

  expectEqual(canadian.status, "not_collected", "a Canadian transaction completes nothing");

  const badId = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: "invoice 1", countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(scriptedOf([{ status: 201, body: "{}" }])),
  );

  expectEqual(badId.status, "refused", "an id that is not one is refused");
}

/* ---- section 9: the totals ---- */

function checkTotals(): void {
  const tax: TaxCloudInvoiceTax = {
    cartId: INVOICE_ID,
    currency: "USD",
    lines: [
      { itemId: "line-1", index: 0, taxMinor: 13_100n, rate: 0.08125 },
      { itemId: "line-2", index: 1, taxMinor: 20_000n, rate: 0.0825 },
    ],
    totalTaxMinor: 33_100n,
    transactionDate: null,
  };

  expectEqual(taxCloudInvoiceTaxTotalOf(tax).totalTaxMinor, 33_100n, "the lines add up");
  expectEqual(
    errorCodeOf(() => taxCloudInvoiceTaxTotalOf({ ...tax, totalTaxMinor: 33_101n })),
    "INTERNAL_ERROR",
    "a total that is not the sum is refused",
  );
  expectEqual(taxCloudInvoiceTaxTotalOf({ ...tax, lines: [], totalTaxMinor: 0n }).totalTaxMinor, 0n, "an invoice with no lines has no tax");
}

/* ---- section 11: the guarantees the invoice writer depends on ---- */

async function checkGuarantees(): Promise<void> {
  // The calculation writes nothing: the merchant's row is byte-identical afterwards, which is why this
  // module audits nothing - the invoice's own mutation is the one that is audited.
  const fixture = await fixtureOf();
  const before = JSON.stringify(await fixture.store.listByCompany(COMPANY));
  const versionBefore = fixture.row.version;
  const script = scriptedOf([cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1.31 }])]);

  await calculateInvoiceTax(inputOf(), fixture.options(script));

  expectEqual(JSON.stringify(await fixture.store.listByCompany(COMPANY)), before, "the calculation leaves the connection row untouched");
  expectEqual((await fixture.store.listByCompany(COMPANY))[0]?.version, versionBefore, "no version moves");
  expectEqual(fixture.row.updatedAtEpochMs, NOW, "and no timestamp moves");

  // Credentials are opened per call and never returned: the result cannot carry one.
  let opens = 0;
  const counting: TaxCloudSecretSealer = {
    seal: (plaintext: string, context: string) => sealSecret(MASTER_KEY, plaintext, context),
    open: (box: SecretBox, context: string) => {
      opens += 1;
      return openSecret(MASTER_KEY, box, context);
    },
  };
  const second = scriptedOf([cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1.31 }])]);
  const counted = await calculateInvoiceTax(inputOf(), { ...fixture.options(second), sealer: counting });

  expectEqual(opens, 2, "one call opens the key and the connection id, and nothing else");
  expectEqual(counted.status, "calculated", "and the call is made");

  const again = scriptedOf([cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1.31 }])]);

  await calculateInvoiceTax(inputOf(), { ...fixture.options(again), sealer: counting });

  expectEqual(opens, 4, "a second call opens them again rather than reusing a plaintext in memory");
  expectEqual(jsonOf(counted).includes(API_KEY), false, "the result carries no key");
  expectEqual(jsonOf(counted).includes(CONNECTION_ID), false, "the result carries no connection id");
  expectEqual(jsonOf(counted).includes("apiKeyBox"), false, "and no sealed box");

  // The invoice id is the cart id, so a second save for one invoice is the same cart, not a second one.
  const twice = scriptedOf([
    cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1 }]),
    cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1 }]),
  ]);

  await calculateInvoiceTax(inputOf(), fixture.options(twice));
  await calculateInvoiceTax(inputOf(), fixture.options(twice));

  const bodies = twice.calls.map((call) => call.body ?? "");

  expectEqual(bodies.length, 2, "two saves are two calls");
  expect(bodies.every((body) => body.includes(`"cartId":"${INVOICE_ID}"`)), "both name the invoice's cart");

  const other = scriptedOf([cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1 }])]);

  await calculateInvoiceTax(inputOf({ invoiceId: "another-invoice" }), fixture.options(other));
  expectEqual((other.calls[0]?.body ?? "").includes(`"cartId":"another-invoice"`), true, "another invoice is another cart");

  // A zero amount is a calculated zero, not a refusal: an exempt item is priced at nothing.
  const zero = await calculateInvoiceTax(
    inputOf(),
    fixture.options(scriptedOf([cartAnswerOf([{ itemId: "line-1", index: 0, amount: 0 }])])),
  );

  expectEqual(zero.status, "calculated", "a zero amount is a calculation");
  expectEqual(zero.status === "calculated" ? zero.tax.totalTaxMinor : null, 0n, "with a zero tax");

  // A three decimal quantity is sent as its own decimal, not rounded.
  const fractional = scriptedOf([cartAnswerOf([{ itemId: "line-1", index: 0, amount: 1 }])]);

  await calculateInvoiceTax(
    inputOf({ lines: [{ itemId: "line-1", index: 0, quantityThousandths: 1_001n, unitPriceMinor: 10_000n, discountMinor: 0n }] }),
    fixture.options(fractional),
  );

  expectEqual((fractional.calls[0]?.body ?? "").includes('"quantity":1.001'), true, "one and one thousandth keeps its decimal");
  expectEqual((fractional.calls[0]?.body ?? "").includes('"tic"'), false, "an unassigned TIC is absent rather than zero");
  expectEqual((fractional.calls[0]?.body ?? "").includes('"exemption"'), false, "no exemption is claimed for a taxable invoice");

  // Two lines keep their order and their indexes.
  const twoLines = scriptedOf([
    cartAnswerOf([
      { itemId: "line-1", index: 0, amount: 1 },
      { itemId: "line-2", index: 1, amount: 2 },
    ]),
  ]);
  const two = await calculateInvoiceTax(
    inputOf({
      lines: [
        { itemId: "line-1", index: 0, quantityThousandths: 1_000n, unitPriceMinor: 10_000n, discountMinor: 0n },
        { itemId: "line-2", index: 1, quantityThousandths: 2_000n, unitPriceMinor: 5_000n, discountMinor: 0n },
      ],
    }),
    fixture.options(twoLines),
  );
  const twoBody = twoLines.calls[0]?.body ?? "";

  expectEqual(two.status, "calculated", "a two line invoice is priced");
  expect(twoBody.indexOf('"itemId":"line-1"') < twoBody.indexOf('"itemId":"line-2"'), "the lines keep their order");
  expect(twoBody.includes('"index":1'), "and their indexes");

  // The failure table is the table: a 403 maps to whatever STEP 176 recorded for it.
  const forbidding = await calculateTaxWith(403, "{}");

  expectEqual(
    forbidding.status === "rejected" ? forbidding.code : "",
    (await import("./taxcloud.ts")).taxCloudFailureOf(403, null).code,
    "a 403 takes STEP 176's code rather than a new one",
  );

  // A refusal carries no decision, and a decision carries a sentence a merchant can read.
  const refused = await calculateInvoiceTax(inputOf({ lines: [] }), fixture.options(scriptedOf([{ status: 200, body: "{}" }])));

  expectEqual(refused.status === "refused" ? "decision" in refused : true, false, "a refusal carries no connection decision");

  const decision = await calculateInvoiceTax(inputOf(), (await fixtureOf({ enabled: false })).options(scriptedOf([{ status: 200, body: "{}" }])));

  expectEqual(
    decision.status === "not_collected" ? decision.decision.message : "",
    "The merchant has switched sales tax collection off.",
    "a decision carries STEP 178's sentence",
  );
  expectEqual(decision.status === "not_collected" ? decision.decision.collect : null, false, "and says collection is off");

  // The order read is a GET with no body.
  const readBack = scriptedOf([{ status: 422, body: "{}" }, { status: 200, body: "{}" }]);

  await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(readBack),
  );

  expectEqual(readBack.calls.length, 2, "the read back is a second call");
  expectEqual(readBack.calls[1]?.method ?? "", "GET", "the read back is a GET");
  expectEqual(readBack.calls[1]?.body ?? null, null, "with no body");

  // A read back that cannot be made leaves the answer a rejection, not a completion.
  const unreachableRead = scriptedOf([{ status: 422, body: "{}" }, new Error("socket hang up")]);
  const unread = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(unreachableRead),
  );

  expectEqual(unread.status, "rejected", "an unreadable read back is a rejection");
  expectEqual(unreachableRead.calls.length, 4, "the read is retried twice before it is given up");

  // A 409 is read back too, because a second order for one invoice is a conflict TaxCloud reports that way.
  const conflicted = await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    fixture.options(scriptedOf([{ status: 409, body: "{}" }, { status: 200, body: "{}" }])),
  );

  expectEqual(conflicted.status, "completed", "a 409 that reads back as an order is a completion");

  // A completion with the connection deleted mid-flight is still refused, not sent.
  const switchedOff = await fixtureOf({ enabled: false });
  const offScript = scriptedOf([{ status: 201, body: "{}" }]);

  await completeInvoiceTaxOrder(
    { companyId: COMPANY, invoiceId: INVOICE_ID, countryCode: "US", completedAtEpochMs: NOW - MINUTE_MS },
    switchedOff.options(offScript),
  );

  expectEqual(offScript.calls.length, 0, "a switched-off merchant sends no completion");

  // The totals are the line sum even for one line, and a line with no rate is still a line.
  const noRate: TaxCloudInvoiceTax = {
    cartId: INVOICE_ID,
    currency: "USD",
    lines: [{ itemId: "line-1", index: 0, taxMinor: 7n, rate: null }],
    totalTaxMinor: 7n,
    transactionDate: null,
  };

  expectEqual(taxCloudInvoiceTaxTotalOf(noRate).totalTaxMinor, 7n, "one line without a rate is still a total");
  expectEqual(isTaxCloudInvoiceTaxStatus("refused"), true, "the status reader accepts refused");
}

/* ---- section 10: the source ---- */

async function checkSource(): Promise<void> {
  const source = readFileSync(new URL("./taxcloud-invoice-tax.ts", import.meta.url), "utf8");

  for (const method of ["log", "error", "warn", "info"]) {
    expectEqual(source.includes(["console", method].join(".")), false, `the source never calls console.${method}`);
  }

  expectEqual(source.includes("sandbox"), false, "the word the documentation refuses appears nowhere");
  expectEqual(source.includes("Authorization"), false, "the source builds no Authorization header");
  expectEqual(source.includes("sk_live_"), false, "no live key shape appears");
  expectEqual(source.includes("fetch("), false, "the module sends nothing itself: STEP 177's transport does");
  expectEqual(source.includes("taxCloudRequestOf("), true, "the request is STEP 176's builder");
  expectEqual(source.includes("taxCloudCollectionGateOf("), true, "the decision is STEP 178's");
  expectEqual(source.includes("taxCloudMinorOfAmount("), true, "the amount is read by STEP 176's parser");
  expectEqual(source.includes('headers["Retry-After"]'), false, "no header is read by a capitalised name");
  expectEqual(source.includes('headers["retry-after"]'), true, "the documented header is read where it is documented");
  expectEqual(source.includes("TAXCLOUD_INVOICE_MAXIMUM_WAIT_MS"), true, "every wait has a ceiling");
  expectEqual(source.includes("options.store.listByCompany("), true, "the merchant's rows are read from the store");
  expectEqual(source.includes("writeWithVersion"), false, "the calculation writes no row");

  const runtime = readFileSync(new URL("./taxcloud-invoice-tax-runtime.ts", import.meta.url), "utf8");

  expectEqual(runtime.includes(["console", "log"].join(".")), false, "the runtime never logs");
  expectEqual(runtime.includes("taxCloudFetchTransport"), true, "the runtime uses STEP 177's one transport");
  expectEqual(runtime.includes("ENCRYPTION_MASTER_KEY"), true, "the key comes from the environment");
  expectEqual(runtime.includes("setTimeout"), true, "the production sleep is a timer");

  // The gate proves the two conversions agree with the invoice's own minor units by running one value through both.
  for (const minor of [100n, 10_000n, 107_500n, 131_000n, 1_000_000n]) {
    expectEqual(taxCloudPriceOf(minor), Number(minor) / 10_000, `the price of ${String(minor)} minor units is its decimal`);
  }

  expectEqual(TAXCLOUD_INVOICE_CURRENCY, "USD", "and the currency is dollars");
}

/* ---- running ---- */

checkConstants();
checkValidation();
checkConversions();
await checkCartBody();
checkAnswer();
await checkCalculate();
await checkRetry();
await checkCompletion();
checkTotals();
await checkGuarantees();
await checkSource();

if (failures.length > 0) {
  process.stderr.write(
    `taxcloud invoice tax gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `taxcloud invoice tax gate passed: ${checks} checks (an invoice is priced only for a merchant whose own switch is on, whose connection answered a verification ping and whose client is in the United States, the cart carries the invoice id so a retry upserts instead of duplicating, prices and discounts are exact JSON numbers and a sub-cent value is refused rather than rounded, the answer is read strictly so a missing line, an extra line, a duplicate, a negative amount or an amount with more than four decimals fails instead of taxing the wrong total, the invoice's tax is the sum of the line amounts while the documented rate is kept as information only, 429 and 500 and 503 and a network failure are retried twice with the documented Retry-After honoured and every wait capped, a completion never sends a future date and reads a duplicate back before reporting it, and a total that is not the sum of its lines is refused)\n`,
);
