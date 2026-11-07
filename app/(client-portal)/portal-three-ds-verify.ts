// path: app/(client-portal)/portal-three-ds-verify.ts
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { openSecret, packSecretBox, sealSecret, unpackSecretBox } from "../../lib/auth/secrets.ts";
import { isAppError } from "../../lib/errors/app-error.ts";
import { mintPortalToken, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { threeDsVerified } from "../../lib/security/fraud.ts";
import {
  configureNmiKeys,
  InMemoryNmiKeyStore,
  type NmiKeyStore,
} from "../../lib/payments/adapters/nmi-client.ts";
import type { NmiHttpTransport } from "../../lib/payments/adapters/nmi-payment.ts";
import {
  PORTAL_PAYMENT_AUDIT_ENTITY,
  PORTAL_PAYMENT_CAPTURED_AUDIT_ACTION,
  PORTAL_PAYMENT_RULES,
} from "./portal-payment-fields.ts";
import type { PortalPaymentDependencies } from "./portal-payment.ts";
import {
  createPortalPaymentProcessor,
  type PortalPaymentRecorder,
  type PortalRecorderOpen,
} from "./portal-payment-processor.ts";
import {
  PORTAL_THREE_DS_AUDIT_ENTITY,
  PORTAL_THREE_DS_AUTHENTICATED_AUDIT_ACTION,
  PORTAL_THREE_DS_CHALLENGED_AUDIT_ACTION,
  PORTAL_THREE_DS_CHALLENGE_FIELDS,
  PORTAL_THREE_DS_CHALLENGE_MAXIMUM_LENGTH,
  PORTAL_THREE_DS_COMPLETE_PATH,
  PORTAL_THREE_DS_HANDLE_MAXIMUM_LENGTH,
  PORTAL_THREE_DS_MAXIMUM_BODY_BYTES,
  PORTAL_THREE_DS_NOT_COMPLETED_AUDIT_ACTION,
  PORTAL_THREE_DS_RATE_LIMIT,
  PORTAL_THREE_DS_REFUSED_AUDIT_ACTION,
  PORTAL_THREE_DS_RESULT_FIELDS,
  PORTAL_THREE_DS_RESULT_PATH,
  PORTAL_THREE_DS_RESULT_STATES,
  PORTAL_THREE_DS_REVIEW_AUDIT_ACTION,
  PORTAL_THREE_DS_REVIEW_OWNER,
  PORTAL_THREE_DS_RULES,
  PORTAL_THREE_DS_START_PATH,
  isPortalThreeDsResultState,
  portalThreeDsAcsUrlOf,
  portalThreeDsCaptureDecisionOf,
  portalThreeDsHandleContext,
  portalThreeDsOutcomeOf,
  portalThreeDsResultStateOf,
  portalThreeDsTermUrlOf,
} from "./portal-three-ds-fields.ts";
import {
  completePortalThreeDs,
  openPortalThreeDsHandle,
  parsePortalThreeDsResult,
  sealPortalThreeDsHandle,
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
import { createInMemoryPortalThreeDsRecorder, noPortalThreeDsPort } from "./portal-three-ds-processor.ts";

/**
 * The gate for STEP 184: the 3D Secure step in front of a card payment.
 *
 * ## What this proves without a gateway
 *
 * There is no issuer and no NMI sandbox in this sandbox, so the outside world is two fakes and a real cipher:
 *
 *   - The **fixture database** is a small PostgREST over arrays - STEP 181's, narrowed to what an invoice read
 *     touches - because the flow's first three checks are the invoice's.
 *   - The **recording port** answers the way an issuer's flow does: frictionless authentication, a challenge
 *     to carry the payer through, a refusal, an abandoned challenge, or nothing at all. Every answer is a fact
 *     about a bank, not about this module.
 *   - The **cipher is real**: `lib/auth/secrets.ts` with a thirty two byte master key, so a handle that was
 *     edited, moved to another challenge or sealed with another key actually fails to open rather than being
 *     described as failing.
 *
 * ## What it exercises
 *
 *   - the vocabulary: paths, the three challenge fields and the two result fields, the counters, the ceilings,
 *     the three mappings (provider answer to outcome, outcome to decision, rule to page state);
 *   - the redirect target: `https` only, no credentials, no fragment, no whitespace, no invented host;
 *   - the handle: sealed, unreadable, challenge-bound, tamper-evident, strict, and refused with one sentence;
 *   - section 18's capture rule: every outcome against every pair of billing facts, compared both with
 *     `threeDsVerified` and with `payments_three_ds_capture_check`'s own text;
 *   - starting: link, invoice, seller, body, amount, port, recorder, secrets, then the four answers, with the
 *     record written before the payer leaves and the audit written for each;
 *   - completing: the claimed-once record, the provider's four answers, the capture or the review, the charge
 *     through STEP 183's service, the settlement, and every way a return can be refused;
 *   - the sources: CSRF on the start, CSRF exactly when a session exists on the return, the 303, the rate
 *     counter, the body ceilings, the challenge form's three hidden fields and no card input anywhere;
 *   - the schema: `0037` already carries the 3DS outcome, the capture rule, the two billing facts and
 *     `under_review`, and this STEP adds no migration.
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
  rateLimitAnswer: Row | null;
}

function createFixture(): Fixture {
  return {
    tables: new Map<string, Row[]>(),
    queries: [],
    rateLimitAnswer: { allowed: true, remaining: 9, retry_after_seconds: 0, first_refusal: false },
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
      throw new Error("a portal 3DS step writes no table of its own");
    },

    async insertReturning<TRow>(): Promise<readonly TRow[]> {
      throw new Error("a portal 3DS step writes no table of its own");
    },

    async update(): Promise<void> {
      throw new Error("a portal 3DS step writes no table of its own");
    },

    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (functionName !== "consume_rate_limit") {
        throw new Error(`unexpected rpc ${functionName}`);
      }

      if (
        arguments_["p_scope"] !== "portal_3ds" ||
        typeof arguments_["p_key_hash"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(String(arguments_["p_key_hash"])) ||
        arguments_["p_limit"] !== 10 ||
        arguments_["p_window_seconds"] !== 600
      ) {
        throw new Error("the 3DS counter was called with the wrong policy");
      }

      return fixture.rateLimitAnswer === null ? [] : [fixture.rateLimitAnswer];
    },
  };
}

const companyId = "11111111-1111-4111-8111-111111111111";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const keys: PortalTokenKeys = { primary: Buffer.alloc(32, 7).toString("base64") };
const masterKey = Buffer.alloc(32, 9).toString("base64");
const otherMasterKey = Buffer.alloc(32, 11).toString("base64");
const nowMs = Date.parse("2026-11-07T09:30:00.000Z");
const nowSeconds = Math.floor(nowMs / 1_000);
const encryptionKeyHex = randomBytes(32).toString("hex");
const tokenizationKey = "public-tokenization-key-1234";
const securityKey = "private-security-key-1234";
const origin = "https://portal.kd-solutions.test";
const collectJsToken = "1234567890abcdef-token";

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

function tokenOf(company = companyId, capability = "pay"): string {
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

/** A payment recorder a gate can use: idempotent, and honest that its records live in this process. */
function paymentRecorderOf(durable = true): PortalPaymentRecorder {
  const records = new Map<string, { readonly paymentId: string; settled: string | null; transactionId: string | null }>();
  const byPayment = new Map<string, { readonly paymentId: string; settled: string | null; transactionId: string | null }>();

  return {
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

/** STEP 183's payment dependencies, which this flow charges through unchanged. */
function paymentDependenciesOf(options: {
  readonly fixture?: Fixture;
  readonly audit?: InMemoryAuditTrail;
  readonly transport?: RecordingTransport;
}): PortalPaymentDependencies {
  return {
    rest: createRest(options.fixture ?? fixtureOf(invoiceRow())),
    audit: options.audit ?? createInMemoryAuditTrail(),
    tokenKeys: keys,
    processor: createPortalPaymentProcessor({
      recorder: paymentRecorderOf(),
      keyStore: keyStoreOf(),
      encryptionKeyHex,
      ...(options.transport === undefined ? {} : { transport: options.transport.transport }),
    }),
    tokenizationKeyFor: () => ({ apiKey: tokenizationKey, environment: "sandbox" }),
    now: () => nowMs,
  };
}

// ---------------------------------------------------------------------------------------------
// The 3DS port, the challenge recorder and the cipher the gate uses.
// ---------------------------------------------------------------------------------------------

interface RecordingPort extends PortalThreeDsPort {
  readonly requests: PortalThreeDsRequest[];
  readonly completes: PortalThreeDsCompleteRequest[];
}

/** A port that answers what it was told to, and remembers what it was asked. */
function portOf(
  request: PortalThreeDsRequestAnswer,
  complete: PortalThreeDsCompleteAnswer = { status: "authenticated" },
  available = true,
): RecordingPort {
  const requests: PortalThreeDsRequest[] = [];
  const completes: PortalThreeDsCompleteRequest[] = [];

  return {
    available,
    requests,
    completes,
    async request(input): Promise<PortalThreeDsRequestAnswer> {
      requests.push(input);
      return request;
    },
    async complete(input): Promise<PortalThreeDsCompleteAnswer> {
      completes.push(input);
      return complete;
    },
  };
}

interface GateRecorder extends PortalThreeDsRecorder {
  readonly records: Map<string, PortalThreeDsRecord>;
  readonly settlements: PortalThreeDsSettlement[];
  readonly claimed: Set<string>;
}

/** A challenge recorder whose state the gate can read and edit, because the billing facts are STEP 185's. */
function challengeRecorderOf(durable = true): GateRecorder {
  const records = new Map<string, PortalThreeDsRecord>();
  const settlements: PortalThreeDsSettlement[] = [];
  const claimed = new Set<string>();

  return {
    durable,
    records,
    settlements,
    claimed,
    open(record: PortalThreeDsRecord): { readonly status: "opened" } | { readonly status: "refused"; readonly reason: string } {
      records.set(record.challengeId, record);
      return { status: "opened" };
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
    settle(input: PortalThreeDsSettlement): void {
      settlements.push(input);
    },
  };
}

/** The real cipher, keyed by a test master key: a handle that was edited actually fails to open. */
function secretsOf(key = masterKey): PortalThreeDsSecrets {
  return {
    seal: (plaintext, context) => packSecretBox(sealSecret(key, plaintext, context)),
    open: (box, context) => {
      const unpacked = unpackSecretBox(box);

      if (unpacked === null) {
        throw new Error("not a box");
      }

      return openSecret(key, unpacked, context);
    },
  };
}

interface Flow {
  readonly dependencies: PortalThreeDsDependencies;
  readonly port: RecordingPort;
  readonly recorder: GateRecorder;
  readonly audit: InMemoryAuditTrail;
  readonly transport: RecordingTransport;
  readonly fixture: Fixture;
}

function flowOf(options: {
  readonly invoice?: Row;
  readonly request?: PortalThreeDsRequestAnswer;
  readonly complete?: PortalThreeDsCompleteAnswer;
  readonly portAvailable?: boolean;
  readonly recorderDurable?: boolean;
  readonly port?: PortalThreeDsPort;
  readonly recorder?: PortalThreeDsRecorder | null;
  readonly secrets?: PortalThreeDsSecrets | null;
  readonly transport?: Record<string, string> | "throw";
} = {}): Flow {
  const fixture = fixtureOf(options.invoice ?? invoiceRow());
  const audit = createInMemoryAuditTrail();
  const transport = transportOf(options.transport ?? approval);
  const port = portOf(
    options.request ?? {
      status: "challenge",
      providerChallengeId: "prov-challenge-0001",
      acsUrl: "https://acs.example-bank.test/challenge",
      paReq: "UEFSZXE+YmFzZTY0K2NoYWxsZW5nZQ==",
    },
    options.complete ?? { status: "authenticated" },
    options.portAvailable ?? true,
  );
  const recorder = challengeRecorderOf(options.recorderDurable ?? true);

  return {
    fixture,
    audit,
    transport,
    port,
    recorder,
    dependencies: {
      payment: paymentDependenciesOf({ fixture, audit, transport }),
      port: options.port ?? port,
      recorder: options.recorder === undefined ? recorder : options.recorder,
      secrets: options.secrets === undefined ? secretsOf() : options.secrets,
      now: () => nowMs,
    },
  };
}

function bodyOf(overrides: Row = {}): Row {
  return {
    collectjs_token: collectJsToken,
    idempotency_key: randomUUID(),
    ...overrides,
  };
}

function startInputOf(token: string, body: Row, actorCompanyId: string | null = null) {
  return {
    token,
    body,
    clientAddress: "203.0.113.9",
    userAgent: "Mozilla/5.0 (gate)",
    acceptLanguage: "en-GB",
    origin,
    actorCompanyId,
  } as const;
}

function completeInputOf(token: string, md: string, paRes = "Y2hhbGxlbmdlLXJlc3VsdA==") {
  return {
    token,
    body: { PaRes: paRes, MD: md },
    clientAddress: "203.0.113.9",
    userAgent: "Mozilla/5.0 (gate)",
    actorCompanyId: null,
  } as const;
}

/** Start a challenge and hand back what the browser would carry. */
async function challengeOf(flow: Flow, token = tokenOf()): Promise<{
  readonly md: string;
  readonly challengeId: string;
  readonly idempotencyKey: string;
}> {
  const body = bodyOf();
  const started = await startPortalThreeDs(startInputOf(token, body), flow.dependencies);

  if (started.status !== "challenge") {
    throw new Error("the fixture expected a challenge");
  }

  return {
    md: started.md,
    challengeId: started.md.slice(0, started.md.indexOf(".")),
    idempotencyKey: String(body["idempotency_key"]),
  };
}

async function main(): Promise<void> {
  // ---- the vocabulary: one place for every number the page, the routes and the record share
  expectEqual(PORTAL_THREE_DS_START_PATH, "/pay/3ds", "a challenge starts under the payment page");
  expectEqual(PORTAL_THREE_DS_COMPLETE_PATH, "/3ds/complete", "and returns to its own segment");
  expectEqual(PORTAL_THREE_DS_RESULT_PATH, "/3ds/result", "and lands on a page that says what happened");
  expectEqual(
    (PORTAL_THREE_DS_CHALLENGE_FIELDS as readonly string[]).join(","),
    "PaReq,MD,TermUrl",
    "the challenge form carries the issuer's request, this platform's handle and the return address",
  );
  expectEqual(
    (PORTAL_THREE_DS_RESULT_FIELDS as readonly string[]).join(","),
    "PaRes,MD",
    "and the issuer's answer is two fields, no more",
  );
  expectEqual(PORTAL_THREE_DS_RATE_LIMIT.scope, "portal_3ds", "the 3DS step has its own counter");
  expectEqual(PORTAL_THREE_DS_RATE_LIMIT.limit, 10, "ten attempts");
  expectEqual(PORTAL_THREE_DS_RATE_LIMIT.windowSeconds, 600, "per ten minutes");
  expectEqual(PORTAL_THREE_DS_MAXIMUM_BODY_BYTES, 16_384, "the return body is capped at sixteen kilobytes");
  expectEqual(PORTAL_THREE_DS_HANDLE_MAXIMUM_LENGTH, 2_048, "and a handle at two kilobytes");
  expectEqual(PORTAL_THREE_DS_CHALLENGE_MAXIMUM_LENGTH, 4_096, "and the issuer's request at four");
  expectEqual(PORTAL_THREE_DS_REVIEW_OWNER, "compliance_kyc", "an unverified payment belongs to compliance");
  expectEqual(PORTAL_THREE_DS_AUDIT_ENTITY, PORTAL_PAYMENT_AUDIT_ENTITY, "a 3DS attempt is about a payment");
  expect(
    (PORTAL_THREE_DS_RESULT_STATES as readonly string[]).includes("review"),
    "the result page has a word for a payment under review",
  );
  expect(
    isPortalThreeDsResultState("captured") && !isPortalThreeDsResultState("settled"),
    "and a closed vocabulary for the rest",
  );

  expectEqual(portalThreeDsOutcomeOf("authenticated"), "authenticated", "an authenticated card is one");
  expectEqual(portalThreeDsOutcomeOf("abandoned"), "attempted", "a challenge the payer left was attempted");
  expectEqual(portalThreeDsOutcomeOf("failed"), "not_completed", "and a refusal was not completed");
  expectEqual(portalThreeDsResultStateOf("three_ds_authentication_failed"), "declined", "a refusal reads as declined");
  expectEqual(portalThreeDsResultStateOf("three_ds_under_review"), "review", "a review reads as reviewed");
  expectEqual(portalThreeDsResultStateOf("outcome_unknown"), "unknown", "a lost answer reads as unknown");
  expectEqual(portalThreeDsResultStateOf("three_ds_challenge_expired"), "expired", "an expiry reads as expired");
  expectEqual(portalThreeDsResultStateOf("something_else"), "expired", "and an unknown rule gets the same page");

  const auditActions = [
    PORTAL_THREE_DS_CHALLENGED_AUDIT_ACTION,
    PORTAL_THREE_DS_AUTHENTICATED_AUDIT_ACTION,
    PORTAL_THREE_DS_NOT_COMPLETED_AUDIT_ACTION,
    PORTAL_THREE_DS_REVIEW_AUDIT_ACTION,
    PORTAL_THREE_DS_REFUSED_AUDIT_ACTION,
  ];

  expectEqual(new Set(auditActions).size, 5, "the five 3DS audit actions are distinct");
  expect(
    auditActions.every((action) => action.startsWith("portal.three_ds_")),
    "and all of them are named for the step",
  );

  // ---- the redirect target: a value from outside, reflected into a form action
  expectEqual(
    portalThreeDsAcsUrlOf("https://acs.bank.test/challenge"),
    "https://acs.bank.test/challenge",
    "an https challenge page is the one shape this page will send a payer to",
  );
  expectEqual(portalThreeDsAcsUrlOf("http://acs.bank.test/challenge"), null, "a plain http address is refused");
  expectEqual(portalThreeDsAcsUrlOf("javascript:alert(1)"), null, "and a script scheme");
  expectEqual(portalThreeDsAcsUrlOf("data:text/html,<form>"), null, "and a data url");
  expectEqual(portalThreeDsAcsUrlOf("https://user:pass@acs.bank.test/x"), null, "and a credentials bearing url");
  expectEqual(portalThreeDsAcsUrlOf("https://acs.bank.test/x#frag"), null, "and one with a fragment");
  expectEqual(portalThreeDsAcsUrlOf(" https://acs.bank.test/x"), null, "and one with a leading space");
  expectEqual(portalThreeDsAcsUrlOf("https://acs.bank.test/a b"), null, "and one with a space inside");
  expectEqual(portalThreeDsAcsUrlOf(""), null, "and an empty string");
  expectEqual(portalThreeDsAcsUrlOf(42), null, "and something that is not a string");
  expectEqual(
    portalThreeDsAcsUrlOf(`https://acs.bank.test/${"a".repeat(600)}`),
    null,
    "and an address longer than a url",
  );
  expectEqual(
    portalThreeDsTermUrlOf(origin, "kdpt1.payload.signature"),
    `${origin}/i/kdpt1.payload.signature/3ds/complete`,
    "the issuer returns the payer to this link's own completion",
  );

  // ---- the handle: sealed, challenge-bound, tamper-evident
  const secrets = secretsOf();
  const sealedHandle = sealPortalThreeDsHandle(
    {
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId,
      invoiceId,
      amountMinor: "1000000",
      issuedAtEpochMs: nowMs,
      expiresAtEpochMs: nowMs + 900_000,
    },
    secrets,
  );

  expect(sealedHandle.length < PORTAL_THREE_DS_HANDLE_MAXIMUM_LENGTH, "a handle fits well inside its ceiling");
  expect(
    sealedHandle.includes(invoiceId) === false,
    "and it does not carry the invoice id in the clear, because it is sealed",
  );
  expectEqual(
    sealedHandle.slice(0, 36),
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "the challenge id travels beside the box, so the context can be rebuilt",
  );

  const openedHandle = openPortalThreeDsHandle(sealedHandle, secrets);

  expectEqual(openedHandle.invoiceId, invoiceId, "the handle opens to the invoice it was minted for");
  expectEqual(openedHandle.amountMinor, "1000000", "and the amount it was minted for");
  expectEqual(openedHandle.challengeId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "and the challenge");

  expectSyncRefusal(
    () => openPortalThreeDsHandle(`${sealedHandle.slice(0, -2)}aa`, secrets),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.challengeInvalid,
    "a handle with an edited byte does not open",
  );
  expectSyncRefusal(
    () => openPortalThreeDsHandle(`bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb${sealedHandle.slice(36)}`, secrets),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.challengeInvalid,
    "nor does one moved to another challenge, because the context is part of the box",
  );
  expectSyncRefusal(
    () => openPortalThreeDsHandle(sealedHandle, secretsOf(otherMasterKey)),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.challengeInvalid,
    "nor one sealed with another key",
  );
  expectSyncRefusal(
    () => openPortalThreeDsHandle("not-a-handle", secrets),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.challengeInvalid,
    "nor something that was never a handle",
  );
  expect(
    openPortalThreeDsHandle(sealedHandle, secrets).challengeId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "and opening a handle twice answers the same claim",
  );

  const strictClaim = packSecretBox(
    sealSecret(
      masterKey,
      JSON.stringify({
        purpose: "portal-three-ds",
        version: 1,
        challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId,
        invoiceId,
        amountMinor: "1000000",
        issuedAtEpochMs: nowMs,
        expiresAtEpochMs: nowMs + 900_000,
        smuggled: true,
      }),
      portalThreeDsHandleContext("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ),
  );

  expectSyncRefusal(
    () => openPortalThreeDsHandle(`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.${strictClaim}`, secrets),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.challengeInvalid,
    "a claim with a field nobody reads is refused, not ignored",
  );

  // ---- the capture rule: every outcome against every pair of billing facts
  const flagPairs = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const;

  for (const outcome of ["authenticated", "attempted", "not_completed"] as const) {
    for (const [postalCodeMatched, ipCountryMatched] of flagPairs) {
      const decision = portalThreeDsCaptureDecisionOf({ outcome, postalCodeMatched, ipCountryMatched });
      const expected =
        threeDsVerified({ threeDsOutcome: outcome, postalCodeMatched, ipCountryMatched }) ? "capture" : "review";

      expectEqual(
        decision,
        expected,
        `an ${outcome} card with postal=${String(postalCodeMatched)} and country=${String(ipCountryMatched)} follows STEP 066's rule`,
      );
    }
  }

  expectEqual(
    portalThreeDsCaptureDecisionOf({ outcome: "authenticated", postalCodeMatched: false, ipCountryMatched: false }),
    "capture",
    "an authenticated payment is captured without any billing match",
  );
  expectEqual(
    portalThreeDsCaptureDecisionOf({ outcome: "not_completed", postalCodeMatched: false, ipCountryMatched: true }),
    "review",
    "an unauthenticated payment with one matching fact is reviewed",
  );

  // ---- the schema states the same rule, and this STEP adds nothing to it
  const paymentsMigration = await readFile(new URL("../../migrations/0037_payments.sql", import.meta.url), "utf8");

  expect(
    paymentsMigration.includes("payments_three_ds_capture_check") &&
      paymentsMigration.includes("three_ds_outcome = 'authenticated'") &&
      paymentsMigration.includes("(postal_code_matched and ip_country_matched)"),
    "the database states section 18's capture rule in the same words this module does",
  );
  expect(
    paymentsMigration.includes("three_ds_outcome in ('authenticated', 'attempted', 'not_completed', 'not_requested')"),
    "and the four outcomes the column accepts",
  );
  expect(
    paymentsMigration.includes("'under_review'"),
    "and a status for a payment that was not captured",
  );

  const migrations = await readdir(new URL("../../migrations/", import.meta.url));

  expect(
    migrations.every((file) => !file.startsWith("0123")),
    "this STEP adds no migration: the next free number is still unused",
  );

  // ---- the issuer's answer, parsed
  expectEqual(
    parsePortalThreeDsResult({ PaRes: "  Y2hhbGxlbmdl  ", MD: "handle" }).paRes,
    "Y2hhbGxlbmdl",
    "an issuer result is read trimmed",
  );
  expectSyncRefusal(
    () => parsePortalThreeDsResult({ PaRes: "x" }),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.resultInvalid,
    "a result missing the handle is refused",
  );
  expectSyncRefusal(
    () => parsePortalThreeDsResult({ PaRes: "x", MD: "y", extra: "z" }),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.resultInvalid,
    "a result carrying a third field is refused",
  );
  expectSyncRefusal(
    () => parsePortalThreeDsResult({ PaRes: "", MD: "y" }),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.resultInvalid,
    "an empty answer is refused",
  );
  expectSyncRefusal(
    () => parsePortalThreeDsResult({ PaRes: "a".repeat(PORTAL_THREE_DS_RESULT_FIELDS.length + 5_000), MD: "y" }),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.resultInvalid,
    "and one longer than the ceiling",
  );
  expectSyncRefusal(
    () => parsePortalThreeDsResult({ PaRes: "a\nb", MD: "y" }),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.resultInvalid,
    "and one with a control character in it",
  );
  expectSyncRefusal(
    () => parsePortalThreeDsResult(null),
    "VALIDATION_FAILED",
    PORTAL_THREE_DS_RULES.resultInvalid,
    "and a body that is not an object",
  );

  // ---- starting a challenge: the link, the invoice, the seller, the body, the amount, then the port
  {
    const flow = flowOf();
    const token = tokenOf();
    const body = bodyOf({ idempotency_key: "6f1c5c1e-6f6f-4f6f-8f6f-6f6f6f6f6f6f" });
    const started = await startPortalThreeDs(startInputOf(token, body), flow.dependencies);

    expectEqual(started.status, "challenge", "a challenge is what the issuer asked for");

    if (started.status === "challenge") {
      expectEqual(started.acsUrl, "https://acs.example-bank.test/challenge", "the issuer's page is passed through");
      expectEqual(started.paReq, "UEFSZXE+YmFzZTY0K2NoYWxsZW5nZQ==", "with the issuer's own request");
      expectEqual(
        started.termUrl,
        `${origin}/i/${token}/3ds/complete`,
        "and a return address that names this link",
      );
      expectEqual(started.amountText, "100.0000 USD", "the amount is the invoice's own remaining due");
      expectEqual(started.amountMinor, "1000000", "in the platform's own units");
      expectEqual(started.expiresAt, "2026-11-07T09:45:00.000Z", "and the handle lives fifteen minutes");
      expect(started.md.length > 36, "the handle is this platform's own sealed value");
    }

    expectEqual(flow.port.requests.length, 1, "the provider was asked once");
    expectEqual(flow.port.requests[0]?.token, collectJsToken, "with the token the browser was given");
    expectEqual(flow.port.requests[0]?.amountText, "100.00", "and the amount in the provider's own text");
    expectEqual(flow.port.requests[0]?.amountMinor, "1000000", "and in the platform's");
    expectEqual(flow.port.requests[0]?.companyId, companyId, "for the company that sent the invoice");
    expectEqual(flow.port.requests[0]?.browser.ipAddress, "203.0.113.9", "with the payer's address");
    expectEqual(flow.port.requests[0]?.browser.acceptLanguage, "en-GB", "and the browser's language");
    expectEqual(flow.transport.calls.length, 0, "and nothing was charged: authentication is not a payment");
    expectEqual(flow.recorder.records.size, 1, "one challenge record was opened before the payer left");

    const record = [...flow.recorder.records.values()][0];

    expectEqual(record?.token, collectJsToken, "which holds the token the charge will use");
    expectEqual(
      record?.idempotencyKey,
      "6f1c5c1e-6f6f-4f6f-8f6f-6f6f6f6f6f6f",
      "and the payer's own key, so the charge after the bank is the same payment",
    );
    expectEqual(record?.postalCodeMatched, false, "the billing facts default to false, because STEP 185 fills them");
    expectEqual(record?.ipCountryMatched, false, "and neither is guessed here");
    expectEqual(flow.audit.entries.length, 1, "one audit entry was written");
    expectEqual(flow.audit.entries[0]?.action, PORTAL_THREE_DS_CHALLENGED_AUDIT_ACTION, "under the challenge action");
    expectEqual(flow.audit.entries[0]?.entityType, PORTAL_THREE_DS_AUDIT_ENTITY, "about a payment");
    expect(
      JSON.stringify(flow.audit.entries[0]?.payload ?? {}).includes(collectJsToken) === false,
      "and the entry holds no token, only a hash of the payer's key",
    );
  }

  // ---- starting without the pieces a challenge needs
  {
    const flow = flowOf({ portAvailable: false });

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), flow.dependencies),
      "SERVICE_UNAVAILABLE",
      PORTAL_THREE_DS_RULES.unavailable,
      "a deployment with no authentication operation refuses, and says which one is missing",
    );
    expectEqual(flow.port.requests.length, 0, "and asks nothing");
    expectEqual(flow.recorder.records.size, 0, "and opens no challenge to abandon");
  }

  {
    const flow = flowOf({ recorderDurable: false });

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), flow.dependencies),
      "SERVICE_UNAVAILABLE",
      PORTAL_THREE_DS_RULES.recorderUnavailable,
      "a challenge a process cannot remember is not started",
    );
    expectEqual(flow.port.requests.length, 0, "so the issuer is never asked");
  }

  {
    const flow = flowOf({ recorder: null });

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), flow.dependencies),
      "SERVICE_UNAVAILABLE",
      PORTAL_THREE_DS_RULES.recorderUnavailable,
      "and no recorder at all is the same answer",
    );
  }

  {
    const flow = flowOf({ secrets: null });

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), flow.dependencies),
      "SERVICE_UNAVAILABLE",
      PORTAL_THREE_DS_RULES.unavailable,
      "without a cipher there is no handle, and no challenge either",
    );
  }

  {
    const flow = flowOf({ request: { status: "unavailable", reason: "provider_down" } });

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), flow.dependencies),
      "SERVICE_UNAVAILABLE",
      PORTAL_THREE_DS_RULES.unavailable,
      "a provider that cannot be reached refuses the payment",
    );
    expectEqual(flow.audit.entries[0]?.action, PORTAL_THREE_DS_REFUSED_AUDIT_ACTION, "and the refusal is audited");
    expectEqual(flow.transport.calls.length, 0, "with nothing charged");
  }

  {
    const flow = flowOf({ request: { status: "failed", code: "not_enrolled" } });

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), flow.dependencies),
      "VALIDATION_FAILED",
      PORTAL_THREE_DS_RULES.authenticationFailed,
      "an issuer that will not authenticate the card refuses it",
    );
    expectEqual(
      flow.audit.entries[0]?.action,
      PORTAL_THREE_DS_NOT_COMPLETED_AUDIT_ACTION,
      "and the fact is recorded as not completed",
    );
    expectEqual(flow.transport.calls.length, 0, "with nothing charged");
  }

  {
    // Frictionless: the issuer answered without the cardholder, so section 18's rule is already satisfied.
    const flow = flowOf({ request: { status: "authenticated" } });
    const started = await startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), flow.dependencies);

    expectEqual(started.status, "captured", "a frictionless authentication charges straight away");
    expectEqual(flow.transport.calls.length, 1, "one provider call");
    expectEqual(flow.transport.calls[0]?.payload["type"], "sale", "a sale");
    expectEqual(flow.transport.calls[0]?.payload["amount"], "100.00", "for the invoice's own amount");
    expectEqual(
      flow.audit.entries.map((entry) => entry.action).includes(PORTAL_THREE_DS_AUTHENTICATED_AUDIT_ACTION),
      true,
      "and the authentication is in the chain",
    );
    expectEqual(flow.recorder.records.size, 0, "no challenge record is opened for a payment that never left");
  }

  // ---- starting is refused by everything STEP 183 refuses, in the same words
  {
    const flow = flowOf();

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf(), companyId), flow.dependencies),
      "CONFLICT",
      PORTAL_PAYMENT_RULES.selfPayment,
      "a seller cannot authenticate their own invoice",
    );
    expectEqual(flow.port.requests.length, 0, "and the issuer is not asked");

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf({ card_number: "4111111111111111" })), flow.dependencies),
      "VALIDATION_FAILED",
      PORTAL_PAYMENT_RULES.cardDataRefused,
      "a body carrying a card number is refused by STEP 183's rule",
    );
    expectEqual(flow.port.requests.length, 0, "before anything is sent");

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf({ collectjs_token: "4111111111111111" })), flow.dependencies),
      "VALIDATION_FAILED",
      PORTAL_PAYMENT_RULES.cardDataRefused,
      "and a card number pasted into the token box is refused as card data, not forwarded as a token",
    );

    const settled = flowOf({ invoice: invoiceRow({ status: "paid", amount_paid_minor: "1000000", paid_at: "2026-11-05T00:00:00.000Z" }) });

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), settled.dependencies),
      "CONFLICT",
      PORTAL_PAYMENT_RULES.notPayable,
      "a settled invoice cannot start a challenge",
    );

    const cancelled = flowOf({
      invoice: invoiceRow({ status: "void", voided_at: "2026-11-06T00:00:00.000Z" }),
    });

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), cancelled.dependencies),
      "CONFLICT",
      PORTAL_PAYMENT_RULES.invoiceVoid,
      "nor can a cancelled one",
    );

    const withoutCapability = flowOf();

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(companyId, "view"), bodyOf()), withoutCapability.dependencies),
      "RESOURCE_NOT_FOUND",
      null,
      "a link without the pay capability is not a payment link",
    );

    const tooSmall = flowOf({
      invoice: invoiceRow({ subtotal_minor: "1", total_minor: "1", amount_paid_minor: "0" }),
    });

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), tooSmall.dependencies),
      "CONFLICT",
      PORTAL_PAYMENT_RULES.amountUnrepresentable,
      "and an amount the provider cannot write is refused before the issuer sees it",
    );

    const brokenAcs = flowOf({
      request: {
        status: "challenge",
        providerChallengeId: "prov-challenge-0001",
        acsUrl: "http://acs.example-bank.test/challenge",
        paReq: "UEZS",
      },
    });

    await expectRefusal(
      () => startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), brokenAcs.dependencies),
      "VALIDATION_FAILED",
      PORTAL_THREE_DS_RULES.resultInvalid,
      "an issuer address this page will not redirect to is refused",
    );
    expectEqual(brokenAcs.recorder.records.size, 0, "and no challenge is opened around it");
  }

  // ---- completing: the answer, the measured charge, and the settlement
  {
    const flow = flowOf();
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);
    const completed = await completePortalThreeDs(completeInputOf(token, challenge.md), flow.dependencies);

    expectEqual(completed.status, "captured", "an authenticated card is charged");
    expectEqual(flow.transport.calls.length, 1, "one provider call");
    expectEqual(flow.transport.calls[0]?.payload["payment_token"], collectJsToken, "with the token the challenge was started for");
    expectEqual(flow.transport.calls[0]?.payload["type"], "sale", "as a sale");

    if (completed.status === "captured") {
      expectEqual(completed.outcome, "authenticated", "the outcome is the issuer's own");
      expectEqual(completed.basis, "three_ds", "and the basis is the authentication");
      expectEqual(completed.payment.amountMinor, "1000000", "for the invoice's amount");
    }

    expectEqual(flow.recorder.settlements.length, 1, "the challenge was settled once");
    expectEqual(flow.recorder.settlements[0]?.status, "captured", "as captured");
    expectEqual(flow.recorder.settlements[0]?.decision, "capture", "with the capture decision recorded");
    expectEqual(flow.recorder.settlements[0]?.outcome, "authenticated", "and the outcome");
    expectEqual(typeof flow.recorder.settlements[0]?.paymentId === "string", true, "naming the payment");
    expectEqual(flow.recorder.settlements[0]?.transactionId, "9876543210", "and the provider's transaction");
    expectEqual(flow.port.completes.length, 1, "the issuer's result was handed back once");
    expectEqual(flow.port.completes[0]?.paRes, "Y2hhbGxlbmdlLXJlc3VsdA==", "with the payer's answer");
    expectEqual(flow.port.completes[0]?.challengeId, "prov-challenge-0001", "against the provider's own challenge id");

    const capturedEntry = flow.audit.entries.find((entry) => entry.action === PORTAL_THREE_DS_AUTHENTICATED_AUDIT_ACTION);

    expect(capturedEntry !== undefined, "the capture is in the chain");
    expectEqual(capturedEntry?.payload["basis"], "three_ds", "with the basis");
    expectEqual(capturedEntry?.payload["three_ds_outcome"], "authenticated", "and the outcome");
    expect(
      JSON.stringify(flow.audit.entries).includes(collectJsToken) === false,
      "no audit entry holds the token",
    );
    expect(
      flow.audit.entries.map((entry) => entry.action).includes(PORTAL_PAYMENT_CAPTURED_AUDIT_ACTION),
      "and STEP 183's own capture entry is written too, because the charge is its charge",
    );
  }

  // ---- a challenge the payer abandoned: nothing is taken, and compliance reads it
  {
    const flow = flowOf({ complete: { status: "abandoned" } });
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);
    const completed = await completePortalThreeDs(completeInputOf(token, challenge.md), flow.dependencies);

    expectEqual(completed.status, "review", "an abandoned challenge goes to review");

    if (completed.status === "review") {
      expectEqual(completed.outcome, "attempted", "as an attempt that was started and not finished");
      expectEqual(completed.reviewOwner, "compliance_kyc", "owned by the compliance desk");
      expectEqual(completed.amountText, "100.0000 USD", "for the invoice's own amount");
    }

    expectEqual(flow.transport.calls.length, 0, "and nothing is charged");
    expectEqual(flow.recorder.settlements[0]?.status, "under_review", "the record says under review");
    expectEqual(flow.recorder.settlements[0]?.paymentId, null, "there is no payment to name");
    expectEqual(flow.recorder.settlements[0]?.decision, "review", "and the decision is the review");

    const review = flow.audit.entries.find((entry) => entry.action === PORTAL_THREE_DS_REVIEW_AUDIT_ACTION);

    expect(review !== undefined, "the review is in the chain");
    expectEqual(review?.payload["review_owner"], "compliance_kyc", "naming the desk");
    expectEqual(review?.payload["captured"], false, "and stating that nothing was captured");
  }

  // ---- the billing-match basis: STEP 185's facts, when they arrive
  {
    const flow = flowOf({ complete: { status: "abandoned" } });
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);
    const record = flow.recorder.records.get(challenge.challengeId);

    if (record !== undefined) {
      flow.recorder.records.set(challenge.challengeId, {
        ...record,
        postalCodeMatched: true,
        ipCountryMatched: true,
      });
    }

    const completed = await completePortalThreeDs(completeInputOf(token, challenge.md), flow.dependencies);

    expectEqual(
      completed.status,
      "captured",
      "an unauthenticated payment is captured when the billing postal code and the payer's country both match",
    );
    expectEqual(flow.transport.calls.length, 1, "which is a charge");

    if (completed.status === "captured") {
      expectEqual(completed.basis, "billing_match", "recorded against the billing match rather than the bank");
      expectEqual(completed.outcome, "attempted", "with the outcome the issuer gave");
    }
  }

  // ---- every other answer at the return
  {
    const flow = flowOf({ complete: { status: "failed", code: "authentication_failed" } });
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, challenge.md), flow.dependencies),
      "VALIDATION_FAILED",
      PORTAL_THREE_DS_RULES.authenticationFailed,
      "a bank that refuses the cardholder refuses the payment",
    );
    expectEqual(flow.transport.calls.length, 0, "and nothing is charged");
    expectEqual(flow.recorder.settlements[0]?.status, "failed", "the record says failed");
  }

  {
    const flow = flowOf({ complete: { status: "unavailable", reason: "timeout" } });
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, challenge.md), flow.dependencies),
      "CONFLICT",
      PORTAL_PAYMENT_RULES.outcomeUnknown,
      "a lost answer is an unknown outcome, never a retry",
    );
    expectEqual(flow.transport.calls.length, 0, "and nothing is charged on a guess");
    expectEqual(flow.recorder.settlements[0]?.status, "unknown", "the record says the outcome is unknown");
  }

  {
    const flow = flowOf();
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);

    await completePortalThreeDs(completeInputOf(token, challenge.md), flow.dependencies);

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, challenge.md), flow.dependencies),
      "CONFLICT",
      PORTAL_THREE_DS_RULES.challengeReplayed,
      "a second arrival for the same challenge is a replay",
    );
    expectEqual(flow.transport.calls.length, 1, "and the provider is not asked twice");
  }

  {
    const flow = flowOf();
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);
    const later = nowMs + 900_001;
    const lateDependencies: PortalThreeDsDependencies = { ...flow.dependencies, now: () => later };

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, challenge.md), lateDependencies),
      "CONFLICT",
      PORTAL_THREE_DS_RULES.challengeExpired,
      "a handle outlives the window the issuer gives a cardholder",
    );
    expectEqual(flow.port.completes.length, 0, "so the provider is not asked");
  }

  {
    const flow = flowOf();
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);
    const record = flow.recorder.records.get(challenge.challengeId);

    if (record !== undefined) {
      flow.recorder.records.set(challenge.challengeId, { ...record, expiresAtEpochMs: nowMs - 1 });
    }

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, challenge.md), flow.dependencies),
      "CONFLICT",
      PORTAL_THREE_DS_RULES.challengeExpired,
      "and a challenge the platform itself expired is refused too",
    );
    expectEqual(flow.recorder.settlements[0]?.status, "failed", "with the record settled as failed");
  }

  {
    const flow = flowOf();
    const token = tokenOf();
    const otherInvoiceHandle = sealPortalThreeDsHandle(
      {
        challengeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        companyId,
        invoiceId: "99999999-9999-4999-8999-999999999999",
        amountMinor: "1000000",
        issuedAtEpochMs: nowMs,
        expiresAtEpochMs: nowMs + 900_000,
      },
      secretsOf(),
    );

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, otherInvoiceHandle), flow.dependencies),
      "VALIDATION_FAILED",
      PORTAL_THREE_DS_RULES.challengeInvalid,
      "a handle minted for another payment does not complete this one",
    );

    const unknownHandle = sealPortalThreeDsHandle(
      {
        challengeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        companyId,
        invoiceId,
        amountMinor: "1000000",
        issuedAtEpochMs: nowMs,
        expiresAtEpochMs: nowMs + 900_000,
      },
      secretsOf(),
    );

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, unknownHandle), flow.dependencies),
      "VALIDATION_FAILED",
      PORTAL_THREE_DS_RULES.challengeUnknown,
      "and a handle naming a challenge this platform does not hold is refused",
    );
  }

  {
    const flow = flowOf();
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);

    await expectRefusal(
      () => completePortalThreeDs({ ...completeInputOf(token, challenge.md), body: { PaRes: "x" } }, flow.dependencies),
      "VALIDATION_FAILED",
      PORTAL_THREE_DS_RULES.resultInvalid,
      "a return without the handle is refused before any lookup",
    );
  }

  {
    const flow = flowOf();
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);

    await expectRefusal(
      () => completePortalThreeDs({ ...completeInputOf(token, challenge.md), actorCompanyId: companyId }, flow.dependencies),
      "CONFLICT",
      PORTAL_PAYMENT_RULES.selfPayment,
      "the seller's own session cannot complete the payment",
    );
  }

  {
    const flow = flowOf();
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);
    const invoice = flow.fixture.tables.get("invoices")?.[0];

    if (invoice !== undefined) {
      invoice["amount_paid_minor"] = "250000";
    }

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, challenge.md), flow.dependencies),
      "CONFLICT",
      PORTAL_THREE_DS_RULES.staleDocument,
      "an invoice that moved while the payer was at their bank is not charged the old amount",
    );
  }

  {
    const flow = flowOf();
    const token = tokenOf();
    const challenge = await challengeOf(flow, token);
    const invoice = flow.fixture.tables.get("invoices")?.[0];

    if (invoice !== undefined) {
      invoice["status"] = "paid";
      invoice["amount_paid_minor"] = "1000000";
      invoice["paid_at"] = "2026-11-07T09:31:00.000Z";
    }

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, challenge.md), flow.dependencies),
      "CONFLICT",
      PORTAL_PAYMENT_RULES.notPayable,
      "and an invoice settled in the meantime cannot be charged again",
    );
  }

  {
    const flow = flowOf({ recorderDurable: false });
    const token = tokenOf();

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, "x.y"), flow.dependencies),
      "SERVICE_UNAVAILABLE",
      PORTAL_THREE_DS_RULES.recorderUnavailable,
      "a completion with no durable record to read is refused",
    );
  }

  {
    const flow = flowOf({ portAvailable: false });
    const token = tokenOf();

    await expectRefusal(
      () => completePortalThreeDs(completeInputOf(token, "x.y"), flow.dependencies),
      "SERVICE_UNAVAILABLE",
      PORTAL_THREE_DS_RULES.unavailable,
      "and one with no operation to complete against",
    );
  }

  // ---- the sources: what the routes and the surfaces must and must not say
  const startRoute = await readFile(new URL("./i/[token]/pay/3ds/route.ts", import.meta.url), "utf8");
  const completeRoute = await readFile(new URL("./i/[token]/pay/3ds/complete/route.ts", import.meta.url), "utf8");
  const resultPage = await readFile(new URL("./i/[token]/pay/3ds/result/page.tsx", import.meta.url), "utf8");
  const challengeForm = await readFile(new URL("../../components/payments/three-ds-challenge.tsx", import.meta.url), "utf8");
  const payPage = await readFile(new URL("./i/[token]/pay/page.tsx", import.meta.url), "utf8");
  const cardForm = await readFile(new URL("../../components/payments/card-payment-form.tsx", import.meta.url), "utf8");
  const refusalVocabulary = await readFile(new URL("../../components/payments/portal-three-ds-refusal.ts", import.meta.url), "utf8");

  expect(startRoute.includes("requireCsrfToken("), "starting a challenge requires the CSRF token");
  expect(
    startRoute.indexOf("requireCsrfToken(") < startRoute.indexOf("await request.text()"),
    "before the body is read",
  );
  expect(
    startRoute.indexOf("enforcePortalRateLimit(") < startRoute.indexOf("await request.text()"),
    "and the counter is spent before the body is read",
  );
  expectEqual(
    startRoute.split("PORTAL_THREE_DS_MAXIMUM_BODY_BYTES").length - 1 >= 2,
    true,
    "the byte ceiling is applied to the declared length and to the body",
  );
  expect(startRoute.includes("readRequestActorOptionally"), "the start resolves an actor when there is one");
  expect(startRoute.includes("PORTAL_THREE_DS_RATE_LIMIT"), "and spends the 3DS counter");
  expect(
    ["cardnumber", "card_number", "cvv", "cvc"].every((key) => startRoute.includes(key) === false),
    "and the route names no card field at all",
  );
  expect(
    ["acsUrl", "paReq", "md", "termUrl"].every((field) => startRoute.includes(field)),
    "the start hands the browser the issuer's page, its request, this platform's handle and the return address",
  );

  expect(completeRoute.includes("requireCsrfToken("), "the return requires the CSRF token when a session exists");
  expect(
    completeRoute.includes("readCsrfCookie(") && completeRoute.indexOf("readCsrfCookie(") < completeRoute.indexOf("requireCsrfToken("),
    "and only then, because a cardholder mid-challenge has no session to borrow",
  );
  expect(completeRoute.includes("PaRes") && completeRoute.includes("MD"), "it reads the issuer's two fields");
  expect(completeRoute.includes("collectjs_token") === false, "and nothing that looks like a token it was not given");
  expect(completeRoute.includes("NOWHERE" as string) === false, "no placeholder is left in the route");
  expect(completeRoute.includes("303"), "the return answers a redirect, not a body");
  expect(completeRoute.includes("PORTAL_THREE_DS_RESULT_PATH"), "and lands on the result page");
  expect(completeRoute.includes("readRequestActorOptionally"), "the return resolves an actor when there is one");

  expect(resultPage.includes("force-dynamic"), "the result page is not cached");
  expect(resultPage.includes("nocache: true"), "and asks not to be indexed or cached");
  expect(resultPage.includes("isPortalThreeDsResultState"), "it validates the state it is given");
  expectEqual(/<input[\s/>]/u.test(resultPage.replace(/\/\*[\s\S]*?\*\//gu, "")) === false, true, "and holds no input");

  expect(challengeForm.includes('type="hidden"'), "the challenge form posts hidden fields only");
  expect(
    (challengeForm.match(/<input/gu) ?? []).length === 3,
    "exactly three, one per field the protocol names",
  );
  expect(
    (PORTAL_THREE_DS_CHALLENGE_FIELDS as readonly string[]).every((field) => challengeForm.includes(`name="${field}"`)),
    "and they are named PaReq, MD and TermUrl",
  );
  expect(
    /type="(text|password|email|tel|number)"/u.test(challengeForm) === false,
    "there is no field a card could be typed into",
  );
  expect(challengeForm.includes("onChange") === false, "and no handler over one");
  expect(challengeForm.includes('method="post"'), "the challenge is posted, as the protocol requires");

  expect(payPage.includes("getPortalThreeDsRuntime"), "the payment page asks this step what it can do");
  expect(payPage.includes("/pay/3ds"), "and posts to the challenge when it can");
  expect(payPage.includes("threeDsReady"), "with the answer deciding which endpoint the form uses");
  expectEqual(/<input[\s/>]/u.test(payPage.replace(/\/\*[\s\S]*?\*\//gu, "")) === false, true, "and the page itself holds no input");

  expect(cardForm.includes('parsed.status === "challenge"'), "the card form understands a challenge answer");
  expect(cardForm.includes("ThreeDsChallenge"), "and hands the payer to the challenge form");
  expect(cardForm.includes("clearInputs"), "clearing the spent token first");
  expect(cardForm.includes('type="password"') === false, "while never rendering a masked field");
  expect(cardForm.includes("portalThreeDsRuleSentences"), "and words a 3DS refusal from this step's table");
  expect(cardForm.includes("console.") === false, "no surface logs anything");

  expect(refusalVocabulary.includes("three_ds_authentication_failed"), "the refusal table knows the bank's rules");
  expect(refusalVocabulary.includes("getMessage("), "and reads every sentence from the catalogue");

  const service = await readFile(new URL("./portal-three-ds.ts", import.meta.url), "utf8");
  const fields = await readFile(new URL("./portal-three-ds-fields.ts", import.meta.url), "utf8");

  expect(service.includes("chargePortalPayment("), "the flow charges through STEP 183's one charge path");
  expect(service.includes("parsePortalPaymentBody("), "and parses a payment body with STEP 183's parser");
  expect(fields.includes("threeDsVerified"), "the capture rule is STEP 066's, imported rather than restated");
  expect(fields.includes("cardnumber") === false, "and nothing here names a card field");
  expect(service.includes("console.") === false, "the service logs nothing");
  expect(service.includes("as unknown as") === false, "and never casts a value past its own type");

  // ---- the composition this build actually wires
  const inMemoryRecorder = createInMemoryPortalThreeDsRecorder();

  expectEqual(inMemoryRecorder.durable, false, "the in-memory challenge recorder says it is not durable");
  await expectRefusal(
    () =>
      startPortalThreeDs(startInputOf(tokenOf(), bodyOf()), {
        ...flowOf().dependencies,
        recorder: inMemoryRecorder,
      }),
    "SERVICE_UNAVAILABLE",
    PORTAL_THREE_DS_RULES.recorderUnavailable,
    "so a challenge cannot start on it",
  );
  expectEqual(noPortalThreeDsPort.available, false, "and this build's port says it has no operation");
  expectEqual(
    (await noPortalThreeDsPort.request({
      companyId,
      invoiceId,
      number: "INV-0007",
      amountText: "100.00",
      amountMinor: "1000000",
      token: collectJsToken,
      returnUrl: `${origin}/i/x/3ds/complete`,
      browser: { ipAddress: "203.0.113.9", userAgent: null, acceptLanguage: null },
    })).status,
    "unavailable",
    "answering honestly rather than pretending to be a bank",
  );

  // ---- and the result
  if (failures.length > 0) {
    process.stdout.write(`portal 3DS gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `portal 3DS gate passed: ${String(checkCount)} checks, ${String(PORTAL_THREE_DS_RESULT_STATES.length)} result states, one capture rule shared with the schema, no card data in any body, no migration needed\n`,
  );
}

// A failing check is a failed run, not an unhandled rejection: `main` sets the exit code and reports.
await main();
