// path: app/(client-portal)/portal-velocity-verify.ts
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { isAppError } from "../../lib/errors/app-error.ts";
import type { AppError } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import { configureNmiKeys, InMemoryNmiKeyStore } from "../../lib/payments/adapters/nmi-client.ts";
import type { NmiHttpTransport } from "../../lib/payments/adapters/nmi-payment.ts";
import {
  VELOCITY_AUDIT_ACTION,
  VELOCITY_CARD_FINGERPRINT_PATTERN,
  VELOCITY_CONSUME_FUNCTION,
  VELOCITY_DEFAULT_POLICY,
  type VelocityCounterSubject,
  type VelocityPolicy,
} from "../../lib/security/velocity.ts";
import { mintPortalToken, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import {
  portalPaymentRefusalIsFinal,
  portalPaymentRuleSentences,
  portalPaymentRuleTextOf,
} from "../../components/payments/portal-payment-refusal.ts";
import { portalRefusalOf } from "../../components/payments/portal-form-refusal.ts";
import { portalCardFingerprintOf } from "./portal-blacklist.ts";
import { createPortalCardBlockCheck } from "./portal-blacklist-processor.ts";
import { PORTAL_BLACKLIST_RULES } from "./portal-blacklist-fields.ts";
import {
  PORTAL_VELOCITY_AUDIT_ACTION,
  PORTAL_VELOCITY_AUDIT_ENTITY,
  PORTAL_VELOCITY_POLICY,
  PORTAL_VELOCITY_REFUSAL_FIELD,
  PORTAL_VELOCITY_RULES,
  PORTAL_VELOCITY_SUBJECTS,
  portalVelocityPolicyOf,
  portalVelocityRuleOf,
} from "./portal-velocity-fields.ts";
import {
  consumePortalPaymentVelocity,
  createPortalVelocityLookup,
  portalVelocityCardFingerprint,
} from "./portal-velocity.ts";
import { createPortalVelocityCheck } from "./portal-velocity-processor.ts";
import { chargePortalPayment, type PortalPaymentDependencies } from "./portal-payment.ts";
import { createPortalPaymentProcessor, type PortalPaymentRecorder } from "./portal-payment-processor.ts";

/**
 * The gate for STEP 188: card and IP velocity limits, enforced on the payment page.
 *
 * ## What this proves
 *
 * Section 18's sentence is one line - "card and IP velocity limits exist with defaults in config" - and a limit
 * is only real if it bites. So the gate drives the **real** counters of STEP 067 (its `consumeVelocity`, its
 * canonicalisation, STEP 067's own audit entry) and the **real** charge path of STEP 183-187, and checks:
 *
 *   - the **policy**: STEP 067's defaults, an operator's override accepted, and every invalid policy refused at
 *     the seam rather than on the first payment;
 *   - the **two hits**: one attempt counts the card and the address, in order, with the same fingerprint STEP
 *     187 matches the blacklist with;
 *   - the **breach**: which subject, how many hits against which limit, the wait, and the one `429` the page
 *     answers with - while the gateway is asked only for the attempts that were allowed;
 *   - the **failures**: a counter that cannot answer refuses the payment instead of passing it, and the two
 *     counters fail in the two ways they can;
 *   - the **chain**: STEP 067's single breach entry per window, and this page's own refusal entry.
 *
 * ## Why the counter is a fake and the rest is not
 *
 * `0093` is a PL/pgSQL function and this repository has no database in the gate. The fake implements exactly the
 * contract that function documents - one row, hits counted up, the limit frozen at the window's first hit, the
 * window aligned to the epoch of `p_now` - so what is checked is the page's use of the counter rather than a
 * description of it. The migration is read and asserted separately, so the argument names and the column shapes
 * cannot drift from the fake.
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

/** Run a call that must refuse, and check the code, the first rule and the wait. */
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

// ---------------------------------------------------------------------------------------------
// The counter: the contract of `0093`, in memory.
// ---------------------------------------------------------------------------------------------

interface CounterRow {
  hits: number;
  limit: number;
  windowSeconds: number;
  windowStartMs: number;
}

interface CounterCall {
  readonly subject: string;
  readonly cardFingerprint: unknown;
  readonly ipAddress: unknown;
  readonly limit: unknown;
  readonly windowSeconds: unknown;
  readonly now: unknown;
}

interface VelocityCounter {
  readonly rpc: {
    rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
  };
  readonly calls: CounterCall[];
  /** Which subject's call fails, as the database going away would. */
  failOn: VelocityCounterSubject["kind"] | null;
}

function counterOf(): VelocityCounter {
  const rows = new Map<string, CounterRow>();
  const calls: CounterCall[] = [];

  const counter: VelocityCounter = {
    calls,
    failOn: null,
    rpc: {
      async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
        expect(functionName === VELOCITY_CONSUME_FUNCTION, "the counter is called by `0093`'s own name");

        const subject = String(arguments_["p_subject"] ?? "");
        const limit = Number(arguments_["p_limit"]);
        const windowSeconds = Number(arguments_["p_window_seconds"]);
        const now = String(arguments_["p_now"] ?? "");
        const nowMs = Date.parse(now);

        calls.push({
          subject,
          cardFingerprint: arguments_["p_card_fingerprint"],
          ipAddress: arguments_["p_ip_address"],
          limit,
          windowSeconds,
          now,
        });

        if (counter.failOn === subject) {
          throw new Error("the database is away");
        }

        const key =
          subject === "card"
            ? `card:${String(arguments_["p_card_fingerprint"])}`
            : `ip:${String(arguments_["p_ip_address"])}`;
        const seconds = Math.floor(nowMs / 1_000);
        const windowStartMs = (seconds - (seconds % windowSeconds)) * 1_000;
        const existing = rows.get(key);
        const row: CounterRow =
          existing === undefined || existing.windowStartMs !== windowStartMs
            ? { hits: 0, limit, windowSeconds, windowStartMs }
            : existing;

        row.hits += 1;
        rows.set(key, row);

        return [
          {
            counter_hits: row.hits,
            counter_limit: row.limit,
            counter_window_start: new Date(row.windowStartMs).toISOString(),
            counter_window_seconds: row.windowSeconds,
            counter_exceeded: row.hits >= row.limit,
            counter_first_breach: row.hits === row.limit,
          },
        ];
      },
    },
  };

  return counter;
}

// ---------------------------------------------------------------------------------------------
// The payment page, over the real flow.
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
const payerAddress = "203.0.113.9";

function invoiceRow(): Row {
  return {
    id: invoiceId,
    company_id: companyId,
    client_id: clientId,
    number: "INV-0009",
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
  calls: number;
}

function transportOf(): RecordingTransport {
  const recorder: RecordingTransport = {
    calls: 0,
    transport: async () => {
      recorder.calls += 1;

      return {
        response: "1",
        response_code: "100",
        responsetext: "SUCCESS",
        transactionid: "9876543210",
        amount: "100.00",
      };
    },
  };

  return recorder;
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

        const record: Settled = { paymentId: randomUUID(), settled: null, transactionId: null, code: null };

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
  readonly recorder: Map<string, Settled>;
  readonly blacklistReads: string[];
}

interface PaymentGateOptions {
  readonly policy?: VelocityPolicy;
  readonly blacklistRows?: readonly Row[];
  readonly counter?: VelocityCounter;
  readonly now?: () => number;
}

function paymentGateOf(options: PaymentGateOptions = {}): PaymentGate {
  const invoices: Row[] = [invoiceRow()];
  const items: Row[] = [itemRow()];
  const blacklistRows: Row[] = [...(options.blacklistRows ?? [])];
  const blacklistReads: string[] = [];
  const counter = options.counter ?? counterOf();
  const audit = createInMemoryAuditTrail();
  const transport = transportOf();
  const recorder = recorderOf();
  const store = new InMemoryNmiKeyStore();

  const rest: RestClient = {
    async select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      if (table === "card_blacklist") {
        blacklistReads.push(query);

        const equals = filtersOf(query);

        return blacklistRows
          .filter((row) => matches(row, equals))
          .slice(0, 1)
          .map((row) => schema.parse({ ...row }));
      }

      const equals = filtersOf(query);
      const rows = table === "invoices" ? invoices : table === "invoice_items" ? items : [];

      return rows.filter((row) => matches(row, equals)).map((row) => schema.parse({ ...row }));
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

    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      return counter.rpc.rpc(functionName, arguments_);
    },
  };

  configureNmiKeys(
    { companyId, apiKey: tokenizationKey, secretKey: securityKey, environment: "sandbox" },
    { store, encryptionKey: encryptionKeyHex, occurredAtEpochMs: nowMs - 86_400_000 },
  );

  return {
    audit,
    transport,
    recorder: recorder.records,
    blacklistReads,
    dependencies: {
      rest,
      audit,
      tokenKeys: keys,
      processor: createPortalPaymentProcessor({
        recorder: recorder.recorder,
        keyStore: store,
        encryptionKeyHex,
        transport: transport.transport,
        // STEP 187's own check, so the ordering this gate asserts is the ordering the page has.
        blacklist: createPortalCardBlockCheck({ rest, audit, now: () => nowMs }),
        velocity: createPortalVelocityCheck({
          rest: counter.rpc,
          audit,
          ...(options.policy === undefined ? {} : { policy: options.policy }),
          now: options.now ?? ((): number => nowMs),
        }),
      }),
      tokenizationKeyFor: () => ({ apiKey: tokenizationKey, environment: "sandbox" }),
      referral: null,
      now: options.now ?? ((): number => nowMs),
    },
  };
}

function chargeOf(gate: PaymentGate, token = collectJsToken, address = payerAddress) {
  return chargePortalPayment(
    {
      token: tokenOf(),
      body: { collectjs_token: token, idempotency_key: randomUUID() },
      clientAddress: address,
      userAgent: "Mozilla/5.0 (gate)",
      actorCompanyId: null,
    },
    gate.dependencies,
  );
}

function breachesOf(audit: InMemoryAuditTrail): readonly Record<string, unknown>[] {
  return payloadsOf(audit, VELOCITY_AUDIT_ACTION);
}

function payloadsOf(audit: InMemoryAuditTrail, action: string): readonly Record<string, unknown>[] {
  return audit.entries
    .filter((entry) => entry.action === action)
    .map((entry) => (entry.payload ?? {}) as Record<string, unknown>);
}

async function main(): Promise<void> {
  // ---- the vocabulary: STEP 067's defaults, carried rather than reinvented
  expectEqual(PORTAL_VELOCITY_SUBJECTS.join(","), "card,ip", "section 18 names two subjects");
  expectEqual(PORTAL_VELOCITY_POLICY.card.limit, 5, "the default card limit is STEP 067's five");
  expectEqual(PORTAL_VELOCITY_POLICY.card.windowSeconds, 3_600, "in one hour");
  expectEqual(PORTAL_VELOCITY_POLICY.ip.limit, 20, "and the default address limit is twenty");
  expectEqual(PORTAL_VELOCITY_POLICY.ip.windowSeconds, 3_600, "in the same hour");
  expectEqual(
    PORTAL_VELOCITY_POLICY.card.limit,
    VELOCITY_DEFAULT_POLICY.card.limit,
    "the page states the platform's default rather than inventing one",
  );
  expect(
    new Set([PORTAL_VELOCITY_RULES.cardLimited, PORTAL_VELOCITY_RULES.addressLimited, PORTAL_VELOCITY_RULES.unavailable]).size === 3,
    "the three rules are distinct",
  );
  expectEqual(PORTAL_VELOCITY_RULES.cardLimited, "velocity_card_limited", "the card rule names the card");
  expectEqual(PORTAL_VELOCITY_RULES.addressLimited, "velocity_ip_limited", "the address rule names the address");
  expectEqual(PORTAL_VELOCITY_AUDIT_ENTITY, "payment", "a refused attempt is a payment attempt in the chain");
  expectEqual(PORTAL_VELOCITY_REFUSAL_FIELD, "payment", "and a form marks the payment, not a field");
  expectEqual(portalVelocityRuleOf("card"), PORTAL_VELOCITY_RULES.cardLimited, "a card breach refuses with the card rule");
  expectEqual(portalVelocityRuleOf("ip"), PORTAL_VELOCITY_RULES.addressLimited, "and an address breach with its own");

  // ---- the policy: an operator's value, and every invalid one refused at the seam
  expectEqual(portalVelocityPolicyOf(), PORTAL_VELOCITY_POLICY, "no policy means the platform's defaults");
  expectEqual(
    portalVelocityPolicyOf({ card: { limit: 3, windowSeconds: 600 }, ip: { limit: 9, windowSeconds: 600 } }).card.limit,
    3,
    "an operator's limit travels as the argument",
  );

  for (const [invalid, description] of [
    [{ card: { limit: 0, windowSeconds: 600 }, ip: { limit: 9, windowSeconds: 600 } }, "a limit of zero"],
    [{ card: { limit: 3, windowSeconds: 0 }, ip: { limit: 9, windowSeconds: 600 } }, "a window of zero"],
    [{ card: { limit: 3, windowSeconds: 2_592_001 }, ip: { limit: 9, windowSeconds: 600 } }, "a window past thirty days"],
    [{ card: { limit: 3, windowSeconds: 600 } }, "a policy with one subject"],
    [{ card: { limit: 3, windowSeconds: 600 }, ip: { limit: 9, windowSeconds: 600 }, extra: true }, "an unknown key"],
    [{ card: { limit: 1.5, windowSeconds: 600 }, ip: { limit: 9, windowSeconds: 600 } }, "a fractional limit"],
  ] as const) {
    let thrown: unknown;

    try {
      portalVelocityPolicyOf(invalid);
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown) && thrown.code === "INTERNAL_ERROR", `${description} is refused when the page is built`);
  }

  // ---- the fingerprint: the same card STEP 187 names, and no card number is ever hashed
  expectEqual(
    portalVelocityCardFingerprint(collectJsToken),
    portalCardFingerprintOf(collectJsToken),
    "the counter and the blacklist name one card by one hash",
  );
  expect(VELOCITY_CARD_FINGERPRINT_PATTERN.test(portalVelocityCardFingerprint(collectJsToken)), "in the fingerprint alphabet");

  let panRefused: unknown;

  try {
    portalVelocityCardFingerprint("4111111111111111");
  } catch (error) {
    panRefused = error;
  }

  expect(isAppError(panRefused), "a value shaped like a card number is refused by STEP 067 before it is hashed");

  // ---- the reading, as the page reports it
  const limits: VelocityPolicy = { card: { limit: 2, windowSeconds: 600 }, ip: { limit: 3, windowSeconds: 600 } };
  const counter = counterOf();
  const dependencies = { rest: counter.rpc, policy: limits, now: (): number => nowMs };

  const first = await consumePortalPaymentVelocity(
    { cardToken: collectJsToken, clientAddress: payerAddress },
    dependencies,
  );

  expectEqual(first.status, "within", "the first attempt is inside both limits");
  expectEqual(counter.calls.length, 2, "and is two hits: the card, then the address");
  expectEqual(counter.calls[0]?.subject, "card", "the card first");
  expectEqual(counter.calls[1]?.subject, "ip", "and the address second");
  expectEqual(counter.calls[0]?.cardFingerprint, portalCardFingerprintOf(collectJsToken), "the card hit is keyed on the fingerprint");
  expectEqual(counter.calls[1]?.ipAddress, payerAddress, "and the address hit on the address");
  expectEqual(counter.calls[0]?.limit, 2, "the operator's card limit is what the counter was given");
  expectEqual(counter.calls[1]?.limit, 3, "and the operator's address limit");
  expectEqual(counter.calls[0]?.windowSeconds, 600, "with the operator's window");
  expectEqual(counter.calls[0]?.now, new Date(nowMs).toISOString(), "and the instant the attempt happened");

  if (first.status === "within") {
    expectEqual(first.card.hits, 1, "the card's count is one");
    expectEqual(first.ip.hits, 1, "and the address's");
    expectEqual(first.card.limit, 2, "against the limit it was given");
  }

  const second = await consumePortalPaymentVelocity(
    { cardToken: collectJsToken, clientAddress: payerAddress },
    dependencies,
  );

  expectEqual(second.status, "limited", "the second attempt reaches the card limit of two");
  expectEqual(second.status === "limited" ? second.limited.subject : null, "card", "and names the card as the subject");

  if (second.status === "limited") {
    expectEqual(second.limited.hits, 2, "with the count that reached it");
    expectEqual(second.limited.limit, 2, "the limit it reached");
    expectEqual(second.limited.windowSeconds, 600, "the window it was counted in");
    expectEqual(second.limited.ip.hits, 2, "and the address counted too, under its own limit");
    expect(second.limited.retryAfterSeconds > 0, "and a wait the page can tell a payer about");
    expect(
      second.limited.retryAfterSeconds <= 600,
      "which is inside the window the limit applies to",
    );
  }

  // ---- the address limit is enforced when the card is not the subject
  {
    const addressCounter = counterOf();
    const addressLimits: VelocityPolicy = { card: { limit: 100, windowSeconds: 600 }, ip: { limit: 2, windowSeconds: 600 } };

    await consumePortalPaymentVelocity(
      { cardToken: "1111111111-token", clientAddress: payerAddress },
      { rest: addressCounter.rpc, policy: addressLimits, now: (): number => nowMs },
    );

    const blocked = await consumePortalPaymentVelocity(
      { cardToken: "2222222222-token", clientAddress: payerAddress },
      { rest: addressCounter.rpc, policy: addressLimits, now: (): number => nowMs },
    );

    expectEqual(blocked.status === "limited" ? blocked.limited.subject : null, "ip", "a second card from one address breaches the address limit");
    expectEqual(blocked.status === "limited" ? blocked.limited.card.hits : null, 1, "while that card's own count is one");
    expectEqual(blocked.status === "limited" ? blocked.limited.retryAfterSeconds : null, 600, "and the wait is the window that is still open");
  }

  // ---- both breached: the card is reported, and both counters travel
  {
    const bothCounter = counterOf();
    const tightPolicy: VelocityPolicy = { card: { limit: 1, windowSeconds: 600 }, ip: { limit: 1, windowSeconds: 600 } };

    await consumePortalPaymentVelocity(
      { cardToken: "1111111111-token", clientAddress: payerAddress },
      { rest: bothCounter.rpc, policy: tightPolicy, now: (): number => nowMs },
    );

    const both = await consumePortalPaymentVelocity(
      { cardToken: "1111111111-token", clientAddress: payerAddress },
      { rest: bothCounter.rpc, policy: tightPolicy, now: (): number => nowMs },
    );

    expectEqual(both.status === "limited" ? both.limited.subject : null, "card", "an attempt that breaches both reports the card, which is counted first");

    if (both.status === "limited") {
      expectEqual(both.limited.card.hits, 2, "and carries the card's count");
      expectEqual(both.limited.ip.hits, 2, "and the address's, so the chain shows the whole picture");
    }
  }

  // ---- a window rolls over, and the count starts again
  {
    const rollingCounter = counterOf();
    const rollingPolicy: VelocityPolicy = { card: { limit: 2, windowSeconds: 600 }, ip: { limit: 100, windowSeconds: 600 } };
    const later = Date.parse("2026-11-07T09:45:00.000Z");

    await consumePortalPaymentVelocity(
      { cardToken: "1111111111-token", clientAddress: payerAddress },
      { rest: rollingCounter.rpc, policy: rollingPolicy, now: (): number => nowMs },
    );

    const next = await consumePortalPaymentVelocity(
      { cardToken: "1111111111-token", clientAddress: payerAddress },
      { rest: rollingCounter.rpc, policy: rollingPolicy, now: (): number => later },
    );

    expectEqual(next.status, "within", "an attempt in the next window is not counted against the last one");
    expectEqual(next.status === "within" ? next.card.hits : null, 1, "the count started again, because the window is the database's");
  }

  // ---- the two failures, and the counter that is not spent on a payment that will be refused
  {
    const failingCard = counterOf();

    failingCard.failOn = "card";

    const reading = await consumePortalPaymentVelocity(
      { cardToken: "1111111111-token", clientAddress: payerAddress },
      { rest: failingCard.rpc, policy: limits, now: (): number => nowMs },
    );

    expectEqual(reading.status, "unavailable", "a card counter that cannot answer refuses the attempt");
    expectEqual(reading.status === "unavailable" ? reading.reason : null, "card_counter_failed", "naming which counter failed");
    expectEqual(failingCard.calls.length, 1, "and the address counter is not spent on an attempt that is refused");

    const failingAddress = counterOf();

    failingAddress.failOn = "ip";

    const secondReading = await consumePortalPaymentVelocity(
      { cardToken: "1111111111-token", clientAddress: payerAddress },
      { rest: failingAddress.rpc, policy: limits, now: (): number => nowMs },
    );

    expectEqual(secondReading.status === "unavailable" ? secondReading.reason : null, "address_counter_failed", "and the address counter has its own reason");
  }

  // ---- the chain: one entry per breach, STEP 067's own, and this page's refusal separately
  {
    const audit = createInMemoryAuditTrail();
    const breachCounter = counterOf();
    const breachPolicy: VelocityPolicy = { card: { limit: 1, windowSeconds: 600 }, ip: { limit: 100, windowSeconds: 600 } };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await consumePortalPaymentVelocity(
        { cardToken: "1111111111-token", clientAddress: payerAddress, userAgent: "Mozilla/5.0 (gate)" },
        { rest: breachCounter.rpc, policy: breachPolicy, audit, now: (): number => nowMs },
      );
    }

    const breaches = payloadsOf(audit, VELOCITY_AUDIT_ACTION);

    expectEqual(breaches.length, 1, "the hit that reached the limit is written once, and the hits after it are not");
    expectEqual(breaches[0]?.["subject"], "card", "naming the subject");
    expectEqual(breaches[0]?.["hits"], 1, "the count that reached it");
    expectEqual(breaches[0]?.["limit"], 1, "the limit");
    expectEqual(breaches[0]?.["card_fingerprint"], portalCardFingerprintOf("1111111111-token"), "and the fingerprint, which is not a card");
    expectEqual(audit.entries[0]?.ipAddress, payerAddress, "with the address the attempt came from");
  }

  {
    const brokenAudit = {
      async append(): Promise<void> {
        throw new Error("the chain is down");
      },
    };
    const auditCounter = counterOf();
    const auditPolicy: VelocityPolicy = { card: { limit: 1, windowSeconds: 600 }, ip: { limit: 100, windowSeconds: 600 } };

    await consumePortalPaymentVelocity(
      { cardToken: "1111111111-token", clientAddress: payerAddress },
      { rest: auditCounter.rpc, policy: auditPolicy, audit: brokenAudit, now: (): number => nowMs },
    );

    const reading = await consumePortalPaymentVelocity(
      { cardToken: "1111111111-token", clientAddress: payerAddress },
      { rest: auditCounter.rpc, policy: auditPolicy, audit: brokenAudit, now: (): number => nowMs },
    );

    expectEqual(reading.status, "limited", "a chain that cannot be written does not turn a breach into a pass");
  }

  // ---- STEP 066's reader, in the shape the fraud evaluation takes
  {
    const lookupCounter = counterOf();
    const lookup = createPortalVelocityLookup({ rest: lookupCounter.rpc, policy: limits });

    const cardReading = await lookup.readVelocity({ kind: "card", value: collectJsToken });

    expectEqual(cardReading.hits, 1, "the reader answers the hit it just counted");
    expectEqual(cardReading.limit, 2, "and the limit the counter applied");

    const addressReading = await lookup.readVelocity({ kind: "ip", value: payerAddress });

    expectEqual(addressReading.hits, 1, "and it answers for an address as well as a card");
    expectEqual(addressReading.limit, 3, "with that subject's limit");
    expectEqual(lookupCounter.calls.length, 2, "and every read is a hit, which is what a velocity limit counts");
  }

  // ---- the payment page: the limit bites, and the gateway is asked only for what was allowed
  {
    // STEP 067 refuses the hit that *reaches* the limit, so the platform's five-card default allows four
    // charged attempts in an hour and refuses the fifth. That is the row's own arithmetic, asserted here at
    // the number section 18 states rather than at a number this gate made up.
    const gate = paymentGateOf();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expectEqual((await chargeOf(gate)).status, "captured", `attempt ${String(attempt)} of the default five is charged`);
    }

    expectEqual(gate.transport.calls, 4, "the gateway was asked four times");

    const refused = await expectRefusal(
      () => chargeOf(gate),
      "RATE_LIMITED",
      PORTAL_VELOCITY_RULES.cardLimited,
      "the fifth attempt reaches the default card limit and is refused",
    );

    expect(refused?.retryAfterSeconds !== undefined, "with a wait the route answers as `retry-after`");
    expect(gate.transport.calls === 4, "and the gateway was not asked a fifth time");
    expectEqual(gate.recorder.size, 4, "no payment record exists for the attempt the platform turned away");

    const refusals = payloadsOf(gate.audit, PORTAL_VELOCITY_AUDIT_ACTION);

    expectEqual(refusals.length, 1, "the refusal is in the chain once");
    expectEqual(refusals[0]?.["rule"], "velocity_card_limited", "naming the limit it reached");
    expectEqual(refusals[0]?.["subject"], "card", "and the subject");
    expectEqual(refusals[0]?.["hits"], 5, "with the count");
    expectEqual(refusals[0]?.["limit"], 5, "and the limit");
    expectEqual(refusals[0]?.["window_seconds"], 3_600, "and the window");
    expectEqual(refusals[0]?.["card_fingerprint"], portalCardFingerprintOf(collectJsToken), "and the fingerprint, which is a hash");
    expect(
      typeof refusals[0]?.["retry_after_seconds"] === "number",
      "and the wait, so an operator can see how long the window had left",
    );
    expect(Object.hasOwn(refusals[0] ?? {}, "collectjs_token") === false, "and no token");
    expectEqual(breachesOf(gate.audit).length, 1, "and STEP 067 wrote its own breach once, not once per refusal");
  }

  {
    // An operator's policy is what is enforced: the same page, a limit of two, and the third attempt refused.
    const gate = paymentGateOf({ policy: { card: { limit: 3, windowSeconds: 600 }, ip: { limit: 100, windowSeconds: 3_600 } } });

    expectEqual((await chargeOf(gate)).status, "captured", "the first attempt is charged");
    expectEqual((await chargeOf(gate)).status, "captured", "and the second");

    await expectRefusal(
      () => chargeOf(gate),
      "RATE_LIMITED",
      PORTAL_VELOCITY_RULES.cardLimited,
      "the third attempt reaches the operator's limit of three",
    );

    expectEqual(gate.transport.calls, 2, "and the gateway was asked twice");
    expectEqual(payloadsOf(gate.audit, PORTAL_VELOCITY_AUDIT_ACTION)[0]?.["limit"], 3, "the chain shows the operator's limit, not the default");
    expectEqual(payloadsOf(gate.audit, PORTAL_VELOCITY_AUDIT_ACTION)[0]?.["window_seconds"], 600, "and the operator's window");
  }

  {
    const gate = paymentGateOf({ policy: { card: { limit: 100, windowSeconds: 3_600 }, ip: { limit: 2, windowSeconds: 3_600 } } });

    expectEqual((await chargeOf(gate)).status, "captured", "the first card from an address is charged");

    await expectRefusal(
      () => chargeOf(gate, "another-token-0002"),
      "RATE_LIMITED",
      PORTAL_VELOCITY_RULES.addressLimited,
      "a second card from the same address reaches the address limit",
    );

    expectEqual(gate.transport.calls, 1, "and the gateway was asked once");
    expectEqual(payloadsOf(gate.audit, PORTAL_VELOCITY_AUDIT_ACTION)[0]?.["subject"], "ip", "the chain names the address as the subject");
  }

  {
    const gate = paymentGateOf({ counter: Object.assign(counterOf(), { failOn: "card" as const }) });

    await expectRefusal(
      () => chargeOf(gate),
      "SERVICE_UNAVAILABLE",
      PORTAL_VELOCITY_RULES.unavailable,
      "counters that cannot answer refuse the attempt",
    );

    expectEqual(gate.transport.calls, 0, "the gateway is never asked");
    expectEqual(gate.recorder.size, 0, "and no payment record is opened");
  }

  // ---- the list is read first, and a card it refuses is refused by the list rather than by a counter
  {
    const gate = paymentGateOf({
      blacklistRows: [
        {
          id: randomUUID(),
          company_id: null,
          card_fingerprint: portalCardFingerprintOf(collectJsToken),
          fingerprint_source: "card_token",
          reason: "fraud",
          status: "active",
          blacklisted_at: "2026-10-01T00:00:00.000Z",
          released_at: null,
          released_by: null,
          release_note: null,
          expires_at: null,
          deleted_at: null,
          version: 1,
        },
      ],
    });

    await expectRefusal(
      () => chargeOf(gate),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.blocked,
      "a listed card is refused by the list",
    );


    expectEqual(gate.blacklistReads.length, 1, "the list was asked before anything else");
    expectEqual(gate.transport.calls, 0, "and the gateway was not asked");
    expectEqual(gate.recorder.size, 1, "the attempt STEP 187 records as failed is still one record");
    expectEqual(
      payloadsOf(gate.audit, VELOCITY_AUDIT_ACTION).length,
      0,
      "and the default policy counted one hit of five, so no breach was written",
    );
  }

  // ---- a within-limit attempt is untouched
  {
    const gate = paymentGateOf();
    const paid = await chargeOf(gate);

    expectEqual(paid.status, "captured", "an attempt inside both limits is charged as before");
    expectEqual(gate.transport.calls, 1, "through one gateway call");
    expectEqual(payloadsOf(gate.audit, PORTAL_VELOCITY_AUDIT_ACTION).length, 0, "with no velocity refusal in the chain");
  }

  // ---- the sentences, and the answer a form reads
  {
    const card = getMessage("portal.ruleVelocityCardLimited");
    const address = getMessage("portal.ruleVelocityAddressLimited");
    const unavailable = getMessage("portal.ruleVelocityUnavailable");

    expect(card.length > 0 && address.length > 0 && unavailable.length > 0, "all three have a sentence");
    expect(new Set([card, address, unavailable]).size === 3, "and they are three different sentences");
    expect(/[Nn]othing was charged/u.test(card), "the card's sentence says nothing was charged");
    expect(/[Nn]othing was charged/u.test(address), "and the address's");
    expect(
      [card, address, unavailable].every((sentence) => sentence.length <= 220),
      "each sentence fits a narrow card without becoming a wall of text",
    );
    expect(
      /velocity_|RATE_LIMITED|429/u.test(`${card} ${address} ${unavailable}`) === false,
      "and none of them prints a rule, a code or a status a payer cannot act on",
    );
    expect(portalPaymentRuleTextOf(PORTAL_VELOCITY_RULES.cardLimited) === card, "the vocabulary reaches the card form");
    expect(portalPaymentRuleSentences()[PORTAL_VELOCITY_RULES.addressLimited] === address, "and its table carries both");
    expect(portalPaymentRefusalIsFinal(PORTAL_VELOCITY_RULES.cardLimited) === false, "a limit does not end the page: it is a wait");
    expect(portalPaymentRefusalIsFinal(PORTAL_VELOCITY_RULES.addressLimited) === false, "neither does the address's");

    const envelope = JSON.stringify({
      error: { code: "RATE_LIMITED", details: [{ field: "payment", rule: PORTAL_VELOCITY_RULES.cardLimited }] },
    });
    const refusal = await portalRefusalOf(
      new Response(envelope, { status: 429 }),
      getMessage("portal.paymentFailed"),
      portalPaymentRuleSentences(),
    );

    expectEqual(refusal.status, 429, "the form reads a `429`");
    expectEqual(refusal.rule, PORTAL_VELOCITY_RULES.cardLimited, "and the rule the limit named");
    expectEqual(refusal.text, card, "so the payer reads the sentence for that limit");

    const plain = await portalRefusalOf(new Response("{}", { status: 429 }), getMessage("portal.paymentFailed"));

    expectEqual(plain.rule, null, "a rate limit with no rule still reads as one");
    expectEqual(plain.text, getMessage("portal.confirmationRateLimited"), "and keeps the sentence it always had");
  }

  // ---- the sources, and the migration that is deliberately not there
  const service = await readFile(new URL("./portal-velocity.ts", import.meta.url), "utf8");
  const fields = await readFile(new URL("./portal-velocity-fields.ts", import.meta.url), "utf8");
  const processor = await readFile(new URL("./portal-velocity-processor.ts", import.meta.url), "utf8");
  const paymentProcessor = await readFile(new URL("./portal-payment-processor.ts", import.meta.url), "utf8");
  const paymentService = await readFile(new URL("./portal-payment.ts", import.meta.url), "utf8");
  const runtime = await readFile(new URL("./portal-payment-runtime.ts", import.meta.url), "utf8");
  const counters = await readFile(new URL("../../migrations/0056_velocity_counters.sql", import.meta.url), "utf8");
  const consume = await readFile(new URL("../../migrations/0093_velocity_counter_consume.sql", import.meta.url), "utf8");

  expect(service.includes("consumeVelocity"), "the page calls STEP 067's counter rather than writing its own");
  expect(service.includes("insert") === false, "and never inserts a counter row");
  expect(service.includes("velocityAuditEntry"), "the breach entry is STEP 067's own");
  expect(processor.includes("portalVelocityPolicyOf"), "the policy is validated when the page is built");
  expect(runtime.includes("createPortalVelocityCheck"), "the runtime wires the counters");
  expect(fields.includes("PORTAL_VELOCITY_POLICY"), "the defaults are stated once");

  const velocityAt = paymentProcessor.indexOf("velocity.check(");
  const gatewayAt = paymentProcessor.indexOf("processNmiPayment(");
  const listAt = paymentProcessor.indexOf("blacklist.check(");

  expect(velocityAt > 0 && gatewayAt > 0 && velocityAt < gatewayAt, "the counters are asked before the gateway");
  expect(listAt > 0 && listAt < velocityAt, "after the list is read, and before any record or gateway call");
  expect(
    paymentService.includes('"RATE_LIMITED"'),
    "a breach is refused as a rate limit rather than as a declined card",
  );
  expect(
    /retry_permitted: true/u.test(paymentService) === false,
    "and the page still never promises a retry it does not make",
  );

  expect(
    counters.includes("constraint velocity_counters_subject_check check (\n    num_nonnulls(card_fingerprint, ip_address) = 1"),
    "`0056` stores one subject per counter",
  );
  expect(
    counters.includes("card_fingerprint ~ '^[0-9a-f]{64}$'"),
    "a card counter is keyed on the fingerprint",
  );
  expect(
    counters.includes("constraint velocity_counters_window_check check (\n    window_seconds between 1 and 2592000"),
    "with the window bounds this module validates against",
  );
  expect(
    counters.includes("constraint velocity_counters_limit_check check (limit_value >= 1)"),
    "and a limit that is at least one",
  );
  expect(
    counters.includes("constraint velocity_counters_platform_check check (company_id is null)"),
    "on the platform's own counters, not a merchant's",
  );
  expect(
    counters.includes("create unique index velocity_counters_card_key") &&
      counters.includes("create unique index velocity_counters_ip_key"),
    "one counter per card and one per address, per window",
  );
  expect(
    consume.includes("p_subject text") &&
      consume.includes("p_card_fingerprint text") &&
      consume.includes("p_ip_address inet") &&
      consume.includes("p_limit integer") &&
      consume.includes("p_window_seconds integer") &&
      consume.includes("p_now timestamptz"),
    "the function this module calls takes exactly the six arguments it sends",
  );
  expect(
    consume.includes("counter_hits integer") && consume.includes("counter_first_breach boolean"),
    "and answers the row the gate's fake answers",
  );

  const migrations = (await readdir(new URL("../../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name) && !name.endsWith(".down.sql"))
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .sort((left, right) => left - right);

  expectEqual(migrations[migrations.length - 1], 122, "`0056` and `0093` already hold the counters, so this STEP adds no migration");

  if (failures.length > 0) {
    process.stdout.write(`portal velocity gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `portal velocity gate passed: ${String(checkCount)} checks, ${PORTAL_VELOCITY_SUBJECTS.join("/")} limits at ${String(PORTAL_VELOCITY_POLICY.card.limit)} and ${String(PORTAL_VELOCITY_POLICY.ip.limit)} per hour by default, one attempt two hits, a breach refused as ${PORTAL_VELOCITY_RULES.cardLimited}/${PORTAL_VELOCITY_RULES.addressLimited} before the gateway, counters failing closed, no migration needed\n`,
  );
}

await main();
