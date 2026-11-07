// path: app/(client-portal)/portal-fraud-verify.ts
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { isAppError } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import { configureNmiKeys, InMemoryNmiKeyStore } from "../../lib/payments/adapters/nmi-client.ts";
import type { NmiHttpTransport } from "../../lib/payments/adapters/nmi-payment.ts";
import { NMI_RESPONSE_CODES } from "../../lib/payments/adapters/nmi-status-sync.ts";
import { FRAUD_FAILURE_CODE } from "../../lib/security/fraud.ts";
import { mintPortalToken, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { PORTAL_BILLING_REVIEW_OWNER } from "./portal-billing-match-fields.ts";
import { portalPaymentRefusalIsFinal } from "../../components/payments/portal-payment-refusal.ts";
import {
  PORTAL_FRAUD_AUDIT_ENTITY,
  PORTAL_FRAUD_CODE_MEANINGS,
  PORTAL_FRAUD_CODES,
  PORTAL_FRAUD_FAILURE_CODE,
  PORTAL_FRAUD_REJECTED_AUDIT_ACTION,
  PORTAL_FRAUD_REJECT_DECISION,
  PORTAL_FRAUD_REJECTED_STATUS,
  PORTAL_FRAUD_REVIEW_DECISION,
  PORTAL_FRAUD_REVIEW_OWNER,
  PORTAL_FRAUD_REVIEW_STATUS,
  PORTAL_FRAUD_RULES,
  PORTAL_FRAUD_SIGNAL_AUDIT_ACTION,
  PORTAL_FRAUD_SUSPICIOUS_AUDIT_ACTION,
  PORTAL_FRAUD_SUSPICIOUS_CODES,
  portalFraudDecisionOf,
  portalFraudPayloadOf,
  portalProviderFraudSignalOf,
} from "./portal-fraud-fields.ts";
import {
  handlePortalProviderSignal,
  recordPortalProviderSignal,
  referPortalCard,
  type PortalCardReferral,
  type PortalCardReferralQueue,
  type PortalCardReferred,
} from "./portal-fraud.ts";
import { createInMemoryCardReferralQueue } from "./portal-fraud-processor.ts";
import { chargePortalPayment, type PortalPaymentDependencies } from "./portal-payment.ts";
import { createPortalPaymentProcessor, type PortalPaymentRecorder } from "./portal-payment-processor.ts";

/**
 * The gate for STEP 186: a provider fraud signal rejects the payment at once.
 *
 * ## What this proves
 *
 * Section 18's last clause is a rule about money moving, and a rule is only real if the platform can be made to
 * answer it both ways. So this gate drives the *real* charge path - `chargePortalPayment` over the real
 * processor, the real adapter and a recording gateway - with the gateway's documented answers, and checks:
 *
 *   - the **vocabulary**: which documented codes are the signal, and which are merely suspicious, asserted
 *     against the adapter's own table so the two cannot drift;
 *   - the **decision**: every way a code can meet this page, including the ordinary declines that must *not*
 *     become fraud;
 *   - the **rejection**: nothing captured, the record settled `failed` with `risk_rejected`, the refusal the
 *     payer sees, and the chain entries an operator reads;
 *   - the **referral**: the card's token told to the list, and the honest `card_referral_unavailable` when the
 *     list cannot keep it - while the rejection stands either way;
 *   - and the **replay**: the same attempt sent again answers the same refusal without charging twice.
 *
 * ## Why the refusal is the assertion, not just the record
 *
 * A payment that is written as failed but answered as captured is a page that takes the money and lies about
 * it. The gate therefore checks the thrown refusal's code and rule, and the recorder's settled state, for the
 * same attempt.
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

/** Run a call that must refuse, and check the code and the first rule it refuses with. */
async function expectRefusal(
  run: () => Promise<unknown>,
  code: string,
  rule: string,
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
    expectEqual(error.details[0]?.rule ?? "", rule, `${description}: the rule it names`);
  }
}

// ---------------------------------------------------------------------------------------------
// The fixture: a PostgREST over arrays, as STEP 183 and STEP 185 built theirs.
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

function fixtureOf(): Fixture {
  const fixture: Fixture = { tables: new Map<string, Row[]>(), queries: [] };

  fixture.tables.set("invoices", [invoiceRow()]);
  fixture.tables.set("invoice_items", [itemRow()]);
  fixture.tables.set("payments", []);

  return fixture;
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

    async update(): Promise<void> {
      throw new Error("a portal payment page writes no table of its own");
    },

    async rpc(): Promise<unknown> {
      throw new Error("a portal payment page calls no function");
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
const collectJsToken = "1234567890abcdef-token";

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

/** The gateway's answer to a sale: an approval, or a decline carrying one documented code. */
function transportOf(responseCode: string): RecordingTransport {
  const calls: { readonly endpoint: string; readonly payload: Record<string, string> }[] = [];

  return {
    calls,
    transport: async (endpoint, payload) => {
      calls.push({ endpoint, payload });

      return {
        response: "2",
        response_code: responseCode,
        responsetext: NMI_RESPONSE_CODES[responseCode]?.description ?? "DECLINED",
      };
    },
  };
}

function approvalTransportOf(): RecordingTransport {
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

interface Settled {
  readonly paymentId: string;
  settled: string | null;
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
            settled: existing.settled as
              | "captured"
              | "declined"
              | "unknown"
              | "failed"
              | "under_review"
              | null,
            transactionId: existing.transactionId,
            code: existing.code,
          };
        }

        const record: Settled = {
          paymentId: randomUUID(),
          settled: null,
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

interface GateReferralQueue extends PortalCardReferralQueue {
  readonly referrals: PortalCardReferral[];
}

/** A list that keeps what it is told, so the referral path can be checked when one is durable. */
function referralQueueOf(durable = true): GateReferralQueue {
  const referrals: PortalCardReferral[] = [];

  return {
    durable,
    referrals,
    async refer(card: PortalCardReferral): Promise<PortalCardReferred> {
      referrals.push(card);

      return { status: "referred", referralId: randomUUID() };
    },
  };
}

interface Gate {
  readonly dependencies: PortalPaymentDependencies;
  readonly audit: InMemoryAuditTrail;
  readonly transport: RecordingTransport;
  readonly recorder: Map<string, Settled>;
}

function gateOf(options: {
  readonly code: string;
  readonly referral?: PortalCardReferralQueue | null;
  readonly audit?: InMemoryAuditTrail;
  readonly transport?: RecordingTransport;
} = { code: "100" }): Gate {
  const fixture = fixtureOf();
  const audit = options.audit ?? createInMemoryAuditTrail();
  const transport = options.transport ?? transportOf(options.code);
  const recorder = recorderOf();
  const store = new InMemoryNmiKeyStore();

  configureNmiKeys(
    { companyId, apiKey: tokenizationKey, secretKey: securityKey, environment: "sandbox" },
    { store, encryptionKey: encryptionKeyHex, occurredAtEpochMs: nowMs - 86_400_000 },
  );

  return {
    audit,
    transport,
    recorder: recorder.records,
    dependencies: {
      rest: createRest(fixture),
      audit,
      tokenKeys: keys,
      processor: createPortalPaymentProcessor({
        recorder: recorder.recorder,
        keyStore: store,
        encryptionKeyHex,
        transport: transport.transport,
      }),
      tokenizationKeyFor: () => ({ apiKey: tokenizationKey, environment: "sandbox" }),
      referral: options.referral ?? null,
      now: () => nowMs,
    },
  };
}

function chargeOf(gate: Gate, idempotencyKey = randomUUID()) {
  return chargePortalPayment(
    {
      token: tokenOf(),
      body: { collectjs_token: collectJsToken, idempotency_key: idempotencyKey },
      clientAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (gate)",
      actorCompanyId: null,
    },
    gate.dependencies,
  );
}

function actionsOf(audit: InMemoryAuditTrail): string[] {
  return audit.entries.map((entry) => entry.action);
}

function payloadsOf(audit: InMemoryAuditTrail, action: string): readonly Record<string, unknown>[] {
  return audit.entries
    .filter((entry) => entry.action === action)
    .map((entry) => (entry.payload ?? {}) as Record<string, unknown>);
}

async function main(): Promise<void> {
  // ---- the vocabulary: which documented codes are the signal
  expectEqual(PORTAL_FRAUD_CODES.length, 4, "the fraud signal is four documented codes");
  expectEqual(PORTAL_FRAUD_CODES.join(","), "250,251,252,253", "and they are the card-is-the-problem ones");
  expectEqual(
    PORTAL_FRAUD_SUSPICIOUS_CODES.join(","),
    "240,260,261,262",
    "the codes that ask the merchant to stop are suspicious, not fraud",
  );
  expectEqual(PORTAL_FRAUD_FAILURE_CODE, FRAUD_FAILURE_CODE, "the failure code is the platform's own risk code");
  expectEqual(PORTAL_FRAUD_FAILURE_CODE, "risk_rejected", "which is `risk_rejected`");
  expectEqual(PORTAL_FRAUD_REJECT_DECISION, "reject", "a rejection is the risk decision `reject`");
  expectEqual(PORTAL_FRAUD_REVIEW_DECISION, "review", "a hold is `review`");
  expectEqual(PORTAL_FRAUD_REJECTED_STATUS, "failed", "and `payments_risk_reject_check` allows it only on `failed`");
  expectEqual(PORTAL_FRAUD_REVIEW_STATUS, "under_review", "a hold is the status `0037` indexes");
  expectEqual(PORTAL_FRAUD_REVIEW_OWNER, PORTAL_BILLING_REVIEW_OWNER, "the desk is the one section 18 names");
  expectEqual(PORTAL_FRAUD_REVIEW_OWNER, "compliance_kyc", "which is compliance");
  expectEqual(PORTAL_FRAUD_AUDIT_ENTITY, "payment", "every one of these is about a payment");
  expectEqual(PORTAL_FRAUD_RULES.rejected, "risk_rejected", "the payer is refused with the risk rule");
  expectEqual(PORTAL_FRAUD_RULES.suspicious, "risk_suspicious", "or with the review rule");
  expectEqual(
    PORTAL_FRAUD_RULES.referralUnavailable,
    "card_referral_unavailable",
    "and a referral that cannot be kept says so",
  );
  expect(
    new Set([
      PORTAL_FRAUD_REJECTED_AUDIT_ACTION,
      PORTAL_FRAUD_SUSPICIOUS_AUDIT_ACTION,
      PORTAL_FRAUD_SIGNAL_AUDIT_ACTION,
    ]).size === 3,
    "the three chain actions are distinct",
  );

  // ---- the meanings travel with the codes, and agree with the adapter's table
  for (const code of PORTAL_FRAUD_CODES) {
    expectEqual(
      PORTAL_FRAUD_CODE_MEANINGS[code],
      NMI_RESPONSE_CODES[code]?.description,
      `code ${code} carries the gateway's own words`,
    );
    expect((PORTAL_FRAUD_CODE_MEANINGS[code] ?? "").length > 0, `code ${code} has a meaning`);
    expectEqual(NMI_RESPONSE_CODES[code]?.category, "declined", `code ${code} is a decline category`);
  }

  for (const code of PORTAL_FRAUD_SUSPICIOUS_CODES) {
    expect(NMI_RESPONSE_CODES[code] !== undefined, `code ${code} is documented`);
    expect(
      (PORTAL_FRAUD_CODES as readonly string[]).includes(code) === false,
      `and ${code} is not one of the four`,
    );
  }

  // ---- the signal: only those eight codes move a payment onto this path
  for (const code of PORTAL_FRAUD_CODES) {
    expectEqual(portalProviderFraudSignalOf({ responseCode: code }), "fraud", `${code} is the fraud signal`);
  }

  for (const code of PORTAL_FRAUD_SUSPICIOUS_CODES) {
    expectEqual(
      portalProviderFraudSignalOf({ responseCode: code }),
      "suspicious",
      `${code} is suspicious, not fraud`,
    );
  }

  for (const code of ["100", "200", "201", "202", "203", "204", "220", "300", "420", "421", "430"]) {
    expectEqual(
      portalProviderFraudSignalOf({ responseCode: code }),
      "clear",
      `${code} is an ordinary answer, not a fraud signal`,
    );
  }

  expectEqual(portalProviderFraudSignalOf({ responseCode: " 250 " }), "fraud", "a padded code is the same code");
  expectEqual(portalProviderFraudSignalOf({ responseCode: null }), "clear", "a missing code is not a signal");
  expectEqual(portalProviderFraudSignalOf({ responseCode: "" }), "clear", "nor is an empty one");
  expectEqual(portalProviderFraudSignalOf({ responseCode: "2501" }), "clear", "nor is a code that merely starts with one");

  // ---- the decision, and the payload it carries
  expectEqual(portalFraudDecisionOf("fraud"), "reject", "fraud rejects at once");
  expectEqual(portalFraudDecisionOf("suspicious"), "review", "suspicious is held for a person");
  expectEqual(portalFraudDecisionOf("clear"), null, "clear is not this step's business");

  const rejected = portalFraudPayloadOf({
    invoiceId,
    paymentId: "55555555-5555-4555-8555-555555555555",
    signal: "fraud",
    decision: "reject",
    responseCode: "253",
    amountMinor: "1000000",
  });

  expectEqual(rejected["status"], "failed", "a rejection is written as a failed payment");
  expectEqual(rejected["risk_decision"], "reject", "with the only risk decision `0037` allows there");
  expectEqual(rejected["failure_code"], "risk_rejected", "carrying the platform's risk code");
  expectEqual(rejected["provider_response_code"], "253", "and naming the gateway's code");
  expectEqual(rejected["provider_response_meaning"], "Fraudulent card.", "with the gateway's own words");
  expectEqual(rejected["amount_minor"], "1000000", "for the amount that was asked for");
  expectEqual(rejected["retry_permitted"], false, "and never a retry");
  expectEqual(rejected["review_owner"], null, "a rejection goes to no review desk");

  const reviewed = portalFraudPayloadOf({
    invoiceId,
    paymentId: null,
    signal: "suspicious",
    decision: "review",
    responseCode: "240",
    amountMinor: "1000000",
  });

  expectEqual(reviewed["status"], "under_review", "a hold is written as under review");
  expectEqual(reviewed["risk_decision"], "review", "with the review decision");
  expectEqual(reviewed["failure_code"], null, "and no failure code, because nothing failed");
  expectEqual(reviewed["review_owner"], "compliance_kyc", "routed to the desk section 18 names");
  expectEqual(reviewed["retry_permitted"], false, "a held payment is not retried either");

  for (const payload of [rejected, reviewed]) {
    expect(
      Object.keys(payload).every((key) => /card|pan|cvv|expiry|number/iu.test(key) === false),
      "no key of the payload names card data",
    );
  }

  // ---- the rejection through the real charge path, for each of the four codes
  for (const code of PORTAL_FRAUD_CODES) {
    const gate = gateOf({ code });

    await expectRefusal(
      () => chargeOf(gate),
      "VALIDATION_FAILED",
      PORTAL_FRAUD_RULES.rejected,
      `${code} rejects the payment at once`,
    );

    expectEqual(gate.transport.calls.length, 1, `${code}: the gateway was asked once, and not again`);
    expectEqual(gate.transport.calls[0]?.payload["type"], "sale", `${code}: as a sale`);
    expectEqual(gate.transport.calls[0]?.payload["amount"], "100.00", `${code}: for the invoice's amount`);

    const record = [...gate.recorder.values()][0];

    expectEqual(record?.settled, "failed", `${code}: the payment is written as failed, never captured`);
    expectEqual(record?.code, "risk_rejected", `${code}: with the risk code`);
    expectEqual(record?.transactionId, null, `${code}: and no transaction to settle`);
    expect(actionsOf(gate.audit).includes("portal.payment_captured") === false, `${code}: nothing says captured`);

    const signals = payloadsOf(gate.audit, PORTAL_FRAUD_SIGNAL_AUDIT_ACTION);

    expectEqual(signals.length, 1, `${code}: the signal is in the chain once`);
    expectEqual(signals[0]?.["provider_signal"], "fraud", `${code}: named as fraud`);
    expectEqual(signals[0]?.["provider_response_code"], code, `${code}: with the code the gateway gave`);
    expectEqual(signals[0]?.["risk_decision"], "reject", `${code}: and the decision taken`);

    const rejections = payloadsOf(gate.audit, PORTAL_FRAUD_REJECTED_AUDIT_ACTION);

    expectEqual(rejections.length, 1, `${code}: the rejection is in the chain once`);
    expectEqual(rejections[0]?.["rule"], "risk_rejected", `${code}: naming the rule the payer was refused with`);
    expectEqual(rejections[0]?.["retry_permitted"], false, `${code}: and that no retry is permitted`);
    expectEqual(rejections[0]?.["card_referred"], false, `${code}: the referral did not happen`);
    expectEqual(
      rejections[0]?.["referral_rule"],
      "card_referral_unavailable",
      `${code}: and the chain says why, because there is no list to write`,
    );
    expect(
      actionsOf(gate.audit).includes(PORTAL_FRAUD_SUSPICIOUS_AUDIT_ACTION) === false,
      `${code}: a fraud signal is not a review`,
    );
  }

  // ---- the suspicious codes: nothing captured, held for the desk, and no blacklist
  for (const code of PORTAL_FRAUD_SUSPICIOUS_CODES) {
    const referral = referralQueueOf();
    const gate = gateOf({ code, referral });

    await expectRefusal(
      () => chargeOf(gate),
      "CONFLICT",
      PORTAL_FRAUD_RULES.suspicious,
      `${code} holds the payment instead of taking it`,
    );

    expectEqual(gate.transport.calls.length, 1, `${code}: one charge attempt`);
    expectEqual([...gate.recorder.values()][0]?.settled, "under_review", `${code}: written as under review`);

    const reviews = payloadsOf(gate.audit, PORTAL_FRAUD_SUSPICIOUS_AUDIT_ACTION);

    expectEqual(reviews.length, 1, `${code}: the hold is in the chain once`);
    expectEqual(reviews[0]?.["provider_signal"], "suspicious", `${code}: named as suspicious`);
    expectEqual(reviews[0]?.["review_owner"], "compliance_kyc", `${code}: routed to compliance`);
    expectEqual(referral.referrals.length, 0, `${code}: and the card is not blacklisted for asking a question`);
    expect(
      actionsOf(gate.audit).includes(PORTAL_FRAUD_REJECTED_AUDIT_ACTION) === false,
      `${code}: a hold is not a rejection`,
    );
  }

  // ---- an ordinary decline is a decline, and never a fraud signal
  for (const code of ["200", "201", "220", "300"]) {
    const referral = referralQueueOf();
    const gate = gateOf({ code, referral });

    await expectRefusal(
      () => chargeOf(gate),
      "VALIDATION_FAILED",
      "card_declined",
      `${code} stays an ordinary decline`,
    );

    expectEqual([...gate.recorder.values()][0]?.settled, "declined", `${code}: written as a decline`);
    expectEqual(referral.referrals.length, 0, `${code}: and the card is not referred for a plain decline`);
    expect(
      actionsOf(gate.audit).includes(PORTAL_FRAUD_SIGNAL_AUDIT_ACTION) === false,
      `${code}: no provider signal is recorded`,
    );
    expect(
      actionsOf(gate.audit).includes(PORTAL_FRAUD_REJECTED_AUDIT_ACTION) === false,
      `${code}: and nothing says the payment was rejected for risk`,
    );
  }

  // ---- an approval still captures, with the fraud path wired and unused
  {
    const referral = referralQueueOf();
    const gate = gateOf({ code: "100", referral, transport: approvalTransportOf() });
    const paid = await chargeOf(gate);

    expectEqual(paid.status, "captured", "an approved sale is still captured");
    expectEqual([...gate.recorder.values()][0]?.settled, "captured", "and settled as captured");
    expectEqual(referral.referrals.length, 0, "with nothing referred");
    expect(
      actionsOf(gate.audit).includes(PORTAL_FRAUD_SIGNAL_AUDIT_ACTION) === false,
      "and no risk entry, because the gateway raised nothing",
    );
  }

  // ---- the referral itself: the token, the code, and the list that keeps it
  {
    const referral = referralQueueOf();
    const gate = gateOf({ code: "250", referral });

    await expectRefusal(
      () => chargeOf(gate),
      "VALIDATION_FAILED",
      PORTAL_FRAUD_RULES.rejected,
      "a flagged payment is still refused when a list can keep the card",
    );

    expectEqual(referral.referrals.length, 1, "the card token was referred once");

    const referred = referral.referrals[0];

    expectEqual(referred?.token, collectJsToken, "carrying the token, never a card");
    expectEqual(referred?.companyId, companyId, "for the business the invoice belongs to");
    expectEqual(referred?.invoiceId, invoiceId, "from the invoice that was being paid");
    expectEqual(referred?.providerSignal, "fraud", "with the signal that caused it");
    expectEqual(referred?.responseCode, "250", "and the gateway's code");
    expectEqual(referred?.occurredAtEpochMs, nowMs, "at the time the attempt was made");

    const rejections = payloadsOf(gate.audit, PORTAL_FRAUD_REJECTED_AUDIT_ACTION);

    expectEqual(rejections[0]?.["card_referred"], true, "and the chain says the referral happened");
    expectEqual(typeof rejections[0]?.["referral_id"], "string", "with the id the list answered");
    expect(
      Object.hasOwn(rejections[0] ?? {}, "referral_rule") === false,
      "and no unavailability rule, because it was available",
    );
  }

  // ---- a list that cannot keep what it is told is reported, and the rejection stands
  {
    const inMemory = createInMemoryCardReferralQueue();

    expectEqual(inMemory.durable, false, "the in-memory referral queue says it is not durable");

    const referred = await referPortalCard(
      {
        companyId,
        invoiceId,
        paymentId: null,
        token: collectJsToken,
        signal: "fraud",
        responseCode: "251",
        ipAddress: "203.0.113.9",
        userAgent: "Mozilla/5.0 (gate)",
      },
      { audit: createInMemoryAuditTrail(), referral: inMemory, now: () => nowMs },
    );

    expectEqual(referred.status, "refused", "so a referral through it is answered as refused");
    expectEqual(referred.status === "refused" ? referred.reason : null, "queue_not_durable", "and says why");

    const absent = await referPortalCard(
      {
        companyId,
        invoiceId,
        paymentId: null,
        token: collectJsToken,
        signal: "fraud",
        responseCode: "251",
        ipAddress: null,
        userAgent: null,
      },
      { audit: createInMemoryAuditTrail(), referral: null, now: () => nowMs },
    );

    expectEqual(
      absent.status === "refused" ? absent.reason : null,
      "queue_unavailable",
      "a page with no list at all says the list is unavailable",
    );
  }

  // ---- an audit sink that is down does not turn a refusal into a capture
  {
    const referral = referralQueueOf();
    let attempts = 0;
    const failing = {
      async append(): Promise<void> {
        attempts += 1;

        throw new Error("the chain is down");
      },
    };

    const handler = await handlePortalProviderSignal(
      {
        companyId,
        invoiceId,
        paymentId: null,
        token: collectJsToken,
        signal: "fraud",
        responseCode: "252",
        amountMinor: "1000000",
        ipAddress: "203.0.113.9",
        userAgent: "Mozilla/5.0 (gate)",
      },
      { audit: failing, referral, now: () => nowMs },
    );

    expectEqual(handler.decision, "reject", "a fraud signal is still rejected when the chain cannot be written");
    expectEqual(handler.referred?.status, "referred", "and the card is still referred");

    // The signal recorder is the same bargain, and is checked on its own because it runs first.
    await recordPortalProviderSignal(
      {
        companyId,
        invoiceId,
        paymentId: null,
        signal: "suspicious",
        responseCode: "260",
        amountMinor: "1000000",
        ipAddress: null,
        userAgent: null,
      },
      { audit: failing, referral: null, now: () => nowMs },
    );

    expectEqual(attempts, 3, "and both entries were attempted through the broken sink without throwing");
  }

  // ---- the replay: the same attempt answers the same refusal, and charges once
  {
    const idempotencyKey = randomUUID();
    const gate = gateOf({ code: "253" });

    await expectRefusal(
      () => chargeOf(gate, idempotencyKey),
      "VALIDATION_FAILED",
      PORTAL_FRAUD_RULES.rejected,
      "the first attempt is rejected",
    );

    const signalsAfterFirst = payloadsOf(gate.audit, PORTAL_FRAUD_SIGNAL_AUDIT_ACTION).length;
    const rejectionsAfterFirst = payloadsOf(gate.audit, PORTAL_FRAUD_REJECTED_AUDIT_ACTION).length;

    await expectRefusal(
      () => chargeOf(gate, idempotencyKey),
      "VALIDATION_FAILED",
      PORTAL_FRAUD_RULES.rejected,
      "the replay is rejected with the same rule",
    );

    expectEqual(gate.transport.calls.length, 1, "and the gateway was not asked a second time");
    expectEqual([...gate.recorder.values()][0]?.settled, "failed", "the record is still failed");
    expectEqual(
      payloadsOf(gate.audit, PORTAL_FRAUD_SIGNAL_AUDIT_ACTION).length,
      signalsAfterFirst,
      "the signal is not written twice for one flag",
    );
    expectEqual(
      payloadsOf(gate.audit, PORTAL_FRAUD_REJECTED_AUDIT_ACTION).length,
      rejectionsAfterFirst,
      "nor is the rejection",
    );
  }

  // ---- the sentences a payer reads
  {
    const rejectedText = getMessage("portal.ruleRiskRejected");
    const suspiciousText = getMessage("portal.ruleRiskSuspicious");

    expect(rejectedText.length > 0, "the rejection has a sentence");
    expect(rejectedText !== suspiciousText, "and it is not the sentence for a hold");
    expect(/no|not|nothing/iu.test(rejectedText), "the rejection says nothing was charged");
    expect(/review/iu.test(suspiciousText), "and the hold says the payment is under review");
    expect(
      /[0-9]{4}/u.test(rejectedText) === false,
      "neither sentence leaks a code a payer cannot act on",
    );
  }

  // ---- the sources, and the migration that is deliberately not there
  const fraudService = await readFile(new URL("./portal-fraud.ts", import.meta.url), "utf8");
  const fraudFields = await readFile(new URL("./portal-fraud-fields.ts", import.meta.url), "utf8");
  const fraudProcessor = await readFile(new URL("./portal-fraud-processor.ts", import.meta.url), "utf8");
  const paymentService = await readFile(new URL("./portal-payment.ts", import.meta.url), "utf8");
  const paymentProcessor = await readFile(new URL("./portal-payment-processor.ts", import.meta.url), "utf8");
  const runtime = await readFile(new URL("./portal-payment-runtime.ts", import.meta.url), "utf8");
  const refusal = await readFile(new URL("../../components/payments/portal-payment-refusal.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../../migrations/0037_payments.sql", import.meta.url), "utf8");

  const signalRead = paymentProcessor.indexOf("portalProviderFraudSignalOf");
  const declineWritten = paymentProcessor.indexOf('outcome: "declined"');

  expect(signalRead > 0, "the charge path reads the gateway's code through this step's own mapping");
  expect(
    declineWritten === -1 || signalRead < declineWritten,
    "before it writes the answer as an ordinary decline",
  );
  expect(
    paymentProcessor.includes("under_review"),
    "and a hold is settled as under review rather than as a decline",
  );
  expect(
    paymentService.includes("!outcome.replayed"),
    "a replayed answer is refused without writing its consequences twice",
  );
  // Restated by STEP 187: the page now writes `retry_permitted: false` when it refuses for risk, so the claim is
  // the one it always meant - no answer of this page ever permits a retry.
  expect(
    /retry_permitted: true/u.test(paymentService) === false,
    "the page never promises a retry it does not make",
  );
  // Restated by STEP 187: the runtime now wires the durable queue over the blacklist table, which is the list
  // this gate's referrals were always going to reach.
  expect(
    runtime.includes("createPortalCardBlacklistQueue"),
    "the runtime wires the referral queue this build has",
  );
  expect(
    fraudProcessor.includes("durable: false"),
    "and that queue says it is not durable",
  );
  expect(
    fraudFields.includes('referralUnavailable: "card_referral_unavailable"'),
    "the unavailability rule is named once, in the fields",
  );
  expect(
    fraudService.includes("PORTAL_FRAUD_RULES.referralUnavailable"),
    "and the refusal refers to it rather than spelling it again",
  );
  expect(
    fraudFields.includes('"250", "251", "252", "253"'),
    "the four codes are the documented four",
  );
  expect(
    refusal.includes("risk_rejected") && refusal.includes("risk_suspicious"),
    "both rules reach the payer as sentences",
  );
  expect(
    portalPaymentRefusalIsFinal(PORTAL_FRAUD_RULES.rejected),
    "and the refusal the page ends on is the same rule this vocabulary rejects with",
  );
  expect(
    portalPaymentRefusalIsFinal(PORTAL_FRAUD_RULES.suspicious) === false,
    "while a hold leaves the page able to be retried",
  );

  expect(
    "risk_decision <> 'reject' or status = 'failed'" ===
      (migration.match(/constraint payments_risk_reject_check check \(([^)]*)\)/u)?.[1] ?? ""),
    "`payments_risk_reject_check` already allows a rejection only on a failed payment",
  );
  expect(
    migration.includes("check (risk_decision in ('allow', 'review', 'reject'))"),
    "and `risk_decision` already carries the two decisions this step writes",
  );
  expect(
    migration.includes("'refunded', 'under_review'"),
    "and the status list already carries `under_review`",
  );
  expect(
    migration.includes("payments_under_review_idx") || migration.includes("where status = 'under_review'"),
    "with the index the review queue is read by",
  );
  expect(
    fraudFields.includes("STEP 187"),
    "the blacklist table is named as the next step's, not written here",
  );

  if (failures.length > 0) {
    process.stdout.write(`portal fraud gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `portal fraud gate passed: ${String(checkCount)} checks, ${PORTAL_FRAUD_CODES.join("/")} reject at once with ${PORTAL_FRAUD_FAILURE_CODE}, ${PORTAL_FRAUD_SUSPICIOUS_CODES.join("/")} held for ${PORTAL_FRAUD_REVIEW_OWNER}, referrals honest about the missing list, no migration needed\n`,
  );
}

await main();
