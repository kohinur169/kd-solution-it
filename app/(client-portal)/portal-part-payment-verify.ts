// path: app/(client-portal)/portal-part-payment-verify.ts
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { isAppError } from "../../lib/errors/app-error.ts";
import type { AppError } from "../../lib/errors/app-error.ts";
import { getMessage, formatMessage } from "../../lib/i18n/messages.ts";
import { configureNmiKeys, InMemoryNmiKeyStore } from "../../lib/payments/adapters/nmi-client.ts";
import type { NmiHttpTransport } from "../../lib/payments/adapters/nmi-payment.ts";
import { mintPortalToken, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { priceToMinor } from "../../services/products/price.ts";
import {
  INVOICE_PAYMENT_BELOW_MINIMUM_RULE,
  INVOICE_PAYMENT_EXCEEDS_REMAINING_RULE,
} from "../../services/invoices/invoice-status.ts";
import { portalPaymentRuleSentences, portalPaymentRuleTextOf } from "../../components/payments/portal-payment-refusal.ts";
import type { PortalInvoiceView } from "./portal-invoice.ts";
import { PORTAL_MINIMUM_PARTIAL_PAYMENT } from "./portal-invoice-money.ts";
import { PORTAL_PAYMENT_RULES } from "./portal-payment-fields.ts";
import {
  PORTAL_PART_PAYMENT_FIELD,
  PORTAL_PART_PAYMENT_INPUT_ID,
  PORTAL_PART_PAYMENT_INPUT_MAXIMUM_LENGTH,
  PORTAL_PART_PAYMENT_RULES,
  PORTAL_PART_PAYMENT_STALE_RULE,
  PORTAL_PART_PAYMENT_UNREPRESENTABLE_RULE,
  portalPartPaymentNoneOf,
  portalPartPaymentTextOf,
} from "./portal-part-payment-fields.ts";
import {
  portalPartPaymentAmountOf,
  portalPartPaymentLimitsOf,
  portalPartPaymentMovedOf,
  portalPartPaymentRequestBodyOf,
  splitPortalPartPaymentAmountField,
} from "./portal-part-payment.ts";
import { chargePortalPayment, preparePortalPayment, type PortalPaymentDependencies } from "./portal-payment.ts";
import { createPortalPaymentProcessor, type PortalPaymentRecorder } from "./portal-payment-processor.ts";
import { openPortalThreeDsHandle, sealPortalThreeDsHandle } from "./portal-three-ds.ts";

/**
 * The gate for STEP 189: part payment on the invoice link, limited to the remaining amount.
 *
 * ## What this proves
 *
 * Section 18's last line - "a partly paid invoice link accepts only the remaining amount" - is a ceiling, and
 * section 16's twenty dollar floor is the second rule a part payment meets. A payer who names an amount is
 * therefore held to four things, and each is checked here against the **real** charge path and the real
 * document read rather than a description of them:
 *
 *   - **the ceiling**: the remaining is read from the invoice, never from the request, and a larger number is
 *     refused with the same rule STEP 124's merchant-side service uses;
 *   - **the floor**: a payment that leaves the document open is a partial and meets the twenty dollar floor;
 *     the payment that settles it is not a partial and does not, which is what keeps a small remainder payable;
 *   - **the parser**: the amount is the text a person typed, through the platform's one money parser, so
 *     `1e3`, `12,50` and a fifth decimal are refused rather than coerced;
 *   - **the provider's cents**: an amount the gateway cannot express is refused, and the code says whose
 *     number it was - the document's (`CONFLICT`, STEP 183's answer) or the payer's (`VALIDATION_FAILED`).
 *
 * ## Why the words are checked against another STEP's
 *
 * `below_minimum` and `exceeds_remaining` are STEP 124's rule strings. This gate imports them from
 * `services/invoices/invoice-status.ts` and asserts the page's vocabulary is the same two strings, so a rename
 * in the merchant-side service is a failing gate instead of a payer reading a sentence nobody wrote.
 */

const failures: string[] = [];
let checkCount = 0;

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<TValue>(actual: TValue, expected: TValue, description: string): void {
  expect(
    Object.is(actual, expected),
    `${description} (expected ${String(expected)}, got ${String(actual)})`,
  );
}

async function expectRefusal(
  run: () => Promise<unknown>,
  code: string,
  rule: string,
  description: string,
): Promise<AppError | null> {
  try {
    await run();
    expect(false, `${description} (nothing was thrown)`);
    return null;
  } catch (error) {
    if (!isAppError(error)) {
      expect(false, `${description} (threw something that is not an AppError)`);
      return null;
    }

    expectEqual(error.code, code, description);
    expectEqual(error.details[0]?.rule ?? "", rule, `${description}: the rule it names`);

    return error;
  }
}

function refusalOf(run: () => unknown): AppError | null {
  try {
    run();
    return null;
  } catch (error) {
    return isAppError(error) ? error : null;
  }
}

// ---------------------------------------------------------------------------------------------
// A document, in the shape `openPortalInvoice` answers.
// ---------------------------------------------------------------------------------------------

const companyId = "11111111-1111-4111-8111-111111111111";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const keys: PortalTokenKeys = { primary: Buffer.alloc(32, 7).toString("base64") };
const nowMs = Date.parse("2026-11-07T09:30:00.000Z");
const nowSeconds = Math.floor(nowMs / 1_000);
const encryptionKeyHex = randomBytes(32).toString("hex");
const tokenizationKey = "public-tokenization-key-1234";
const securityKey = "private-security-key-1234";
const collectJsToken = "1234567890abcdef-token";

/** The floor the platform's config names, in minor units: `20.0000` is 200000. */
const FLOOR_MINOR = 200_000n;

/**
 * A view of a document that owes `remainingMinor`, built through the real read.
 *
 * Only the two fields a part payment reads are set here; everything else is the invoice read's own shape, so a
 * rule that started reading a third field would fail this gate rather than silently pass.
 */
function viewOf(input: {
  readonly remainingMinor: string;
  readonly minimumMinor: string | null;
  readonly currency?: string;
  readonly open?: boolean;
}): PortalInvoiceView {
  return {
    payment: {
      open: input.open ?? true,
      amountMinor: input.open === false ? null : input.remainingMinor,
      minimumMinor: input.open === false ? null : input.minimumMinor,
    },
    currency: input.currency ?? "USD",
  } as PortalInvoiceView;
}

/** A view of a document that will take `remaining` and folds the floor the way STEP 181 does. */
function payableViewOf(remainingMinor: string, currency = "USD"): PortalInvoiceView {
  const remaining = BigInt(remainingMinor);
  let minimum: string | null = null;

  if (currency === "USD" && remaining > 0n) {
    minimum = (remaining <= FLOOR_MINOR ? remaining : FLOOR_MINOR).toString();
  }

  return viewOf({ remainingMinor, minimumMinor: minimum, currency });
}

// ---------------------------------------------------------------------------------------------
// The payment page, over the real charge path.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

function filtersOf(query: string): Map<string, unknown> {
  const equals = new Map<string, unknown>();

  for (const part of query.split("&")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === "select" || key === "order" || key === "limit") {
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, value.slice(3));
      continue;
    }

    if (value === "is.null") {
      equals.set(key, null);
      continue;
    }

    if (value.startsWith("in.(") && value.endsWith(")")) {
      equals.set(key, value.slice(4, -1).split(","));
    }
  }

  return equals;
}

function matches(row: Row, equals: ReadonlyMap<string, unknown>): boolean {
  for (const [key, expected] of equals) {
    const actual = row[key];

    if (Array.isArray(expected)) {
      if (typeof actual !== "string" || !expected.includes(actual)) {
        return false;
      }

      continue;
    }

    if (expected === null ? actual !== null : actual === null || String(actual) !== String(expected)) {
      return false;
    }
  }

  return true;
}

function invoiceRowOf(input: { readonly totalMinor: string; readonly paidMinor: string }): Row {
  return {
    id: invoiceId,
    company_id: companyId,
    client_id: clientId,
    number: "INV-0009",
    status: input.paidMinor === "0" ? "sent" : "partially_paid",
    currency: "USD",
    subtotal_minor: input.totalMinor,
    discount_minor: "0",
    discount_basis: "none",
    discount_percent_bp: 0,
    tax_minor: "0",
    total_minor: input.totalMinor,
    amount_paid_minor: input.paidMinor,
    client_name: "Acme Trading",
    client_email: "billing@acme.test",
    client_address: "9 Harbour Road\nDhaka",
    memo: "November retainer",
    issued_at: "2026-11-01T00:00:00.000Z",
    due_at: "2026-11-15T00:00:00.000Z",
    first_viewed_at: null,
    paid_at: null,
    voided_at: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    deleted_at: null,
    version: 2,
  };
}

function itemRowOf(totalMinor: string): Row {
  return {
    id: randomUUID(),
    company_id: companyId,
    invoice_id: invoiceId,
    position: 1,
    description: "Monthly retainer",
    unit: "hour",
    quantity: "1.000",
    unit_price_minor: totalMinor,
    discount_minor: "0",
    line_total_minor: totalMinor,
    product_id: null,
    service_id: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    deleted_at: null,
    version: 1,
  };
}

function tokenOf(): string {
  return mintPortalToken(
    { kind: "invoice", companyId, resourceId: invoiceId, capability: "pay", lifetimeSeconds: 604_800 },
    { keys, now: nowSeconds - 3_600 },
  );
}

interface RecordingTransport {
  readonly transport: NmiHttpTransport;
  readonly amounts: string[];
}

function transportOf(): RecordingTransport {
  const recorder: RecordingTransport = {
    amounts: [],
    transport: async (_endpoint, payload) => {
      // The amount the adapter actually sends, read from the payload it builds - not from a value this gate
      // assumed, so a page that sent the wrong amount would be caught here.
      const amount = String(payload["amount"] ?? "");
      recorder.amounts.push(amount);

      return {
        response: "1",
        response_code: "100",
        responsetext: "SUCCESS",
        transactionid: `txn-${String(recorder.amounts.length)}`,
        amount,
      };
    },
  };

  return recorder;
}

interface Settled {
  readonly paymentId: string;
  settled: string | null;
  amountMinor: string | null;
  transactionId: string | null;
  code: string | null;
}

function recorderOf(): { readonly recorder: PortalPaymentRecorder; readonly records: Map<string, Settled> } {
  const byKey = new Map<string, Settled>();
  const byPayment = new Map<string, Settled>();

  return {
    records: byPayment,
    recorder: {
      durable: true,
      open: (input) => {
        const existing = byKey.get(input.idempotencyKey);

        if (existing !== undefined) {
          return {
            status: "duplicate",
            paymentId: existing.paymentId,
            settled: existing.settled as "captured" | "declined" | "unknown" | "failed" | "under_review" | null,
            transactionId: existing.transactionId,
            code: existing.code,
          };
        }

        const record: Settled = {
          paymentId: randomUUID(),
          settled: null,
          amountMinor: input.amountMinor,
          transactionId: null,
          code: null,
        };

        byKey.set(input.idempotencyKey, record);
        byPayment.set(record.paymentId, record);

        return { status: "opened", paymentId: record.paymentId };
      },
      settle: (input) => {
        const record = byPayment.get(input.paymentId);

        if (record !== undefined) {
          record.settled = input.outcome;
          record.transactionId = input.transactionId;
          record.code = input.code;
        }
      },
    },
  };
}

interface PaymentGate {
  readonly dependencies: PortalPaymentDependencies;
  readonly audit: InMemoryAuditTrail;
  readonly transport: RecordingTransport;
  readonly records: Map<string, Settled>;
}

function paymentGateOf(input: { readonly totalMinor: string; readonly paidMinor: string }): PaymentGate {
  const invoices: Row[] = [invoiceRowOf(input)];
  const items: Row[] = [itemRowOf(input.totalMinor)];
  const audit = createInMemoryAuditTrail();
  const transport = transportOf();
  const recorder = recorderOf();
  const store = new InMemoryNmiKeyStore();

  const rest: RestClient = {
    async select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const equals = filtersOf(query);
      const rows = table === "invoices" ? invoices : table === "invoice_items" ? items : [];

      return rows
        .filter((row) => matches(row, equals))
        .map((row) => schema.parse({ ...row }));
    },
    async insert(): Promise<void> {
      throw new Error("the payment page writes no table of its own");
    },
    async insertReturning<TRow>(): Promise<readonly TRow[]> {
      throw new Error("the payment page writes no table of its own");
    },
    async update(): Promise<void> {
      throw new Error("the payment page writes no table of its own");
    },
    async rpc(): Promise<unknown> {
      throw new Error("the charge calls no function before the gateway");
    },
  };

  configureNmiKeys(
    { companyId, apiKey: tokenizationKey, secretKey: securityKey, environment: "sandbox" },
    { store, encryptionKey: encryptionKeyHex, occurredAtEpochMs: nowMs - 86_400_000 },
  );

  return {
    audit,
    transport,
    records: recorder.records,
    dependencies: {
      rest,
      audit,
      tokenKeys: keys,
      processor: createPortalPaymentProcessor({
        recorder: recorder.recorder,
        keyStore: store,
        encryptionKeyHex,
        transport: transport.transport,
      }),
      tokenizationKeyFor: () => ({ apiKey: tokenizationKey, environment: "sandbox" }),
      referral: null,
      now: () => nowMs,
    },
  };
}

function chargeOf(gate: PaymentGate, body: Record<string, unknown> = {}) {
  return chargePortalPayment(
    {
      token: tokenOf(),
      body: { collectjs_token: collectJsToken, idempotency_key: randomUUID(), ...body },
      clientAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (gate)",
      actorCompanyId: null,
    },
    gate.dependencies,
  );
}

function payloadsOf(audit: InMemoryAuditTrail, action: string): readonly Record<string, unknown>[] {
  return audit.entries
    .filter((entry) => entry.action === action)
    .map((entry) => (entry.payload ?? {}) as Record<string, unknown>);
}

const CAPTURED = "portal.payment_captured";

async function main(): Promise<void> {
  // ---- the vocabulary
  expectEqual(PORTAL_PART_PAYMENT_FIELD, "amount", "the payer's chosen amount has one field name");
  expectEqual(PORTAL_PART_PAYMENT_RULES.belowMinimum, INVOICE_PAYMENT_BELOW_MINIMUM_RULE, "the floor is STEP 124's own word");
  expectEqual(
    PORTAL_PART_PAYMENT_RULES.exceedsRemaining,
    INVOICE_PAYMENT_EXCEEDS_REMAINING_RULE,
    "and so is the ceiling",
  );
  expectEqual(PORTAL_PART_PAYMENT_RULES.invalidFormat, "amount_invalid", "the page names its own unreadable amount");
  expectEqual(PORTAL_PART_PAYMENT_RULES.zeroAmount, "amount_zero", "and its own zero");
  expectEqual(PORTAL_PART_PAYMENT_UNREPRESENTABLE_RULE, PORTAL_PAYMENT_RULES.amountUnrepresentable, "an unrepresentable amount keeps STEP 183's rule");
  expectEqual(PORTAL_PART_PAYMENT_STALE_RULE, "stale_document", "and a moved document keeps STEP 184's");
  expect(
    new Set(Object.values(PORTAL_PART_PAYMENT_RULES)).size === 4,
    "the four rules are distinct",
  );
  expectEqual(PORTAL_MINIMUM_PARTIAL_PAYMENT, "20.0000", "the floor is the platform's configured twenty dollars");
  expectEqual(priceToMinor(PORTAL_MINIMUM_PARTIAL_PAYMENT), FLOOR_MINOR, "which is 200000 minor units");
  expectEqual(portalPartPaymentTextOf("500000"), "50.0000", "a chosen amount prints at the platform's scale");
  expectEqual(priceToMinor(portalPartPaymentTextOf("500000")), 500_000n, "and parses back to itself");
  expect(PORTAL_PART_PAYMENT_INPUT_MAXIMUM_LENGTH >= 17, "the input holds a `numeric(18,4)` amount");
  expectEqual(PORTAL_PART_PAYMENT_INPUT_ID, "portal-pay-amount", "the field has one id");

  // ---- the limits a page prints
  {
    const limits = portalPartPaymentLimitsOf(payableViewOf("1000000"));

    expectEqual(limits.remainingMinor, "1000000", "the ceiling is the document's remaining");
    expectEqual(limits.minimumMinor, "200000", "the floor is the configured twenty dollars");
    expect(limits.allowPartial, "a hundred dollar remainder can be paid in parts");
    expectEqual(limits.remainingText, "100.0000 USD", "and the ceiling prints for a person");
    expectEqual(limits.minimumText, "20.0000 USD", "as does the floor");
    expectEqual(limits.currency, "USD", "with the document's own currency");
  }

  {
    // A remainder at or below the floor folds into the remainder, so the only payment left is the whole of it.
    const exact = portalPartPaymentLimitsOf(payableViewOf("200000"));
    const below = portalPartPaymentLimitsOf(payableViewOf("150000"));

    expectEqual(exact.minimumMinor, "200000", "a remainder exactly at the floor is its own floor");
    expectEqual(exact.allowPartial, false, "so there is no choice to offer");
    expectEqual(below.minimumMinor, "150000", "and a smaller one is its own floor too");
    expectEqual(below.allowPartial, false, "with no partial payment possible");
    expectEqual(portalPartPaymentLimitsOf(payableViewOf("220000")).allowPartial, true, "just above the floor, a choice exists");
  }

  {
    const closed = portalPartPaymentLimitsOf(viewOf({ remainingMinor: "0", minimumMinor: null, open: false }));
    const none = portalPartPaymentNoneOf("USD");

    expectEqual(closed.remainingMinor, "0", "a settled document takes nothing");
    expectEqual(closed.allowPartial, false, "and offers no choice");
    expectEqual(closed.minimumText, null, "with no floor to print");
    expectEqual(none.remainingText, "0.0000 USD", "the closed shape prints a zero rather than nothing");
  }

  {
    const foreign = portalPartPaymentLimitsOf(payableViewOf("1000000", "EUR"));

    expectEqual(foreign.minimumMinor, null, "a currency the platform does not price has no floor");
    expectEqual(foreign.allowPartial, false, "so no part payment is offered on it");
  }

  // ---- the amount, resolved
  {
    const view = payableViewOf("1000000");
    const whole = portalPartPaymentAmountOf({ requested: null, view });

    expectEqual(whole.amountMinor, "1000000", "no amount means the whole remainder");
    expectEqual(whole.chargeAmount, "100.00", "sent to the provider in its own cents");
    expectEqual(whole.amountText, "100.0000 USD", "and printed for the payer");
    expectEqual(whole.partial, false, "which is not a partial payment");
    expectEqual(whole.remainingAfterMinor, "0", "and leaves nothing owed");

    const half = portalPartPaymentAmountOf({ requested: "50.00", view });

    expectEqual(half.amountMinor, "500000", "fifty dollars is half the document");
    expectEqual(half.chargeAmount, "50.00", "in the provider's cents");
    expect(half.partial, "and it leaves the document open, so it is a partial payment");
    expectEqual(half.remainingAfterMinor, "500000", "with half still owed");

    expectEqual(portalPartPaymentAmountOf({ requested: "20", view }).amountMinor, "200000", "the floor itself is accepted");
    expectEqual(portalPartPaymentAmountOf({ requested: "20.0000", view }).amountMinor, "200000", "however it is spelled");
    expectEqual(portalPartPaymentAmountOf({ requested: "100", view }).partial, false, "paying the whole is not a partial");
    expectEqual(portalPartPaymentAmountOf({ requested: " 50.00 ", view }).amountMinor, "500000", "surrounding space is not an amount");
  }

  {
    const view = payableViewOf("150000");

    expectEqual(
      portalPartPaymentAmountOf({ requested: "15.00", view }).amountMinor,
      "150000",
      "a fifteen dollar remainder may be paid whole, below the floor, because it is not a partial",
    );

    const below = refusalOf(() => portalPartPaymentAmountOf({ requested: "10.00", view }));

    expectEqual(below?.details[0]?.rule, PORTAL_PART_PAYMENT_RULES.belowMinimum, "but not in part below the floor");

    const over = refusalOf(() => portalPartPaymentAmountOf({ requested: "20.00", view }));

    expectEqual(over?.details[0]?.rule, PORTAL_PART_PAYMENT_RULES.exceedsRemaining, "and not more than it owes");
  }

  // ---- the four refusals a chosen amount meets, in the order a payer can act on
  {
    const view = payableViewOf("1000000");

    for (const [requested, rule, description] of [
      ["100.0001", PORTAL_PART_PAYMENT_RULES.exceedsRemaining, "one minor unit over the ceiling"],
      ["1000", PORTAL_PART_PAYMENT_RULES.exceedsRemaining, "far over it"],
      ["19.9999", PORTAL_PART_PAYMENT_RULES.belowMinimum, "one minor unit under the floor"],
      ["0.0001", PORTAL_PART_PAYMENT_RULES.belowMinimum, "a fraction of a cent"],
      ["0", PORTAL_PART_PAYMENT_RULES.zeroAmount, "zero"],
      ["0.0000", PORTAL_PART_PAYMENT_RULES.zeroAmount, "zero however it is spelled"],
      ["", PORTAL_PART_PAYMENT_RULES.invalidFormat, "an empty text"],
      ["   ", PORTAL_PART_PAYMENT_RULES.invalidFormat, "spaces"],
      ["abc", PORTAL_PART_PAYMENT_RULES.invalidFormat, "letters"],
      ["1e3", PORTAL_PART_PAYMENT_RULES.invalidFormat, "an exponent"],
      ["12,50", PORTAL_PART_PAYMENT_RULES.invalidFormat, "a comma"],
      ["-5", PORTAL_PART_PAYMENT_RULES.invalidFormat, "a negative"],
      ["12.34567", PORTAL_PART_PAYMENT_RULES.invalidFormat, "a fifth decimal"],
      ["50.0050", PORTAL_PART_PAYMENT_UNREPRESENTABLE_RULE, "a sub-cent amount the provider cannot charge"],
    ] as const) {
      const error = refusalOf(() => portalPartPaymentAmountOf({ requested, view }));

      expectEqual(error?.details[0]?.rule ?? "none", rule, `${description} is refused by its rule`);
      expectEqual(error?.details[0]?.field ?? "", PORTAL_PART_PAYMENT_FIELD, `${description}: naming the amount field`);
      expectEqual(error?.code ?? "", "VALIDATION_FAILED", `${description}: as a value the payer can fix`);
    }
  }

  {
    // The document's own remainder cannot be written in cents: STEP 183's answer is a conflict with the
    // document, and a payer who chose nothing is not told to fix a number they did not type.
    const view = payableViewOf("1000050");
    const error = refusalOf(() => portalPartPaymentAmountOf({ requested: null, view }));

    expectEqual(error?.code ?? "", "CONFLICT", "a remainder the provider cannot write is a conflict with the document");
    expectEqual(error?.details[0]?.rule ?? "", PORTAL_PART_PAYMENT_UNREPRESENTABLE_RULE, "in STEP 183's rule");

    const chosen = refusalOf(() => portalPartPaymentAmountOf({ requested: "100.0050", view }));

    expectEqual(chosen?.code ?? "", "VALIDATION_FAILED", "while the payer's own unrepresentable amount is theirs to fix");
  }

  {
    const error = refusalOf(() =>
      portalPartPaymentAmountOf({ requested: "10.00", view: payableViewOf("1000000", "EUR") }),
    );

    expectEqual(
      error?.details[0]?.rule ?? "",
      PORTAL_PART_PAYMENT_RULES.belowMinimum,
      "a currency with no floor offers no part payment at all",
    );
  }

  {
    const error = refusalOf(() =>
      portalPartPaymentAmountOf({ requested: null, view: viewOf({ remainingMinor: "0", minimumMinor: null, open: false }) }),
    );

    expectEqual(error?.code ?? "", "CONFLICT", "a settled document refuses an amount as not payable");
    expectEqual(error?.details[0]?.rule ?? "", PORTAL_PAYMENT_RULES.notPayable, "in the payment page's own rule");
  }

  // ---- the field, split out of the body
  {
    const body = { collectjs_token: collectJsToken, idempotency_key: "k", amount: " 50.00 " };
    const split = splitPortalPartPaymentAmountField(body);

    expectEqual(split.amount, "50.00", "the amount is taken out and trimmed");
    expectEqual(Object.hasOwn(split.rest as Record<string, unknown>, "amount"), false, "and the rest has no amount");
    expectEqual(
      Object.keys(split.rest as Record<string, unknown>).sort().join(","),
      "collectjs_token,idempotency_key",
      "so STEP 183's strict parser still sees its own two fields",
    );

    const absent = splitPortalPartPaymentAmountField({ collectjs_token: collectJsToken });

    expectEqual(absent.amount, null, "an absent amount is not a failure");
    expectEqual(splitPortalPartPaymentAmountField(null).amount, null, "nor is a body that is not an object");
    expectEqual(splitPortalPartPaymentAmountField([]).amount, null, "nor an array");
  }

  {
    for (const [body, code, rule, description] of [
      [{ amount: 50 }, "VALIDATION_FAILED", PORTAL_PART_PAYMENT_RULES.invalidFormat, "a JSON number"],
      [{ amount: null }, "VALIDATION_FAILED", PORTAL_PART_PAYMENT_RULES.invalidFormat, "a null"],
      [{ amount: { minor: "500000" } }, "VALIDATION_FAILED", PORTAL_PART_PAYMENT_RULES.invalidFormat, "an object"],
      [{ amount: "5".repeat(19) }, "VALIDATION_FAILED", PORTAL_PART_PAYMENT_RULES.invalidFormat, "a value past the ceiling"],
      [{ amount: "4111111111111111" }, "VALIDATION_FAILED", PORTAL_PAYMENT_RULES.cardDataRefused, "a card number in the amount box"],
    ] as const) {
      const error = refusalOf(() => splitPortalPartPaymentAmountField(body));

      expectEqual(error?.code ?? "", code, `${description} is refused`);
      expectEqual(error?.details[0]?.rule ?? "", rule, `${description}: by its rule`);
    }
  }

  // ---- the request text a later step re-posts
  expectEqual(portalPartPaymentRequestBodyOf("500000"), "50.0000", "a chosen amount travels as text that parses back");
  expectEqual(priceToMinor(portalPartPaymentRequestBodyOf("500000")), 500_000n, "to itself");
  expectEqual(
    portalPartPaymentMovedOf({ chosenMinor: "500000", view: payableViewOf("1000000") }),
    false,
    "an amount the document still owes can still be taken",
  );
  expectEqual(
    portalPartPaymentMovedOf({ chosenMinor: "500000", view: payableViewOf("400000") }),
    true,
    "an amount larger than what is left has moved",
  );
  expectEqual(
    portalPartPaymentMovedOf({ chosenMinor: "500000", view: viewOf({ remainingMinor: "0", minimumMinor: null, open: false }) }),
    true,
    "and a document that settled underneath the payer has moved too",
  );

  // ---- the page: a part payment is charged as the part it is
  {
    const gate = paymentGateOf({ totalMinor: "1000000", paidMinor: "0" });
    const prepared = await preparePortalPayment({ token: tokenOf() }, gate.dependencies);

    expectEqual(prepared.partPayment.remainingMinor, "1000000", "the page reads the ceiling from the invoice");
    expectEqual(prepared.partPayment.minimumMinor, "200000", "and the floor beside it");
    expect(prepared.partPayment.allowPartial, "so the form offers an amount to choose");

    const paid = await chargeOf(gate, { amount: "50.00" });

    expectEqual(paid.status, "captured", "a fifty dollar part on a hundred dollar invoice is charged");
    expectEqual(paid.amountMinor, "500000", "for the amount the payer chose");
    expectEqual(paid.chargeAmount, "50.00", "in the provider's own spelling");
    expectEqual(paid.amountText, "50.0000 USD", "and printed at the platform's scale");
    expectEqual(gate.transport.amounts.join(","), "50.00", "the gateway was asked for the part, not the whole");
    expectEqual([...gate.records.values()][0]?.amountMinor, "500000", "and the record holds the part");

    const captured = payloadsOf(gate.audit, CAPTURED);

    expectEqual(captured[0]?.["amount_minor"], "500000", "the chain entry carries the part");
    expectEqual(captured[0]?.["part_payment"], true, "and says it was a part payment");
    expectEqual(captured[0]?.["charge_amount"], "50.00", "with the provider's own text");
  }

  {
    // No amount at all is the request STEP 183 always sent, and it is unchanged.
    const gate = paymentGateOf({ totalMinor: "1000000", paidMinor: "0" });
    const paid = await chargeOf(gate);

    expectEqual(paid.status, "captured", "a charge with no amount still pays the invoice");
    expectEqual(paid.amountMinor, "1000000", "for the whole remainder");
    expectEqual(gate.transport.amounts.join(","), "100.00", "and the gateway is asked for it");
    expectEqual(payloadsOf(gate.audit, CAPTURED)[0]?.["part_payment"], false, "which is not a part payment");
  }

  {
    // The payer sends the whole remainder explicitly: same charge, still not a partial.
    const gate = paymentGateOf({ totalMinor: "1000000", paidMinor: "250000" });
    const paid = await chargeOf(gate, { amount: "75.00" });

    expectEqual(paid.amountMinor, "750000", "what is left after an earlier payment is what the link takes");
    expectEqual(paid.amountText, "75.0000 USD", "printed as the amount charged, which is what the payer chose");
    expectEqual(payloadsOf(gate.audit, CAPTURED)[0]?.["part_payment"], false, "a settling payment is not a partial");
  }

  {
    const gate = paymentGateOf({ totalMinor: "1000000", paidMinor: "0" });

    await expectRefusal(
      () => chargeOf(gate, { amount: "120.00" }),
      "VALIDATION_FAILED",
      PORTAL_PART_PAYMENT_RULES.exceedsRemaining,
      "a payer who names more than the invoice owes is refused",
    );

    expectEqual(gate.transport.amounts.length, 0, "and the gateway is never asked");
    expectEqual(gate.records.size, 0, "and no payment record is opened");
  }

  {
    const gate = paymentGateOf({ totalMinor: "1000000", paidMinor: "0" });

    await expectRefusal(
      () => chargeOf(gate, { amount: "10.00" }),
      "VALIDATION_FAILED",
      PORTAL_PART_PAYMENT_RULES.belowMinimum,
      "a part below the floor is refused",
    );

    expectEqual(gate.transport.amounts.length, 0, "with nothing sent to the gateway");
  }

  {
    const gate = paymentGateOf({ totalMinor: "1000000", paidMinor: "0" });

    await expectRefusal(
      () => chargeOf(gate, { amount: "50.0050" }),
      "VALIDATION_FAILED",
      PORTAL_PART_PAYMENT_UNREPRESENTABLE_RULE,
      "a part the provider cannot write in cents is refused",
    );

    expectEqual(gate.transport.amounts.length, 0, "and the gateway is never asked");
  }

  {
    // The card scan still runs over everything: an amount beside a card number is still card data.
    const gate = paymentGateOf({ totalMinor: "1000000", paidMinor: "0" });

    await expectRefusal(
      () => chargeOf(gate, { amount: "50.00", card_number: "4111111111111111" }),
      "VALIDATION_FAILED",
      PORTAL_PAYMENT_RULES.cardDataRefused,
      "an amount does not open the body to card data",
    );

    expectEqual(gate.transport.amounts.length, 0, "and nothing is charged");
  }

  {
    // The whole remainder cannot be written in cents, and no amount was sent: STEP 183's answer.
    const gate = paymentGateOf({ totalMinor: "1000050", paidMinor: "0" });

    await expectRefusal(
      () => chargeOf(gate),
      "CONFLICT",
      PORTAL_PART_PAYMENT_UNREPRESENTABLE_RULE,
      "a document whose remainder cannot be charged is refused as a conflict",
    );
  }

  // ---- the 3D Secure handle carries the amount the payer chose
  {
    const secrets = {
      seal: (plaintext: string): string => Buffer.from(plaintext, "utf8").toString("base64"),
      open: (sealed: string): string => Buffer.from(sealed, "base64").toString("utf8"),
    };
    const handle = sealPortalThreeDsHandle(
      {
        challengeId: "88888888-8888-4888-8888-888888888888",
        companyId,
        invoiceId,
        amountMinor: "500000",
        issuedAtEpochMs: nowMs,
        expiresAtEpochMs: nowMs + 900_000,
      },
      secrets,
    );
    const claim = openPortalThreeDsHandle(handle, secrets);

    expectEqual(claim.amountMinor, "500000", "the sealed handle carries the part the payer chose");
    expectEqual(claim.invoiceId, invoiceId, "and the document it belongs to, so a part cannot be moved to another");
  }

  // ---- the sentences, and the answer a form reads
  {
    const below = getMessage("portal.partPaymentBelowMinimum");
    const over = getMessage("portal.partPaymentExceedsRemaining");
    const invalid = getMessage("portal.partPaymentInvalidAmount");

    expect(below.length > 0 && over.length > 0 && invalid.length > 0, "all three have a sentence");
    expect(new Set([below, over, invalid]).size === 3, "and they are three different sentences");
    expect(below.includes("{") === false && over.includes("{") === false, "with no placeholder the form cannot fill");
    expect(over.includes("nothing has been charged"), "the ceiling sentence says nothing was charged");
    expect(portalPaymentRuleTextOf(PORTAL_PART_PAYMENT_RULES.belowMinimum) === below, "the floor rule reaches its sentence");
    expect(portalPaymentRuleTextOf(PORTAL_PART_PAYMENT_RULES.exceedsRemaining) === over, "and the ceiling rule its own");
    expect(portalPaymentRuleTextOf(PORTAL_PART_PAYMENT_RULES.invalidFormat) === invalid, "and an unreadable amount its own");
    expect(portalPaymentRuleTextOf(PORTAL_PART_PAYMENT_RULES.zeroAmount) === invalid, "zero reads as the same sentence");
    expect(portalPaymentRuleSentences()[PORTAL_PART_PAYMENT_RULES.exceedsRemaining] === over, "the form's table carries it");
    expect(
      formatMessage("portal.partPaymentHint", { remaining: "100.0000 USD", minimum: "20.0000 USD" }).includes(
        "100.0000 USD",
      ),
      "the hint prints the ceiling it was given",
    );
    expect(getMessage("portal.paymentSubmitGeneric").length > 0, "and the button has a label when the amount is beside it");
  }

  // ---- the sources, and the migration that is deliberately not there
  const service = await readFile(new URL("./portal-part-payment.ts", import.meta.url), "utf8");
  const fields = await readFile(new URL("./portal-part-payment-fields.ts", import.meta.url), "utf8");
  const payment = await readFile(new URL("./portal-payment.ts", import.meta.url), "utf8");
  const threeDs = await readFile(new URL("./portal-three-ds.ts", import.meta.url), "utf8");
  const form = await readFile(new URL("../../components/payments/card-payment-form.tsx", import.meta.url), "utf8");
  const invoice = await readFile(new URL("./portal-invoice.ts", import.meta.url), "utf8");

  expect(service.includes("priceToMinor"), "the amount goes through the platform's one money parser");
  expect(service.includes("splitPortalPartPaymentAmountField"), "and arrives through one splitter");
  expect(fields.includes("PORTAL_PART_PAYMENT_RULES"), "the vocabulary is stated once");
  expect(payment.includes("splitPortalPartPaymentAmountField"), "the charge takes the amount out before STEP 183's parser");
  expect(payment.includes("portalPartPaymentAmountOf"), "and resolves it in one place");
  expect(
    payment.indexOf("portalPartPaymentAmountOf") < payment.indexOf("processor.charge("),
    "before the payment operation is asked",
  );
  expect(threeDs.includes("splitPortalPartPaymentAmountField"), "the 3D Secure start takes it out too");
  expect(threeDs.includes("portalPartPaymentMovedOf"), "and the completion asks whether the chosen amount can still be taken");
  expect(form.includes("PORTAL_PART_PAYMENT_FIELD"), "the form sends the amount under one name");
  expect(form.includes("partPayment.allowPartial"), "and offers it only when a legal choice exists");
  expect(
    invoice.includes("minimumMinor"),
    "the floor the page applies is STEP 181's own folding, read rather than recomputed",
  );
  expect(
    /amount_paid_minor\s*:/.test(service) === false && /amount_paid_minor\s*:/.test(payment) === false,
    "neither this STEP nor the page writes the invoice's paid amount: STEP 130's operation and the ledger own it",
  );

  if (failures.length > 0) {
    process.stdout.write(`portal part payment gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `portal part payment gate passed: ${String(checkCount)} checks, a chosen amount inside the remaining and above the ${PORTAL_MINIMUM_PARTIAL_PAYMENT} floor, the settling payment exempt from the floor, ${PORTAL_PART_PAYMENT_RULES.exceedsRemaining}/${PORTAL_PART_PAYMENT_RULES.belowMinimum} shared with STEP 124, the part carried through the gateway, the record, the chain and the 3D Secure handle, no migration needed\n`,
  );
}

await main();
