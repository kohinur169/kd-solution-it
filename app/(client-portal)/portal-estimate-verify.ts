// path: app/(client-portal)/portal-estimate-verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { isAppError } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import { mintPortalToken, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { hashEstimateDocument } from "../../services/estimates/estimate-signature.ts";
import { ESTIMATE_DOCUMENT_HASH_PATTERN } from "../../services/estimates/estimate-signature-fields.ts";
import {
  isPortalEstimateDecision,
  PORTAL_ESTIMATE_ACCEPTED_AUDIT_ACTION,
  PORTAL_ESTIMATE_CONSENT_KEY,
  PORTAL_ESTIMATE_DECLINED_AUDIT_ACTION,
  PORTAL_ESTIMATE_DOCUMENT_HASH_ENCODING,
  PORTAL_ESTIMATE_EXPIRED_AUDIT_ACTION,
  PORTAL_ESTIMATE_LIMITS,
  PORTAL_ESTIMATE_MAXIMUM_BODY_BYTES,
  PORTAL_ESTIMATE_OPEN_STATUSES,
  PORTAL_ESTIMATE_RULES,
  PORTAL_ESTIMATE_STATES,
  PORTAL_ESTIMATE_VOID_REASONS,
  PORTAL_SIGNATURE_RATE_LIMIT,
} from "./portal-estimate-fields.ts";
import {
  applyPortalEstimateExpiry,
  applyPortalEstimateView,
  decidePortalEstimate,
  parsePortalEstimateDecision,
  type PortalEstimateDependencies,
} from "./portal-estimate-decision.ts";
import { openPortalEstimate, portalEstimateStateOf } from "./portal-estimate.ts";
import { enforcePortalRateLimit, portalRateLimitHeaders } from "./portal-rate-limit.ts";

/**
 * The gate for STEP 182: the tokenized estimate page, its signature and the two voids around it.
 *
 * ## What this proves without a database
 *
 * There is no PostgreSQL in this sandbox, so the fixture below *is* the database, and its rules are
 * transcribed from `0025`, `0026` and `0027` rather than from the modules under test - a fixture written
 * from the service agrees with the service by construction and proves nothing. The fake rest client is a
 * small PostgREST: it applies the equality filters of a query string, `is.null`, `in.(...)` and `limit`,
 * parses every row through the schema the caller passed, and refuses a query that names no tenant, which
 * is the one mistake a portal read must never make.
 *
 * ## What it exercises
 *
 *   - the fold: `0025`'s five statuses and `void`'s three reasons into the six states a client meets, and
 *     the refusal of a row this page will not describe - a `void` without a reason, or a status outside
 *     the five;
 *   - the link: an estimate token verifies, a token of the wrong kind or the wrong capability does not, an
 *     expired token does not, and a quote that is deleted, foreign or missing answers the same refusal;
 *   - the two voids section 16 asks for: **declining** writes `void` with `void_reason = 'declined'`, and
 *     **expiry** writes `void` with `void_reason = 'expired'`, both with `voided_at`, both audited once,
 *     both refused a second time;
 *   - the acceptance: the evidence row `0027` describes - name, email, consent wording, consent, time, IP,
 *     location, device fingerprint, document digest - written by STEP 022's service and then applied to the
 *     quote by this STEP's, with the digest computed from the document rather than taken from the body;
 *   - every refusal a client, a merchant or an attacker can produce: not issued, expired, already accepted,
 *     already declined, withdrawn, a stale version, a merchant deciding their own quote, an unticked
 *     consent, a malformed address, an oversized name, a body that tries to send its own digest or its own
 *     drawn signature;
 *   - the security shape of the route, the page and the components, read as source: CSRF before the rate
 *     limit, the rate limit before the body, the byte ceiling, `force-dynamic`, `noindex`, the form only
 *     when the offer is open, and no write anywhere but onto `estimates` itself.
 *
 * ## Why there is no migration check here
 *
 * The structure gate already refuses a forbidden marker in any file, so this gate does not restate it.
 *
 * STEP 182 adds no table and no column. `0025` already carries `void_reason`, `voided_at` and
 * `accepted_at`; `0027` already carries the eight pieces of evidence with a unique index on
 * `estimate_id`; `0118` already freezes a terminal quote. The gate proves that by reading those
 * migrations and asserting the columns and the guard it depends on, which is cheaper and more honest than
 * a `0123` that would add nothing.
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

/** The filters of a PostgREST query string: `key=eq.value`, `key=is.null`, `key=in.(...)`, `limit=N`. */
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

    // PostgREST compares the text of a column, so `version=eq.3` matches the number three: the fake
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
        arguments_["p_scope"] !== "portal_signature" ||
        typeof arguments_["p_key_hash"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(String(arguments_["p_key_hash"])) ||
        arguments_["p_limit"] !== 10 ||
        arguments_["p_window_seconds"] !== 600
      ) {
        throw new Error("the signature counter was called with the wrong policy");
      }

      return fixture.rateLimitAnswer === null ? [] : [fixture.rateLimitAnswer];
    },
  };
}

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const estimateId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const signatureId = "55555555-5555-4555-8555-555555555555";
const keys: PortalTokenKeys = { primary: Buffer.alloc(32, 7).toString("base64") };
const nowMs = Date.parse("2026-11-07T09:30:00.000Z");
const nowSeconds = Math.floor(nowMs / 1_000);
const consentSentence = getMessage(PORTAL_ESTIMATE_CONSENT_KEY);

/** The quote a link names: two hours of work, 250.0000 in total, open for another thirteen days. */
function estimateRow(overrides: Row = {}): Row {
  return {
    id: estimateId,
    company_id: companyId,
    client_id: clientId,
    number: "EST-0021",
    status: "sent",
    void_reason: null,
    currency: "USD",
    subtotal_minor: "250000",
    discount_minor: "0",
    discount_basis: "none",
    discount_percent_bp: 0,
    tax_minor: "0",
    total_minor: "250000",
    client_name: "Acme Trading",
    client_email: "billing@acme.test",
    client_address: "9 Harbour Road\nDhaka",
    memo: "Website refresh",
    issued_at: "2026-11-05T00:00:00.000Z",
    expires_at: "2026-11-20T00:00:00.000Z",
    accepted_at: null,
    voided_at: null,
    converted_invoice_id: null,
    created_at: "2026-11-05T00:00:00.000Z",
    updated_at: "2026-11-05T00:00:00.000Z",
    deleted_at: null,
    version: 3,
    ...overrides,
  };
}

function itemRow(position: number, description: string, unitPriceMinor: string, lineTotal: string): Row {
  return {
    id: randomUUID(),
    company_id: companyId,
    estimate_id: estimateId,
    position,
    description,
    unit: "hour",
    quantity: "2.500",
    unit_price_minor: unitPriceMinor,
    discount_minor: "0",
    line_total_minor: lineTotal,
    product_id: null,
    service_id: null,
    created_at: "2026-11-05T00:00:00.000Z",
    updated_at: "2026-11-05T00:00:00.000Z",
    deleted_at: null,
    version: 1,
  };
}

function signatureRow(overrides: Row = {}): Row {
  return {
    id: signatureId,
    company_id: companyId,
    estimate_id: estimateId,
    decision: "accepted",
    signer_name: "Rina Chowdhury",
    signer_email: "rina@acme.test",
    consent_text: consentSentence,
    consent_accepted: true,
    signed_at: "2026-11-06T10:00:00.000Z",
    ip: "203.0.113.9",
    geo_location: "Asia/Dhaka",
    device_fingerprint: "web/abc1234567890abc",
    document_hash: "a".repeat(64),
    signature_path: null,
    created_at: "2026-11-06T10:00:00.000Z",
    updated_at: "2026-11-06T10:00:00.000Z",
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

function fixtureWith(
  rows: { readonly quotes: readonly Row[]; readonly lines?: readonly Row[]; readonly decisions?: readonly Row[] },
): Fixture {
  const fixture = createFixture();

  fixture.tables.set("estimates", rows.quotes.map((row) => ({ ...row })));
  fixture.tables.set("estimate_items", (rows.lines ?? []).map((row) => ({ ...row })));
  fixture.tables.set("estimate_signatures", (rows.decisions ?? []).map((row) => ({ ...row })));

  return fixture;
}

/** The two lines every fixture quote has, so the digest is over a real document. */
function linesOf(): readonly Row[] {
  return [itemRow(1, "Discovery workshop", "80000", "200000"), itemRow(2, "Handover call", "20000", "50000")];
}

function dependenciesOf(
  fixture: Fixture,
  audit: InMemoryAuditTrail = createInMemoryAuditTrail(),
  now: number = nowMs,
): PortalEstimateDependencies {
  return { rest: createRest(fixture), audit, tokenKeys: keys, now: () => now };
}

function tokenOf(overrides: { readonly capability?: string; readonly kind?: string; readonly companyId?: string } = {}): string {
  return mintPortalToken(
    {
      kind: (overrides.kind ?? "estimate") as "estimate",
      companyId: overrides.companyId ?? companyId,
      resourceId: estimateId,
      capability: (overrides.capability ?? "sign") as "sign",
      lifetimeSeconds: 604_800,
    },
    { keys, now: nowSeconds - 3_600 },
  );
}

/** One field of a fixture row, as text: the fixture holds JSON, and a gate compares print. */
function fieldOf(row: Row | undefined, key: string): string {
  const value = row?.[key];

  return value === null || value === undefined ? "" : String(value);
}

/** A body the form would send, which the gate then edits one field at a time. */
function bodyOf(overrides: Row = {}): Row {
  return {
    decision: "accepted",
    signer_name: "Rina Chowdhury",
    signer_email: "rina@acme.test",
    consent_accepted: true,
    device_fingerprint: "web/abc1234567890abc",
    geo_location: "Asia/Dhaka",
    ...overrides,
  };
}

async function main(): Promise<void> {
  // ---- the vocabulary: six states, two decisions, three reasons, no second copy of a limit
  expectEqual(PORTAL_ESTIMATE_STATES.length, 6, "six client facing states");
  expect(
    ["not_issued", "open", "accepted", "declined", "expired", "withdrawn"].every((state) =>
      (PORTAL_ESTIMATE_STATES as readonly string[]).includes(state),
    ),
    "and the six are the ones the page renders",
  );
  expectEqual(PORTAL_ESTIMATE_OPEN_STATUSES.length, 2, "two statuses are open for a decision");
  expectEqual(
    (PORTAL_ESTIMATE_OPEN_STATUSES as readonly string[]).join(","),
    "sent,viewed",
    "and they are `sent` and `viewed`",
  );
  expectEqual(PORTAL_ESTIMATE_VOID_REASONS.length, 3, "three reasons end a quote");
  expect(isPortalEstimateDecision("accepted"), "`accepted` is a decision");
  expect(isPortalEstimateDecision("declined"), "`declined` is a decision");
  expect(!isPortalEstimateDecision("maybe"), "and `maybe` is not");
  expect(!isPortalEstimateDecision(1), "nor is a number");
  expectEqual(PORTAL_ESTIMATE_LIMITS.signerName.max, 160, "a name is held to the column's 160");
  expectEqual(PORTAL_ESTIMATE_LIMITS.signerEmail.max, 254, "an address to the column's 254");
  expectEqual(PORTAL_ESTIMATE_LIMITS.geoLocation.max, 200, "a location to the column's 200");
  expectEqual(PORTAL_ESTIMATE_MAXIMUM_BODY_BYTES, 4_096, "the body ceiling is four kilobytes");
  expectEqual(PORTAL_SIGNATURE_RATE_LIMIT.scope, "portal_signature", "the signature has its own counter");
  expectEqual(PORTAL_SIGNATURE_RATE_LIMIT.limit, 10, "ten attempts");
  expectEqual(PORTAL_SIGNATURE_RATE_LIMIT.windowSeconds, 600, "in ten minutes");
  expectEqual(
    PORTAL_ESTIMATE_DOCUMENT_HASH_ENCODING,
    "kd-estimate-document-hash/1",
    "the digest is STEP 022's encoding, not a second one",
  );
  expectEqual(PORTAL_ESTIMATE_CONSENT_KEY, "portal.signatureConsent", "the consent is a catalog key");
  expect(consentSentence.length > 40, "and the sentence behind it is a real sentence");
  expect(consentSentence === consentSentence.trim(), "with no padding to store");
  expect(
    consentSentence.includes("{") === false && consentSentence.includes("}") === false,
    "and no placeholder a signer would be shown literally",
  );

  // ---- the fold: five statuses and three reasons into six states, and nothing guessed
  expectEqual(portalEstimateStateOf("draft", null), "not_issued", "a draft is not issued");
  expectEqual(portalEstimateStateOf("sent", null), "open", "a sent quote is open");
  expectEqual(portalEstimateStateOf("viewed", null), "open", "a viewed quote is open");
  expectEqual(portalEstimateStateOf("accepted", null), "accepted", "an accepted quote is accepted");
  expectEqual(
    portalEstimateStateOf("void", "declined"),
    "declined",
    "a void quote the client declined is declined",
  );
  expectEqual(portalEstimateStateOf("void", "expired"), "expired", "a void quote that ran out expired");
  expectEqual(
    portalEstimateStateOf("void", "withdrawn"),
    "withdrawn",
    "a void quote the merchant withdrew is withdrawn",
  );
  expectEqual(portalEstimateStateOf("void", null), null, "a void without a reason is refused");
  expectEqual(portalEstimateStateOf("void", "cancelled"), null, "and so is a reason `0025` cannot hold");
  expectEqual(portalEstimateStateOf("signed", null), null, "a status outside the five is refused");

  // ---- the link: a token of the wrong kind, capability or lifetime opens nothing
  await expectRefusal(
    () =>
      openPortalEstimate({ token: tokenOf({ capability: "view" }) }, dependenciesOf(fixtureWith({ quotes: [estimateRow()] }))),
    "RESOURCE_NOT_FOUND",
    null,
    "a link without the `sign` capability cannot open the page",
  );
  await expectRefusal(
    () =>
      openPortalEstimate(
        { token: tokenOf({ kind: "invoice", capability: "pay", companyId }) },
        dependenciesOf(fixtureWith({ quotes: [estimateRow()] })),
      ),
    "RESOURCE_NOT_FOUND",
    null,
    "and a link minted for an invoice cannot either",
  );
  await expectRefusal(
    () =>
      openPortalEstimate(
        {
          token: mintPortalToken(
            { kind: "estimate", companyId, resourceId: estimateId, capability: "sign", lifetimeSeconds: 300 },
            { keys, now: nowSeconds - 3_600 },
          ),
        },
        dependenciesOf(fixtureWith({ quotes: [estimateRow()] })),
      ),
    "RESOURCE_NOT_FOUND",
    null,
    "a token whose lifetime has passed opens nothing",
  );
  await expectRefusal(
    () =>
      openPortalEstimate(
        { token: tokenOf() },
        dependenciesOf(
          fixtureWith({ quotes: [estimateRow({ id: "99999999-9999-4999-8999-999999999999" })] }),
        ),
      ),
    "RESOURCE_NOT_FOUND",
    null,
    "a link naming a quote that is not there opens nothing",
  );
  await expectRefusal(
    () =>
      openPortalEstimate(
        { token: tokenOf() },
        dependenciesOf(fixtureWith({ quotes: [estimateRow({ company_id: otherCompanyId })] })),
      ),
    "RESOURCE_NOT_FOUND",
    null,
    "a quote belonging to another merchant opens nothing",
  );
  await expectRefusal(
    () =>
      openPortalEstimate(
        { token: tokenOf() },
        dependenciesOf(fixtureWith({ quotes: [estimateRow({ deleted_at: "2026-11-06T00:00:00.000Z" })] })),
      ),
    "RESOURCE_NOT_FOUND",
    null,
    "a soft deleted quote opens nothing",
  );
  await expectRefusal(
    () =>
      openPortalEstimate(
        { token: tokenOf() },
        dependenciesOf(fixtureWith({ quotes: [estimateRow({ status: "void", void_reason: null })] })),
      ),
    "RESOURCE_NOT_FOUND",
    null,
    "a void quote with no reason is not described by this page",
  );

  // ---- the read model: what an open, a draft and an expired quote look like
  const openFixture = fixtureWith({ quotes: [estimateRow()], lines: linesOf() });
  const openView = await openPortalEstimate({ token: tokenOf() }, dependenciesOf(openFixture));

  expectEqual(openView.state, "open", "a sent quote opens as open");
  expectEqual(openView.open, true, "and this link may decide it");
  expectEqual(openView.expired, false, "and it is inside its lifetime");
  expectEqual(openView.signature, null, "with no decision recorded");
  expectEqual(openView.estimate.number, "EST-0021", "the document carries its number");
  expectEqual(openView.estimate.totals.totalMinor, "250000", "and its exact total in minor units");
  expectEqual(openView.estimate.lines.length, 2, "and both of its lines");
  expectEqual(openView.tokenId.length > 0, true, "the view names the link it was opened by");
  expect(
    ESTIMATE_DOCUMENT_HASH_PATTERN.test(openView.documentHash),
    "the page's digest is the shape `0027` stores",
  );
  expectEqual(
    openView.documentHash,
    hashEstimateDocument(openView.estimate),
    "and it is the digest of the document the page prints",
  );
  expect(
    openFixture.queries.every((query) => query.includes("company_id=eq.")),
    "every read of a tokenized link is tenant scoped",
  );
  expect(
    openFixture.queries.filter((query) => query.startsWith("estimates?")).length === 1,
    "the quote is read exactly once",
  );

  const draftView = await openPortalEstimate(
    { token: tokenOf() },
    dependenciesOf(fixtureWith({ quotes: [estimateRow({ status: "draft", number: null })] })),
  );

  expectEqual(draftView.state, "not_issued", "a draft is answered, not refused");
  expectEqual(draftView.open, false, "and offers no decision");
  expectEqual(draftView.estimate.number, null, "with no number, because it has none yet");

  const pastFixture = fixtureWith({
    quotes: [estimateRow({ expires_at: "2026-11-06T00:00:00.000Z" })],
    lines: linesOf(),
  });
  const pastView = await openPortalEstimate({ token: tokenOf() }, dependenciesOf(pastFixture));

  expectEqual(pastView.expired, true, "a quote past `expires_at` is expired the moment the clock passes it");
  expectEqual(pastView.open, false, "and offers no decision");
  expectEqual(pastView.state, "open", "even though the stored status has not caught up yet");
  expect(
    pastFixture.updates.length === 0,
    "a read alone writes nothing: expiry is applied by the page and the decision, not by the opener",
  );

  const decidedView = await openPortalEstimate(
    { token: tokenOf() },
    dependenciesOf(fixtureWith({ quotes: [estimateRow({ status: "accepted" })], decisions: [signatureRow()] })),
  );

  expectEqual(decidedView.state, "accepted", "an accepted quote prints its state");
  expectEqual(decidedView.open, false, "and cannot be decided again");
  expectEqual(decidedView.signature?.signerName, "Rina Chowdhury", "with the signer's name");
  expectEqual(decidedView.signature?.hasDrawnSignature, false, "and no drawn signature this page never stored");

  // ---- expiry: the void section 16 asks for, written once and scoped by version
  const expiryFixture = fixtureWith({
    quotes: [estimateRow({ expires_at: "2026-11-06T00:00:00.000Z" })],
    lines: linesOf(),
  });
  const expiryTrail = createInMemoryAuditTrail();
  const expiryDependencies = dependenciesOf(expiryFixture, expiryTrail);
  const beforeExpiry = await openPortalEstimate({ token: tokenOf() }, expiryDependencies);
  const afterExpiry = await applyPortalEstimateExpiry(
    { token: tokenOf(), view: beforeExpiry },
    expiryDependencies,
  );

  expectEqual(afterExpiry.state, "expired", "opening an expired quote voids it");
  expectEqual(
    expiryFixture.tables.get("estimates")?.[0]?.["status"],
    "void",
    "and stores the terminal status",
  );
  expectEqual(
    expiryFixture.tables.get("estimates")?.[0]?.["void_reason"],
    "expired",
    "with `void_reason = 'expired'`, the reason section 16 names",
  );
  expect(
    typeof expiryFixture.tables.get("estimates")?.[0]?.["voided_at"] === "string",
    "and the instant it was voided",
  );
  expectEqual(expiryFixture.updates.length, 1, "exactly one write");
  expectEqual(expiryFixture.updates[0]?.table, "estimates", "onto the quote and nothing else");
  expect(
    expiryFixture.updates[0]?.query.includes("version=eq.3") === true,
    "guarded by the version the page read",
  );
  expect(
    expiryFixture.updates[0]?.query.includes("status=in.(sent,viewed)") === true,
    "and by the two statuses a decision is still possible in",
  );
  expectEqual(expiryTrail.entries.length, 1, "the void is audited once");
  expectEqual(
    expiryTrail.entries[0]?.action,
    PORTAL_ESTIMATE_EXPIRED_AUDIT_ACTION,
    "under the expiry action",
  );
  expectEqual(
    String(expiryTrail.entries[0]?.payload["document_hash"] ?? ""),
    beforeExpiry.documentHash,
    "and it carries the digest of the offer that expired",
  );

  await applyPortalEstimateExpiry({ token: tokenOf(), view: afterExpiry }, expiryDependencies);

  expectEqual(expiryFixture.updates.length, 1, "a second visit to an expired quote writes nothing");
  expectEqual(expiryTrail.entries.length, 1, "and audits nothing");

  const insideFixture = fixtureWith({ quotes: [estimateRow()], lines: linesOf() });
  const insideDependencies = dependenciesOf(insideFixture);
  const insideView = await openPortalEstimate({ token: tokenOf() }, insideDependencies);

  await applyPortalEstimateExpiry({ token: tokenOf(), view: insideView }, insideDependencies);

  expectEqual(insideFixture.updates.length, 0, "a quote inside its lifetime is not voided");

  const acceptedLateFixture = fixtureWith({
    quotes: [estimateRow({ status: "accepted", expires_at: "2026-11-06T00:00:00.000Z" })],
    lines: linesOf(),
  });
  const acceptedLateTrail = createInMemoryAuditTrail();
  const acceptedLateDependencies = dependenciesOf(acceptedLateFixture, acceptedLateTrail);
  const acceptedLateView = await openPortalEstimate({ token: tokenOf() }, acceptedLateDependencies);

  expectEqual(acceptedLateView.state, "accepted", "an accepted quote is never re-read as expired");
  await applyPortalEstimateExpiry({ token: tokenOf(), view: acceptedLateView }, acceptedLateDependencies);
  expectEqual(acceptedLateFixture.updates.length, 0, "and the clock cannot void it afterwards");
  expectEqual(acceptedLateTrail.entries.length, 0, "so nothing is audited");

  const raceFixture = fixtureWith({
    quotes: [estimateRow({ expires_at: "2026-11-06T00:00:00.000Z" })],
    lines: linesOf(),
  });
  const raceTrail = createInMemoryAuditTrail();
  const raceDependencies = dependenciesOf(raceFixture, raceTrail);
  const raceView = await openPortalEstimate({ token: tokenOf() }, raceDependencies);

  // Another visitor moved the quote between this page's read and its write: the update matches nothing,
  // and the loser must not claim the void.
  const raceRow = raceFixture.tables.get("estimates")?.[0];

  if (raceRow !== undefined) {
    raceRow["version"] = 9;
    raceRow["status"] = "viewed";
  }

  const raceAfter = await applyPortalEstimateExpiry({ token: tokenOf(), view: raceView }, raceDependencies);

  expectEqual(
    raceAfter.state,
    "open",
    "a page that lost the expiry race answers the state the winner left",
  );
  expectEqual(raceTrail.entries.filter((entry) => entry.action === PORTAL_ESTIMATE_EXPIRED_AUDIT_ACTION).length, 0, "and records no void it did not write");

  // ---- the view: `sent` becomes `viewed` once, and a page that cannot write it still renders
  const viewFixture = fixtureWith({ quotes: [estimateRow()], lines: linesOf() });
  const viewTrail = createInMemoryAuditTrail();
  const viewDependencies = dependenciesOf(viewFixture, viewTrail);
  const sentView = await openPortalEstimate({ token: tokenOf() }, viewDependencies);

  await applyPortalEstimateView(sentView, viewDependencies);

  expectEqual(viewFixture.updates.length, 1, "opening a sent quote records the view");
  expectEqual(viewFixture.updates[0]?.values["status"], "viewed", "as the status `0025` has for it");
  expectEqual(viewTrail.entries.length, 1, "and audits it once");
  expectEqual(viewTrail.entries[0]?.action, "portal.estimate_viewed", "under the view action");
  expectEqual(viewTrail.entries[0]?.payload["number"], "EST-0021", "naming the quote");

  await applyPortalEstimateView(await openPortalEstimate({ token: tokenOf() }, viewDependencies), viewDependencies);

  expectEqual(viewFixture.updates.length, 1, "a quote already viewed is not written again");
  expectEqual(viewTrail.entries.length, 1, "and not audited again");

  const acceptedViewFixture = fixtureWith({ quotes: [estimateRow({ status: "accepted" })], lines: linesOf() });
  const acceptedViewDependencies = dependenciesOf(acceptedViewFixture);
  const acceptedView = await openPortalEstimate({ token: tokenOf() }, acceptedViewDependencies);

  await applyPortalEstimateView(acceptedView, acceptedViewDependencies);

  expectEqual(acceptedViewFixture.updates.length, 0, "a decided quote is never marked as viewed");

  const brokenRest: RestClient = {
    ...createRest(viewFixture),
    async update(): Promise<void> {
      throw new Error("the database is down");
    },
  };
  const brokenTrail = createInMemoryAuditTrail();

  await applyPortalEstimateView(
    sentView,
    { rest: brokenRest, audit: brokenTrail, tokenKeys: keys, now: () => nowMs },
  ).then(
    () => expect(true, "a view that cannot be written is tolerated: the client came to read an offer"),
    () => expect(false, "a view that cannot be written is tolerated"),
  );
  expectEqual(brokenTrail.entries.length, 0, "and nothing is audited for a write that did not land");

  // ---- the acceptance: section 16's evidence, and the status it implies
  const acceptFixture = fixtureWith({ quotes: [estimateRow()], lines: linesOf() });
  const acceptTrail = createInMemoryAuditTrail();
  const acceptDependencies = dependenciesOf(acceptFixture, acceptTrail);
  const beforeAccept = await openPortalEstimate({ token: tokenOf() }, acceptDependencies);
  const accepted = await decidePortalEstimate(
    {
      token: tokenOf(),
      body: bodyOf(),
      clientAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (fixture)",
      actorCompanyId: null,
    },
    acceptDependencies,
  );

  expectEqual(accepted.decision, "accepted", "an acceptance answers its decision");
  expectEqual(accepted.state, "accepted", "and the state it produced");
  expectEqual(accepted.documentHash, beforeAccept.documentHash, "over the document the client was shown");
  expectEqual(
    acceptFixture.tables.get("estimates")?.[0]?.["status"],
    "accepted",
    "the quote is accepted",
  );
  expect(
    typeof acceptFixture.tables.get("estimates")?.[0]?.["accepted_at"] === "string",
    "with the instant it was accepted",
  );
  expectEqual(
    acceptFixture.tables.get("estimates")?.[0]?.["void_reason"],
    null,
    "and no void reason",
  );
  expectEqual(
    acceptFixture.updates.filter((update) => update.table !== "estimates").length,
    0,
    "this STEP writes no table but the quote",
  );

  const evidence = acceptFixture.tables.get("estimate_signatures")?.[0];

  expectEqual(fieldOf(evidence, "decision"), "accepted", "the evidence records the decision");
  expectEqual(fieldOf(evidence, "signer_name"), "Rina Chowdhury", "and the signer's name");
  expectEqual(fieldOf(evidence, "signer_email"), "rina@acme.test", "and their address");
  expectEqual(fieldOf(evidence, "consent_text"), consentSentence, "and the consent wording the client ticked");
  expect(evidence?.["consent_accepted"] === true, "and that they ticked it");
  expectEqual(fieldOf(evidence, "ip"), "203.0.113.9", "and the address of the request");
  expectEqual(fieldOf(evidence, "geo_location"), "Asia/Dhaka", "and the location");
  expectEqual(fieldOf(evidence, "device_fingerprint"), "web/abc1234567890abc", "and the device fingerprint");
  expectEqual(fieldOf(evidence, "document_hash"), beforeAccept.documentHash, "and the digest of the offer");
  expect(evidence?.["signature_path"] === null, "with no drawn signature, because none was sent");
  expect(fieldOf(evidence, "signed_at").endsWith("Z"), "and the instant, as UTC");
  expectEqual(accepted.signatureId, fieldOf(evidence, "id"), "the answer names the row that was written");
  expectEqual(acceptTrail.entries.length, 2, "two entries: STEP 022's evidence and this STEP's transition");
  expectEqual(
    acceptTrail.entries[0]?.action,
    "estimate.signature_recorded",
    "the evidence entry comes first",
  );
  expectEqual(
    acceptTrail.entries[1]?.action,
    PORTAL_ESTIMATE_ACCEPTED_AUDIT_ACTION,
    "and the transition second",
  );
  expectEqual(
    String(acceptTrail.entries[1]?.payload["signature_id"] ?? ""),
    fieldOf(evidence, "id"),
    "the transition names the signature",
  );
  expect(acceptTrail.entries[1]?.payload["void_reason"] === null, "and that nothing was voided");
  expectEqual(acceptTrail.entries[1]?.ipAddress, "203.0.113.9", "and carries the request's address");
  expectEqual(
    acceptTrail.entries[1]?.payload["signer_name"],
    undefined,
    "while the audit entry keeps no personal data",
  );

  // ---- the decline: the other void section 16 names
  const declineFixture = fixtureWith({ quotes: [estimateRow()], lines: linesOf() });
  const declineTrail = createInMemoryAuditTrail();
  const declined = await decidePortalEstimate(
    {
      token: tokenOf(),
      body: bodyOf({ decision: "declined" }),
      clientAddress: "198.51.100.4",
      userAgent: null,
      actorCompanyId: otherCompanyId,
    },
    dependenciesOf(declineFixture, declineTrail),
  );

  expectEqual(declined.decision, "declined", "a decline answers its decision");
  expectEqual(declined.state, "declined", "and the state it produced");
  expectEqual(declineFixture.tables.get("estimates")?.[0]?.["status"], "void", "declining voids the quote");
  expectEqual(
    declineFixture.tables.get("estimates")?.[0]?.["void_reason"],
    "declined",
    "with `void_reason = 'declined'`",
  );
  expect(
    typeof declineFixture.tables.get("estimates")?.[0]?.["voided_at"] === "string",
    "and the instant it ended",
  );
  expectEqual(
    declineFixture.tables.get("estimates")?.[0]?.["accepted_at"],
    null,
    "and it is not accepted",
  );
  expectEqual(
    fieldOf(declineFixture.tables.get("estimate_signatures")?.[0], "decision"),
    "declined",
    "the evidence records the decline",
  );
  expectEqual(
    declineTrail.entries[1]?.action,
    PORTAL_ESTIMATE_DECLINED_AUDIT_ACTION,
    "and the transition is audited as a decline",
  );
  expectEqual(
    declineTrail.entries[1]?.payload["void_reason"],
    "declined",
    "with the reason it wrote",
  );

  // ---- the refusals: what a decided, expired or foreign quote answers
  await expectRefusal(
    () =>
      decidePortalEstimate(
        { token: tokenOf(), body: bodyOf(), clientAddress: "203.0.113.9", userAgent: null, actorCompanyId: null },
        dependenciesOf(fixtureWith({ quotes: [estimateRow({ status: "accepted" })], lines: linesOf(), decisions: [signatureRow()] })),
      ),
    "CONFLICT",
    PORTAL_ESTIMATE_RULES.alreadyAccepted,
    "an accepted quote cannot be decided again",
  );
  await expectRefusal(
    () =>
      decidePortalEstimate(
        {
          token: tokenOf(),
          body: bodyOf({ decision: "declined" }),
          clientAddress: "203.0.113.9",
          userAgent: null,
          actorCompanyId: null,
        },
        dependenciesOf(
          fixtureWith({
            quotes: [estimateRow({ status: "void", void_reason: "declined" })],
            lines: linesOf(),
            decisions: [signatureRow({ decision: "declined" })],
          }),
        ),
      ),
    "CONFLICT",
    PORTAL_ESTIMATE_RULES.alreadyDeclined,
    "nor a declined one",
  );
  await expectRefusal(
    () =>
      decidePortalEstimate(
        { token: tokenOf(), body: bodyOf(), clientAddress: "203.0.113.9", userAgent: null, actorCompanyId: null },
        dependenciesOf(
          fixtureWith({ quotes: [estimateRow({ status: "void", void_reason: "withdrawn" })], lines: linesOf() }),
        ),
      ),
    "CONFLICT",
    PORTAL_ESTIMATE_RULES.withdrawn,
    "nor one the merchant withdrew",
  );
  await expectRefusal(
    () =>
      decidePortalEstimate(
        { token: tokenOf(), body: bodyOf(), clientAddress: "203.0.113.9", userAgent: null, actorCompanyId: null },
        dependenciesOf(fixtureWith({ quotes: [estimateRow({ status: "draft", number: null })] })),
      ),
    "CONFLICT",
    PORTAL_ESTIMATE_RULES.notIssued,
    "a draft cannot be signed",
  );

  const expiredRefusalFixture = fixtureWith({
    quotes: [estimateRow({ expires_at: "2026-11-06T00:00:00.000Z" })],
    lines: linesOf(),
  });
  const expiredRefusalTrail = createInMemoryAuditTrail();

  await expectRefusal(
    () =>
      decidePortalEstimate(
        { token: tokenOf(), body: bodyOf(), clientAddress: "203.0.113.9", userAgent: null, actorCompanyId: null },
        dependenciesOf(expiredRefusalFixture, expiredRefusalTrail),
      ),
    "CONFLICT",
    PORTAL_ESTIMATE_RULES.expired,
    "a quote whose lifetime passed refuses the decision",
  );
  expectEqual(
    expiredRefusalFixture.tables.get("estimates")?.[0]?.["void_reason"],
    "expired",
    "and the refusal still voids it, so the stored status catches up with the clock",
  );
  expectEqual(
    expiredRefusalFixture.tables.get("estimate_signatures")?.length,
    0,
    "while no evidence is written for a decision that was refused",
  );
  expectEqual(expiredRefusalTrail.entries.length, 1, "and only the expiry is audited");
  expectEqual(
    expiredRefusalTrail.entries[0]?.action,
    PORTAL_ESTIMATE_EXPIRED_AUDIT_ACTION,
    "under the expiry action",
  );

  await expectRefusal(
    () =>
      decidePortalEstimate(
        { token: tokenOf(), body: bodyOf(), clientAddress: "203.0.113.9", userAgent: null, actorCompanyId: companyId },
        dependenciesOf(fixtureWith({ quotes: [estimateRow()], lines: linesOf() })),
      ),
    "CONFLICT",
    PORTAL_ESTIMATE_RULES.selfDecision,
    "the merchant who sent the offer cannot sign it",
  );

  await expectRefusal(
    () =>
      decidePortalEstimate(
        { token: tokenOf(), body: bodyOf(), clientAddress: "203.0.113.9", userAgent: null, actorCompanyId: null },
        dependenciesOf(
          fixtureWith({ quotes: [estimateRow()], lines: linesOf(), decisions: [signatureRow()] }),
        ),
      ),
    "CONFLICT",
    PORTAL_ESTIMATE_RULES.staleVersion,
    "an offer whose evidence already exists is not decided twice",
  );

  // A status write that matches nothing - the winner moved the quote between the read and the update.
  const staleFixture = fixtureWith({ quotes: [estimateRow()], lines: linesOf() });
  const staleDependencies: PortalEstimateDependencies = {
    rest: {
      ...createRest(staleFixture),
      async update(table: string, query: string, values: Row): Promise<void> {
        if (table === "estimates") {
          return;
        }

        await createRest(staleFixture).update(table, query, values);
      },
    },
    audit: createInMemoryAuditTrail(),
    tokenKeys: keys,
    now: () => nowMs,
  };

  await expectRefusal(
    () =>
      decidePortalEstimate(
        { token: tokenOf(), body: bodyOf(), clientAddress: "203.0.113.9", userAgent: null, actorCompanyId: null },
        staleDependencies,
      ),
    "CONFLICT",
    PORTAL_ESTIMATE_RULES.staleVersion,
    "a decision whose status write lost a race is told the quote changed",
  );

  await expectRefusal(
    () =>
      decidePortalEstimate(
        { token: "not-a-token", body: bodyOf(), clientAddress: "203.0.113.9", userAgent: null, actorCompanyId: null },
        dependenciesOf(fixtureWith({ quotes: [estimateRow()] })),
      ),
    "RESOURCE_NOT_FOUND",
    null,
    "a decision on a link that does not verify is refused",
  );

  // ---- the body: the same rules on the server as the form applies in the browser
  await expectRefusal(
    () => Promise.resolve(parsePortalEstimateDecision(bodyOf({ signature_path: "signatures/1.png" }))),
    "VALIDATION_FAILED",
    "unknown_field",
    "a body with a drawn signature is refused rather than ignored",
  );
  await expectRefusal(
    () => Promise.resolve(parsePortalEstimateDecision(bodyOf({ document_hash: "b".repeat(64) }))),
    "VALIDATION_FAILED",
    "unknown_field",
    "and a body that sends its own digest is refused too",
  );
  await expectRefusal(
    () => Promise.resolve(parsePortalEstimateDecision(bodyOf({ consent_accepted: false }))),
    "VALIDATION_FAILED",
    "required",
    "an unticked consent is refused",
  );
  await expectRefusal(
    () => Promise.resolve(parsePortalEstimateDecision(bodyOf({ signer_email: "not-an-address" }))),
    "VALIDATION_FAILED",
    "invalid_format",
    "an address that is not an address is refused",
  );
  await expectRefusal(
    () => Promise.resolve(parsePortalEstimateDecision(bodyOf({ signer_name: "x".repeat(161) }))),
    "VALIDATION_FAILED",
    "too_long",
    "a name longer than the column is refused",
  );
  await expectRefusal(
    () => Promise.resolve(parsePortalEstimateDecision(bodyOf({ signer_name: "   " }))),
    "VALIDATION_FAILED",
    "too_short",
    "and an empty one",
  );
  await expectRefusal(
    () => Promise.resolve(parsePortalEstimateDecision(bodyOf({ decision: "maybe" }))),
    "VALIDATION_FAILED",
    "invalid_format",
    "a decision that is neither accept nor decline is refused",
  );
  await expectRefusal(
    () => Promise.resolve(parsePortalEstimateDecision(bodyOf({ device_fingerprint: "short" }))),
    "VALIDATION_FAILED",
    "invalid_format",
    "a fingerprint under eight characters is refused",
  );

  const trimmed = parsePortalEstimateDecision(
    bodyOf({ signer_name: "  Rina Chowdhury  ", signer_email: " rina@acme.test ", geo_location: "" }),
  );

  expectEqual(trimmed.signerName, "Rina Chowdhury", "a name is stored trimmed");
  expectEqual(trimmed.geoLocation, null, "and an empty location is stored as absent rather than as a blank");
  expectEqual(
    parsePortalEstimateDecision(bodyOf({ device_fingerprint: null })).deviceFingerprint,
    null,
    "a browser that refuses to fingerprint is not refused a decision",
  );

  // ---- the rate limit: ten attempts per address per ten minutes, on its own scope
  const allowedLimit = await enforcePortalRateLimit(
    PORTAL_SIGNATURE_RATE_LIMIT,
    { clientAddress: "203.0.113.9", route: "/e/[token]/signature" },
    { rest: createRest(createFixture()), audit: createInMemoryAuditTrail() },
  );

  expectEqual(allowedLimit.allowed, true, "an address inside its window may sign");
  expectEqual(
    portalRateLimitHeaders(PORTAL_SIGNATURE_RATE_LIMIT, allowedLimit)["ratelimit-remaining"],
    "9",
    "and the answer names what is left",
  );
  expectEqual(
    portalRateLimitHeaders(PORTAL_SIGNATURE_RATE_LIMIT, allowedLimit)["cache-control"],
    "no-store",
    "and is never cached",
  );

  const refusedLimitFixture = createFixture();
  refusedLimitFixture.rateLimitAnswer = {
    allowed: false,
    remaining: 0,
    retry_after_seconds: 90,
    first_refusal: true,
  };
  const refusedLimitTrail = createInMemoryAuditTrail();

  await expectRefusal(
    () =>
      enforcePortalRateLimit(
        PORTAL_SIGNATURE_RATE_LIMIT,
        { clientAddress: "203.0.113.9", route: "/e/[token]/signature" },
        { rest: createRest(refusedLimitFixture), audit: refusedLimitTrail },
      ),
    "RATE_LIMITED",
    null,
    "an address that spent its ten attempts is refused",
  );
  expectEqual(refusedLimitTrail.entries.length, 1, "and the first refusal is recorded once");
  expect(
    refusedLimitTrail.entries[0]?.payload["key_hash"] !== "203.0.113.9",
    "the entry names the hashed counter, never the address",
  );

  const unreadableLimitFixture = createFixture();
  unreadableLimitFixture.rateLimitAnswer = null;

  await expectRefusal(
    () =>
      enforcePortalRateLimit(
        PORTAL_SIGNATURE_RATE_LIMIT,
        { clientAddress: "203.0.113.9", route: "/e/[token]/signature" },
        { rest: createRest(unreadableLimitFixture) },
      ),
    "DEPENDENCY_FAILED",
    null,
    "a counter that cannot answer is a failure, never a pass",
  );

  // ---- the sources: what the route, the page and the components must say
  const route = await readFile(new URL("./e/[token]/signature/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("./e/[token]/page.tsx", import.meta.url), "utf8");
  const form = await readFile(new URL("../../components/payments/estimate-decision-form.tsx", import.meta.url), "utf8");
  const card = await readFile(new URL("../../components/payments/estimate-decision-card.tsx", import.meta.url), "utf8");
  const decision = await readFile(new URL("./portal-estimate-decision.ts", import.meta.url), "utf8");
  const read = await readFile(new URL("./portal-estimate.ts", import.meta.url), "utf8");
  const fields = await readFile(new URL("./portal-estimate-fields.ts", import.meta.url), "utf8");
  const estimateMigration = await readFile(new URL("../../migrations/0025_estimates.sql", import.meta.url), "utf8");
  const itemMigration = await readFile(new URL("../../migrations/0026_estimate_items.sql", import.meta.url), "utf8");
  const evidenceMigration = await readFile(
    new URL("../../migrations/0027_estimate_signatures.sql", import.meta.url),
    "utf8",
  );
  const conversionMigration = await readFile(
    new URL("../../migrations/0118_estimate_conversion_lock.sql", import.meta.url),
    "utf8",
  );

  expect(route.includes("requireCsrfToken("), "the signature route checks the CSRF token");
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("enforcePortalRateLimit("),
    "and checks it before it spends a counter",
  );
  expect(
    route.indexOf("enforcePortalRateLimit(") < route.indexOf("request.text()"),
    "and spends the counter before it reads the body",
  );
  expect(
    route.includes("PORTAL_ESTIMATE_MAXIMUM_BODY_BYTES") &&
      route.includes('"content-length"') &&
      route.includes("new TextEncoder().encode(bodyText).length"),
    "the route caps the body twice: the declared length and the bytes it actually received",
  );
  expect(route.includes("readClientAddress("), "and reads the address from the request");
  expect(
    route.includes("readRequestActorOptionally("),
    "and resolves whichever session the request carries, so a merchant cannot sign their own quote",
  );
  expect(route.includes("decodeURIComponent("), "and decodes the token rather than trusting its spelling");
  expect(route.includes("document_hash") === false, "and never reads a digest from the body");
  expect(
    route.includes("PORTAL_SIGNATURE_RATE_LIMIT") && route.includes("portalRateLimitHeaders("),
    "the answer carries the counter's own headers",
  );
  expect(route.includes("withErrorResponse("), "and every refusal leaves as the platform's error envelope");

  expect(page.includes('"use server"') === false, "the estimate page is a page, not a server action");
  expect(page.includes('export const dynamic = "force-dynamic"'), "the page is never cached");
  expect(page.includes("nocache: true"), "and asks a crawler to keep it out of an index");
  expect(page.includes("applyPortalEstimateExpiry("), "the page applies the expiry section 16 describes");
  expect(
    page.indexOf("applyPortalEstimateExpiry(") < page.indexOf("applyPortalEstimateView("),
    "before it records the view, so an expired quote is never marked as viewed",
  );
  expect(page.includes("isAppError(error) && error.code === \"RESOURCE_NOT_FOUND\""), "a link that does not verify renders one card");
  expect(page.includes("RATE_LIMITED") === false, "and the page itself never rate limits a read");

  expect(
    card.includes('view.state === "open" ? <EstimateDecisionForm token={token} /> : null'),
    "the form is offered only while the offer is open",
  );
  expect(
    card.includes("view.signature === null") || card.includes("SignatureRecord"),
    "and the record is printed from the row",
  );
  expect(form.includes("device_fingerprint"), "the form sends the device fingerprint it derived");
  expect(form.includes("geo_location"), "and the location");
  expect(form.includes('document_hash') === false, "and never a digest of its own");
  expect(form.includes("requireCsrfToken") === false, "a client component cannot check a CSRF token");
  expect(form.includes("csrfHeaders("), "so it asks the platform for one instead");
  expect(form.includes("getMessage(\"portal.signatureConsent\")"), "and prints the consent sentence the server stores");

  for (const source of [decision, read, fields]) {
    expect(!/update\s+public/iu.test(source), "no portal module writes a table in SQL");
    expect(!source.includes('"invoices"'), "and none of them names an invoice table at all");
    expect(!source.includes("console."), "and none of them logs to the console");
  }

  for (const source of [decision, read, fields, route, page, form, card]) {
    expect(source.startsWith("// path: "), "every file of this STEP names its path on the first line");
  }

  expectEqual(
    (decision.match(/rest[.]update[(]/gu) ?? []).length,
    (decision.match(/rest[.]update[(]\s*ESTIMATE_TABLE/gu) ?? []).length,
    "every write this STEP makes is onto the estimate table and nothing else",
  );

  // ---- the schema the page relies on, which is why this STEP needs no migration
  for (const column of ["void_reason", "voided_at", "accepted_at", "expires_at"]) {
    expect(estimateMigration.includes(column), `0025 already has \`${column}\`, so no migration is needed`);
  }
  expect(
    estimateMigration.includes("estimates_guard_terminal"),
    "0025's terminal guard is what freezes a decided quote",
  );
  expect(itemMigration.includes("create table public.estimate_items ("), "0026 already has the lines");
  for (const column of [
    "signer_name",
    "signer_email",
    "consent_text",
    "consent_accepted",
    "signed_at",
    "ip",
    "geo_location",
    "device_fingerprint",
    "document_hash",
  ]) {
    expect(evidenceMigration.includes(column), `0027 already stores \`${column}\``);
  }
  expect(
    /create unique index[^;]*estimate_signatures[^;]*[(]estimate_id[)]/iu.test(evidenceMigration),
    "and one decision per quote, as a unique index",
  );
  expect(
    evidenceMigration.includes("enable row level security"),
    "the evidence table is row level secured",
  );
  expect(
    conversionMigration.includes("accepted") && conversionMigration.includes("void"),
    "0118 already freezes the terminal statuses a decision writes",
  );

  if (failures.length > 0) {
    process.stderr.write(`portal estimate gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `portal estimate gate passed: ${checkCount} checks, ${PORTAL_ESTIMATE_STATES.length} states folded, ` +
      "2 voids (declined, expired), one signature per estimate, no migration needed\n",
  );
}

await main();
