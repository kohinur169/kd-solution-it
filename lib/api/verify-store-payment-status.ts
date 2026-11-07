// path: lib/api/verify-store-payment-status.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import { createInMemoryAuditTrail, type AuditEntry, type AuditTrail, type InMemoryAuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { RATE_LIMIT_CLASS_POLICIES } from "../security/rate-limit.ts";
import { API_PAYMENTS_PATH } from "./payment-fields.ts";
import { PUBLIC_API_BASE, PUBLIC_API_VERSION, PUBLIC_API_VERSION_HEADER } from "./public-fields.ts";
import { handlePublicApiCall } from "./public-api.ts";
import {
  API_PAYMENT_ID_MAXIMUM_LENGTH,
  API_PAYMENT_READ_AUDIT,
  API_PAYMENT_STATUS_COLUMNS,
  API_PAYMENT_STATUS_FIELD,
  API_PAYMENT_STATUS_ROUTE,
  API_PAYMENT_STATUS_RULES,
  API_STORE_PAYMENT_STATUSES,
  parsePaymentId,
  paymentStatusPathOf,
  readStorePaymentStatus,
} from "./store-payment-status.ts";

/**
 * The gate for STEP 204: the store payment status endpoint.
 *
 * ## What this proves
 *
 *   - **No migration.** `0037` already holds every column the answer reads, including the comment that defines a
 *     store payment as the invoice-less one; the gate reads the migration and pins the status list, the refund
 *     invariants and the column comment the tenant fence depends on.
 *   - **The id is validated before it is a query.** Ten malformed ids refused with `422` and no query at all; a
 *     lower-case UUID accepted; a value past the length ceiling refused before a regular expression sees it.
 *   - **The answer is the payment's money and nothing else.** All nine states render, each with its own failure
 *     code and refunded total; the key set is exactly ten names; and no answer carries a card field, the processor's
 *     transaction id, the free text failure sentence, a fee or the merchant's own company id.
 *   - **Five kinds of "not yours" are one answer.** Unknown, another merchant's, another mode's, an invoice payment
 *     and a deleted payment all answer `404 payment_not_found`, and the query that produced them is asserted to
 *     carry the tenant, the mode and `invoice_id is.null` - so the answer cannot be narrowed by probing.
 *   - **A refusal is in the chain, a served read is not.** One `api.payment_read_refused` per refusal with the id,
 *     the mode, the credential and the address and never the caller's key; a malformed id records no `entityId`; a
 *     successful read writes nothing here because STEP 202's `api.call` already recorded it.
 *   - **The pipeline still owns the surface.** Through `handlePublicApiCall`: `200` with `x-api-version` and
 *     `cache-control: no-store`, no replay header, three counters, one call entry; a `404` that still records its
 *     call; and a full bucket refusing before a payment is read.
 *   - **The route is one verb.** `GET` only, the pipeline's template rather than the arriving path (one route
 *     bucket, not one per id), no idempotency header read, no body read, no CSRF token, nothing printed.
 *
 * The fixture is a PostgREST shaped in-memory store with the credential, company and payment rows the pipeline and
 * the service read, and it records every query so the gate can assert what was asked rather than only what came
 * back.
 */

let checkCount = 0;
const failures: string[] = [];

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

interface Refusal {
  readonly code: string;
  readonly status: number;
  readonly field: string | null;
  readonly rule: string | null;
}

async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) {
      return {
        code: error.code,
        status: error.status,
        field: error.details[0]?.field ?? null,
        rule: error.details[0]?.rule ?? null,
      };
    }

    return { code: "not-an-app-error", status: 0, field: null, rule: null };
  }

  return { code: "no-refusal", status: 0, field: null, rule: null };
}

// ---------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "5a000000-0000-4000-8000-000000000001";
const otherCompanyId = "5a000000-0000-4000-8000-000000000002";
const credentialId = "5b000000-0000-4000-8000-000000000001";
const presentedKey = `kd_test_status_${"1".repeat(64)}`;
const startedAt = Date.parse("2026-11-07T12:00:00.000Z");

/** A UUID the way the database writes them: time ordered, version 7, lower case. */
function uuidOf(suffix: number): string {
  return `0192f0a1-7c3d-7000-8000-${String(suffix).padStart(12, "0")}`;
}

function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function paymentRow(overrides: Row = {}): Row {
  return {
    id: uuidOf(1),
    company_id: companyId,
    invoice_id: null,
    status: "pending",
    amount_minor: 12_50,
    refunded_minor: 0,
    currency: "USD",
    mode: "test",
    payment_method: "card",
    failure_code: null,
    created_at: new Date(startedAt).toISOString(),
    updated_at: new Date(startedAt + 60_000).toISOString(),
    deleted_at: null,
    ...overrides,
  };
}

interface Query {
  readonly equals: Map<string, string>;
  readonly nulls: Set<string>;
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const nulls = new Set<string>();
  let limit: number | null = null;

  for (const part of query.split("&")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === "select") {
      continue;
    }

    if (key === "limit") {
      limit = Number.parseInt(value, 10);
      continue;
    }

    if (value === "is.null") {
      nulls.add(key);
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, nulls, limit };
}

function matchesRow(row: Row, query: Query): boolean {
  for (const [column, value] of query.equals) {
    if (String(row[column]) !== value) {
      return false;
    }
  }

  for (const column of query.nulls) {
    if (row[column] !== null && row[column] !== undefined) {
      return false;
    }
  }

  return true;
}

interface Fixture {
  rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly state: { credentials: Row[]; companies: Row[]; payments: Row[] };
  readonly queries: string[];
  readonly counters: { scope: string; limit: number }[];
  nowMs: number;
  refuseCounter: boolean;
  failAudit: boolean;
}

function createFixture(): Fixture {
  const state: Fixture["state"] = {
    credentials: [
      {
        id: credentialId,
        company_id: companyId,
        label: "Store key",
        mode: "test",
        status: "active",
        key_prefix: "kd_test_status_1",
        key_hash: hashOf(presentedKey),
        key_last_four: "1111",
        last_used_at: null,
        version: 1,
        deleted_at: null,
      },
    ],
    companies: [
      { id: companyId, name: "Northwind Studio", deleted_at: null },
      { id: otherCompanyId, name: "Second Store", deleted_at: null },
    ],
    payments: [paymentRow()],
  };
  const audit = createInMemoryAuditTrail();
  const queries: string[] = [];
  const counters: { scope: string; limit: number }[] = [];
  const fixture: Fixture = {
    rest: undefined as unknown as RestClient,
    audit,
    state,
    queries,
    counters,
    nowMs: startedAt,
    refuseCounter: false,
    failAudit: false,
  };

  fixture.rest = {
    async select<TRow>(table: string, query: string, schema: ZodType<TRow>): Promise<readonly TRow[]> {
      queries.push(`${table}:${query}`);

      if (table === "merchant_api_credentials") {
        return schema.array().parse(
          state.credentials
            .filter((row) => row["key_hash"] === query.match(/key_hash=eq\.([0-9a-f]{64})/u)?.[1])
            .map((row) => ({ ...row })),
        );
      }

      if (table === "companies") {
        return schema.array().parse(state.companies.map((row) => ({ ...row })));
      }

      if (table !== "payments") {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      const parsed = parseQuery(query);
      const selected = state.payments.filter((row) => matchesRow(row, parsed));

      return schema.array().parse(
        (parsed.limit === null ? selected : selected.slice(0, parsed.limit)).map((row) => ({ ...row })),
      );
    },

    async insert(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "read_only_gate" } });
    },

    async insertReturning(): Promise<never> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "read_only_gate" } });
    },

    async update(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "read_only_gate" } });
    },

    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (functionName !== "consume_rate_limit") {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_function" } });
      }

      counters.push({ scope: String(arguments_["p_scope"]), limit: Number(arguments_["p_limit"]) });

      return fixture.refuseCounter
        ? [{ allowed: false, remaining: 0, retry_after_seconds: 7, first_refusal: true }]
        : [{ allowed: true, remaining: Number(arguments_["p_limit"]) - 1, retry_after_seconds: 0, first_refusal: false }];
    },
  };

  return fixture;
}

function dependenciesOf(fixture: Fixture): {
  rest: RestClient;
  audit: AuditTrail;
  now: () => number;
} {
  const audit: AuditTrail = fixture.failAudit
    ? {
        async append(): Promise<void> {
          throw new AppError("DEPENDENCY_FAILED");
        },
      }
    : fixture.audit;

  return { rest: fixture.rest, audit, now: (): number => fixture.nowMs };
}

function principalOf(overrides: Partial<{ mode: "test" | "live"; companyId: string }> = {}): {
  credentialId: string;
  companyId: string;
  companyName: string;
  mode: "test" | "live";
  label: string;
  keyPrefix: string;
  keyLastFour: string;
  lastUsedRefreshed: boolean;
} {
  return {
    credentialId,
    companyId: overrides.companyId ?? companyId,
    companyName: "Northwind Studio",
    mode: overrides.mode ?? "test",
    label: "Store key",
    keyPrefix: "kd_test_status_1",
    keyLastFour: "1111",
    lastUsedRefreshed: false,
  };
}

function readInputOf(
  paymentId: string,
  overrides: Partial<{ mode: "test" | "live"; companyId: string; clientAddress: string | null }> = {},
): {
  paymentId: string;
  principal: ReturnType<typeof principalOf>;
  clientAddress: string | null;
} {
  return {
    paymentId,
    principal: principalOf(overrides),
    clientAddress: overrides.clientAddress ?? "203.0.113.7",
  };
}

function requestOf(options: { readonly key?: string | null; readonly header?: string | null } = {}): Request {
  const headers = new Headers({
    "x-forwarded-for": "203.0.113.7",
    authorization: `Bearer ${presentedKey}`,
  });

  if (options.header !== null && options.header !== undefined) {
    headers.set("idempotency-key", options.header);
  }

  return new Request(`https://api.example.test${paymentStatusPathOf(uuidOf(1))}`, {
    method: "GET",
    headers,
  });
}

// ---------------------------------------------------------------------------------------------
// 1. No migration, and the schema already holds the answer
// ---------------------------------------------------------------------------------------------

const migrationFiles = (await readdir(new URL("../../migrations", import.meta.url).pathname)).filter((name) =>
  name.endsWith(".sql"),
);
const numbers = [
  ...new Set(migrationFiles.map((name) => Number.parseInt(name.slice(0, 4), 10)).filter(Number.isFinite)),
].sort((left, right) => left - right);

expectEqual(numbers[numbers.length - 1] ?? 0, 128, "STEP 204 adds no migration: 0037 already holds every column read");

const paymentsMigration = await readFile(new URL("../../migrations/0037_payments.sql", import.meta.url), "utf8");

expect(
  paymentsMigration.includes("or null for a store payment that has no invoice yet"),
  "0037's own column comment defines the store payment as the invoice-less one, which is the fence this endpoint uses",
);
expect(paymentsMigration.includes("    status in ('pending', 'authorized', 'captured', 'settled', 'failed', 'voided',"),
  "the first half of the status vocabulary is the schema's");
expect(
  paymentsMigration.includes("               'partially_refunded', 'refunded', 'under_review')"),
  "and so is the second half",
);
expect(paymentsMigration.includes("refunded_minor >= 0 and refunded_minor <= amount_minor"),
  "the refunded total can never exceed the amount, which is what the answer shows a store");
expect(paymentsMigration.includes("(status = 'refunded') = (refunded_minor = amount_minor)"),
  "and a refunded state means the whole amount");
expect(paymentsMigration.includes("updated_at >= created_at"), "the row's second instant cannot precede its first");
expect(paymentsMigration.includes("payment_method in ('card', 'bank_transfer', 'e_wallet')"),
  "the method vocabulary is the schema's too");

// ---------------------------------------------------------------------------------------------
// 2. The id
// ---------------------------------------------------------------------------------------------

for (const [value, description] of [
  ["", "an empty segment"],
  ["abc", "three letters"],
  [uuidOf(1).toUpperCase(), "an upper case id"],
  [uuidOf(1).slice(0, 35), "an id one character short"],
  [`${uuidOf(1)}a`, "an id one character long"],
  [uuidOf(1).replace("-", "_"), "an id with a wrong separator"],
  ["%00", "a percent escape"],
  ["0192f0a1-7c3d-7000-8000-0000000000zz", "an id with letters outside hexadecimal"],
  ["a".repeat(API_PAYMENT_ID_MAXIMUM_LENGTH + 1), "a value past the ceiling"],
] as readonly [string, string][]) {
  const refusal = await refusalOf(async () => parsePaymentId(value));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.status, 422, "with a 422");
  expectEqual(refusal.field, API_PAYMENT_STATUS_FIELD, "naming the path's parameter");
  expectEqual(refusal.rule, API_PAYMENT_STATUS_RULES.malformed, `and ${description} names payment_id_malformed`);
}

const notAString = await refusalOf(async () => parsePaymentId(null));

expectEqual(notAString.rule, API_PAYMENT_STATUS_RULES.malformed, "a value that is not a string at all is refused unread");
expectEqual(notAString.status, 422, "with the same refusal a bad string gets");

expectEqual(parsePaymentId(uuidOf(9)), uuidOf(9), "a lower case version 7 id is accepted");
expectEqual(parsePaymentId(`  ${uuidOf(9)}  `), uuidOf(9), "and surrounding whitespace is trimmed, not refused");
const atCeiling = await refusalOf(async () => parsePaymentId("a".repeat(API_PAYMENT_ID_MAXIMUM_LENGTH)));

expectEqual(
  atCeiling.rule,
  API_PAYMENT_STATUS_RULES.malformed,
  "a value exactly at the ceiling is looked at, then refused by the pattern rather than by its length",
);
expectEqual(API_PAYMENT_STATUS_FIELD, "id", "the refusal names `id`, the path's parameter");

// ---------------------------------------------------------------------------------------------
// 3. The answer
// ---------------------------------------------------------------------------------------------

const expectedKeys = [
  "amount_minor",
  "created_at",
  "currency",
  "failure_code",
  "id",
  "mode",
  "object",
  "payment_method",
  "refunded_minor",
  "status",
  "updated_at",
];

const shapeFixture = createFixture();
const served = await readStorePaymentStatus(readInputOf(uuidOf(1)), dependenciesOf(shapeFixture));

expectEqual(Object.keys(served).sort().join(","), expectedKeys.join(","), "the answer's key set is exactly the ten fields");
expectEqual(served.object, "payment", "it names its object");
expectEqual(served.id, uuidOf(1), "and its id");
expectEqual(served.amount_minor, 12_50, "the amount that was charged");
expectEqual(served.refunded_minor, 0, "nothing returned yet");
expectEqual(served.currency, "USD", "the row's currency");
expectEqual(served.mode, "test", "the mode the credential proved");
expectEqual(served.payment_method, "card", "the method");
expectEqual(served.failure_code, null, "a pending payment has no failure");
expectEqual(served.created_at, new Date(startedAt).toISOString(), "the instant it was written");
expectEqual(served.updated_at, new Date(startedAt + 60_000).toISOString(), "and the instant it last moved");
expect(!JSON.stringify(served).includes("card_last_four"), "no card field is in the answer");
expect(!JSON.stringify(served).includes(companyId), "and no company id");
expect(!JSON.stringify(served).includes("provider_transaction_id"), "and no processor transaction id");
expect(!JSON.stringify(served).includes("failure_detail"), "and no processor sentence");

for (const [status, extra, description] of [
  ["pending", {}, "a payment waiting for its customer"],
  ["authorized", {}, "an authorization"],
  ["captured", {}, "a captured payment"],
  ["settled", {}, "a settled one"],
  ["failed", { failure_code: "do_not_honor", amount_minor: 25_00 }, "a decline with its machine code"],
  ["voided", {}, "a void"],
  ["partially_refunded", { refunded_minor: 5_00 }, "a partial refund"],
  ["refunded", { refunded_minor: 12_50 }, "a full refund"],
  ["under_review", {}, "a payment held for review"],
] as readonly [string, Row, string][]) {
  const fixture = createFixture();

  fixture.state.payments = [paymentRow({ ...extra, status })];

  const view = await readStorePaymentStatus(readInputOf(uuidOf(1)), dependenciesOf(fixture));

  expectEqual(view.status, status, `${description} is served as its own state`);
  expectEqual(view.refunded_minor, Number(extra["refunded_minor"] ?? 0), `and ${description} carries the refunded total`);
  expectEqual(view.failure_code, (extra["failure_code"] as string | undefined) ?? null, `and ${description} its failure code`);
}

expectEqual(API_STORE_PAYMENT_STATUSES.length, 9, "nine states, which is the schema's list");

const currencyFixture = createFixture();

currencyFixture.state.payments = [paymentRow({ currency: "USD", amount_minor: 10_000_000 })];

const large = await readStorePaymentStatus(readInputOf(uuidOf(1)), dependenciesOf(currencyFixture));

expectEqual(large.amount_minor, 10_000_000, "the ceiling amount is served as a number, not a string");

const currencyEchoFixture = createFixture();

currencyEchoFixture.state.payments = [paymentRow({ currency: "EUR" })];

const echoed = await readStorePaymentStatus(readInputOf(uuidOf(1)), dependenciesOf(currencyEchoFixture));

expectEqual(
  echoed.currency,
  "EUR",
  "the answer repeats the row's currency rather than assuming USD: rule 2 is enforced where money is written",
);

// ---------------------------------------------------------------------------------------------
// 4. The query
// ---------------------------------------------------------------------------------------------

const queryFixture = createFixture();

await readStorePaymentStatus(readInputOf(uuidOf(1), { clientAddress: null }), dependenciesOf(queryFixture));

const paymentQueries = queryFixture.queries.filter((entry) => entry.startsWith("payments:"));

expectEqual(paymentQueries.length, 1, "one read is one query, never a query in a loop");
expectEqual(paymentQueries[0]?.includes(`id=eq.${uuidOf(1)}`), true, "the query narrows on the id");
expectEqual(paymentQueries[0]?.includes(`company_id=eq.${companyId}`), true, "and on the tenant, before anything else");
expectEqual(paymentQueries[0]?.includes("mode=eq.test"), true, "and on the credential's mode");
expectEqual(paymentQueries[0]?.includes("invoice_id=is.null"), true, "and on the schema's definition of a store payment");
expectEqual(paymentQueries[0]?.includes("deleted_at=is.null"), true, "and refuses a deleted row");
expectEqual(paymentQueries[0]?.includes("limit=1"), true, "and asks for one row");
expectEqual(paymentQueries[0]?.includes(`select=${API_PAYMENT_STATUS_COLUMNS}`), true, "with the column list this file names");
expect(!(paymentQueries[0] ?? "").includes("card_"), "the column list carries no card field");
expect(!(paymentQueries[0] ?? "").includes("failure_detail"), "and no free text failure sentence");
expect(!(paymentQueries[0] ?? "").includes("provider_transaction_id"), "and no processor identifier");
expect(!(paymentQueries[0] ?? "").includes("fee_minor"), "and no fee the platform kept");
expect(!(paymentQueries[0] ?? "").includes("select=*"), "and never a star");

expectEqual(
  API_PAYMENT_STATUS_COLUMNS,
  "id,status,amount_minor,refunded_minor,currency,mode,payment_method,failure_code,created_at,updated_at",
  "the column list is the ten fields of the answer and nothing else",
);

// ---------------------------------------------------------------------------------------------
// 5. The five ways a read is not yours, and the one way the id is not an id
// ---------------------------------------------------------------------------------------------

const cases: readonly [string, Row, string][] = [
  ["an id that does not exist", paymentRow({ id: uuidOf(77) }), "unknown"],
  ["another merchant's payment", paymentRow({ company_id: otherCompanyId }), "another tenant"],
  ["a live payment read with a test key", paymentRow({ mode: "live" }), "another mode"],
  ["an invoice payment", paymentRow({ invoice_id: "5c000000-0000-4000-8000-000000000001" }), "an invoice payment"],
  ["a deleted payment", paymentRow({ deleted_at: new Date(startedAt + 120_000).toISOString() }), "a deleted row"],
];

for (const [description, row, label] of cases) {
  const fixture = createFixture();

  fixture.state.payments = [row];

  const refusal = await refusalOf(async () =>
    readStorePaymentStatus(readInputOf(uuidOf(1)), dependenciesOf(fixture)),
  );

  expectEqual(refusal.code, "RESOURCE_NOT_FOUND", `${label} is a 404`);
  expectEqual(refusal.status, 404, "with the platform's own status");
  expectEqual(refusal.field, API_PAYMENT_STATUS_FIELD, `and ${label} names the path's parameter`);
  expectEqual(refusal.rule, API_PAYMENT_STATUS_RULES.notFound, `and ${label} carries the same rule as the others`);

  const refusals = fixture.audit.entries.filter((entry) => entry.action === API_PAYMENT_READ_AUDIT.refused);

  expectEqual(refusals.length, 1, `${description} writes one refusal entry`);
  expectEqual(refusals[0]?.entityId, uuidOf(1), "naming the id that was asked for");
  expectEqual(refusals[0]?.payload["rule"], API_PAYMENT_STATUS_RULES.notFound, "and the rule");
}

const malformedFixture = createFixture();
const malformed = await refusalOf(async () =>
  readStorePaymentStatus(readInputOf("not-a-uuid"), dependenciesOf(malformedFixture)),
);

expectEqual(malformed.status, 422, "a malformed id is a 422 rather than a query that cannot match");
expectEqual(malformed.rule, API_PAYMENT_STATUS_RULES.malformed, "with its own rule");
expectEqual(
  malformedFixture.queries.filter((entry) => entry.startsWith("payments:")).length,
  0,
  "and no query at all reaches the table",
);
expectEqual(
  malformedFixture.audit.entries.filter((entry) => entry.action === API_PAYMENT_READ_AUDIT.refused).length,
  1,
  "the probe is still in the chain",
);
expectEqual(
  malformedFixture.audit.entries.find((entry) => entry.action === API_PAYMENT_READ_AUDIT.refused)?.entityId,
  null,
  "with no entity, because the value was not a payment id",
);

// ---------------------------------------------------------------------------------------------
// 6. The chain
// ---------------------------------------------------------------------------------------------

const refusalChainFixture = createFixture();

refusalChainFixture.state.payments = [];

await refusalOf(async () =>
  readStorePaymentStatus(readInputOf(uuidOf(5), { clientAddress: "198.51.100.4" }), dependenciesOf(refusalChainFixture)),
);

const refusedEntry: AuditEntry | undefined = refusalChainFixture.audit.entries.find(
  (entry) => entry.action === API_PAYMENT_READ_AUDIT.refused,
);

expect(refusedEntry !== undefined, "a refusal writes api.payment_read_refused");
expectEqual(refusedEntry?.action, API_PAYMENT_READ_AUDIT.refused, "and the action is the one this file names");
expectEqual(refusedEntry?.companyId, companyId, "on the merchant's chain");
expectEqual(refusedEntry?.actorUserId, null, "with no human actor, because there is none");
expectEqual(refusedEntry?.ipAddress, "198.51.100.4", "and the address the call came from");
expectEqual(refusedEntry?.payload["mode"], "test", "and the mode the credential proved");
expectEqual(refusedEntry?.payload["credential_id"], credentialId, "and which key asked");
expect(!JSON.stringify(refusedEntry).includes(presentedKey.slice(8)), "and never the caller's key");

expectEqual(
  shapeFixture.audit.entries.filter((entry) => entry.action === API_PAYMENT_READ_AUDIT.refused).length,
  0,
  "a served read writes no refusal entry",
);
expectEqual(
  shapeFixture.audit.entries.length,
  0,
  "and nothing else here either: STEP 202's call entry is written by the pipeline, not by this service",
);

const deafFixture = createFixture();

deafFixture.failAudit = true;
deafFixture.state.payments = [];

const stillRefused = await refusalOf(async () =>
  readStorePaymentStatus(readInputOf(uuidOf(1)), dependenciesOf(deafFixture)),
);

expectEqual(stillRefused.code, "RESOURCE_NOT_FOUND", "a chain that cannot be written does not make a read allowed");

const deafServedFixture = createFixture();

deafServedFixture.failAudit = true;

const stillServed = await refusalOf(async () =>
  readStorePaymentStatus(readInputOf(uuidOf(1)), dependenciesOf(deafServedFixture)),
);

expectEqual(stillServed.code, "no-refusal", "and does not make a served read fail either");

// ---------------------------------------------------------------------------------------------
// 7. Through the pipeline
// ---------------------------------------------------------------------------------------------

async function readThroughPipeline(
  fixture: Fixture,
  header: string | null = null,
): Promise<{ status: number; body: unknown; headers: Readonly<Record<string, string>> }> {
  return handlePublicApiCall(
    {
      request: requestOf({ header }),
      route: API_PAYMENT_STATUS_ROUTE,
      handler: async (call) => {
        const payment = await readStorePaymentStatus(
          {
            paymentId: uuidOf(1),
            principal: call.principal,
            clientAddress: "203.0.113.7",
          },
          dependenciesOf(fixture),
        );

        return { status: 200, body: payment };
      },
    },
    dependenciesOf(fixture),
  );
}

const pipelineFixture = createFixture();
const pipelineAnswer = await readThroughPipeline(pipelineFixture);

expectEqual(pipelineAnswer.status, 200, "a status read answers 200");
expectEqual(pipelineAnswer.headers[PUBLIC_API_VERSION_HEADER], PUBLIC_API_VERSION, "with the version header");
expectEqual(pipelineAnswer.headers["cache-control"], "no-store", "and never cached");
expectEqual(pipelineAnswer.headers["idempotency-replayed"], undefined, "and no replay header, because nothing is replayed");
expectEqual(pipelineFixture.counters.length, 3, "the call is counted in all three public_api buckets");
expectEqual(
  pipelineFixture.counters.filter((counter) => counter.scope.startsWith("route_public_api")).length,
  1,
  "including the route bucket",
);
expectEqual(
  pipelineFixture.counters.find((counter) => counter.scope.startsWith("route_public_api"))?.limit,
  RATE_LIMIT_CLASS_POLICIES.public_api.route.limit,
  "against the limiter's own route ceiling",
);
expectEqual(
  pipelineFixture.audit.entries.filter((entry) => entry.action === "api.call").length,
  1,
  "and one call entry",
);
expectEqual(
  pipelineFixture.audit.entries.find((entry) => entry.action === "api.call")?.payload["status"],
  200,
  "with the status it answered",
);
expectEqual(
  pipelineFixture.audit.entries.find((entry) => entry.action === "api.call")?.payload["route"],
  API_PAYMENT_STATUS_ROUTE,
  "and the route template, so the bucket is the endpoint's and not the payment's",
);

const withHeader = createFixture();
const headerAnswer = await readThroughPipeline(withHeader, "checkout-8f2c1d");

expectEqual(headerAnswer.status, 200, "a store that sends an idempotency key on a read is not refused for it");
expectEqual(headerAnswer.body instanceof Object, true, "and gets the payment");

const missingFixture = createFixture();
const missingAnswer = await refusalOf(async () => {
  missingFixture.state.payments = [];

  return readThroughPipeline(missingFixture);
});

expectEqual(missingAnswer.status, 404, "a missing payment through the pipeline is a 404");
expectEqual(
  missingFixture.audit.entries.filter((entry) => entry.action === "api.call").length,
  1,
  "and the refused call is still recorded",
);
expectEqual(
  missingFixture.audit.entries.find((entry) => entry.action === "api.call")?.payload["status"],
  404,
  "with the status it answered",
);
expectEqual(
  missingFixture.audit.entries.filter((entry) => entry.action === API_PAYMENT_READ_AUDIT.refused).length,
  1,
  "beside the read's own refusal entry",
);

const limitedFixture = createFixture();

limitedFixture.refuseCounter = true;

const limited = await refusalOf(async () => readThroughPipeline(limitedFixture));

expectEqual(limited.code, "RATE_LIMITED", "a full bucket refuses before the handler runs");
expectEqual(
  limitedFixture.queries.filter((entry) => entry.startsWith("payments:")).length,
  0,
  "and no payment is read",
);

// ---------------------------------------------------------------------------------------------
// 8. The route file
// ---------------------------------------------------------------------------------------------

const routeSource = await readFile(
  new URL("../../app/api/public/v1/payments/[id]/route.ts", import.meta.url),
  "utf8",
);

expect(routeSource.includes("export const GET"), "the status route answers a GET");
expect(!routeSource.includes("export const POST"), "and no POST: creating is STEP 203's sibling route");
expect(!routeSource.includes("export const PUT"), "and no PUT");
expect(!routeSource.includes("export const PATCH"), "and no PATCH");
expect(!routeSource.includes("export const DELETE"), "and no DELETE");
expect(routeSource.includes("handlePublicApiCall("), "it goes through STEP 202's pipeline");
expect(routeSource.includes("route: API_PAYMENT_STATUS_ROUTE"), "counted under the route template");
expect(routeSource.includes("await context.params"), "it reads the id from the path");
expect(routeSource.includes("readStorePaymentStatus("), "and hands it to the service");
expect(routeSource.includes("readClientAddress(call.request.headers)"), "carrying the address into the refusal entry");
expect(routeSource.includes('export const dynamic = "force-dynamic"'), "and is never cached by the framework either");
expect(!routeSource.includes("readIdempotencyKey"), "it reads no idempotency key");
expect(!routeSource.includes("readPaymentBody"), "and no body");
expect(!routeSource.includes("requireCsrfToken"), "and asks for no CSRF token, because a GET changes nothing");
expect(!routeSource.includes("cookie"), "and reads no cookie");
expect(!routeSource.includes("console."), "and prints nothing");
expect(!/card_(?:number|expiry|cvv|token|last_four|brand)/u.test(routeSource), "and names no card field");
expect(routeSource.includes("headers: answer.headers"), "the answer's headers reach the response");
expect(routeSource.includes("return { status: 200, body: payment };"), "and a served read answers 200 with the view");

const serviceSource = await readFile(new URL("./store-payment-status.ts", import.meta.url), "utf8");

expect(serviceSource.includes("invoice_id=is.null"), "the service narrows to the schema's store payment");
expect(serviceSource.includes("deleted_at=is.null"), "and refuses a deleted row");
expect(serviceSource.includes("mode=eq.${encodeURIComponent(input.principal.mode)}"), "and honours the credential's mode");
expect(
  serviceSource.includes("select=${API_PAYMENT_STATUS_COLUMNS}"),
  "the service selects the column list this file names, never a star",
);
expect(!serviceSource.includes("console."), "and prints nothing");

// ---------------------------------------------------------------------------------------------
// 9. The vocabulary
// ---------------------------------------------------------------------------------------------

expectEqual(API_PAYMENT_STATUS_ROUTE, `${API_PAYMENTS_PATH}/{id}`, "the route template is STEP 203's path with its parameter");
expectEqual(API_PAYMENT_STATUS_ROUTE, `${PUBLIC_API_BASE}/payments/{id}`, "under this version's root");
expectEqual(paymentStatusPathOf(uuidOf(1)), `${API_PAYMENTS_PATH}/${uuidOf(1)}`, "and a payment's own path joins the id on");
expectEqual(
  paymentStatusPathOf("a b"),
  `${API_PAYMENTS_PATH}/a%20b`,
  "encoding anything that would not survive a path segment",
);
expect(
  Object.values(API_PAYMENT_STATUS_RULES).every((rule) => /^[a-z][a-z0-9_]+$/u.test(rule)),
  "every refusal rule is a machine word",
);
expectEqual(
  API_PAYMENT_READ_AUDIT.refused,
  "api.payment_read_refused",
  "the refusal action is the one the chain expects",
);
expect(
  /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(API_PAYMENT_READ_AUDIT.refused),
  "and fits the chain's dotted action pattern",
);
expect(
  (API_STORE_PAYMENT_STATUSES as readonly string[]).every((status) => /^[a-z][a-z0-9_]+$/u.test(status)),
  "every state is a machine word",
);
expectEqual(API_STORE_PAYMENT_STATUSES[0], "pending", "the list starts where a payment starts");
expectEqual(API_STORE_PAYMENT_STATUSES[4], "failed", "and keeps the schema's order");
expect(
  (API_STORE_PAYMENT_STATUSES as readonly string[]).includes("partially_refunded") &&
    (API_STORE_PAYMENT_STATUSES as readonly string[]).includes("refunded"),
  "both refunded states are carried, because a store ships on the difference",
);

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`store payment status gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `store payment status gate passed: ${String(checkCount)} checks, one authenticated read of one store payment ` +
      "narrowed by tenant, mode and the schema's definition of a store payment, five kinds of \"not yours\" " +
      "answered as one 404, a refusal in the chain with the id and never the caller's key, and an answer that " +
      "carries the money and none of the processor's record\n",
  );
}
