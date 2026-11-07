// path: lib/api/verify-sandbox-simulation.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import {
  createInMemoryAuditTrail,
  type AuditEntry,
  type AuditTrail,
  type InMemoryAuditTrail,
} from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { API_PAYMENTS_PATH } from "./payment-fields.ts";
import { PUBLIC_API_BASE, PUBLIC_API_VERSION, PUBLIC_API_VERSION_HEADER } from "./public-fields.ts";
import { handlePublicApiCall } from "./public-api.ts";
import {
  API_PAYMENT_ID_MAXIMUM_LENGTH,
  API_PAYMENT_STATUS_COLUMNS,
  API_PAYMENT_STATUS_FIELD,
  API_PAYMENT_STATUS_RULES,
  paymentStatusPathOf,
} from "./store-payment-status.ts";
import {
  API_SANDBOX_AUDIT,
  API_SANDBOX_BODY_MAXIMUM_BYTES,
  API_SANDBOX_CAPTURE_THREE_DS,
  API_SANDBOX_DECLINE_CODE,
  API_SANDBOX_ENTITY,
  API_SANDBOX_PATH_SEGMENT,
  API_SANDBOX_PAYMENT_TABLE,
  API_SANDBOX_READ_COLUMNS,
  API_SANDBOX_RESULT_STATUSES,
  API_SANDBOX_REVIEW_RISK,
  API_SANDBOX_ROUTE,
  API_SANDBOX_RULES,
  API_SANDBOX_SCENARIOS,
  API_SANDBOX_SCENARIO_FIELD,
  API_SANDBOX_SIMULABLE_STATUSES,
  API_SANDBOX_VERIFY_COLUMNS,
  isSandboxScenario,
  sandboxPatchFor,
  sandboxPathOf,
  type ApiSandboxScenario,
} from "./sandbox-fields.ts";
import {
  assertTestCredential,
  guardTestCredential,
  parseSandboxSimulationRequest,
  paymentViewFieldNames,
  readSandboxBody,
  simulateTestPayment,
} from "./sandbox-payment.ts";
import { CREDENTIAL_KEY_PATTERN } from "./credential-fields.ts";

/**
 * The gate for STEP 206: merchant test credentials and sandbox payment simulation.
 *
 * ## What this proves
 *
 *   - **No migration.** `0037` already holds every column a simulation writes and every constraint the write has to
 *     satisfy, including the three dimensional secure rule that decides what a simulated capture may record.
 *   - **The test fence is two fences.** A live credential is refused `403` before a body is read and before a query,
 *     *and* every query of the service names `mode=eq.test` as a literal rather than splicing the principal's mode -
 *     so section 8's "fully separated" survives the removal of either one.
 *   - **A scenario is a scripted answer, not a patch.** Three words, a closed table from each to columns, and a patch
 *     that cannot name an amount, a currency, a fee, a refunded total, a provider transaction id or a card field:
 *     "test payments move no real money" as a property of the code rather than of its intentions.
 *   - **The write is a compare-and-set.** One read with the version, one update filtered on it, one read-back that
 *     requires the version to have advanced *and* the row to hold the scenario's status - and a lost race answered
 *     `409` rather than reported as success.
 *   - **Five kinds of "not yours" are one answer, again.** Unknown, another merchant's, another mode's, an invoice
 *     payment and a deleted payment all answer STEP 204's `404`, and a decided payment answers `409`.
 *   - **The chain names what moved.** `api.sandbox_payment_simulated` carries the scenario and both statuses and
 *     never a key, an amount or a card; every refusal writes `api.sandbox_simulation_refused`; and a deaf trail
 *     changes neither a simulation's outcome nor a live credential's refusal.
 *   - **The route is one verb and one template.** `POST` only, the pipeline's route string rather than the arriving
 *     path, the credential fenced before the body, and an answer shaped exactly as STEP 204 serves the same payment.
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

const companyId = "7a000000-0000-4000-8000-000000000001";
const otherCompanyId = "7a000000-0000-4000-8000-000000000002";
const credentialId = "7b000000-0000-4000-8000-000000000001";
const liveCredentialId = "7b000000-0000-4000-8000-000000000002";
const testKey = `kd_test_sandbox_${"1".repeat(64)}`;
const liveKey = `kd_live_sandbox_${"2".repeat(64)}`;
const startedAt = Date.parse("2026-11-07T12:00:00.000Z");
const instantIso = new Date(startedAt).toISOString();

function uuidOf(suffix: number): string {
  return `0192f0a1-7c3d-7000-8000-${String(suffix).padStart(12, "0")}`;
}

function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const pendingId = uuidOf(1);
const capturedId = uuidOf(2);
const livePendingId = uuidOf(3);
const invoicePaymentId = uuidOf(4);
const deletedPaymentId = uuidOf(5);
const foreignCompanyPaymentId = uuidOf(6);
const secondPendingId = uuidOf(7);

function paymentRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    company_id: companyId,
    invoice_id: null,
    provider_id: uuidOf(900),
    idempotency_key_id: uuidOf(901),
    status: "pending",
    amount_minor: 12_50,
    refunded_minor: 0,
    currency: "USD",
    fee_minor: 0,
    platform_fee_minor: 0,
    mode: "test",
    payment_method: "card",
    three_ds_outcome: "not_requested",
    postal_code_matched: false,
    ip_country_matched: false,
    risk_decision: "allow",
    provider_transaction_id: null,
    card_brand: null,
    card_last_four: null,
    failure_code: null,
    failure_detail: null,
    authorized_at: null,
    captured_at: null,
    settled_at: null,
    failed_at: null,
    refunded_at: null,
    created_at: instantIso,
    updated_at: instantIso,
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

interface Query {
  readonly equals: Map<string, string>;
  readonly nulls: Set<string>;
  readonly limit: number | null;
  readonly select: string | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const nulls = new Set<string>();
  let limit: number | null = null;
  let select: string | null = null;

  for (const part of query.split("&")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === "select") {
      select = value;
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

  return { equals, nulls, limit, select };
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
  readonly writes: { table: string; query: string; values: Row }[];
  readonly counters: { scope: string; limit: number }[];
  nowMs: number;
  refuseCounter: boolean;
  failAudit: boolean;
  loseRace: "none" | "untouched" | "vanished";
}

function createFixture(): Fixture {
  const state: Fixture["state"] = {
    credentials: [
      {
        id: credentialId,
        company_id: companyId,
        label: "Sandbox key",
        mode: "test",
        status: "active",
        key_prefix: "kd_test_sandbox_1",
        key_hash: hashOf(testKey),
        key_last_four: "1111",
        last_used_at: null,
        version: 1,
        deleted_at: null,
      },
      {
        id: liveCredentialId,
        company_id: companyId,
        label: "Live key",
        mode: "live",
        status: "active",
        key_prefix: "kd_live_sandbox_2",
        key_hash: hashOf(liveKey),
        key_last_four: "2222",
        last_used_at: null,
        version: 1,
        deleted_at: null,
      },
    ],
    companies: [
      { id: companyId, name: "Northwind Studio", deleted_at: null },
      { id: otherCompanyId, name: "Second Store", deleted_at: null },
    ],
    payments: [
      paymentRow(pendingId),
      paymentRow(capturedId, {
        status: "captured",
        three_ds_outcome: "authenticated",
        authorized_at: instantIso,
        captured_at: instantIso,
      }),
      paymentRow(livePendingId, { mode: "live" }),
      paymentRow(invoicePaymentId, { invoice_id: uuidOf(902) }),
      paymentRow(deletedPaymentId, { deleted_at: instantIso }),
      paymentRow(foreignCompanyPaymentId, { company_id: otherCompanyId }),
      paymentRow(secondPendingId),
    ],
  };
  const queries: string[] = [];
  const writes: { table: string; query: string; values: Row }[] = [];
  const counters: { scope: string; limit: number }[] = [];
  const audit = createInMemoryAuditTrail();
  const fixture: Fixture = {
    rest: undefined as unknown as RestClient,
    audit,
    state,
    queries,
    writes,
    counters,
    nowMs: startedAt,
    refuseCounter: false,
    failAudit: false,
    loseRace: "none",
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

      if (table !== API_SANDBOX_PAYMENT_TABLE) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      const parsed = parseQuery(query);
      const selected = state.payments.filter((row) => matchesRow(row, parsed));

      return schema.array().parse(
        (parsed.limit === null ? selected : selected.slice(0, parsed.limit)).map((row) => ({ ...row })),
      );
    },

    async insert(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "simulation_inserts_nothing" } });
    },

    async insertReturning(): Promise<never> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "simulation_inserts_nothing" } });
    },

    async update(
      table: string,
      query: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      writes.push({ table, query, values: { ...values } });

      if (table !== API_SANDBOX_PAYMENT_TABLE) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      const parsed = parseQuery(query);
      const matched = state.payments.filter((row) => matchesRow(row, parsed));

      if (fixture.loseRace === "untouched") {
        // A concurrent writer won: its patch landed, so the version advanced but our status did not.
        for (const row of matched) {
          row["version"] = Number(row["version"]) + 1;
        }

        return;
      }

      if (fixture.loseRace === "vanished") {
        state.payments = state.payments.filter((row) => !matched.includes(row));

        return;
      }

      for (const row of matched) {
        Object.assign(row, values);
        row["version"] = Number(row["version"]) + 1;
      }
    },

    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (functionName !== "consume_rate_limit") {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_function" } });
      }

      counters.push({ scope: String(arguments_["p_scope"]), limit: Number(arguments_["p_limit"]) });

      return fixture.refuseCounter
        ? [{ allowed: false, remaining: 0, retry_after_seconds: 7, first_refusal: true }]
        : [
            {
              allowed: true,
              remaining: Number(arguments_["p_limit"]) - 1,
              retry_after_seconds: 0,
              first_refusal: false,
            },
          ];
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
  const mode = overrides.mode ?? "test";

  return {
    credentialId: mode === "test" ? credentialId : liveCredentialId,
    companyId: overrides.companyId ?? companyId,
    companyName: "Northwind Studio",
    mode,
    label: mode === "test" ? "Sandbox key" : "Live key",
    keyPrefix: mode === "test" ? "kd_test_sandbox_1" : "kd_live_sandbox_2",
    keyLastFour: mode === "test" ? "1111" : "2222",
    lastUsedRefreshed: false,
  };
}

function simulationInputOf(
  paymentId: string,
  scenario: ApiSandboxScenario,
  overrides: Partial<{ mode: "test" | "live"; companyId: string }> = {},
): {
  paymentId: string;
  principal: ReturnType<typeof principalOf>;
  clientAddress: string | null;
  request: { scenario: ApiSandboxScenario };
} {
  return {
    paymentId,
    principal: principalOf(overrides),
    clientAddress: "203.0.113.7",
    request: { scenario },
  };
}

function requestOf(options: { readonly key?: string; readonly body?: string } = {}): Request {
  const headers = new Headers({
    "x-forwarded-for": "203.0.113.7",
    authorization: `Bearer ${options.key ?? testKey}`,
    "content-type": "application/json",
  });

  return new Request(`https://api.example.test${sandboxPathOf(pendingId)}`, {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify({ scenario: "captured" }),
  });
}

// ---------------------------------------------------------------------------------------------
// 1. No migration, and the constraints the simulation must satisfy
// ---------------------------------------------------------------------------------------------

const migrationFiles = (await readdir(new URL("../../migrations", import.meta.url).pathname)).filter((name) =>
  name.endsWith(".sql"),
);
const migrationNumbers = [
  ...new Set(migrationFiles.map((name) => Number.parseInt(name.slice(0, 4), 10)).filter(Number.isFinite)),
].sort((left, right) => left - right);

expectEqual(
  migrationNumbers[migrationNumbers.length - 1] ?? 0,
  128,
  "STEP 206 adds no migration: 0037 already holds every column a simulation writes",
);

const paymentsMigration = await readFile(new URL("../../migrations/0037_payments.sql", import.meta.url), "utf8");

expect(
  paymentsMigration.includes("'partially_refunded', 'refunded', 'under_review')"),
  "under_review, the state a simulated review writes, is in the schema's own status list",
);
expect(
  paymentsMigration.includes("payment_method in ('card', 'bank_transfer', 'e_wallet')"),
  "and the method vocabulary is untouched by a simulation",
);
expect(
  paymentsMigration.includes(
    "status not in ('captured', 'settled', 'partially_refunded', 'refunded')\n    or three_ds_outcome = 'authenticated'",
  ),
  "0037 refuses a capture without an authentication, which is why a simulated capture records one",
);
expect(
  paymentsMigration.includes("(status = 'failed') = (failure_code is not null)"),
  "a failed payment carries a code exactly when it failed, which the decline scenario satisfies",
);
expect(
  paymentsMigration.includes("(status = 'failed') = (failed_at is not null)"),
  "and an instant to match",
);
expect(
  paymentsMigration.includes("risk_decision <> 'reject' or status = 'failed'"),
  "a risk decision is the schema's, and a simulated review only ever writes the waiting one",
);
expect(
  paymentsMigration.includes("new.refunded_minor is distinct from old.refunded_minor"),
  "the refunded total is written by refunds and by nothing else - a simulation cannot move money back",
);
expect(
  paymentsMigration.includes("constraint payments_row_version_check check (version > 0)"),
  "the row carries the version the compare-and-set filters on",
);

const credentialsMigration = await readFile(
  new URL("../../migrations/0034_merchant_api_credentials.sql", import.meta.url),
  "utf8",
);

expect(
  credentialsMigration.includes("constraint merchant_api_credentials_mode_check check (mode in ('test', 'live'))"),
  "0034 keeps the two kinds of credential apart by mode, which is the fence this endpoint sits behind",
);
expect(
  credentialsMigration.includes(
    "'test or live. Section 8 keeps the two sets of credentials apart.'",
  ),
  "and says so in the column comment, naming section 8",
);

// ---------------------------------------------------------------------------------------------
// 2. Test credentials: the key says which mode it is, and the mode decides the surface
// ---------------------------------------------------------------------------------------------

expect(
  CREDENTIAL_KEY_PATTERN.test(testKey),
  "a test key is shaped the way STEP 201 issues them, with the mode inside the key",
);
expect(CREDENTIAL_KEY_PATTERN.test(liveKey), "and so is a live one");
expect(
  testKey.startsWith("kd_test_") && liveKey.startsWith("kd_live_"),
  "the two are distinguishable before a single character of the random tail is read",
);
expect(
  !CREDENTIAL_KEY_PATTERN.test(`kd_staging_sandbox_${"3".repeat(64)}`),
  "and a third mode word is not a key the platform would ever have issued",
);

const liveFence = await refusalOf(async () => {
  assertTestCredential(principalOf({ mode: "live" }));
});

expectEqual(liveFence.code, "PERMISSION_DENIED", "a live credential is refused this surface");
expectEqual(liveFence.status, 403, "with 403 rather than a validation error");
expectEqual(liveFence.field, "authorization", "naming the credential and not a payment field");
expectEqual(liveFence.rule, API_SANDBOX_RULES.liveCredential, "with the rule the handoff names");
expectEqual(API_SANDBOX_RULES.liveCredential, "live_credential_not_simulable", "spelled once and nowhere else");

const testFence = await refusalOf(async () => {
  assertTestCredential(principalOf());
});

expectEqual(testFence.code, "no-refusal", "a test credential passes the fence, which is the caller it was built for");

const fenceFixture = createFixture();
const passThrough = await refusalOf(async () =>
  guardTestCredential(principalOf(), {
    audit: fenceFixture.audit,
    clientAddress: "203.0.113.7",
  }),
);

expectEqual(passThrough.code, "no-refusal", "the guarding fence lets a test credential through");
expectEqual(fenceFixture.audit.entries.length, 0, "and writes nothing, because nothing was refused");

const liveFencedFixture = createFixture();
const fencedRefusal = await refusalOf(async () =>
  guardTestCredential(principalOf({ mode: "live" }), {
    audit: liveFencedFixture.audit,
    clientAddress: "203.0.113.7",
  }),
);

expectEqual(fencedRefusal.code, "PERMISSION_DENIED", "the fence refuses a live credential");
expectEqual(liveFencedFixture.audit.entries.length, 1, "and records the refusal");
expectEqual(
  liveFencedFixture.audit.entries[0]?.action,
  API_SANDBOX_AUDIT.refused,
  "under the refusal action",
);
expectEqual(
  liveFencedFixture.audit.entries[0]?.payload["rule"],
  API_SANDBOX_RULES.liveCredential,
  "naming the rule",
);
expectEqual(liveFencedFixture.audit.entries[0]?.payload["mode"], "live", "and the mode that was refused");
expectEqual(
  liveFencedFixture.audit.entries[0]?.payload["scenario"],
  null,
  "with no scenario, because the body had not been read yet",
);
expectEqual(liveFencedFixture.queries.length, 0, "the fence costs no query at all");

// The live credential through the whole service: refused before the first read.
const liveServiceFixture = createFixture();
const liveServiceRefusal = await refusalOf(async () =>
  simulateTestPayment(
    simulationInputOf(pendingId, "captured", { mode: "live" }),
    dependenciesOf(liveServiceFixture),
  ),
);

expectEqual(liveServiceRefusal.code, "PERMISSION_DENIED", "a live credential cannot simulate through the service");
expectEqual(liveServiceFixture.queries.length, 0, "and the service queries nothing before refusing it");
expectEqual(liveServiceFixture.writes.length, 0, "and writes nothing");
expectEqual(
  liveServiceFixture.state.payments[0]?.["status"],
  "pending",
  "the payment is still where it was",
);
expectEqual(
  liveServiceFixture.audit.entries[0]?.action,
  API_SANDBOX_AUDIT.refused,
  "and the refusal is in the chain",
);

// ---------------------------------------------------------------------------------------------
// 3. The literal mode fence, and the columns a simulation reads
// ---------------------------------------------------------------------------------------------

const capturedFixture = createFixture();
const capturedOutcome = await simulateTestPayment(
  simulationInputOf(pendingId, "captured"),
  dependenciesOf(capturedFixture),
);

expectEqual(capturedOutcome.status, 200, "a captured scenario answers 200");
expectEqual(capturedFixture.queries.length, 2, "two reads: the row with its version, and the read-back");
expectEqual(capturedFixture.writes.length, 1, "and one write between them");
expect(
  capturedFixture.queries[0]?.includes("select=id,status,mode,version") === true,
  "the first reads the status and the version the write will filter on",
);
expect(
  capturedFixture.queries[0]?.includes("mode=eq.test") === true,
  "and narrows on the literal test mode, never on a mode that arrived in a request",
);
expect(
  capturedFixture.queries[0]?.includes("mode=eq.live") !== true,
  "so no live row is reachable here at all",
);
expect(
  capturedFixture.queries[0]?.includes(`company_id=eq.${companyId}`) === true,
  "the tenant is the key's company",
);
expect(
  capturedFixture.queries[0]?.includes("invoice_id=is.null") === true,
  "an invoice payment is not a store payment, so it is out of scope here as it is in STEP 204",
);
expect(capturedFixture.queries[0]?.includes("deleted_at=is.null") === true, "a deleted payment is gone");
expect(capturedFixture.queries[0]?.includes("limit=1") === true, "one id reads at most one row");
expect(
  capturedFixture.queries[0]?.includes("select=*") !== true,
  "and the columns are named rather than starred",
);
expectEqual(
  API_SANDBOX_READ_COLUMNS,
  "id,status,mode,version",
  "the read's column list is the constant, so a query cannot drift from it",
);
expectEqual(
  API_SANDBOX_VERIFY_COLUMNS,
  `${API_PAYMENT_STATUS_COLUMNS},version`,
  "the read-back is STEP 204's ten columns plus the version that proves the write landed",
);

// ---------------------------------------------------------------------------------------------
// 4. A scenario is a scripted answer, and its patch cannot name money
// ---------------------------------------------------------------------------------------------

expectEqual(API_SANDBOX_SCENARIOS.length, 3, "three scenarios, and a fourth is a change to this list");
expectEqual(API_SANDBOX_SCENARIOS[0], "captured", "the successful checkout first");
expectEqual(API_SANDBOX_SCENARIOS[1], "declined", "then the refused one");
expectEqual(API_SANDBOX_SCENARIOS[2], "review", "then the one that waits for a human");
expectEqual(Object.isFrozen(API_SANDBOX_SCENARIOS), true, "the list is frozen");
expectEqual(isSandboxScenario("captured"), true, "a scenario word is recognised");
expectEqual(isSandboxScenario("CAPTURED"), false, "and its upper case form is not");
expectEqual(isSandboxScenario(" captured"), false, "nor a padded one");
expectEqual(isSandboxScenario("refunded"), false, "nor a status the caller might prefer");
expectEqual(isSandboxScenario(7), false, "nor a number, which is not a word at all");
expectEqual(isSandboxScenario(null), false, "nor null");

const capturedPatch = sandboxPatchFor("captured", instantIso);

expectEqual(Object.keys(capturedPatch).sort().join(","), "authorized_at,captured_at,status,three_ds_outcome",
  "a capture writes four columns and no others");
expectEqual(capturedPatch["status"], "captured", "the status the schema names");
expectEqual(capturedPatch["authorized_at"], instantIso, "authorized at the simulation's instant");
expectEqual(capturedPatch["captured_at"], instantIso, "and captured at the same one, not a millisecond later");
expectEqual(capturedPatch["three_ds_outcome"], API_SANDBOX_CAPTURE_THREE_DS, "with the simulated provider's answer");
expectEqual(API_SANDBOX_CAPTURE_THREE_DS, "authenticated", "which is the only one 0037 accepts for a capture");

const declinedPatch = sandboxPatchFor("declined", instantIso);

expectEqual(Object.keys(declinedPatch).sort().join(","), "failed_at,failure_code,failure_detail,status",
  "a decline writes four columns");
expectEqual(declinedPatch["status"], "failed", "which is the schema's word for it, not the scenario's");
expectEqual(declinedPatch["failure_code"], API_SANDBOX_DECLINE_CODE, "with a closed code");
expectEqual(API_SANDBOX_DECLINE_CODE, "card_declined", "the platform's own, recognisable as a simulation");
expectEqual(declinedPatch["failure_detail"], null, "and no free sentence, because section 18 keeps those out");
expectEqual(declinedPatch["failed_at"], instantIso, "the instant the failure happened");

const reviewPatch = sandboxPatchFor("review", instantIso);

expectEqual(Object.keys(reviewPatch).sort().join(","), "risk_decision,status", "a review writes two columns");
expectEqual(reviewPatch["status"], "under_review", "the waiting state");
expectEqual(reviewPatch["risk_decision"], API_SANDBOX_REVIEW_RISK, "with the waiting decision");
expectEqual(API_SANDBOX_REVIEW_RISK, "review", "which is not the rejecting one");

const moneyColumns = [
  "id",
  "company_id",
  "invoice_id",
  "provider_id",
  "provider_key_id",
  "routing_rule_id",
  "idempotency_key_id",
  "mode",
  "payment_method",
  "amount_minor",
  "currency",
  "fee_minor",
  "net_minor",
  "platform_fee_minor",
  "refunded_minor",
  "refunded_at",
  "settled_at",
  "provider_transaction_id",
  "card_brand",
  "card_last_four",
  "postal_code_matched",
  "ip_country_matched",
  "created_at",
  "deleted_at",
];

for (const scenario of API_SANDBOX_SCENARIOS) {
  const patch = sandboxPatchFor(scenario, instantIso);

  for (const column of moneyColumns) {
    expect(
      !(column in patch),
      `${scenario} never writes ${column}: a test payment moves a state, not money`,
    );
  }
}

expectEqual(
  API_SANDBOX_RESULT_STATUSES.captured,
  "captured",
  "each scenario's status is named once",
);
expectEqual(API_SANDBOX_RESULT_STATUSES.declined, "failed", "and the decline's is the schema's failure");
expectEqual(API_SANDBOX_RESULT_STATUSES.review, "under_review", "and the review's is the waiting one");
expectEqual(API_SANDBOX_SIMULABLE_STATUSES.length, 1, "one status may be simulated from");
expectEqual(API_SANDBOX_SIMULABLE_STATUSES[0], "pending", "which is the one STEP 203 creates");

// ---------------------------------------------------------------------------------------------
// 5. The request: one word, bounded, and strict about anything else
// ---------------------------------------------------------------------------------------------

for (const [body, description] of [
  [{ scenario: "captured" }, "the captured word"],
  [{ scenario: "declined" }, "the declined word"],
  [{ scenario: "review" }, "the review word"],
] as readonly [unknown, string][]) {
  const parsed = parseSandboxSimulationRequest(body);

  expectEqual(parsed.scenario, (body as { scenario: ApiSandboxScenario }).scenario, description + " is accepted");
}

for (const [body, rule, field, description] of [
  [{}, API_SANDBOX_RULES.scenarioMissing, API_SANDBOX_SCENARIO_FIELD, "an empty body"],
  [{ status: "captured" }, API_SANDBOX_RULES.scenarioMissing, API_SANDBOX_SCENARIO_FIELD, "a body naming a status"],
  [[{ scenario: "captured" }], API_SANDBOX_RULES.scenarioMissing, API_SANDBOX_SCENARIO_FIELD, "an array"],
  [null, API_SANDBOX_RULES.scenarioMissing, API_SANDBOX_SCENARIO_FIELD, "null"],
  ["captured", API_SANDBOX_RULES.scenarioMissing, API_SANDBOX_SCENARIO_FIELD, "a bare string"],
  [{ scenario: "refunded" }, API_SANDBOX_RULES.scenarioUnsupported, API_SANDBOX_SCENARIO_FIELD, "a status word"],
  [{ scenario: "CAPTURED" }, API_SANDBOX_RULES.scenarioUnsupported, API_SANDBOX_SCENARIO_FIELD, "an upper case word"],
  [{ scenario: "captured " }, API_SANDBOX_RULES.scenarioUnsupported, API_SANDBOX_SCENARIO_FIELD, "a padded word"],
  [{ scenario: "" }, API_SANDBOX_RULES.scenarioUnsupported, API_SANDBOX_SCENARIO_FIELD, "an empty word"],
  [{ scenario: 7 }, API_SANDBOX_RULES.scenarioUnsupported, API_SANDBOX_SCENARIO_FIELD, "a number"],
] as readonly [unknown, string, string, string][]) {
  const refusal = await refusalOf(async () => parseSandboxSimulationRequest(body));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.status, 422, `${description}: as a validation failure`);
  expectEqual(refusal.field, field, `${description}: naming the scenario field`);
  expectEqual(refusal.rule, rule, `${description}: with its own rule`);
}

const unknownFieldRefusal = await refusalOf(async () =>
  parseSandboxSimulationRequest({ scenario: "captured", amount_minor: 1 }),
);

expectEqual(unknownFieldRefusal.code, "VALIDATION_FAILED", "an extra field is refused rather than ignored");
expectEqual(unknownFieldRefusal.field, "amount_minor", "and named");
expectEqual(unknownFieldRefusal.rule, API_SANDBOX_RULES.unknownField, "as an unknown field");
expectEqual(API_SANDBOX_RULES.unknownField, "unknown_field", "spelled once");

const malformedBodyRefusal = await refusalOf(async () =>
  readSandboxBody(
    new Request(`https://api.example.test${sandboxPathOf(pendingId)}`, {
      method: "POST",
      body: "{not json",
    }),
  ),
);

expectEqual(malformedBodyRefusal.code, "VALIDATION_FAILED", "a body that is not JSON is refused");
expectEqual(malformedBodyRefusal.field, "body", "naming the body");
expectEqual(malformedBodyRefusal.rule, API_SANDBOX_RULES.bodyMalformed, "as malformed");

const declaredTooLarge = await refusalOf(async () =>
  readSandboxBody(
    new Request(`https://api.example.test${sandboxPathOf(pendingId)}`, {
      method: "POST",
      headers: { "content-length": String(API_SANDBOX_BODY_MAXIMUM_BYTES + 1) },
      body: "{}",
    }),
  ),
);

expectEqual(declaredTooLarge.code, "PAYLOAD_TOO_LARGE", "a declared length past the ceiling is refused");
expectEqual(declaredTooLarge.status, 413, "with 413");
expectEqual(declaredTooLarge.rule, API_SANDBOX_RULES.bodyTooLarge, "as too large");

const oversizedBody = `{"scenario":"${"c".repeat(API_SANDBOX_BODY_MAXIMUM_BYTES)}"}`;
const actualTooLarge = await refusalOf(async () =>
  readSandboxBody(
    new Request(`https://api.example.test${sandboxPathOf(pendingId)}`, {
      method: "POST",
      body: oversizedBody,
    }),
  ),
);

expectEqual(actualTooLarge.code, "PAYLOAD_TOO_LARGE", "a body with no declared length is counted as it is read");
expectEqual(actualTooLarge.rule, API_SANDBOX_RULES.bodyTooLarge, "and refused by the same rule");
expectEqual(
  await readSandboxBody(
    new Request(`https://api.example.test${sandboxPathOf(pendingId)}`, {
      method: "POST",
      body: JSON.stringify({ scenario: "review" }),
    }),
  ).then((body) => (body as { scenario: string }).scenario),
  "review",
  "a body inside the ceiling is read",
);

// ---------------------------------------------------------------------------------------------
// 6. The write, and the answer
// ---------------------------------------------------------------------------------------------

expectEqual(capturedFixture.writes.length, 1, "one write per simulation");
expectEqual(capturedFixture.writes[0]?.table, API_SANDBOX_PAYMENT_TABLE, "to the payment row and no other table");
expect(
  capturedFixture.writes[0]?.query.includes("version=eq.1") === true,
  "filtered on the version that was read, which is the compare-and-set",
);
expect(
  capturedFixture.writes[0]?.query.includes("mode=eq.test") === true,
  "and on the literal test mode again, so the write cannot land on a live row",
);
expectEqual(
  Object.keys(capturedFixture.writes[0]?.values ?? {}).sort().join(","),
  "authorized_at,captured_at,status,three_ds_outcome",
  "carrying exactly the scenario's columns",
);
expectEqual(capturedOutcome.body.status, "captured", "the answer shows the state the simulation wrote");
expectEqual(capturedOutcome.body.mode, "test", "in test mode, which the caller can see");
expectEqual(capturedOutcome.previousStatus, "pending", "and names the state it moved from");
expectEqual(capturedOutcome.scenario, "captured", "and the scenario it was asked for");
expectEqual(capturedFixture.state.payments[0]?.["status"], "captured", "the row itself moved");
expectEqual(capturedFixture.state.payments[0]?.["three_ds_outcome"], "authenticated", "with the simulated answer");
expectEqual(capturedFixture.state.payments[0]?.["amount_minor"], 12_50, "and the amount is untouched");
expectEqual(capturedFixture.state.payments[0]?.["provider_transaction_id"], null, "no provider transaction invented");
expectEqual(capturedFixture.state.payments[0]?.["postal_code_matched"], false, "and no evidence invented either");
expectEqual(capturedFixture.state.payments[0]?.["version"], 2, "the row's version advanced by one");

const viewKeys = Object.keys(capturedOutcome.body);

expectEqual(viewKeys[0], "id", "the answer starts with the payment's id");
expectEqual(viewKeys[1], "object", "then its object name");
expectEqual(viewKeys.length, 11, "eleven keys: the object name and STEP 204's ten fields");
expectEqual(
  viewKeys.filter((key) => key !== "object").join(","),
  paymentViewFieldNames().join(","),
  "which are STEP 204's ten field names, in its order",
);
expectEqual(
  paymentViewFieldNames().join(","),
  API_PAYMENT_STATUS_COLUMNS,
  "and those names are the column list STEP 204 selects",
);
expectEqual(capturedOutcome.body.object, "payment", "the object name is the platform's");

// ---------------------------------------------------------------------------------------------
// 7. The other two scenarios, through the same service
// ---------------------------------------------------------------------------------------------

const declinedFixture = createFixture();
const declinedOutcome = await simulateTestPayment(
  simulationInputOf(pendingId, "declined"),
  dependenciesOf(declinedFixture),
);

expectEqual(declinedOutcome.body.status, "failed", "a decline ends failed");
expectEqual(declinedOutcome.body.failure_code, API_SANDBOX_DECLINE_CODE, "with the platform's closed code");
expectEqual(declinedFixture.state.payments[0]?.["failure_detail"], null, "and no free sentence");
expectEqual(
  declinedFixture.state.payments[0]?.["failed_at"],
  instantIso,
  "the instant the failure was recorded",
);
expectEqual(
  declinedFixture.state.payments[1]?.["status"],
  "captured",
  "and the fixture's other payment is untouched",
);

const reviewFixture = createFixture();
const reviewOutcome = await simulateTestPayment(
  simulationInputOf(pendingId, "review"),
  dependenciesOf(reviewFixture),
);

expectEqual(reviewOutcome.body.status, "under_review", "a review leaves the payment waiting for a human");
expectEqual(reviewFixture.state.payments[0]?.["risk_decision"], "review", "with the waiting risk decision");
expectEqual(reviewFixture.state.payments[0]?.["version"], 2, "and one version");
expectEqual(reviewFixture.writes.length, 1, "one write, as ever");

// The comparison the schema itself makes: a capture patch and a review patch are disjoint.
const scenariosSeen = new Set<string>();

for (const scenario of API_SANDBOX_SCENARIOS) {
  scenariosSeen.add(sandboxPatchFor(scenario, instantIso)["status"] as string);
}

expectEqual(scenariosSeen.size, 3, "the three scenarios end in three different states");

// ---------------------------------------------------------------------------------------------
// 8. The refusals, and what a store can learn from them
// ---------------------------------------------------------------------------------------------

for (const [value, description] of [
  ["", "an empty segment"],
  ["abc", "three letters"],
  [pendingId.toUpperCase(), "an upper case id"],
  [pendingId.slice(0, 35), "an id one character short"],
  [`${pendingId}a`, "an id one character long"],
  ["%00", "a percent escape"],
  ["a".repeat(API_PAYMENT_ID_MAXIMUM_LENGTH + 1), "a value past the ceiling"],
] as readonly [string, string][]) {
  const fixture = createFixture();
  const refusal = await refusalOf(async () =>
    simulateTestPayment(
      simulationInputOf(value, "captured"),
      dependenciesOf(fixture),
    ),
  );

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.field, API_PAYMENT_STATUS_FIELD, `${description}: naming the id field STEP 204 names`);
  expectEqual(refusal.rule, API_PAYMENT_STATUS_RULES.malformed, `${description}: with STEP 204's rule`);
  expectEqual(fixture.queries.length, 0, `${description}: and no query at all`);
  expectEqual(fixture.writes.length, 0, `${description}: and no write`);
  expectEqual(fixture.audit.entries.length, 1, `${description}: one refusal entry`);
  expectEqual(fixture.audit.entries[0]?.entityId, null, `${description}: with no entity id for a non-id`);
}

for (const [id, description] of [
  [uuidOf(404), "an id that does not exist"],
  [foreignCompanyPaymentId, "another merchant's payment"],
  [livePendingId, "a live-mode payment reached with a test key"],
  [invoicePaymentId, "an invoice payment"],
  [deletedPaymentId, "a deleted payment"],
] as readonly [string, string][]) {
  const fixture = createFixture();
  const refusal = await refusalOf(async () =>
    simulateTestPayment(simulationInputOf(id, "captured"), dependenciesOf(fixture)),
  );

  expectEqual(refusal.code, "RESOURCE_NOT_FOUND", `${description} answers not found`);
  expectEqual(refusal.status, 404, `${description}: with 404`);
  expectEqual(refusal.field, "id", `${description}: naming the id`);
  expectEqual(refusal.rule, API_PAYMENT_STATUS_RULES.notFound, `${description}: with the one rule for five states`);
  expectEqual(fixture.writes.length, 0, `${description}: and nothing written`);
  expectEqual(fixture.audit.entries.length, 1, `${description}: one refusal entry`);
  expectEqual(fixture.audit.entries[0]?.entityId, id, `${description}: naming the id that was asked for`);
}

const decidedFixture = createFixture();
const decidedRefusal = await refusalOf(async () =>
  simulateTestPayment(simulationInputOf(capturedId, "declined"), dependenciesOf(decidedFixture)),
);

expectEqual(decidedRefusal.code, "CONFLICT", "a payment that already has an outcome is a conflict");
expectEqual(decidedRefusal.status, 409, "with 409");
expectEqual(decidedRefusal.field, "payment.status", "naming the status rather than the id");
expectEqual(decidedRefusal.rule, API_SANDBOX_RULES.paymentAlreadyDecided, "with its own rule");
expectEqual(decidedFixture.writes.length, 0, "and nothing written");
expectEqual(decidedFixture.state.payments[1]?.["status"], "captured", "the decided payment is unchanged");
expectEqual(
  decidedFixture.audit.entries[0]?.payload["scenario"],
  "declined",
  "the refusal records the scenario that was asked for",
);

const raceFixture = createFixture();

raceFixture.loseRace = "untouched";

const raceRefusal = await refusalOf(async () =>
  simulateTestPayment(simulationInputOf(pendingId, "captured"), dependenciesOf(raceFixture)),
);

expectEqual(raceRefusal.code, "CONFLICT", "a write that lost the compare-and-set is a conflict");
expectEqual(raceRefusal.status, 409, "with 409 rather than a success");
expectEqual(raceRefusal.field, "payment", "naming the payment");
expectEqual(raceRefusal.rule, API_SANDBOX_RULES.simulationRace, "with the race's own rule");
expectEqual(
  raceFixture.audit.entries.at(-1)?.payload["rule"],
  API_SANDBOX_RULES.simulationRace,
  "and the chain says a race rather than a decision",
);
expectEqual(raceFixture.state.payments[0]?.["status"], "pending", "the row never reached the scenario's state");

const vanishedFixture = createFixture();

vanishedFixture.loseRace = "vanished";

const vanishedRefusal = await refusalOf(async () =>
  simulateTestPayment(simulationInputOf(pendingId, "review"), dependenciesOf(vanishedFixture)),
);

expectEqual(vanishedRefusal.code, "CONFLICT", "a row that vanished between the reads is the same conflict");
expectEqual(vanishedRefusal.rule, API_SANDBOX_RULES.simulationRace, "by the same rule");

// ---------------------------------------------------------------------------------------------
// 9. The chain: what a simulation records, and what it never does
// ---------------------------------------------------------------------------------------------

const successEntry = capturedFixture.audit.entries[0];

expectEqual(capturedFixture.audit.entries.length, 1, "one chain entry for one successful simulation");
expectEqual(successEntry?.action, API_SANDBOX_AUDIT.simulated, "under its own action");
expectEqual(API_SANDBOX_AUDIT.simulated, "api.sandbox_payment_simulated", "spelled once");
expect(
  /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(API_SANDBOX_AUDIT.simulated),
  "and fitting the chain's dotted action pattern",
);
expect(
  /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(API_SANDBOX_AUDIT.refused),
  "as does the refusal action",
);
expectEqual(successEntry?.entityType, API_SANDBOX_ENTITY, "naming a payment");
expectEqual(successEntry?.entityId, pendingId, "and which one");
expectEqual(successEntry?.actorUserId, null, "with no human actor, because a key made the call");
expectEqual(successEntry?.sessionId, null, "and no session");
expectEqual(successEntry?.companyId, companyId, "on the merchant's own chain");
expectEqual(successEntry?.ipAddress, "203.0.113.7", "with the address the call came from");
expectEqual(successEntry?.userAgent, null, "and no user agent it did not need");
expectEqual(successEntry?.payload["scenario"], "captured", "the scenario");
expectEqual(successEntry?.payload["from_status"], "pending", "the state it moved from");
expectEqual(successEntry?.payload["to_status"], "captured", "and the one it moved to");
expectEqual(successEntry?.payload["mode"], "test", "in test mode");
expectEqual(successEntry?.payload["credential_id"], credentialId, "naming the credential that asked");
expect(
  !JSON.stringify(successEntry).includes(testKey),
  "and never the key that was presented",
);
expect(!JSON.stringify(successEntry).includes("amount"), "nor the amount, because no money moved");
expect(!JSON.stringify(successEntry).includes("card"), "nor a card field, which does not exist here");

const deafFixture = createFixture();

deafFixture.failAudit = true;

const deafOutcome = await refusalOf(async () =>
  simulateTestPayment(simulationInputOf(pendingId, "captured"), dependenciesOf(deafFixture)),
);

expectEqual(deafOutcome.code, "no-refusal", "a chain that cannot be written does not fail a simulation");
expectEqual(deafFixture.state.payments[0]?.["status"], "captured", "the state moved anyway");

const deafLiveFixture = createFixture();

deafLiveFixture.failAudit = true;

const deafLiveRefusal = await refusalOf(async () =>
  guardTestCredential(principalOf({ mode: "live" }), {
    audit: (dependenciesOf(deafLiveFixture) as { audit: AuditTrail }).audit,
    clientAddress: "203.0.113.7",
  }),
);

expectEqual(deafLiveRefusal.code, "PERMISSION_DENIED", "and a deaf chain does not let a live credential through");

const refusalEntry = liveServiceFixture.audit.entries[0] as AuditEntry | undefined;

expectEqual(refusalEntry?.action, API_SANDBOX_AUDIT.refused, "a refusal is recorded under its own action");
expectEqual(refusalEntry?.companyId, companyId, "on the merchant's chain");
expectEqual(refusalEntry?.payload["mode"], "live", "with the mode that was refused");

// ---------------------------------------------------------------------------------------------
// 10. Through the pipeline the surface really has
// ---------------------------------------------------------------------------------------------

const pipelineFixture = createFixture();
const pipelineBodyReads: string[] = [];

const pipelineAnswer = await handlePublicApiCall(
  {
    request: requestOf(),
    route: API_SANDBOX_ROUTE,
    handler: async (call) => {
      await guardTestCredential(call.principal, {
        audit: pipelineFixture.audit,
        clientAddress: "203.0.113.7",
      });

      const body = await readSandboxBody(call.request);

      pipelineBodyReads.push("read");

      const outcome = await simulateTestPayment(
        {
          paymentId: pendingId,
          principal: call.principal,
          clientAddress: "203.0.113.7",
          request: parseSandboxSimulationRequest(body),
        },
        dependenciesOf(pipelineFixture),
      );

      return { status: outcome.status, body: outcome.body };
    },
  },
  dependenciesOf(pipelineFixture),
);

expectEqual(pipelineAnswer.status, 200, "through the pipeline a simulation answers 200");
expectEqual(
  pipelineAnswer.headers[PUBLIC_API_VERSION_HEADER],
  PUBLIC_API_VERSION,
  "with the version the surface publishes",
);
expectEqual(pipelineAnswer.headers["cache-control"], "no-store", "and no cache between merchants");
expectEqual(
  "idempotency-replayed" in pipelineAnswer.headers,
  false,
  "and no replay header, because a simulation is not a charge",
);
expectEqual(pipelineBodyReads.length, 1, "the body was read once");
expectEqual(pipelineFixture.counters.length, 3, "the limiter counted the route, the account and the address");
expectEqual(
  pipelineFixture.audit.entries.filter((entry) => entry.action === "api.call").length,
  1,
  "one call entry, as every public API call writes",
);

const callEntry = pipelineFixture.audit.entries.find((entry) => entry.action === "api.call");

expectEqual(callEntry?.payload["route"], API_SANDBOX_ROUTE, "recorded under the template, not the arriving path");
expectEqual(callEntry?.payload["status"], 200, "with the status it answered");

const livePipelineFixture = createFixture();
let liveBodyRead = false;

const livePipelineRefusal = await refusalOf(async () =>
  handlePublicApiCall(
    {
      request: requestOf({ key: liveKey }),
      route: API_SANDBOX_ROUTE,
      handler: async (call) => {
        await guardTestCredential(call.principal, {
          audit: livePipelineFixture.audit,
          clientAddress: "203.0.113.7",
        });

        liveBodyRead = true;

        return { status: 200, body: {} };
      },
    },
    dependenciesOf(livePipelineFixture),
  ),
);

expectEqual(livePipelineRefusal.code, "PERMISSION_DENIED", "a live key through the pipeline is refused the surface");
expectEqual(livePipelineRefusal.status, 403, "with 403");
expectEqual(liveBodyRead, false, "before a byte of the body is read");
expectEqual(
  livePipelineFixture.queries.filter((query) => query.startsWith(`${API_SANDBOX_PAYMENT_TABLE}:`)).length,
  0,
  "and before a single payment query, so the sandbox never inspects what a live key could reach",
);
expectEqual(
  livePipelineFixture.audit.entries.filter((entry) => entry.action === "api.call").length,
  1,
  "while the call itself is still recorded",
);
expectEqual(
  livePipelineFixture.audit.entries.find((entry) => entry.action === "api.call")?.payload["status"],
  403,
  "with the 403 it answered",
);

const throttledFixture = createFixture();

throttledFixture.refuseCounter = true;

const throttledRefusal = await refusalOf(async () =>
  simulateTestPayment(simulationInputOf(pendingId, "captured"), dependenciesOf(throttledFixture)),
);

expectEqual(throttledRefusal.code, "no-refusal", "the service itself is not rate limited: the pipeline is");

const throttledPipelineRefusal = await refusalOf(async () =>
  handlePublicApiCall(
    {
      request: requestOf(),
      route: API_SANDBOX_ROUTE,
      handler: async () => ({ status: 200, body: {} }),
    },
    dependenciesOf(throttledFixture),
  ),
);

expectEqual(throttledPipelineRefusal.code, "RATE_LIMITED", "and a full bucket refuses before the handler runs");

// ---------------------------------------------------------------------------------------------
// 11. The sources, and the vocabulary a client reads
// ---------------------------------------------------------------------------------------------

const routeSource = await readFile(
  new URL("../../app/api/public/v1/payments/[id]/simulate/route.ts", import.meta.url),
  "utf8",
);
const serviceSource = await readFile(new URL("./sandbox-payment.ts", import.meta.url), "utf8");
const fieldsSource = await readFile(new URL("./sandbox-fields.ts", import.meta.url), "utf8");

expect(routeSource.includes("export const POST"), "the route exports POST");
expect(!routeSource.includes("export const GET"), "and no GET, because this path is an action");
expect(!routeSource.includes("export const PUT"), "and no PUT");
expect(!routeSource.includes("export const PATCH"), "and no PATCH");
expect(!routeSource.includes("export const DELETE"), "and no DELETE");
expect(routeSource.includes("force-dynamic"), "the route is dynamic, because a payment status is never stale");
expect(routeSource.includes("await context.params"), "it awaits the params, as the framework requires");
expect(routeSource.includes("handlePublicApiCall"), "and it goes through the pipeline that authenticates and counts");
expect(routeSource.includes("route,"), "passing the template constant rather than the arriving path");
expect(
  routeSource.includes("await guardTestCredential(call.principal"),
  "fencing the credential inside the handler, with the principal the pipeline proved",
);
expect(
  routeSource.indexOf("await guardTestCredential(call.principal") <
    routeSource.indexOf("await readSandboxBody("),
  "before the body is read, which is the point of the fence",
);
expect(!routeSource.includes("cookie"), "and reading no cookie, because a key is not a session");
expect(!routeSource.includes("csrf"), "and no CSRF token");
expect(
  !routeSource.includes("readIdempotencyKey"),
  "and reading no idempotency key, which this surface does not need",
);
expect(!routeSource.includes("console."), "printing nothing");

expect(!serviceSource.includes("console."), "the service prints nothing");
expect(
  (serviceSource.match(/\.update\(/gu) ?? []).length === 1,
  "the service writes exactly one table, once: a test payment posts nothing to the ledger",
);
expect(!serviceSource.includes(".insert("), "and inserts nothing at all");
expect(
  (serviceSource.match(/\.select\(/gu) ?? []).length === 2,
  "two reads and one write is the whole of what a simulation does",
);
expect(
  serviceSource.includes("mode=eq.test"),
  "the literal mode fence is in the service source, not only in a filter it builds",
);
expect(
  serviceSource.indexOf("await guardTestCredential(input.principal") <
    serviceSource.indexOf("dependencies.rest.select("),
  "the credential is fenced before the service's first query",
);
expect(!fieldsSource.includes("console."), "the vocabulary prints nothing too");
expect(API_SANDBOX_ROUTE.endsWith(`/{id}/${API_SANDBOX_PATH_SEGMENT}`), "the route is a template with the id unbound");
expectEqual(API_SANDBOX_ROUTE, `${PUBLIC_API_BASE}/payments/{id}/simulate`, "built from the API base STEP 203 uses");
expectEqual(API_SANDBOX_PATH_SEGMENT, "simulate", "the action's own segment");
expectEqual(API_PAYMENTS_PATH, `${PUBLIC_API_BASE}/payments`, "and STEP 203's path is the prefix");
expectEqual(sandboxPathOf(pendingId), `${API_PAYMENTS_PATH}/${pendingId}/simulate`, "a payment's own path encodes its id");
expect(
  sandboxPathOf(pendingId) !== paymentStatusPathOf(pendingId),
  "and is not the status path, which is a different endpoint",
);
expectEqual(API_SANDBOX_ENTITY, "payment", "the chain names a payment");

for (const rule of Object.values(API_SANDBOX_RULES)) {
  expect(/^[a-z][a-z0-9_]*$/u.test(rule), `${rule} is a machine word`);
}

expectEqual(Object.isFrozen(API_SANDBOX_RULES), true, "the rule list is frozen");
expectEqual(
  API_SANDBOX_RULES.paymentAlreadyDecided,
  "payment_already_decided",
  "the decided-payment rule is spelled once",
);
expectEqual(API_SANDBOX_RULES.simulationRace, "simulation_race", "and so is the race's");
expectEqual(API_SANDBOX_BODY_MAXIMUM_BYTES, 1_024, "the body ceiling is a kilobyte, for a one-word body");

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`sandbox simulation gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `sandbox simulation gate passed: ${String(checkCount)} checks, a test-only endpoint that turns one pending ` +
      "test payment into one of three scripted outcomes, a patch table that cannot name money, a compare-and-set " +
      "write that survives a lost race, five kinds of \"not yours\" answered as one 404, and a chain that names " +
      "what moved and never the key\n",
  );
}
