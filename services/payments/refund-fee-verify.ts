// path: services/payments/refund-fee-verify.ts
import process from "node:process";
import { readFile, readdir } from "node:fs/promises";
import type { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { InMemoryLedgerEntryStore, type LedgerEntry } from "../../lib/payments/ledger-posting.ts";
import { SETTING_KEY_PATTERN } from "../../lib/settings/registry.ts";
import {
  REFUND_FEE_AUDIT_ACTIONS,
  REFUND_FEE_BACKLOG_LIMIT,
  REFUND_FEE_RETAINED_AUDIT_ACTION,
  REFUND_FEE_RETURNED_AUDIT_ACTION,
  REFUND_FEE_RULE_DEFAULT,
  REFUND_FEE_RULE_KEY,
  REFUND_FEE_RULE_UPDATED_AUDIT_ACTION,
  REFUND_FEE_RULES,
  REFUND_FEE_SETTLED_STATUS,
  REFUND_FEE_SWEEP_LIMIT,
  feeReturnGroupIdOf,
  feeReturnPlanOf,
  feeShareOf,
  isFeeReturnGroupId,
} from "./refund-fee-fields.ts";
import {
  REFUND_FEE_RULE_ROLES,
  REFUND_FEE_SCREEN_ROLES,
  applyRefundFeeReturn,
  readRefundFeeBacklog,
  readRefundFeeRule,
  saveRefundFeeRule,
  sweepRefundFeeReturns,
  type RefundFeeDependencies,
} from "./refund-fee.ts";

/**
 * The gate for STEP 193: the platform fee on a refund, applied from the super administrator's setting.
 *
 * ## What this proves
 *
 *   - **The proportion is a proportion.** A part refund returns its share of the fee and no more; the refund that
 *     completes a payment returns the remainder, so a payment refunded in full gives the whole fee back exactly -
 *     no part over-returns and no fee is left behind as rounding dust.
 *   - **The answer is recorded once.** A succeeded refund carries `platform_fee_settled_at` from the first pass
 *     that looked at it, and a second pass changes nothing: no second write, no second ledger group, no second
 *     chain entry. The switch being closed is an answer too, and it is recorded rather than re-asked.
 *   - **The ledger is the money and the row is the record.** A return posts one balanced pair - fee income debited,
 *     merchant payable credited - under a group id derived from the refund, so a retry finds the group instead of
 *     posting a second one and records the amount that was actually posted.
 *   - **The switch is the super administrator's**, written with the version it was read at, audited, and refused
 *     to everybody else; a save that changes nothing writes nothing.
 *   - **A merchant cannot reach any of it**: the sweep and the single application require the refund desk's role,
 *     and the bulk pass requires a fresh second factor.
 *   - **Nothing writes a payment.** The refunded total stays `refunds_sync_payment`'s, exactly as `0037` says.
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
// A PostgREST over arrays, with `0038`'s refund checks and `0123`'s two new ones on it.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const financeUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const superUserId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ownerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const paymentId = "5f000000-0000-4000-8000-000000000001";
const refundOneId = "8b000000-0000-4000-8000-000000000001";
const refundTwoId = "8b000000-0000-4000-8000-000000000002";
const refundThreeId = "8b000000-0000-4000-8000-000000000003";
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
    // A second factor proved a minute ago, which is inside `STEP_UP_WINDOW_MS`: the section 18 write and the
    // bulk pass both ask for it, and the stale cases below take it away.
    mfaVerifiedAtEpochMs: null,
    reauthenticatedAtEpochMs: startedAtMs - 60_000,
    ...overrides,
  } as RequestActor;
}

function deskActor(): RequestActor {
  return actorOf();
}

/** The section 18 role, which is also the only account that may answer the question. */
function superActor(): RequestActor {
  return actorOf({ userId: superUserId, roles: ["super_admin"] });
}

interface Query {
  readonly equals: Map<string, string>;
  readonly notEquals: Map<string, string>;
  readonly nulls: Set<string>;
  readonly order: { readonly column: string; readonly direction: "asc" | "desc" } | null;
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const notEquals = new Map<string, string>();
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

      continue;
    }

    if (value.startsWith("neq.")) {
      notEquals.set(key, value.slice(4));
    }
  }

  return { equals, notEquals, nulls, order, limit };
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
  readonly settings: Row[];
  /** Every write a caller made to `payments`, so the gate can prove this STEP wrote none. */
  readonly paymentWrites: Row[];
  /** Set to make the next refund update fail the way a lost race does. */
  failNextRefundUpdate: boolean;
}

/**
 * The refund row rules this STEP can break, enforced by the fixture rather than by an assertion.
 *
 * `0038`'s `refunds_platform_fee_check` and `0123`'s two constraints are here because a service that wrote
 * `platform_fee_returned_minor` without the flag, or the flag without an instant, would otherwise pass.
 */
function guardRefund(row: Row): void {
  const returned = row["platform_fee_returned"] === true;
  const minor = BigInt(String(row["platform_fee_returned_minor"] ?? "0"));
  const settled = row["platform_fee_settled_at"] ?? null;

  if (minor < 0n || (returned ? false : minor !== 0n)) {
    throw new AppError("CONFLICT", { details: [{ field: "platform_fee", rule: "refund_platform_fee" }] });
  }

  if (returned && (settled === null || minor === 0n)) {
    throw new AppError("CONFLICT", { details: [{ field: "platform_fee", rule: "refund_platform_fee_answered" }] });
  }

  if (settled !== null) {
    if (row["status"] !== "succeeded") {
      throw new AppError("CONFLICT", {
        details: [{ field: "platform_fee_settled_at", rule: "refund_platform_fee_settled" }],
      });
    }

    if (typeof settled !== "string" || Date.parse(settled) < Date.parse(String(row["created_at"]))) {
      throw new AppError("CONFLICT", {
        details: [{ field: "platform_fee_settled_at", rule: "refund_platform_fee_settled" }],
      });
    }
  }
}

function createFixture(input: {
  readonly payments?: readonly Row[];
  readonly refunds?: readonly Row[];
  readonly settings?: readonly Row[];
} = {}): Fixture {
  const table = {
    refunds: [...(input.refunds ?? [])],
    payments: [...(input.payments ?? [paymentRow()])],
    settings: [...(input.settings ?? [])],
  };
  const paymentWrites: Row[] = [];
  let writeCount = 0;

  const rowsOf = (name: string): Row[] => {
    if (name === "refunds") {
      return table.refunds;
    }

    if (name === "payments") {
      return table.payments;
    }

    if (name === "platform_settings") {
      return table.settings;
    }

    throw new AppError("DEPENDENCY_FAILED");
  };

  const fixture: Fixture = {
    rest: {
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
          writeCount += 1;

          rowsOf(name).push({
            id: `setting-${String(writeCount).padStart(4, "0")}`,
            created_at: new Date(startedAtMs).toISOString(),
            updated_at: new Date(startedAtMs).toISOString(),
            version: 1,
            deleted_at: null,
            ...row,
          });
        }
      },

      async insertReturning<TRow>(
        _name: string,
        _rows: readonly Row[],
        schema: z.ZodType<TRow>,
      ): Promise<readonly TRow[]> {
        return schema.array().parse([]);
      },

      async update(name: string, query: string, values: Row): Promise<void> {
        const parsed = parseQuery(query);

        for (const row of rowsOf(name).filter((candidate) => matches(candidate, parsed))) {
          if (name === "payments") {
            paymentWrites.push({ ...values });
          }

          if (name === "refunds" && fixture.failNextRefundUpdate) {
            fixture.failNextRefundUpdate = false;

            // PostgREST reports a zero-row update as success, and the service's read-back is what notices.
            continue;
          }

          Object.assign(row, { ...values });

          if (name === "refunds") {
            guardRefund(row);
            row["version"] = Number(row["version"]) + 1;
            row["updated_at"] = new Date(startedAtMs + 1_000).toISOString();
          }

          if (name === "platform_settings") {
            row["version"] = Number(row["version"]) + 1;
            row["updated_at"] = new Date(startedAtMs + 1_000).toISOString();
          }
        }
      },

      async rpc(): Promise<unknown> {
        throw new AppError("DEPENDENCY_FAILED");
      },
    },
    refunds: table.refunds,
    payments: table.payments,
    settings: table.settings,
    paymentWrites,
    failNextRefundUpdate: false,
  };

  for (const row of fixture.refunds) {
    guardRefund(row);
  }

  return fixture;
}

/** One payment: a hundred dollars, of which the platform's fee is two dollars and ninety cents. */
function paymentRow(overrides: Row = {}): Row {
  return {
    id: paymentId,
    company_id: companyId,
    amount_minor: "1000000",
    currency: "USD",
    status: "captured",
    refunded_minor: "0",
    platform_fee_minor: "29000",
    deleted_at: null,
    created_at: new Date(startedAtMs - 86_400_000).toISOString(),
    ...overrides,
  };
}

/** One succeeded refund of that payment, with no fee answer yet. */
function refundRow(overrides: Row = {}): Row {
  return {
    id: refundOneId,
    company_id: companyId,
    payment_id: paymentId,
    amount_minor: "250000",
    currency: "USD",
    status: "succeeded",
    reason: "Customer returned the order",
    requested_by: ownerUserId,
    approved_by: financeUserId,
    decided_at: new Date(startedAtMs - 7_200_000).toISOString(),
    processed_at: new Date(startedAtMs - 3_600_000).toISOString(),
    provider_refund_id: "nmi-refund-0001",
    platform_fee_returned: false,
    platform_fee_returned_minor: "0",
    platform_fee_settled_at: null,
    failure_detail: null,
    created_at: new Date(startedAtMs - 86_400_000).toISOString(),
    updated_at: new Date(startedAtMs - 3_600_000).toISOString(),
    version: 3,
    deleted_at: null,
    ...overrides,
  };
}

/** One `platform_settings` row, as `0123` seeds it or as the screen writes it. */
function settingRow(value: unknown, overrides: Row = {}): Row {
  return {
    id: "setting-0000",
    company_id: null,
    setting_key: REFUND_FEE_RULE_KEY,
    value,
    is_secret: false,
    updated_by: null,
    created_at: new Date(startedAtMs).toISOString(),
    updated_at: new Date(startedAtMs - 60_000).toISOString(),
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

interface Harness {
  readonly fixture: Fixture;
  readonly audit: InMemoryAuditTrail;
  readonly ledger: InMemoryLedgerEntryStore | null;
  readonly dependencies: RefundFeeDependencies;
}

function harnessOf(input: {
  readonly payments?: readonly Row[];
  readonly refunds?: readonly Row[];
  readonly settings?: readonly Row[];
  readonly ledger?: boolean;
} = {}): Harness {
  const fixture = createFixture(input);
  const audit = createInMemoryAuditTrail();
  const ledger = input.ledger === false ? null : new InMemoryLedgerEntryStore();

  return {
    fixture,
    audit,
    ledger,
    dependencies: {
      rest: fixture.rest,
      audit,
      ledger,
      now: (): number => startedAtMs,
    },
  };
}

/** Write the refunded total the way `refunds_sync_payment` would, and say so if the payment is missing. */
function setRefundedTotal(payment: Row | undefined, value: string): void {
  if (payment === undefined) {
    expect(false, "the fixture holds the payment being refunded");
    return;
  }

  payment["refunded_minor"] = value;
}

/** Every entry an in-memory ledger store holds, in group order. */
function entriesOf(store: InMemoryLedgerEntryStore): readonly LedgerEntry[] {
  return store.listGroupIds().flatMap((groupId) => store.findByGroup(groupId));
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------------------------
  // 1. The vocabulary
  // -------------------------------------------------------------------------------------------
  const rules = Object.values(REFUND_FEE_RULES);

  expectEqual(new Set(rules).size, rules.length, "every rule code is distinct");
  expect(
    rules.every((rule) => /^[a-z][a-z0-9_]*$/u.test(rule)),
    "and every one is lower snake case, which is the alphabet the error envelope uses",
  );
  expect(
    REFUND_FEE_AUDIT_ACTIONS.every((action) => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u.test(action)),
    "every audit action is dotted lower case, the alphabet `audit_log.action` accepts",
  );
  expectEqual(REFUND_FEE_AUDIT_ACTIONS.length, 3, "three actions: the rule, and its two answers");
  expect(
    SETTING_KEY_PATTERN.test(REFUND_FEE_RULE_KEY),
    "the setting key is one `platform_settings_key_check` accepts",
  );
  expectEqual(REFUND_FEE_RULE_DEFAULT, false, "the default keeps the platform's fee");
  expectEqual(REFUND_FEE_SETTLED_STATUS, "succeeded", "the rule applies to money that went back");
  expectEqual(REFUND_FEE_SWEEP_LIMIT, 50, "a pass is bounded at fifty refunds");
  expectEqual(REFUND_FEE_BACKLOG_LIMIT, 100, "and the screen counts a hundred before it says \"at least\"");
  expectEqual(REFUND_FEE_RULE_ROLES.length, 1, "one role answers the question");
  expectEqual(REFUND_FEE_RULE_ROLES[0], "super_admin", "and it is the super administrator, as section 18 says");
  expectEqual(REFUND_FEE_SCREEN_ROLES.length, 2, "two roles read it: the desk and the super administrator");

  // The group id: derived from the refund, the same every time, and a UUID the ledger accepts.
  const groupId = feeReturnGroupIdOf(refundOneId);

  expectEqual(groupId, feeReturnGroupIdOf(refundOneId), "the ledger group of a refund is the same group every run");
  expect(isFeeReturnGroupId(groupId), "and it is a version 5 UUID the ledger's column accepts");
  expect(groupId !== feeReturnGroupIdOf(refundTwoId), "two refunds never share a group");

  // The share: integer arithmetic, rounded down, never above the fee.
  expectEqual(feeShareOf(29000n, 250000n, 1000000n), 7250n, "a quarter of the payment returns a quarter of the fee");
  expectEqual(feeShareOf(29000n, 1000000n, 1000000n), 29000n, "the whole payment returns the whole fee");
  expectEqual(feeShareOf(29000n, 1n, 1000000n), 0n, "a part too small to reach a minor unit returns nothing");
  expectEqual(feeShareOf(0n, 250000n, 1000000n), 0n, "a payment with no fee has nothing to return");
  expectEqual(feeShareOf(29000n, 250000n, 0n), 0n, "and a payment of zero is answered without dividing by it");

  // -------------------------------------------------------------------------------------------
  // 2. The plan, before any row moves
  // -------------------------------------------------------------------------------------------
  const quarter = feeReturnPlanOf({
    feeMinor: 29000n,
    paymentMinor: 1000000n,
    refundedMinor: 250000n,
    refundMinor: 250000n,
    alreadyReturnedMinor: 0n,
  });

  expectEqual(quarter.returnMinor, 7250n, "a quarter refund returns a quarter of the fee");
  expectEqual(quarter.completes, false, "and does not complete the payment");
  expectEqual(quarter.rule, null, "so the rule returns money rather than an excuse");
  expectEqual(quarter.remainingMinor, 29000n, "with the whole fee still to account for");

  const completing = feeReturnPlanOf({
    feeMinor: 29000n,
    paymentMinor: 1000000n,
    refundedMinor: 1000000n,
    refundMinor: 500000n,
    alreadyReturnedMinor: 14500n,
  });

  expectEqual(completing.returnMinor, 14500n, "the refund that completes the payment takes the remainder");
  expectEqual(completing.completes, true, "because the payment's own refunded total says it is complete");
  expectEqual(
    quarter.returnMinor + completing.returnMinor,
    21750n,
    "which is not the whole fee for a half refunded payment: the other half is still the merchant's",
  );

  const exhausted = feeReturnPlanOf({
    feeMinor: 29000n,
    paymentMinor: 1000000n,
    refundedMinor: 1000000n,
    refundMinor: 250000n,
    alreadyReturnedMinor: 29000n,
  });

  expectEqual(exhausted.returnMinor, 0n, "a fee already returned is not returned twice");
  expectEqual(exhausted.rule, REFUND_FEE_RULES.feeExhausted, "and the rule says why");

  const noFee = feeReturnPlanOf({
    feeMinor: 0n,
    paymentMinor: 1000000n,
    refundedMinor: 250000n,
    refundMinor: 250000n,
    alreadyReturnedMinor: 0n,
  });

  expectEqual(noFee.rule, REFUND_FEE_RULES.feeZero, "a payment that carried no fee has an answer of nothing");

  const dust = feeReturnPlanOf({
    feeMinor: 29000n,
    paymentMinor: 1000000n,
    refundedMinor: 1n,
    refundMinor: 1n,
    alreadyReturnedMinor: 0n,
  });

  expectEqual(dust.rule, REFUND_FEE_RULES.shareZero, "and a share below one minor unit is nothing, not a rounding");
  expectEqual(dust.returnMinor, 0n, "with no money invented to make it a return");

  const invalidPayment = feeReturnPlanOf({
    feeMinor: 29000n,
    paymentMinor: 0n,
    refundedMinor: 0n,
    refundMinor: 0n,
    alreadyReturnedMinor: 0n,
  });

  expectEqual(invalidPayment.rule, REFUND_FEE_RULES.paymentInvalid, "a payment of zero is a defect, not a rule");

  const capped = feeReturnPlanOf({
    feeMinor: 29000n,
    paymentMinor: 1000000n,
    refundedMinor: 250000n,
    refundMinor: 250000n,
    alreadyReturnedMinor: 28000n,
  });

  expectEqual(capped.returnMinor, 1000n, "a part never returns more than what is left of the fee");

  // -------------------------------------------------------------------------------------------
  // 3. The switch
  // -------------------------------------------------------------------------------------------
  const switchHarness = harnessOf();

  expectEqual(
    (await readRefundFeeRule({ actor: deskActor() }, switchHarness.dependencies)).returned,
    false,
    "a deployment nobody has answered for keeps the fee",
  );
  expectEqual(
    (await readRefundFeeRule({ actor: deskActor() }, switchHarness.dependencies)).isSet,
    false,
    "and the screen can say the answer is the default",
  );

  const merchant = actorOf({ userId: ownerUserId, companyId, roles: ["owner"] });
  const staleSuper = actorOf({ userId: superUserId, roles: ["super_admin"], reauthenticatedAtEpochMs: null, mfaVerifiedAtEpochMs: null });

  await expectRefusal(
    () => saveRefundFeeRule({ actor: merchant, returned: true, expectedUpdatedAt: null }, switchHarness.dependencies),
    "PERMISSION_DENIED",
    "",
    "a merchant cannot answer the platform fee question",
  );

  await expectRefusal(
    () => saveRefundFeeRule({ actor: deskActor(), returned: true, expectedUpdatedAt: null }, switchHarness.dependencies),
    "PERMISSION_DENIED",
    "",
    "and neither can the finance desk: section 18 gives it to the super administrator",
  );

  await expectRefusal(
    () => saveRefundFeeRule({ actor: staleSuper, returned: true, expectedUpdatedAt: null }, switchHarness.dependencies),
    "PERMISSION_DENIED",
    "reauth_required",
    "a super administrator whose second factor is not fresh cannot answer it either",
  );

  // A save of the value already in force writes nothing and audits nothing.
  const unchanged = await saveRefundFeeRule(
    { actor: superActor(), returned: false, expectedUpdatedAt: null },
    switchHarness.dependencies,
  );

  expectEqual(unchanged.returned, false, "saving the default state leaves the default state");
  expectEqual(switchHarness.fixture.settings.length, 0, "and writes no row, because nothing changed");
  expectEqual(switchHarness.audit.entries.length, 0, "and records nothing, because nothing happened");

  const opened = await saveRefundFeeRule(
    { actor: superActor(), returned: true, expectedUpdatedAt: null },
    switchHarness.dependencies,
  );

  expectEqual(opened.returned, true, "the super administrator opens the switch");
  expectEqual(switchHarness.fixture.settings.length, 1, "which is one row in the registry");
  expectEqual(switchHarness.fixture.settings[0]?.["setting_key"], REFUND_FEE_RULE_KEY, "under the section 18 key");
  expectEqual(switchHarness.fixture.settings[0]?.["value"], true, "holding a JSON boolean, not a string");
  expectEqual(switchHarness.fixture.settings[0]?.["is_secret"], false, "as a plain setting, not a secret");
  expectEqual(switchHarness.fixture.settings[0]?.["updated_by"], superUserId, "naming who answered");
  expectEqual(switchHarness.audit.entries.length, 1, "and the answer is in the chain");
  expectEqual(
    switchHarness.audit.entries[0]?.action,
    REFUND_FEE_RULE_UPDATED_AUDIT_ACTION,
    "under the rule's own action",
  );
  expectEqual(
    switchHarness.audit.entries[0]?.payload["previous"],
    null,
    "recording that there was no earlier answer",
  );

  // Answering again with the same value is not an answer.
  await saveRefundFeeRule({ actor: superActor(), returned: true, expectedUpdatedAt: null }, switchHarness.dependencies);

  expectEqual(switchHarness.audit.entries.length, 1, "re-saving the same answer writes no second chain entry");
  expectEqual(switchHarness.fixture.settings[0]?.["version"], 1, "and does not spend a version");

  // A stale form is a conflict, and the officer reads the other officer's answer.
  await expectRefusal(
    () =>
      saveRefundFeeRule(
        { actor: superActor(), returned: false, expectedUpdatedAt: "2026-01-01T00:00:00.000Z" },
        switchHarness.dependencies,
      ),
    "CONFLICT",
    "stale",
    "a screen built before somebody else answered cannot overwrite their answer",
  );

  const closed = await saveRefundFeeRule(
    {
      actor: superActor(),
      returned: false,
      expectedUpdatedAt: String(switchHarness.fixture.settings[0]?.["updated_at"]),
    },
    switchHarness.dependencies,
  );

  expectEqual(closed.returned, false, "with the instant it read, the super administrator closes it again");
  expectEqual(switchHarness.fixture.settings[0]?.["version"], 2, "the row moves one version");
  expectEqual(switchHarness.audit.entries.length, 2, "and the change is in the chain");
  expectEqual(switchHarness.audit.entries[1]?.payload["previous"], true, "with the answer it replaced");

  // A value that is not a boolean is not an answer either.
  const mistyped = harnessOf({ settings: [settingRow("true")] });

  expectEqual(
    (await readRefundFeeRule({ actor: deskActor() }, mistyped.dependencies)).returned,
    false,
    "a switch stored as the string \"true\" reads as the default rather than as on",
  );
  expectEqual(
    (await readRefundFeeRule({ actor: deskActor() }, mistyped.dependencies)).isSet,
    false,
    "and the screen shows it as unanswered",
  );

  // -------------------------------------------------------------------------------------------
  // 4. A refund that returns its share
  // -------------------------------------------------------------------------------------------
  const returned = harnessOf({
    settings: [settingRow(true)],
    refunds: [refundRow()],
  });
  const first = await applyRefundFeeReturn(
    { actor: deskActor(), refundId: refundOneId },
    returned.dependencies,
  );

  expectEqual(first.kind, "returned", "an open switch returns the fee on a succeeded refund");
  expectEqual(first.returnedMinor, "7250", "which is a quarter of the two dollar ninety the payment carried");
  expectEqual(first.feeMinor, "29000", "the payment's fee, as it was read");
  expectEqual(first.alreadyReturnedMinor, "0", "with nothing returned by other refunds yet");
  expectEqual(first.completes, false, "and the payment not yet complete");
  expectEqual(first.ledger, "posted", "the pair is posted when a store is there");
  expectEqual(first.refund.platformFeeReturned, true, "the refund says the fee came back");
  expectEqual(first.refund.platformFeeReturnedMinor, "7250", "with the amount that came back");

  const answeredRow = returned.fixture.refunds[0];

  expectEqual(
    typeof answeredRow?.["platform_fee_settled_at"],
    "string",
    "and it carries the instant the rule was applied, which a second pass finds",
  );
  expectEqual(answeredRow?.["version"], 4, "the row moved exactly one version");
  expectEqual(
    answeredRow?.["status"],
    "succeeded",
    "nothing about the refund's own status changed: the rule is not a refund",
  );

  const entries = returned.ledger === null ? [] : entriesOf(returned.ledger);

  expectEqual(entries.length, 2, "one pair of entries, and no more");
  expect(entries.every((entry) => entry.entryGroupId === groupId), "in the group derived from the refund");
  expect(entries.every((entry) => entry.sourceType === "refund"), "sourced as a refund");
  expect(entries.every((entry) => entry.refundId === refundOneId), "naming the refund");
  expect(
    entries.every((entry) => entry.paymentId === null),
    "and not the payment, which `0041` refuses a refund source to carry",
  );
  expectEqual(
    entries.find((entry) => entry.entrySide === "debit")?.accountId,
    "platform_fee_income",
    "the fee income the platform booked is debited back",
  );
  expectEqual(
    entries.find((entry) => entry.entrySide === "credit")?.accountId,
    "merchant_payable",
    "and the merchant's payable is credited by the same amount",
  );
  expectEqual(
    entries.reduce((total, entry) => (entry.entrySide === "debit" ? total + entry.amountMinor : total), 0n),
    entries.reduce((total, entry) => (entry.entrySide === "credit" ? total + entry.amountMinor : total), 0n),
    "so the pair balances to zero",
  );
  expectEqual(entries[0]?.amountMinor, 7250n, "and the amount is the return");

  expectEqual(returned.audit.entries.length, 1, "one chain entry for the one answer");
  expectEqual(returned.audit.entries[0]?.action, REFUND_FEE_RETURNED_AUDIT_ACTION, "recording the return");
  expectEqual(returned.audit.entries[0]?.entityType, "refund", "against the refund");
  expectEqual(returned.audit.entries[0]?.entityId, refundOneId, "that was settled");
  expectEqual(returned.audit.entries[0]?.payload["returned_minor"], "7250", "with the amount");
  expectEqual(returned.audit.entries[0]?.payload["ledger"], "posted", "and the fact that a pair exists");
  expectEqual(returned.fixture.paymentWrites.length, 0, "the pass wrote no payment row");

  // A second pass on the same refund changes nothing at all.
  const again = await applyRefundFeeReturn({ actor: deskActor(), refundId: refundOneId }, returned.dependencies);

  expectEqual(again.kind, "skipped", "a refund the rule already answered is skipped");
  expectEqual(again.rule, REFUND_FEE_RULES.alreadySettled, "and says so");
  expectEqual(answeredRow?.["version"], 4, "the row does not move again");
  expectEqual(returned.audit.entries.length, 1, "no second chain entry");
  expectEqual(returned.ledger === null ? 0 : entriesOf(returned.ledger).length, 2, "and no second pair");

  // -------------------------------------------------------------------------------------------
  // 5. A payment refunded in parts returns the whole fee, exactly
  // -------------------------------------------------------------------------------------------
  const parts = harnessOf({
    settings: [settingRow(true)],
    refunds: [
      refundRow({ id: refundOneId, amount_minor: "250000", processed_at: new Date(startedAtMs - 4_000).toISOString() }),
      refundRow({ id: refundTwoId, amount_minor: "250000", processed_at: new Date(startedAtMs - 3_000).toISOString() }),
      refundRow({ id: refundThreeId, amount_minor: "500000", processed_at: new Date(startedAtMs - 2_000).toISOString() }),
    ],
  });

  const partOne = await applyRefundFeeReturn({ actor: deskActor(), refundId: refundOneId }, parts.dependencies);

  // `refunds_sync_payment` writes the payment's refunded total the instant a refund succeeds, so by the second
  // part the payment records the first one, and by the third it records both.
  setRefundedTotal(parts.fixture.payments[0], "250000");

  const partTwo = await applyRefundFeeReturn({ actor: deskActor(), refundId: refundTwoId }, parts.dependencies);

  setRefundedTotal(parts.fixture.payments[0], "500000");

  const partTwoRefunded = parts.fixture.payments[0]?.["refunded_minor"];

  expectEqual(partTwoRefunded, "500000", "the payment records two quarters before the last part is answered");

  // The last part completes the payment, so the trigger has already written the whole amount by the time the
  // rule is applied - which is what tells the plan to hand back the remainder rather than a fourth quarter.
  setRefundedTotal(parts.fixture.payments[0], "1000000");

  const partThree = await applyRefundFeeReturn({ actor: deskActor(), refundId: refundThreeId }, parts.dependencies);

  expectEqual(partOne.returnedMinor, "7250", "the first quarter returns its quarter");
  expectEqual(partTwo.returnedMinor, "7250", "the second does the same");
  expectEqual(partThree.returnedMinor, "14500", "and the half that completes the payment takes the remainder");
  expectEqual(partThree.completes, true, "which it knows because the payment's refunded total says so");
  expectEqual(
    BigInt(partOne.returnedMinor) + BigInt(partTwo.returnedMinor) + BigInt(partThree.returnedMinor),
    29000n,
    "so a payment refunded in full returns the fee in full, to the minor unit",
  );
  expectEqual(parts.fixture.paymentWrites.length, 0, "and no pass wrote a payment");

  // -------------------------------------------------------------------------------------------
  // 6. The answers that return nothing
  // -------------------------------------------------------------------------------------------
  const closedRule = harnessOf({ refunds: [refundRow()] });
  const retained = await applyRefundFeeReturn({ actor: deskActor(), refundId: refundOneId }, closedRule.dependencies);

  expectEqual(retained.kind, "retained", "with the switch closed the platform keeps the fee");
  expectEqual(retained.rule, REFUND_FEE_RULES.ruleClosed, "and the answer names the switch");
  expectEqual(retained.returnedMinor, "0", "no money moves");
  expectEqual(retained.ledger, "absent", "and no pair is posted");
  expectEqual(retained.refund.platformFeeReturned, false, "the row does not claim a return");
  expectEqual(
    typeof closedRule.fixture.refunds[0]?.["platform_fee_settled_at"],
    "string",
    "but the question is recorded as answered, so the pass never asks it again",
  );
  expectEqual(closedRule.audit.entries[0]?.action, REFUND_FEE_RETAINED_AUDIT_ACTION, "the chain says retained");
  expectEqual(closedRule.audit.entries[0]?.payload["rule"], REFUND_FEE_RULES.ruleClosed, "with the rule");

  const noFeeRefund = harnessOf({
    settings: [settingRow(true)],
    payments: [paymentRow({ platform_fee_minor: "0" })],
    refunds: [refundRow()],
  });

  expectEqual(
    (await applyRefundFeeReturn({ actor: deskActor(), refundId: refundOneId }, noFeeRefund.dependencies)).rule,
    REFUND_FEE_RULES.feeZero,
    "a payment that carried no fee has nothing to give back",
  );

  const dustRefund = harnessOf({
    settings: [settingRow(true)],
    refunds: [refundRow({ amount_minor: "1" })],
  });

  expectEqual(
    (await applyRefundFeeReturn({ actor: deskActor(), refundId: refundOneId }, dustRefund.dependencies)).rule,
    REFUND_FEE_RULES.shareZero,
    "a part whose share is below one minor unit returns nothing rather than rounding somebody's money",
  );

  const exhaustedRefund = harnessOf({
    settings: [settingRow(true)],
    payments: [paymentRow({ refunded_minor: "750000" })],
    refunds: [
      refundRow({ id: refundTwoId, amount_minor: "500000", platform_fee_settled_at: new Date(startedAtMs).toISOString(), platform_fee_returned: true, platform_fee_returned_minor: "29000" }),
      refundRow({ id: refundOneId, amount_minor: "250000" }),
    ],
  });

  expectEqual(
    (await applyRefundFeeReturn({ actor: deskActor(), refundId: refundOneId }, exhaustedRefund.dependencies)).rule,
    REFUND_FEE_RULES.feeExhausted,
    "a fee an earlier refund already returned in full is not returned twice",
  );
  expectEqual(exhaustedRefund.fixture.paymentWrites.length, 0, "and that answer wrote no payment either");

  // A refund that is not succeeded is not settled, and neither is a failed one.
  const notSettled = harnessOf({
    settings: [settingRow(true)],
    refunds: [refundRow({ status: "processing", processed_at: null, provider_refund_id: null })],
  });

  const refusedSettlement = await applyRefundFeeReturn(
    { actor: deskActor(), refundId: refundOneId },
    notSettled.dependencies,
  );

  expectEqual(refusedSettlement.kind, "skipped", "a refund still in progress is not answered");
  expectEqual(refusedSettlement.rule, REFUND_FEE_RULES.refundNotSettled, "and the skip says why");
  expectEqual(notSettled.audit.entries.length, 0, "no chain entry for a question not asked");
  expectEqual(notSettled.fixture.refunds[0]?.["version"], 3, "and no write");

  // -------------------------------------------------------------------------------------------
  // 7. The ledger is the money: a refused pair leaves the question unanswered
  // -------------------------------------------------------------------------------------------
  const refusing = harnessOf({ settings: [settingRow(true)], refunds: [refundRow()] });
  const refusalDependencies: RefundFeeDependencies = {
    ...refusing.dependencies,
    ledger: {
      findByGroup: () => [],
      findByReversalOf: () => null,
      listGroupIds: () => [],
      insertGroup: () => false,
    },
  };

  const refused = await applyRefundFeeReturn(
    { actor: deskActor(), refundId: refundOneId },
    refusalDependencies,
  );

  expectEqual(refused.kind, "unavailable", "a ledger that refuses leaves the refund unanswered");
  expectEqual(refused.rule, REFUND_FEE_RULES.ledgerRefused, "naming the ledger");
  expectEqual(refusing.fixture.refunds[0]?.["platform_fee_settled_at"], null, "nothing is recorded on the row");
  expectEqual(refusing.audit.entries.length, 0, "and nothing is recorded in the chain as an answer");

  // A deployment with no store records the answer and says the pair is absent.
  const storeless = harnessOf({ settings: [settingRow(true)], refunds: [refundRow()], ledger: false });
  const absent = await applyRefundFeeReturn({ actor: deskActor(), refundId: refundOneId }, storeless.dependencies);

  expectEqual(absent.kind, "returned", "with no store the answer is still the answer");
  expectEqual(absent.ledger, "absent", "and the result says no pair exists, rather than pretending one does");
  expectEqual(absent.returnedMinor, "7250", "for the same amount the store would have carried");
  expectEqual(
    storeless.audit.entries[0]?.payload["ledger"],
    "absent",
    "and the chain records that the pair is still owed",
  );

  // -------------------------------------------------------------------------------------------
  // 8. A crash between the pair and the row: the ledger wins, and nothing is posted twice
  // -------------------------------------------------------------------------------------------
  const crashed = harnessOf({ settings: [settingRow(true)], refunds: [refundRow()] });

  // The pair posted, the row write lost - exactly what a process killed between the two leaves behind. The group
  // here carries 5000 rather than the 7250 the plan would compute, so the retry has to record the ledger's number.
  crashed.ledger?.insertGroup([
    {
      id: "00000000-0000-4000-8000-000000000001",
      companyId,
      accountId: "platform_fee_income",
      entryGroupId: groupId,
      entrySide: "debit",
      amountMinor: 5000n,
      currency: "USD",
      occurredAt: new Date(startedAtMs).toISOString(),
      sourceType: "refund",
      sourceId: refundOneId,
      paymentId: null,
      refundId: refundOneId,
      disputeId: null,
      description: null,
      reversalOfId: null,
      postedAt: new Date(startedAtMs).toISOString(),
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      companyId,
      accountId: "merchant_payable",
      entryGroupId: groupId,
      entrySide: "credit",
      amountMinor: 5000n,
      currency: "USD",
      occurredAt: new Date(startedAtMs).toISOString(),
      sourceType: "refund",
      sourceId: refundOneId,
      paymentId: null,
      refundId: refundOneId,
      disputeId: null,
      description: null,
      reversalOfId: null,
      postedAt: new Date(startedAtMs).toISOString(),
    },
  ]);

  const repaired = await applyRefundFeeReturn({ actor: deskActor(), refundId: refundOneId }, crashed.dependencies);

  expectEqual(repaired.kind, "returned", "the retry answers the question");
  expectEqual(repaired.ledger, "existing", "finding the pair already posted");
  expectEqual(repaired.returnedMinor, "5000", "and recording the amount the ledger actually holds");
  expectEqual(repaired.refund.platformFeeReturnedMinor, "5000", "on the row, rather than a recomputed number");
  expectEqual(
    crashed.ledger === null ? 0 : entriesOf(crashed.ledger).length,
    2,
    "no second pair was posted for the same refund",
  );

  // A stale row write is detected rather than overwritten as a success.
  const raced = harnessOf({ settings: [settingRow(true)], refunds: [refundRow()] });

  raced.fixture.failNextRefundUpdate = true;

  await expectRefusal(
    () => applyRefundFeeReturn({ actor: deskActor(), refundId: refundOneId }, raced.dependencies),
    "CONFLICT",
    "refund_moved",
    "a row that did not move is reported as moved rather than as answered",
  );
  expectEqual(raced.fixture.paymentWrites.length, 0, "and the refused write touched no payment");

  // -------------------------------------------------------------------------------------------
  // 9. Who may ask, and what happens to a refund nobody can see
  // -------------------------------------------------------------------------------------------
  await expectRefusal(
    () => applyRefundFeeReturn({ actor: merchant, refundId: refundOneId }, returned.dependencies),
    "PERMISSION_DENIED",
    "",
    "a merchant cannot settle the platform fee on any refund",
  );

  await expectRefusal(
    () => applyRefundFeeReturn({ actor: deskActor(), refundId: "8b000000-0000-4000-8000-0000000000ff" }, returned.dependencies),
    "RESOURCE_NOT_FOUND",
    REFUND_FEE_RULES.refundNotFound,
    "a refund that does not exist is not found",
  );

  // -------------------------------------------------------------------------------------------
  // 10. The pass
  // -------------------------------------------------------------------------------------------
  const sweep = harnessOf({
    settings: [settingRow(true)],
    payments: [paymentRow()],
    refunds: [
      refundRow({ id: refundOneId, processed_at: new Date(startedAtMs - 3_000).toISOString() }),
      refundRow({ id: refundTwoId, amount_minor: "750000", processed_at: new Date(startedAtMs - 2_000).toISOString() }),
      refundRow({ id: refundThreeId, status: "processing", processed_at: null, provider_refund_id: null }),
    ],
  });

  const sweepResult = await sweepRefundFeeReturns({ actor: deskActor() }, sweep.dependencies);

  expectEqual(sweepResult.examined, 2, "the pass reads only the succeeded refunds nobody has answered");
  expectEqual(sweepResult.returned, 2, "and answers both of them");
  expectEqual(sweepResult.skipped, 0, "with no row moving under it");
  expectEqual(sweepResult.ruleReturned, true, "under the switch as it stands");
  expectEqual(
    sweepResult.returnedMinor,
    "29000",
    "returning each part's share of the fee, in the proportion the part is of the payment",
  );
  expectEqual(sweepResult.ranAtEpochMs, startedAtMs, "at the instant the clock it was given says");
  expectEqual(sweep.audit.entries.length, 2, "two answers, two chain entries");

  const sweepAgain = await sweepRefundFeeReturns({ actor: deskActor() }, sweep.dependencies);

  expectEqual(sweepAgain.examined, 0, "the second pass finds nothing to do");
  expectEqual(sweep.audit.entries.length, 2, "and writes nothing");

  // Bounded, and honest about it.
  const many = harnessOf({
    settings: [settingRow(true)],
    payments: [paymentRow({ amount_minor: "10000000", platform_fee_minor: "290000" })],
    refunds: Array.from({ length: REFUND_FEE_SWEEP_LIMIT + 5 }, (_value, index) =>
      refundRow({
        id: `8b000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        amount_minor: "10000",
        processed_at: new Date(startedAtMs - 100_000 + index).toISOString(),
      }),
    ),
  });
  const bounded = await sweepRefundFeeReturns({ actor: deskActor() }, many.dependencies);

  expectEqual(bounded.examined, REFUND_FEE_SWEEP_LIMIT, "a pass works through fifty refunds and stops");
  expectEqual(bounded.returned, REFUND_FEE_SWEEP_LIMIT, "answering each of them");
  expectEqual(
    await readRefundFeeBacklog(many.dependencies).then((backlog) => backlog.pending),
    5,
    "and the backlog the screen prints is what is left",
  );

  // A merchant cannot run the pass, and a super administrator whose second factor is stale cannot either.
  await expectRefusal(
    () => sweepRefundFeeReturns({ actor: merchant }, sweep.dependencies),
    "PERMISSION_DENIED",
    "",
    "a merchant cannot run the platform's fee pass",
  );

  await expectRefusal(
    () => sweepRefundFeeReturns({ actor: staleSuper }, sweep.dependencies),
    "PERMISSION_DENIED",
    "reauth_required",
    "and the pass needs a fresh second factor even for the super administrator",
  );

  // A closed switch is still an answer, and the pass records it rather than leaving the queue full.
  const closedSweep = harnessOf({ refunds: [refundRow()] });
  const closedResult = await sweepRefundFeeReturns({ actor: deskActor() }, closedSweep.dependencies);

  expectEqual(closedResult.ruleReturned, false, "the pass runs under the switch as it stands");
  expectEqual(closedResult.retained, 1, "and records the retained answer");
  expectEqual(closedSweep.audit.entries[0]?.action, REFUND_FEE_RETAINED_AUDIT_ACTION, "in the chain");
  expectEqual(
    closedSweep.fixture.refunds[0]?.["platform_fee_settled_at"] === null ? "unset" : "set",
    "set",
    "so opening the switch later does not reopen a refund the platform already settled",
  );

  // -------------------------------------------------------------------------------------------
  // 11. The sources
  // -------------------------------------------------------------------------------------------
  const serviceSource = await readFile(new URL("./refund-fee.ts", import.meta.url), "utf8");
  const fieldsSource = await readFile(new URL("./refund-fee-fields.ts", import.meta.url), "utf8");
  const runtimeSource = await readFile(new URL("./refund-fee-runtime.ts", import.meta.url), "utf8");
  const migrateSource = await readFile(new URL("../../migrations/0123_refund_fee_rule.sql", import.meta.url), "utf8");
  const downSource = await readFile(
    new URL("../../migrations/0123_refund_fee_rule.down.sql", import.meta.url),
    "utf8",
  );
  const routeSource = await readFile(
    new URL("../../app/api/office/refunds/fees/route.ts", import.meta.url),
    "utf8",
  );
  const settleSource = await readFile(
    new URL("../../app/api/office/refunds/fees/settle/route.ts", import.meta.url),
    "utf8",
  );
  const executeSource = await readFile(
    new URL("../../app/api/office/refunds/[id]/execute/route.ts", import.meta.url),
    "utf8",
  );
  const pageSource = await readFile(
    new URL("../../app/(admin)/office/refunds/fees/page.tsx", import.meta.url),
    "utf8",
  );
  const formSource = await readFile(
    new URL("../../app/(admin)/office/refunds/fees/refund-fee-form.tsx", import.meta.url),
    "utf8",
  );
  const queueSource = await readFile(
    new URL("../../app/(admin)/office/refunds/page.tsx", import.meta.url),
    "utf8",
  );
  const csrfSource = await readFile(new URL("../../lib/security/csrf.ts", import.meta.url), "utf8");
  const catalogSource = await readFile(new URL("../../lib/i18n/strings/en.ts", import.meta.url), "utf8");

  // The migration.
  expect(migrateSource.includes("add column platform_fee_settled_at timestamptz"), "0123 adds the instant");
  expect(
    migrateSource.includes("refunds_platform_fee_settled_check"),
    "with the constraint that keeps it on a succeeded refund",
  );
  expect(
    migrateSource.includes("refunds_platform_fee_answered_check"),
    "and the one that keeps a returned fee from existing without it",
  );
  expect(migrateSource.includes("refunds_fee_settle_idx"), "and the partial index the pass reads");
  expect(
    migrateSource.includes("'refunds.platform_fee_returned', 'false'::jsonb"),
    "and seeds the switch on the side that keeps the fee",
  );
  expect(
    !migrateSource.includes("create trigger") && !migrateSource.includes("alter table public.payments"),
    "0123 adds no trigger and changes no payment: the refunded total stays `refunds_sync_payment`'s",
  );
  expect(downSource.includes("drop column if exists platform_fee_settled_at"), "the rollback removes the column");
  expect(downSource.includes("drop index if exists public.refunds_fee_settle_idx"), "and the index");
  expect(
    downSource.includes("delete from public.platform_settings where setting_key"),
    "and the seeded row, so a reversed database reads the default again",
  );

  // The migration chain.
  const migrationNames = (await readdir(new URL("../../migrations", import.meta.url))).filter((name) =>
    /^\d{4}_.*\.sql$/u.test(name) && !name.endsWith(".down.sql"),
  );
  const numbers = migrationNames.map((name) => Number.parseInt(name.slice(0, 4), 10));

  // 0123 is this STEP's own migration and 0124 is STEP 195's; the chain is contiguous to 124.
  expectEqual(Math.max(...numbers), 124, "0124 is the newest migration in the chain");
  expectEqual(numbers.length, 124, "and the chain is one longer than STEP 192 left it");

  // The service writes no payment, and reuses the refund module's guarded write.
  expect(
    serviceSource.includes("moveRefund(dependencies, refund"),
    "the answer is written through STEP 191's versioned guarded write",
  );
  const directWrites = new Set(
    [...serviceSource.matchAll(/\.(?:update|insert)\(\s*"([a-z_]+)"/gu)].map((match) => match[1]),
  );

  expectEqual(
    [...directWrites].join(","),
    "platform_settings",
    "the only table this STEP writes directly is the switch; a refund goes through `moveRefund`",
  );
  expect(
    !directWrites.has("payments"),
    "so this STEP never writes a payment: `refunds_sync_payment` owns the refunded total",
  );
  expect(
    serviceSource.includes("insert(\"platform_settings\"") && serviceSource.includes('update(\n      "platform_settings"'),
    "the switch is inserted when absent and updated when present",
  );

  // The fields module is pure: no database, no audit, no clock.
  expect(
    !fieldsSource.includes("RestClient") &&
      !fieldsSource.includes("AuditTrail") &&
      !fieldsSource.includes("Date.now"),
    "the vocabulary module imports no database, no chain and no clock",
  );
  expect(
    !/^import .*(rest|audit)\.ts/mu.test(fieldsSource),
    "and its one import from the platform is the error shape",
  );

  // The runtime says what it does not wire.
  expect(runtimeSource.includes("ledger: null"), "the runtime passes no ledger store, and the file says why");
  expect(
    runtimeSource.includes("getAuthRuntime()"),
    "and projects the one runtime that already validated the environment",
  );

  // The routes.
  expect(routeSource.includes("requireCsrfToken"), "the switch route checks the CSRF token");
  expect(routeSource.includes("requireTrustedDevice"), "and the device proof over the exact bytes");
  expect(routeSource.includes("REFUND_FEE_MAXIMUM_BODY_BYTES"), "and refuses a body over its ceiling");
  expect(routeSource.includes('"cache-control": "no-store"'), "and answers with no-store");
  expect(settleSource.includes("requireCsrfToken"), "the pass route checks the CSRF token");
  expect(settleSource.includes("requireTrustedDevice"), "and the device proof");
  expect(settleSource.includes('"cache-control": "no-store"'), "and answers with no-store");
  expect(
    csrfSource.includes('"/api/office/refunds/fees"') && csrfSource.includes('"/api/office/refunds/fees/settle"'),
    "both routes are in the CSRF inventory",
  );

  // The execution route applies the rule only after a success, and never lets it fail the answer.
  expect(
    executeSource.includes('execution.outcome === "succeeded"'),
    "the execution route applies the fee rule only to a refund that went back",
  );
  expect(
    /if \(execution\.outcome === "succeeded"\) \{\s*try \{/u.test(executeSource),
    "and inside a try, so a fee that cannot be written never fails a sent refund",
  );
  expect(
    executeSource.lastIndexOf("await applyRefundFeeReturn(") > executeSource.indexOf("await executeRefund("),
    "and after the execution, because the rule is about money that has left",
  );

  // The screens.
  expect(pageSource.includes("<RefundFeeRuleForm"), "the fees screen renders the switch for the roles that may save it");
  expect(
    pageSource.includes("state.rule.canEdit ?"),
    "only when the service says this account may answer",
  );
  expect(pageSource.includes("<RefundFeeSweepForm"), "and offers the pass to the desk");
  expect(formSource.includes("deviceProofHeaders"), "the form signs its bytes with the device proof");
  expect(formSource.includes("csrfHeaders"), "and carries the CSRF token");
  expect(formSource.includes("savedAt"), "and sends the instant it rendered, so a stale save is a conflict");
  expect(queueSource.includes("feeReturnedRowLabel"), "the queue prints the fee answer on a succeeded refund");
  expect(queueSource.includes('href="/office/refunds/fees"'), "and links to the screen that changes it");

  // The catalogue holds every key the three screens name.
  for (const key of [
    "refundFees.screenTitle",
    "refundFees.screenDescription",
    "refundFees.stateReturned",
    "refundFees.stateRetained",
    "refundFees.defaultNote",
    "refundFees.prorationHelp",
    "refundFees.backlogLabel",
    "refundFees.ledgerAbsentNote",
    "refundFees.switchLabel",
    "refundFees.save",
    "refundFees.runPass",
    "refundFees.reauthRequired",
    "refundFees.staleSave",
    "refunds.feesLink",
    "refunds.feeReturnedRowLabel",
    "refunds.feeRetainedRowLabel",
  ]) {
    const [group = "", name = ""] = key.split(".");
    const block = catalogSource.slice(catalogSource.indexOf(`  ${group}: {`));

    expect(block.includes(`${name}:`), `the catalogue holds ${key}`);
  }

  // -------------------------------------------------------------------------------------------
  // The answer
  // -------------------------------------------------------------------------------------------
  if (failures.length > 0) {
    process.stderr.write(`refund fee gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `refund fee gate passed: ${checkCount} checks, the section 18 switch answered by one role, a refund returning ` +
      `its exact share of the fee, a payment refunded in full returning the whole fee, one balanced ledger pair ` +
      `per return derived from the refund, and no pass ever answering the same refund twice\n`,
  );
}

await main();
