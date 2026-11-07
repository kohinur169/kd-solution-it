// path: app/(client-portal)/portal-billing-match-verify.ts
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { openSecret, packSecretBox, sealSecret, unpackSecretBox } from "../../lib/auth/secrets.ts";
import { isAppError } from "../../lib/errors/app-error.ts";
import { mintPortalToken, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import {
  configureNmiKeys,
  InMemoryNmiKeyStore,
} from "../../lib/payments/adapters/nmi-client.ts";
import type { NmiHttpTransport } from "../../lib/payments/adapters/nmi-payment.ts";
import { PORTAL_PAYMENT_RULES } from "./portal-payment-fields.ts";
import type { PortalPaymentDependencies } from "./portal-payment.ts";
import {
  createPortalPaymentProcessor,
  type PortalPaymentRecorder,
  type PortalRecorderOpen,
} from "./portal-payment-processor.ts";
import {
  PORTAL_BILLING_AUDIT_ENTITY,
  PORTAL_BILLING_DECIDED_AUDIT_ACTION,
  PORTAL_BILLING_POSTAL_FIELD,
  PORTAL_BILLING_POSTAL_MAXIMUM_LENGTH,
  PORTAL_BILLING_POSTAL_MINIMUM_LENGTH,
  PORTAL_BILLING_POSTAL_PATTERN,
  PORTAL_BILLING_REVIEW_DECISION,
  PORTAL_BILLING_REVIEW_OWNER,
  PORTAL_BILLING_REVIEW_REFUSED_AUDIT_ACTION,
  PORTAL_BILLING_REVIEW_ROUTED_AUDIT_ACTION,
  PORTAL_BILLING_REVIEW_STATUS,
  PORTAL_BILLING_RULES,
  portalBillingCountryKey,
  portalBillingMatchOf,
  portalBillingPostalCodeKey,
  portalBillingReviewPayloadOf,
  type PortalBillingFacts,
} from "./portal-billing-match-fields.ts";
import {
  evaluatePortalBillingMatch,
  readPortalBillingFacts,
  routePortalPaymentReview,
  splitPortalBillingPostalField,
  type PortalBillingMatchDependencies,
  type PortalCountryResolver,
  type PortalPaymentReviewQueue,
  type PortalPaymentReviewRequest,
} from "./portal-billing-match.ts";
import { createInMemoryPaymentReviewQueue, noPortalCountryResolver } from "./portal-billing-match-processor.ts";
import {
  completePortalThreeDs,
  startPortalThreeDs,
  type PortalThreeDsClaim,
  type PortalThreeDsCompleteAnswer,
  type PortalThreeDsCompleteRequest,
  type PortalThreeDsDependencies,
  type PortalThreeDsPort,
  type PortalThreeDsRecorder,
  type PortalThreeDsRecord,
  type PortalThreeDsRequest,
  type PortalThreeDsRequestAnswer,
  type PortalThreeDsSecrets,
  type PortalThreeDsSettlement,
} from "./portal-three-ds.ts";

/**
 * The gate for STEP 185: the billing match, and the review it routes when the match fails.
 *
 * ## What this proves
 *
 * Section 18's second sentence is a rule about what may be captured when a bank did not confirm the card, and a
 * rule is only real if the platform can be made to answer it both ways. So this gate exercises:
 *
 *   - the **normalisation**, because a postal code typed by a person has three spellings of one place;
 *   - the **comparison**, over every combination of the two facts - matched, mismatched, absent, unreadable,
 *     unresolvable - with the reason a reviewer reads;
 *   - the **read**, against a fixture whose client record is the only source of the invoice's billing facts;
 *   - the **routing**, into a queue and into the audit chain, and the honest refusal when the queue cannot
 *     keep what it routes;
 *   - and the **whole flow through STEP 184**, because the point of these two booleans is that a payment which
 *     was not authenticated is still captured when they are both true, and reviewed when either is not.
 *
 * The third of those is the one worth the fiction: the flow is driven by the real `startPortalThreeDs` and
 * `completePortalThreeDs` over the fixture database, the recording bank and the real cipher, so what is checked
 * is the platform's behaviour rather than a description of it.
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
function expectSyncRefusal(run: () => unknown, code: string, rule: string, description: string): void {
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
// The fixture: a PostgREST over arrays, now carrying the client record STEP 185 reads.
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
}

function createFixture(): Fixture {
  return { tables: new Map<string, Row[]>(), queries: [] };
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
      throw new Error("a portal billing rule writes no table of its own");
    },

    async insertReturning<TRow>(): Promise<readonly TRow[]> {
      throw new Error("a portal billing rule writes no table of its own");
    },

    async update(): Promise<void> {
      throw new Error("a portal billing rule writes no table of its own");
    },

    async rpc(): Promise<unknown> {
      throw new Error("a portal billing rule calls no function");
    },
  };
}

const companyId = "11111111-1111-4111-8111-111111111111";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const keys: PortalTokenKeys = { primary: Buffer.alloc(32, 7).toString("base64") };
const masterKey = Buffer.alloc(32, 9).toString("base64");
const nowMs = Date.parse("2026-11-07T09:30:00.000Z");
const nowSeconds = Math.floor(nowMs / 1_000);
const encryptionKeyHex = randomBytes(32).toString("hex");
const tokenizationKey = "public-tokenization-key-1234";
const securityKey = "private-security-key-1234";
const origin = "https://portal.kd-solutions.test";
const collectJsToken = "1234567890abcdef-token";
const clientPostal = "SW1A 1AA";
const clientCountry = "GB";

function invoiceRow(): Row {
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

function clientRow(overrides: Row = {}): Row {
  return {
    id: clientId,
    company_id: companyId,
    postal_code: clientPostal,
    country: clientCountry,
    // The read asks for a record that has not been deleted, so the fixture's row says it has not.
    deleted_at: null,
    version: 3,
    ...overrides,
  };
}

function fixtureOf(options: { readonly client?: Row | null } = {}): Fixture {
  const fixture = createFixture();
  const client = options.client === undefined ? clientRow() : options.client;

  fixture.tables.set("invoices", [invoiceRow()]);
  fixture.tables.set("invoice_items", [itemRow()]);
  fixture.tables.set("payments", []);
  fixture.tables.set("invoice_fulfilment_evidence", []);
  fixture.tables.set("invoice_acceptances", []);

  if (client !== null) {
    fixture.tables.set("clients", [client]);
  }

  return fixture;
}

function tokenOf(): string {
  return mintPortalToken(
    {
      kind: "invoice",
      companyId,
      resourceId: invoiceId,
      capability: "pay",
      lifetimeSeconds: 604_800,
    },
    { keys, now: nowSeconds - 3_600 },
  );
}

interface RecordingTransport {
  readonly transport: NmiHttpTransport;
  readonly calls: { readonly endpoint: string; readonly payload: Record<string, string> }[];
}

function transportOf(): RecordingTransport {
  const calls: { readonly endpoint: string; readonly payload: Record<string, string> }[] = [];

  return {
    calls,
    transport: async (endpoint, payload) => {
      calls.push({ endpoint, payload });

      return {
        response: "1",
        response_code: "100",
        responsetext: "SUCCESS",
        transactionid: "9876543210",
        amount: "100.00",
      };
    },
  };
}

function paymentRecorderOf(): PortalPaymentRecorder {
  const records = new Map<string, { readonly paymentId: string; settled: string | null; transactionId: string | null }>();
  const byPayment = new Map<string, { readonly paymentId: string; settled: string | null; transactionId: string | null }>();

  return {
    durable: true,
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
  };
}

function paymentDependenciesOf(
  fixture: Fixture,
  audit: InMemoryAuditTrail,
  transport: RecordingTransport,
): PortalPaymentDependencies {
  const store = new InMemoryNmiKeyStore();

  configureNmiKeys(
    { companyId, apiKey: tokenizationKey, secretKey: securityKey, environment: "sandbox" },
    { store, encryptionKey: encryptionKeyHex, occurredAtEpochMs: nowMs - 86_400_000 },
  );

  return {
    rest: createRest(fixture),
    audit,
    tokenKeys: keys,
    processor: createPortalPaymentProcessor({
      recorder: paymentRecorderOf(),
      keyStore: store,
      encryptionKeyHex,
      transport: transport.transport,
    }),
    tokenizationKeyFor: () => ({ apiKey: tokenizationKey, environment: "sandbox" }),
    now: () => nowMs,
  };
}

interface RecordingResolver extends PortalCountryResolver {
  readonly asked: string[];
}

/** A resolver that answers for every address, and remembers what it was asked about. */
function resolverOf(country: string | null, available = true, fail = false): RecordingResolver {
  const asked: string[] = [];

  return {
    asked,
    available,
    async countryOf(ipAddress: string): Promise<string | null> {
      asked.push(ipAddress);

      if (fail) {
        throw new Error("the resolver is down");
      }

      return country;
    },
  };
}

interface GateQueue extends PortalPaymentReviewQueue {
  readonly routed: PortalPaymentReviewRequest[];
}

function queueOf(durable = true): GateQueue {
  const routed: PortalPaymentReviewRequest[] = [];

  return {
    durable,
    routed,
    async route(input: PortalPaymentReviewRequest) {
      routed.push(input);

      return { status: "routed", reviewId: randomUUID() } as const;
    },
  };
}

interface RecordingPort extends PortalThreeDsPort {
  readonly completes: PortalThreeDsCompleteRequest[];
}

function portOf(complete: PortalThreeDsCompleteAnswer): RecordingPort {
  const completes: PortalThreeDsCompleteRequest[] = [];

  return {
    available: true,
    completes,
    async request(_input: PortalThreeDsRequest): Promise<PortalThreeDsRequestAnswer> {
      return {
        status: "challenge",
        providerChallengeId: "prov-challenge-0001",
        acsUrl: "https://acs.example-bank.test/challenge",
        paReq: "UEFSZXE+YmFzZTY0K2NoYWxsZW5nZQ==",
      };
    },
    async complete(input: PortalThreeDsCompleteRequest): Promise<PortalThreeDsCompleteAnswer> {
      completes.push(input);

      return complete;
    },
  };
}

interface GateRecorder extends PortalThreeDsRecorder {
  readonly records: Map<string, PortalThreeDsRecord>;
  readonly claimed: Set<string>;
}

function challengeRecorderOf(): GateRecorder {
  const records = new Map<string, PortalThreeDsRecord>();
  const claimed = new Set<string>();

  return {
    durable: true,
    records,
    claimed,
    open(record: PortalThreeDsRecord) {
      records.set(record.challengeId, record);

      return { status: "opened" } as const;
    },
    claim(challengeId: string): PortalThreeDsClaim {
      const record = records.get(challengeId);

      if (record === undefined) {
        return { status: "unknown" };
      }

      if (claimed.has(challengeId)) {
        return { status: "spent" };
      }

      claimed.add(challengeId);

      return { status: "claimed", record };
    },
    settle(_input: PortalThreeDsSettlement): void {
      // The flow's settlement is STEP 184's gate's subject; here the review routing is.
    },
  };
}

function secretsOf(): PortalThreeDsSecrets {
  return {
    seal: (plaintext, context) => packSecretBox(sealSecret(masterKey, plaintext, context)),
    open: (box, context) => {
      const unpacked = unpackSecretBox(box);

      if (unpacked === null) {
        throw new Error("not a box");
      }

      return openSecret(masterKey, unpacked, context);
    },
  };
}

interface Flow {
  readonly dependencies: PortalThreeDsDependencies;
  readonly billing: PortalBillingMatchDependencies;
  readonly audit: InMemoryAuditTrail;
  readonly transport: RecordingTransport;
  readonly recorder: GateRecorder;
  readonly queue: GateQueue;
  readonly resolver: RecordingResolver;
  readonly fixture: Fixture;
}

function flowOf(options: {
  readonly client?: Row | null;
  readonly country?: string | null;
  readonly resolver?: PortalCountryResolver | null;
  readonly queue?: PortalPaymentReviewQueue | null;
  readonly complete?: PortalThreeDsCompleteAnswer;
  readonly resolverFails?: boolean;
} = {}): Flow {
  const fixture = fixtureOf(options.client === undefined ? {} : { client: options.client });
  const audit = createInMemoryAuditTrail();
  const transport = transportOf();
  const recorder = challengeRecorderOf();
  const queue = queueOf();
  const resolver = resolverOf(options.country ?? clientCountry, true, options.resolverFails ?? false);

  const billing: PortalBillingMatchDependencies = {
    rest: createRest(fixture),
    audit,
    resolver: options.resolver === undefined ? resolver : options.resolver,
    queue: options.queue === undefined ? queue : options.queue,
    now: () => nowMs,
  };

  return {
    fixture,
    audit,
    transport,
    recorder,
    queue,
    resolver,
    billing,
    dependencies: {
      payment: paymentDependenciesOf(fixture, audit, transport),
      port: portOf(options.complete ?? { status: "abandoned" }),
      recorder,
      secrets: secretsOf(),
      billing,
      now: () => nowMs,
    },
  };
}

function startInputOf(body: Row) {
  return {
    token: tokenOf(),
    body,
    clientAddress: "203.0.113.9",
    userAgent: "Mozilla/5.0 (gate)",
    acceptLanguage: "en-GB",
    origin,
    actorCompanyId: null,
  } as const;
}

function bodyOf(postalCode?: string): Row {
  const base: Row = { collectjs_token: collectJsToken, idempotency_key: randomUUID() };

  return postalCode === undefined ? base : { ...base, [PORTAL_BILLING_POSTAL_FIELD]: postalCode };
}

/** Start a challenge and complete it with the bank's answer, which is what a payer would do. */
async function runFlow(flow: Flow, body: Row, token: string): Promise<Awaited<ReturnType<typeof completePortalThreeDs>>> {
  const started = await startPortalThreeDs(startInputOf(body), flow.dependencies);

  if (started.status !== "challenge") {
    throw new Error("the fixture expected a challenge");
  }

  return completePortalThreeDs(
    {
      token,
      body: { PaRes: "Y2hhbGxlbmdlLXJlc3VsdA==", MD: started.md },
      clientAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (gate)",
      actorCompanyId: null,
    },
    flow.dependencies,
  );
}

async function main(): Promise<void> {
  // ---- the vocabulary
  expectEqual(PORTAL_BILLING_POSTAL_FIELD, "billing_postal_code", "the payer's postal code has one field name");
  expectEqual(PORTAL_BILLING_POSTAL_MINIMUM_LENGTH, 2, "a postal code is at least two characters");
  expectEqual(PORTAL_BILLING_POSTAL_MAXIMUM_LENGTH, 16, "and at most sixteen, as `clients_postal_code_check` allows");
  expect(PORTAL_BILLING_POSTAL_PATTERN.test("SW1A 1AA"), "letters, digits and spaces are a postal code");
  expect(PORTAL_BILLING_POSTAL_PATTERN.test("75001-1234"), "and so is one with a hyphen");
  expect(PORTAL_BILLING_POSTAL_PATTERN.test("-10001") === false, "one starting with a separator is not");
  expectEqual(PORTAL_BILLING_REVIEW_OWNER, "compliance_kyc", "section 18 names the desk");
  expectEqual(PORTAL_BILLING_REVIEW_STATUS, "under_review", "and `0037` names the status");
  expectEqual(PORTAL_BILLING_REVIEW_DECISION, "review", "and the risk decision");
  expectEqual(PORTAL_BILLING_AUDIT_ENTITY, "payment", "the review is about a payment");
  expect(
    new Set([
      PORTAL_BILLING_DECIDED_AUDIT_ACTION,
      PORTAL_BILLING_REVIEW_ROUTED_AUDIT_ACTION,
      PORTAL_BILLING_REVIEW_REFUSED_AUDIT_ACTION,
    ]).size === 3,
    "the three audit actions are distinct",
  );

  // ---- normalisation: one place, three spellings
  expectEqual(portalBillingPostalCodeKey("SW1A 1AA"), "SW1A1AA", "a spaced postal code normalises");
  expectEqual(portalBillingPostalCodeKey("sw1a1aa"), "SW1A1AA", "a lower case one is the same place");
  expectEqual(portalBillingPostalCodeKey("SW1A-1AA"), "SW1A1AA", "and so is a hyphenated one");
  expectEqual(portalBillingPostalCodeKey(" 10001 "), "10001", "and a padded one is trimmed");
  expectEqual(portalBillingPostalCodeKey("A"), null, "one character is not a postal code");
  expectEqual(portalBillingPostalCodeKey("A".repeat(17)), null, "nor is seventeen characters");
  expectEqual(portalBillingPostalCodeKey("!!"), null, "nor is punctuation");
  expectEqual(portalBillingPostalCodeKey(""), null, "nor is nothing");
  expectEqual(portalBillingPostalCodeKey(null), null, "nor is a missing value");
  expectEqual(portalBillingPostalCodeKey(10001), null, "nor is a number");

  expectEqual(portalBillingCountryKey("gb"), "GB", "a country code folds case");
  expectEqual(portalBillingCountryKey(" GB "), "GB", "and trims");
  expectEqual(portalBillingCountryKey("GBR"), null, "a three letter code is not the shape the platform stores");
  expectEqual(portalBillingCountryKey("G1"), null, "nor is a digit");
  expectEqual(portalBillingCountryKey(null), null, "nor is nothing");

  // ---- the comparison: every way two facts can meet
  const facts: PortalBillingFacts = { postalCode: clientPostal, country: clientCountry };

  const bothMatched = portalBillingMatchOf({
    payerPostalCode: "sw1a1aa",
    payerCountry: "gb",
    facts,
  });

  expectEqual(bothMatched.postalCodeMatched, true, "the payer's postal code is the client's, however it was typed");
  expectEqual(bothMatched.ipCountryMatched, true, "and the country is the same one");
  expectEqual(bothMatched.decision, "capture", "so section 18's fallback allows capture");
  expectEqual(bothMatched.postalCodeReason, "matched", "with both reasons saying so");
  expectEqual(bothMatched.countryReason, "matched", "and the country too");

  const postalWrong = portalBillingMatchOf({ payerPostalCode: "M1 1AE", payerCountry: "GB", facts });

  expectEqual(postalWrong.postalCodeMatched, false, "another postal code is a mismatch");
  expectEqual(postalWrong.postalCodeReason, "postal_code_mismatch", "and the reason says which");
  expectEqual(postalWrong.ipCountryMatched, true, "while the country still matched");
  expectEqual(postalWrong.decision, "review", "so nothing is captured");

  const countryWrong = portalBillingMatchOf({ payerPostalCode: "SW1A 1AA", payerCountry: "US", facts });

  expectEqual(countryWrong.postalCodeMatched, true, "the postal code still matched");
  expectEqual(countryWrong.countryReason, "country_mismatch", "but the country did not");
  expectEqual(countryWrong.decision, "review", "so nothing is captured either");

  const postalAbsent = portalBillingMatchOf({ payerPostalCode: null, payerCountry: "GB", facts });

  expectEqual(postalAbsent.postalCodeMatched, false, "a payer who typed no postal code is a mismatch");
  expectEqual(postalAbsent.postalCodeReason, "postal_code_absent", "and the reason says the field was absent");
  expectEqual(postalAbsent.decision, "review", "so the payment is reviewed");

  const postalUnreadable = portalBillingMatchOf({ payerPostalCode: "!!", payerCountry: "GB", facts });

  expectEqual(postalUnreadable.postalCodeReason, "postal_code_invalid", "an unreadable one is its own reason");

  const noFacts = portalBillingMatchOf({ payerPostalCode: "SW1A 1AA", payerCountry: "GB", facts: null });

  expectEqual(noFacts.postalCodeReason, "postal_code_unknown", "a client with no postal code can match nothing");
  expectEqual(noFacts.countryReason, "country_absent", "and a client with no country likewise");
  expectEqual(noFacts.decision, "review", "so an invoice whose client has no address is reviewed");

  const noResolver = portalBillingMatchOf(
    { payerPostalCode: "SW1A 1AA", payerCountry: null, facts },
    { countryResolved: false },
  );

  expectEqual(noResolver.countryReason, "country_unresolved", "a deployment with no resolver says so");
  expectEqual(noResolver.decision, "review", "and captures nothing without 3D Secure");

  const unknownAddress = portalBillingMatchOf(
    { payerPostalCode: "SW1A 1AA", payerCountry: null, facts },
    { countryResolved: true },
  );

  expectEqual(unknownAddress.countryReason, "country_unknown", "an address in no country is its own reason");
  expectEqual(unknownAddress.decision, "review", "and is a mismatch rather than a pass");

  // The rule is one `and`, so no combination of the two booleans can disagree with it.
  for (const postalMatches of [false, true]) {
    for (const countryMatches of [false, true]) {
      const expected = postalMatches && countryMatches ? "capture" : "review";
      const computed = portalBillingMatchOf(
        {
          payerPostalCode: postalMatches ? clientPostal : "M1 1AE",
          payerCountry: countryMatches ? clientCountry : "US",
          facts,
        },
        { countryResolved: true },
      );

      expectEqual(
        computed.decision,
        expected,
        `postal ${String(postalMatches)} and country ${String(countryMatches)} decide ${expected}`,
      );
    }
  }

  expectEqual(
    portalBillingReviewPayloadOf({
      invoiceId,
      amountMinor: "1000000",
      paymentId: null,
      challengeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      match: postalWrong,
    })["status"],
    "under_review",
    "the review payload carries the status `0037` indexes",
  );
  expectEqual(PORTAL_BILLING_RULES.matched, "billing_matched", "and the rules are named, not spelled inline");

  // ---- the read: the client record is the only source of the invoice's facts
  {
    const fixture = fixtureOf();
    const rest = createRest(fixture);
    const read = await readPortalBillingFacts(
      { companyId, clientId },
      { rest, audit: createInMemoryAuditTrail(), resolver: null, queue: null },
    );

    expectEqual(read?.postalCode, clientPostal, "the client's postal code is read");
    expectEqual(read?.country, clientCountry, "and its country");
    expect(
      fixture.queries.some((query) => query.startsWith("clients?") && query.includes("company_id=eq.")),
      "the read is tenant scoped, so a client of another company cannot be reached",
    );
    expect(
      fixture.queries.every((query) => !query.includes("select=*")),
      "and it selects only the two columns it compares",
    );

    const missing = await readPortalBillingFacts(
      { companyId, clientId },
      { rest, audit: createInMemoryAuditTrail(), resolver: null, queue: null },
    );

    expect(missing !== null, "a client record that is there is read");

    const empty = createFixture();

    empty.tables.set("clients", []);

    expectEqual(
      await readPortalBillingFacts(
        { companyId, clientId },
        { rest: createRest(empty), audit: createInMemoryAuditTrail(), resolver: null, queue: null },
      ),
      null,
      "and a client record that is gone is null rather than an error",
    );
  }

  // ---- the evaluation: the resolver is asked, and its failure fails closed
  {
    const fixture = fixtureOf();
    const resolver = resolverOf("GB");
    const evaluated = await evaluatePortalBillingMatch(
      { companyId, clientId, payerPostalCode: "sw1a 1aa", payerIpAddress: "203.0.113.9" },
      { rest: createRest(fixture), audit: createInMemoryAuditTrail(), resolver, queue: null },
    );

    expectEqual(evaluated.decision, "capture", "a matching postal code and a resolved country allow capture");
    expectEqual(resolver.asked[0], "203.0.113.9", "the resolver is asked about the payer's address");

    const failing = await evaluatePortalBillingMatch(
      { companyId, clientId, payerPostalCode: "SW1A 1AA", payerIpAddress: "203.0.113.9" },
      {
        rest: createRest(fixture),
        audit: createInMemoryAuditTrail(),
        resolver: resolverOf("GB", true, true),
        queue: null,
      },
    );

    expectEqual(failing.decision, "review", "a resolver that throws is a mismatch, not a capture");
    expectEqual(failing.countryReason, "country_unknown", "and says the address could not be placed");

    const absent = await evaluatePortalBillingMatch(
      { companyId, clientId, payerPostalCode: "SW1A 1AA", payerIpAddress: "203.0.113.9" },
      { rest: createRest(fixture), audit: createInMemoryAuditTrail(), resolver: null, queue: null },
    );

    expectEqual(absent.decision, "review", "and a deployment with no resolver captures nothing unauthenticated");
    expectEqual(absent.countryReason, "country_unresolved", "which the audit can tell from an unknown address");

    const other = await evaluatePortalBillingMatch(
      { companyId, clientId, payerPostalCode: "SW1A 1AA", payerIpAddress: "198.51.100.7" },
      { rest: createRest(fixture), audit: createInMemoryAuditTrail(), resolver: resolverOf("US"), queue: null },
    );

    expectEqual(other.ipCountryMatched, false, "a payer whose address resolves elsewhere does not match");
    expectEqual(other.countryReason, "country_mismatch", "and the reason is a mismatch rather than an absence");
  }

  // ---- the routing: a queue, the audit chain, and an honest refusal
  {
    const fixture = fixtureOf();
    const audit = createInMemoryAuditTrail();
    const queue = queueOf();

    const routed = await routePortalPaymentReview(
      {
        companyId,
        invoiceId,
        paymentId: null,
        challengeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        amountMinor: "1000000",
        match: postalWrong,
        ipAddress: "203.0.113.9",
        userAgent: "Mozilla/5.0 (gate)",
      },
      { rest: createRest(fixture), audit, resolver: null, queue },
    );

    expectEqual(routed.status, "routed", "a durable queue routes the review");
    expectEqual(queue.routed.length, 1, "one record was written");
    expectEqual(queue.routed[0]?.status, "under_review", "with the status `0037` indexes");
    expectEqual(queue.routed[0]?.riskDecision, "review", "and the risk decision the schema allows");
    expectEqual(queue.routed[0]?.reviewOwner, "compliance_kyc", "for the desk section 18 names");
    expectEqual(queue.routed[0]?.postalCodeMatched, false, "naming the postal code as the failing fact");
    expectEqual(queue.routed[0]?.countryReason, "matched", "and the country as the one that matched");
    expectEqual(queue.routed[0]?.amountMinor, "1000000", "with the amount a reviewer is being asked about");

    expectEqual(audit.entries.length, 2, "two chain entries were written");
    expectEqual(audit.entries[0]?.action, PORTAL_BILLING_DECIDED_AUDIT_ACTION, "the decision first");
    expectEqual(audit.entries[0]?.payload["review_owner"], "compliance_kyc", "naming the desk");
    expectEqual(audit.entries[0]?.payload["captured"], false, "and stating that nothing was captured");
    expectEqual(audit.entries[0]?.payload["postal_code_reason"], "postal_code_mismatch", "with the reason");
    expectEqual(audit.entries[1]?.action, PORTAL_BILLING_REVIEW_ROUTED_AUDIT_ACTION, "then the routing");
    expect(audit.entries[1]?.payload["review_id"] !== undefined, "with the review it wrote");

    const unaudited = createInMemoryAuditTrail();
    const refused = await routePortalPaymentReview(
      {
        companyId,
        invoiceId,
        paymentId: null,
        challengeId: null,
        amountMinor: "1000000",
        match: postalWrong,
        ipAddress: "203.0.113.9",
        userAgent: null,
      },
      { rest: createRest(fixture), audit: unaudited, resolver: null, queue: createInMemoryPaymentReviewQueue() },
    );

    expectEqual(refused.status, "refused", "a queue that cannot keep its records refuses the routing");
    expectEqual(
      refused.status === "refused" ? refused.reason : "",
      "queue_not_durable",
      "and says why",
    );
    expectEqual(
      unaudited.entries[1]?.action,
      PORTAL_BILLING_REVIEW_REFUSED_AUDIT_ACTION,
      "the refusal is in the chain too, because a review that did not happen is a fact",
    );
    expectEqual(
      unaudited.entries[1]?.payload["rule"],
      PORTAL_BILLING_RULES.reviewQueueNotDurable,
      "with the rule",
    );

    const noQueue = await routePortalPaymentReview(
      {
        companyId,
        invoiceId,
        paymentId: null,
        challengeId: null,
        amountMinor: "1000000",
        match: postalWrong,
        ipAddress: "203.0.113.9",
        userAgent: null,
      },
      { rest: createRest(fixture), audit: createInMemoryAuditTrail(), resolver: null, queue: null },
    );

    expectEqual(noQueue.status, "refused", "and no queue at all is the same refusal");
    expectEqual(noQueue.status === "refused" ? noQueue.reason : "", "queue_unavailable", "for the other reason");
  }

  // ---- the body split: the postal code leaves, everything else still meets STEP 183's rules
  {
    const withPostal = splitPortalBillingPostalField({
      collectjs_token: collectJsToken,
      idempotency_key: "6f1c5c1e-6f6f-4f6f-8f6f-6f6f6f6f6f6f",
      billing_postal_code: "  SW1A 1AA  ",
    });

    expectEqual(withPostal.postalCode, "SW1A 1AA", "the postal code is trimmed out of the body");
    expect(
      Object.hasOwn(withPostal.rest as Row, PORTAL_BILLING_POSTAL_FIELD) === false,
      "and the body STEP 183 parses no longer holds it",
    );

    const without = splitPortalBillingPostalField({ collectjs_token: "x", idempotency_key: "y" });

    expectEqual(without.postalCode, null, "an absent postal code is not an error");
    expectEqual(without.rest === null, false, "and the body passes through unchanged");

    const withCard = splitPortalBillingPostalField({
      collectjs_token: collectJsToken,
      idempotency_key: "6f1c5c1e-6f6f-4f6f-8f6f-6f6f6f6f6f6f",
      billing_postal_code: "SW1A 1AA",
      card_number: "4111111111111111",
    });

    expect(
      Object.hasOwn(withCard.rest as Row, "card_number"),
      "a card field stays in the body, so STEP 183's card scan still sees it",
    );

    expectSyncRefusal(
      () => splitPortalBillingPostalField({ billing_postal_code: "!!" }),
      "VALIDATION_FAILED",
      PORTAL_BILLING_RULES.postalCodeInvalid,
      "an unreadable postal code is refused rather than compared",
    );
    expectSyncRefusal(
      () => splitPortalBillingPostalField({ billing_postal_code: 10001 }),
      "VALIDATION_FAILED",
      PORTAL_BILLING_RULES.postalCodeInvalid,
      "and so is one that is not text",
    );
    expectSyncRefusal(
      () => splitPortalBillingPostalField({ billing_postal_code: "A".repeat(PORTAL_BILLING_POSTAL_MAXIMUM_LENGTH + 1) }),
      "VALIDATION_FAILED",
      PORTAL_BILLING_RULES.postalCodeInvalid,
      "and one longer than the platform stores",
    );
  }

  // ---- the flow: both facts true captures without a bank, either false reviews and routes
  {
    const flow = flowOf();
    const token = tokenOf();
    const completed = await runFlow(flow, bodyOf("sw1a 1aa"), token);

    expectEqual(completed.status, "captured", "a payment whose billing facts both match is captured without 3DS");
    expectEqual(flow.transport.calls.length, 1, "through the one charge path");
    expectEqual(flow.transport.calls[0]?.payload["amount"], "100.00", "for the invoice's amount");
    expectEqual(flow.queue.routed.length, 0, "and no review is routed");

    if (completed.status === "captured") {
      expectEqual(completed.basis, "billing_match", "the basis is the billing match, not the bank");
      expectEqual(completed.outcome, "attempted", "with the bank's own answer recorded");
    }

    const record = [...flow.recorder.records.values()][0];

    expectEqual(record?.billingMatch.postalCodeMatched, true, "the challenge record carries the postal match");
    expectEqual(record?.billingMatch.ipCountryMatched, true, "and the country match");
    expectEqual(record?.billingMatch.postalCodeReason, "matched", "with the reasons a reviewer would read");
  }

  {
    const flow = flowOf();
    const token = tokenOf();
    const completed = await runFlow(flow, bodyOf("M1 1AE"), token);

    expectEqual(completed.status, "review", "a payment whose postal code does not match is reviewed");
    expectEqual(flow.transport.calls.length, 0, "and nothing is captured");
    expectEqual(flow.queue.routed.length, 1, "the review was routed to the desk");
    expectEqual(flow.queue.routed[0]?.postalCodeMatched, false, "naming the fact that failed");
    expectEqual(flow.queue.routed[0]?.reviewOwner, "compliance_kyc", "for compliance");
    expect(
      flow.audit.entries.map((entry) => entry.action).includes(PORTAL_BILLING_REVIEW_ROUTED_AUDIT_ACTION),
      "and the routing is in the chain",
    );
  }

  {
    const flow = flowOf({ country: "US" });
    const token = tokenOf();
    const completed = await runFlow(flow, bodyOf("SW1A 1AA"), token);

    expectEqual(completed.status, "review", "a payer whose address resolves elsewhere is reviewed");
    expectEqual(flow.queue.routed[0]?.countryReason, "country_mismatch", "with the country named as the reason");
    expectEqual(flow.transport.calls.length, 0, "and nothing captured");
  }

  {
    const flow = flowOf();
    const token = tokenOf();
    const completed = await runFlow(flow, bodyOf(), token);

    expectEqual(completed.status, "review", "a payer who typed no postal code is reviewed");
    expectEqual(
      flow.queue.routed[0]?.postalCodeReason,
      "postal_code_absent",
      "and the queue says the field was absent rather than wrong",
    );
  }

  {
    const flow = flowOf({ resolver: noPortalCountryResolver });
    const token = tokenOf();
    const completed = await runFlow(flow, bodyOf("SW1A 1AA"), token);

    expectEqual(completed.status, "review", "a deployment with no country data captures nothing unauthenticated");
    expectEqual(flow.queue.routed[0]?.countryReason, "country_unresolved", "and says so in the queue");
  }

  {
    const flow = flowOf({ resolverFails: true });
    const token = tokenOf();
    const completed = await runFlow(flow, bodyOf("SW1A 1AA"), token);

    expectEqual(completed.status, "review", "a resolver that fails fails closed");
    expectEqual(flow.queue.routed[0]?.countryReason, "country_unknown", "and the address is unknown, not matched");
  }

  {
    const flow = flowOf({ queue: createInMemoryPaymentReviewQueue() });
    const token = tokenOf();
    const completed = await runFlow(flow, bodyOf("M1 1AE"), token);

    expectEqual(completed.status, "review", "a review that cannot be queued is still not a capture");
    expect(
      flow.audit.entries.map((entry) => entry.action).includes(PORTAL_BILLING_REVIEW_REFUSED_AUDIT_ACTION),
      "and the refusal to route is in the chain",
    );
  }

  {
    const flow = flowOf();

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(bodyOf("!!")), flow.dependencies),
      "VALIDATION_FAILED",
      PORTAL_BILLING_RULES.postalCodeInvalid,
      "an unreadable postal code stops the attempt before the bank is asked",
    );

    await expectRefusal(
      () =>
        startPortalThreeDs(
          startInputOf({
            collectjs_token: collectJsToken,
            idempotency_key: randomUUID(),
            billing_postal_code: "SW1A 1AA",
            card_number: "4111111111111111",
          }),
          flow.dependencies,
        ),
      "VALIDATION_FAILED",
      PORTAL_PAYMENT_RULES.cardDataRefused,
      "and a body carrying card data is still refused by STEP 183's rule",
    );

    await expectRefusal(
      () =>
        startPortalThreeDs(
          startInputOf({
            collectjs_token: "4111111111111111",
            idempotency_key: randomUUID(),
            billing_postal_code: "SW1A 1AA",
          }),
          flow.dependencies,
        ),
      "VALIDATION_FAILED",
      PORTAL_PAYMENT_RULES.cardDataRefused,
      "a PAN where the token belongs is card data, not a token",
    );
  }

  // ---- the sources
  const billingService = await readFile(new URL("./portal-billing-match.ts", import.meta.url), "utf8");
  const billingFields = await readFile(new URL("./portal-billing-match-fields.ts", import.meta.url), "utf8");
  const processor = await readFile(new URL("./portal-billing-match-processor.ts", import.meta.url), "utf8");
  const form = await readFile(new URL("../../components/payments/card-payment-form.tsx", import.meta.url), "utf8");
  const payPage = await readFile(new URL("./i/[token]/pay/page.tsx", import.meta.url), "utf8");
  const migration = await readFile(new URL("../../migrations/0037_payments.sql", import.meta.url), "utf8");
  const clientsMigration = await readFile(new URL("../../migrations/0019_clients.sql", import.meta.url), "utf8");

  expect(billingService.includes("company_id=eq."), "the client read is tenant scoped in the query itself");
  expect(billingService.includes("deleted_at=is.null"), "and skips a deleted client record");
  expect(billingService.includes('"select=id,company_id,postal_code,country"'), "and selects nothing else");
  expect(billingFields.includes("clients_postal_code_check") || billingFields.includes("PORTAL_BILLING_POSTAL_PATTERN"), "the postal alphabet is the one the client table allows");
  expect(processor.includes("durable: false"), "the in-memory review queue says it is not durable");
  expect(processor.includes("available: false"), "and the absent resolver says it is absent");

  expect(form.includes('name="billing_postal_code"'), "the card form asks for the billing postal code");
  expect(form.includes('autoComplete="postal-code"'), "as a browser can fill it");
  expect(form.includes('maxLength={16}'), "bounded to the length the client table stores");
  expect(
    /<input[^>]*(ccnumber|ccexp|cvv)/u.test(form) === false,
    "and the card fields are still the provider's containers, not inputs",
  );
  expect(form.includes("askForPostalCode"), "the field is rendered only on the path that compares it");
  expect(payPage.includes("askForPostalCode={threeDsReady}"), "and the page decides that by asking the flow");

  expect(
    migration.includes("postal_code_matched") && migration.includes("ip_country_matched"),
    "the payments table carries the two facts",
  );
  expect(
    migration.includes("where status = 'under_review'"),
    "and an index on the queue the review lands in",
  );
  expect(
    clientsMigration.includes("constraint clients_postal_code_check") &&
      clientsMigration.includes("postal_code ~ '^[A-Za-z0-9][A-Za-z0-9 -]{1,14}[A-Za-z0-9]$'"),
    "the client record's postal alphabet is the one this module compares",
  );

  if (failures.length > 0) {
    process.stdout.write(`portal billing gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `portal billing gate passed: ${String(checkCount)} checks, one rule for the two facts, reviews routed to ${PORTAL_BILLING_REVIEW_OWNER}, capture without a bank only when both match, no migration needed\n`,
  );
}

await main();
