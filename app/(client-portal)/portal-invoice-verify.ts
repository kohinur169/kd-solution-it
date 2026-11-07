// path: app/(client-portal)/portal-invoice-verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { createInMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { isAppError } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import { mintPortalToken, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { INVOICE_STATUSES } from "../../services/invoices/invoice-fields.ts";
import {
  isPortalTokenId,
  portalAcceptanceStatementFor,
  portalFulfilmentKindOf,
  portalStatementMatchesKind,
  PORTAL_ACCEPTANCE_CONSENT_KEY,
  PORTAL_DOCUMENT_HASH_PATTERN,
  PORTAL_RELEASE_BLOCKERS,
} from "./portal-invoice-fields.ts";
import {
  openPortalInvoice,
  portalInvoiceDocumentHashOf,
  portalInvoiceDocumentEncoding,
  portalInvoiceStateOf,
  portalMinimumPartialMinor,
  type PortalInvoiceView,
} from "./portal-invoice.ts";
import { portalMoneyTextOf, portalQuantityTextOf } from "./portal-invoice-money.ts";
import {
  capturePortalInvoiceAcceptance,
  parsePortalAcceptance,
  parsePortalFulfilment,
  recordPortalInvoiceFulfilment,
  type PortalEvidenceDependencies,
} from "./portal-invoice-evidence.ts";
import { enforcePortalAcceptanceRateLimit } from "./portal-invoice-rate-limit.ts";

/**
 * The gate for STEP 181: the tokenized invoice page, its receipt and the two evidence writes.
 *
 * ## What this proves without a database
 *
 * There is no PostgreSQL in this sandbox, so the fixture below *is* the database, and its rules are
 * transcribed from `0122`, `0022`, `0023`, `0037` and `0041` rather than from the modules under test - a
 * fixture written from the service agrees with the service by construction and proves nothing. The fake
 * rest client is a small PostgREST: it applies the equality filters of a query string, `is.null` and
 * `limit`, parses every row through the schema the caller passed (so a mis-shaped read fails here rather
 * than in production), and refuses a query that names no tenant, which is the one mistake a portal read
 * must never make.
 *
 * ## What it exercises
 *
 *   - every one of `0022`'s seven statuses folded into the five a buyer meets, and the refusal of a
 *     status that is not one of them;
 *   - the money: exact minor units printed, the twenty dollar floor, the remainder below the floor, and
 *     the fact that a settled or cancelled document offers no amount at all;
 *   - the receipt: three entries, the four counted statuses, the cut at forty and the totals that go
 *     quiet when the list was cut;
 *   - the digest: unchanged when the status, the paid total or a timestamp moves, changed when a line, a
 *     price or the client does - the property a confirmation depends on;
 *   - both writes: the merchant's record and its correction before a confirmation, the refusal after one,
 *     the buyer's confirmation with a server-computed digest and a consent sentence from the catalog, and
 *     every refusal an attacker or a mistake can produce - unpaid, cancelled, already confirmed, wrong
 *     statement, stale evidence id, unticked consent, a body with a `document_hash` of its own;
 *   - the security shape of the two routes, the page and the migration, read as source: CSRF before the
 *     body, the rate limit before the body, the byte ceiling, `force-dynamic`, `noindex`, default-deny,
 *     the append-only guard, the release question, and the absence of any write onto `invoices`.
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

/** Run a service call that must fail, and check the code and the first rule it refuses with. */
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

// ---------------------------------------------------------------------------------------------
// The fixture: a PostgREST over arrays, with the refusals of the migrations that matter.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** The equality filters of a PostgREST query string: `key=eq.value`, `key=is.null`, `limit=N`. */
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

    // `in.(a,b,c)` is how the receipt asks for the four counted statuses.
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

    // PostgREST compares the text of a column, so `version=eq.1` matches the number one: the fake
    // compares the same way rather than being stricter than the database it stands in for.
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
  readonly inserts: { readonly table: string; readonly row: Row }[];
  rateLimitAnswer: Row | null;
}

function createFixture(): Fixture {
  return {
    tables: new Map<string, Row[]>(),
    queries: [],
    updates: [],
    inserts: [],
    rateLimitAnswer: {
      allowed: true,
      remaining: 9,
      retry_after_seconds: 0,
      first_refusal: false,
    },
  };
}

/**
 * The rest client the service sees.
 *
 * A `select` on a tenant table whose query names no `company_id` is a failure of the gate rather than of
 * the service: every read of this STEP is tenant scoped, and a fake that quietly answered such a query
 * would hide exactly the defect the scoping exists to prevent.
 */
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

    async insert(table: string, rows: readonly Row[]): Promise<void> {
      for (const row of rows) {
        const stored: Row = {
          id: randomUUID(),
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
          version: 1,
          ...row,
        };

        fixture.inserts.push({ table, row: stored });
        rowsOf(table).push(stored);
      }
    },

    async insertReturning<TRow>(
      table: string,
      rows: readonly Row[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      const inserted: TRow[] = [];

      for (const row of rows) {
        const stored: Row = {
          id: randomUUID(),
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
          version: 1,
          ...row,
        };

        fixture.inserts.push({ table, row: stored });
        rowsOf(table).push(stored);
        inserted.push(schema.parse({ ...stored }));
      }

      return inserted;
    },

    async update(table: string, query: string, values: Row): Promise<void> {
      fixture.updates.push({ table, query, values });

      const { equals } = filtersOf(query);

      for (const row of rowsOf(table)) {
        if (matches(row, equals)) {
          Object.assign(row, values, { version: Number(row["version"] ?? 1) + 1 });
        }
      }
    },

    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (functionName !== "consume_rate_limit") {
        throw new Error(`unexpected rpc ${functionName}`);
      }

      if (
        arguments_["p_scope"] !== "portal_acceptance" ||
        typeof arguments_["p_key_hash"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(String(arguments_["p_key_hash"])) ||
        arguments_["p_limit"] !== 10 ||
        arguments_["p_window_seconds"] !== 600
      ) {
        throw new Error("the confirmation counter was called with the wrong policy");
      }

      return fixture.rateLimitAnswer === null ? [] : [fixture.rateLimitAnswer];
    },
  };
}

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const fulfilmentId = "66666666-6666-4666-8666-666666666666";
const keys: PortalTokenKeys = { primary: Buffer.alloc(32, 7).toString("base64") };
const nowMs = Date.parse("2026-11-07T09:30:00.000Z");

/** The invoice a paid link names: 100.0000 charged, 100.0000 received. */
function invoiceRow(overrides: Row = {}): Row {
  return {
    id: invoiceId,
    company_id: companyId,
    client_id: clientId,
    number: "INV-0007",
    status: "paid",
    currency: "USD",
    subtotal_minor: "1000000",
    discount_minor: "0",
    discount_basis: "none",
    discount_percent_bp: 0,
    tax_minor: "0",
    total_minor: "1000000",
    amount_paid_minor: "1000000",
    client_name: "Acme Trading",
    client_email: "billing@acme.test",
    client_address: "9 Harbour Road\nDhaka",
    memo: "November retainer",
    issued_at: "2026-11-01T00:00:00.000Z",
    due_at: "2026-11-15T00:00:00.000Z",
    first_viewed_at: "2026-11-01T04:00:00.000Z",
    paid_at: "2026-11-03T12:00:00.000Z",
    voided_at: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-03T12:00:00.000Z",
    deleted_at: null,
    version: 4,
    ...overrides,
  };
}

function itemRow(position: number, description: string, unitPrice: string, lineTotal: string): Row {
  return {
    id: randomUUID(),
    company_id: companyId,
    invoice_id: invoiceId,
    position,
    description,
    unit: "hour",
    quantity: "2.500",
    unit_price_minor: unitPrice,
    discount_minor: "0",
    line_total_minor: lineTotal,
    product_id: null,
    service_id: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    deleted_at: null,
    version: 1,
  };
}

function paymentRow(id: string, status: string, amount: string, refunded: string, createdAt: string): Row {
  return {
    id,
    company_id: companyId,
    invoice_id: invoiceId,
    mode: "live",
    payment_method: "card",
    amount_minor: amount,
    currency: "USD",
    fee_minor: "0",
    refunded_minor: refunded,
    card_brand: "visa",
    card_last_four: "4242",
    status,
    captured_at: createdAt,
    settled_at: createdAt,
    refunded_at: null,
    created_at: createdAt,
    deleted_at: null,
  };
}

function fulfilmentRow(overrides: Row = {}): Row {
  return {
    id: fulfilmentId,
    company_id: companyId,
    invoice_id: invoiceId,
    kind: "delivery",
    method: "carrier",
    occurred_at: "2026-11-02T09:00:00.000Z",
    reference: "TRACK-991",
    description: null,
    recorded_by_user_id: userId,
    recorded_at: "2026-11-02T10:00:00.000Z",
    created_at: "2026-11-02T10:00:00.000Z",
    updated_at: "2026-11-02T10:00:00.000Z",
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

function acceptanceRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    company_id: companyId,
    invoice_id: invoiceId,
    fulfilment_evidence_id: fulfilmentId,
    statement: "delivery_received",
    signer_name: "Rina Chowdhury",
    signer_email: "rina@acme.test",
    consent_text: getMessage(PORTAL_ACCEPTANCE_CONSENT_KEY),
    consent_accepted: true,
    accepted_at: "2026-11-04T08:00:00.000Z",
    ip: "203.0.113.9",
    geo_location: null,
    device_fingerprint: null,
    document_hash: "a".repeat(64),
    user_agent: "Mozilla/5.0",
    created_at: "2026-11-04T08:00:00.000Z",
    updated_at: "2026-11-04T08:00:00.000Z",
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

function tokenFor(resourceId: string = invoiceId, company: string = companyId): string {
  return mintPortalToken(
    {
      kind: "invoice",
      companyId: company,
      resourceId,
      capability: "pay",
      lifetimeSeconds: 86_400,
    },
    { keys, now: Math.floor(nowMs / 1_000) },
  );
}

function dependencies(fixture: Fixture): PortalEvidenceDependencies {
  return {
    rest: createRest(fixture),
    audit: createInMemoryAuditTrail(),
    tokenKeys: keys,
    now: () => nowMs,
  };
}

/** The owner of the invoice's company. */
function ownerActor(company: string = companyId): RequestActor {
  return {
    userId,
    companyId: company,
    sessionId: null,
    roles: ["owner"],
    platformRoles: ["owner"],
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
  } as unknown as RequestActor;
}

/** A plain member of the same company: a real role that may read invoices and may not write evidence. */
function memberActor(): RequestActor {
  return {
    ...ownerActor(),
    roles: ["staff"],
    platformRoles: ["staff"],
  } as unknown as RequestActor;
}

async function main(): Promise<void> {
  // ---- the vocabulary: five states from seven, and no eighth
  const expectedStates: Readonly<Record<string, string>> = {
    draft: "not_issued",
    sent: "open",
    viewed: "open",
    overdue: "open",
    partially_paid: "partially_paid",
    paid: "paid",
    void: "void",
  };

  for (const status of INVOICE_STATUSES) {
    expectEqual(portalInvoiceStateOf(status), expectedStates[status], `0022 status ${status}`);
  }

  expectEqual(portalInvoiceStateOf("refunded"), null, "a status 0022 does not have is not folded");

  // ---- the vocabulary: every method belongs to a kind, every kind has a statement
  for (const method of ["carrier", "hand_delivery", "pickup", "digital", "in_person", "remote"] as const) {
    expect(
      portalFulfilmentKindOf(method) === "delivery" || portalFulfilmentKindOf(method) === "service",
      `method ${method} names a kind`,
    );
  }

  expectEqual(portalAcceptanceStatementFor("delivery"), "delivery_received", "delivery asks for delivery");
  expectEqual(portalAcceptanceStatementFor("service"), "service_accepted", "service asks for acceptance");
  expect(
    portalStatementMatchesKind("delivery_received", "service") === false,
    "a delivery statement never matches service evidence",
  );

  // ---- the money printer: exact minor units, the column's own scale
  expectEqual(portalMoneyTextOf("USD", "200000"), "20.0000 USD", "twenty dollars prints exactly");
  expectEqual(portalMoneyTextOf("USD", "1234567"), "123.4567 USD", "a fraction of a cent survives");
  expectEqual(portalQuantityTextOf("2.500"), "2.5", "a stored quantity loses its padding");
  expectEqual(portalQuantityTextOf("3.000"), "3", "a whole quantity prints without a point");

  // ---- the floor: twenty, or the remainder when the remainder is smaller
  expectEqual(portalMinimumPartialMinor(1_000_000n, "USD"), 200_000n, "the floor is twenty dollars");
  expectEqual(portalMinimumPartialMinor(150_000n, "USD"), 150_000n, "a remainder under the floor is the floor");
  expectEqual(portalMinimumPartialMinor(200_000n, "USD"), 200_000n, "a remainder at the floor is the floor");
  expectEqual(portalMinimumPartialMinor(0n, "USD"), null, "nothing left has no minimum");
  expectEqual(portalMinimumPartialMinor(1_000_000n, "EUR"), null, "a currency the platform cannot price has none");

  // ---- the read model over a paid invoice with a receipt
  const fixture = createFixture();
  fixture.tables.set("invoices", [invoiceRow()]);
  fixture.tables.set("invoice_items", [
    itemRow(1, "Design work", "300000", "750000"),
    itemRow(2, "Follow-up call", "100000", "250000"),
  ]);
  fixture.tables.set("payments", [
    paymentRow("77777777-7777-4777-8777-777777777777", "settled", "600000", "0", "2026-11-03T11:00:00.000Z"),
    paymentRow("88888888-8888-4888-8888-888888888888", "settled", "400000", "100000", "2026-11-03T12:00:00.000Z"),
  ]);
  fixture.tables.set("invoice_fulfilment_evidence", [fulfilmentRow()]);
  fixture.tables.set("invoice_acceptances", []);

  const deps = dependencies(fixture);
  const paidView = await openPortalInvoice({ token: tokenFor() }, deps);

  expectEqual(paidView.state, "paid", "the link reads the paid state");
  expectEqual(paidView.number, "INV-0007", "the number is the invoice's own");
  expectEqual(paidView.totals.totalMinor, "1000000", "the total is exact minor units");
  expectEqual(paidView.totals.remainingMinor, "0", "a paid invoice owes nothing");
  expectEqual(paidView.lines.length, 2, "both lines are read");
  expectEqual(paidView.lines[0]?.quantityText, "2.5", "the line prints its own quantity");
  expectEqual(paidView.receipt.entries.length, 2, "both payments are on the receipt");
  expectEqual(paidView.receipt.receivedMinor, "1000000", "the receipt holds what the ledger holds");
  expectEqual(paidView.receipt.refundedMinor, "100000", "the refund is summed");
  expectEqual(paidView.receipt.netMinor, "900000", "net is received minus refunded");
  expectEqual(paidView.payment.open, false, "a paid link takes no payment");
  expectEqual(paidView.payment.amountMinor, null, "and offers no amount at all");
  expectEqual(paidView.fulfilment?.id, fulfilmentId, "the delivery record is read");
  expectEqual(paidView.acceptance, null, "nothing is confirmed yet");
  expectEqual(paidView.release.ok, false, "a release without a confirmation is refused");
  expectEqual(
    paidView.release.blockers.join(","),
    "acceptance_missing",
    "and the blocker names the confirmation",
  );
  expect(
    paidView.release.blockers.every((blocker) =>
      (PORTAL_RELEASE_BLOCKERS as readonly string[]).includes(blocker),
    ),
    "every blocker is one of the four the release question can name",
  );
  expect(isPortalTokenId(paidView.tokenId), "the view carries a token id, never the token");
  expect(
    fixture.queries.every((query) => query.includes("company_id=eq.")),
    "every read is tenant scoped",
  );

  // ---- the digest: the identity and the money, never the state
  const digest = portalInvoiceDocumentHashOf(paidView);

  expect(PORTAL_DOCUMENT_HASH_PATTERN.test(digest), "the digest is 64 lower case hex characters");
  expect(
    portalInvoiceDocumentEncoding(paidView).startsWith("{\"encoding\":\"kd-invoice-portal-document/1\""),
    "the digest names the document it digests",
  );

  const restated: PortalInvoiceView = {
    ...paidView,
    state: "partially_paid",
    paidAt: null,
    firstViewedAt: null,
    totals: { ...paidView.totals, paidMinor: "400000", remainingMinor: "600000" },
    receipt: { ...paidView.receipt, entries: [] },
  };

  expectEqual(
    portalInvoiceDocumentHashOf(restated),
    digest,
    "a payment arriving does not change the document's digest",
  );

  const repriced: PortalInvoiceView = {
    ...paidView,
    lines: paidView.lines.map((line, index) =>
      index === 0 ? { ...line, lineTotalMinor: "750001" } : line,
    ),
  };

  expect(
    portalInvoiceDocumentHashOf(repriced) !== digest,
    "a changed line changes the document's digest",
  );

  const renamed: PortalInvoiceView = { ...paidView, clientName: "Acme Trading Ltd" };

  expect(
    portalInvoiceDocumentHashOf(renamed) !== digest,
    "a changed client changes the document's digest",
  );

  // ---- a paid invoice, once confirmed, releases and offers nothing
  fixture.tables.set("invoice_acceptances", [acceptanceRow()]);
  const confirmedView = await openPortalInvoice({ token: tokenFor() }, dependencies(fixture));

  expectEqual(confirmedView.acceptance?.statement, "delivery_received", "the confirmation is read");
  expectEqual(confirmedView.release.ok, true, "a paid, delivered, confirmed invoice may be released");
  expectEqual(confirmedView.release.blockers.length, 0, "and names no blocker");

  // ---- a partly paid invoice offers the remainder only
  fixture.tables.set("invoices", [
    invoiceRow({ status: "partially_paid", amount_paid_minor: "400000", paid_at: null }),
  ]);
  fixture.tables.set("invoice_acceptances", []);
  const partialView = await openPortalInvoice({ token: tokenFor() }, dependencies(fixture));

  expectEqual(partialView.state, "partially_paid", "the link reads the partly paid state");
  expectEqual(partialView.payment.open, true, "a partly paid link still takes money");
  expectEqual(partialView.payment.amountMinor, "600000", "and offers only the remainder");
  expectEqual(partialView.payment.minimumMinor, "200000", "the floor applies to a partial");
  expectEqual(
    partialView.release.blockers.join(","),
    "invoice_not_paid,acceptance_missing",
    "a partly paid invoice is not released",
  );

  // ---- a cancelled invoice shows itself and takes nothing
  fixture.tables.set("invoices", [
    invoiceRow({ status: "void", amount_paid_minor: "0", paid_at: null, voided_at: "2026-11-05T00:00:00.000Z" }),
  ]);
  const voidView = await openPortalInvoice({ token: tokenFor() }, dependencies(fixture));

  expectEqual(voidView.state, "void", "a cancelled invoice reads as cancelled");
  expectEqual(voidView.payment.open, false, "and takes no payment");
  expectEqual(voidView.release.blockers[0], "invoice_void", "a cancelled invoice is blocked first");

  // ---- a draft is answered rather than refused
  fixture.tables.set("invoices", [invoiceRow({ status: "draft", number: null, issued_at: null, amount_paid_minor: "0", paid_at: null })]);
  const draftView = await openPortalInvoice({ token: tokenFor() }, dependencies(fixture));

  expectEqual(draftView.state, "not_issued", "a draft link says the invoice is not ready");

  // ---- a token for another company reads nothing
  fixture.tables.set("invoices", [invoiceRow()]);
  fixture.tables.set("invoice_acceptances", []);
  await expectRefusal(
    () => openPortalInvoice({ token: tokenFor(invoiceId, otherCompanyId) }, dependencies(fixture)),
    "RESOURCE_NOT_FOUND",
    null,
    "a token naming another company finds no invoice",
  );

  await expectRefusal(
    () => openPortalInvoice({ token: "kdpt1.not-a-token" }, dependencies(fixture)),
    "RESOURCE_NOT_FOUND",
    null,
    "a forged token is refused as not found",
  );

  // ---- the receipt is cut at forty, and its totals go quiet when it is
  const manyPayments: Row[] = [];

  for (let index = 0; index < 41; index += 1) {
    manyPayments.push(
      paymentRow(randomUUID(), "settled", "10000", "0", `2026-11-03T11:${String(index).padStart(2, "0")}:00.000Z`),
    );
  }

  fixture.tables.set("payments", manyPayments);
  const truncatedView = await openPortalInvoice({ token: tokenFor() }, dependencies(fixture));

  expectEqual(truncatedView.receipt.entries.length, 40, "the receipt prints forty entries");
  expectEqual(truncatedView.receipt.truncated, true, "and says it was cut");
  expectEqual(truncatedView.receipt.omitted, 1, "counting what it left out");
  expectEqual(truncatedView.receipt.refundedMinor, null, "a cut receipt prints no refund total");
  expectEqual(truncatedView.receipt.netMinor, null, "and no net total either");
  expectEqual(truncatedView.receipt.receivedMinor, "1000000", "but the amount received stays exact");

  // ---- the merchant's record: first write, then a correction, then the refusal after a confirmation
  const writeFixture = createFixture();
  writeFixture.tables.set("invoices", [
    invoiceRow({ status: "partially_paid", amount_paid_minor: "400000", paid_at: null }),
  ]);
  writeFixture.tables.set("invoice_items", []);
  writeFixture.tables.set("payments", []);
  writeFixture.tables.set("invoice_fulfilment_evidence", []);
  writeFixture.tables.set("invoice_acceptances", []);
  const writeDeps = dependencies(writeFixture);

  const first = await recordPortalInvoiceFulfilment(
    {
      actor: ownerActor(),
      token: tokenFor(),
      body: {
        kind: "delivery",
        method: "carrier",
        occurred_at: "2026-11-06T10:00:00.000Z",
        reference: "TRACK-1001",
        description: null,
      },
    },
    writeDeps,
  );

  expectEqual(first.replaced, false, "a first record replaces nothing");
  expectEqual(first.fulfilment.kind, "delivery", "the record keeps its kind");
  expectEqual(first.fulfilment.reference, "TRACK-1001", "and its reference");
  expectEqual(writeFixture.inserts.length, 1, "one row was written");
  expectEqual(
    writeFixture.inserts[0]?.row["recorded_by_user_id"],
    userId,
    "the record names the account that wrote it",
  );

  const corrected = await recordPortalInvoiceFulfilment(
    {
      actor: ownerActor(),
      token: tokenFor(),
      body: {
        kind: "delivery",
        method: "hand_delivery",
        occurred_at: "2026-11-06T11:00:00.000Z",
        reference: "TRACK-1002",
        description: "Left with the concierge",
      },
    },
    writeDeps,
  );

  expectEqual(corrected.replaced, true, "a second record replaces the first");
  expectEqual(writeFixture.updates.length, 1, "the first row was soft deleted");
  expectEqual(
    typeof writeFixture.updates[0]?.values["deleted_at"],
    "string",
    "by a soft delete rather than a removal",
  );
  expect(
    writeFixture.updates[0]?.query.includes("version=eq.") === true,
    "and the correction is scoped to the version it read",
  );

  await expectRefusal(
    () =>
      recordPortalInvoiceFulfilment(
        {
          actor: ownerActor(otherCompanyId),
          token: tokenFor(),
          body: { kind: "delivery", method: "carrier", occurred_at: "2026-11-06T10:00:00.000Z" },
        },
        writeDeps,
      ),
    "PERMISSION_DENIED",
    null,
    "an owner of another company cannot record evidence on this link",
  );

  await expectRefusal(
    () =>
      recordPortalInvoiceFulfilment(
        {
          actor: memberActor(),
          token: tokenFor(),
          body: { kind: "delivery", method: "carrier", occurred_at: "2026-11-06T10:00:00.000Z" },
        },
        writeDeps,
      ),
    "PERMISSION_DENIED",
    null,
    "a member who may read invoices may not record evidence",
  );

  await expectRefusal(
    () =>
      recordPortalInvoiceFulfilment(
        {
          actor: ownerActor(),
          token: tokenFor(),
          body: { kind: "delivery", method: "in_person", occurred_at: "2026-11-06T10:00:00.000Z" },
        },
        writeDeps,
      ),
    "VALIDATION_FAILED",
    "invalid_format",
    "a method outside the kind it claims is refused",
  );

  await expectRefusal(
    () =>
      recordPortalInvoiceFulfilment(
        {
          actor: ownerActor(),
          token: tokenFor(),
          body: { kind: "delivery", method: "carrier", occurred_at: "2027-01-01T10:00:00.000Z" },
        },
        writeDeps,
      ),
    "VALIDATION_FAILED",
    "too_large",
    "a delivery in the future is refused",
  );

  writeFixture.tables.set("invoice_acceptances", [acceptanceRow()]);
  await expectRefusal(
    () =>
      recordPortalInvoiceFulfilment(
        {
          actor: ownerActor(),
          token: tokenFor(),
          body: { kind: "delivery", method: "carrier", occurred_at: "2026-11-06T10:00:00.000Z" },
        },
        writeDeps,
      ),
    "CONFLICT",
    "evidence_confirmed",
    "a confirmed record is a fact and cannot be corrected",
  );
  writeFixture.tables.set("invoice_acceptances", []);

  // ---- the buyer's confirmation
  writeFixture.tables.set("invoice_fulfilment_evidence", [fulfilmentRow()]);
  const captureDeps = dependencies(writeFixture);

  await expectRefusal(
    () =>
      capturePortalInvoiceAcceptance(
        {
          token: tokenFor(),
          clientAddress: "203.0.113.9",
          userAgent: "Mozilla/5.0",
          actorCompanyId: null,
          body: {
            statement: "delivery_received",
            fulfilment_evidence_id: fulfilmentId,
            signer_name: "Rina Chowdhury",
            signer_email: "rina@acme.test",
            consent_accepted: true,
            document_hash: "b".repeat(64),
          },
        },
        captureDeps,
      ),
    "VALIDATION_FAILED",
    "unknown_field",
    "a body that brings its own digest is refused",
  );

  await expectRefusal(
    () =>
      capturePortalInvoiceAcceptance(
        {
          token: tokenFor(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
          body: {
            statement: "delivery_received",
            fulfilment_evidence_id: fulfilmentId,
            signer_name: "Rina Chowdhury",
            signer_email: "rina@acme.test",
            consent_accepted: false,
          },
        },
        captureDeps,
      ),
    "VALIDATION_FAILED",
    "required",
    "an unticked consent box is not a confirmation",
  );

  await expectRefusal(
    () =>
      capturePortalInvoiceAcceptance(
        {
          token: tokenFor(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
          body: {
            statement: "service_accepted",
            fulfilment_evidence_id: fulfilmentId,
            signer_name: "Rina Chowdhury",
            signer_email: "rina@acme.test",
            consent_accepted: true,
          },
        },
        captureDeps,
      ),
    "VALIDATION_FAILED",
    "statement_mismatch",
    "a statement that contradicts the evidence is refused",
  );

  await expectRefusal(
    () =>
      capturePortalInvoiceAcceptance(
        {
          token: tokenFor(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
          body: {
            statement: "delivery_received",
            fulfilment_evidence_id: "99999999-9999-4999-8999-999999999999",
            signer_name: "Rina Chowdhury",
            signer_email: "rina@acme.test",
            consent_accepted: true,
          },
        },
        captureDeps,
      ),
    "CONFLICT",
    "evidence_changed",
    "a confirmation of evidence the page no longer shows is refused",
  );

  const captured = await capturePortalInvoiceAcceptance(
    {
      token: tokenFor(),
      clientAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (confirmation)",
      actorCompanyId: null,
      body: {
        statement: "delivery_received",
        fulfilment_evidence_id: fulfilmentId,
        signer_name: "  Rina Chowdhury ",
        signer_email: " rina@acme.test ",
        consent_accepted: true,
        device_fingerprint: "fp-0123456789",
      },
    },
    captureDeps,
  );

  expectEqual(captured.statement, "delivery_received", "the confirmation keeps its statement");
  expectEqual(captured.signerName, "Rina Chowdhury", "the name is stored trimmed");
  expectEqual(captured.fulfilmentEvidenceId, fulfilmentId, "and points at the live record");

  const acceptanceInsert = writeFixture.inserts.find((entry) => entry.table === "invoice_acceptances");

  expect(acceptanceInsert !== undefined, "the confirmation was written to its own table");
  expectEqual(
    acceptanceInsert?.row["document_hash"],
    portalInvoiceDocumentHashOf(await openPortalInvoice({ token: tokenFor() }, captureDeps)),
    "the digest is the one the server computed from the document",
  );
  expectEqual(
    acceptanceInsert?.row["consent_text"],
    getMessage(PORTAL_ACCEPTANCE_CONSENT_KEY),
    "the consent sentence stored is the one the catalog shows",
  );
  expectEqual(acceptanceInsert?.row["ip"], "203.0.113.9", "the address is the request's own");
  expectEqual(
    acceptanceInsert?.row["user_agent"],
    "Mozilla/5.0 (confirmation)",
    "and the browser string is recorded",
  );

  writeFixture.tables.set("invoice_acceptances", [acceptanceRow()]);
  await expectRefusal(
    () =>
      capturePortalInvoiceAcceptance(
        {
          token: tokenFor(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
          body: {
            statement: "delivery_received",
            fulfilment_evidence_id: fulfilmentId,
            signer_name: "Rina Chowdhury",
            signer_email: "rina@acme.test",
            consent_accepted: true,
          },
        },
        dependencies(writeFixture),
      ),
    "CONFLICT",
    "acceptance_exists",
    "a second confirmation is refused, because once is enough",
  );

  writeFixture.tables.set("invoice_acceptances", []);

  // The seller cannot confirm their own delivery: a session belonging to the invoice's own company is
  // refused, because evidence a merchant produced for themselves is not evidence.
  writeFixture.tables.set("invoices", [
    invoiceRow({ status: "partially_paid", amount_paid_minor: "400000", paid_at: null }),
  ]);
  await expectRefusal(
    () =>
      capturePortalInvoiceAcceptance(
        {
          token: tokenFor(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: companyId,
          body: {
            statement: "delivery_received",
            fulfilment_evidence_id: fulfilmentId,
            signer_name: "Rina Chowdhury",
            signer_email: "rina@acme.test",
            consent_accepted: true,
          },
        },
        dependencies(writeFixture),
      ),
    "CONFLICT",
    "self_confirmation",
    "the merchant's own session cannot confirm the merchant's own invoice",
  );

  writeFixture.tables.set("invoices", [
    invoiceRow({ status: "sent", amount_paid_minor: "0", paid_at: null }),
  ]);
  await expectRefusal(
    () =>
      capturePortalInvoiceAcceptance(
        {
          token: tokenFor(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
          body: {
            statement: "delivery_received",
            fulfilment_evidence_id: fulfilmentId,
            signer_name: "Rina Chowdhury",
            signer_email: "rina@acme.test",
            consent_accepted: true,
          },
        },
        dependencies(writeFixture),
      ),
    "CONFLICT",
    "not_paid_yet",
    "an unpaid invoice cannot be confirmed",
  );

  writeFixture.tables.set("invoices", [
    invoiceRow({ status: "void", amount_paid_minor: "0", paid_at: null, voided_at: "2026-11-05T00:00:00.000Z" }),
  ]);
  await expectRefusal(
    () =>
      capturePortalInvoiceAcceptance(
        {
          token: tokenFor(),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
          body: {
            statement: "delivery_received",
            fulfilment_evidence_id: fulfilmentId,
            signer_name: "Rina Chowdhury",
            signer_email: "rina@acme.test",
            consent_accepted: true,
          },
        },
        dependencies(writeFixture),
      ),
    "CONFLICT",
    "invoice_void",
    "a cancelled invoice cannot be confirmed",
  );

  // ---- the parsers, on their own
  await expectRefusal(
    async () => parsePortalAcceptance({ signer_name: "A", signer_email: "not-an-address", consent_accepted: true, statement: "delivery_received", fulfilment_evidence_id: fulfilmentId }),
    "VALIDATION_FAILED",
    "invalid_format",
    "an address that is not an address is refused",
  );
  await expectRefusal(
    async () => parsePortalAcceptance({ signer_name: "A", signer_email: "a@b.test", consent_accepted: true, statement: "delivery_received", fulfilment_evidence_id: fulfilmentId, device_fingerprint: "short" }),
    "VALIDATION_FAILED",
    "invalid_format",
    "a fingerprint shorter than eight characters is refused",
  );
  await expectRefusal(
    async () =>
      parsePortalFulfilment(
        { kind: "delivery", method: "carrier", occurred_at: "2026-11-06T10:00:00.000Z", reference: "ab" },
        nowMs,
      ),
    "VALIDATION_FAILED",
    "too_short",
    "a reference under three characters is refused",
  );
  await expectRefusal(
    async () =>
      parsePortalFulfilment(
        { kind: "delivery", method: "carrier", occurred_at: "not-a-date" },
        nowMs,
      ),
    "VALIDATION_FAILED",
    "invalid_format",
    "an instant that cannot be parsed is refused",
  );

  // ---- the rate limit: allowed, refused, and refused with a wait
  const allowedFixture = createFixture();
  const allowed = await enforcePortalAcceptanceRateLimit(
    { clientAddress: "203.0.113.9" },
    { rest: createRest(allowedFixture), audit: createInMemoryAuditTrail() },
  );

  expectEqual(allowed.allowed, true, "an address inside its window is allowed");

  const refusedFixture = createFixture();
  refusedFixture.rateLimitAnswer = {
    allowed: false,
    remaining: 0,
    retry_after_seconds: 42,
    first_refusal: true,
  };
  const refusalTrail = createInMemoryAuditTrail();

  await expectRefusal(
    () =>
      enforcePortalAcceptanceRateLimit(
        { clientAddress: "203.0.113.9" },
        { rest: createRest(refusedFixture), audit: refusalTrail },
      ),
    "RATE_LIMITED",
    null,
    "an address that spent its window is refused",
  );
  expectEqual(refusalTrail.entries.length, 1, "and the first refusal is recorded once");
  expectEqual(
    refusalTrail.entries[0]?.payload["key_hash"] === undefined,
    false,
    "the entry names the hashed counter",
  );
  expect(
    refusalTrail.entries[0]?.payload["key_hash"] !== "203.0.113.9",
    "and never the address itself as the key",
  );

  const unreadableFixture = createFixture();
  unreadableFixture.rateLimitAnswer = null;
  await expectRefusal(
    () =>
      enforcePortalAcceptanceRateLimit(
        { clientAddress: "203.0.113.9" },
        { rest: createRest(unreadableFixture) },
      ),
    "DEPENDENCY_FAILED",
    null,
    "a counter that cannot answer is a failure, never a pass",
  );

  // ---- the sources: what the routes, the page and the migration must say
  const acceptanceRoute = await readFile(
    new URL("./i/[token]/acceptance/route.ts", import.meta.url),
    "utf8",
  );
  const fulfilmentRoute = await readFile(new URL("./i/[token]/fulfilment/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("./i/[token]/page.tsx", import.meta.url), "utf8");
  const migration = await readFile(new URL("../../migrations/0122_invoice_fulfilment_evidence.sql", import.meta.url), "utf8");
  const rollback = await readFile(
    new URL("../../migrations/0122_invoice_fulfilment_evidence.down.sql", import.meta.url),
    "utf8",
  );

  expect(acceptanceRoute.includes("requireCsrfToken("), "the confirmation route checks the CSRF token");
  expect(
    acceptanceRoute.indexOf("requireCsrfToken(") < acceptanceRoute.indexOf("enforcePortalAcceptanceRateLimit("),
    "and checks it before it spends a counter",
  );
  expect(
    acceptanceRoute.indexOf("enforcePortalAcceptanceRateLimit(") < acceptanceRoute.indexOf("request.text()"),
    "and spends the counter before it reads the body",
  );
  expect(
    acceptanceRoute.includes("PORTAL_EVIDENCE_MAXIMUM_BODY_BYTES"),
    "the confirmation route caps the body",
  );
  expect(acceptanceRoute.includes("readClientAddress("), "and reads the address from the request");
  expect(
    acceptanceRoute.includes("readRequestActorOptionally("),
    "and resolves whichever session the request carries, so a seller cannot confirm their own invoice",
  );
  expect(
    !acceptanceRoute.includes("body.document_hash"),
    "and never takes a digest from the body",
  );

  expect(fulfilmentRoute.includes("requireCsrfToken("), "the delivery route checks the CSRF token");
  expect(fulfilmentRoute.includes("readRequestActor("), "and resolves the merchant's session");
  expect(page.includes('"use server"') === false, "the page is a page, not a server action");
  expect(page.includes('export const dynamic = "force-dynamic"'), "the page is never cached");
  expect(page.includes("nocache: true"), "and asks a crawler to keep it out of an index");

  for (const table of ["invoice_fulfilment_evidence", "invoice_acceptances"]) {
    expect(
      migration.includes(`create table public.${table} (`),
      `0122 creates ${table}`,
    );
    expect(
      migration.includes(`alter table public.${table} enable row level security;`),
      `${table} is row level secured`,
    );
    expect(
      migration.includes(`create policy ${table}_default_deny`),
      `${table} is default deny`,
    );
    expect(
      rollback.includes(`drop table if exists public.${table};`),
      `the rollback drops ${table}`,
    );
  }

  for (const trigger of [
    "invoice_acceptances_guard_append_only",
    "invoice_acceptances_guard_evidence",
    "invoice_fulfilment_evidence_guard",
    "invoice_release_evidence_ok",
  ]) {
    expect(migration.includes(`public.${trigger}`), `0122 defines ${trigger}`);
    expect(rollback.includes(`public.${trigger}`), `and the rollback removes ${trigger}`);
  }

  expect(
    /update\s+public[.]invoices/iu.test(migration) === false,
    "0122 never writes onto an existing invoice",
  );
  expect(
    /update\s+public[.]payments/iu.test(migration) === false,
    "and never writes onto a payment",
  );

  if (failures.length > 0) {
    process.stderr.write(`portal invoice gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `portal invoice gate passed: ${checkCount} checks, ${INVOICE_STATUSES.length} statuses folded, ` +
      `2 evidence tables, one confirmation per invoice\n`,
  );
}

await main();
