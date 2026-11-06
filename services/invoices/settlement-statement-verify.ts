// path: services/invoices/settlement-statement-verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  MAXIMUM_STATEMENT_ROWS,
  SETTLEMENT_STATEMENT_RULES,
  STATEMENT_CSV_HEADER,
  STATEMENT_SOURCE_TYPES,
  STATEMENT_TYPE_LABELS,
  statementCsvOf,
} from "./settlement-statement-fields.ts";
import { buildSettlementStatement } from "./settlement-statement.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

interface Refusal {
  readonly code: string | null;
  readonly field: string | null;
  readonly rule: string | null;
}

async function refusalOfAsync(call: () => Promise<unknown>): Promise<Refusal> {
  try {
    await call();
  } catch (error) {
    if (error instanceof AppError) {
      const details = error.details as readonly { readonly field?: unknown; readonly rule?: unknown }[];
      const first = details[0];

      return {
        code: error.code,
        field: typeof first?.field === "string" ? first.field : null,
        rule: typeof first?.rule === "string" ? first.rule : null,
      };
    }

    throw error;
  }

  throw new Error("the call was supposed to be refused and was not");
}

/* ---- the world ---- */

const NOW = Date.parse("2026-11-04T09:00:00.000Z");
const OWNER_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const COMPANY_A = "018f2b8a-4444-4c2d-9c3e-000000000001";
const COMPANY_B = "018f2b8a-4444-4c2d-9c3e-000000000002";

function actorOf(roles: readonly PlatformRole[], companyId: string | null): RequestActor {
  return {
    userId: OWNER_ID,
    companyId,
    roles,
    sessionId: "018f2b8a-2222-4c2d-9c3e-000000000001",
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: NOW,
    expiresAtEpochMs: NOW + 900_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: null,
    sessionFamilyId: null,
    mfaVerifiedAtEpochMs: null,
    reauthenticatedAtEpochMs: null,
  };
}

const owner = actorOf(["owner"], COMPANY_A);

interface AccountRow {
  readonly id: string;
  readonly company_id: string;
  readonly account_code: string;
  readonly is_active: boolean;
}

interface EntryRow {
  readonly id: string;
  readonly company_id: string;
  readonly account_id: string;
  readonly occurred_at: string;
  readonly entry_side: "debit" | "credit";
  readonly amount_minor: string;
  readonly currency: string;
  readonly source_type: string;
  readonly description: string | null;
}

interface StatementDb {
  readonly accounts: AccountRow[];
  readonly entries: EntryRow[];
}

const PAYABLE = "merchant_payable";
const CLEARING = "processor_clearing";

/**
 * The ledger of the statement's world, answering the service's two reads the way PostgREST answers.
 *
 * The reads are the service's own: the account lookup by the company and the frozen code, and the
 * entry read scoped to the accounts it was given, the eight words, the window and the order. A query
 * the service builds wrong is a query the gate sees, because the fake parses the query string the
 * service built and answers only what it asks for.
 *
 * The write methods throw: the statement is a reading of an append-only history, and a service that
 * reached for one of them would fail the gate here before it failed in production.
 */
function restOf(db: StatementDb): RestClient {
  return {
    async select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const parts = new Map<string, string>();

      for (const piece of query.split("&")) {
        const at = piece.indexOf("=");

        if (at > 0) {
          parts.set(piece.slice(0, at), piece.slice(at + 1));
        }
      }

      if (table === "ledger_accounts") {
        const company = parts.get("company_id");
        const code = parts.get("account_code");

        if (company === undefined || code === undefined || !company.startsWith("eq.") || !code.startsWith("eq.")) {
          throw new Error(`the account read is not scoped to one company and one code: ${query}`);
        }

        const rows = db.accounts.filter(
          (row) => row.company_id === company.slice(3) && row.account_code === code.slice(3),
        );

        return parseAll(schema, rows, "an account row the service cannot read");
      }

      if (table === "ledger_entries") {
        const company = parts.get("company_id");
        const accounts = parts.get("account_id");
        const types = parts.get("source_type");
        const from = parts.get("occurred_at");
        const limit = parts.get("limit");

        if (company === undefined || accounts === undefined || types === undefined || from === undefined) {
          throw new Error(`the entry read is not scoped the way the statement scoping needs: ${query}`);
        }

        const accountIds = accounts.startsWith("in.")
          ? accounts.slice(4, -1).split(",").filter((value) => value.length > 0)
          : [];
        const typeIds = types.startsWith("in.") ? types.slice(4, -1).split(",") : [];

        // The two `occurred_at` predicates: the lower bound and the upper bound the query carries.
        const bounds = query
          .split("&occurred_at=")
          .slice(1)
          .map((piece) => {
            const at = piece.indexOf(".");
            const operator = piece.slice(0, at);
            const value = piece.slice(at + 1).split("&")[0] ?? "";

            return { operator, value: Date.parse(value) };
          });

        const lower = bounds.find((bound) => bound.operator === "gte");
        const upper = bounds.find((bound) => bound.operator === "lt");

        if (lower === undefined || upper === undefined) {
          throw new Error(`the entry read carries no closed window: ${query}`);
        }

        const ceiling = limit === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(limit, 10);

        const rows = db.entries
          .filter(
            (row) =>
              row.company_id === company.slice(3) &&
              accountIds.includes(row.account_id) &&
              typeIds.includes(row.source_type) &&
              Date.parse(row.occurred_at) >= lower.value &&
              Date.parse(row.occurred_at) < upper.value,
          )
          .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at) || (a.id < b.id ? 1 : -1))
          .slice(0, ceiling);

        return parseAll(schema, rows, "an entry row the service cannot read");
      }

      throw new Error(`the statement reads no other table: ${table}`);
    },
    async insert(): Promise<void> {
      throw new Error("the statement writes no row");
    },
    async insertReturning(): Promise<readonly never[]> {
      throw new Error("the statement writes no row");
    },
    async update(): Promise<void> {
      throw new Error("the statement writes no row");
    },
    async rpc(): Promise<never> {
      throw new Error("the statement calls no function");
    },
  };
}

function parseAll<TRow>(schema: z.ZodType<TRow>, rows: readonly object[], what: string): readonly TRow[] {
  const out: TRow[] = [];

  for (const row of rows) {
    const parsed = schema.safeParse(row);

    if (!parsed.success) {
      throw new Error(what);
    }

    out.push(parsed.data);
  }

  return out;
}

function depsOf(db: StatementDb) {
  return { rest: restOf(db) };
}

/** One entry on the statement's world, in the minute of the period it is told to sit in. */
function entryOf(overrides: Partial<EntryRow> & { readonly source_type: string }, index: number): EntryRow {
  return {
    id: `018f2b8a-5555-4c2d-9c3e-${String(index).padStart(12, "0")}`,
    company_id: COMPANY_A,
    account_id: "018f2b8a-6666-4c2d-9c3e-000000000001",
    occurred_at: new Date(NOW + index * 60_000).toISOString(),
    entry_side: "credit",
    amount_minor: "10000",
    currency: "USD",
    description: null,
    ...overrides,
  };
}

function accountOf(overrides: Partial<AccountRow> & { readonly id: string }): AccountRow {
  return {
    company_id: COMPANY_A,
    account_code: PAYABLE,
    is_active: true,
    ...overrides,
  };
}

/* ---- the scenarios ---- */

/** The world the statement reads from: one active payable, one clearing, one closed payable. */
function statementWorld(): StatementDb {
  const payableId = "018f2b8a-6666-4c2d-9c3e-000000000001";
  const clearingId = "018f2b8a-6666-4c2d-9c3e-000000000002";
  const oldPayableId = "018f2b8a-6666-4c2d-9c3e-000000000003";
  const otherPayableId = "018f2b8a-6666-4c2d-9c3e-000000000009";

  const accounts: AccountRow[] = [
    accountOf({ id: payableId }),
    accountOf({ id: clearingId, account_code: CLEARING }),
    // The account a correction closed, still the balance's history.
    accountOf({ id: oldPayableId, is_active: false }),
    // The other merchant's payable.
    accountOf({ id: otherPayableId, company_id: COMPANY_B }),
  ];

  const on = (hour: number, minuteOfHour: number): string =>
    new Date(Date.parse(`2026-11-01T${String(hour).padStart(2, "0")}:${String(minuteOfHour).padStart(2, "0")}:00.000Z`)).toISOString();

  const entries: EntryRow[] = [
    // The eight words, one each, inside the window.
    entryOf({ occurred_at: on(9, 0), source_type: "payment", amount_minor: "1250000", description: "Card sale" }, 1),
    entryOf({ occurred_at: on(9, 5), source_type: "platform_fee", entry_side: "debit", amount_minor: "62500" }, 2),
    entryOf({ occurred_at: on(10, 0), source_type: "hold", entry_side: "debit", amount_minor: "100000" }, 3),
    entryOf({ occurred_at: on(10, 30), source_type: "reserve", entry_side: "debit", amount_minor: "125000" }, 4),
    entryOf({ occurred_at: on(11, 0), source_type: "refund", entry_side: "debit", amount_minor: "30000" }, 5),
    entryOf({ occurred_at: on(11, 30), source_type: "chargeback", entry_side: "debit", amount_minor: "70000" }, 6),
    entryOf({ occurred_at: on(12, 0), source_type: "chargeback_fee", entry_side: "debit", amount_minor: "20000" }, 7),
    entryOf({ occurred_at: on(12, 30), source_type: "payout", entry_side: "debit", amount_minor: "900000" }, 8),
    // The two words the statement stays out on.
    entryOf({ occurred_at: on(13, 0), source_type: "settlement", entry_side: "debit", amount_minor: "1000000" }, 9),
    entryOf({ occurred_at: on(13, 15), source_type: "subscription_charge", entry_side: "debit", amount_minor: "150000" }, 10),
    // The other side of the double entry: on the clearing account, not on the balance.
    entryOf({ occurred_at: on(14, 0), account_id: clearingId, source_type: "payment", amount_minor: "500000" }, 11),
    // The other merchant's money, on its own payable.
    entryOf({
      occurred_at: on(14, 30),
      account_id: otherPayableId,
      company_id: COMPANY_B,
      source_type: "payment",
      amount_minor: "800000",
    }, 12),
  ];

  return { accounts, entries };
}

async function checkVocabulary(): Promise<void> {
  expectEqual(STATEMENT_SOURCE_TYPES.length, 8, "the statement knows the eight words section 17 names");
  expect(!STATEMENT_SOURCE_TYPES.includes("settlement"), "and not the word for the batch the statement is about");
  expect(!STATEMENT_SOURCE_TYPES.includes("subscription_charge"), "nor the word for the platform billing the merchant");

  for (const type of STATEMENT_SOURCE_TYPES) {
    expect(STATEMENT_TYPE_LABELS[type] !== undefined, `and the label for ${type} is closed on the eight`);
  }
}

async function checkWorld(): Promise<void> {
  const result = await buildSettlementStatement(
    { actor: owner, from: "2026-11-01", to: "2026-11-03" },
    depsOf(statementWorld()),
  );

  expectEqual(result.rowCount, 8, "the statement carries the eight movements, and nothing else");

  const rows = result.csv.split("\r\n");

  expectEqual(rows.length, 10, "the header, the eight lines and the record break, nothing more");
  expectEqual(rows[0], STATEMENT_CSV_HEADER, "and it opens with the statement's own header");

  const lines = rows.slice(1, -1);

  // Newest first: the 12:30 payout leads.
  expectEqual(lines[0], "2026-11-01T12:30:00.000Z,Payout,-90.0000,USD,", "and the newest movement leads, its side as its sign");
  expectEqual(lines[1], "2026-11-01T12:00:00.000Z,Chargeback fee,-2.0000,USD,", "the fee of the chargeback second");
  expectEqual(lines[2], "2026-11-01T11:30:00.000Z,Chargeback,-7.0000,USD,", "the chargeback third");
  expectEqual(lines[3], "2026-11-01T11:00:00.000Z,Refund,-3.0000,USD,", "the refund fourth");
  expectEqual(lines[4], "2026-11-01T10:30:00.000Z,Reserve,-12.5000,USD,", "the reserve fifth");
  expectEqual(lines[5], "2026-11-01T10:00:00.000Z,Hold,-10.0000,USD,", "the hold sixth");
  expectEqual(lines[6], "2026-11-01T09:05:00.000Z,Platform fee,-6.2500,USD,", "the platform fee seventh");
  expectEqual(lines[7], "2026-11-01T09:00:00.000Z,Payment,125.0000,USD,Card sale", "the payment last, a credit, with the words the merchant reads");

  // The words that stay out of a statement are out of the file.
  expect(!result.csv.includes("Settlement") && !result.csv.includes("Subscription"), "the two words that stay out stay out of the file");

  // The other side of the double entry posts to the clearing account: not a line of the statement.
  expect(!result.csv.includes("50.0000"), "the other side of the double entry is not a line of the statement");

  // The other merchant's money, in the same minute, on its own payable.
  expect(!result.csv.includes("80.0000"), "and no other merchant's money is in the statement at all");

  expectEqual(result.filename, "settlement-statement_2026-11-01_2026-11-03.csv", "and the file is named with the period it covers");
}

async function checkBoundary(): Promise<void> {
  const payableId = "018f2b8a-6666-4c2d-9c3e-000000000001";

  const db: StatementDb = {
    accounts: [accountOf({ id: payableId })],
    entries: [
      // The open edge: exactly the start of the first day, inside.
      entryOf({ id: "018f2b8a-7777-4c2d-9c3e-000000000001", occurred_at: "2026-11-01T00:00:00.000Z", source_type: "payment", amount_minor: "10000" }, 1),
      // The last second of the last day, inside.
      entryOf({ id: "018f2b8a-7777-4c2d-9c3e-000000000002", occurred_at: "2026-11-03T23:59:59.000Z", source_type: "payment", amount_minor: "10000" }, 2),
      // The last instant before the close, inside.
      entryOf({ id: "018f2b8a-7777-4c2d-9c3e-000000000003", occurred_at: "2026-11-03T23:59:59.999Z", source_type: "payment", amount_minor: "10000" }, 3),
      // The close itself: the start of the day after the last, outside.
      entryOf({ id: "018f2b8a-7777-4c2d-9c3e-000000000004", occurred_at: "2026-11-04T00:00:00.000Z", source_type: "payment", amount_minor: "10000" }, 4),
    ],
  };

  const result = await buildSettlementStatement(
    { actor: owner, from: "2026-11-01", to: "2026-11-03" },
    depsOf(db),
  );

  expectEqual(result.rowCount, 3, "the window is the two days whole, and the close belongs to the next period");
  expect(result.csv.includes("2026-11-01T00:00:00.000Z"), "the open edge is inside the window");
  expect(result.csv.includes("2026-11-03T23:59:59.000Z"), "the last second of the last day is inside");
  expect(result.csv.includes("2026-11-03T23:59:59.999Z"), "the instant before the close is inside");
  expect(!result.csv.includes("2026-11-04T00:00:00.000Z"), "and the close itself is not");
}

async function checkClosedPayable(): Promise<void> {
  const activeId = "018f2b8a-6666-4c2d-9c3e-000000000001";
  const closedId = "018f2b8a-6666-4c2d-9c3e-000000000003";

  const db: StatementDb = {
    accounts: [accountOf({ id: activeId }), accountOf({ id: closedId, is_active: false })],
    entries: [
      entryOf({ occurred_at: "2026-11-01T09:00:00.000Z", account_id: activeId, source_type: "payment", amount_minor: "100000" }, 1),
      entryOf({ occurred_at: "2026-11-01T10:00:00.000Z", account_id: closedId, source_type: "payment", amount_minor: "200000" }, 2),
    ],
  };

  const result = await buildSettlementStatement(
    { actor: owner, from: "2026-11-01", to: "2026-11-03" },
    depsOf(db),
  );

  expectEqual(result.rowCount, 2, "both payables the merchant was ever given are in the statement");
  expect(result.csv.includes("2026-11-01T10:00:00.000Z,Payment,20.0000"), "and the closed one's money is its own line");
}

async function checkTieOrder(): Promise<void> {
  const payableId = "018f2b8a-6666-4c2d-9c3e-000000000001";
  const instant = "2026-11-01T09:00:00.000Z";

  const db: StatementDb = {
    accounts: [accountOf({ id: payableId })],
    entries: [
      entryOf({ id: "018f2b8a-7777-4c2d-9c3e-000000000101", occurred_at: instant, source_type: "payment", amount_minor: "10000" }, 1),
      entryOf({ id: "018f2b8a-7777-4c2d-9c3e-000000000102", occurred_at: instant, source_type: "payment", amount_minor: "20000" }, 2),
    ],
  };

  const result = await buildSettlementStatement(
    { actor: owner, from: "2026-11-01", to: "2026-11-03" },
    depsOf(db),
  );

  const rows = result.csv.split("\r\n").slice(1, -1);

  expectEqual(rows[0], "2026-11-01T09:00:00.000Z,Payment,2.0000,USD,", "a tie on the instant is broken by the newer id first");
  expectEqual(rows[1], "2026-11-01T09:00:00.000Z,Payment,1.0000,USD,", "and the older id second");
}

async function checkCeiling(): Promise<void> {
  const payableId = "018f2b8a-6666-4c2d-9c3e-000000000001";
  const base = Date.parse("2026-01-01T00:00:00.000Z");

  const world = (count: number): StatementDb => ({
    accounts: [accountOf({ id: payableId })],
    entries: Array.from({ length: count }, (_, index) =>
      entryOf(
        {
          id: `018f2b8a-7777-4c2d-9c3e-${String(index + 1).padStart(12, "0")}`,
          occurred_at: new Date(base + index * 60_000).toISOString(),
          source_type: "payment",
          amount_minor: "10000",
        },
        index + 1,
      ),
    ),
  });

  const atCeiling = await buildSettlementStatement(
    { actor: owner, from: "2026-01-01", to: "2026-01-31" },
    depsOf(world(MAXIMUM_STATEMENT_ROWS)),
  );

  expectEqual(atCeiling.rowCount, MAXIMUM_STATEMENT_ROWS, "a period that carries the ceiling carries it");

  const over = await refusalOfAsync(() =>
    buildSettlementStatement(
      { actor: owner, from: "2026-01-01", to: "2026-01-31" },
      depsOf(world(MAXIMUM_STATEMENT_ROWS + 1)),
    ),
  );

  expectEqual(over.rule, SETTLEMENT_STATEMENT_RULES.statement_too_long, "one more than the ceiling is a period, not a file");
  expectEqual(over.field, "period", "and the refusal names the period, because the period is what is too wide");
}

async function checkTenancy(): Promise<void> {
  const db = statementWorld();
  const other = actorOf(["owner"], COMPANY_B);

  const statement = await buildSettlementStatement(
    { actor: other, from: "2026-11-01", to: "2026-11-03" },
    depsOf(db),
  );

  // Each merchant reads its own book: the other merchant's statement carries the other merchant's
  // money and none of this merchant's.
  expectEqual(statement.rowCount, 1, "the other merchant reads its own history, one movement here");
  expect(statement.csv.includes("80.0000"), "and the file carries the other merchant's own movement");
  expect(!statement.csv.includes("125.0000") && !statement.csv.includes("90.0000"), "and none of this merchant's money");

  // A platform account with no merchant has no statement to read.
  const refusal = await refusalOfAsync(() =>
    buildSettlementStatement({ actor: actorOf(["owner"], null), from: "2026-11-01", to: "2026-11-03" }, depsOf(db)),
  );

  expectEqual(refusal.code, "PERMISSION_DENIED", "an actor with no merchant is refused before any read");
}

async function checkRoles(): Promise<void> {
  const db = statementWorld();

  for (const role of ["support", "finance_ops", "ceo"] as const) {
    const refusal = await refusalOfAsync(() =>
      buildSettlementStatement(
        { actor: actorOf([role], COMPANY_A), from: "2026-11-01", to: "2026-11-03" },
        depsOf(db),
      ),
    );

    expectEqual(refusal.code, "PERMISSION_DENIED", `${role} cannot read the statement`);
  }
}

async function checkPeriod(): Promise<void> {
  const db = statementWorld();

  const reversed = await refusalOfAsync(() =>
    buildSettlementStatement({ actor: owner, from: "2026-11-03", to: "2026-11-01" }, depsOf(db)),
  );

  expectEqual(reversed.rule, SETTLEMENT_STATEMENT_RULES.period_reversed, "a first day after the last day is a reversed period");
  expectEqual(reversed.field, "to", "and the day it names is the last one, the one that does not fit");

  const malformed = await refusalOfAsync(() =>
    buildSettlementStatement({ actor: owner, from: "11/01/2026", to: "2026-11-03" }, depsOf(db)),
  );

  expectEqual(malformed.rule, SETTLEMENT_STATEMENT_RULES.invalid_format, "a day not in the form is refused");
  expectEqual(malformed.field, "from", "and the field it names is the day that is not");

  const impossible = await refusalOfAsync(() =>
    buildSettlementStatement({ actor: owner, from: "2026-02-30", to: "2026-11-03" }, depsOf(db)),
  );

  expectEqual(impossible.rule, SETTLEMENT_STATEMENT_RULES.invalid_format, "and a day that is not a day of its month is refused the same way");

  const absent = await refusalOfAsync(() =>
    buildSettlementStatement({ actor: owner, from: null, to: "2026-11-03" }, depsOf(db)),
  );

  expectEqual(absent.rule, SETTLEMENT_STATEMENT_RULES.required, "a day the form did not send is a refusal, not a guess");
  expectEqual(absent.field, "from", "and it names the day it is missing");
}

async function checkWriter(): Promise<void> {
  const csv = statementCsvOf([
    { date: "2026-11-01T09:00:00.000Z", label: "Payment", amount: "100.0000", currency: "USD", description: "Card sale, settled" },
    { date: "2026-11-01T09:01:00.000Z", label: "Payment", amount: "50.0000", currency: "USD", description: 'A "quoted" sale' },
    { date: "2026-11-01T09:02:00.000Z", label: "Payment", amount: "25.0000", currency: "USD", description: "A sale\non two lines" },
    { date: "2026-11-01T09:03:00.000Z", label: "Payment", amount: "10.0000", currency: "USD", description: "" },
  ]);

  const rows = csv.split("\r\n");

  expectEqual(rows[1], "2026-11-01T09:00:00.000Z,Payment,100.0000,USD,\"Card sale, settled\"", "a comma in a word quotes the field");
  expectEqual(rows[2], "2026-11-01T09:01:00.000Z,Payment,50.0000,USD,\"A \"\"quoted\"\" sale\"", "a quote in a word is quoted and doubled");
  expectEqual(rows[3], "2026-11-01T09:02:00.000Z,Payment,25.0000,USD,\"A sale\non two lines\"", "a line break in a word is quoted, and the line stays in the field");
  expectEqual(rows[4], "2026-11-01T09:03:00.000Z,Payment,10.0000,USD,", "an empty word is an empty cell, and nothing else");

  // A statement the platform writes is one its own reader reads back: the round trip, the import's
  // reader on the export's file.
  const { readCsv } = await import("../clients/csv.ts");
  const back = readCsv(csv);

  expect(back.ok, "the platform's own reader reads the file back");

  if (back.ok) {
    expectEqual(back.records.length, 5, "and it reads the header and the four lines, not more");
    expectEqual(back.records[1]?.fields[4], "Card sale, settled", "the comma comes back inside the word it was in");
    expectEqual(back.records[2]?.fields[4], 'A "quoted" sale', "and the quote comes back one, not two");
    expectEqual(back.records[3]?.fields[4], "A sale\non two lines", "and the line break stays in the field it was in");
  }
}

async function checkRoute(): Promise<void> {
  const source = await readFile("app/api/settlements/statements/route.ts", "utf8");

  expect(source.includes("readRequestActor("), "the route reads the session, and only the session, for its authorization");
  expect(!source.includes("requireCsrfToken("), "and a read that changes nothing asks for no token");
  expect(!source.includes("request.text()"), "and a read parses no body, for the reason the auth gate names");
  expect(source.includes("text/csv"), "and the answer is the file, as the file's own type");
  expect(source.includes("attachment; filename="), "and it is an attachment, named with the period it covers");
  expect(source.includes("no-store"), "and no cache between the merchant and the server keeps a copy of the money");
  expect(source.includes("force-dynamic"), "and the read is per request, never cached with a token");
  expect(!/parameters\.get\("company/.test(source), "and the company is on no parameter at all");
}

/* ---- the run ---- */

async function run(): Promise<void> {
  await checkVocabulary();
  await checkWorld();
  await checkBoundary();
  await checkClosedPayable();
  await checkTieOrder();
  await checkCeiling();
  await checkTenancy();
  await checkRoles();
  await checkPeriod();
  await checkWriter();
  await checkRoute();

  if (failures.length > 0) {
    process.stderr.write(`settlement statement gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `settlement statement gate passed: ${String(checks)} checks, section 17, the merchant's own ` +
      `settlement balance one line per movement, the eight words section 17 names, newest first, ` +
      `a period in days and a file its own reader reads back\n`,
  );
}

await run();
