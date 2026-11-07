// path: app/(client-portal)/portal-blacklist-verify.ts
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import { configureNmiKeys, InMemoryNmiKeyStore } from "../../lib/payments/adapters/nmi-client.ts";
import type { NmiHttpTransport } from "../../lib/payments/adapters/nmi-payment.ts";
import { FRAUD_CARD_FINGERPRINT_PATTERN } from "../../lib/security/fraud.ts";
import { mintPortalToken, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { portalPaymentRefusalIsFinal } from "../../components/payments/portal-payment-refusal.ts";
import {
  PORTAL_BLACKLIST_AUDIT_ENTITY,
  PORTAL_BLACKLIST_BLOCKED_AUDIT_ACTION,
  PORTAL_BLACKLIST_FINGERPRINT_PATTERN,
  PORTAL_BLACKLIST_NOTE_MAXIMUM_LENGTH,
  PORTAL_BLACKLIST_PAYMENT_ENTITY,
  PORTAL_BLACKLIST_REASONS,
  PORTAL_BLACKLIST_REFUSED_AUDIT_ACTION,
  PORTAL_BLACKLIST_RELEASED_AUDIT_ACTION,
  PORTAL_BLACKLIST_REQUESTED_AUDIT_ACTION,
  PORTAL_BLACKLIST_RULES,
  PORTAL_BLACKLIST_SETTLED_CODE,
  PORTAL_BLACKLIST_SOURCES,
  PORTAL_BLACKLIST_STATUSES,
  PORTAL_BLACKLIST_TABLE,
  PORTAL_BLACKLIST_UNAVAILABLE_AUDIT_ACTION,
  portalBlacklistBlockInputSchema,
  portalBlacklistReleaseInputSchema,
  portalBlacklistRowSchema,
} from "./portal-blacklist-fields.ts";
import {
  blockPortalCard,
  checkPortalCardBlacklist,
  createPortalCardBlockLookup,
  portalCardBlockInForce,
  portalCardFingerprintOf,
  portalCardFingerprintsOf,
  releasePortalCard,
  type PortalBlacklistDependencies,
} from "./portal-blacklist.ts";
import {
  createPortalCardBlacklistQueue,
  createPortalCardBlockCheck,
} from "./portal-blacklist-processor.ts";
import { PORTAL_FRAUD_RULES } from "./portal-fraud-fields.ts";
import { chargePortalPayment, type PortalPaymentDependencies } from "./portal-payment.ts";
import { createPortalPaymentProcessor, type PortalPaymentRecorder } from "./portal-payment-processor.ts";

/**
 * The gate for STEP 187: the card blacklist, checked by token and by provider fingerprint.
 *
 * ## What this proves
 *
 * Section 18's sentence is short - "card blacklist entries use card token or provider card fingerprint" - and it
 * says three things that can each be false in code:
 *
 *   - the **entry** holds a hash of one of exactly two identifiers, under the row shape `0055` already fixed;
 *   - the **check** asks the list about both identifiers in one query, and a card on it is refused *before* the
 *     gateway is asked, with nothing captured and a failed record carrying the list's own code;
 *   - a list that cannot be read **fails closed**, because "we could not check" and "we checked and it was fine"
 *     are opposite facts.
 *
 * The fourth thing this gate proves is the one that took the most thought: an entry names a person, because
 * `card_blacklist.blacklisted_by` references `public.users` and the table's trigger freezes it. So the referral
 * of STEP 186 writes a real block when an officer is named, and a chain entry proposing one when nobody is.
 *
 * ## The payment half is the real flow
 *
 * `chargePortalPayment` over the real processor, the real NMI adapter and a recording gateway - not a mock of
 * the page. The assertion that matters most is a call count of zero: a blocked card produces no request to the
 * provider at all.
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
// The fixture: a PostgREST over arrays, and the list itself.
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
  readonly queries: { readonly table: string; readonly query: string }[];
  readonly inserted: Row[];
  readonly updated: { readonly query: string; readonly values: Row }[];
  /** When true, every write fails the way a database that has gone away would. */
  failWrites: boolean;
}

function createFixture(): Fixture {
  return { tables: new Map<string, Row[]>(), queries: [], inserted: [], updated: [], failWrites: false };
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
      fixture.queries.push({ table, query });

      if (table === PORTAL_BLACKLIST_TABLE && !query.includes("company_id=is.null")) {
        throw new Error(`the platform list was read without naming the platform: ${query}`);
      }

      const { equals, limit } = filtersOf(query);
      const matched = rowsOf(table).filter((row) => matches(row, equals));

      return matched.slice(0, limit ?? matched.length).map((row) => schema.parse({ ...row }));
    },

    async insert(): Promise<void> {
      throw new Error("a block is inserted and read back");
    },

    async insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      if (fixture.failWrites) {
        throw new Error("the database is away");
      }

      const row = rows[0] ?? {};
      const fingerprint = String(row["card_fingerprint"] ?? "");
      const existing = rowsOf(table).find(
        (candidate) => candidate["card_fingerprint"] === fingerprint && candidate["status"] === "active",
      );

      if (existing !== undefined) {
        // What the unique partial index does: one active block per fingerprint, whatever the caller believed.
        throw new AppError("CONFLICT");
      }

      const stored: Row = {
        id: randomUUID(),
        status: "active",
        version: 1,
        released_at: null,
        released_by: null,
        release_note: null,
        deleted_at: null,
        company_id: null,
        ...row,
      };

      rowsOf(table).push(stored);
      fixture.inserted.push(stored);

      return [schema.parse({ ...stored })];
    },

    async update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      if (fixture.failWrites) {
        throw new Error("the database is away");
      }

      fixture.updated.push({ query, values: { ...values } });

      const { equals } = filtersOf(query);

      for (const row of rowsOf(table)) {
        if (!matches(row, equals)) {
          continue;
        }

        Object.assign(row, values);
        row["version"] = Number(row["version"] ?? 1) + 1;
      }
    },

    async rpc(): Promise<unknown> {
      throw new Error("the list calls no function");
    },
  };
}

/** A row of the list, in the shape `0055` stores after a person blocked a card. */
function blockRowOf(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    company_id: null,
    card_fingerprint: portalCardFingerprintOf("blocked-token-0001"),
    fingerprint_source: "card_token",
    reason: "fraud",
    status: "active",
    blacklisted_at: "2026-10-01T00:00:00.000Z",
    released_at: null,
    released_by: null,
    release_note: null,
    expires_at: null,
    deleted_at: null,
    version: 2,
    ...overrides,
  };
}

const companyId = "11111111-1111-4111-8111-111111111111";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const officerId = "66666666-6666-4666-8666-666666666666";
const secondOfficerId = "77777777-7777-4777-8777-777777777777";
const paymentId = "88888888-8888-4888-8888-888888888888";
const keys: PortalTokenKeys = { primary: Buffer.alloc(32, 7).toString("base64") };
const nowMs = Date.parse("2026-11-07T09:30:00.000Z");
const nowSeconds = Math.floor(nowMs / 1_000);
const encryptionKeyHex = randomBytes(32).toString("hex");
const tokenizationKey = "public-tokenization-key-1234";
const securityKey = "private-security-key-1234";
const collectJsToken = "1234567890abcdef-token";
const blockedToken = "blocked-token-0001";

const blockedFingerprint = portalCardFingerprintOf(blockedToken);

function invoiceRow(): Row {
  return {
    id: invoiceId,
    company_id: companyId,
    client_id: clientId,
    number: "INV-0008",
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

function transportOf(responseCode = "100"): RecordingTransport {
  const calls: { readonly endpoint: string; readonly payload: Record<string, string> }[] = [];

  return {
    calls,
    transport: async (endpoint, payload) => {
      calls.push({ endpoint, payload });

      return responseCode === "100"
        ? {
            response: "1",
            response_code: "100",
            responsetext: "SUCCESS",
            transactionid: "9876543210",
            amount: "100.00",
          }
        : { response: "2", response_code: responseCode, responsetext: "DECLINED" };
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

interface PaymentGate {
  readonly dependencies: PortalPaymentDependencies;
  readonly audit: InMemoryAuditTrail;
  readonly transport: RecordingTransport;
  readonly recorder: Map<string, Settled>;
  readonly fixture: Fixture;
}

interface PaymentGateOptions {
  readonly rows?: readonly Row[];
  readonly listFails?: boolean;
  readonly responseCode?: string;
  readonly referral?: PortalPaymentDependencies["referral"];
}

function paymentGateOf(options: PaymentGateOptions = {}): PaymentGate {
  const fixture = createFixture();

  fixture.tables.set("invoices", [invoiceRow()]);
  fixture.tables.set("invoice_items", [itemRow()]);

  if (options.rows !== undefined) {
    fixture.tables.set(PORTAL_BLACKLIST_TABLE, [...options.rows]);
  }

  const audit = createInMemoryAuditTrail();
  const transport = transportOf(options.responseCode ?? "100");
  const recorder = recorderOf();
  const store = new InMemoryNmiKeyStore();
  const rest = createRest(fixture);

  configureNmiKeys(
    { companyId, apiKey: tokenizationKey, secretKey: securityKey, environment: "sandbox" },
    { store, encryptionKey: encryptionKeyHex, occurredAtEpochMs: nowMs - 86_400_000 },
  );

  return {
    audit,
    transport,
    recorder: recorder.records,
    fixture,
    dependencies: {
      rest,
      audit,
      tokenKeys: keys,
      processor: createPortalPaymentProcessor({
        recorder: recorder.recorder,
        keyStore: store,
        encryptionKeyHex,
        transport: transport.transport,
        blacklist: options.listFails
          ? {
              async check() {
                return { status: "unavailable", reason: "read_failed" } as const;
              },
            }
          : createPortalCardBlockCheck({ rest, audit, now: () => nowMs }),
      }),
      tokenizationKeyFor: () => ({ apiKey: tokenizationKey, environment: "sandbox" }),
      referral: options.referral ?? null,
      now: () => nowMs,
    },
  };
}

function chargeOf(gate: PaymentGate, token = collectJsToken, idempotencyKey = randomUUID()) {
  return chargePortalPayment(
    {
      token: tokenOf(),
      body: { collectjs_token: token, idempotency_key: idempotencyKey },
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

/** The list, for the service-level checks: no payment page, just the table and the chain. */
function listGateOf(rows: readonly Row[] = []): { readonly deps: PortalBlacklistDependencies; readonly fixture: Fixture; readonly audit: InMemoryAuditTrail } {
  const fixture = createFixture();

  fixture.tables.set(PORTAL_BLACKLIST_TABLE, [...rows]);

  const audit = createInMemoryAuditTrail();

  return { fixture, audit, deps: { rest: createRest(fixture), audit, now: () => nowMs } };
}

function blockInputOf(overrides: Row = {}): Parameters<typeof blockPortalCard>[0] {
  return {
    fingerprint: portalCardFingerprintOf(blockedToken),
    source: "card_token",
    reason: "fraud",
    note: null,
    blacklistedBy: officerId,
    blacklistedAtEpochMs: nowMs - 60_000,
    expiresAtEpochMs: null,
    providerId: null,
    sourcePaymentId: paymentId,
    ...(overrides as object),
  } as Parameters<typeof blockPortalCard>[0];
}

async function main(): Promise<void> {
  // ---- the vocabulary, against the migration that already holds the list
  expectEqual(PORTAL_BLACKLIST_TABLE, "card_blacklist", "the list is the table STEP 030 created");
  expectEqual(PORTAL_BLACKLIST_SOURCES.join(","), "card_token,provider_fingerprint", "section 18 names exactly two identifiers");
  expectEqual(
    PORTAL_BLACKLIST_REASONS.join(","),
    "fraud,card_testing,chargeback,stolen_card,compliance,other",
    "the six reasons `0055` accepts",
  );
  expectEqual(PORTAL_BLACKLIST_STATUSES.join(","), "active,released", "a block is on the list or it is history");
  expectEqual(
    PORTAL_BLACKLIST_FINGERPRINT_PATTERN.source,
    FRAUD_CARD_FINGERPRINT_PATTERN.source,
    "the fingerprint alphabet is STEP 066's, not a second copy",
  );
  expectEqual(PORTAL_BLACKLIST_NOTE_MAXIMUM_LENGTH, 500, "a note is at most five hundred characters");
  expectEqual(PORTAL_BLACKLIST_SETTLED_CODE, "card_blacklisted", "the refused record carries the list's own code");
  expectEqual(PORTAL_BLACKLIST_PAYMENT_ENTITY, "payment", "a refused payment is a payment in the chain");
  expectEqual(PORTAL_BLACKLIST_AUDIT_ENTITY, "card_blacklist", "and a block is the list's own subject");
  expectEqual(PORTAL_BLACKLIST_RULES.blocked, "card_blacklisted", "the payer is refused with the list's rule");
  expectEqual(PORTAL_BLACKLIST_RULES.unavailable, "card_blacklist_unavailable", "and an unreadable list says so");
  expect(
    new Set([
      PORTAL_BLACKLIST_REFUSED_AUDIT_ACTION,
      PORTAL_BLACKLIST_UNAVAILABLE_AUDIT_ACTION,
      PORTAL_BLACKLIST_BLOCKED_AUDIT_ACTION,
      PORTAL_BLACKLIST_RELEASED_AUDIT_ACTION,
      PORTAL_BLACKLIST_REQUESTED_AUDIT_ACTION,
    ]).size === 5,
    "the five chain actions are distinct",
  );

  // ---- the fingerprint: one hash, two sources, and a known vector
  expectEqual(
    portalCardFingerprintOf("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "the fingerprint is the SHA-256 of what the adapter returned",
  );
  expect(PORTAL_BLACKLIST_FINGERPRINT_PATTERN.test(portalCardFingerprintOf("anything")), "and always in the column's alphabet");

  const tokenOnly = portalCardFingerprintsOf({ token: "  tok  " });

  expectEqual(tokenOnly.length, 1, "a token alone is one identifier");
  expectEqual(tokenOnly[0]?.source, "card_token", "named as the token");
  expectEqual(tokenOnly[0]?.fingerprint, portalCardFingerprintOf("tok"), "and trimmed before hashing");

  const both = portalCardFingerprintsOf({ token: collectJsToken, providerFingerprint: "provider-card-9f2" });

  expectEqual(both.length, 2, "both identifiers are asked about together");
  expectEqual(both[1]?.source, "provider_fingerprint", "the second named as the provider's");
  expect(both[0]?.fingerprint !== both[1]?.fingerprint, "and they are different hashes of different instruments");
  expectEqual(portalCardFingerprintsOf({ token: collectJsToken, providerFingerprint: "   " }).length, 1, "a blank fingerprint is no fingerprint");

  // ---- the row shape, read back from the fixture
  const parsedRow = portalBlacklistRowSchema.safeParse(blockRowOf());

  expect(parsedRow.success, "a block written by `0055` parses as a row");
  expectEqual(
    portalBlacklistRowSchema.safeParse(blockRowOf({ card_fingerprint: "ABC" })).success,
    false,
    "a fingerprint that is not sixty four lowercase hex characters is not a row",
  );
  expectEqual(
    portalBlacklistRowSchema.safeParse(blockRowOf({ fingerprint_source: "card_hash" })).success,
    false,
    "nor is a third source",
  );
  expectEqual(
    portalBlacklistRowSchema.safeParse(blockRowOf({ reason: "maybe" })).success,
    false,
    "nor is a reason outside the six",
  );

  // ---- the life of a block: a temporary one ends by itself
  const active = portalBlacklistRowSchema.parse(blockRowOf());
  const expired = portalBlacklistRowSchema.parse(blockRowOf({ expires_at: "2026-11-01T00:00:00.000Z" }));
  const future = portalBlacklistRowSchema.parse(blockRowOf({ expires_at: "2026-12-01T00:00:00.000Z" }));
  const released = portalBlacklistRowSchema.parse(blockRowOf({ status: "released" }));

  expectEqual(portalCardBlockInForce(active, nowMs), true, "a block with no expiry is in force");
  expectEqual(portalCardBlockInForce(future, nowMs), true, "and so is one that has not expired");
  expectEqual(portalCardBlockInForce(expired, nowMs), false, "a lapsed temporary block is not");
  expectEqual(portalCardBlockInForce(released, nowMs), false, "a released block is history");

  // ---- the check: one query, three answers
  {
    const gate = listGateOf();
    const { reading } = await checkPortalCardBlacklist({ token: collectJsToken, nowMs }, gate.deps);

    expectEqual(reading.status, "clear", "an empty list clears the card");
    expectEqual(gate.fixture.queries.length, 1, "in one query");

    const read = gate.fixture.queries[0]?.query ?? "";

    expect(read.includes("company_id=is.null"), "that names the platform's own rows");
    expect(read.includes("status=eq.active"), "asks only for blocks in force");
    expect(read.includes("deleted_at=is.null"), "skips a soft deleted row");
    expect(
      read.includes("select=id,card_fingerprint,fingerprint_source,reason,status,blacklisted_at,expires_at"),
      "and reads the six columns a decision needs",
    );
    expect(read.includes("select=*") === false, "and nothing else");
    expect(read.includes(`card_fingerprint=in.(${portalCardFingerprintOf(collectJsToken)})`), "asking about the token's hash");
  }

  {
    const gate = listGateOf([blockRowOf({ card_fingerprint: blockedFingerprint })]);
    const { reading, fingerprints } = await checkPortalCardBlacklist({ token: blockedToken, nowMs }, gate.deps);

    expectEqual(reading.status, "blocked", "a listed card is blocked");
    expectEqual(fingerprints[0], blockedFingerprint, "the fingerprint asked about is the token's hash");

    if (reading.status === "blocked") {
      expectEqual(reading.block.reason, "fraud", "with the reason the officer gave");
      expectEqual(reading.block.source, "card_token", "and which identifier the block was made from");
      expectEqual(reading.block.blacklistedAt, "2026-10-01T00:00:00.000Z", "and when it was made");
      expectEqual(reading.block.expiresAt, null, "and that it never expires");
      expectEqual(reading.block.fingerprint, blockedFingerprint, "and the fingerprint itself, so the chain can name it");
    }
  }

  {
    const gate = listGateOf([blockRowOf({ card_fingerprint: blockedFingerprint, expires_at: "2026-11-01T00:00:00.000Z" })]);
    const { reading } = await checkPortalCardBlacklist({ token: blockedToken, nowMs }, gate.deps);

    expectEqual(reading.status, "clear", "a temporary block that lapsed no longer refuses the card");
  }

  {
    const gate = listGateOf([blockRowOf({ card_fingerprint: blockedFingerprint })]);
    const { reading } = await checkPortalCardBlacklist({ token: blockedToken, providerFingerprint: "provider-card-9f2", nowMs }, gate.deps);

    expectEqual(reading.status, "blocked", "a card blocked by its token is blocked when both are offered");
    expectEqual(gate.fixture.queries.length, 1, "and both identifiers travel in one query");
    expect(
      (gate.fixture.queries[0]?.query ?? "").includes(
        `in.(${blockedFingerprint},${portalCardFingerprintOf("provider-card-9f2")})`,
      ),
      "the token's hash and the provider's together",
    );
  }

  {
    const gate = listGateOf([blockRowOf({ card_fingerprint: portalCardFingerprintOf("provider-card-9f2"), fingerprint_source: "provider_fingerprint" })]);
    const { reading } = await checkPortalCardBlacklist({ token: collectJsToken, providerFingerprint: "provider-card-9f2", nowMs }, gate.deps);

    expectEqual(reading.status, "blocked", "a block made from the provider's fingerprint matches the same card");

    if (reading.status === "blocked") {
      expectEqual(reading.block.source, "provider_fingerprint", "and says which identifier it came from");
    }
  }

  {
    const gate = listGateOf([blockRowOf({ card_fingerprint: blockedFingerprint, fingerprint_source: "card_hash" })]);
    const { reading } = await checkPortalCardBlacklist({ token: blockedToken, nowMs }, gate.deps);

    expectEqual(reading.status, "unavailable", "a row that is not the shape `0055` allows is not read as a block");
    expectEqual(reading.status === "unavailable" ? reading.reason : null, "read_failed", "and the read is reported as failed");
  }

  {
    const gate = listGateOf();
    const broken: PortalBlacklistDependencies = {
      rest: {
        ...createRest(gate.fixture),
        async select() {
          throw new Error("the database is away");
        },
      },
      audit: gate.audit,
    };
    const { reading } = await checkPortalCardBlacklist({ token: collectJsToken, nowMs }, broken);

    expectEqual(reading.status, "unavailable", "a list that cannot be read fails closed");
  }

  {
    const gate = listGateOf();
    const { reading } = await checkPortalCardBlacklist({ token: "", nowMs }, gate.deps);

    expectEqual(reading.status, "clear", "a caller with no token has nothing to ask about");
    expectEqual(gate.fixture.queries.length, 0, "and the list is not queried at all");
  }

  // ---- STEP 066's lookup, in the same shape the fraud evaluation takes
  {
    const empty = listGateOf();
    const lookup = createPortalCardBlockLookup(empty.deps);

    expectEqual(await lookup.isCardBlocked(blockedFingerprint), false, "the lookup answers false for a clear card");

    const listed = listGateOf([blockRowOf({ card_fingerprint: blockedFingerprint })]);

    expectEqual(
      await createPortalCardBlockLookup(listed.deps).isCardBlocked(blockedFingerprint),
      true,
      "and true for a blocked one",
    );

    const broken = createPortalCardBlockLookup({
      rest: {
        ...createRest(listGateOf().fixture),
        async select() {
          throw new Error("the database is away");
        },
      },
      audit: createInMemoryAuditTrail(),
    });

    let thrown: unknown;

    try {
      await broken.isCardBlocked(blockedFingerprint);
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown) && thrown.code === "DEPENDENCY_FAILED", "and throws rather than clearing a card it could not check");
  }

  // ---- the payment page: a listed card never reaches the gateway
  {
    const gate = paymentGateOf({ rows: [blockRowOf({ card_fingerprint: blockedFingerprint })] });

    await expectRefusal(
      () => chargeOf(gate, blockedToken),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.blocked,
      "a listed card refuses the payment",
    );

    expectEqual(gate.transport.calls.length, 0, "and nothing was sent to the gateway");
    expectEqual([...gate.recorder.values()][0]?.settled, "failed", "the record is written as failed, never captured");
    expectEqual([...gate.recorder.values()][0]?.code, PORTAL_BLACKLIST_SETTLED_CODE, "with the list's own code");
    expectEqual([...gate.recorder.values()][0]?.transactionId, null, "and no transaction");
    expect(actionsOf(gate.audit).includes("portal.payment_captured") === false, "nothing says captured");

    const refusals = payloadsOf(gate.audit, PORTAL_BLACKLIST_REFUSED_AUDIT_ACTION);

    expectEqual(refusals.length, 1, "the refusal is in the chain once");
    expectEqual(refusals[0]?.["rule"], "card_blacklisted", "naming the rule the payer was refused with");
    expectEqual(refusals[0]?.["card_fingerprint"], blockedFingerprint, "with the fingerprint, so the list can be asked later");
    expectEqual(refusals[0]?.["fingerprint_source"], "card_token", "and which identifier it was");
    expectEqual(refusals[0]?.["block_reason"], "fraud", "and the reason the block was made");
    expectEqual(refusals[0]?.["retry_permitted"], false, "and that no retry is permitted");
    expectEqual(refusals[0]?.["replayed"], false, "on a first attempt");
    expect(Object.keys(refusals[0] ?? {}).includes("collectjs_token") === false, "the token is not in the entry");

    // The same key again: the same refusal, and still no gateway call.
    const key = randomUUID();

    await expectRefusal(
      () => chargeOf(gate, blockedToken, key),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.blocked,
      "a first attempt with a stored key is refused",
    );

    await expectRefusal(
      () => chargeOf(gate, blockedToken, key),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.blocked,
      "and the replay of it is refused with the same rule",
    );

    expectEqual(gate.transport.calls.length, 0, "the gateway was never asked, on either attempt");
    expectEqual(
      payloadsOf(gate.audit, PORTAL_BLACKLIST_REFUSED_AUDIT_ACTION).some((payload) => payload["replayed"] === true),
      true,
      "and the replay says so in the chain",
    );
  }

  // ---- the list that cannot be read refuses the payment without charging
  {
    const gate = paymentGateOf({ listFails: true });

    await expectRefusal(
      () => chargeOf(gate),
      "SERVICE_UNAVAILABLE",
      PORTAL_BLACKLIST_RULES.unavailable,
      "an unreadable list refuses the payment rather than clearing the card",
    );

    expectEqual(gate.transport.calls.length, 0, "nothing was sent to the gateway");
    expectEqual(gate.recorder.size, 0, "and no payment record was opened, because nothing was attempted");
    expect(
      actionsOf(gate.audit).includes(PORTAL_BLACKLIST_UNAVAILABLE_AUDIT_ACTION),
      "the unreadable list is in the chain",
    );
  }

  // ---- a clear list leaves the page exactly as it was
  {
    const gate = paymentGateOf();
    const paid = await chargeOf(gate);

    expectEqual(paid.status, "captured", "a card the list knows nothing about is charged");
    expectEqual(gate.transport.calls.length, 1, "through one gateway call");
    expectEqual([...gate.recorder.values()][0]?.settled, "captured", "and recorded as captured");
    expect(gate.fixture.queries.some((queried) => queried.table === PORTAL_BLACKLIST_TABLE), "the list was asked");
    expect(
      actionsOf(gate.audit).includes(PORTAL_BLACKLIST_REFUSED_AUDIT_ACTION) === false,
      "and nothing says the card was blocked",
    );
  }

  // ---- STEP 186's referral, now that the list exists
  {
    const gate = listGateOf();
    const officer = createPortalCardBlacklistQueue({
      rest: createRest(gate.fixture),
      audit: gate.audit,
      actor: { userId: officerId },
      now: () => nowMs,
    });

    expectEqual(officer.durable, true, "a referral with an officer named survives the request");

    const referred = await officer.refer({
      companyId,
      invoiceId,
      paymentId,
      token: blockedToken,
      providerSignal: "fraud",
      responseCode: "250",
      occurredAtEpochMs: nowMs,
    });

    expectEqual(referred.status, "referred", "and it writes the block");

    const inserted = gate.fixture.inserted[0];

    expectEqual(inserted?.["card_fingerprint"], blockedFingerprint, "the row holds the token's hash");
    expectEqual(inserted?.["fingerprint_source"], "card_token", "named as a token block");
    expectEqual(inserted?.["reason"], "fraud", "with the reason the referral exists for");
    expectEqual(inserted?.["blacklisted_by"], officerId, "and the officer who is accountable for it");
    expectEqual(inserted?.["company_id"], null, "the platform's list, not a merchant's");
    expectEqual(inserted?.["source_payment_id"], paymentId, "pointing back at the payment that earned it");
    expectEqual(inserted?.["expires_at"], null, "a block with no expiry");
    expect(String(inserted?.["note"] ?? "").includes("250"), "and a note naming the gateway's code");

    const blocked = payloadsOf(gate.audit, PORTAL_BLACKLIST_BLOCKED_AUDIT_ACTION);

    expectEqual(blocked.length, 1, "the block is in the chain once");
    expectEqual(blocked[0]?.["card_fingerprint"], blockedFingerprint, "with the fingerprint");
    expectEqual(blocked[0]?.["blacklisted_by"], officerId, "and the person");
    expectEqual(actorOf(gate.audit, PORTAL_BLACKLIST_BLOCKED_AUDIT_ACTION), officerId, "written as that person's act");

    // A second referral for the same card is the same block, not a second one.
    const again = await officer.refer({
      companyId,
      invoiceId,
      paymentId,
      token: blockedToken,
      providerSignal: "fraud",
      responseCode: "251",
      occurredAtEpochMs: nowMs + 1_000,
    });

    expectEqual(again.status, "referred", "referring a listed card again answers the list it is on");
    expectEqual(gate.fixture.inserted.length, 1, "and writes no second row");
    expectEqual(
      again.status === "referred" ? again.referralId : "",
      String(gate.fixture.inserted[0]?.["id"] ?? ""),
      "with the block that already exists",
    );
  }

  {
    const gate = listGateOf();
    const proposal = createPortalCardBlacklistQueue({
      rest: createRest(gate.fixture),
      audit: gate.audit,
      actor: null,
      now: () => nowMs,
    });

    expectEqual(proposal.durable, false, "without an officer the referral cannot survive as a block");

    const referred = await proposal.refer({
      companyId,
      invoiceId,
      paymentId,
      token: blockedToken,
      providerSignal: "fraud",
      responseCode: "253",
      occurredAtEpochMs: nowMs,
    });

    expectEqual(referred.status, "refused", "so it answers refused");
    expectEqual(referred.status === "refused" ? referred.reason : null, "actor_required", "naming the person it needs");
    expectEqual(gate.fixture.inserted.length, 0, "and no row accuses the card");

    const requested = payloadsOf(gate.audit, PORTAL_BLACKLIST_REQUESTED_AUDIT_ACTION);

    expectEqual(requested.length, 1, "but the proposal is in the chain");
    expectEqual(requested[0]?.["card_fingerprint"], blockedFingerprint, "with the fingerprint a person can act on");
    expectEqual(requested[0]?.["outcome"], "proposed", "marked as a proposal");
    expectEqual(requested[0]?.["provider_response_code"], "253", "and the gateway's code");
  }

  {
    const gate = listGateOf();

    gate.fixture.failWrites = true;

    const referred = await createPortalCardBlacklistQueue({
      rest: createRest(gate.fixture),
      audit: gate.audit,
      actor: { userId: officerId },
      now: () => nowMs,
    }).refer({
      companyId,
      invoiceId,
      paymentId,
      token: blockedToken,
      providerSignal: "fraud",
      responseCode: "250",
      occurredAtEpochMs: nowMs,
    });

    expectEqual(referred.status === "refused" ? referred.reason : null, "write_failed", "a list that refuses the write says so");
    expect(
      payloadsOf(gate.audit, PORTAL_BLACKLIST_REQUESTED_AUDIT_ACTION).some((payload) => payload["outcome"] === "write_failed"),
      "and the failure is in the chain",
    );
  }

  // ---- the referral wired into the real charge path
  {
    const referralGate = listGateOf();
    const referral = createPortalCardBlacklistQueue({
      rest: createRest(referralGate.fixture),
      audit: referralGate.audit,
      actor: { userId: officerId },
      now: () => nowMs,
    });
    const gate = paymentGateOf({ responseCode: "250", referral });

    await expectRefusal(
      () => chargeOf(gate),
      "VALIDATION_FAILED",
      PORTAL_FRAUD_RULES.rejected,
      "a gateway fraud signal still rejects the payment",
    );

    expectEqual(referralGate.fixture.inserted.length, 1, "and the card is now on the list");
    expectEqual(
      referralGate.fixture.inserted[0]?.["card_fingerprint"],
      portalCardFingerprintOf(collectJsToken),
      "by the hash of the token the attempt used",
    );
    expect(
      actionsOf(referralGate.audit).includes(PORTAL_BLACKLIST_BLOCKED_AUDIT_ACTION),
      "with the block in the chain",
    );

    // The same card, a second time, is refused by the list before the gateway is asked again.
    const second = paymentGateOf({ rows: referralGate.fixture.tables.get(PORTAL_BLACKLIST_TABLE) ?? [] });
    const callsBefore = gate.transport.calls.length;

    await expectRefusal(
      () => chargeOf(second),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.blocked,
      "the next attempt is refused by the list itself",
    );

    expectEqual(second.transport.calls.length, 0, "without reaching the gateway");
    expectEqual(callsBefore, 1, "the first attempt was the only one that did");
  }

  // ---- a person blocks a card, and a person lifts it
  {
    const gate = listGateOf();
    const blockedBy = await blockPortalCard(blockInputOf(), gate.deps);

    expectEqual(blockedBy.status, "blocked", "an officer's block is written");
    expectEqual(gate.fixture.inserted.length, 1, "as one row");
    expectEqual(gate.fixture.inserted[0]?.["company_id"], null, "on the platform's list");
    expectEqual(gate.fixture.inserted[0]?.["blacklisted_by"], officerId, "under the officer's name");
    expectEqual(gate.fixture.inserted[0]?.["status"], "active", "and it is in force");
    expectEqual(gate.fixture.inserted[0]?.["blacklisted_at"], new Date(nowMs - 60_000).toISOString(), "at the instant it was made");

    const entries = payloadsOf(gate.audit, PORTAL_BLACKLIST_BLOCKED_AUDIT_ACTION);

    expectEqual(entries.length, 1, "the block is in the chain");
    expectEqual(entries[0]?.["reason"], "fraud", "with its reason");
    expectEqual(entries[0]?.["source_payment_id"], paymentId, "and the payment it came from");
    expectEqual(entries[0]?.["card_fingerprint"], blockedFingerprint, "and the fingerprint, which is what the chain records");
  }

  {
    const gate = listGateOf([blockRowOf({ card_fingerprint: blockedFingerprint })]);
    const blockedBy = await blockPortalCard(blockInputOf(), gate.deps);

    expectEqual(blockedBy.status, "already_blocked", "blocking a listed card answers the block that exists");
    expectEqual(gate.fixture.inserted.length, 0, "and writes no second row");
    expect(gate.audit.entries.length === 0, "and claims no new decision");

    if (blockedBy.status === "already_blocked") {
      expectEqual(blockedBy.block.reason, "fraud", "with the reason the first officer gave");
    }
  }

  {
    const gate = listGateOf();

    await expectRefusal(
      () => blockPortalCard(blockInputOf({ fingerprint: "ABC" }), gate.deps),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.invalidFingerprint,
      "a fingerprint that is not a hash is refused",
    );
    await expectRefusal(
      () => blockPortalCard(blockInputOf({ source: "card_hash" }), gate.deps),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.invalidSource,
      "a third identifier source is refused",
    );
    await expectRefusal(
      () => blockPortalCard(blockInputOf({ reason: "suspicion" }), gate.deps),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.invalidReason,
      "a reason outside the six is refused",
    );
    await expectRefusal(
      () => blockPortalCard(blockInputOf({ reason: "other", note: null }), gate.deps),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.noteRequired,
      "the reason `other` without a note is refused",
    );
    await expectRefusal(
      () => blockPortalCard(blockInputOf({ expiresAtEpochMs: nowMs - 120_000 }), gate.deps),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.invalidExpiry,
      "a block that expires before it starts is refused",
    );
    await expectRefusal(
      () => blockPortalCard(blockInputOf({ note: "   " }), gate.deps),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.noteRequired,
      "an untrimmed note is refused",
    );

    expectEqual(gate.fixture.inserted.length, 0, "and none of them wrote a row");
    expectEqual(
      portalBlacklistBlockInputSchema.safeParse({ ...blockInputOf(), extra: true }).success,
      false,
      "an unknown key is refused rather than ignored",
    );
  }

  {
    const row = blockRowOf({ card_fingerprint: blockedFingerprint, released_at: null, released_by: null, release_note: null, version: 2 });
    const gate = listGateOf([row]);
    const released = await releasePortalCard(
      {
        blockId: String(row["id"]),
        releasedBy: secondOfficerId,
        note: "Cardholder confirmed the charge was theirs.",
        releasedAtEpochMs: nowMs,
        expectedVersion: 2,
      },
      gate.deps,
    );

    expectEqual(released.status, "released", "an officer can lift a block");
    expectEqual(gate.fixture.updated.length, 1, "with one update");
    const updateQuery = gate.fixture.updated[0]?.query ?? "";

    expect(updateQuery.includes(`id=eq.${String(row["id"])}`), "addressed to the row");
    expect(updateQuery.includes("status=eq.active"), "that must still be in force");
    expect(updateQuery.includes("version=eq.2"), "at the version the officer read");
    expectEqual(gate.fixture.updated[0]?.values["status"], "released", "carrying the release");
    expectEqual(gate.fixture.updated[0]?.values["released_by"], secondOfficerId, "the person who lifted it");
    expectEqual(gate.fixture.updated[0]?.values["release_note"], "Cardholder confirmed the charge was theirs.", "and why");

    const entries = payloadsOf(gate.audit, PORTAL_BLACKLIST_RELEASED_AUDIT_ACTION);

    expectEqual(entries.length, 1, "the release is in the chain");
    expectEqual(entries[0]?.["released_by"], secondOfficerId, "with the person");
    expectEqual(entries[0]?.["release_note"], "Cardholder confirmed the charge was theirs.", "and the note");
  }

  {
    const row = blockRowOf({ version: 5 });
    const gate = listGateOf([row]);
    const released = await releasePortalCard(
      { blockId: String(row["id"]), releasedBy: secondOfficerId, note: "Lifting the block.", releasedAtEpochMs: nowMs, expectedVersion: 4 },
      gate.deps,
    );

    expectEqual(released.status, "stale", "a release at a version that moved is refused rather than reported");
    expectEqual(gate.audit.entries.length, 0, "and nothing claims it happened");
  }

  {
    const gate = listGateOf();
    const released = await releasePortalCard(
      { blockId: randomUUID(), releasedBy: secondOfficerId, note: "Lifting the block.", releasedAtEpochMs: nowMs, expectedVersion: 1 },
      gate.deps,
    );

    expectEqual(released.status, "not_found", "a block that does not exist is not a release");
  }

  {
    const row = blockRowOf({
      status: "released",
      released_at: "2026-10-02T00:00:00.000Z",
      released_by: officerId,
      release_note: "Released by the first officer.",
      version: 3,
    });
    const gate = listGateOf([row]);
    const released = await releasePortalCard(
      { blockId: String(row["id"]), releasedBy: secondOfficerId, note: "Lifting the block.", releasedAtEpochMs: nowMs, expectedVersion: 3 },
      gate.deps,
    );

    expectEqual(released.status, "already_released", "a block another officer already lifted is history, not a second release");
    expectEqual(gate.audit.entries.length, 0, "and the chain says nothing new");

    await expectRefusal(
      () => releasePortalCard({ blockId: String(row["id"]), releasedBy: secondOfficerId, note: "", releasedAtEpochMs: nowMs, expectedVersion: 3 }, gate.deps),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.noteRequired,
      "a release with no note is refused: `0055` requires one",
    );
    await expectRefusal(
      () => releasePortalCard({ blockId: String(row["id"]), releasedBy: secondOfficerId, note: "x".repeat(PORTAL_BLACKLIST_NOTE_MAXIMUM_LENGTH + 1), releasedAtEpochMs: nowMs, expectedVersion: 3 }, gate.deps),
      "VALIDATION_FAILED",
      PORTAL_BLACKLIST_RULES.noteRequired,
      "and one longer than five hundred characters",
    );
    expectEqual(
      portalBlacklistReleaseInputSchema.safeParse({ blockId: String(row["id"]), releasedBy: secondOfficerId, note: "ok", releasedAtEpochMs: nowMs, expectedVersion: 0 }).success,
      false,
      "a version of zero is not a version",
    );
  }

  // ---- the sentences a payer reads
  {
    const blockedText = getMessage("portal.ruleCardBlacklisted");
    const unavailableText = getMessage("portal.ruleCardBlacklistUnavailable");

    expect(blockedText.length > 0, "a blocked card has a sentence");
    expect(blockedText !== unavailableText, "and it is not the sentence for an unreadable list");
    expect(/[Nn]othing was charged/u.test(blockedText), "it says nothing was charged");
    expect(/[Nn]othing was charged/u.test(unavailableText), "and so does the other");
    expect(/[0-9]{4}/u.test(blockedText) === false, "neither prints a code a payer cannot act on");
    expect(portalPaymentRefusalIsFinal(PORTAL_BLACKLIST_RULES.blocked), "the page ends on a blocked card");
    expect(
      portalPaymentRefusalIsFinal(PORTAL_BLACKLIST_RULES.unavailable) === false,
      "but not on a list that could not be read: that one may be tried again",
    );
  }

  // ---- the sources, and the migration that is deliberately not there
  const service = await readFile(new URL("./portal-blacklist.ts", import.meta.url), "utf8");
  const fields = await readFile(new URL("./portal-blacklist-fields.ts", import.meta.url), "utf8");
  const processor = await readFile(new URL("./portal-blacklist-processor.ts", import.meta.url), "utf8");
  const paymentProcessor = await readFile(new URL("./portal-payment-processor.ts", import.meta.url), "utf8");
  const runtime = await readFile(new URL("./portal-payment-runtime.ts", import.meta.url), "utf8");
  const refusal = await readFile(new URL("../../components/payments/portal-payment-refusal.ts", import.meta.url), "utf8");
  const form = await readFile(new URL("../../components/payments/card-payment-form.tsx", import.meta.url), "utf8");
  const blacklistMigration = await readFile(new URL("../../migrations/0055_card_blacklist.sql", import.meta.url), "utf8");
  const paymentsMigration = await readFile(new URL("../../migrations/0037_payments.sql", import.meta.url), "utf8");

  expect(service.includes('"sha256"'), "the fingerprint is a SHA-256");
  expect(service.includes("company_id=is.null"), "the list is read as the platform's own");
  expect(service.includes("select=*") === false, "and never with a wildcard");
  expect(service.includes("cvv") === false && service.includes("card_number") === false, "no column of this module names card data");
  expect(processor.includes("durable: options.actor !== null"), "the referral is durable only when a person can author it");
  expect(processor.includes("actor_required"), "and says so when nobody can");
  expect(runtime.includes("createPortalCardBlockCheck"), "the runtime asks the list before the gateway");
  expect(runtime.includes("createPortalCardBlacklistQueue"), "and wires the durable referral queue");
  expect(runtime.includes("actor: null"), "with no officer configured, which the handoff states");
  expect(refusal.includes("card_blacklisted"), "the rule reaches the payer as a sentence");
  expect(form.includes("portalPaymentRefusalIsFinal"), "and the form ends the page on it");

  const checkAt = paymentProcessor.indexOf("blacklist.check(");
  const gatewayAt = paymentProcessor.indexOf("processNmiPayment(");

  expect(checkAt > 0 && gatewayAt > 0 && checkAt < gatewayAt, "the check runs before the gateway is called");
  expect(
    paymentProcessor.includes('code: PORTAL_BLACKLIST_SETTLED_CODE'),
    "and a listed card is settled with the list's code",
  );
  expect(
    paymentProcessor.includes('opened.code === PORTAL_BLACKLIST_SETTLED_CODE'),
    "so a replayed attempt is refused by the same rule",
  );
  expect(fields.includes("PORTAL_BLACKLIST_SOURCES"), "the two identifiers are named once");

  expect(
    blacklistMigration.includes("card_fingerprint ~ '^[0-9a-f]{64}$'"),
    "`0055` stores a sixty four character hash and nothing else",
  );
  expect(
    blacklistMigration.includes("fingerprint_source in ('card_token', 'provider_fingerprint')"),
    "from exactly the two identifiers section 18 names",
  );
  expect(
    blacklistMigration.includes("reason in ('fraud', 'card_testing', 'chargeback', 'stolen_card', 'compliance', 'other')"),
    "with the six reasons this module validates against",
  );
  expect(
    blacklistMigration.includes("create unique index card_blacklist_active_key"),
    "one active block per fingerprint, which is what makes a duplicate a conflict",
  );
  expect(
    blacklistMigration.includes("constraint card_blacklist_platform_check check (company_id is null)"),
    "and the list is the platform's, not a merchant's",
  );
  expect(
    blacklistMigration.includes("char_length(note) between 1 and 500"),
    "a note is trimmed and bounded, as this module's schema is",
  );
  expect(
    blacklistMigration.includes("(status = 'released') = (released_at is not null)"),
    "a release is a release or it is nothing",
  );
  expect(
    blacklistMigration.includes("blacklisted_by") && blacklistMigration.includes("references public.users (id)"),
    "and a block names a person, which is why a referral cannot author one",
  );
  expect(
    paymentsMigration.includes("constraint payments_failure_code_check check (\n    failure_code is null\n    or (char_length(failure_code) between 1 and 64"),
    "`card_blacklisted` fits the payments failure code bounds",
  );
  expect(
    paymentsMigration.includes("payments_risk_reject_check check (risk_decision <> 'reject' or status = 'failed')"),
    "and a refused payment's `reject` decision sits on `failed`",
  );

  const migrations = (await readdir(new URL("../../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name) && !name.endsWith(".down.sql"))
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .sort((left, right) => left - right);
  const highest = migrations[migrations.length - 1] ?? 0;

  expectEqual(highest, 122, "`0055` already holds the list, so this STEP adds no migration and 0123 stays free");
  expect(migrations.filter((number) => number === 0).length === 0, "and every migration is numbered");

  if (failures.length > 0) {
    process.stdout.write(`portal blacklist gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `portal blacklist gate passed: ${String(checkCount)} checks, ${PORTAL_BLACKLIST_SOURCES.join("/")} entries by ${PORTAL_BLACKLIST_STATUSES.join("/")}, a listed card refused before the gateway with ${PORTAL_BLACKLIST_SETTLED_CODE}, an unreadable list failing closed, referrals durable only under a person, no migration needed\n`,
  );
}

/** The person a chain entry was written as, so a block can be attributed rather than assumed. */
function actorOf(audit: InMemoryAuditTrail, action: string): string | null {
  const entry = audit.entries.find((candidate) => candidate.action === action);

  return entry?.actorUserId ?? null;
}

await main();
