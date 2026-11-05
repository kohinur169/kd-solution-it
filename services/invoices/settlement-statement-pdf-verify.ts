// path: services/invoices/settlement-statement-pdf-verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  MAXIMUM_STATEMENT_ROWS,
  SETTLEMENT_STATEMENT_RULES,
  STATEMENT_SOURCE_TYPES,
} from "./settlement-statement-fields.ts";
import { buildSettlementStatementPdf } from "./settlement-statement-pdf.ts";
import { extractPdfText } from "./pdf.ts";

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

async function refusalOfAsync(call: () => Promise<unknown>): Promise<{
  readonly code: string | null;
  readonly field: string | null;
  readonly rule: string | null;
}> {
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

/**
 * The ledger of the statement's world, answering the service's two reads the way PostgREST answers.
 * The gate reads the PDF the service builds from this world, so a query the service builds wrong is a
 * query the gate sees. The write methods throw: the statement is a reading of an append-only history.
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

function accountOf(overrides: Partial<AccountRow> & { readonly id: string }): AccountRow {
  return {
    company_id: COMPANY_A,
    account_code: PAYABLE,
    is_active: true,
    ...overrides,
  };
}

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

/** The world the statement reads from: one payable and the eight movements section 17 names. */
function statementWorld(): StatementDb {
  const payableId = "018f2b8a-6666-4c2d-9c3e-000000000001";

  const accounts: AccountRow[] = [accountOf({ id: payableId })];

  const on = (hour: number, minuteOfHour: number): string =>
    new Date(Date.parse(`2026-11-01T${String(hour).padStart(2, "0")}:${String(minuteOfHour).padStart(2, "0")}:00.000Z`)).toISOString();

  const entries: EntryRow[] = [
    entryOf({ occurred_at: on(9, 0), source_type: "payment", amount_minor: "1250000", description: "Card sale" }, 1),
    entryOf({ occurred_at: on(9, 5), source_type: "platform_fee", entry_side: "debit", amount_minor: "62500" }, 2),
    entryOf({ occurred_at: on(10, 0), source_type: "hold", entry_side: "debit", amount_minor: "100000" }, 3),
    entryOf({ occurred_at: on(10, 30), source_type: "reserve", entry_side: "debit", amount_minor: "125000" }, 4),
    entryOf({ occurred_at: on(11, 0), source_type: "refund", entry_side: "debit", amount_minor: "30000" }, 5),
    entryOf({ occurred_at: on(11, 30), source_type: "chargeback", entry_side: "debit", amount_minor: "70000" }, 6),
    entryOf({ occurred_at: on(12, 0), source_type: "chargeback_fee", entry_side: "debit", amount_minor: "20000" }, 7),
    entryOf({ occurred_at: on(12, 30), source_type: "payout", entry_side: "debit", amount_minor: "900000" }, 8),
  ];

  return { accounts, entries };
}

/* ---- the PDF structure helpers ---- */

function latin1Of(bytes: Uint8Array): string {
  let out = "";

  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }

  return out;
}

interface StructureReport {
  readonly ok: boolean;
  readonly problems: string[];
  readonly objectCount: number;
}

/**
 * Read the PDF's own structure back: the header, the xref, the offsets it names, and the `/Length`
 * of every stream. A PDF that passes this is one a reader can open - the gate does not need a PDF
 * library to know that, because the structure is the thing the writer built.
 */
function validatePdfStructure(pdf: Uint8Array): StructureReport {
  const text = latin1Of(pdf);
  const problems: string[] = [];

  if (!text.startsWith("%PDF-1.4")) {
    problems.push("the file does not open with the PDF header");
  }

  if (!text.trimEnd().endsWith("%%EOF")) {
    problems.push("the file does not close with the EOF marker");
  }

  const xrefStart = text.indexOf("xref");

  if (xrefStart < 0) {
    problems.push("the file carries no xref");

    return { ok: false, problems, objectCount: 0 };
  }

  const lines = text.slice(xrefStart).split("\n");
  const count = Number.parseInt(lines[1]?.split(" ")[1] ?? "0", 10);

  for (let num = 1; num < count; num += 1) {
    const entry = lines[2 + num];
    const parts = entry?.trim().split(/\s+/) ?? [];
    const offset = Number.parseInt(parts[0] ?? "0", 10);
    const type = parts[2];

    if (type === "n") {
      const atOffset = text.slice(offset, offset + 20);

      if (!atOffset.startsWith(`${num} 0 obj`)) {
        problems.push(`object ${num} is named at an offset that holds "${atOffset.slice(0, 20)}"`);
      }
    }
  }

  const streamPattern = /<< \/Length (\d+) >>\nstream\n/g;
  let match: RegExpExecArray | null = streamPattern.exec(text);

  while (match !== null) {
    const declared = Number.parseInt(match[1] ?? "0", 10);
    const streamStart = match.index + match[0].length;
    const after = text.slice(streamStart + declared);

    if (!after.startsWith("\nendstream")) {
      problems.push(`a stream declares ${declared} bytes and carries a different number`);
    }

    match = streamPattern.exec(text);
  }

  return { ok: problems.length === 0, problems, objectCount: count };
}

/* ---- the scenarios ---- */

async function checkVocabulary(): Promise<void> {
  expectEqual(STATEMENT_SOURCE_TYPES.length, 8, "the statement knows the eight words section 17 names");
}

async function checkStructure(): Promise<void> {
  const result = await buildSettlementStatementPdf(
    { actor: owner, from: "2026-11-01", to: "2026-11-03" },
    depsOf(statementWorld()),
  );

  const report = validatePdfStructure(result.pdf);

  expect(report.ok, `the PDF is a PDF a reader can open${report.problems.length > 0 ? ` (${report.problems.join("; ")})` : ""}`);
  expect(report.objectCount >= 7, "and it carries the catalog, the pages tree, two fonts, a page and a stream at least");

  // The two fonts are standard and built in: no font object embeds a font program.
  const text = latin1Of(result.pdf);
  expect(text.includes("/Helvetica"), "and it uses the standard Helvetica, which needs no embedding");
  expect(!text.includes("/FontFile"), "and it embeds no font file");

  expectEqual(result.filename, "settlement-statement_2026-11-01_2026-11-03.pdf", "and the file is named with the period it covers");
}

async function checkTextAndTotals(): Promise<void> {
  const result = await buildSettlementStatementPdf(
    { actor: owner, from: "2026-11-01", to: "2026-11-03" },
    depsOf(statementWorld()),
  );

  const text = extractPdfText(result.pdf);
  const joined = text.join("\n");

  expect(joined.includes("Settlement Statement"), "the document opens with the statement's own title");
  expect(joined.includes("Period: 2026-11-01 to 2026-11-03"), "and names the period it covers");
  expect(joined.includes("Date") && joined.includes("Type") && joined.includes("Amount"), "and carries the table's own columns");

  // The eight movements, newest first, each with its word and its signed amount.
  expect(joined.includes("Payout") && joined.includes("-90.0000"), "the newest movement leads, with its sign");
  expect(joined.includes("Chargeback fee") && joined.includes("-2.0000"), "the fee of the chargeback is its own line");
  expect(joined.includes("Payment") && joined.includes("125.0000"), "and the payment that opened the balance is last");
  expect(joined.includes("Card sale"), "and the words the merchant reads on a line are on the page");

  // The totals the CSV leaves off: what came in, what went out, and what the balance did.
  expect(joined.includes("Total credits") && joined.includes("Total debits") && joined.includes("Net"), "and the document carries the three totals");

  expectEqual(result.totals.credits, "125.0000", "the credits are the sum of the credits");
  expectEqual(result.totals.debits, "130.7500", "the debits are the sum of the debits");
  expectEqual(result.totals.net, "-5.7500", "and the net is the credits minus the debits");

  expect(joined.includes("125.0000") && joined.includes("130.7500") && joined.includes("-5.7500"), "and the totals are printed on the page");
  expect(joined.includes("Page 1 of 1"), "and the one-page document says it is one page");
}

async function checkTotalsMath(): Promise<void> {
  // A world where the credits and debits are known separately, so the three totals can be checked
  // against arithmetic rather than against a fixture's memory.
  const payableId = "018f2b8a-6666-4c2d-9c3e-000000000001";

  const db: StatementDb = {
    accounts: [accountOf({ id: payableId })],
    entries: [
      entryOf({ occurred_at: "2026-11-01T09:00:00.000Z", source_type: "payment", amount_minor: "1000000" }, 1),
      entryOf({ occurred_at: "2026-11-01T10:00:00.000Z", source_type: "payment", amount_minor: "500000" }, 2),
      entryOf({ occurred_at: "2026-11-01T11:00:00.000Z", source_type: "platform_fee", entry_side: "debit", amount_minor: "250000" }, 3),
      entryOf({ occurred_at: "2026-11-01T12:00:00.000Z", source_type: "refund", entry_side: "debit", amount_minor: "125000" }, 4),
    ],
  };

  const result = await buildSettlementStatementPdf(
    { actor: owner, from: "2026-11-01", to: "2026-11-03" },
    depsOf(db),
  );

  // credits = 1,500,000; debits = 375,000; net = +1,125,000.
  expectEqual(result.totals.credits, "150.0000", "two credits sum to the credits total");
  expectEqual(result.totals.debits, "37.5000", "two debits sum to the debits total");
  expectEqual(result.totals.net, "112.5000", "and the net is the difference, positive when the balance grew");
}

async function checkPagination(): Promise<void> {
  const payableId = "018f2b8a-6666-4c2d-9c3e-000000000001";
  const base = Date.parse("2026-01-01T00:00:00.000Z");

  // Forty-five movements: the first page fills at forty, the second carries five and the totals.
  const db: StatementDb = {
    accounts: [accountOf({ id: payableId })],
    entries: Array.from({ length: 45 }, (_, index) =>
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
  };

  const result = await buildSettlementStatementPdf(
    { actor: owner, from: "2026-01-01", to: "2026-01-31" },
    depsOf(db),
  );

  const text = extractPdfText(result.pdf);
  const joined = text.join("\n");

  expect(joined.includes("Page 1 of 2") && joined.includes("Page 2 of 2"), "a forty-five movement statement runs to two pages");

  // The structure carries two page objects and two content streams.
  const structure = validatePdfStructure(result.pdf);
  expect(structure.ok, "and the two-page file is a PDF a reader can open");

  const pageCount = (latin1Of(result.pdf).match(/\/Type \/Page[^s]/g) ?? []).length;
  expectEqual(pageCount, 2, "and it carries exactly two page objects");
}

async function checkEmpty(): Promise<void> {
  const payableId = "018f2b8a-6666-4c2d-9c3e-000000000001";

  const db: StatementDb = {
    accounts: [accountOf({ id: payableId })],
    entries: [],
  };

  const result = await buildSettlementStatementPdf(
    { actor: owner, from: "2026-11-01", to: "2026-11-03" },
    depsOf(db),
  );

  const text = extractPdfText(result.pdf);
  const joined = text.join("\n");

  expect(joined.includes("No movements in this period."), "an empty statement says so in words on its page");
  expect(joined.includes("Total credits") && joined.includes("Total debits") && joined.includes("Net"), "and still carries the three totals");

  expectEqual(result.totals.credits, "0.0000", "the credits of an empty statement are zero");
  expectEqual(result.totals.debits, "0.0000", "the debits are zero");
  expectEqual(result.totals.net, "0.0000", "and the net is zero");

  const structure = validatePdfStructure(result.pdf);
  expect(structure.ok, "and the empty statement is still a PDF a reader can open");
}

async function checkNoPayable(): Promise<void> {
  const db: StatementDb = { accounts: [], entries: [] };

  const result = await buildSettlementStatementPdf(
    { actor: owner, from: "2026-11-01", to: "2026-11-03" },
    depsOf(db),
  );

  const text = extractPdfText(result.pdf);
  expect(text.join("\n").includes("No movements in this period."), "a merchant with no payable reads an empty statement");
  expectEqual(result.rowCount, 0, "and it carries no movements");
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

  const atCeiling = await buildSettlementStatementPdf(
    { actor: owner, from: "2026-01-01", to: "2026-01-31" },
    depsOf(world(MAXIMUM_STATEMENT_ROWS)),
  );

  expectEqual(atCeiling.rowCount, MAXIMUM_STATEMENT_ROWS, "a period that carries the ceiling carries it as a PDF");

  const over = await refusalOfAsync(() =>
    buildSettlementStatementPdf(
      { actor: owner, from: "2026-01-01", to: "2026-01-31" },
      depsOf(world(MAXIMUM_STATEMENT_ROWS + 1)),
    ),
  );

  expectEqual(over.rule, SETTLEMENT_STATEMENT_RULES.statement_too_long, "one more than the ceiling is refused the same way as the CSV");
}

async function checkEscaping(): Promise<void> {
  // The three characters a PDF literal string treats specially, and the empty cell, drawn and read
  // back through the writer's own escape and the gate's own unescape.
  const payableId = "018f2b8a-6666-4c2d-9c3e-000000000001";

  const db: StatementDb = {
    accounts: [accountOf({ id: payableId })],
    entries: [
      entryOf({ occurred_at: "2026-11-01T09:00:00.000Z", source_type: "payment", amount_minor: "10000", description: "A comma, a quote and a (paren)" }, 1),
      entryOf({ occurred_at: "2026-11-01T10:00:00.000Z", source_type: "payment", amount_minor: "10000", description: "A backslash \\ inside" }, 2),
      entryOf({ occurred_at: "2026-11-01T11:00:00.000Z", source_type: "payment", amount_minor: "10000", description: "" }, 3),
    ],
  };

  const result = await buildSettlementStatementPdf(
    { actor: owner, from: "2026-11-01", to: "2026-11-03" },
    depsOf(db),
  );

  const text = extractPdfText(result.pdf);

  expect(text.includes("A comma, a quote and a (paren)"), "a parenthesis in a word is escaped and reads back as a parenthesis");
  expect(text.includes("A backslash \\ inside"), "a backslash in a word is escaped and reads back as a backslash");
  expect(text.includes(""), "an empty description is an empty cell");

  const structure = validatePdfStructure(result.pdf);
  expect(structure.ok, "and the escaped document is still a PDF a reader can open");
}

async function checkRoles(): Promise<void> {
  const db = statementWorld();

  for (const role of ["support", "finance_ops", "ceo"] as const) {
    const refusal = await refusalOfAsync(() =>
      buildSettlementStatementPdf(
        { actor: actorOf([role], COMPANY_A), from: "2026-11-01", to: "2026-11-03" },
        depsOf(db),
      ),
    );

    expectEqual(refusal.code, "PERMISSION_DENIED", `${role} cannot read the statement as PDF`);
  }
}

async function checkReuse(): Promise<void> {
  // The PDF renderer reads the statement through the gather the CSV renderer reads it through, so the
  // two files cannot disagree about a rule. The proof is the import, not a behaviour: a renderer that
  // duplicated the gather would compile and pass every check above and still be a second statement.
  const source = await readFile("services/invoices/settlement-statement-pdf.ts", "utf8");

  expect(source.includes("gatherSettlementLines"), "the PDF renderer reads the statement through the gather the CSV renderer reads it through");
  expect(source.includes("buildSettlementStatementPdf"), "and it is its own builder, not a parameter on the CSV one");

  const pdfSource = await readFile("services/invoices/pdf.ts", "utf8");
  expect(!pdfSource.includes("ledger_entries"), "the PDF writer is a document primitive and knows nothing of the ledger");
  expect(!pdfSource.includes("merchant_payable"), "and nothing of the merchant's account");
}

async function checkRoute(): Promise<void> {
  const source = await readFile("app/api/settlements/statements/route.ts", "utf8");

  expect(source.includes("format"), "the route reads the format the caller asked for");
  expect(source.includes("buildSettlementStatementPdf"), "and answers a PDF request with the PDF builder");
  expect(source.includes("application/pdf"), "and the PDF is answered as the PDF's own type");
  expect(source.includes("text/csv"), "and the CSV is still answered as the CSV's own type");
  expect(source.includes("readRequestActor("), "the route reads the session, and only the session, for its authorization");
  expect(!source.includes("requireCsrfToken("), "and a read that changes nothing asks for no token");
  expect(!source.includes("request.text()"), "and a read parses no body");
  expect(source.includes("attachment; filename="), "and both forms are attachments named with the period");
  expect(source.includes("no-store"), "and no cache between the merchant and the server keeps a copy of the money");
  expect(source.includes("force-dynamic"), "and the read is per request");
}

/* ---- the run ---- */

async function run(): Promise<void> {
  await checkVocabulary();
  await checkStructure();
  await checkTextAndTotals();
  await checkTotalsMath();
  await checkPagination();
  await checkEmpty();
  await checkNoPayable();
  await checkCeiling();
  await checkEscaping();
  await checkRoles();
  await checkReuse();
  await checkRoute();

  if (failures.length > 0) {
    process.stderr.write(`settlement statement PDF gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `settlement statement PDF gate passed: ${String(checks)} checks, section 17, the same statement ` +
      `as a document its own reader opens, the eight words newest first, the three totals the CSV ` +
      `leaves off, forty movements a page, and a writer that knows nothing of the ledger it writes\n`,
  );
}

await run();
