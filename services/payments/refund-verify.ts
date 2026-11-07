// path: services/payments/refund-verify.ts
import process from "node:process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import {
  REFUND_APPROVED_AUDIT_ACTION,
  REFUND_CANCELLED_AUDIT_ACTION,
  REFUND_DECISION_ROLES,
  REFUND_LIST_LIMIT,
  REFUND_LIVE_STATUSES,
  REFUND_OPEN_STATUSES,
  REFUND_QUEUE_LIMIT,
  REFUND_REASON_MAXIMUM_LENGTH,
  REFUND_REJECTED_AUDIT_ACTION,
  REFUND_REQUESTED_AUDIT_ACTION,
  REFUND_REQUEST_ROLES,
  REFUND_RULES,
  REFUND_STATUSES,
  REFUND_AUDIT_ENTITY,
  parseRefundDecisionBody,
  parseRefundRequestBody,
  refundAmountOf,
  refundReasonOf,
  refundRemainingOf,
} from "./refund-fields.ts";
import {
  cancelRefund,
  decideRefund,
  listRefundablePayments,
  listRefundQueue,
  listRefunds,
  readRefund,
  requestRefund,
  type RefundDependencies,
} from "./refund.ts";

/**
 * The gate for STEP 191: section 19's refund request, approval and status tracking.
 *
 * ## What this proves
 *
 *   - **A refund is raised by the merchant that owns the payment**, for an amount inside what is left of
 *     it, with a reason the row can hold. A payment of another merchant, an uncaptured payment, a fully
 *     refunded one, an amount past the headroom and a reason outside `0038`'s bounds are each refused with
 *     their own rule, and nothing is written.
 *   - **Money is promised once.** The headroom counts what is held (approved, processing, succeeded) *and*
 *     what is still requested, so two merchants cannot both ask for the whole of one payment and leave the
 *     approval desk to discover it.
 *   - **A refund is decided by the platform, never by the person who raised it.** `finance_ops` and
 *     `super_admin` approve or reject; an `owner` cannot; the requester cannot decide their own request; and
 *     an approval re-checks the headroom, because an approval may have landed in between.
 *   - **Every act leaves one chain entry**, under entity `refund`, and the merchant's own words are not
 *     copied into it.
 *   - **No provider is called**, because executing a refund is STEP 192's and returning the platform fee
 *     is STEP 193's. The gate proves the service contains no gateway call and never writes
 *     `payments.refunded_minor`, which `0037`'s trigger reserves for the refund sync.
 *   - **No migration is needed**: `0038` already carries the table, the six statuses, the approval and
 *     processing constraints, the cap trigger and the payment sync. The gate reads that file and asserts
 *     every one of them, and asserts the newest migration is whatever the chain's head is (124, after STEP 195).
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

/** Run a call that must refuse, and check the code and the first rule it names. */
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
// A PostgREST over arrays, with `0038`'s triggers on it.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOwnerUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const financeUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const otherFinanceUserId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const startedAtMs = Date.parse("2026-11-07T09:00:00.000Z");

function actorOf(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: ownerUserId,
    companyId,
    roles: ["owner"],
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

/** The desk: a platform account, so a `companyId` of null and an office role. */
function deskActor(role: "finance_ops" | "super_admin" = "finance_ops", userId = financeUserId): RequestActor {
  return actorOf({ userId, companyId: null, roles: [role] });
}

interface Fixture {
  readonly rest: RestClient;
  readonly payments: Row[];
  readonly refunds: Row[];
  /**
   * Something that lands between a caller's read and its write.
   *
   * A real race cannot be scheduled inside one process, so the fixture is given the one moment that matters:
   * another actor deciding the row the caller is about to move. Cleared after it fires.
   */
  beforeUpdate: ((table: string) => void) | null;
}

/** The clauses a query string carries, as this gate's fake understands them. */
interface Query {
  readonly equals: Map<string, string>;
  readonly notEquals: Map<string, string>;
  readonly inLists: Map<string, readonly string[]>;
  readonly nulls: Set<string>;
  readonly order: { readonly column: string; readonly direction: "asc" | "desc" } | null;
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const notEquals = new Map<string, string>();
  const inLists = new Map<string, readonly string[]>();
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

    if (value.startsWith("in.(") && value.endsWith(")")) {
      inLists.set(key, value.slice(4, -1).split(","));

      continue;
    }

    if (value.startsWith("not.eq.")) {
      notEquals.set(key, value.slice(7));

      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, value.slice(3));
    }
  }

  return { equals, notEquals, inLists, nulls, order, limit };
}

function matches(row: Row, query: Query): boolean {
  for (const [column, value] of query.equals) {
    if (String(row[column]) !== value) {
      return false;
    }
  }

  for (const [column, value] of query.notEquals) {
    if (String(row[column]) === value) {
      return false;
    }
  }

  for (const [column, values] of query.inLists) {
    if (!values.includes(String(row[column]))) {
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

/** The live total `refunds_guard_amount` sums: approved, processing and succeeded, excluding this row. */
function liveTotalOf(refunds: readonly Row[], paymentId: string, exceptId: string | null): number {
  let total = 0;

  for (const row of refunds) {
    if (
      row["payment_id"] === paymentId &&
      row["id"] !== exceptId &&
      (REFUND_LIVE_STATUSES as readonly string[]).includes(String(row["status"]))
    ) {
      total += Number(row["amount_minor"]);
    }
  }

  return total;
}

/**
 * The triggers of `0038`, in the fixture.
 *
 * The service is written to refuse before it writes, so most of these never fire. They exist so the gate can
 * prove *that*: the two tests that need the database to be the last word - a second approval racing the
 * first, and the cap at the exact boundary - are answered by the same rules the migration enforces.
 */
function guardRefund(fixture: { readonly payments: readonly Row[]; readonly refunds: readonly Row[] }, row: Row): void {
  const payment = fixture.payments.find((candidate) => candidate["id"] === row["payment_id"]);

  if (payment === undefined) {
    throw new AppError("CONFLICT", { details: [{ field: "payment_id", rule: "refund_guard" }] });
  }

  if (payment["company_id"] !== row["company_id"]) {
    throw new AppError("CONFLICT", { details: [{ field: "company_id", rule: "refund_guard" }] });
  }

  if (payment["currency"] !== row["currency"]) {
    throw new AppError("CONFLICT", { details: [{ field: "currency", rule: "refund_guard" }] });
  }

  const live = (REFUND_LIVE_STATUSES as readonly string[]).includes(String(row["status"]));

  if (
    live &&
    !["captured", "settled", "partially_refunded", "refunded"].includes(String(payment["status"]))
  ) {
    throw new AppError("CONFLICT", { details: [{ field: "payment_id", rule: "refund_guard" }] });
  }

  if (live) {
    const total = liveTotalOf(fixture.refunds, String(row["payment_id"]), String(row["id"]));

    if (total + Number(row["amount_minor"]) > Number(payment["amount_minor"])) {
      throw new AppError("CONFLICT", { details: [{ field: "amount", rule: "refund_guard" }] });
    }
  }

  if (Number(row["platform_fee_returned_minor"] ?? 0) > Number(payment["platform_fee_minor"])) {
    throw new AppError("CONFLICT", { details: [{ field: "platform_fee", rule: "refund_guard" }] });
  }

  const decided = ["approved", "processing", "succeeded", "failed"].includes(String(row["status"]));

  if (decided && (row["approved_by"] === null || row["decided_at"] === null)) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "refund_approval" }] });
  }

  const pending = ["requested", "cancelled"].includes(String(row["status"]));

  if (pending && (row["approved_by"] !== null || row["decided_at"] !== null)) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "refund_approval" }] });
  }

  const processed = ["succeeded", "failed"].includes(String(row["status"]));

  if (processed !== (row["processed_at"] !== null)) {
    throw new AppError("CONFLICT", { details: [{ field: "processed_at", rule: "refund_processed" }] });
  }
}

function createFixture(payments: readonly Row[]): Fixture {
  const refunds: Row[] = [];
  /** Each write lands a second after the last, so a list ordered by `created_at` has an order to print. */
  let writeCount = 0;
  const table = { payments: [...payments], refunds };

  const rowsOf = (name: string): Row[] => {
    if (name === "payments") {
      return table.payments;
    }

    if (name === "refunds") {
      return table.refunds;
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
          id: randomUUID(),
          status: "requested",
          currency: "USD",
          approved_by: null,
          decided_at: null,
          processed_at: null,
          provider_refund_id: null,
          platform_fee_returned: false,
          platform_fee_returned_minor: 0,
          failure_detail: null,
          created_at: new Date(startedAtMs + writeCount * 1_000).toISOString(),
          updated_at: new Date(startedAtMs + writeCount * 1_000).toISOString(),
          version: 1,
          ...row,
        };

        guardRefund(table, complete);
        rowsOf(name).push(complete);
        written.push(complete);
      }

      return schema.array().parse(written);
    },

    async update(name: string, query: string, values: Row): Promise<void> {
      const interference = fixture.beforeUpdate;

      fixture.beforeUpdate = null;
      interference?.(name);

      const parsed = parseQuery(query);

      for (const row of rowsOf(name).filter((candidate) => matches(candidate, parsed))) {
        const next: Row = { ...row, ...values };

        if (name === "refunds") {
          guardRefund(table, next);
          next["version"] = Number(row["version"]) + 1;
          next["updated_at"] = new Date(startedAtMs + 1_000).toISOString();
        }

        Object.assign(row, next);
      }
    },

    async rpc(): Promise<unknown> {
      throw new AppError("DEPENDENCY_FAILED");
    },
  };

  const fixture: Fixture = { rest, payments: table.payments, refunds: table.refunds, beforeUpdate: null };

  return fixture;
}

function paymentRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    company_id: companyId,
    invoice_id: null,
    amount_minor: "100000000",
    currency: "USD",
    refunded_minor: "0",
    platform_fee_minor: "20000",
    fee_minor: "29000",
    status: "captured",
    captured_at: new Date(startedAtMs - 86_400_000).toISOString(),
    settled_at: null,
    created_at: new Date(startedAtMs - 86_400_000).toISOString(),
    deleted_at: null,
    ...overrides,
  };
}

interface Harness {
  readonly fixture: Fixture;
  readonly audit: InMemoryAuditTrail;
  readonly dependencies: RefundDependencies;
  readonly paymentId: string;
}

function harnessOf(paymentOverrides: Row = {}): Harness {
  const payment = paymentRow(paymentOverrides);
  const fixture = createFixture([payment]);
  const audit = createInMemoryAuditTrail();

  return {
    fixture,
    audit,
    paymentId: String(payment["id"]),
    dependencies: { rest: fixture.rest, audit, now: () => startedAtMs },
  };
}

const validBody = (paymentId: string, amount = "200.00"): Record<string, unknown> => ({
  payment_id: paymentId,
  amount,
  reason: "Damaged goods returned",
});

/** The actions one chain holds, in order. */
function actionsOf(audit: InMemoryAuditTrail): readonly string[] {
  return audit.entries.map((entry) => entry.action);
}

function payloadOf(audit: InMemoryAuditTrail, action: string): Readonly<Record<string, unknown>> | null {
  const entry = audit.entries.find((candidate) => candidate.action === action);

  return entry?.payload ?? null;
}

// ---------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  // -------------------------------------------------------------------------------------------
  // 1. The vocabulary, against `0038`
  // -------------------------------------------------------------------------------------------
  expectEqual(REFUND_STATUSES.length, 6, "`0038` allows six statuses");
  expectEqual(REFUND_AUDIT_ENTITY, "refund", "the audit entity");
  expectEqual(REFUND_REQUEST_ROLES.join(","), "owner", "a refund is raised by the merchant's owner");
  expectEqual(
    REFUND_DECISION_ROLES.join(","),
    "finance_ops,super_admin",
    "and decided by the platform's finance desk",
  );
  expect(
    REFUND_REQUEST_ROLES.every((role) => !(REFUND_DECISION_ROLES as readonly string[]).includes(role)),
    "the two lists are disjoint, which is what makes four eyes possible at all",
  );
  expectEqual(REFUND_LIVE_STATUSES.join(","), "approved,processing,succeeded", "the cap counts three statuses");
  expectEqual(REFUND_OPEN_STATUSES.join(","), "requested,approved,processing", "the queue shows three");
  expectEqual(REFUND_LIST_LIMIT, 50, "a merchant's list is bounded");
  expectEqual(REFUND_QUEUE_LIMIT, 100, "and the platform's queue");
  expectEqual(
    new Set(Object.values(REFUND_RULES)).size,
    Object.values(REFUND_RULES).length,
    "no two causes share a rule",
  );
  expect(
    Object.values(REFUND_RULES).every((rule) => /^[a-z][a-z0-9_]{2,48}$/u.test(rule)),
    "each rule is in the vocabulary's own alphabet",
  );

  // -------------------------------------------------------------------------------------------
  // 2. The two things a person types
  // -------------------------------------------------------------------------------------------
  expectEqual(refundAmountOf("200.00"), 2_000_000n, "an amount is typed as a price and stored in minor units");
  expectEqual(refundAmountOf(" 0.01 "), 100n, "a cent is a legal refund");
  expectEqual(refundReasonOf("  Damaged goods  "), "Damaged goods", "a reason is trimmed");

  for (const [text, rule] of [
    ["", REFUND_RULES.amountInvalid],
    ["abc", REFUND_RULES.amountInvalid],
    ["1e3", REFUND_RULES.amountInvalid],
    ["12,50", REFUND_RULES.amountInvalid],
    ["0", REFUND_RULES.amountTooSmall],
    ["0.00", REFUND_RULES.amountTooSmall],
  ] as const) {
    try {
      refundAmountOf(text);
      expect(false, `"${text}" is refused`);
    } catch (error) {
      expect(isAppError(error) && error.details[0]?.rule === rule, `"${text}" is refused with ${rule}`);
    }
  }

  try {
    refundReasonOf("   ");
    expect(false, "an empty reason is refused");
  } catch (error) {
    expect(isAppError(error) && error.details[0]?.rule === REFUND_RULES.reasonInvalid, "an empty reason is refused");
  }

  try {
    refundReasonOf("x".repeat(REFUND_REASON_MAXIMUM_LENGTH + 1));
    expect(false, "a reason past 500 characters is refused");
  } catch (error) {
    expect(
      isAppError(error) && error.details[0]?.rule === REFUND_RULES.reasonInvalid,
      "a reason past 500 characters is refused",
    );
  }

  const parsedBody = parseRefundRequestBody({
    payment_id: "11111111-1111-4111-8111-111111111111",
    amount: "20.00",
    reason: " Return ",
  });

  expectEqual(parsedBody.amountMinor, 200_000n, "a parsed request carries the amount in minor units");
  expectEqual(parsedBody.reason, "Return", "and the trimmed reason");

  for (const body of [
    { payment_id: "nope", amount: "20.00", reason: "x" },
    { payment_id: "11111111-1111-4111-8111-111111111111", amount: "20.00", reason: "x", extra: 1 },
    { payment_id: "11111111-1111-4111-8111-111111111111", amount: "20.00" },
  ]) {
    try {
      parseRefundRequestBody(body);
      expect(false, "a request body this platform does not take is refused");
    } catch (error) {
      expect(isAppError(error) && error.code === "VALIDATION_FAILED", "a request body this platform does not take is refused");
    }
  }

  expectEqual(parseRefundDecisionBody({ decision: "approve" }).decision, "approve", "a decision is approve or reject");
  expectEqual(parseRefundDecisionBody({ decision: "REJECT", note: "  " }).note, null, "an empty note is no note");

  try {
    parseRefundDecisionBody({ decision: "maybe" });
    expect(false, "an unknown decision word is refused rather than defaulted");
  } catch (error) {
    expect(
      isAppError(error) && error.code === "VALIDATION_FAILED",
      "an unknown decision word is refused rather than defaulted",
    );
  }

  expectEqual(
    refundRemainingOf({ amountMinor: 1_000n, heldMinor: 200n, promisedMinor: 300n }),
    500n,
    "the headroom is the charge less what is held and what is still asked for",
  );
  expectEqual(
    refundRemainingOf({ amountMinor: 1_000n, heldMinor: 900n, promisedMinor: 300n }),
    0n,
    "and it never goes negative",
  );

  // -------------------------------------------------------------------------------------------
  // 3. Requesting: the role, the payment, the amount, the reason
  // -------------------------------------------------------------------------------------------
  const harness = harnessOf();

  await expectRefusal(
    () => requestRefund({ actor: actorOf({ roles: ["support"] }), body: validBody(harness.paymentId) }, harness.dependencies),
    "PERMISSION_DENIED",
    "",
    "a member of staff cannot raise a refund",
  );

  await expectRefusal(
    () => requestRefund({ actor: deskActor(), body: validBody(harness.paymentId) }, harness.dependencies),
    "PERMISSION_DENIED",
    "",
    "and a platform account with no merchant cannot either",
  );

  await expectRefusal(
    () => requestRefund({ actor: actorOf(), body: validBody(randomUUID()) }, harness.dependencies),
    "RESOURCE_NOT_FOUND",
    REFUND_RULES.paymentNotFound,
    "a payment that does not exist is not found",
  );

  const otherHarness = harnessOf();

  await expectRefusal(
    () =>
      requestRefund(
        { actor: actorOf({ companyId: otherCompanyId, userId: otherOwnerUserId }), body: validBody(otherHarness.paymentId) },
        otherHarness.dependencies,
      ),
    "RESOURCE_NOT_FOUND",
    REFUND_RULES.paymentNotFound,
    "and another merchant's payment is not found either",
  );

  for (const [status, rule] of [
    ["pending", REFUND_RULES.paymentNotRefundable],
    ["authorized", REFUND_RULES.paymentNotRefundable],
    ["failed", REFUND_RULES.paymentNotRefundable],
    ["refunded", REFUND_RULES.nothingToRefund],
  ] as const) {
    const pendingHarness = harnessOf({ status });

    await expectRefusal(
      () => requestRefund({ actor: actorOf(), body: validBody(pendingHarness.paymentId) }, pendingHarness.dependencies),
      "CONFLICT",
      rule,
      `a ${status} payment cannot be refunded`,
    );
  }

  for (const [amount, rule, code] of [
    ["0", REFUND_RULES.amountTooSmall, "VALIDATION_FAILED"],
    ["abc", REFUND_RULES.amountInvalid, "VALIDATION_FAILED"],
    ["20000.00", REFUND_RULES.exceedsRefundable, "VALIDATION_FAILED"],
  ] as const) {
    await expectRefusal(
      () => requestRefund({ actor: actorOf(), body: validBody(harness.paymentId, amount) }, harness.dependencies),
      code,
      rule,
      `an amount of ${amount} is refused`,
    );
  }

  await expectRefusal(
    () =>
      requestRefund(
        { actor: actorOf(), body: { ...validBody(harness.paymentId), reason: "   " } },
        harness.dependencies,
      ),
    "VALIDATION_FAILED",
    REFUND_RULES.reasonInvalid,
    "and an empty reason is refused",
  );

  const requested = await requestRefund(
    { actor: actorOf(), body: validBody(harness.paymentId, "200.00") },
    harness.dependencies,
  );

  expectEqual(requested.status, "requested", "a request starts as requested");
  expectEqual(requested.amountMinor, "2000000", "with the amount it asked for");
  expectEqual(requested.amountText, "200.0000 USD", "printed for a person");
  expectEqual(requested.currency, "USD", "in the payment's own currency");
  expectEqual(requested.requestedBy, ownerUserId, "naming the person who raised it");
  expectEqual(requested.approvedBy, null, "and nobody has decided it yet");
  expectEqual(requested.decidedAt, null, "so there is no decision instant");
  expectEqual(requested.platformFeeReturned, false, "the platform fee rule is STEP 193's, so nothing is returned yet");
  expectEqual(requested.platformFeeReturnedMinor, "0", "and no fee amount is written");
  expectEqual(harness.fixture.refunds.length, 1, "one row was written");
  expectEqual(
    harness.fixture.payments[0]?.["refunded_minor"],
    "0",
    "and the payment's refunded total is untouched, because only the database's sync writes it",
  );

  expectEqual(actionsOf(harness.audit)[0], REFUND_REQUESTED_AUDIT_ACTION, "the request leaves one chain entry");
  expect(
    harness.audit.entries.every((entry) => entry.entityType === REFUND_AUDIT_ENTITY),
    "and every entry is filed under the refund entity",
  );
  const requestPayload = payloadOf(harness.audit, REFUND_REQUESTED_AUDIT_ACTION);
  expectEqual(requestPayload?.["payment_id"], harness.paymentId, "which names the payment");
  expectEqual(requestPayload?.["amount_minor"], "2000000", "and the amount");
  expectEqual(requestPayload?.["reason_length"], 22, "and that there was a reason, without copying it");
  expect(
    typeof requestPayload?.["reason"] === "undefined",
    "the merchant's own words stay on the row",
  );

  // -------------------------------------------------------------------------------------------
  // 4. The headroom counts promises, not only decisions
  // -------------------------------------------------------------------------------------------
  const promiseHarness = harnessOf();

  await requestRefund(
    { actor: actorOf(), body: validBody(promiseHarness.paymentId, "3000.00") },
    promiseHarness.dependencies,
  );

  await expectRefusal(
    () =>
      requestRefund(
        { actor: actorOf(), body: validBody(promiseHarness.paymentId, "8000.00") },
        promiseHarness.dependencies,
      ),
    "VALIDATION_FAILED",
    REFUND_RULES.exceedsRefundable,
    "a second request cannot promise more than the first left",
  );

  const beforeSecond = await listRefundablePayments({ actor: actorOf() }, promiseHarness.dependencies);

  expectEqual(beforeSecond[0]?.remainingMinor, "70000000", "the list prints the headroom the first request left");

  const second = await requestRefund(
    { actor: actorOf(), body: validBody(promiseHarness.paymentId, "7000.00") },
    promiseHarness.dependencies,
  );

  expectEqual(second.status, "requested", "while the rest of the payment can still be asked for");

  const paymentsView = await listRefundablePayments({ actor: actorOf() }, promiseHarness.dependencies);

  expectEqual(paymentsView.length, 0, "and a payment with nothing left is filtered out of the list");

  // One payment can be in both states at once - a decided refund and a request waiting on the same money -
  // and the headroom must count each of them once and not twice.
  const mixedCapHarness = harnessOf();
  const decidedPart = await requestRefund(
    { actor: actorOf(), body: validBody(mixedCapHarness.paymentId, "2000.00") },
    mixedCapHarness.dependencies,
  );

  await decideRefund(
    { actor: deskActor(), refundId: decidedPart.id, body: { decision: "approve" } },
    mixedCapHarness.dependencies,
  );

  await requestRefund(
    { actor: actorOf(), body: validBody(mixedCapHarness.paymentId, "3000.00") },
    mixedCapHarness.dependencies,
  );

  const mixedHeadroom = await listRefundablePayments({ actor: actorOf() }, mixedCapHarness.dependencies);

  expectEqual(
    mixedHeadroom[0]?.remainingMinor,
    "50000000",
    "held money and promised money are each counted once in the headroom",
  );

  // -------------------------------------------------------------------------------------------
  // 5. Deciding: the desk, four eyes, and the re-check
  // -------------------------------------------------------------------------------------------
  const decisionHarness = harnessOf();
  const requested2 = await requestRefund(
    { actor: actorOf(), body: validBody(decisionHarness.paymentId, "200.00") },
    decisionHarness.dependencies,
  );

  for (const role of ["owner", "support", "compliance_kyc"] as const) {
    await expectRefusal(
      () =>
        decideRefund(
          { actor: actorOf({ roles: [role] }), refundId: requested2.id, body: { decision: "approve" } },
          decisionHarness.dependencies,
        ),
      "PERMISSION_DENIED",
      "",
      `a ${role} cannot decide a refund`,
    );
  }

  await expectRefusal(
    () =>
      decideRefund(
        { actor: deskActor(), refundId: randomUUID(), body: { decision: "approve" } },
        decisionHarness.dependencies,
      ),
    "RESOURCE_NOT_FOUND",
    REFUND_RULES.refundNotFound,
    "a refund that does not exist is not found",
  );

  await expectRefusal(
    () =>
      decideRefund(
        { actor: deskActor("finance_ops", ownerUserId), refundId: requested2.id, body: { decision: "approve" } },
        decisionHarness.dependencies,
      ),
    "CONFLICT",
    REFUND_RULES.selfDecision,
    "the person who raised it cannot decide it, even holding the desk role",
  );

  const approved = await decideRefund(
    { actor: deskActor(), refundId: requested2.id, body: { decision: "approve", note: "Checked the return" } },
    decisionHarness.dependencies,
  );

  expectEqual(approved.status, "approved", "the desk approves the refund");
  expectEqual(approved.approvedBy, financeUserId, "naming the person who did it");
  expect(approved.decidedAt !== null, "and the instant they decided");
  expectEqual(approved.processedAt, null, "without processing it, which is STEP 192's");
  expectEqual(approved.providerRefundId, null, "and without a provider identifier");

  expectEqual(actionsOf(decisionHarness.audit)[1], REFUND_APPROVED_AUDIT_ACTION, "the decision leaves one entry");
  const approvePayload = payloadOf(decisionHarness.audit, REFUND_APPROVED_AUDIT_ACTION);
  expectEqual(approvePayload?.["status_before"], "requested", "which names the status it moved from");
  expectEqual(approvePayload?.["status_after"], "approved", "and the status it moved to");
  expectEqual(approvePayload?.["note_present"], true, "and whether the desk wrote a note");
  expect(typeof approvePayload?.["note"] === "undefined", "without copying the note itself");

  await expectRefusal(
    () =>
      decideRefund(
        { actor: deskActor("super_admin"), refundId: requested2.id, body: { decision: "approve" } },
        decisionHarness.dependencies,
      ),
    "CONFLICT",
    REFUND_RULES.refundNotPending,
    "a refund already decided cannot be decided again",
  );

  // A decision that lost the race: another desk member moved the row between this caller's read and its
  // write. The guarded update matches nothing, the read-back shows a version that is not this caller's, and
  // the caller is told the refund moved - not handed a row somebody else decided.
  const raceHarness2 = harnessOf();
  const racing = await requestRefund(
    { actor: actorOf(), body: validBody(raceHarness2.paymentId, "10.00") },
    raceHarness2.dependencies,
  );

  raceHarness2.fixture.beforeUpdate = (table): void => {
    if (table !== "refunds") {
      return;
    }

    const row = raceHarness2.fixture.refunds[0];

    if (row === undefined) {
      return;
    }

    row["status"] = "approved";
    row["approved_by"] = otherFinanceUserId;
    row["decided_at"] = new Date(startedAtMs).toISOString();
    row["version"] = Number(row["version"]) + 1;
  };

  const chainBefore = raceHarness2.audit.entries.length;

  await expectRefusal(
    () =>
      decideRefund(
        { actor: deskActor("super_admin"), refundId: racing.id, body: { decision: "approve" } },
        raceHarness2.dependencies,
      ),
    "CONFLICT",
    REFUND_RULES.refundMoved,
    "a decision that another decision beat is told the refund moved",
  );

  expectEqual(
    raceHarness2.audit.entries.length,
    chainBefore,
    "and the loser writes no chain entry claiming a decision it did not make",
  );

  const survivor = await readRefund({ actor: deskActor(), refundId: racing.id }, raceHarness2.dependencies);

  expectEqual(survivor.status, "approved", "the row keeps the decision that actually landed");
  expectEqual(survivor.approvedBy, otherFinanceUserId, "and the approver it landed with");
  expect(survivor.approvedBy !== financeUserId, "which is not the caller whose read the row moved under");

  // A rejection is a cancelled row, because `0038` gives a refused refund no other home.
  const rejectHarness = harnessOf();
  const toReject = await requestRefund(
    { actor: actorOf(), body: validBody(rejectHarness.paymentId, "150.00") },
    rejectHarness.dependencies,
  );
  const rejected = await decideRefund(
    { actor: deskActor("super_admin"), refundId: toReject.id, body: { decision: "reject", note: "Outside the policy" } },
    rejectHarness.dependencies,
  );

  expectEqual(rejected.status, "cancelled", "a rejection is a cancelled refund");
  expectEqual(rejected.approvedBy, null, "with nobody recorded as its approver");
  expectEqual(rejected.decidedAt, null, "and no decision instant, which `0038` requires");
  expectEqual(actionsOf(rejectHarness.audit)[1], REFUND_REJECTED_AUDIT_ACTION, "and its own chain action");

  const rejectPayload = payloadOf(rejectHarness.audit, REFUND_REJECTED_AUDIT_ACTION);
  expectEqual(rejectPayload?.["decision"], "reject", "which says it was a rejection");
  expectEqual(rejectPayload?.["recorded_as"], "cancelled", "and how the row records one");

  // The cap is re-checked at the decision, because two requests can each fit an empty payment.
  const raceHarness = harnessOf();
  const firstHalf = await requestRefund(
    { actor: actorOf(), body: validBody(raceHarness.paymentId, "6000.00") },
    raceHarness.dependencies,
  );

  // An approval that landed between this request and this decision: the same payment, the same amount,
  // decided by another desk member a moment ago. The service's own reads cannot promise past the headroom,
  // so the re-check at the decision is exercised with the row such a race would leave behind.
  await raceHarness.dependencies.rest.insertReturning(
    "refunds",
    [
      {
        company_id: companyId,
        payment_id: raceHarness.paymentId,
        amount_minor: "60000000",
        currency: "USD",
        status: "approved",
        reason: "Approved while this one waited",
        requested_by: otherOwnerUserId,
        approved_by: financeUserId,
        decided_at: new Date(startedAtMs).toISOString(),
      },
    ],
    z.looseObject({}),
  );

  await expectRefusal(
    () =>
      decideRefund(
        { actor: deskActor("super_admin"), refundId: firstHalf.id, body: { decision: "approve" } },
        raceHarness.dependencies,
      ),
    "CONFLICT",
    REFUND_RULES.exceedsRefundable,
    "an approval that no longer fits is refused at the decision, not discovered at the database",
  );

  // -------------------------------------------------------------------------------------------
  // 6. Cancelling: the merchant's own, while it is still pending
  // -------------------------------------------------------------------------------------------
  const cancelHarness = harnessOf();
  const toCancel = await requestRefund(
    { actor: actorOf(), body: validBody(cancelHarness.paymentId, "40.00") },
    cancelHarness.dependencies,
  );

  await expectRefusal(
    () =>
      cancelRefund(
        { actor: actorOf({ companyId: otherCompanyId, userId: otherOwnerUserId }), refundId: toCancel.id },
        cancelHarness.dependencies,
      ),
    "RESOURCE_NOT_FOUND",
    REFUND_RULES.refundNotFound,
    "another merchant cannot cancel it",
  );

  await expectRefusal(
    () => cancelRefund({ actor: actorOf({ roles: ["support"] }), refundId: toCancel.id }, cancelHarness.dependencies),
    "PERMISSION_DENIED",
    "",
    "and a member of staff cannot either",
  );

  const cancelled = await cancelRefund({ actor: actorOf(), refundId: toCancel.id }, cancelHarness.dependencies);

  expectEqual(cancelled.status, "cancelled", "the merchant withdraws their own request");
  expectEqual(actionsOf(cancelHarness.audit)[1], REFUND_CANCELLED_AUDIT_ACTION, "and it leaves one entry");
  expectEqual(
    payloadOf(cancelHarness.audit, REFUND_CANCELLED_AUDIT_ACTION)?.["by"],
    "merchant",
    "which says who withdrew it",
  );

  await expectRefusal(
    () =>
      decideRefund(
        { actor: deskActor(), refundId: toCancel.id, body: { decision: "approve" } },
        cancelHarness.dependencies,
      ),
    "CONFLICT",
    REFUND_RULES.refundNotPending,
    "a withdrawn request cannot be approved afterwards",
  );

  await expectRefusal(
    () => cancelRefund({ actor: actorOf(), refundId: toCancel.id }, cancelHarness.dependencies),
    "CONFLICT",
    REFUND_RULES.refundNotPending,
    "and it cannot be withdrawn twice",
  );

  // Withdrawing frees the promise again.
  const again = await requestRefund(
    { actor: actorOf(), body: validBody(cancelHarness.paymentId, "100.00") },
    cancelHarness.dependencies,
  );

  expectEqual(again.status, "requested", "and the headroom it held is free again");

  // -------------------------------------------------------------------------------------------
  // 7. Reading: the merchant's list, the platform's queue, one row
  // -------------------------------------------------------------------------------------------
  const listHarness = harnessOf();
  const first = await requestRefund(
    { actor: actorOf(), body: validBody(listHarness.paymentId, "10.00") },
    listHarness.dependencies,
  );
  const secondRequest = await requestRefund(
    { actor: actorOf(), body: validBody(listHarness.paymentId, "20.00") },
    listHarness.dependencies,
  );

  // A refund belonging to another merchant, written straight into the table: the reads that follow must not
  // show it to this one, whether the scope is a filter this module writes or one it forgets to write.
  const foreignRefundId = randomUUID();

  listHarness.fixture.refunds.push({
    id: foreignRefundId,
    company_id: otherCompanyId,
    payment_id: randomUUID(),
    amount_minor: "50000",
    currency: "USD",
    status: "requested",
    reason: "Somebody else's refund",
    requested_by: otherOwnerUserId,
    approved_by: null,
    decided_at: null,
    processed_at: null,
    provider_refund_id: null,
    platform_fee_returned: false,
    platform_fee_returned_minor: "0",
    failure_detail: null,
    created_at: new Date(startedAtMs + 1_500).toISOString(),
    updated_at: new Date(startedAtMs + 1_500).toISOString(),
    version: 1,
  });

  const listed = await listRefunds({ actor: actorOf() }, listHarness.dependencies);

  expectEqual(listed.length, 2, "a merchant sees its own refunds and no others");
  expectEqual(listed[0]?.id, secondRequest.id, "newest first");
  expectEqual(listed[1]?.id, first.id, "then the older one");
  expect(
    listed.every((row) => row.companyId === companyId),
    "no row in a merchant's list belongs to another merchant",
  );

  await expectRefusal(
    () => readRefund({ actor: actorOf(), refundId: foreignRefundId }, listHarness.dependencies),
    "RESOURCE_NOT_FOUND",
    REFUND_RULES.refundNotFound,
    "and another merchant's refund cannot be read by its id either",
  );

  await expectRefusal(
    () => cancelRefund({ actor: actorOf(), refundId: foreignRefundId }, listHarness.dependencies),
    "RESOURCE_NOT_FOUND",
    REFUND_RULES.refundNotFound,
    "nor withdrawn",
  );

  await expectRefusal(
    () => listRefunds({ actor: actorOf({ roles: ["support"] }) }, listHarness.dependencies),
    "PERMISSION_DENIED",
    "",
    "and a member of staff cannot read them",
  );

  await expectRefusal(
    () => listRefundQueue({ actor: actorOf() }, listHarness.dependencies),
    "PERMISSION_DENIED",
    "",
    "the platform queue is not a merchant's list",
  );

  const queue = await listRefundQueue({ actor: deskActor() }, listHarness.dependencies);

  expectEqual(queue.length, 3, "the desk sees every open refund, every merchant's");
  expectEqual(queue[0]?.id, first.id, "oldest first, because it is a queue");
  expectEqual(queue[1]?.id, foreignRefundId, "the other merchant's request is in the same queue");

  await decideRefund(
    { actor: deskActor(), refundId: first.id, body: { decision: "approve" } },
    listHarness.dependencies,
  );

  const queueAfter = await listRefundQueue({ actor: deskActor() }, listHarness.dependencies);

  expectEqual(queueAfter.length, 3, "an approved refund is still somebody's work");

  await cancelRefund({ actor: actorOf(), refundId: secondRequest.id }, listHarness.dependencies);

  const queueSettled = await listRefundQueue({ actor: deskActor() }, listHarness.dependencies);

  expectEqual(queueSettled.length, 2, "a refund decided against has left the queue");
  expectEqual(
    queueSettled.some((row) => row.status === "cancelled" || row.status === "failed"),
    false,
    "the queue holds no refund nobody has to look at",
  );

  const own = await readRefund({ actor: actorOf(), refundId: secondRequest.id }, listHarness.dependencies);

  expectEqual(own.id, secondRequest.id, "a merchant can read its own refund");

  await expectRefusal(
    () =>
      readRefund(
        { actor: actorOf({ companyId: otherCompanyId, userId: otherOwnerUserId }), refundId: secondRequest.id },
        listHarness.dependencies,
      ),
    "RESOURCE_NOT_FOUND",
    REFUND_RULES.refundNotFound,
    "and not another merchant's",
  );

  const deskRead = await readRefund({ actor: deskActor("super_admin"), refundId: secondRequest.id }, listHarness.dependencies);

  expectEqual(deskRead.id, secondRequest.id, "while the desk can read any of them");

  // -------------------------------------------------------------------------------------------
  // 8. What the payment list offers, and what it refuses to offer
  // -------------------------------------------------------------------------------------------
  const listPaymentsHarness = harnessOf();
  const offered = await listRefundablePayments({ actor: actorOf() }, listPaymentsHarness.dependencies);

  expectEqual(offered.length, 1, "a captured payment is offered");
  expectEqual(offered[0]?.remainingMinor, "100000000", "with its whole amount as headroom");
  expectEqual(offered[0]?.remainingText, "10000.0000 USD", "printed for a person");

  await requestRefund(
    { actor: actorOf(), body: validBody(listPaymentsHarness.paymentId, "10000.00") },
    listPaymentsHarness.dependencies,
  );

  const afterFullRequest = await listRefundablePayments({ actor: actorOf() }, listPaymentsHarness.dependencies);

  expectEqual(afterFullRequest.length, 0, "and it is withdrawn from the list once the whole is asked for");

  // A payment that was never captured is not offered at all: the list is the states a refund starts from,
  // and the service's own request would refuse the rest.
  const mixedFixture = createFixture([
    paymentRow({ status: "pending" }),
    paymentRow({ status: "settled" }),
    paymentRow({ status: "failed" }),
    paymentRow({ status: "refunded" }),
    paymentRow({ status: "settled", company_id: otherCompanyId }),
  ]);
  const mixedAudit = createInMemoryAuditTrail();
  const mixed = await listRefundablePayments(
    { actor: actorOf() },
    { rest: mixedFixture.rest, audit: mixedAudit, now: () => startedAtMs },
  );

  expectEqual(mixed.length, 1, "only the merchant's own captured or settled payment is offered");
  expectEqual(mixed[0]?.status, "settled", "which is the settled one");

  // -------------------------------------------------------------------------------------------
  // 9. The files: boundaries, and the migration this STEP does not need
  // -------------------------------------------------------------------------------------------
  const serviceRoot = new URL("./", import.meta.url);
  const serviceSource = await readFile(new URL("refund.ts", serviceRoot), "utf8");
  const fieldsSource = await readFile(new URL("refund-fields.ts", serviceRoot), "utf8");
  const runtimeSource = await readFile(new URL("refund-runtime.ts", serviceRoot), "utf8");
  const requestRoute = await readFile(new URL("../../app/api/payments/refunds/route.ts", serviceRoot), "utf8");
  const cancelRoute = await readFile(new URL("../../app/api/payments/refunds/[id]/cancel/route.ts", serviceRoot), "utf8");
  const paymentsRoute = await readFile(new URL("../../app/api/payments/route.ts", serviceRoot), "utf8");
  const queueRoute = await readFile(new URL("../../app/api/office/refunds/route.ts", serviceRoot), "utf8");
  const decisionRoute = await readFile(
    new URL("../../app/api/office/refunds/[id]/decision/route.ts", serviceRoot),
    "utf8",
  );
  const refundsMigration = await readFile(new URL("../../migrations/0038_refunds.sql", serviceRoot), "utf8");

  for (const [name, source] of [
    ["the request route", requestRoute],
    ["the cancel route", cancelRoute],
    ["the decision route", decisionRoute],
  ] as const) {
    expect(source.includes("requireCsrfToken("), `${name} checks the CSRF token`);
    expect(source.includes("\"cache-control\": \"no-store\""), `${name} answers no-store`);
    expect(source.includes("readRequestActor"), `${name} reads the actor rather than trusting a body`);
  }

  for (const [name, source] of [
    ["the payment list route", paymentsRoute],
    ["the queue route", queueRoute],
  ] as const) {
    expect(source.includes("\"cache-control\": \"no-store\""), `${name} answers no-store`);
    expect(source.includes("readRequestActor"), `${name} reads the actor`);
  }

  expect(!serviceSource.includes("fetch("), "the service calls no gateway: executing a refund is STEP 192's");
  expect(
    !serviceSource.includes('status: "processing"') &&
      !serviceSource.includes('status: "succeeded"') &&
      !serviceSource.includes('status: "failed"'),
    "and it writes no status the processor owns",
  );
  expectEqual(
    serviceSource.split("refunded_minor").length - 1,
    4,
    "it reads the payment's refunded total in three places, names it once in prose and writes it nowhere",
  );
  expect(
    serviceSource.includes("refund_guard_amount") || fieldsSource.includes("refunds_guard_amount"),
    "the cap the database enforces is named where it is relied on",
  );
  expect(runtimeSource.includes("getAuthRuntime"), "the runtime is a projection of the platform runtime");

  expect(
    refundsMigration.includes("create table public.refunds ("),
    "`0038` already carries the refund row",
  );
  expect(
    refundsMigration.includes("status in ('requested', 'approved', 'processing', 'succeeded', 'failed', 'cancelled')"),
    "with the six statuses this module words",
  );
  expect(
    refundsMigration.includes("constraint refunds_approval_check check ("),
    "and the approval constraint tying the approver to the status",
  );
  expect(
    refundsMigration.includes("constraint refunds_processed_check check ("),
    "the processing constraint tying the processor's instant to its two statuses",
  );
  expect(
    refundsMigration.includes("create function public.refunds_guard_amount()"),
    "the cap function",
  );
  expect(
    refundsMigration.includes("create function public.refunds_sync_payment()"),
    "and the payment sync that owns `payments.refunded_minor`",
  );
  expect(
    refundsMigration.includes("refunds_provider_required_check"),
    "a succeeded refund needs the provider's own identifier, which is STEP 192's to supply",
  );

  expect(
    decisionRoute.includes("requireTrustedDevice(") && decisionRoute.includes("verifySensitiveRequest("),
    "a decision authorises money, so its route demands a signed device proof over the exact bytes",
  );
  expect(
    !requestRoute.includes("requireTrustedDevice(") && !cancelRoute.includes("requireTrustedDevice("),
    "a request and a withdrawal move no money and ask for no device proof",
  );

  // -------------------------------------------------------------------------------------------
  // 10. The screens, and the words on them
  // -------------------------------------------------------------------------------------------
  const merchantPage = await readFile(
    new URL("../../app/(dashboard)/payments/refunds/page.tsx", serviceRoot),
    "utf8",
  );
  const merchantConsole = await readFile(
    new URL("../../app/(dashboard)/payments/refunds/refund-console.tsx", serviceRoot),
    "utf8",
  );
  const officePage = await readFile(new URL("../../app/(admin)/office/refunds/page.tsx", serviceRoot), "utf8");
  const officeForm = await readFile(
    new URL("../../app/(admin)/office/refunds/refund-decision-form.tsx", serviceRoot),
    "utf8",
  );
  const english = await readFile(new URL("../../lib/i18n/strings/en.ts", serviceRoot), "utf8");

  expect(merchantPage.includes("<RefundConsole />"), "the merchant page renders the console");
  expect(
    !merchantConsole.includes("@/services/"),
    "the console is a client component, so it imports no server module",
  );
  expect(
    merchantConsole.includes("csrfHeaders()"),
    "every write from the console carries a CSRF token",
  );
  expect(
    merchantConsole.includes("/api/payments/refunds") && merchantConsole.includes("/cancel`"),
    "the console talks to the two merchant routes",
  );
  expect(
    !merchantConsole.includes("window.confirm") && !merchantConsole.includes("alert("),
    "a withdrawal is confirmed inline, in two steps, rather than by a browser dialog",
  );
  expect(
    officePage.includes("listRefundQueue") && officePage.includes("<RefundDecisionForm"),
    "the office page reads the queue and offers the decision form on the rows that still need one",
  );
  expect(
    officeForm.includes('deviceProofHeaders("POST", path, payload)'),
    "the decision form signs the exact bytes it sends",
  );

  const usedKeys = new Set<string>();

  for (const source of [merchantConsole, officePage, officeForm, merchantPage]) {
    for (const match of source.matchAll(/getMessage\("(refunds\.[a-zA-Z]+)"\)/gu)) {
      if (typeof match[1] === "string") {
        usedKeys.add(match[1]);
      }
    }
  }

  expect(usedKeys.size >= 25, "the two screens use the refund vocabulary rather than hard-coded prose");

  for (const key of usedKeys) {
    const leaf = key.slice("refunds.".length);

    expect(
      new RegExp(`\\n\\s{4}${leaf}:`, "u").test(english),
      `the catalog carries ${key}`,
    );
  }

  expect(
    !merchantConsole.includes("provider_refund_id") && !/providerRefundId\s*:/.test(merchantConsole),
    "the merchant screen reads no processor identifier into a field of its own",
  );
  expect(
    merchantConsole.includes('case "processing":') && merchantConsole.includes('case "succeeded":'),
    "it prints the statuses the processor writes, and writes none of them",
  );

  const migrations = (await readdir(new URL("../../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name) && !name.endsWith(".down.sql"))
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .sort((left, right) => left - right);

  // The head is now STEP 196's `0125_dispute_deadline_warnings`; 124 was STEP 195's and 123 was this STEP's own
  // `0123_refund_fee_rule`. This STEP still owns no migration: `0038` carries the whole lifecycle.
  expectEqual(
    migrations[migrations.length - 1] ?? 0,
    125,
    "this STEP adds no migration, because `0038` already carries the whole lifecycle",
  );

  if (failures.length > 0) {
    process.stdout.write(`refund gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `refund gate passed: ${String(checkCount)} checks, a refund raised by the merchant that owns the payment, the headroom counting promises as well as decisions, a decision by the finance desk and never by the requester, a rejection recorded as cancelled, every act in the chain, no gateway call and no migration needed\n`,
  );
}

await main();
