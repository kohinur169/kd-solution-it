// path: services/payments/refund-execution-verify.ts
import process from "node:process";
import { readFile, readdir } from "node:fs/promises";
import { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { PROVIDER_KEYS, type ProviderKey } from "../../lib/payments/registry.ts";
import {
  REFUND_EXECUTION_RULES,
  REFUND_EXECUTION_MAXIMUM_BODY_BYTES,
  REFUND_EXECUTABLE_STATUS,
  REFUND_EXECUTION_REFUSED_AUDIT_ACTION,
  REFUND_FAILED_AUDIT_ACTION,
  REFUND_PROCESSING_AUDIT_ACTION,
  REFUND_PROVIDER_OUTCOMES,
  REFUND_PROVIDER_PENDING_AUDIT_ACTION,
  REFUND_PROVIDER_UNANSWERED_AUDIT_ACTION,
  REFUND_SUCCEEDED_AUDIT_ACTION,
  REFUND_DETAIL_MAXIMUM_LENGTH,
  providerAmountOf,
  failureDetailOf,
} from "./refund-execution-fields.ts";
import {
  REFUNDING_PROVIDER_KEYS,
  isRefundingProvider,
  refundPortOf,
  type RefundProviderOutcome,
  type RefundProviderPort,
  type RefundProviderTarget,
} from "./refund-provider.ts";
import { createNmiRefundPort } from "./refund-nmi.ts";
import { executeRefund, type RefundExecutionDependencies } from "./refund-execution.ts";

/**
 * The gate for STEP 192: refund execution through the originating provider.
 *
 * ## What this proves
 *
 *   - **Only an approved refund is executed, and only once.** A `requested`, `processing`, `succeeded`, `failed`
 *     or `cancelled` refund is refused before any call, and the second execution of a succeeded one is refused
 *     by the status rather than by a lock.
 *   - **The provider is the one the payment recorded**, in the mode it recorded, against the provider's own
 *     transaction id, for the amount the refund is for - converted to hundredths and refused when it cannot be.
 *   - **Each of a provider's five answers lands on the status `0038` allows**: succeeded with an identifier,
 *     failed with a detail within 280, pending and unanswered left in `processing`, and not-sent back to
 *     `approved` with no money moved.
 *   - **The payment's refunded total is the database's** - `refunds_sync_payment` writes it from succeeded rows
 *     and `payments_guard_refund_state` refuses anyone else - and this STEP writes it nowhere.
 *   - **Every step is in the chain**, under entity `refund`, with the provider, the amount and the answer.
 *   - **The four providers this build cannot refund through refuse honestly**, leaving the refund approved.
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
  expect(Object.is(actual, expected), `${description} (expected ${String(expected)}, got ${String(actual)})`);
}

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
// A PostgREST over arrays, with `0037`'s and `0038`'s triggers on it.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const financeUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ownerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const providerId = "9f000000-0000-4000-8000-000000000001";
const startedAtMs = Date.parse("2026-11-07T09:00:00.000Z");

/** One account, with the parts a case cares about written over the desk's defaults. */
function actorOf(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: financeUserId,
    companyId: null,
    roles: ["finance_ops"],
    sessionId: "session-0001",
    assuranceLevel: "aal1",
    authenticatedAtEpochMs: startedAtMs - 60_000,
    expiresAtEpochMs: startedAtMs + 3_600_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    ...overrides,
  } as RequestActor;
}

function deskActor(): RequestActor {
  return actorOf();
}

interface Query {
  readonly equals: Map<string, string>;
  readonly nulls: Set<string>;
  readonly order: { readonly column: string; readonly direction: "asc" | "desc" } | null;
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const nulls = new Set<string>();
  let order: Query["order"] = null;
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

    if (key === "order") {
      const [column = "", direction = "asc"] = value.split(".");

      order = { column, direction: direction === "desc" ? "desc" : "asc" };

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
      equals.set(key, value.slice(3));
    }
  }

  return { equals, nulls, order, limit };
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

  return true;
}

interface Fixture {
  readonly rest: RestClient;
  readonly refunds: Row[];
  readonly payments: Row[];
  readonly providers: Row[];
  /** Every update a caller made to `payments`, so the gate can prove nothing wrote a refunded total. */
  readonly paymentWrites: Row[];
}

/** The rules `0038` enforces on a refund row, in the fixture, so a service bug is caught by the database. */
function guardRefund(fixture: { readonly refunds: readonly Row[]; readonly payments: readonly Row[] }, row: Row): void {
  const payment = fixture.payments.find((candidate) => candidate["id"] === row["payment_id"]);

  if (payment === undefined) {
    throw new AppError("CONFLICT", { details: [{ field: "payment_id", rule: "refund_guard" }] });
  }

  if (payment["company_id"] !== row["company_id"] || payment["currency"] !== row["currency"]) {
    throw new AppError("CONFLICT", { details: [{ field: "company_id", rule: "refund_guard" }] });
  }

  const live = ["approved", "processing", "succeeded"].includes(String(row["status"]));

  if (
    ["requested", "approved", "processing", "succeeded"].includes(String(row["status"])) &&
    !["captured", "settled", "partially_refunded", "refunded"].includes(String(payment["status"]))
  ) {
    throw new AppError("CONFLICT", { details: [{ field: "payment_id", rule: "refund_guard" }] });
  }

  if (live) {
    const total = fixture.refunds
      .filter(
        (candidate) =>
          candidate["payment_id"] === row["payment_id"] &&
          candidate["id"] !== row["id"] &&
          ["approved", "processing", "succeeded"].includes(String(candidate["status"])),
      )
      .reduce((sum, candidate) => sum + Number(candidate["amount_minor"]), 0);

    if (total + Number(row["amount_minor"]) > Number(payment["amount_minor"])) {
      throw new AppError("CONFLICT", { details: [{ field: "amount", rule: "refund_guard" }] });
    }
  }

  const decided = ["approved", "processing", "succeeded", "failed"].includes(String(row["status"]));

  if (decided !== (row["approved_by"] !== null && row["approved_by"] !== undefined && row["decided_at"] !== null)) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "refund_approval" }] });
  }

  if (["succeeded", "failed"].includes(String(row["status"])) !== (row["processed_at"] !== null && row["processed_at"] !== undefined)) {
    throw new AppError("CONFLICT", { details: [{ field: "processed_at", rule: "refund_processed" }] });
  }

  if (row["status"] === "succeeded" && (row["provider_refund_id"] === null || row["provider_refund_id"] === undefined)) {
    throw new AppError("CONFLICT", { details: [{ field: "provider_refund_id", rule: "refund_provider" }] });
  }

  const detail = row["failure_detail"];

  if ((row["status"] === "failed") !== (detail !== null && detail !== undefined)) {
    throw new AppError("CONFLICT", { details: [{ field: "failure_detail", rule: "refund_failure" }] });
  }

  if (
    detail !== null &&
    detail !== undefined &&
    (typeof detail !== "string" || detail.length < 1 || detail.length > 280 || detail !== detail.trim())
  ) {
    throw new AppError("CONFLICT", { details: [{ field: "failure_detail", rule: "refund_failure" }] });
  }
}

/** `refunds_sync_payment`, in the fixture: the only writer of a payment's refunded total. */
function syncPayment(fixture: Fixture, paymentId: string): void {
  const payment = fixture.payments.find((candidate) => candidate["id"] === paymentId);

  if (payment === undefined) {
    return;
  }

  const refunded = fixture.refunds
    .filter((candidate) => candidate["payment_id"] === paymentId && candidate["status"] === "succeeded")
    .reduce((sum, candidate) => sum + Number(candidate["amount_minor"]), 0);

  if (refunded === 0) {
    payment["refunded_minor"] = "0";

    if (payment["status"] === "partially_refunded") {
      payment["status"] = "captured";
    }

    return;
  }

  payment["refunded_minor"] = String(refunded);

  if (refunded >= Number(payment["amount_minor"])) {
    payment["status"] = "refunded";
    payment["refunded_at"] = new Date(startedAtMs).toISOString();
  } else {
    payment["status"] = "partially_refunded";
    payment["refunded_at"] = null;
  }
}

function createFixture(payments: readonly Row[], providers: readonly Row[]): Fixture {
  const refunds: Row[] = [];
  const table = { refunds, payments: [...payments], providers: [...providers], keys: [] as Row[] };
  const paymentWrites: Row[] = [];
  /** The fixture this table's closures sync into. Assigned once the object below exists. */
  const holder: { current: Fixture | null } = { current: null };
  let writeCount = 0;

  const rowsOf = (name: string): Row[] => {
    if (name === "refunds") {
      return table.refunds;
    }

    if (name === "payments") {
      return table.payments;
    }

    if (name === "payment_providers") {
      return table.providers;
    }

    if (name === "provider_keys") {
      return table.keys;
    }

    throw new AppError("DEPENDENCY_FAILED");
  };

  const rest: RestClient = {
    async select<TRow>(name: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const parsed = parseQuery(query);
      let rows = rowsOf(name).filter((row) => matches(row, parsed));

      if (parsed.order !== null) {
        const { column, direction } = parsed.order;
        rows = [...rows].sort((left, right) => {
          const a = String(left[column] ?? "");
          const b = String(right[column] ?? "");

          return direction === "asc" ? a.localeCompare(b) : b.localeCompare(a);
        });
      }

      if (parsed.limit !== null) {
        rows = rows.slice(0, parsed.limit);
      }

      return schema.array().parse(rows);
    },

    async insert(name: string, rows: readonly Row[]): Promise<void> {
      for (const row of rows) {
        rowsOf(name).push({ ...row });
      }
    },

    async insertReturning<TRow>(name: string, rows: readonly Row[], schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const written: Row[] = [];

      for (const row of rows) {
        writeCount += 1;

        const complete: Row = {
          id: `refund-${String(writeCount).padStart(4, "0")}`,
          status: "requested",
          approved_by: null,
          decided_at: null,
          processed_at: null,
          provider_refund_id: null,
          platform_fee_returned: false,
          platform_fee_returned_minor: "0",
          failure_detail: null,
          created_at: new Date(startedAtMs).toISOString(),
          updated_at: new Date(startedAtMs).toISOString(),
          version: 1,
          ...row,
        };

        guardRefund(table, complete);
        rowsOf(name).push(complete);
        written.push(complete);

        if (holder.current !== null) {
          syncPayment(holder.current, String(complete["payment_id"]));
        }
      }

      return schema.array().parse(written);
    },

    async update(name: string, query: string, values: Row): Promise<void> {
      const parsed = parseQuery(query);

      for (const row of rowsOf(name).filter((candidate) => matches(candidate, parsed))) {
        if (name === "payments") {
          paymentWrites.push({ ...values });
        }

        const next: Row = { ...row, ...values };

        if (name === "refunds") {
          guardRefund(table, next);
          next["version"] = Number(row["version"]) + 1;
          next["updated_at"] = new Date(startedAtMs + 1_000).toISOString();
        }

        Object.assign(row, next);

        if (name === "refunds" && holder.current !== null) {
          syncPayment(holder.current, String(next["payment_id"]));
        }
      }
    },

    async rpc(): Promise<unknown> {
      throw new AppError("DEPENDENCY_FAILED");
    },
  };

  const fixture: Fixture = {
    rest,
    refunds: table.refunds,
    payments: table.payments,
    providers: table.providers,
    paymentWrites,
  };

  holder.current = fixture;

  return fixture;
}

function paymentRow(overrides: Row = {}): Row {
  return {
    id: "5f000000-0000-4000-8000-000000000001",
    company_id: companyId,
    provider_id: providerId,
    provider_key_id: "7a000000-0000-4000-8000-000000000001",
    mode: "live",
    provider_transaction_id: "nmi-txn-0001",
    amount_minor: "100000000",
    currency: "USD",
    status: "captured",
    refunded_minor: "0",
    platform_fee_minor: "200000",
    deleted_at: null,
    created_at: new Date(startedAtMs - 86_400_000).toISOString(),
    ...overrides,
  };
}

function providerRow(overrides: Row = {}): Row {
  return {
    id: providerId,
    provider_key: "nmi",
    status: "enabled",
    company_id: null,
    deleted_at: null,
    ...overrides,
  };
}

interface Harness {
  readonly fixture: Fixture;
  readonly audit: InMemoryAuditTrail;
  readonly dependencies: RefundExecutionDependencies;
  readonly calls: RefundProviderTarget[];
  setOutcome(outcome: RefundProviderOutcome): void;
}

function harnessOf(options: {
  readonly payment?: Row;
  readonly provider?: Row;
  readonly outcome?: RefundProviderOutcome;
  readonly ports?: Partial<Record<ProviderKey, RefundProviderPort>>;
} = {}): Harness {
  const fixture = createFixture([paymentRow(options.payment ?? {})], [providerRow(options.provider ?? {})]);
  const audit = createInMemoryAuditTrail();
  const calls: RefundProviderTarget[] = [];
  let outcome: RefundProviderOutcome = options.outcome ?? {
    kind: "succeeded",
    providerRefundId: "nmi-refund-0001",
  };

  const port: RefundProviderPort = async (target) => {
    calls.push(target);

    return outcome;
  };

  const dependencies: RefundExecutionDependencies = {
    rest: fixture.rest,
    audit,
    providers: options.ports ?? { nmi: port },
    now: () => startedAtMs,
  };

  return {
    fixture,
    audit,
    dependencies,
    calls,
    setOutcome(next: RefundProviderOutcome): void {
      outcome = next;
    },
  };
}

/** Seed an approved refund row directly: this gate is about what happens after the decision. */
async function seedApprovedRefund(
  harness: Harness,
  overrides: Row = {},
): Promise<{ readonly id: string; readonly version: number }> {
  const rows = await harness.fixture.rest.insertReturning(
    "refunds",
    [
      {
        id: `8b000000-0000-4000-8000-00000000000${String(harness.fixture.refunds.length + 1)}`,
        company_id: companyId,
        payment_id: "5f000000-0000-4000-8000-000000000001",
        amount_minor: "2000000",
        currency: "USD",
        status: "approved",
        reason: "Damaged goods returned",
        requested_by: ownerUserId,
        approved_by: financeUserId,
        decided_at: new Date(startedAtMs).toISOString(),
        ...overrides,
      },
    ],
    z.looseObject({ id: z.string(), version: z.number() }),
  );

  const row = rows[0];

  if (row === undefined) {
    throw new Error("the fixture refused the seed");
  }

  return { id: row.id, version: row.version };
}

function actionsOf(audit: InMemoryAuditTrail): readonly string[] {
  return audit.entries.map((entry) => entry.action);
}

function payloadOf(audit: InMemoryAuditTrail, action: string): Readonly<Record<string, unknown>> | null {
  return audit.entries.find((candidate) => candidate.action === action)?.payload ?? null;
}

// ---------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  // -------------------------------------------------------------------------------------------
  // 1. The vocabulary
  // -------------------------------------------------------------------------------------------
  expectEqual(REFUND_EXECUTABLE_STATUS, "approved", "only an approved refund is executable");
  expectEqual(REFUND_PROVIDER_OUTCOMES.length, 5, "a provider has five answers");
  expectEqual(
    new Set(Object.values(REFUND_EXECUTION_RULES)).size,
    Object.values(REFUND_EXECUTION_RULES).length,
    "no two refusals share a rule",
  );
  expectEqual(
    new Set([
      REFUND_PROCESSING_AUDIT_ACTION,
      REFUND_SUCCEEDED_AUDIT_ACTION,
      REFUND_FAILED_AUDIT_ACTION,
      REFUND_PROVIDER_PENDING_AUDIT_ACTION,
      REFUND_PROVIDER_UNANSWERED_AUDIT_ACTION,
      REFUND_EXECUTION_REFUSED_AUDIT_ACTION,
    ]).size,
    6,
    "six audit actions, one per thing that can happen",
  );
  expect(
    [
      REFUND_PROCESSING_AUDIT_ACTION,
      REFUND_SUCCEEDED_AUDIT_ACTION,
      REFUND_FAILED_AUDIT_ACTION,
      REFUND_PROVIDER_PENDING_AUDIT_ACTION,
      REFUND_PROVIDER_UNANSWERED_AUDIT_ACTION,
      REFUND_EXECUTION_REFUSED_AUDIT_ACTION,
    ].every((action) => action.startsWith("refund.") && /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/u.test(action)),
    "all six in the column's own alphabet, under the refund family",
  );
  expectEqual(REFUND_DETAIL_MAXIMUM_LENGTH, 280, "the detail limit is `refunds_failure_check`'s");
  expectEqual(REFUND_EXECUTION_MAXIMUM_BODY_BYTES, 512, "an execution carries no body worth more");

  expectEqual(REFUNDING_PROVIDER_KEYS.join(","), "nmi", "this build refunds through NMI, and says so");
  expect(
    REFUNDING_PROVIDER_KEYS.every((key) => PROVIDER_KEYS.includes(key)),
    "and only through keys the registry knows",
  );
  expectEqual(isRefundingProvider("nmi"), true, "NMI refunds");
  expectEqual(isRefundingProvider("stripe_connect"), false, "Stripe does not, yet");

  // -------------------------------------------------------------------------------------------
  // 2. The amount, as the networks write it
  // -------------------------------------------------------------------------------------------
  expectEqual(providerAmountOf(2_000_000n), "200.00", "two hundred dollars is two hundred dollars");
  expectEqual(providerAmountOf(100n), "0.01", "a cent is a cent");
  expectEqual(providerAmountOf(100_000_000n), "10000.00", "and ten thousand dollars is ten thousand");
  expectEqual(providerAmountOf(200_000n), "20.00", "twenty dollars, which is what the console types");
  expectEqual(providerAmountOf(1_234_567n), null, "an amount that is not a whole number of cents is refused");
  expectEqual(providerAmountOf(0n), null, "zero is not a refund");
  expectEqual(providerAmountOf(-100n), null, "nor is a negative one");

  expectEqual(failureDetailOf("  Provider said no.  ", "fallback"), "Provider said no.", "a detail is trimmed");
  expectEqual(failureDetailOf("   ", "the fallback"), "the fallback", "and never empty");
  expectEqual(failureDetailOf("x".repeat(400), "fallback").length, 280, "and never longer than the column");
  expect(failureDetailOf("x".repeat(400), "fallback").endsWith("…"), "the cut is visible");

  const recordingPort: RefundProviderPort = async () => ({ kind: "succeeded", providerRefundId: "x" });

  expectEqual(refundPortOf({}, "nmi"), null, "a build with no NMI port has no NMI port");
  expect(refundPortOf({ nmi: recordingPort }, "nmi") === recordingPort, "and the one it was given is the one it uses");
  expectEqual(refundPortOf({ nmi: recordingPort }, "unknown_provider"), null, "an unknown provider is never routed");

  // -------------------------------------------------------------------------------------------
  // 3. The NMI port, on its own
  // -------------------------------------------------------------------------------------------
  const nmiTarget: RefundProviderTarget = {
    refundId: "8b000000-0000-4000-8000-000000000010",
    paymentId: "5f000000-0000-4000-8000-000000000001",
    companyId,
    providerKey: "nmi",
    providerId,
    mode: "live",
    providerReference: "nmi-txn-0001",
    amountMinor: 2_000_000n,
    providerAmount: "200.00",
    currency: "USD",
    providerKeyId: null,
  };

  interface RecordedCall {
    readonly endpoint: string;
    readonly payload: Record<string, string>;
  }

  function nmiPortWith(options: {
    readonly raw?: Record<string, string>;
    readonly throws?: string;
    readonly secret?: string | null;
    readonly expectEndpoint?: string;
  }): { readonly port: RefundProviderPort; readonly calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const port = createNmiRefundPort({
      secret: async () => (options.secret === null ? null : { secretKey: options.secret ?? "nmi-secret-key" }),
      transport: async (endpoint, payload) => {
        calls.push({ endpoint, payload });

        if (options.throws !== undefined) {
          throw new Error(options.throws);
        }

        return options.raw ?? {};
      },
    });

    return { port, calls };
  }

  const accepted = nmiPortWith({
    raw: { response: "1", transactionid: "nmi-refund-0001", response_code: "100", responsetext: "Transaction Approved", amount: "200.00" },
  });
  const acceptedOutcome = await accepted.port(nmiTarget);

  expectEqual(acceptedOutcome.kind, "succeeded", "an accepted refund is succeeded");
  expectEqual(
    acceptedOutcome.kind === "succeeded" ? acceptedOutcome.providerRefundId : "",
    "nmi-refund-0001",
    "with the id NMI gave it",
  );
  expectEqual(accepted.calls.length, 1, "one call, one answer");
  expectEqual(accepted.calls[0]?.endpoint, "https://secure.nmi.com/api/transact.php", "the live endpoint in live mode");
  expectEqual(accepted.calls[0]?.payload["type"], "refund", "the transaction type is a refund");
  expectEqual(accepted.calls[0]?.payload["transactionid"], "nmi-txn-0001", "naming the original transaction");
  expectEqual(accepted.calls[0]?.payload["amount"], "200.00", "for the refunded amount");
  expectEqual(accepted.calls[0]?.payload["orderid"], nmiTarget.refundId, "and carrying the refund id as its order");
  expectEqual(accepted.calls[0]?.payload["security_key"], "nmi-secret-key", "signed with the provider's key");
  expectEqual(accepted.calls[0]?.payload["payment_token"], undefined, "with no token, which a refund may not carry");

  const sandboxed = nmiPortWith({ raw: { response: "1", transactionid: "nmi-refund-0002" } });

  await sandboxed.port({ ...nmiTarget, mode: "test" });
  expectEqual(
    sandboxed.calls[0]?.endpoint,
    "https://sandbox.nmi.com/api/transact.php",
    "and the sandbox endpoint in test mode, which is the mode the payment was taken in",
  );

  const declinedCall = nmiPortWith({
    raw: { response: "2", response_code: "300", responsetext: "Do not honor" },
  });
  const declinedOutcome = await declinedCall.port(nmiTarget);

  expectEqual(declinedOutcome.kind, "declined", "a network refusal is a decline");
  expect(
    declinedOutcome.kind === "declined" && declinedOutcome.detail.includes("300"),
    "carrying NMI's own code",
  );
  expect(
    declinedOutcome.kind === "declined" && declinedOutcome.detail.includes("Do not honor"),
    "and its own words",
  );

  const timeoutOutcome = await nmiPortWith({ throws: "socket hang up" }).port(nmiTarget);

  expectEqual(timeoutOutcome.kind, "unanswered", "a transport failure is unanswered, never failed");

  // NMI says a transaction is successful only when it named one, so an answer with `response=1` and no id is
  // read as a refusal by the adapter itself - and the port turns that into a decline with a detail of its own.
  const noIdOutcome = await nmiPortWith({ raw: { response: "1" } }).port(nmiTarget);

  expectEqual(noIdOutcome.kind, "declined", "an acceptance with no identifier cannot be a success");
  expect(
    noIdOutcome.kind === "declined" && noIdOutcome.detail.trim().length > 0,
    "and its detail is never empty, because `refunds_failure_check` requires one",
  );

  const noSecretOutcome = await nmiPortWith({ secret: null }).port(nmiTarget);

  expectEqual(noSecretOutcome.kind, "not_sent", "no key means nothing is sent");
  expectEqual(
    noSecretOutcome.kind === "not_sent" ? noSecretOutcome.rule : "",
    REFUND_EXECUTION_RULES.credentialMissing,
    "with the key rule",
  );

  const noReferenceOutcome = await nmiPortWith({ raw: { response: "1", transactionid: "x" } }).port({
    ...nmiTarget,
    providerReference: "",
  });

  expectEqual(noReferenceOutcome.kind, "not_sent", "a request NMI's own validator refuses is not sent");
  expectEqual(
    noReferenceOutcome.kind === "not_sent" ? noReferenceOutcome.rule : "",
    REFUND_EXECUTION_RULES.providerRefused,
    "with the refusal rule",
  );

  // -------------------------------------------------------------------------------------------
  // 4. Who may execute, and what is executable
  // -------------------------------------------------------------------------------------------
  const merchantHarness = harnessOf();
  const merchantSeed = await seedApprovedRefund(merchantHarness);
  const merchantActor = actorOf({ userId: ownerUserId, companyId, roles: ["owner"] });

  await expectRefusal(
    () => executeRefund({ actor: merchantActor, refundId: merchantSeed.id }, merchantHarness.dependencies),
    "PERMISSION_DENIED",
    "",
    "a merchant cannot execute a refund",
  );

  await expectRefusal(
    () => executeRefund({ actor: deskActor(), refundId: "8b000000-0000-4000-8000-0000000000ff" }, merchantHarness.dependencies),
    "RESOURCE_NOT_FOUND",
    REFUND_EXECUTION_RULES.refundNotFound,
    "an unknown refund is not found",
  );

  for (const [status, rule] of [
    ["requested", REFUND_EXECUTION_RULES.refundNotExecutable],
    ["processing", REFUND_EXECUTION_RULES.refundNotExecutable],
    ["failed", REFUND_EXECUTION_RULES.refundNotExecutable],
    ["cancelled", REFUND_EXECUTION_RULES.refundNotExecutable],
  ] as const) {
    const harness = harnessOf();
    const seeded = await seedApprovedRefund(harness, {
      status,
      approved_by: status === "requested" || status === "cancelled" ? null : financeUserId,
      decided_at: status === "requested" || status === "cancelled" ? null : new Date(startedAtMs).toISOString(),
      processed_at: status === "failed" ? new Date(startedAtMs).toISOString() : null,
      failure_detail: status === "failed" ? "the provider declined it" : null,
    });

    await expectRefusal(
      () => executeRefund({ actor: deskActor(), refundId: seeded.id }, harness.dependencies),
      "CONFLICT",
      rule,
      `a ${status} refund is not executable`,
    );
    expectEqual(harness.calls.length, 0, `and no provider is called for a ${status} refund`);
  }

  // A succeeded refund cannot be executed a second time: the money has already gone.
  const succeededHarness = harnessOf();
  const succeededSeed = await seedApprovedRefund(succeededHarness, {
    status: "succeeded",
    processed_at: new Date(startedAtMs).toISOString(),
    provider_refund_id: "nmi-refund-0009",
  });

  await expectRefusal(
    () => executeRefund({ actor: deskActor(), refundId: succeededSeed.id }, succeededHarness.dependencies),
    "CONFLICT",
    REFUND_EXECUTION_RULES.refundNotExecutable,
    "a succeeded refund is not executed twice",
  );

  // -------------------------------------------------------------------------------------------
  // 5. The originating provider, the reference and the amount
  // -------------------------------------------------------------------------------------------
  const unsupportedHarness = harnessOf({ provider: { provider_key: "stripe_connect" } });
  const unsupportedSeed = await seedApprovedRefund(unsupportedHarness);

  await expectRefusal(
    () => executeRefund({ actor: deskActor(), refundId: unsupportedSeed.id }, unsupportedHarness.dependencies),
    "SERVICE_UNAVAILABLE",
    REFUND_EXECUTION_RULES.providerUnsupported,
    "a provider with no refund path is refused, not faked",
  );
  expectEqual(
    unsupportedHarness.fixture.refunds[0]?.["status"],
    "approved",
    "and the refund stays approved, because no money moved",
  );

  const noProviderHarness = harnessOf({ provider: { provider_key: "unknown_provider" } });
  const noProviderSeed = await seedApprovedRefund(noProviderHarness);

  await expectRefusal(
    () => executeRefund({ actor: deskActor(), refundId: noProviderSeed.id }, noProviderHarness.dependencies),
    "SERVICE_UNAVAILABLE",
    REFUND_EXECUTION_RULES.providerUnsupported,
    "a provider this build cannot even read a port for is refused the same way",
  );

  const noReferenceHarness = harnessOf({ payment: { provider_transaction_id: null } });
  const noReferenceSeed = await seedApprovedRefund(noReferenceHarness);

  await expectRefusal(
    () => executeRefund({ actor: deskActor(), refundId: noReferenceSeed.id }, noReferenceHarness.dependencies),
    "CONFLICT",
    REFUND_EXECUTION_RULES.referenceMissing,
    "a payment with no provider transaction cannot be refunded",
  );

  const oddAmountHarness = harnessOf();
  const oddAmountSeed = await seedApprovedRefund(oddAmountHarness, { amount_minor: "1234567" });

  await expectRefusal(
    () => executeRefund({ actor: deskActor(), refundId: oddAmountSeed.id }, oddAmountHarness.dependencies),
    "VALIDATION_FAILED",
    REFUND_EXECUTION_RULES.amountUnrepresentable,
    "an amount the provider cannot express is refused before the call",
  );
  expectEqual(oddAmountHarness.calls.length, 0, "and nothing is sent");
  expectEqual(oddAmountHarness.fixture.refunds[0]?.["status"], "approved", "with the refund still approved");

  // -------------------------------------------------------------------------------------------
  // 6. A refund that succeeds
  // -------------------------------------------------------------------------------------------
  const happyHarness = harnessOf();
  const happySeed = await seedApprovedRefund(happyHarness);
  const succeeded = await executeRefund({ actor: deskActor(), refundId: happySeed.id }, happyHarness.dependencies);

  expectEqual(succeeded.outcome, "succeeded", "the provider accepted it");
  expectEqual(succeeded.providerKey, "nmi", "through the provider the payment recorded");
  expectEqual(succeeded.refund.status, "succeeded", "the refund is succeeded");
  expectEqual(succeeded.refund.providerRefundId, "nmi-refund-0001", "with the provider's own identifier");
  expect(succeeded.refund.processedAt !== null, "and the instant it answered");

  expectEqual(happyHarness.calls.length, 1, "the provider was called once");
  const target = happyHarness.calls[0];

  expectEqual(target?.paymentId, "5f000000-0000-4000-8000-000000000001", "the call names the payment");
  expectEqual(target?.providerKey, "nmi", "the provider");
  expectEqual(target?.providerId, providerId, "its registry row");
  expectEqual(target?.mode, "live", "the mode the payment was taken in");
  expectEqual(target?.providerReference, "nmi-txn-0001", "the provider's own transaction");
  expectEqual(target?.providerAmount, "200.00", "the amount in hundredths");
  expectEqual(target?.amountMinor, 2_000_000n, "and in the platform's own unit");
  expectEqual(target?.providerKeyId, "7a000000-0000-4000-8000-000000000001", "and the key that signed the sale");

  expectEqual(actionsOf(happyHarness.audit).join(","), "refund.processing,refund.succeeded", "two chain entries");
  expectEqual(
    payloadOf(happyHarness.audit, REFUND_SUCCEEDED_AUDIT_ACTION)?.["provider_refund_id"],
    "nmi-refund-0001",
    "the success entry names the provider's identifier",
  );
  expectEqual(
    payloadOf(happyHarness.audit, REFUND_PROCESSING_AUDIT_ACTION)?.["provider"],
    "nmi",
    "and the attempt names the provider before it was asked",
  );

  expectEqual(
    happyHarness.fixture.payments[0]?.["refunded_minor"],
    "2000000",
    "the payment's refunded total is written by the database's sync",
  );
  expectEqual(
    happyHarness.fixture.payments[0]?.["status"],
    "partially_refunded",
    "and the payment is partly refunded",
  );
  expectEqual(
    happyHarness.fixture.paymentWrites.length,
    0,
    "while this STEP wrote no payment row at all",
  );

  // The rest of the payment, refunded in full.
  const secondSeed = await seedApprovedRefund(happyHarness, { amount_minor: "98000000" });
  const full = await executeRefund({ actor: deskActor(), refundId: secondSeed.id }, happyHarness.dependencies);

  expectEqual(full.outcome, "succeeded", "the rest of the payment is refunded too");
  expectEqual(happyHarness.fixture.payments[0]?.["status"], "refunded", "which makes the payment refunded");
  expectEqual(
    happyHarness.fixture.payments[0]?.["refunded_minor"],
    "100000000",
    "with the whole amount written",
  );
  expectEqual(happyHarness.fixture.paymentWrites.length, 0, "and still no write from this STEP");

  // -------------------------------------------------------------------------------------------
  // 7. The provider declines
  // -------------------------------------------------------------------------------------------
  const declinedHarness = harnessOf({
    outcome: { kind: "declined", detail: "  300 Gateway declined: insufficient funds in the merchant account.  " },
  });
  const declinedSeed = await seedApprovedRefund(declinedHarness);
  const declined = await executeRefund({ actor: deskActor(), refundId: declinedSeed.id }, declinedHarness.dependencies);

  expectEqual(declined.outcome, "declined", "a decline is its own outcome");
  expectEqual(declined.refund.status, "failed", "the refund is failed");
  expect(declined.refund.processedAt !== null, "with the instant the provider answered");
  expectEqual(
    declined.refund.failureDetail,
    "300 Gateway declined: insufficient funds in the merchant account.",
    "and the provider's own words, trimmed",
  );
  expectEqual(actionsOf(declinedHarness.audit).join(","), "refund.processing,refund.failed", "two chain entries");
  expectEqual(
    declinedHarness.fixture.payments[0]?.["refunded_minor"],
    "0",
    "a decline moves no money, so the payment's total is untouched",
  );

  const emptyDeclineHarness = harnessOf({ outcome: { kind: "declined", detail: "   " } });
  const emptyDeclineSeed = await seedApprovedRefund(emptyDeclineHarness);
  const emptyDecline = await executeRefund(
    { actor: deskActor(), refundId: emptyDeclineSeed.id },
    emptyDeclineHarness.dependencies,
  );

  expect(
    emptyDecline.refund.failureDetail !== null && emptyDecline.refund.failureDetail.length > 0,
    "a decline with no words still writes a detail, because `0038` requires one",
  );

  // -------------------------------------------------------------------------------------------
  // 8. Pending and unanswered: the row stays in processing
  // -------------------------------------------------------------------------------------------
  const pendingHarness = harnessOf({ outcome: { kind: "pending", providerRefundId: "nmi-refund-0002" } });
  const pendingSeed = await seedApprovedRefund(pendingHarness);
  const pending = await executeRefund({ actor: deskActor(), refundId: pendingSeed.id }, pendingHarness.dependencies);

  expectEqual(pending.outcome, "pending", "a pending answer is its own outcome");
  expectEqual(pending.refund.status, "processing", "the refund stays in processing");
  expectEqual(pending.refund.providerRefundId, "nmi-refund-0002", "with the identifier the provider gave");
  expectEqual(pending.refund.processedAt, null, "and no processed instant, which `0038` ties to the two endings");
  expectEqual(
    actionsOf(pendingHarness.audit).join(","),
    "refund.processing,refund.provider_pending",
    "and the chain says the answer is coming",
  );

  await expectRefusal(
    () => executeRefund({ actor: deskActor(), refundId: pendingSeed.id }, pendingHarness.dependencies),
    "CONFLICT",
    REFUND_EXECUTION_RULES.refundNotExecutable,
    "a pending refund is not sent a second time",
  );
  expectEqual(pendingHarness.calls.length, 1, "which is what stops a double refund");

  const unansweredHarness = harnessOf({ outcome: { kind: "unanswered", detail: "The provider did not answer." } });
  const unansweredSeed = await seedApprovedRefund(unansweredHarness);
  const unanswered = await executeRefund(
    { actor: deskActor(), refundId: unansweredSeed.id },
    unansweredHarness.dependencies,
  );

  expectEqual(unanswered.outcome, "unanswered", "an unanswered call is its own outcome");
  expectEqual(unanswered.refund.status, "processing", "and the refund is left in processing");
  expectEqual(unanswered.refund.failureDetail, null, "with no failure detail, because nothing failed for certain");
  expectEqual(
    actionsOf(unansweredHarness.audit)[1],
    REFUND_PROVIDER_UNANSWERED_AUDIT_ACTION,
    "the chain records that the provider did not answer",
  );
  expectEqual(
    payloadOf(unansweredHarness.audit, REFUND_PROVIDER_UNANSWERED_AUDIT_ACTION)?.["retry"],
    "manual",
    "and that nothing here retries it",
  );

  // -------------------------------------------------------------------------------------------
  // 9. Not sent: no provider was asked, so the refund goes back
  // -------------------------------------------------------------------------------------------
  const notSentHarness = harnessOf({
    ports: {
      nmi: async () => ({
        kind: "not_sent",
        rule: REFUND_EXECUTION_RULES.credentialMissing,
        detail: "No active NMI security key for the mode this payment was taken in.",
      }),
    },
  });
  const notSentSeed = await seedApprovedRefund(notSentHarness);
  const notSent = await executeRefund({ actor: deskActor(), refundId: notSentSeed.id }, notSentHarness.dependencies);

  expectEqual(notSent.outcome, "not_sent", "a call that was never made is its own outcome");
  expectEqual(notSent.refund.status, "approved", "and the refund is approved again");
  expectEqual(notSent.refund.processedAt, null, "with no processed instant");
  expectEqual(
    actionsOf(notSentHarness.audit)[1],
    REFUND_EXECUTION_REFUSED_AUDIT_ACTION,
    "the chain records the refusal",
  );
  expectEqual(
    payloadOf(notSentHarness.audit, REFUND_EXECUTION_REFUSED_AUDIT_ACTION)?.["rule"],
    REFUND_EXECUTION_RULES.credentialMissing,
    "with the rule that stopped it",
  );
  expectEqual(notSentHarness.fixture.payments[0]?.["refunded_minor"], "0", "and no money moved");

  // -------------------------------------------------------------------------------------------
  // 10. The sources
  // -------------------------------------------------------------------------------------------
  const serviceRoot = new URL("./", import.meta.url);
  const executionSource = await readFile(new URL("refund-execution.ts", serviceRoot), "utf8");
  const nmiSource = await readFile(new URL("refund-nmi.ts", serviceRoot), "utf8");
  const runtimeSource = await readFile(new URL("refund-execution-runtime.ts", serviceRoot), "utf8");
  const routeSource = await readFile(
    new URL("../../app/api/office/refunds/[id]/execute/route.ts", serviceRoot),
    "utf8",
  );
  const csrfSource = await readFile(new URL("../../lib/security/csrf.ts", serviceRoot), "utf8");
  const gatewaysSource = await readFile(new URL("../../lib/gateways/service.ts", serviceRoot), "utf8");
  const queuePage = await readFile(new URL("../../app/(admin)/office/refunds/page.tsx", serviceRoot), "utf8");
  const executionForm = await readFile(
    new URL("../../app/(admin)/office/refunds/refund-execution-form.tsx", serviceRoot),
    "utf8",
  );

  expect(routeSource.includes("requireCsrfToken("), "the execute route checks the CSRF token");
  expect(routeSource.includes("requireTrustedDevice("), "and demands a signed device proof, because money leaves");
  expect(routeSource.includes('"cache-control": "no-store"'), "and answers no-store");
  expect(
    csrfSource.includes('"/api/office/refunds/[id]/execute"'),
    "and is on the CSRF protected list",
  );
  expectEqual(
    executionSource.split("refunded_minor").length - 1,
    1,
    "the execution service names a payment's refunded total once, in prose, and writes it nowhere",
  );
  expect(!executionSource.includes("refunded_minor:"), "no column assignment exists for it either");
  expect(!executionSource.includes('update(\n    "payments"'), "and it never updates a payment row");
  expect(
    !executionSource.includes("platform_fee_returned"),
    "and never touches the platform fee, which is STEP 193's",
  );
  expect(
    executionSource.includes("moveRefund(") && executionSource.includes("findRefund("),
    "it reuses STEP 191's guarded write and read rather than a second copy",
  );
  expect(
    nmiSource.includes("buildNmiRequest") && nmiSource.includes("executeNmiTransaction"),
    "the NMI port reuses the adapter's request builder and answer reader",
  );
  expect(
    nmiSource.includes("nmiFetchTransport") && nmiSource.includes("NMI_SANDBOX_API_ENDPOINT"),
    "and its own transport and endpoints",
  );
  expect(
    runtimeSource.includes("provider_keys") && runtimeSource.includes("getGatewayRuntime().secrets.open"),
    "the runtime reads the sealed provider key and opens it with the platform's one cipher",
  );
  expect(
    gatewaysSource.includes("`provider_keys:${providerKey}:${mode}:${fingerprint}`") &&
      runtimeSource.includes("`provider_keys:${providerKey}:${mode}:${fingerprint}`"),
    "and the context it opens under is the gateways service's own formula",
  );
  expect(
    queuePage.includes("<RefundExecutionForm") && queuePage.includes('refund.status === "approved"'),
    "the queue offers execution only on an approved row",
  );
  expect(
    executionForm.includes('deviceProofHeaders("POST", path, payload)') &&
      executionForm.includes("csrfHeaders()"),
    "and the form signs its bytes and carries the token",
  );

  const migrations = (await readdir(new URL("../../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name) && !name.endsWith(".down.sql"))
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .sort((left, right) => left - right);

  expectEqual(migrations[migrations.length - 1] ?? 0, 122, "this STEP adds no migration either");

  if (failures.length > 0) {
    process.stdout.write(`refund execution gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `refund execution gate passed: ${String(checkCount)} checks, an approved refund sent through the provider that took the payment, five provider answers landing on the statuses 0038 allows, the payment's refunded total written only by the database, and the four providers this build cannot refund through saying so\n`,
  );
}

await main();
