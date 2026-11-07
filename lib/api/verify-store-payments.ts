// path: lib/api/verify-store-payments.ts
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import type { ZodType } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../auth/audit.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { RATE_LIMIT_CLASS_POLICIES } from "../security/rate-limit.ts";
import type { RestClient } from "../auth/rest.ts";
import {
  API_IDEMPOTENCY_HEADER,
  API_IDEMPOTENCY_KEY_MAXIMUM_LENGTH,
  API_IDEMPOTENCY_KEY_MINIMUM_LENGTH,
  API_PAYMENT_AUDIT,
  API_PAYMENT_BODY_MAXIMUM_BYTES,
  API_PAYMENT_CURRENCY,
  API_PAYMENT_DEFAULT_METHOD,
  API_PAYMENT_MAXIMUM_AMOUNT_MINOR,
  API_PAYMENT_METHODS,
  API_PAYMENT_MINIMUM_AMOUNT_MINOR,
  API_PAYMENT_RULES,
  API_PAYMENT_SCOPE,
  API_PAYMENT_TABLES,
  API_PAYMENTS_PATH,
  API_REPLAY_HEADER,
} from "./payment-fields.ts";
import { PUBLIC_API_BASE } from "./public-fields.ts";
import { handlePublicApiCall } from "./public-api.ts";
import {
  createStorePayment,
  parseStorePaymentRequest,
  readIdempotencyKey,
  readPaymentBody,
  STORE_PAYMENT_PROVIDER_KEYS,
} from "./store-payments.ts";

/**
 * The gate for STEP 203: the store payment creation endpoint.
 *
 * ## What this proves
 *
 *   - **No migration.** `0033` already holds the idempotency contract, `0037` the payment, `0031` the rules and
 *     `0029` the providers; the gate reads all four migrations and pins the columns and checks this STEP relies
 *     on, so a later edit that drops one of them fails here rather than at the first live store.
 *   - **The key is a header, hashed and never stored.** Seven malformed keys refused before any query, the
 *     stored row holding a 64 character hash and not the string, and the string absent from the payment, the
 *     chain and the answer.
 *   - **The body is three fields and no more.** A strict schema refuses `company_id`, `mode`, `status` and
 *     anything else a client might believe it set; the amount bounds and the method list are the ones the
 *     vocabulary declares; a kilobyte of padding is refused with `413` before it is parsed.
 *   - **One key, one payment, one answer.** The replay returns the same bytes and `idempotency-replayed`; a key
 *     reused with another amount is `409 idempotency_conflict`; a key in flight and a spent key are conflicts
 *     with their own rules; a unique violation from a racing writer is re-read and replayed rather than
 *     reported as an error.
 *   - **The route decides, and a route that cannot accept is refused.** Priority, method narrowing, mode
 *     separation, a disabled provider, a provider the registry does not know and a country-scoped rule are each
 *     walked; no match spends the key with `route_unavailable` and writes no payment.
 *   - **The company comes from the key, never the body.** Two merchants using the same key string are two rows
 *     and two payments.
 *   - **Every creation is in the chain** with the amount, the mode and the provider, and a replay is not.
 *   - **The pipeline still holds.** Through STEP 202's `handlePublicApiCall` the call is counted, `api.call`
 *     records `201`, and a refused call writes no payment at all.
 *
 * The fixture is a PostgREST shaped in-memory store that carries the constraints of `0033` and `0037` the
 * behaviours depend on: the unique key per tenant, the one-payment-per-key index, the amount and method checks,
 * and the guard that refuses a decided idempotency key that returns to flight.
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

/** The refusal a call raises: its code, status and the one rule it names. */
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

const companyId = "3c000000-0000-4000-8000-000000000001";
const otherCompanyId = "3c000000-0000-4000-8000-000000000002";
const credentialId = "3d000000-0000-4000-8000-000000000001";
const providerNmiId = "3e000000-0000-4000-8000-000000000001";
const providerStripeId = "3e000000-0000-4000-8000-000000000002";
const providerDisabledId = "3e000000-0000-4000-8000-000000000003";
const ruleHighId = "3f000000-0000-4000-8000-000000000001";
const ruleLowId = "3f000000-0000-4000-8000-000000000002";
const ruleTestId = "3f000000-0000-4000-8000-000000000003";
const ruleCardId = "3f000000-0000-4000-8000-000000000004";
const rulePlatformId = "3f000000-0000-4000-8000-000000000005";
const ruleCountryId = "3f000000-0000-4000-8000-000000000006";
const ruleDisabledId = "3f000000-0000-4000-8000-000000000007";
const startedAt = Date.parse("2026-11-07T10:00:00.000Z");

/** The key the pipeline section presents: the shape `0034` mints, hashed the way the authenticator hashes it. */
const presentedKey = `kd_test_main_${"0".repeat(64)}`;

/** `payments_status_check`, so a row written with a status the schema does not know is refused as a database error. */
const PAYMENT_STATUSES = [
  "pending",
  "authorized",
  "captured",
  "settled",
  "failed",
  "voided",
  "partially_refunded",
  "refunded",
  "under_review",
] as const;

const keyIdPrefix = "40000000-0000-4000-8000-";
const paymentIdPrefix = "41000000-0000-4000-8000-";

/** The SHA-256 `0033` stores: the gate computes it the way the service does, to plant rows. */
function hashOfKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface Fixture {
  rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly state: {
    credentials: Row[];
    companies: Row[];
    idempotency_keys: Row[];
    payments: Row[];
    routing_rules: Row[];
    payment_providers: Row[];
  };
  readonly counters: { scope: string; keyHash: string; limit: number }[];
  readonly queries: string[];
  nowMs: number;
  nextId: number;
  refuseCounter: boolean;
  /** Answer the next key lookup as if no row existed, so the insert races. */
  blindOnce: boolean;
  /** Lose the next update, the way a guarded write that matched nothing does. */
  loseUpdate: boolean;
  /** Fail the next payment insert with an integrity violation. */
  failPaymentOnce: boolean;
}

interface Query {
  readonly equals: Map<string, string>;
  readonly nulls: Set<string>;
  readonly in: Map<string, readonly string[]>;
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const nulls = new Set<string>();
  const inLists = new Map<string, readonly string[]>();
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

    if (value.startsWith("in.(")) {
      const list = value.slice(4, -1);
      inLists.set(key, list.split(",").map((piece) => decodeURIComponent(piece)));
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, nulls, in: inLists, limit };
}

function matches(row: Row, query: Query): boolean {
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

  for (const [column, values] of query.in) {
    if (!values.includes(String(row[column]))) {
      return false;
    }
  }

  return true;
}

let ruleNameCounter = 0;

function rulesOf(companyIdValue: string | null, mode: string): Row {
  ruleNameCounter += 1;

  return {
    company_id: companyIdValue,
    rule_name: `rule-${String(ruleNameCounter)}`,
    mode,
    priority: 100,
    provider_id: providerNmiId,
    country_code: null,
    payment_method: null,
    min_amount_minor: null,
    max_amount_minor: null,
    status: "active",
    deleted_at: null,
    version: 1,
  };
}

function createFixture(): Fixture {
  const state: Fixture["state"] = {
    credentials: [
      {
        id: credentialId,
        company_id: companyId,
        label: "Main store",
        mode: "test",
        status: "active",
        key_prefix: "kd_test_main_0",
        key_hash: hashOfKey(presentedKey),
        key_last_four: "0000",
        last_used_at: null,
        version: 1,
        deleted_at: null,
      },
    ],
    companies: [
      { id: companyId, name: "Northwind Studio", deleted_at: null },
      { id: otherCompanyId, name: "Second Store", deleted_at: null },
    ],
    idempotency_keys: [],
    payments: [],
    routing_rules: [
      {
        ...rulesOf(companyId, "test"),
        id: ruleLowId,
        priority: 100,
        provider_id: providerNmiId,
      },
      {
        ...rulesOf(companyId, "test"),
        id: ruleHighId,
        priority: 200,
        provider_id: providerStripeId,
      },
      {
        ...rulesOf(companyId, "test"),
        id: ruleCardId,
        priority: 300,
        provider_id: providerStripeId,
        payment_method: "card",
      },
      {
        ...rulesOf(companyId, "live"),
        id: ruleTestId,
        priority: 400,
        provider_id: providerNmiId,
        mode: "live",
      },
      {
        ...rulesOf(null, "test"),
        id: rulePlatformId,
        priority: 50,
        provider_id: providerNmiId,
      },
      {
        ...rulesOf(companyId, "test"),
        id: ruleCountryId,
        priority: 500,
        provider_id: providerNmiId,
        country_code: "US",
      },
      {
        ...rulesOf(companyId, "test"),
        id: ruleDisabledId,
        priority: 600,
        provider_id: providerDisabledId,
      },
    ],
    payment_providers: [
      {
        id: providerNmiId,
        provider_key: "nmi",
        supports_acceptance: true,
        status: "active",
        deleted_at: null,
      },
      {
        id: providerStripeId,
        provider_key: "stripe_connect",
        supports_acceptance: true,
        status: "active",
        deleted_at: null,
      },
      {
        id: providerDisabledId,
        provider_key: "rainforest",
        supports_acceptance: true,
        status: "disabled",
        deleted_at: null,
      },
    ],
  };
  const audit = createInMemoryAuditTrail();
  const counters: { scope: string; keyHash: string; limit: number }[] = [];
  const queries: string[] = [];
  const fixture: Fixture = {
    rest: undefined as unknown as RestClient,
    audit,
    state,
    counters,
    queries,
    nowMs: startedAt,
    nextId: 1,
    refuseCounter: false,
    blindOnce: false,
    loseUpdate: false,
    failPaymentOnce: false,
  };

  function newId(prefix: string): string {
    const suffix = String(fixture.nextId).padStart(12, "0");
    fixture.nextId += 1;

    return `${prefix}${suffix}`;
  }

  function tablesOf(table: string): Row[] {
    if (table === API_PAYMENT_TABLES.idempotencyKeys) {
      return state.idempotency_keys;
    }

    if (table === API_PAYMENT_TABLES.payments) {
      return state.payments;
    }

    if (table === API_PAYMENT_TABLES.routingRules) {
      return state.routing_rules;
    }

    if (table === API_PAYMENT_TABLES.paymentProviders) {
      return state.payment_providers;
    }

    if (table === "companies") {
      return state.companies;
    }

    if (table === "merchant_api_credentials") {
      return state.credentials;
    }

    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
  }

  function insertRow(table: string, values: Row): Row {
    if (table === API_PAYMENT_TABLES.idempotencyKeys) {
      const clash = state.idempotency_keys.some(
        (row) =>
          row["company_id"] === values["company_id"] &&
          row["scope"] === values["scope"] &&
          row["key_hash"] === values["key_hash"],
      );

      if (clash) {
        // `idempotency_keys_company_scope_key` is unique, and PostgREST answers 409 for it.
        throw new AppError("CONFLICT");
      }

      const row: Row = {
        id: newId(keyIdPrefix),
        company_id: values["company_id"],
        scope: values["scope"],
        key_hash: values["key_hash"],
        request_hash: values["request_hash"],
        state: values["state"],
        response_status: null,
        response_body: null,
        error_detail: null,
        completed_at: null,
        expires_at: values["expires_at"],
        created_at: new Date(fixture.nowMs).toISOString(),
        updated_at: new Date(fixture.nowMs).toISOString(),
        deleted_at: null,
        version: 1,
      };

      state.idempotency_keys.push(row);

      return row;
    }

    if (table === API_PAYMENT_TABLES.payments) {
      if (fixture.failPaymentOnce) {
        fixture.failPaymentOnce = false;

        throw new AppError("VALIDATION_FAILED");
      }

      const provider = state.payment_providers.find((row) => row["id"] === values["provider_id"]);

      if (provider === undefined) {
        throw new AppError("VALIDATION_FAILED", { cause: { rule: "provider_fkey" } });
      }

      if (Number(values["amount_minor"]) <= 0) {
        throw new AppError("VALIDATION_FAILED", { cause: { rule: "amount_check" } });
      }

      if (!(API_PAYMENT_METHODS as readonly string[]).includes(String(values["payment_method"]))) {
        throw new AppError("VALIDATION_FAILED", { cause: { rule: "method_check" } });
      }

      if (!["test", "live"].includes(String(values["mode"]))) {
        throw new AppError("VALIDATION_FAILED", { cause: { rule: "mode_check" } });
      }

      const writtenStatus = String(values["status"]);

      if (!(PAYMENT_STATUSES as readonly string[]).includes(writtenStatus)) {
        throw new AppError("VALIDATION_FAILED", { cause: { rule: "status_check" } });
      }

      if (state.payments.some((row) => row["idempotency_key_id"] === values["idempotency_key_id"])) {
        // `payments_idempotency_key` is unique: the second delivery of one key cannot write a second payment.
        throw new AppError("CONFLICT");
      }

      const row: Row = {
        id: newId(paymentIdPrefix),
        company_id: values["company_id"],
        invoice_id: null,
        provider_id: values["provider_id"],
        provider_key_id: null,
        routing_rule_id: values["routing_rule_id"],
        idempotency_key_id: values["idempotency_key_id"],
        mode: values["mode"],
        payment_method: values["payment_method"],
        amount_minor: values["amount_minor"],
        currency: values["currency"],
        fee_minor: 0,
        platform_fee_minor: 0,
        refunded_minor: 0,
        status: writtenStatus,
        provider_transaction_id: null,
        failure_code: null,
        created_at: new Date(fixture.nowMs).toISOString(),
        updated_at: new Date(fixture.nowMs).toISOString(),
        deleted_at: null,
        version: 1,
      };

      state.payments.push(row);

      return row;
    }

    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unexpected_insert" } });
  }

  fixture.rest = {
    async select<TRow>(table: string, query: string, schema: ZodType<TRow>): Promise<readonly TRow[]> {
      queries.push(`${table}:${query}`);

      if (table === API_PAYMENT_TABLES.idempotencyKeys && fixture.blindOnce) {
        fixture.blindOnce = false;

        return [];
      }

      const parsed = parseQuery(query);
      let selected = tablesOf(table).filter((row) => matches(row, parsed));

      if (parsed.limit !== null) {
        selected = selected.slice(0, parsed.limit);
      }

      return schema.array().parse(selected.map((row) => ({ ...row })));
    },

    async insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      for (const row of rows) {
        insertRow(table, { ...row });
      }
    },

    async insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      const written: Row[] = [];

      for (const row of rows) {
        written.push(insertRow(table, { ...row }));
      }

      return schema.array().parse(written.map((row) => ({ ...row })));
    },

    async update(table: string, query: string, values: Row): Promise<void> {
      if (table !== API_PAYMENT_TABLES.idempotencyKeys) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unexpected_update" } });
      }

      if (fixture.loseUpdate) {
        fixture.loseUpdate = false;

        return;
      }

      const parsed = parseQuery(query);

      for (const row of state.idempotency_keys) {
        if (!matches(row, parsed)) {
          continue;
        }

        // `idempotency_keys_guard_state`, in the two rules the service depends on.
        if (row["state"] === "completed" && values["state"] === "in_flight") {
          throw new AppError("VALIDATION_FAILED", { cause: { rule: "decided_key_in_flight" } });
        }

        if (row["state"] === "completed" && values["state"] === "completed") {
          if (
            values["response_status"] !== row["response_status"] ||
            values["response_body"] !== row["response_body"]
          ) {
            throw new AppError("VALIDATION_FAILED", { cause: { rule: "completed_key_keeps_answer" } });
          }
        }

        Object.assign(row, values);
        row["version"] = Number(row["version"]) + 1;
      }
    },

    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (functionName !== "consume_rate_limit") {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_function" } });
      }

      const limit = Number(arguments_["p_limit"]);

      counters.push({
        scope: String(arguments_["p_scope"]),
        keyHash: String(arguments_["p_key_hash"]),
        limit,
      });

      if (fixture.refuseCounter) {
        return [{ allowed: false, remaining: 0, retry_after_seconds: 11, first_refusal: true }];
      }

      return [{ allowed: true, remaining: limit - 1, retry_after_seconds: 0, first_refusal: false }];
    },
  };

  return fixture;
}

function dependenciesOf(fixture: Fixture): {
  rest: RestClient;
  audit: InMemoryAuditTrail;
  now: () => number;
} {
  return { rest: fixture.rest, audit: fixture.audit, now: (): number => fixture.nowMs };
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
    label: "Main store",
    keyPrefix: "ka1b2c",
    keyLastFour: "4f2a",
    lastUsedRefreshed: false,
  };
}

const validKey = "checkout-8f2c1d";

function createInput(overrides: Partial<{ amountMinor: number; method: string; key: string }> = {}): {
  principal: ReturnType<typeof principalOf>;
  idempotencyKey: string;
  request: { amountMinor: number; currency: "USD"; method: "card" | "bank_transfer" | "e_wallet" };
} {
  return {
    principal: principalOf(),
    idempotencyKey: overrides.key ?? validKey,
    request: {
      amountMinor: overrides.amountMinor ?? 12_50,
      currency: API_PAYMENT_CURRENCY,
      method: (overrides.method ?? API_PAYMENT_DEFAULT_METHOD) as "card" | "bank_transfer" | "e_wallet",
    },
  };
}

function requestOf(input: {
  readonly key?: string | null;
  readonly body?: string;
  readonly contentType?: string;
  readonly contentLength?: string | null;
}): Request {
  const headers = new Headers({
    "x-forwarded-for": "203.0.113.9",
    authorization: `Bearer ${presentedKey}`,
  });

  if (input.key !== null && input.key !== undefined) {
    headers.set("idempotency-key", input.key);
  }

  headers.set("content-type", input.contentType ?? "application/json");

  if (input.contentLength !== null && input.contentLength !== undefined) {
    headers.set("content-length", input.contentLength);
  }

  return new Request(`https://api.example.test${API_PAYMENTS_PATH}`, {
    method: "POST",
    headers,
    body: input.body ?? JSON.stringify({ amount_minor: 1250 }),
  });
}

// ---------------------------------------------------------------------------------------------
// 1. No migration, and the tables this STEP writes already exist
// ---------------------------------------------------------------------------------------------

const migrationFiles = (await readdir(new URL("../../migrations", import.meta.url).pathname)).filter((name) =>
  name.endsWith(".sql"),
);
const numbers = [
  ...new Set(migrationFiles.map((name) => Number.parseInt(name.slice(0, 4), 10)).filter(Number.isFinite)),
].sort((left, right) => left - right);

expectEqual(numbers[numbers.length - 1] ?? 0, 128, "STEP 203 adds no migration: 0033, 0037, 0031 and 0029 already hold every row it writes");

const paymentsMigration = await readFile(new URL("../../migrations/0037_payments.sql", import.meta.url), "utf8");
const keysMigration = await readFile(new URL("../../migrations/0033_idempotency_keys.sql", import.meta.url), "utf8");
const rulesMigration = await readFile(new URL("../../migrations/0031_routing_rules.sql", import.meta.url), "utf8");

expect(paymentsMigration.includes("idempotency_key_id uuid not null"), "a payment cannot exist without its idempotency key");
expect(paymentsMigration.includes("create unique index payments_idempotency_key"), "and the key can produce one payment");
expect(paymentsMigration.includes("provider_id uuid not null"), "a payment cannot exist without the provider it routed to");
expect(paymentsMigration.includes("payments_amount_check check (amount_minor > 0)"), "the amount is positive in the schema");
expect(paymentsMigration.includes("constraint payments_currency_check"), "and the currency is three upper case letters");
expect(paymentsMigration.includes("payment_method in ('card', 'bank_transfer', 'e_wallet')"), "the method list is the schema's, not the service's");
expect(paymentsMigration.includes("mode in ('test', 'live')"), "the mode is the schema's too");
expect(paymentsMigration.includes("default 'pending'"), "and a freshly written payment is pending");
expect(
  paymentsMigration.includes("null for a store payment that has no invoice yet"),
  "0037 already names the store payment: a payment with no invoice",
);
expect(keysMigration.includes("create unique index") || keysMigration.includes("unique"), "the idempotency key is unique per tenant and scope");
expect(keysMigration.includes("scope in ('payment', 'refund', 'payout')"), "and `payment` is one of its scopes");
expect(keysMigration.includes("key_hash ~ '^[0-9a-f]{64}$'"), "the key is stored as a SHA-256 hash and nothing else");
expect(keysMigration.includes("state in ('in_flight', 'completed', 'failed')"), "the three states this service walks are the schema's");
expect(rulesMigration.includes("mode in ('test', 'live')"), "routing rules are per mode, which is what keeps test money apart");
expectEqual(API_PAYMENT_SCOPE, "payment", "the service writes the scope 0033 allows");

// ---------------------------------------------------------------------------------------------
// 2. The idempotency header
// ---------------------------------------------------------------------------------------------

for (const [key, rule, description] of [
  [null, API_PAYMENT_RULES.idempotencyKeyMissing, "a call with no key"],
  ["", API_PAYMENT_RULES.idempotencyKeyMissing, "a call with an empty key"],
  ["   ", API_PAYMENT_RULES.idempotencyKeyMissing, "a call with spaces for a key"],
  ["short7", API_PAYMENT_RULES.idempotencyKeyMalformed, `a key shorter than ${String(API_IDEMPOTENCY_KEY_MINIMUM_LENGTH)}`],
  ["has space here", API_PAYMENT_RULES.idempotencyKeyMalformed, "a key with a space"],
  ["dollar$sign8", API_PAYMENT_RULES.idempotencyKeyMalformed, "a key with a character outside the set"],
  ["-leadinghyphen", API_PAYMENT_RULES.idempotencyKeyMalformed, "a key that starts with a hyphen"],
  [`${"a".repeat(API_IDEMPOTENCY_KEY_MAXIMUM_LENGTH)}b`, API_PAYMENT_RULES.idempotencyKeyMalformed, "a key past the ceiling"],
] as readonly [string | null, string, string][]) {
  const refusal = await refusalOf(async () => readIdempotencyKey(requestOf({ key })));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.status, 422, "with a 422");
  expectEqual(refusal.field, "idempotency_key", "naming the header");
  expectEqual(refusal.rule, rule, `and ${description} names ${rule}`);
}

for (const key of [
  "abcdefgh",
  "checkout-8f2c1d",
  "order:2026:11:07_42",
  "A".repeat(API_IDEMPOTENCY_KEY_MAXIMUM_LENGTH),
]) {
  expectEqual(readIdempotencyKey(requestOf({ key })), key, `"${key.slice(0, 12)}..." is accepted as a key`);
}

const trimmed = readIdempotencyKey(requestOf({ key: "  padded-key-1  " }));

expectEqual(trimmed, "padded-key-1", "surrounding whitespace is trimmed rather than refused");

// ---------------------------------------------------------------------------------------------
// 3. The body
// ---------------------------------------------------------------------------------------------

const malformed = await refusalOf(async () => readPaymentBody(requestOf({ body: "{not json" })));

expectEqual(malformed.rule, API_PAYMENT_RULES.bodyMalformed, "a body that is not JSON is refused as malformed");
expectEqual(malformed.status, 422, "with a 422");

const oversized = await refusalOf(async () =>
  readPaymentBody(requestOf({ body: JSON.stringify({ amount_minor: 1250, pad: "x".repeat(API_PAYMENT_BODY_MAXIMUM_BYTES) }) })),
);

expectEqual(oversized.code, "PAYLOAD_TOO_LARGE", "a body past the ceiling is refused as too large");
expectEqual(oversized.status, 413, "with a 413");
expectEqual(oversized.rule, API_PAYMENT_RULES.bodyTooLarge, "and its own rule");

const declaredLarge = await refusalOf(async () =>
  readPaymentBody(requestOf({ contentLength: String(API_PAYMENT_BODY_MAXIMUM_BYTES + 1), body: "{}" })),
);

expectEqual(declaredLarge.code, "PAYLOAD_TOO_LARGE", "a declared length over the ceiling is refused before the body is read");

for (const [body, field, rule, description] of [
  [{}, "amount_minor", API_PAYMENT_RULES.amountMissing, "a body with no amount"],
  [{ amount_minor: "1250" }, "amount_minor", "invalid_format", "an amount that is a string"],
  [{ amount_minor: 12.5 }, "amount_minor", API_PAYMENT_RULES.amountNotWhole, "an amount with cents of a cent"],
  [{ amount_minor: 0 }, "amount_minor", API_PAYMENT_RULES.amountTooSmall, "an amount of zero"],
  [{ amount_minor: API_PAYMENT_MINIMUM_AMOUNT_MINOR - 1 }, "amount_minor", API_PAYMENT_RULES.amountTooSmall, "an amount below the floor"],
  [{ amount_minor: API_PAYMENT_MAXIMUM_AMOUNT_MINOR + 1 }, "amount_minor", API_PAYMENT_RULES.amountTooLarge, "an amount above the ceiling"],
  [{ amount_minor: 1250, currency: "EUR" }, "currency", API_PAYMENT_RULES.currencyUnsupported, "another currency"],
  [{ amount_minor: 1250, payment_method: "cash" }, "payment_method", API_PAYMENT_RULES.methodUnsupported, "a method no gateway takes"],
  [{ amount_minor: 1250, company_id: otherCompanyId }, "company_id", API_PAYMENT_RULES.unknownField, "a company the body tries to name"],
  [{ amount_minor: 1250, mode: "live" }, "mode", API_PAYMENT_RULES.unknownField, "a mode the body tries to set"],
  [{ amount_minor: 1250, status: "captured" }, "status", API_PAYMENT_RULES.unknownField, "a status the body tries to set"],
] as readonly [unknown, string, string, string][]) {
  const refusal = await refusalOf(async () => parseStorePaymentRequest(body));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.field, field, `and ${description} names ${field}`);
  expectEqual(refusal.rule, rule, `and ${description} carries ${rule}`);
}

const parsedRequest = parseStorePaymentRequest({ amount_minor: API_PAYMENT_MINIMUM_AMOUNT_MINOR });

expectEqual(parsedRequest.amountMinor, API_PAYMENT_MINIMUM_AMOUNT_MINOR, "the floor amount is accepted");
expectEqual(parsedRequest.currency, "USD", "and the currency defaults to USD rather than being absent");
expectEqual(parsedRequest.method, API_PAYMENT_DEFAULT_METHOD, "and the method defaults to the one every gateway takes");

const explicitRequest = parseStorePaymentRequest({
  amount_minor: API_PAYMENT_MAXIMUM_AMOUNT_MINOR,
  currency: "USD",
  payment_method: "bank_transfer",
});

expectEqual(explicitRequest.method, "bank_transfer", "a named method is kept");
expectEqual(explicitRequest.currency, "USD", "and a currency of USD is accepted as the same answer");

// ---------------------------------------------------------------------------------------------
// 4. Creation
// ---------------------------------------------------------------------------------------------

const createFixtureOne = createFixture();
const created = await createStorePayment(createInput(), dependenciesOf(createFixtureOne));
const paymentRow = createFixtureOne.state.payments[0] ?? {};
const keyRow = createFixtureOne.state.idempotency_keys[0] ?? {};

expectEqual(created.status, 201, "a valid request creates a payment");
expectEqual(created.replayed, false, "and is not a replay");
expectEqual(created.body.object, "payment", "the answer names its object");
expectEqual(created.body.status, "pending", "a created payment is pending");
expectEqual(created.body.amount_minor, 12_50, "with the amount that was asked for");
expectEqual(created.body.currency, "USD", "in the only currency the platform trades in");
expectEqual(created.body.mode, "test", "in the mode the credential was issued for");
expectEqual(created.body.payment_method, "card", "and the method that was chosen");
expect(/^\d{4}-\d{2}-\d{2}T/u.test(created.body.created_at), "with the instant the row was written");
expectEqual(paymentRow["company_id"], companyId, "the payment belongs to the merchant the key proved");
expectEqual(paymentRow["mode"], "test", "and its mode is the credential's, not the body's");
expectEqual(paymentRow["status"], "pending", "it starts pending");
expectEqual(paymentRow["currency"], "USD", "its currency is USD");
expectEqual(paymentRow["amount_minor"], 12_50, "its amount is the request's");
expectEqual(paymentRow["invoice_id"], null, "a store payment has no invoice");
expectEqual(paymentRow["provider_key_id"], null, "and no provider key, because no call has been signed yet");
expectEqual(paymentRow["idempotency_key_id"], keyRow["id"], "the payment names the key row it was made under");
expectEqual(keyRow["state"], "completed", "the key row is completed");
expectEqual(keyRow["response_status"], 201, "with the status to replay");
expect(typeof keyRow["response_body"] === "string" && String(keyRow["response_body"]).length >= 2, "and the body to replay");
expectEqual(keyRow["scope"], "payment", "the row is scoped to payments");
expectEqual(String(keyRow["key_hash"]).length, 64, "the stored key is a 64 character hash");
expect(/^[0-9a-f]{64}$/u.test(String(keyRow["key_hash"])), "and it is lower case hex");
expect(!JSON.stringify(paymentRow).includes(validKey), "the caller's key is not in the payment row");
expect(!JSON.stringify(keyRow).includes(validKey), "and not in the key row either");
expect(!JSON.stringify(created.body).includes(validKey), "and not in the answer");
expectEqual(Number(paymentRow["provider_id"]) === 0, false, "the payment names a provider");
expect(
  [providerNmiId, providerStripeId].includes(String(paymentRow["provider_id"])),
  "and the provider is one of the live ones",
);

// ---------------------------------------------------------------------------------------------
// 5. Routing
// ---------------------------------------------------------------------------------------------

expectEqual(
  paymentRow["provider_id"],
  providerStripeId,
  "the highest priority rule wins, and the card rule outranks both general rules",
);
expectEqual(paymentRow["routing_rule_id"], ruleCardId, "and the payment names the rule that chose the provider");

const generalFixture = createFixture();

await createStorePayment(createInput({ method: "bank_transfer", key: "checkout-general-1" }), dependenciesOf(generalFixture));

expectEqual(
  generalFixture.state.payments[0]?.["provider_id"],
  providerStripeId,
  "a method no card rule names falls to the general rule, which is still the higher priority one",
);

const liveFixture = createFixture();
const liveCredential = principalOf({ mode: "live" });

liveFixture.state.credentials = [{ ...liveFixture.state.credentials[0], mode: "live" }];

const liveCreated = await createStorePayment(
  { ...createInput({ key: "checkout-live-1" }), principal: liveCredential },
  dependenciesOf(liveFixture),
);

expectEqual(liveCreated.body.mode, "live", "a live credential creates a live payment");
expectEqual(liveFixture.state.payments[0]?.["provider_id"], providerNmiId, "and is routed by the live rule only");

const noRuleFixture = createFixture();

noRuleFixture.state.routing_rules = [];

const noRule = await refusalOf(async () =>
  createStorePayment(createInput({ key: "checkout-norule-1" }), dependenciesOf(noRuleFixture)),
);

expectEqual(noRule.code, "VALIDATION_FAILED", "a merchant with no rule is refused");
expectEqual(noRule.status, 422, "with a 422 rather than a 500");
expectEqual(noRule.rule, API_PAYMENT_RULES.routeUnavailable, "and says the route is unavailable");
expectEqual(noRuleFixture.state.payments.length, 0, "no payment is written");
expectEqual(noRuleFixture.state.idempotency_keys[0]?.["state"], "failed", "and the key is spent");
expectEqual(noRuleFixture.state.idempotency_keys[0]?.["error_detail"], API_PAYMENT_RULES.routeUnavailable, "with the rule that spent it");

const platformFixture = createFixture();

platformFixture.state.routing_rules = platformFixture.state.routing_rules.filter(
  (row) => row["company_id"] === null,
);

const platformCreated = await refusalOf(async () =>
  createStorePayment(createInput({ key: "checkout-platform-1" }), dependenciesOf(platformFixture)),
);

expectEqual(platformCreated.code, "no-refusal", "a platform rule serves a merchant that has none of its own");
expectEqual(platformFixture.state.payments[0]?.["routing_rule_id"], rulePlatformId, "and the payment names the platform rule");

const countryFixture = createFixture();

countryFixture.state.routing_rules = countryFixture.state.routing_rules.filter(
  (row) => row["id"] === ruleCountryId,
);

const countryOnly = await refusalOf(async () =>
  createStorePayment(createInput({ key: "checkout-country-1" }), dependenciesOf(countryFixture)),
);

expectEqual(
  countryOnly.rule,
  API_PAYMENT_RULES.routeUnavailable,
  "a country scoped rule cannot route a store payment, because the request names no country",
);

const disabledFixture = createFixture();

disabledFixture.state.routing_rules = disabledFixture.state.routing_rules.filter(
  (row) => row["id"] === ruleDisabledId,
);

const disabledOnly = await refusalOf(async () =>
  createStorePayment(createInput({ key: "checkout-disabled-1" }), dependenciesOf(disabledFixture)),
);

expectEqual(disabledOnly.rule, API_PAYMENT_RULES.routeUnavailable, "a disabled provider's rule is not a route");

const unknownProviderFixture = createFixture();

unknownProviderFixture.state.payment_providers = unknownProviderFixture.state.payment_providers.map((row) =>
  row["id"] === providerStripeId ? { ...row, provider_key: "not-a-registry-key" } : row,
);

await createStorePayment(createInput({ key: "checkout-unknown-1" }), dependenciesOf(unknownProviderFixture));

expectEqual(
  unknownProviderFixture.state.payments[0]?.["provider_id"],
  providerNmiId,
  "a provider the registry does not know is skipped rather than routed to",
);

expect(
  STORE_PAYMENT_PROVIDER_KEYS.includes("nmi") && STORE_PAYMENT_PROVIDER_KEYS.length === 5,
  "the five registry providers are the ones a rule can name",
);

// ---------------------------------------------------------------------------------------------
// 6. Idempotency
// ---------------------------------------------------------------------------------------------

const replayFixture = createFixture();

await createStorePayment(createInput(), dependenciesOf(replayFixture));
const replayed = await createStorePayment(createInput(), dependenciesOf(replayFixture));

expectEqual(replayFixture.state.payments.length, 1, "the same key and the same body make one payment");
expectEqual(replayed.replayed, true, "and the second call is a replay");
expectEqual(
  replayed.body.id,
  String(replayFixture.state.payments[0]?.["id"]),
  "the replay answers with the payment the key produced",
);
expectEqual(
  JSON.stringify(replayed.body),
  String(replayFixture.state.idempotency_keys[0]?.["response_body"]),
  "byte for byte, the body stored on the key row",
);

const conflictFixture = createFixture();

await createStorePayment(createInput(), dependenciesOf(conflictFixture));
const conflicted = await refusalOf(async () =>
  createStorePayment(createInput({ amountMinor: 99_00 }), dependenciesOf(conflictFixture)),
);

expectEqual(conflicted.code, "IDEMPOTENCY_CONFLICT", "the same key with another amount is a conflict");
expectEqual(conflicted.status, 409, "with a 409");
expectEqual(conflicted.rule, API_PAYMENT_RULES.idempotencyConflict, "and its own rule");
expectEqual(conflictFixture.state.payments.length, 1, "no second payment is written");

const inFlightFixture = createFixture();

inFlightFixture.state.idempotency_keys.push({
  id: "40000000-0000-4000-8000-000000000099",
  company_id: companyId,
  scope: "payment",
  key_hash: hashOfKey(validKey),
  request_hash: hashOfKey(JSON.stringify([12_50, "USD", "card"])),
  state: "in_flight",
  response_status: null,
  response_body: null,
  error_detail: null,
  completed_at: null,
  expires_at: new Date(startedAt + 86_400_000).toISOString(),
  created_at: new Date(startedAt).toISOString(),
  updated_at: new Date(startedAt).toISOString(),
  deleted_at: null,
  version: 1,
});

const inFlight = await refusalOf(async () =>
  createStorePayment(createInput(), dependenciesOf(inFlightFixture)),
);

expectEqual(inFlight.code, "CONFLICT", "a key still in flight is a conflict");
expectEqual(inFlight.status, 409, "with a 409");
expectEqual(inFlight.rule, API_PAYMENT_RULES.idempotencyInFlight, "and says the first attempt is running");
expectEqual(inFlightFixture.state.payments.length, 0, "no payment is written behind a key in flight");

// An attempt that was abandoned by the process, not by a decision: killed between claiming its key and recording the
// answer. `idempotency_keys` has no expiry of its own and its unique index covers deleted rows too, so without the
// staleness window below the key is stuck for ever and this checkout can never be paid again. The repair is one of two
// things, and which one is decided by whether the dead attempt had already written its payment.

const abandonedResumeFixture = createFixture();
const abandonedResumeFirst = await createStorePayment(
  createInput({ key: "checkout-abandoned-1" }),
  dependenciesOf(abandonedResumeFixture),
);

// Rewind the fixture to the moment after the key was claimed and before the payment was written.
abandonedResumeFixture.state.payments.length = 0;
const resumedRow = abandonedResumeFixture.state.idempotency_keys[0];

if (resumedRow !== undefined) {
  resumedRow["state"] = "in_flight";
  resumedRow["response_status"] = null;
  resumedRow["response_body"] = null;
  resumedRow["completed_at"] = null;
  resumedRow["created_at"] = new Date(startedAt - 400_000).toISOString();
}

const resumed = await createStorePayment(
  createInput({ key: "checkout-abandoned-1" }),
  dependenciesOf(abandonedResumeFixture),
);

expectEqual(resumed.status, 201, "a stale in-flight key with no payment behind it is carried on rather than refused");
expectEqual(resumed.replayed, false, "and it is a fresh attempt, not a replay");
expectEqual(abandonedResumeFixture.state.payments.length, 1, "which writes exactly one payment");
expectEqual(
  abandonedResumeFixture.state.idempotency_keys.length,
  1,
  "on the row that was already there, because the key is unique and a second row is impossible",
);
expectEqual(
  abandonedResumeFixture.state.idempotency_keys[0]?.["state"],
  "completed",
  "and the key is completed at the end, so the next retry replays",
);
expect(
  resumed.body.id !== abandonedResumeFirst.body.id,
  "the resumed attempt is a new payment, because the abandoned one never reached the table",
);

const abandonedHealedFixture = createFixture();
const abandonedHealedFirst = await createStorePayment(
  createInput({ key: "checkout-abandoned-2" }),
  dependenciesOf(abandonedHealedFixture),
);
const healedRow = abandonedHealedFixture.state.idempotency_keys[0];

if (healedRow !== undefined) {
  healedRow["state"] = "in_flight";
  healedRow["response_status"] = null;
  healedRow["response_body"] = null;
  healedRow["completed_at"] = null;
  healedRow["created_at"] = new Date(startedAt - 400_000).toISOString();
}

const healed = await createStorePayment(
  createInput({ key: "checkout-abandoned-2" }),
  dependenciesOf(abandonedHealedFixture),
);

expectEqual(healed.status, 201, "a stale in-flight key whose payment was written is answered, not refused");
expectEqual(healed.replayed, true, "as the replay it is");
expectEqual(
  JSON.stringify(healed.body),
  JSON.stringify(abandonedHealedFirst.body),
  "byte for byte the answer the first attempt would have given",
);
expectEqual(abandonedHealedFixture.state.payments.length, 1, "and no second payment is written, which is the whole point");
expectEqual(abandonedHealedFixture.state.idempotency_keys[0]?.["state"], "completed", "the key is completed from that payment");
expectEqual(
  String(abandonedHealedFixture.state.payments[0]?.["id"]),
  healed.body.id,
  "and it names the payment that exists rather than a new one",
);

const abandonedConflictFixture = createFixture();
const abandonedConflictFirst = await createStorePayment(
  createInput({ key: "checkout-abandoned-3" }),
  dependenciesOf(abandonedConflictFixture),
);

abandonedConflictFixture.state.payments.length = 0;
const conflictRow = abandonedConflictFixture.state.idempotency_keys[0];

if (conflictRow !== undefined) {
  conflictRow["state"] = "in_flight";
  conflictRow["response_status"] = null;
  conflictRow["response_body"] = null;
  conflictRow["completed_at"] = null;
  conflictRow["created_at"] = new Date(startedAt - 400_000).toISOString();
}

const abandonedConflict = await refusalOf(async () =>
  createStorePayment(createInput({ key: "checkout-abandoned-3", amountMinor: 99_00 }), dependenciesOf(abandonedConflictFixture)),
);

expectEqual(abandonedConflict.code, "IDEMPOTENCY_CONFLICT", "an abandoned key replayed with another body is still a conflict");
expectEqual(abandonedConflictFixture.state.payments.length, 0, "and nothing is written for it");
expectEqual(abandonedConflictFirst.body.amount_minor, 12_50, "the first body is what the key remembers");

const spentFixture = createFixture();

spentFixture.state.idempotency_keys.push({
  id: "40000000-0000-4000-8000-000000000098",
  company_id: companyId,
  scope: "payment",
  key_hash: hashOfKey(validKey),
  request_hash: hashOfKey(JSON.stringify([12_50, "USD", "card"])),
  state: "failed",
  response_status: null,
  response_body: null,
  error_detail: API_PAYMENT_RULES.routeUnavailable,
  completed_at: null,
  expires_at: new Date(startedAt + 86_400_000).toISOString(),
  created_at: new Date(startedAt).toISOString(),
  updated_at: new Date(startedAt).toISOString(),
  deleted_at: null,
  version: 1,
});

const spent = await refusalOf(async () => createStorePayment(createInput(), dependenciesOf(spentFixture)));

expectEqual(spent.code, "CONFLICT", "a key whose attempt failed is a conflict");
expectEqual(spent.rule, API_PAYMENT_RULES.idempotencyFailed, "and says the key is spent rather than repeating the refusal");
expectEqual(spentFixture.state.payments.length, 0, "no payment is written under a spent key");

const raceFixture = createFixture();

raceFixture.blindOnce = true;
raceFixture.state.idempotency_keys.push({
  id: "40000000-0000-4000-8000-000000000097",
  company_id: companyId,
  scope: "payment",
  key_hash: hashOfKey(validKey),
  request_hash: hashOfKey(JSON.stringify([12_50, "USD", "card"])),
  state: "completed",
  response_status: 201,
  response_body: JSON.stringify({
    id: "41000000-0000-4000-8000-000000000001",
    object: "payment",
    status: "pending",
    amount_minor: 12_50,
    currency: "USD",
    mode: "test",
    payment_method: "card",
    created_at: new Date(startedAt).toISOString(),
  }),
  error_detail: null,
  completed_at: new Date(startedAt).toISOString(),
  expires_at: new Date(startedAt + 86_400_000).toISOString(),
  created_at: new Date(startedAt).toISOString(),
  updated_at: new Date(startedAt).toISOString(),
  deleted_at: null,
  version: 2,
});

const raced = await refusalOf(async () => createStorePayment(createInput(), dependenciesOf(raceFixture)));

expectEqual(raced.code, "no-refusal", "a writer that loses the race re-reads the winner's row rather than erroring");
expectEqual(raceFixture.state.payments.length, 0, "and writes no second payment");

const otherTenantFixture = createFixture();
const otherTenantPrincipal = principalOf({ companyId: otherCompanyId });

await createStorePayment(createInput(), dependenciesOf(otherTenantFixture));
await createStorePayment(
  { ...createInput(), principal: otherTenantPrincipal },
  dependenciesOf(otherTenantFixture),
);

expectEqual(otherTenantFixture.state.payments.length, 2, "the same key from two merchants is two payments");

// ---------------------------------------------------------------------------------------------
// 7. The chain
// ---------------------------------------------------------------------------------------------

const recoveredFixture = createFixture();

recoveredFixture.loseUpdate = true;
const tolerated = await refusalOf(async () =>
  createStorePayment(createInput({ key: "checkout-lost-1" }), dependenciesOf(recoveredFixture)),
);

expectEqual(tolerated.code, "no-refusal", "a completion write that lands nowhere does not fail the call");
expectEqual(recoveredFixture.state.idempotency_keys[0]?.["state"], "in_flight", "the key stays in flight, which a retry reports as such");
expectEqual(recoveredFixture.state.payments.length, 1, "and the payment exists either way");

const failingFixture = createFixture();

failingFixture.failPaymentOnce = true;
const failedInsert = await refusalOf(async () =>
  createStorePayment(createInput({ key: "checkout-fail-1" }), dependenciesOf(failingFixture)),
);

expectEqual(failedInsert.code, "VALIDATION_FAILED", "a payment the schema refuses is reported as a validation failure");
expectEqual(failingFixture.state.payments.length, 0, "no payment row exists");
expectEqual(failingFixture.state.idempotency_keys[0]?.["state"], "failed", "and the key is spent rather than left in flight");

const createdEntries = createFixtureOne.audit.entries.filter((entry) => entry.action === API_PAYMENT_AUDIT.created);

expectEqual(createdEntries.length, 1, "one created payment writes one chain entry");
expectEqual(createdEntries[0]?.payload["amount_minor"], 12_50, "with the amount");
expectEqual(createdEntries[0]?.payload["mode"], "test", "and the mode");
expectEqual(createdEntries[0]?.payload["provider"], "stripe_connect", "and the provider the money went to");
expectEqual(createdEntries[0]?.payload["credential_id"], credentialId, "and the credential that called");
expectEqual(createdEntries[0]?.companyId, companyId, "on the merchant's chain");
expectEqual(createdEntries[0]?.entityId, created.body.id, "against the payment");
expect(!JSON.stringify(createdEntries[0]?.payload ?? {}).includes(validKey), "and the caller's key is not in it");

const replayEntries = replayFixture.audit.entries.filter((entry) => entry.action === API_PAYMENT_AUDIT.created);

expectEqual(replayEntries.length, 1, "a replay writes no second creation entry");
expectEqual(noRuleFixture.audit.entries.length, 0, "a refusal that never reached a provider writes nothing to the chain here");

// ---------------------------------------------------------------------------------------------
// 8. Through the pipeline: counted, recorded, and refused calls write nothing
// ---------------------------------------------------------------------------------------------

const pipelineFixture = createFixture();
const pipelineAnswer = await handlePublicApiCall(
  {
    request: requestOf({
      key: "checkout-pipeline-1",
      body: JSON.stringify({ amount_minor: 25_00 }),
    }),
    route: API_PAYMENTS_PATH,
    handler: async (context) => {
      const idempotencyKey = readIdempotencyKey(context.request);
      const body = await readPaymentBody(context.request);
      const paymentRequest = parseStorePaymentRequest(body);
      const outcome = await createStorePayment(
        { principal: context.principal, idempotencyKey, request: paymentRequest },
        dependenciesOf(pipelineFixture),
      );

      return { status: outcome.status, body: outcome.body, headers: outcome.replayed ? { [API_REPLAY_HEADER]: "true" } : {} };
    },
  },
  {
    ...dependenciesOf(pipelineFixture),
    rest: pipelineFixture.rest,
  },
);

expectEqual(pipelineAnswer.status, 201, "through the pipeline the call answers 201");
expectEqual(pipelineAnswer.headers[API_REPLAY_HEADER], undefined, "a first answer carries no replay header");
expectEqual(pipelineFixture.counters.length, 3, "the call was counted in all three public_api buckets");
expectEqual(
  pipelineFixture.counters.find((counter) => counter.scope.startsWith("route_public_api"))?.limit,
  RATE_LIMIT_CLASS_POLICIES.public_api.route.limit,
  "against the limiter's own route ceiling",
);
expectEqual(
  pipelineFixture.audit.entries.filter((entry) => entry.action === "api.call").length,
  1,
  "and the pipeline recorded the call",
);
expectEqual(
  pipelineFixture.audit.entries.find((entry) => entry.action === "api.call")?.payload["status"],
  201,
  "with the status the route answered",
);
expect(
  pipelineFixture.queries.every((query) => !query.includes("card_number")),
  "no query this STEP makes names a card field",
);

const refusedFixture = createFixture();

refusedFixture.refuseCounter = true;
const refused = await refusalOf(async () =>
  handlePublicApiCall(
    {
      request: requestOf({ key: "checkout-refused-1" }),
      route: API_PAYMENTS_PATH,
      handler: async () => ({ status: 201, body: { ok: true } }),
    },
    dependenciesOf(refusedFixture),
  ),
);

expectEqual(refused.code, "RATE_LIMITED", "a full bucket refuses before the handler runs");
expectEqual(refusedFixture.state.payments.length, 0, "and no payment is written");

// ---------------------------------------------------------------------------------------------
// 9. The route file
// ---------------------------------------------------------------------------------------------

const routeSource = await readFile(
  new URL("../../app/api/public/v1/payments/route.ts", import.meta.url),
  "utf8",
);

expect(routeSource.includes("export const POST"), "the payments route answers a POST");
expect(!routeSource.includes("export const GET"), "and no GET: reading a payment is STEP 204's endpoint");
expect(!routeSource.includes("export const PUT") && !routeSource.includes("export const DELETE"), "and no other verb");
expect(routeSource.includes("handlePublicApiCall("), "it goes through STEP 202's pipeline");
expect(routeSource.includes("readIdempotencyKey(context.request)"), "reads the idempotency key first");
expect(routeSource.includes("readPaymentBody(context.request)"), "then the bounded body");
expect(routeSource.includes("parseStorePaymentRequest(body)"), "then the three field schema");
expect(routeSource.includes("createStorePayment("), "then the service");
expect(routeSource.includes('export const dynamic = "force-dynamic"'), "and is never cached");
expect(!routeSource.includes("requireCsrfToken("), "it asks for no CSRF token, because a bearer key is not ambient");
expect(!routeSource.includes("cookie"), "and reads no cookie");
expect(!routeSource.includes("console."), "and prints nothing");
expect(!/card_(?:number|expiry|cvv|token)/u.test(routeSource), "and names no card field");
expect(routeSource.includes("headers: answer.headers"), "the answer's headers reach the response");
expect(
  routeSource.includes(`[API_REPLAY_HEADER]: "true"`),
  "and the replay header is set only when the outcome is a replay",
);

const serviceSource = await readFile(new URL("./store-payments.ts", import.meta.url), "utf8");

expect(serviceSource.includes("createHash(\"sha256\")"), "the service hashes the key with SHA-256");
expect(serviceSource.includes("hashOf(input.idempotencyKey)"), "the key is hashed once, on the way in");
expect(serviceSource.includes("key_hash: input.keyHash"), "and the row is written with the hash");
expect(!serviceSource.includes("key_hash: input.idempotencyKey"), "the key string never reaches the row");
expect(serviceSource.includes("state: \"in_flight\""), "the key is claimed before the payment is written");
expect(serviceSource.includes("state: \"completed\""), "and completed with the answer to replay");
expect(serviceSource.includes("routePayment("), "routing goes through the payment core's engine");
expect(serviceSource.includes("insertReturning("), "and the payment is written and read back");
expect(
  serviceSource.includes("select=id,state,request_hash,created_at"),
  "the key read carries the moment it was claimed, which is what staleness is measured from",
);
expect(serviceSource.includes("settleAbandonedAttempt("), "an in-flight key is settled rather than refused blindly");
expect(
  serviceSource.includes("idempotency_key_id=eq.${encodeURIComponent(keyId)}"),
  "and the decision asks the payments table whether the dead attempt wrote anything",
);
expect(!serviceSource.includes("console."), "the service prints nothing");

const fieldsSource = await readFile(new URL("./payment-fields.ts", import.meta.url), "utf8");

expect(!fieldsSource.includes("from \"node:"), "the vocabulary imports no Node builtin");
expect(fieldsSource.includes("export const API_IDEMPOTENCY_ABANDONED_SECONDS = 300;"), "the staleness window is a named constant, pinned");
expectEqual(API_PAYMENTS_PATH, `${PUBLIC_API_BASE}/payments`, "the endpoint lives under the public API's version root");
expectEqual(API_PAYMENTS_PATH, "/api/public/v1/payments", "at the path a store is told to call");
expectEqual(API_IDEMPOTENCY_HEADER, "idempotency-key", "the key travels in the header the contract names");
expectEqual(API_REPLAY_HEADER, "idempotency-replayed", "and a replay is marked by its own header");
expectEqual(API_IDEMPOTENCY_KEY_MINIMUM_LENGTH, 8, "the key floor is eight characters");
expectEqual(API_IDEMPOTENCY_KEY_MAXIMUM_LENGTH, 128, "and its ceiling a hundred and twenty eight");
expectEqual(API_PAYMENT_BODY_MAXIMUM_BYTES, 2_048, "the body ceiling is two kilobytes");
expectEqual(API_PAYMENT_CURRENCY, "USD", "the platform takes one currency");
expect(API_PAYMENT_METHODS.length === 3, "the vocabulary names three methods");
expect(
  API_PAYMENT_METHODS.includes("card") && API_PAYMENT_METHODS.includes("bank_transfer") && API_PAYMENT_METHODS.includes("e_wallet"),
  "in the schema's own three",
);
expectEqual(API_PAYMENT_MINIMUM_AMOUNT_MINOR, 50, "the amount floor is fifty cents");
expectEqual(API_PAYMENT_MAXIMUM_AMOUNT_MINOR, 10_000_000, "and the ceiling a hundred thousand dollars");
expect(API_PAYMENT_MINIMUM_AMOUNT_MINOR < API_PAYMENT_MAXIMUM_AMOUNT_MINOR, "the amount floor is below the ceiling");
expect(API_PAYMENT_MINIMUM_AMOUNT_MINOR > 0, "and the floor is a real amount");
expect(
  Object.values(API_PAYMENT_RULES).every((rule) => /^[a-z][a-z0-9_]+$/u.test(rule)),
  "every refusal rule is a machine word",
);
expect(/^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(API_PAYMENT_AUDIT.created), "the audit action fits the chain's pattern");
expect(
  !JSON.stringify(Object.values(API_PAYMENT_TABLES)).includes("card"),
  "the tables this STEP names hold no card column",
);

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`store payments gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `store payments gate passed: ${String(checkCount)} checks, one authenticated call from an online store ` +
      "becoming one payment under one hashed idempotency key, routed by the payment core's own engine, refused " +
      "when the merchant has no route that accepts it, and recorded in the chain with nothing that names the " +
      "caller's key\n",
  );
}
