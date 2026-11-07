// path: app/(client-portal)/portal-payment-verify.ts
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { isAppError } from "../../lib/errors/app-error.ts";
import { mintPortalToken, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { COLLECT_JS_SCRIPT_URL } from "../../lib/payments/adapters/nmi-collectjs.ts";
import {
  configureNmiKeys,
  InMemoryNmiKeyStore,
  type NmiKeyStore,
} from "../../lib/payments/adapters/nmi-client.ts";
import type { NmiHttpTransport } from "../../lib/payments/adapters/nmi-payment.ts";
import type { RoutingRule } from "../../lib/payments/routing.ts";
import {
  PORTAL_PAYMENT_AUDIT_ENTITY,
  PORTAL_PAYMENT_CAPTURED_AUDIT_ACTION,
  PORTAL_PAYMENT_DECLINED_AUDIT_ACTION,
  PORTAL_PAYMENT_FORBIDDEN_KEYS,
  PORTAL_PAYMENT_MAXIMUM_BODY_BYTES,
  PORTAL_PAYMENT_RATE_LIMIT,
  PORTAL_PAYMENT_REFUSED_AUDIT_ACTION,
  PORTAL_PAYMENT_RULES,
  PORTAL_PAYMENT_SCRIPT_URL,
  PORTAL_PAYMENT_TOKEN_MAXIMUM_LENGTH,
  PORTAL_PAYMENT_UNKNOWN_AUDIT_ACTION,
  portalPaymentChargeAmountOf,
} from "./portal-payment-fields.ts";
import {
  chargePortalPayment,
  parsePortalPaymentBody,
  portalPaymentCardFieldOf,
  preparePortalPayment,
  type PortalPaymentDependencies,
} from "./portal-payment.ts";
import {
  createPortalPaymentProcessor,
  type PortalPaymentRecorder,
  type PortalRecorderOpen,
} from "./portal-payment-processor.ts";
import { enforcePortalRateLimit, portalRateLimitHeaders } from "./portal-rate-limit.ts";

/**
 * The gate for STEP 183: the payment page and the provider's hosted secure fields.
 *
 * ## What this proves without a gateway
 *
 * There is no NMI sandbox account and no PostgreSQL in this sandbox, so the two fakes below stand in for the
 * outside world, and both are transcribed from what the provider's documentation and the migrations say -
 * not from the modules under test.
 *
 *   - The **fixture database** is a small PostgREST over arrays: it applies the equality filters of a query
 *     string, `in.(...)`, `limit`, and refuses a read that names no tenant. It is STEP 181's, narrowed to the
 *     five tables the invoice read touches.
 *   - The **recording transport** answers the way NMI's Classic API documents: `response=1` with a
 *     `transactionid` for an approval, `response=2` with a `response_code` for a decline, and a thrown error
 *     for a lost answer.
 *
 * ## What it exercises
 *
 *   - the amount: four decimals of a dollar in, dollars and cents out, and a sub-cent amount refused rather
 *     than rounded;
 *   - the body: two fields and no others, with every card-shaped key refused at any depth, in any spelling,
 *     **and the value never carried into the refusal**;
 *   - the token: a card number pasted where a token belongs is refused, because the provider's own character
 *     rule would accept sixteen digits;
 *   - the page: what it shows when a business has no gateway, when the platform cannot record a payment
 *     durably, when the invoice is paid, cancelled or a draft;
 *   - the charge: routing to the provider, the sale it builds, the record it opens and settles, the audit
 *     entries, and the idempotency that makes a second submit one payment and one provider call;
 *   - the four provider answers: captured, declined, unknown (which is never retried) and rejected (which was
 *     never sent);
 *   - the sources: CSRF before the counter, the counter before the body, the byte ceiling twice, the page
 *     `force-dynamic` and `noindex`, a form with no card input of its own, and no file in this STEP that
 *     holds, logs or forwards a card number.
 *
 * ## Why there is no migration check here
 *
 * STEP 183 adds no table and no column: `0037` already carries the payment, its idempotency key, its status,
 * its provider transaction and the two card facts section 18 allows (brand and last four, both optional and
 * required together), and `0030` already carries the gateway keys, platform-scoped and encrypted. The gate
 * asserts both rather than assuming them.
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

/** Run a call that must fail, and check the code and the first rule it refuses with. */
async function expectRefusal(
  run: () => Promise<unknown>,
  code: string,
  rule: string | null,
  description: string,
): Promise<void> {
  try {
    await run();
    expect(false, `${description} (nothing was thrown)`);
  } catch (error) {
    if (!isAppError(error)) {
      expect(false, `${description} (threw something that is not an AppError)`);
      return;
    }

    expectEqual(error.code, code, description);

    if (rule !== null) {
      expectEqual(error.details[0]?.rule ?? "", rule, `${description}: the rule it names`);
    }
  }
}

/** The same check for a synchronous parser. */
function expectSyncRefusal(
  run: () => unknown,
  code: string,
  rule: string,
  description: string,
): void {
  let thrown: unknown;

  try {
    run();
  } catch (error) {
    thrown = error;
  }

  expect(isAppError(thrown) && thrown.code === code, `${description} (refused)`);
  expect(
    isAppError(thrown) && thrown.details[0]?.rule === rule,
    `${description} (with the rule \`${rule}\`)`,
  );
}

// ---------------------------------------------------------------------------------------------
// The fixture: a PostgREST over arrays, with the invoice read STEP 181 already proved.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

function filtersOf(query: string): { readonly equals: Map<string, unknown>; readonly limit: number | null } {
  const equals = new Map<string, unknown>();
  let limit: number | null = null;

  for (const part of query.split("&")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === "select" || key === "order") {
      continue;
    }

    if (key === "limit") {
      const parsed = Number.parseInt(value, 10);
      limit = Number.isFinite(parsed) ? parsed : null;
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

  return { equals, limit };
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

interface Fixture {
  readonly tables: Map<string, Row[]>;
  readonly queries: string[];
  readonly updates: { readonly table: string; readonly query: string; readonly values: Row }[];
  rateLimitAnswer: Row | null;
}

function createFixture(): Fixture {
  return {
    tables: new Map<string, Row[]>(),
    queries: [],
    updates: [],
    rateLimitAnswer: { allowed: true, remaining: 4, retry_after_seconds: 0, first_refusal: false },
  };
}

function createRest(fixture: Fixture): RestClient {
  function rowsOf(table: string): Row[] {
    const rows = fixture.tables.get(table);

    if (rows === undefined) {
      fixture.tables.set(table, []);
      return fixture.tables.get(table) ?? [];
    }

    return rows;
  }

  return {
    async select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      fixture.queries.push(`${table}?${query}`);

      if (!query.includes("company_id=eq.")) {
        throw new Error(`a portal read of ${table} was not tenant scoped: ${query}`);
      }

      const { equals, limit } = filtersOf(query);
      const matched = rowsOf(table).filter((row) => matches(row, equals));

      return matched.slice(0, limit ?? matched.length).map((row) => schema.parse({ ...row }));
    },

    async insert(): Promise<void> {
      throw new Error("a portal payment page writes no table of its own");
    },

    async insertReturning<TRow>(): Promise<readonly TRow[]> {
      throw new Error("a portal payment page writes no table of its own");
    },

    async update(table: string, query: string, values: Row): Promise<void> {
      fixture.updates.push({ table, query, values });
    },

    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (functionName !== "consume_rate_limit") {
        throw new Error(`unexpected rpc ${functionName}`);
      }

      if (
        arguments_["p_scope"] !== "portal_payment" ||
        typeof arguments_["p_key_hash"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(String(arguments_["p_key_hash"])) ||
        arguments_["p_limit"] !== 5 ||
        arguments_["p_window_seconds"] !== 600
      ) {
        throw new Error("the payment counter was called with the wrong policy");
      }

      return fixture.rateLimitAnswer === null ? [] : [fixture.rateLimitAnswer];
    },
  };
}

const companyId = "11111111-1111-4111-8111-111111111111";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const keys: PortalTokenKeys = { primary: Buffer.alloc(32, 7).toString("base64") };
const nowMs = Date.parse("2026-11-07T09:30:00.000Z");
const nowSeconds = Math.floor(nowMs / 1_000);
const encryptionKeyHex = randomBytes(32).toString("hex");
const tokenizationKey = "public-tokenization-key-1234";
const securityKey = "private-security-key-1234";

/** An invoice that still owes its whole total: 100.0000 USD. */
function invoiceRow(overrides: Row = {}): Row {
  return {
    id: invoiceId,
    company_id: companyId,
    client_id: clientId,
    number: "INV-0007",
    status: "sent",
    currency: "USD",
    subtotal_minor: "1000000",
    discount_minor: "0",
    discount_basis: "none",
    discount_percent_bp: 0,
    tax_minor: "0",
    total_minor: "1000000",
    amount_paid_minor: "0",
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
    ...overrides,
  };
}

function itemRow(): Row {
  return {
    id: randomUUID(),
    company_id: companyId,
    invoice_id: invoiceId,
    position: 1,
    description: "Monthly retainer",
    unit: "hour",
    quantity: "2.500",
    unit_price_minor: "400000",
    discount_minor: "0",
    line_total_minor: "1000000",
    product_id: null,
    service_id: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    deleted_at: null,
    version: 1,
  };
}

function fixtureOf(invoice: Row): Fixture {
  const fixture = createFixture();

  fixture.tables.set("invoices", [{ ...invoice }]);
  fixture.tables.set("invoice_items", [itemRow()]);
  fixture.tables.set("payments", []);
  fixture.tables.set("invoice_fulfilment_evidence", []);
  fixture.tables.set("invoice_acceptances", []);

  return fixture;
}

function tokenOf(company = companyId, capability: string = "pay"): string {
  return mintPortalToken(
    {
      kind: "invoice",
      companyId: company,
      resourceId: invoiceId,
      capability: capability as "pay",
      lifetimeSeconds: 604_800,
    },
    { keys, now: nowSeconds - 3_600 },
  );
}

/** The recording transport: what NMI's Classic API answers, and how many times it was asked. */
interface RecordingTransport {
  readonly transport: NmiHttpTransport;
  readonly calls: { readonly endpoint: string; readonly payload: Record<string, string> }[];
}

function transportOf(answer: Record<string, string> | "throw"): RecordingTransport {
  const calls: { readonly endpoint: string; readonly payload: Record<string, string> }[] = [];

  return {
    calls,
    transport: async (endpoint, payload) => {
      calls.push({ endpoint, payload });

      if (answer === "throw") {
        throw new Error("the connection was lost");
      }

      return answer;
    },
  };
}

const approval = {
  response: "1",
  response_code: "100",
  responsetext: "SUCCESS",
  transactionid: "9876543210",
  amount: "100.00",
};

const decline = { response: "2", response_code: "200", responsetext: "DECLINED" };

/** A recorder a gate can use: idempotent, and honest that its records live in this process. */
function recorderOf(durable = true): {
  readonly recorder: PortalPaymentRecorder;
  readonly records: Map<string, { readonly paymentId: string; settled: string | null; transactionId: string | null }>;
} {
  const records = new Map<
    string,
    { readonly paymentId: string; settled: string | null; transactionId: string | null }
  >();
  const byPayment = new Map<
    string,
    { readonly paymentId: string; settled: string | null; transactionId: string | null }
  >();

  return {
    records,
    recorder: {
      durable,
      open: (input): PortalRecorderOpen => {
        const existing = records.get(input.idempotencyKey);

        if (existing !== undefined) {
          return {
            status: "duplicate",
            paymentId: existing.paymentId,
            settled: existing.settled as "captured" | "declined" | null,
            transactionId: existing.transactionId,
            code: null,
          };
        }

        const record = { paymentId: randomUUID(), settled: null, transactionId: null };

        records.set(input.idempotencyKey, record);
        byPayment.set(record.paymentId, record);

        return { status: "opened", paymentId: record.paymentId };
      },
      settle: (input) => {
        const record = byPayment.get(input.paymentId);

        if (record !== undefined) {
          record.settled = input.outcome;
          record.transactionId = input.transactionId;
        }
      },
    },
  };
}

/** The key store a configured business has: one encrypted pair, as STEP 152's settings would leave it. */
function keyStoreOf(): NmiKeyStore {
  const store = new InMemoryNmiKeyStore();
  const configured = configureNmiKeys(
    { companyId, apiKey: tokenizationKey, secretKey: securityKey, environment: "sandbox" },
    { store, encryptionKey: encryptionKeyHex, occurredAtEpochMs: nowMs - 86_400_000 },
  );

  if (configured.status !== "configured") {
    throw new Error("the fixture could not configure a gateway key");
  }

  return store;
}

interface DependenciesOptions {
  readonly fixture?: Fixture;
  readonly audit?: InMemoryAuditTrail;
  readonly keyStore?: NmiKeyStore;
  readonly transport?: RecordingTransport;
  readonly recorder?: PortalPaymentRecorder;
  readonly durable?: boolean;
  readonly routingRules?: readonly RoutingRule[];
  readonly withoutProcessor?: boolean;
}

function dependenciesOf(options: DependenciesOptions = {}): PortalPaymentDependencies {
  const fixture = options.fixture ?? fixtureOf(invoiceRow());
  const keyStore = options.keyStore ?? keyStoreOf();
  const recorder = options.recorder ?? recorderOf(options.durable ?? true).recorder;

  return {
    rest: createRest(fixture),
    audit: options.audit ?? createInMemoryAuditTrail(),
    tokenKeys: keys,
    processor: options.withoutProcessor === true
      ? null
      : createPortalPaymentProcessor({
          recorder,
          keyStore,
          encryptionKeyHex,
          ...(options.transport === undefined ? {} : { transport: options.transport.transport }),
          ...(options.routingRules === undefined ? {} : { routingRules: options.routingRules }),
        }),
    tokenizationKeyFor: (company) => {
      const config = keyStore.findActiveByCompany(company);

      return config === null ? null : { apiKey: tokenizationKey, environment: config.environment };
    },
    now: () => nowMs,
  };
}

/** A body the form would send, which the gate then edits one field at a time. */
function bodyOf(overrides: Row = {}): Row {
  return {
    collectjs_token: "1234567890abcdef-token",
    idempotency_key: randomUUID(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  // ---- the amount: four decimals in, dollars and cents out, and nothing rounded
  expectEqual(portalPaymentChargeAmountOf("1000000"), "100.00", "one hundred is a hundred dollars");
  expectEqual(portalPaymentChargeAmountOf("2000"), "0.20", "the twenty dollar floor is twenty cents under a dollar");
  expectEqual(portalPaymentChargeAmountOf("1050000"), "105.00", "and a mixed amount keeps its cents");
  expectEqual(portalPaymentChargeAmountOf("99990000"), "9999.00", "and a large one keeps its thousands");
  expectEqual(portalPaymentChargeAmountOf("1"), null, "a sub-cent amount cannot be charged exactly");
  expectEqual(portalPaymentChargeAmountOf("1050001"), null, "and neither can one with a stray unit");
  expectEqual(portalPaymentChargeAmountOf("0"), null, "zero is not a payment");
  expectEqual(portalPaymentChargeAmountOf("-1000000"), null, "and neither is a negative");
  expectEqual(portalPaymentChargeAmountOf("one dollar"), null, "and neither is text");

  expectEqual(PORTAL_PAYMENT_SCRIPT_URL, COLLECT_JS_SCRIPT_URL, "the script URL is STEP 149's, not a second copy");
  expectEqual(PORTAL_PAYMENT_RATE_LIMIT.scope, "portal_payment", "the payment page has its own counter");
  expectEqual(PORTAL_PAYMENT_RATE_LIMIT.limit, 5, "five attempts");
  expectEqual(PORTAL_PAYMENT_RATE_LIMIT.windowSeconds, 600, "per ten minutes");
  expectEqual(PORTAL_PAYMENT_MAXIMUM_BODY_BYTES, 2_048, "the body ceiling is two kilobytes");
  expectEqual(PORTAL_PAYMENT_TOKEN_MAXIMUM_LENGTH, 256, "and a token has a ceiling of its own");
  expect(
    (PORTAL_PAYMENT_FORBIDDEN_KEYS as readonly string[]).includes("cardnumber") &&
      (PORTAL_PAYMENT_FORBIDDEN_KEYS as readonly string[]).includes("cvv") &&
      (PORTAL_PAYMENT_FORBIDDEN_KEYS as readonly string[]).includes("pan"),
    "the card keys this page refuses are named",
  );

  // ---- the body: two fields, no card keys at any depth, and the value never carried anywhere
  const parsed = parsePortalPaymentBody(bodyOf({ collectjs_token: "  token-abcdefgh123  " }));

  expectEqual(parsed.token, "token-abcdefgh123", "a token is stored trimmed");
  expectEqual(parsed.idempotencyKey.length, 36, "and the key is a uuid");

  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ card_number: "4111111111111111" })),
    "VALIDATION_FAILED",
    PORTAL_PAYMENT_RULES.cardDataRefused,
    "a body with a card number is refused",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody({ collectjs_token: "token-abcdefgh123", idempotency_key: randomUUID(), card: { cvv: "123" } }),
    "VALIDATION_FAILED",
    PORTAL_PAYMENT_RULES.cardDataRefused,
    "and one with a card nested inside it",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ CardNumber: "4111111111111111" })),
    "VALIDATION_FAILED",
    PORTAL_PAYMENT_RULES.cardDataRefused,
    "and one spelled the way a script might spell it",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ expiry_month: "12", expiry_year: "2030" })),
    "VALIDATION_FAILED",
    PORTAL_PAYMENT_RULES.cardDataRefused,
    "and one carrying an expiry",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ collectjs_token: "4111 1111 1111 1111" })),
    "VALIDATION_FAILED",
    PORTAL_PAYMENT_RULES.cardDataRefused,
    "a card number pasted into the token box is refused as card data, not forwarded",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ collectjs_token: "4111111111111111" })),
    "VALIDATION_FAILED",
    PORTAL_PAYMENT_RULES.cardDataRefused,
    "including one with no spaces, which the provider's own character rule would accept",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ collectjs_token: "   " })),
    "VALIDATION_FAILED",
    "required",
    "an empty token is refused",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ collectjs_token: "short" })),
    "VALIDATION_FAILED",
    PORTAL_PAYMENT_RULES.invalidToken,
    "and a token too short to be one",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ collectjs_token: "has spaces in it" })),
    "VALIDATION_FAILED",
    PORTAL_PAYMENT_RULES.invalidToken,
    "and one with characters a token cannot have",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ amount_minor: "1" })),
    "VALIDATION_FAILED",
    "invalid_format",
    "a body that tries to name its own amount is refused",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ idempotency_key: "not-a-uuid" })),
    "VALIDATION_FAILED",
    "invalid_format",
    "and one whose key is not a uuid",
  );
  expectSyncRefusal(
    () => parsePortalPaymentBody(bodyOf({ collectjs_token: "x".repeat(300) })),
    "VALIDATION_FAILED",
    "invalid_format",
    "and a token longer than any token",
  );

  const cardPath = portalPaymentCardFieldOf({ a: [{ card_number: "4111111111111111" }] });

  expectEqual(cardPath, "a.0.card_number", "the scan names where the card field was");
  expectEqual(portalPaymentCardFieldOf(bodyOf()), null, "and finds nothing in a clean body");

  let cardRefusal: unknown;

  try {
    parsePortalPaymentBody(bodyOf({ card_number: "4111111111111111" }));
  } catch (error) {
    cardRefusal = error;
  }

  expect(
    JSON.stringify(isAppError(cardRefusal) ? cardRefusal.details : {}) .includes("4111") === false,
    "the refusal never carries the card number it refused",
  );

  // ---- the page: what it shows, and when it shows fields at all
  const prepared = await preparePortalPayment({ token: tokenOf() }, dependenciesOf());

  expectEqual(prepared.amountMinor, "1000000", "the page prints the invoice's remaining due");
  expectEqual(prepared.chargeAmount, "100.00", "and the amount the provider will be asked for");
  expectEqual(prepared.amountText, "100.0000 USD", "and the amount a person reads, at the platform's own scale");
  expectEqual(prepared.unavailable, null, "a business with keys and a durable recorder offers the form");
  expectEqual(prepared.secureFields?.tokenizationKey, tokenizationKey, "the public tokenization key is what the browser gets");
  expectEqual(prepared.secureFields?.scriptUrl, COLLECT_JS_SCRIPT_URL, "with the provider's own script");
  expectEqual(prepared.secureFields?.environment, "sandbox", "and the environment its keys were configured for");
  expect(prepared.idempotencyKey.length === 36, "the page hands the form a fresh idempotency key");

  const secondRender = await preparePortalPayment({ token: tokenOf() }, dependenciesOf());

  expect(
    secondRender.idempotencyKey !== prepared.idempotencyKey,
    "and a second render gets a different one",
  );

  const noKeys = await preparePortalPayment(
    { token: tokenOf() },
    dependenciesOf({ keyStore: new InMemoryNmiKeyStore() }),
  );

  expectEqual(noKeys.unavailable, "provider", "a business with no gateway is told so");
  expectEqual(noKeys.secureFields, null, "and is shown no fields at all");

  const noRecorder = await preparePortalPayment(
    { token: tokenOf() },
    dependenciesOf({ durable: false }),
  );

  expectEqual(noRecorder.unavailable, "recorder", "a platform that cannot record durably says so before a card is typed");
  expectEqual(noRecorder.secureFields !== null, true, "even though the gateway's key is present");

  const noProcessor = await preparePortalPayment(
    { token: tokenOf() },
    dependenciesOf({ withoutProcessor: true }),
  );

  expectEqual(noProcessor.unavailable, "recorder", "and a deployment with no payment operation says so too");

  await expectRefusal(
    () => preparePortalPayment({ token: tokenOf() }, dependenciesOf({ fixture: fixtureOf(invoiceRow({ status: "paid", amount_paid_minor: "1000000" })) })),
    "CONFLICT",
    PORTAL_PAYMENT_RULES.notPayable,
    "a settled invoice offers no page",
  );
  await expectRefusal(
    () => preparePortalPayment({ token: tokenOf() }, dependenciesOf({ fixture: fixtureOf(invoiceRow({ status: "void", voided_at: "2026-11-02T00:00:00.000Z" })) })),
    "CONFLICT",
    PORTAL_PAYMENT_RULES.invoiceVoid,
    "a cancelled invoice says it was cancelled",
  );
  await expectRefusal(
    () => preparePortalPayment({ token: tokenOf() }, dependenciesOf({ fixture: fixtureOf(invoiceRow({ status: "draft", number: null, issued_at: null })) })),
    "CONFLICT",
    PORTAL_PAYMENT_RULES.notIssued,
    "a draft says it is not issued",
  );
  await expectRefusal(
    () => preparePortalPayment({ token: tokenOf() }, dependenciesOf({ fixture: fixtureOf(invoiceRow({ total_minor: "1000001" })) })),
    "CONFLICT",
    PORTAL_PAYMENT_RULES.amountUnrepresentable,
    "an amount with a sub-cent part is refused rather than rounded",
  );
  await expectRefusal(
    () => preparePortalPayment({ token: tokenOf(companyId, "view") }, dependenciesOf()),
    "RESOURCE_NOT_FOUND",
    null,
    "a link without the `pay` capability opens no payment page",
  );

  // ---- the charge: one payment, one provider call, and the amount the invoice says
  const chargeFixture = fixtureOf(invoiceRow());
  const chargeTrail = createInMemoryAuditTrail();
  const recording = transportOf(approval);
  const chargeRecorder = recorderOf(true);
  const chargeDependencies = dependenciesOf({
    fixture: chargeFixture,
    audit: chargeTrail,
    transport: recording,
    recorder: chargeRecorder.recorder,
  });
  const idempotencyKey = randomUUID();
  const paid = await chargePortalPayment(
    {
      token: tokenOf(),
      body: { collectjs_token: "1234567890abcdef-token", idempotency_key: idempotencyKey },
      clientAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (fixture)",
      actorCompanyId: null,
    },
    chargeDependencies,
  );

  expectEqual(paid.status, "captured", "an approved sale is a captured payment");
  expectEqual(paid.amountMinor, "1000000", "for the invoice's own amount");
  expectEqual(paid.amountText, "100.0000 USD", "printed as the page printed it");
  expectEqual(paid.chargeAmount, "100.00", "and sent as the provider takes it");
  expectEqual(paid.transactionId, "9876543210", "with the provider's transaction id");
  expectEqual(paid.idempotencyKey, idempotencyKey, "and the key the attempt carried");
  expectEqual(recording.calls.length, 1, "the provider was asked once");
  expectEqual(recording.calls[0]?.endpoint, "https://sandbox.nmi.com/api/transact.php", "at the sandbox endpoint its keys name");
  expectEqual(recording.calls[0]?.payload["type"], "sale", "as a sale");
  expectEqual(recording.calls[0]?.payload["amount"], "100.00", "for the exact amount");
  expectEqual(recording.calls[0]?.payload["payment_token"], "1234567890abcdef-token", "with the token, and no card");
  expectEqual(recording.calls[0]?.payload["orderid"], "INV-0007", "referenced to the invoice number");
  expect(
    Object.keys(recording.calls[0]?.payload ?? {}).every((key) =>
      ["security_key", "type", "amount", "payment_token", "orderid"].includes(key),
    ),
    "and nothing else in the request: no card field exists in it",
  );
  expectEqual(chargeRecorder.records.size, 1, "one record was opened");
  expectEqual(
    [...chargeRecorder.records.values()][0]?.settled,
    "captured",
    "and settled as captured",
  );
  expectEqual(
    [...chargeRecorder.records.values()][0]?.transactionId,
    "9876543210",
    "with the provider's transaction",
  );
  expectEqual(chargeTrail.entries.length, 1, "one audit entry");
  expectEqual(chargeTrail.entries[0]?.action, PORTAL_PAYMENT_CAPTURED_AUDIT_ACTION, "under the capture action");
  expectEqual(chargeTrail.entries[0]?.entityType, PORTAL_PAYMENT_AUDIT_ENTITY, "an entry about a payment");
  expectEqual(chargeTrail.entries[0]?.entityId, paid.paymentId, "naming the payment");
  expectEqual(chargeTrail.entries[0]?.payload["transaction_id"], "9876543210", "with its transaction");
  expectEqual(chargeTrail.entries[0]?.payload["amount_minor"], "1000000", "and its amount");
  expect(typeof chargeTrail.entries[0]?.payload["idempotency_key_hash"] === "string", "and a hash of the key");
  expect(
    JSON.stringify(chargeTrail.entries[0]?.payload ?? {}).includes(idempotencyKey) === false,
    "never the key itself",
  );
  expectEqual(chargeFixturesUpdates(chargeFixture), 0, "and the page writes no table of its own");

  // ---- the same key again: the second submit is the first payment, and the card is charged once
  const repeated = await chargePortalPayment(
    {
      token: tokenOf(),
      body: { collectjs_token: "1234567890abcdef-token", idempotency_key: idempotencyKey },
      clientAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (fixture)",
      actorCompanyId: null,
    },
    chargeDependencies,
  );

  expectEqual(repeated.paymentId, paid.paymentId, "a repeated submit answers the first payment");
  expectEqual(recording.calls.length, 1, "and does not charge the card again");
  expectEqual(chargeTrail.entries.length, 2, "though it is audited again, because it was attempted again");

  const freshKey = await chargePortalPayment(
    {
      token: tokenOf(),
      body: { collectjs_token: "abcdef1234567890-token", idempotency_key: randomUUID() },
      clientAddress: "203.0.113.9",
      userAgent: null,
      actorCompanyId: null,
    },
    chargeDependencies,
  );

  expect(freshKey.paymentId !== paid.paymentId, "a new key is a new payment");
  expectEqual(recording.calls.length, 2, "and a second provider call");

  // ---- the provider's other answers
  const declineFixture = fixtureOf(invoiceRow());
  const declineTrail = createInMemoryAuditTrail();

  await expectRefusal(
    () =>
      chargePortalPayment(
        {
          token: tokenOf(),
          body: bodyOf(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
        },
        dependenciesOf({
          fixture: declineFixture,
          audit: declineTrail,
          transport: transportOf(decline),
        }),
      ),
    "VALIDATION_FAILED",
    "card_declined",
    "a declined card says the card was declined",
  );
  expectEqual(declineTrail.entries.length, 1, "and the decline is audited once");
  expectEqual(declineTrail.entries[0]?.action, PORTAL_PAYMENT_DECLINED_AUDIT_ACTION, "under the decline action");
  expectEqual(declineTrail.entries[0]?.payload["decline_code"], "200", "with the provider's response code");

  const unknownTrail = createInMemoryAuditTrail();
  const unknownRecorder = recorderOf(true);

  await expectRefusal(
    () =>
      chargePortalPayment(
        {
          token: tokenOf(),
          body: bodyOf(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
        },
        dependenciesOf({
          fixture: fixtureOf(invoiceRow()),
          audit: unknownTrail,
          transport: transportOf("throw"),
          recorder: unknownRecorder.recorder,
        }),
      ),
    "CONFLICT",
    PORTAL_PAYMENT_RULES.outcomeUnknown,
    "a lost answer is an unknown outcome, never a decline",
  );
  expectEqual(unknownTrail.entries.length, 1, "and it is audited to be reconciled");
  expectEqual(unknownTrail.entries[0]?.action, PORTAL_PAYMENT_UNKNOWN_AUDIT_ACTION, "under the unknown action");
  expectEqual(unknownTrail.entries[0]?.payload["reconcile"], true, "which marks it for reconciliation");
  expectEqual(
    [...unknownRecorder.records.values()][0]?.settled,
    "unknown",
    "and the record says the outcome is unknown rather than refused",
  );

  const noKeyTransport = transportOf(approval);

  await expectRefusal(
    () =>
      chargePortalPayment(
        {
          token: tokenOf(),
          body: bodyOf(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
        },
        dependenciesOf({
          fixture: fixtureOf(invoiceRow()),
          keyStore: new InMemoryNmiKeyStore(),
          transport: noKeyTransport,
        }),
      ),
    "SERVICE_UNAVAILABLE",
    PORTAL_PAYMENT_RULES.providerUnavailable,
    "a company with no gateway key is refused before anything is sent",
  );
  expectEqual(noKeyTransport.calls.length, 0, "and the provider is never called");

  const nonNmiRouting = transportOf(approval);

  await expectRefusal(
    () =>
      chargePortalPayment(
        {
          token: tokenOf(),
          body: bodyOf(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
        },
        dependenciesOf({
          fixture: fixtureOf(invoiceRow()),
          transport: nonNmiRouting,
          routingRules: [{ id: "charge-stripe", capability: "acceptance", providerKey: "stripe_connect", priority: 100 }],
        }),
      ),
    "SERVICE_UNAVAILABLE",
    PORTAL_PAYMENT_RULES.providerUnavailable,
    "a rule pointing at a provider without hosted fields is refused, not charged elsewhere",
  );
  expectEqual(nonNmiRouting.calls.length, 0, "and nothing is sent to it");

  const notDurableTransport = transportOf(approval);

  await expectRefusal(
    () =>
      chargePortalPayment(
        {
          token: tokenOf(),
          body: bodyOf(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
        },
        dependenciesOf({
          fixture: fixtureOf(invoiceRow()),
          transport: notDurableTransport,
          durable: false,
        }),
      ),
    "SERVICE_UNAVAILABLE",
    PORTAL_PAYMENT_RULES.recorderUnavailable,
    "a recorder that cannot keep its records never reaches the card",
  );
  expectEqual(notDurableTransport.calls.length, 0, "so the provider is not called");

  // ---- the refusals a payer or a merchant produces
  const selfTrail = createInMemoryAuditTrail();
  const selfTransport = transportOf(approval);

  await expectRefusal(
    () =>
      chargePortalPayment(
        {
          token: tokenOf(),
          body: bodyOf(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: companyId,
        },
        dependenciesOf({ fixture: fixtureOf(invoiceRow()), audit: selfTrail, transport: selfTransport }),
      ),
    "CONFLICT",
    PORTAL_PAYMENT_RULES.selfPayment,
    "the merchant cannot pay their own invoice",
  );
  expectEqual(selfTrail.entries.length, 1, "and the attempt is audited");
  expectEqual(selfTrail.entries[0]?.action, PORTAL_PAYMENT_REFUSED_AUDIT_ACTION, "as a refusal");
  expectEqual(selfTransport.calls.length, 0, "with no card charged");

  const cardTrail = createInMemoryAuditTrail();
  const cardTransport = transportOf(approval);

  await expectRefusal(
    () =>
      chargePortalPayment(
        {
          token: tokenOf(),
          body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID(), card_number: "4111111111111111" },
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
        },
        dependenciesOf({ fixture: fixtureOf(invoiceRow()), audit: cardTrail, transport: cardTransport }),
      ),
    "VALIDATION_FAILED",
    PORTAL_PAYMENT_RULES.cardDataRefused,
    "a body carrying a card number never reaches the provider",
  );
  expectEqual(cardTransport.calls.length, 0, "nothing was sent");
  expectEqual(cardTrail.entries.length, 1, "and the fact is in the audit chain");
  expectEqual(cardTrail.entries[0]?.action, PORTAL_PAYMENT_REFUSED_AUDIT_ACTION, "as a refusal");
  expect(
    JSON.stringify(cardTrail.entries[0]?.payload ?? {}).includes("4111") === false,
    "with no card number in it",
  );

  const paidTransport = transportOf(approval);

  await expectRefusal(
    () =>
      chargePortalPayment(
        {
          token: tokenOf(),
          body: bodyOf(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
        },
        dependenciesOf({
          fixture: fixtureOf(invoiceRow({ status: "paid", amount_paid_minor: "1000000", paid_at: "2026-11-03T00:00:00.000Z" })),
          transport: paidTransport,
        }),
      ),
    "CONFLICT",
    PORTAL_PAYMENT_RULES.notPayable,
    "a settled invoice cannot be charged again",
  );
  expectEqual(paidTransport.calls.length, 0, "and no card is touched");

  await expectRefusal(
    () =>
      chargePortalPayment(
        {
          token: "not-a-token",
          body: bodyOf(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
        },
        dependenciesOf(),
      ),
    "RESOURCE_NOT_FOUND",
    null,
    "a charge on a link that does not verify is refused",
  );

  // ---- the counter: five per address per ten minutes, on its own scope
  const allowed = await enforcePortalRateLimit(
    PORTAL_PAYMENT_RATE_LIMIT,
    { clientAddress: "203.0.113.9", route: "/i/[token]/pay/charge" },
    { rest: createRest(createFixture()), audit: createInMemoryAuditTrail() },
  );

  expectEqual(allowed.allowed, true, "an address inside its window may try");
  expectEqual(
    portalRateLimitHeaders(PORTAL_PAYMENT_RATE_LIMIT, allowed)["ratelimit-limit"],
    "5",
    "and the answer names the ceiling",
  );

  const refusedFixture = createFixture();
  refusedFixture.rateLimitAnswer = { allowed: false, remaining: 0, retry_after_seconds: 120, first_refusal: true };
  const refusedTrail = createInMemoryAuditTrail();

  await expectRefusal(
    () =>
      enforcePortalRateLimit(
        PORTAL_PAYMENT_RATE_LIMIT,
        { clientAddress: "203.0.113.9", route: "/i/[token]/pay/charge" },
        { rest: createRest(refusedFixture), audit: refusedTrail },
      ),
    "RATE_LIMITED",
    null,
    "an address that spent its five attempts is refused",
  );
  expectEqual(refusedTrail.entries.length, 1, "and the first refusal is recorded once");
  expect(
    refusedTrail.entries[0]?.payload["key_hash"] !== "203.0.113.9",
    "the entry names the hashed counter, never the address",
  );

  const unreadable = createFixture();
  unreadable.rateLimitAnswer = null;

  await expectRefusal(
    () =>
      enforcePortalRateLimit(
        PORTAL_PAYMENT_RATE_LIMIT,
        { clientAddress: "203.0.113.9", route: "/i/[token]/pay/charge" },
        { rest: createRest(unreadable) },
      ),
    "DEPENDENCY_FAILED",
    null,
    "a counter that cannot answer is a failure, never a pass",
  );

  // ---- the sources: what the route, the page and the form must say
  const route = await readFile(new URL("./i/[token]/pay/charge/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("./i/[token]/pay/page.tsx", import.meta.url), "utf8");
  const form = await readFile(new URL("../../components/payments/card-payment-form.tsx", import.meta.url), "utf8");
  const refusal = await readFile(new URL("../../components/payments/portal-payment-refusal.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("./portal-payment.ts", import.meta.url), "utf8");
  const fields = await readFile(new URL("./portal-payment-fields.ts", import.meta.url), "utf8");
  const processor = await readFile(new URL("./portal-payment-processor.ts", import.meta.url), "utf8");
  const runtime = await readFile(new URL("./portal-payment-runtime.ts", import.meta.url), "utf8");
  const paymentMigration = await readFile(new URL("../../migrations/0037_payments.sql", import.meta.url), "utf8");
  const keyMigration = await readFile(new URL("../../migrations/0030_provider_keys.sql", import.meta.url), "utf8");

  expect(route.includes("requireCsrfToken("), "the payment route checks the CSRF token");
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("enforcePortalRateLimit("),
    "before it spends a counter",
  );
  expect(
    route.indexOf("enforcePortalRateLimit(") < route.indexOf("request.text()"),
    "and the counter is spent before the body is read",
  );
  expect(
    route.includes("PORTAL_PAYMENT_MAXIMUM_BODY_BYTES") &&
      route.includes('"content-length"') &&
      route.includes("new TextEncoder().encode(bodyText).length"),
    "the route caps the body twice: what it was told, and what it received",
  );
  expect(route.includes("readClientAddress("), "and reads the address from the request");
  expect(
    route.includes("readRequestActorOptionally("),
    "and resolves whichever session the request carries, so a seller cannot pay their own invoice",
  );
  expect(route.includes("decodeURIComponent("), "and decodes the token rather than trusting its spelling");
  expect(route.includes("withErrorResponse("), "and every refusal leaves as the platform's error envelope");

  expect(page.includes('"use server"') === false, "the payment page is a page, not a server action");
  expect(page.includes('export const dynamic = "force-dynamic"'), "the page is never cached");
  expect(page.includes("nocache: true"), "and asks a crawler to keep it out of an index");
  expect(page.includes("<input") === false, "and holds no input of its own: every field is the provider's");
  expect(
    page.includes("view.unavailable !== null || view.secureFields === null"),
    "a page that cannot take a card renders the notice before the form",
  );

  const formMarkup = form.replace(/\/\*[\s\S]*?\*\//gu, "");

  // STEP 185 added one input to this form - the payer's billing postal code, which is not card data - so the
  // claim is stated as what it always meant: no *card* field is an input, and the three card containers are
  // still the provider's to fill.
  expect(
    /<input[^>]*(ccnumber|ccexp|cvv|cardnumber|card_number|pan)/iu.test(formMarkup) === false,
    "no card field in the form is an input element, only the three containers the provider fills",
  );
  expect(
    /<div[^>]*id=(\{?)?"?ccnumber/iu.test(formMarkup) || formMarkup.includes('id={CARD_NUMBER_FIELD_ID}'),
    "the card number container is a div the provider draws into",
  );
  // STEP 189 added the second: the amount the payer chooses. Both are the payer's own text fields, so the
  // claim this assertion has always meant is stated as that - the form's inputs are the portal's two facts,
  // never a card's - rather than as a count that every later STEP would have to re-number.
  const formInputs = formMarkup.match(/<input[^>]*>/gu) ?? [];

  expect(
    formInputs.length === 2 &&
      formInputs.every((tag) => tag.includes('type="text"')) &&
      formInputs.every((tag) => /name=(\{PORTAL_PART_PAYMENT_FIELD\}|"billing_postal_code")/u.test(tag)),
    "the form's two inputs are the billing postal code STEP 185 asks for and the amount STEP 189 offers",
  );
  expect(form.includes('"data-tokenization-key"'), "it hands the provider the public tokenization key");
  expect(form.includes("document.createElement(\"script\")"), "and mounts the provider's script itself");
  expect(form.includes("paymentSelector"), "so the provider knows which button submits");
  expect(form.includes("clearInputs"), "and clears a spent token instead of retrying it");
  expect(form.includes("type=\"password\"") === false, "there is no masked field, because there is no field");
  expect(
    form.includes("autoComplete=\"cc-") === false,
    "and no browser autofill target for a card, which would put data outside the provider's frames",
  );

  for (const source of [service, fields, processor, runtime, route, page, form, refusal]) {
    expect(source.startsWith("// path: "), "every file of this STEP names it on the first line");
    expect(!source.includes("console."), "and none of them logs to the console");
    expect(!/TO\s?DO|FIX\s?ME/u.test(source), "and none of them carries a note-to-self");
  }

  expect(
    service.includes("collectjs_token") && service.includes("idempotency_key"),
    "the only body fields the service reads are the token and the key",
  );
  expect(runtime.includes("InMemoryNmiKeyStore"), "the runtime says which key store it wires");
  expect(
    runtime.includes("durable: false") || runtime.includes("createInMemoryPortalPaymentRecorder"),
    "and which recorder, whose durability it states",
  );

  // ---- the schema the page relies on, which is why this STEP needs no migration
  for (const column of ["card_brand", "card_last_four", "provider_transaction_id", "idempotency_key_id", "status"]) {
    expect(paymentMigration.includes(column), `0037 already has \`${column}\`, so no migration is needed`);
  }
  expect(
    /card_brand is null or card_brand in/iu.test(paymentMigration) &&
      !/card_number|card_cvv|pan /iu.test(paymentMigration),
    "and no column exists for a card number, a CVV or a full token",
  );
  expect(
    paymentMigration.includes("payments_card_pair_check"),
    "the two card facts it does hold are required together",
  );
  expect(
    keyMigration.includes("key_ciphertext") && keyMigration.includes("provider_keys_platform_check"),
    "0030 keeps the gateway keys platform scoped and encrypted",
  );

  if (failures.length > 0) {
    process.stderr.write(`portal payment gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `portal payment gate passed: ${checkCount} checks, ${PORTAL_PAYMENT_FORBIDDEN_KEYS.length} card keys refused, ` +
      "one payment per idempotency key, no card data in any body, no migration needed\n",
  );
}

/** The updates a fixture recorded, so the gate can say the page wrote nothing. */
function chargeFixturesUpdates(fixture: Fixture): number {
  return fixture.updates.length;
}

await main();
