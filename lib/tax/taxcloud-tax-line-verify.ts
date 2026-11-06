// path: lib/tax/taxcloud-tax-line-verify.ts

/**
 * The gate for storing the tax line.
 *
 * Run directly, because the TaxCloud block owns `lib/tax/` and not `package.json`:
 *
 *   node lib/tax/taxcloud-tax-line-verify.ts
 *
 * Nine sections: `0121` read as the schema it is, the rate, the rows, the writer, the in-memory store's
 * own invariants, the payment's share, the rest adapter's call sequence and its compensation, the
 * audit entries, and the source.
 *
 * Nothing reaches a database or a network: the store is the in-memory one, the rest client is a
 * recorder, and the audit trail is the platform's in-memory one.
 */

import { readFileSync } from "node:fs";
import { AppError } from "../errors/app-error.ts";
import { createInMemoryAuditTrail } from "../auth/audit.ts";
import type { InMemoryAuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import type { RequestActor } from "../auth/types.ts";
import type { TaxCloudInvoiceTax } from "./taxcloud-invoice-tax.ts";
import {
  InMemoryTaxCloudTaxLineStore,
  TAXCLOUD_RATE_MAXIMUM_BP,
  TAXCLOUD_SETTLED_PAYMENT_STATUSES,
  TAXCLOUD_STORABLE_INVOICE_STATUS,
  TAXCLOUD_TAX_LINE_AUDIT_ACTIONS,
  TAXCLOUD_TAX_LINE_PROVIDER_KEY,
  TAXCLOUD_TAX_LINE_REQUIRED_COLUMNS,
  TAXCLOUD_TAX_LINE_STATUSES,
  TAXCLOUD_TAX_LINE_TABLES,
  createTaxCloudTaxLineRestStore,
  recordInvoiceTax,
  recordPaymentTax,
  taxCloudPaymentTaxOf,
  taxCloudRateBpOf,
  taxCloudTaxLineRowsOf,
} from "./taxcloud-tax-line.ts";
import type {
  TaxCloudInvoiceTaxStoreInput,
  TaxCloudPaymentTaxRow,
  RecordInvoiceTaxOptions,
} from "./taxcloud-tax-line.ts";

/* ---- the checking harness ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, name: string): void {
  checks += 1;
  if (condition !== true) failures.push(name);
}

function expectEqual(actual: unknown, expected: unknown, name: string): void {
  checks += 1;
  if (actual !== expected) failures.push(`${name} (read ${asText(actual)}, wanted ${asText(expected)})`);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (typeof value === "bigint") return value.toString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorCodeOf(action: () => void): string {
  try {
    action();
    return "no_error";
  } catch (error) {
    return error instanceof AppError ? error.code : "not_an_app_error";
  }
}

/* ---- fixtures ---- */

const NOW = 1_782_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPANY = "company_kd_tax_line_gate";
const OTHER_COMPANY = "company_kd_tax_line_other";
const OWNER_ID = "user_owner_tax_line_0001";
const SESSION_ID = "session_tax_line_0001";
const INVOICE_ID = "9a1b2c3d-4e5f-4061-8273-94a5b6c7d8e9";
const OTHER_INVOICE_ID = "ab2c3d4e-5f60-4172-9384-a5b6c7d8e9f0";
const LINE_ONE = "bc3d4e5f-6071-4283-a495-b6c7d8e9f0a1";
const LINE_TWO = "cd4e5f60-7182-4394-b5a6-c7d8e9f0a1b2";
const PAYMENT_ID = "de5f6071-8293-44a5-b6c7-d8e9f0a1b2c3";

function ownerActor(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: OWNER_ID,
    companyId: COMPANY,
    roles: ["owner"],
    sessionId: SESSION_ID,
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: NOW - DAY_MS,
    expiresAtEpochMs: NOW + DAY_MS,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: null,
    sessionFamilyId: null,
    mfaVerifiedAtEpochMs: NOW - DAY_MS,
    reauthenticatedAtEpochMs: NOW - DAY_MS,
    ...overrides,
  };
}

/** 1.5 of 10.75 plus 2 of 5.00: subtotal 261_250, no discount, tax 21_000, total 282_250. */
function taxOf(overrides: Partial<TaxCloudInvoiceTax> = {}): TaxCloudInvoiceTax {
  return {
    cartId: INVOICE_ID,
    currency: "USD",
    lines: [
      { itemId: LINE_ONE, index: 0, taxMinor: 13_000n, rate: 0.08125 },
      { itemId: LINE_TWO, index: 1, taxMinor: 8_000n, rate: 0.0825 },
    ],
    totalTaxMinor: 21_000n,
    transactionDate: "2026-11-07T10:00:00Z",
    ...overrides,
  };
}

function inputOf(overrides: Partial<TaxCloudInvoiceTaxStoreInput> = {}): TaxCloudInvoiceTaxStoreInput {
  return {
    actor: ownerActor(),
    invoice: {
      invoiceId: INVOICE_ID,
      status: "draft",
      version: 3,
      currency: "USD",
      subtotalMinor: 261_250n,
      discountMinor: 0n,
      taxMinor: 21_000n,
      totalMinor: 282_250n,
    },
    lines: [
      { invoiceItemId: LINE_ONE, index: 0, netMinor: 161_250n },
      { invoiceItemId: LINE_TWO, index: 1, netMinor: 100_000n, tic: 11_015 },
    ],
    tax: taxOf(),
    nowEpochMs: NOW,
    ...overrides,
  };
}

interface Fixture {
  readonly store: InMemoryTaxCloudTaxLineStore;
  readonly audit: InMemoryAuditTrail;
  readonly options: RecordInvoiceTaxOptions;
}

function fixtureOf(): Fixture {
  const store = new InMemoryTaxCloudTaxLineStore();
  const audit = createInMemoryAuditTrail();

  store.seedInvoice(INVOICE_ID, 0n, 3);
  store.seedInvoice(OTHER_INVOICE_ID, 0n, 1);

  return { store, audit, options: { store, audit } };
}

/* ---- section 1: the migration ---- */

function checkMigration(): void {
  const forward = readFileSync(new URL("../../migrations/0121_invoice_tax_lines.sql", import.meta.url), "utf8");
  const down = readFileSync(new URL("../../migrations/0121_invoice_tax_lines.down.sql", import.meta.url), "utf8");

  expectEqual(forward.split("\n")[0], "-- path: migrations/0121_invoice_tax_lines.sql", "the forward file names its own path");
  expectEqual(down.split("\n")[0], "-- path: migrations/0121_invoice_tax_lines.down.sql", "and so does the rollback");
  expectEqual(/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(forward), false, "the forward file is ASCII");
  expectEqual(/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(down), false, "the rollback is ASCII");
  expectEqual(forward.includes("create table public.invoice_tax_lines"), true, "the forward file creates the tax line table");
  expectEqual(forward.includes("alter table public.invoice_tax_lines enable row level security;"), true, "the table enforces row level security");
  expectEqual(forward.includes("create policy invoice_tax_lines_default_deny"), true, "and carries its default-deny policy");
  expectEqual(/create policy invoice_tax_lines_default_deny[\s\S]*?using \(false\)[\s\S]*?with check \(false\);/u.test(forward), true, "which refuses reads and writes alike");

  for (const column of TAXCLOUD_TAX_LINE_REQUIRED_COLUMNS) {
    expect(forward.includes(`${column} `) || forward.includes(`${column}\n`), `the table carries the ${column} column`);
  }

  const rules: readonly (readonly [string, string])[] = [
    ["the tax is never above what it taxed", "tax_minor >= 0 and tax_minor <= taxable_minor"],
    ["a rate is at most one hundred percent", "rate_bp >= 0 and rate_bp <= 10000"],
    ["the line index is bounded", "line_index >= 0 and line_index <= 999"],
    ["a TIC is bounded or absent", "tic is null or (tic >= 0 and tic <= 99999)"],
    ["the currency has a shape", "currency ~ '^[A-Z]{3}$'"],
    ["the provider is a closed vocabulary", "provider_key in ('taxcloud')"],
    ["the taxable amount is not negative", "taxable_minor >= 0"],
    ["one live row per line", "create unique index invoice_tax_lines_line_key"],
    ["the totals read the merchant and the instant", "create index invoice_tax_lines_company_idx"],
    ["the line's invoice is in one merchant", "foreign key (invoice_id, company_id)"],
    ["the line's own row is in one merchant", "foreign key (invoice_item_id, company_id)"],
    ["the pair the line references is unique", "constraint invoice_items_tenant_key unique (id, company_id)"],
    ["an issued invoice's tax line is frozen", "the tax line of an issued invoice is a fact and cannot be rewritten"],
    ["a removed line of an issued invoice is refused", "the tax line of an issued invoice is a fact and cannot be removed"],
    ["the guard runs on update and delete", "before update or delete on public.invoice_tax_lines"],
    ["the row metadata trigger is attached", "execute function public.set_row_metadata();"],
    ["the payment carries the collected tax", "alter table public.payments add column tax_minor bigint not null default 0;"],
    ["the payment's tax is bounded by its amount", "tax_minor >= 0 and tax_minor <= amount_minor"],
    ["a settled payment's tax is frozen", "the tax of a settled payment is collected money and cannot be rewritten"],
    ["the payment guard is attached", "create trigger payments_guard_tax_state"],
  ];

  for (const [name, needle] of rules) {
    expect(forward.includes(needle), `0121 states that ${name}`);
  }

  // The rollback is the inverse: the table, the column, the constraint and the two functions go.
  expect(down.includes("drop table if exists public.invoice_tax_lines;"), "the rollback drops the table");
  expect(down.includes("drop column if exists tax_minor"), "the rollback drops the payment's tax column");
  expect(down.includes("drop constraint if exists payments_tax_check"), "and its check");
  expect(down.includes("drop function if exists public.invoice_tax_lines_guard_issued();"), "and the tax line guard");
  expect(down.includes("drop function if exists public.payments_guard_tax_state();"), "and the payment guard");
  expect(down.includes("drop constraint if exists invoice_items_tenant_key"), "and the key it added to the lines");
  expectEqual(/create\s+table/iu.test(down), false, "a rollback creates nothing");

  // The forward file is append only, which is what the migrations gate reads as well.
  expectEqual(/\bdelete\s+from\b/iu.test(forward), false, "the forward file deletes no row");
  expectEqual(/\bdrop\s+table\b/iu.test(forward), false, "and drops no table");

  // The writer's own constants are the migration's, so the two cannot drift apart.
  expectEqual(TAXCLOUD_STORABLE_INVOICE_STATUS, "draft", "only a draft's tax is recalculated");
  expectEqual(TAXCLOUD_RATE_MAXIMUM_BP, 10_000, "a rate is at most one hundred percent");
  expectEqual(TAXCLOUD_TAX_LINE_PROVIDER_KEY, "taxcloud", "the provider key is the platform's");
  expectEqual(TAXCLOUD_TAX_LINE_TABLES.join(","), "invoice_tax_lines,invoices,payments", "three records, as section 7 asks");
  expect(TAXCLOUD_SETTLED_PAYMENT_STATUSES.includes("settled"), "a settled payment is frozen");
  expectEqual(TAXCLOUD_SETTLED_PAYMENT_STATUSES.length, 3, "and so are the two refunded states");
}

/* ---- section 2: the rate ---- */

function checkRate(): void {
  expectEqual(taxCloudRateBpOf(0.08125), 813, "eight and an eighth percent is 813 basis points");
  expectEqual(taxCloudRateBpOf(0.0825), 825, "eight and a quarter percent is 825");
  expectEqual(taxCloudRateBpOf(0.08), 800, "eight percent is 800");
  expectEqual(taxCloudRateBpOf(0), 0, "no rate is no basis points");
  expectEqual(taxCloudRateBpOf(null), 0, "an absent rate is no basis points");
  expectEqual(taxCloudRateBpOf(1), 10_000, "one hundred percent is the ceiling");
  expectEqual(taxCloudRateBpOf(0.00005), 1, "a half of a tenth of a basis point rounds up");
  expectEqual(taxCloudRateBpOf(0.00004), 0, "below a half rounds down");
  expectEqual(taxCloudRateBpOf(0.12345), 1_235, "a half of a basis point rounds away from zero");
  expectEqual(taxCloudRateBpOf(0.085555), 856, "a third decimal of a basis point still rounds");
  expectEqual(errorCodeOf(() => taxCloudRateBpOf(1.0001)), "VALIDATION_FAILED", "a rate above one is refused");
  expectEqual(errorCodeOf(() => taxCloudRateBpOf(-0.01)), "VALIDATION_FAILED", "a negative rate is refused");
  expectEqual(errorCodeOf(() => taxCloudRateBpOf(Number.NaN)), "VALIDATION_FAILED", "a rate that is not a number is refused");
  expectEqual(errorCodeOf(() => taxCloudRateBpOf(Number.POSITIVE_INFINITY)), "VALIDATION_FAILED", "and so is an infinite one");
}

/* ---- section 3: the rows ---- */

function checkRows(): void {
  const built = taxCloudTaxLineRowsOf(inputOf());

  expect("rows" in built, "a complete calculation is storable");

  const rows = "rows" in built ? built.rows : [];

  expectEqual(rows.length, 2, "one row per invoice line");
  expectEqual(rows[0]?.invoiceItemId, LINE_ONE, "the first row names its line");
  expectEqual(rows[0]?.lineIndex, 0, "and its index");
  expectEqual(rows[0]?.taxableMinor, 161_250n, "the taxable amount is the line's net");
  expectEqual(rows[0]?.taxMinor, 13_000n, "the tax is the answer's");
  expectEqual(rows[0]?.rateBp, 813, "the rate is basis points");
  expectEqual(rows[0]?.tic, null, "a line with no TIC stores none");
  expectEqual(rows[1]?.tic, 11_015, "a line with a TIC stores it");
  expectEqual(rows[0]?.companyId, COMPANY, "every row carries the merchant");
  expectEqual(rows[0]?.invoiceId, INVOICE_ID, "and the invoice");
  expectEqual(rows[0]?.currency, "USD", "and the currency");
  expectEqual(rows[0]?.providerKey, "taxcloud", "and the provider");
  expectEqual(rows[0]?.calculatedAtEpochMs, NOW, "and the instant it was calculated");

  const refusals: readonly (readonly [string, Partial<TaxCloudInvoiceTaxStoreInput>])[] = [
    ["an invoice that has left draft", { invoice: { ...inputOf().invoice, status: "sent" } }],
    ["a negative subtotal", { invoice: { ...inputOf().invoice, subtotalMinor: -1n, totalMinor: 20_999n } }],
    ["a discount above the subtotal", { invoice: { ...inputOf().invoice, discountMinor: 300_000n, totalMinor: -17_750n } }],
    ["a total that is not its parts", { invoice: { ...inputOf().invoice, totalMinor: 282_251n } }],
    ["a currency that is not the dollar", { invoice: { ...inputOf().invoice, currency: "EUR" } }],
    ["a version of zero", { invoice: { ...inputOf().invoice, version: 0 } }],
    ["an instant of zero", { nowEpochMs: 0 }],
    ["a line id that is not one", { lines: [{ invoiceItemId: "line one", index: 0, netMinor: 1n }], tax: taxOf({ lines: [{ itemId: "line one", index: 0, taxMinor: 0n, rate: 0 }], totalTaxMinor: 0n }), invoice: { ...inputOf().invoice, taxMinor: 0n, totalMinor: 261_250n } }],
    ["an index past the range", { lines: [{ invoiceItemId: LINE_ONE, index: 1_000, netMinor: 1n }] }],
    ["a negative net", { lines: [{ invoiceItemId: LINE_ONE, index: 0, netMinor: -1n }] }],
    ["a TIC out of range", { lines: [{ invoiceItemId: LINE_ONE, index: 0, netMinor: 1n, tic: 100_000 }] }],
    ["two lines with one key", { lines: [inputOf().lines[0] as never, inputOf().lines[0] as never] }],
    ["a cleared tax on a taxed invoice", { tax: null }],
    ["an answer in another currency", { tax: taxOf({ currency: "CAD" as unknown as "USD" }) }],
    ["an answer for another invoice", { tax: taxOf({ cartId: OTHER_INVOICE_ID }) }],
    ["an answer whose total is not the invoice's tax", { tax: taxOf({ totalTaxMinor: 21_001n }) }],
    ["an answer with one line too few", { tax: taxOf({ lines: [{ itemId: LINE_ONE, index: 0, taxMinor: 13_000n, rate: 0.08125 }], totalTaxMinor: 21_000n }) }],
    ["an answer that repeats a line", {
      tax: taxOf({
        lines: [
          { itemId: LINE_ONE, index: 0, taxMinor: 13_000n, rate: 0.08125 },
          { itemId: LINE_ONE, index: 0, taxMinor: 8_000n, rate: 0.0825 },
        ],
      }),
    }],
    ["an answer with no tax for a line", {
      tax: taxOf({
        lines: [
          { itemId: LINE_ONE, index: 5, taxMinor: 13_000n, rate: 0.08125 },
          { itemId: LINE_TWO, index: 1, taxMinor: 8_000n, rate: 0.0825 },
        ],
      }),
    }],
    ["a tax above what it taxed", { tax: taxOf({ lines: [{ itemId: LINE_ONE, index: 0, taxMinor: 200_000n, rate: 0.08 }, { itemId: LINE_TWO, index: 1, taxMinor: 8_000n, rate: 0.08 }], totalTaxMinor: 208_000n }), invoice: { ...inputOf().invoice, taxMinor: 208_000n, totalMinor: 469_250n } }],
    ["line amounts that do not add up", {
      tax: taxOf({
        lines: [
          { itemId: LINE_ONE, index: 0, taxMinor: 10_000n, rate: 0.08125 },
          { itemId: LINE_TWO, index: 1, taxMinor: 10_000n, rate: 0.0825 },
        ],
      }),
    }],
  ];

  for (const [name, patch] of refusals) {
    const answer = taxCloudTaxLineRowsOf(inputOf(patch));

    expect("reason" in answer, `the rows refuse ${name}`);
  }

  const duplicateKey = taxCloudTaxLineRowsOf({
    ...inputOf(),
    lines: [inputOf().lines[0] as never, inputOf().lines[0] as never],
  });

  expectEqual(
    "reason" in duplicateKey ? duplicateKey.reason : "",
    "two lines share an id and an index",
    "a duplicated line is refused for being duplicated, not for some later reason",
  );

  const shortAnswer = taxCloudTaxLineRowsOf(
    inputOf({ tax: taxOf({ lines: [{ itemId: LINE_ONE, index: 0, taxMinor: 13_000n, rate: 0.08125 }], totalTaxMinor: 21_000n }) }),
  );

  expectEqual(
    "reason" in shortAnswer ? shortAnswer.reason : "",
    "the answer does not carry one tax per invoice line",
    "an answer with the wrong number of lines is refused for its count",
  );

  const cleared = taxCloudTaxLineRowsOf({
    ...inputOf(),
    tax: null,
    invoice: { ...inputOf().invoice, taxMinor: 0n, totalMinor: 261_250n },
  });

  expectEqual("rows" in cleared ? cleared.rows.length : -1, 0, "a cleared tax stores no row");

  const noCompany = taxCloudTaxLineRowsOf({ ...inputOf(), actor: ownerActor({ companyId: null }) });

  expectEqual("reason" in noCompany ? noCompany.reason : "", "a tax line belongs to a merchant, and this account has none", "a platform account cannot store a merchant's tax");
}

/* ---- section 4: the writer ---- */

async function checkWriter(): Promise<void> {
  const fixture = fixtureOf();
  const stored = await recordInvoiceTax(inputOf(), fixture.options);

  expectEqual(stored.status, "stored", "a draft's tax is stored");
  expectEqual(stored.status === "stored" ? stored.taxMinor : null, 21_000n, "with the invoice's tax");
  expectEqual(stored.status === "stored" ? stored.lineCount : null, 2, "and its line count");
  expectEqual(stored.status === "stored" ? stored.totalMinor : null, 282_250n, "and the total the invoice now carries");
  expectEqual(fixture.audit.entries.length, 1, "one write is one audit entry");

  const entry = fixture.audit.entries[0];

  expectEqual(entry?.action, "taxcloud.tax_line_stored", "the action names the fact");
  expectEqual(entry?.actorUserId, OWNER_ID, "the actor is the session's");
  expectEqual(entry?.sessionId, SESSION_ID, "with the session");
  expectEqual(entry?.companyId, COMPANY, "and the merchant");
  expectEqual(entry?.entityType, "invoice", "against the invoice");
  expectEqual(entry?.entityId, INVOICE_ID, "and its id");
  expectEqual(entry?.payload["provider_key"], "taxcloud", "the payload names the provider");
  expectEqual(entry?.payload["tax_minor"], "21000", "and the tax as digits");
  expectEqual(entry?.payload["total_minor"], "282250", "and the total");
  expectEqual(entry?.payload["line_count"], 2, "and the line count");
  expectEqual(entry?.payload["invoice_version"], 4, "and the version the write produced");
  expectEqual(entry?.payload["outcome"], "stored", "and the outcome");

  const stored2 = await fixture.store.readTax(COMPANY, INVOICE_ID);

  expectEqual(stored2.taxMinor, 21_000n, "the invoice's tax moved");
  expectEqual(stored2.lines.length, 2, "the lines were written");

  const again = await recordInvoiceTax(inputOf({ invoice: { ...inputOf().invoice, version: 4 } }), fixture.options);

  expectEqual(again.status, "unchanged", "a second calculation of the same answer writes nothing");
  expectEqual(fixture.audit.entries.length, 1, "and audits nothing");
  expectEqual((await fixture.store.readTax(COMPANY, INVOICE_ID)).lines.length, 2, "and leaves the lines alone");

  // A recalculation replaces the breakdown rather than stacking a second one on top of the first.
  const changed = inputOf({
    invoice: { ...inputOf().invoice, version: 4, taxMinor: 20_000n, totalMinor: 281_250n },
    tax: taxOf({
      lines: [
        { itemId: LINE_ONE, index: 0, taxMinor: 12_000n, rate: 0.0744 },
        { itemId: LINE_TWO, index: 1, taxMinor: 8_000n, rate: 0.08 },
      ],
      totalTaxMinor: 20_000n,
    }),
  });
  const recalculated = await recordInvoiceTax(changed, fixture.options);

  expectEqual(recalculated.status, "stored", "a recalculation is stored");
  expectEqual(fixture.audit.entries.length, 2, "and audited");
  expectEqual(fixture.store.allRows().length, 4, "the old rows stay as history");
  expectEqual(
    fixture.store.allRows().filter((row) => row.deletedAtEpochMs === null).length,
    2,
    "but only two of them are live",
  );
  expectEqual((await fixture.store.readTax(COMPANY, INVOICE_ID)).taxMinor, 20_000n, "the invoice carries the new tax");

  // Clearing: collection turned off, the invoice keeps no tax and no rows. It is a change only when
  // there was a tax, so the fixture stores one first.
  const clearedFixture = fixtureOf();

  await recordInvoiceTax(inputOf(), clearedFixture.options);

  const cleared = await recordInvoiceTax(
    { ...inputOf(), tax: null, invoice: { ...inputOf().invoice, version: 4, taxMinor: 0n, totalMinor: 261_250n } },
    clearedFixture.options,
  );

  expectEqual(cleared.status, "cleared", "a cleared tax says so");
  expectEqual(cleared.status === "cleared" ? cleared.totalMinor : null, 261_250n, "and answers the new total");
  expectEqual(clearedFixture.audit.entries[1]?.action, "taxcloud.tax_line_cleared", "the second audit entry names the clearing");
  expectEqual(clearedFixture.audit.entries[1]?.payload["outcome"], "cleared", "and its outcome");
  expectEqual((await clearedFixture.store.readTax(COMPANY, INVOICE_ID)).taxMinor, 0n, "the invoice carries no tax");
  expectEqual(clearedFixture.store.allRows().filter((row) => row.deletedAtEpochMs === null).length, 0, "and no live line");

  // A refusal writes nothing and audits nothing.
  const refusedFixture = fixtureOf();
  const refused = await recordInvoiceTax(inputOf({ invoice: { ...inputOf().invoice, status: "paid" } }), refusedFixture.options);

  expectEqual(refused.status, "refused", "an issued invoice is refused");
  expectEqual(
    refused.status === "refused" ? refused.reason : "",
    "the tax of an invoice that has left draft is a fact and is not recalculated",
    "with the sentence that says why",
  );
  expectEqual(refusedFixture.audit.entries.length, 0, "and nothing is audited");
  expectEqual((await refusedFixture.store.readTax(COMPANY, INVOICE_ID)).lines.length, 0, "and nothing is written");

  // A lost race writes nothing and audits nothing.
  const raced = fixtureOf();

  raced.store.seedInvoice(INVOICE_ID, 0n, 9);

  const conflict = await recordInvoiceTax(inputOf(), raced.options);

  expectEqual(conflict.status, "conflict", "a stale version is a conflict");
  expectEqual(raced.audit.entries.length, 0, "and is not audited");
  expectEqual(raced.store.allRows().length, 0, "and writes no row");

  // A caller with no company cannot write at all.
  const noCompanyFixture = fixtureOf();
  const noCompany = await recordInvoiceTax(
    { ...inputOf(), actor: ownerActor({ companyId: null }) },
    noCompanyFixture.options,
  );

  expectEqual(noCompany.status, "refused", "a platform account is refused rather than throwing");
  expectEqual(noCompanyFixture.audit.entries.length, 0, "and writes no audit entry");
}

/* ---- section 5: the payment's share ---- */

function checkPaymentShare(): void {
  const total = 1_000_000n;
  const tax = 62_500n;
  const first = taxCloudPaymentTaxOf({
    paymentMinor: 333_300n,
    invoiceTotalMinor: total,
    invoiceTaxMinor: tax,
    paidBeforeMinor: 0n,
    collectedTaxBeforeMinor: 0n,
  });
  const second = taxCloudPaymentTaxOf({
    paymentMinor: 333_300n,
    invoiceTotalMinor: total,
    invoiceTaxMinor: tax,
    paidBeforeMinor: 333_300n,
    collectedTaxBeforeMinor: 20_831n,
  });
  const third = taxCloudPaymentTaxOf({
    paymentMinor: 333_400n,
    invoiceTotalMinor: total,
    invoiceTaxMinor: tax,
    paidBeforeMinor: 666_600n,
    collectedTaxBeforeMinor: 41_662n,
  });

  expectEqual(("taxMinor" in first ? first.taxMinor : -1n), 20_831n, "the first part collects its rounded share");
  expectEqual(("taxMinor" in second ? second.taxMinor : -1n), 20_831n, "the second part the same");
  expectEqual(("taxMinor" in third ? third.taxMinor : -1n), 20_838n, "the last part takes the remainder");
  expectEqual(
    (("taxMinor" in first ? first.taxMinor : 0n)) + (("taxMinor" in second ? second.taxMinor : 0n)) + (("taxMinor" in third ? third.taxMinor : 0n)),
    tax,
    "and the three parts are the whole tax",
  );

  const half = taxCloudPaymentTaxOf({ paymentMinor: 500_000n, invoiceTotalMinor: total, invoiceTaxMinor: 1n, paidBeforeMinor: 0n, collectedTaxBeforeMinor: 0n });
  const tiny = taxCloudPaymentTaxOf({ paymentMinor: 1n, invoiceTotalMinor: 3n, invoiceTaxMinor: 1n, paidBeforeMinor: 0n, collectedTaxBeforeMinor: 0n });
  const late = taxCloudPaymentTaxOf({ paymentMinor: 100_000n, invoiceTotalMinor: total, invoiceTaxMinor: tax, paidBeforeMinor: 0n, collectedTaxBeforeMinor: tax });

  expectEqual("taxMinor" in half ? half.taxMinor : -1n, 1n, "a half of a one unit tax rounds away from zero");
  expectEqual("taxMinor" in tiny ? tiny.taxMinor : -1n, 0n, "a third of a one unit tax collects nothing yet");
  expectEqual("taxMinor" in late ? late.taxMinor : -1n, 0n, "a payment after the tax was collected collects nothing");

  // Three payments of one minor unit on a three unit invoice: only the remainder can collect the tax,
  // because each rounded share of a third is nothing.
  const tinyFirst = taxCloudPaymentTaxOf({ paymentMinor: 1n, invoiceTotalMinor: 3n, invoiceTaxMinor: 1n, paidBeforeMinor: 0n, collectedTaxBeforeMinor: 0n });
  const tinySecond = taxCloudPaymentTaxOf({ paymentMinor: 1n, invoiceTotalMinor: 3n, invoiceTaxMinor: 1n, paidBeforeMinor: 1n, collectedTaxBeforeMinor: 0n });
  const tinyLast = taxCloudPaymentTaxOf({ paymentMinor: 1n, invoiceTotalMinor: 3n, invoiceTaxMinor: 1n, paidBeforeMinor: 2n, collectedTaxBeforeMinor: 0n });

  expectEqual("taxMinor" in tinyFirst ? tinyFirst.taxMinor : -1n, 0n, "a third of a one unit tax collects nothing");
  expectEqual("taxMinor" in tinySecond ? tinySecond.taxMinor : -1n, 0n, "and the second third too");
  expectEqual("taxMinor" in tinyLast ? tinyLast.taxMinor : -1n, 1n, "and the last payment takes the whole of it");
  expectEqual(
    ("taxMinor" in tinyFirst ? tinyFirst.taxMinor : 0n) +
      ("taxMinor" in tinySecond ? tinySecond.taxMinor : 0n) +
      ("taxMinor" in tinyLast ? tinyLast.taxMinor : 0n),
    1n,
    "so three payments collect the one unit exactly, which no rounded share would",
  );

  const refusals: readonly (readonly [string, Parameters<typeof taxCloudPaymentTaxOf>[0]])[] = [
    ["an invoice with no total", { paymentMinor: 1n, invoiceTotalMinor: 0n, invoiceTaxMinor: 0n, paidBeforeMinor: 0n, collectedTaxBeforeMinor: 0n }],
    ["a negative tax", { paymentMinor: 1n, invoiceTotalMinor: 10n, invoiceTaxMinor: -1n, paidBeforeMinor: 0n, collectedTaxBeforeMinor: 0n }],
    ["a tax above the total", { paymentMinor: 1n, invoiceTotalMinor: 10n, invoiceTaxMinor: 11n, paidBeforeMinor: 0n, collectedTaxBeforeMinor: 0n }],
    ["a payment of nothing", { paymentMinor: 0n, invoiceTotalMinor: 10n, invoiceTaxMinor: 1n, paidBeforeMinor: 0n, collectedTaxBeforeMinor: 0n }],
    ["more paid than the invoice owes", { paymentMinor: 1n, invoiceTotalMinor: 10n, invoiceTaxMinor: 1n, paidBeforeMinor: 11n, collectedTaxBeforeMinor: 0n }],
    ["more collected than the tax", { paymentMinor: 1n, invoiceTotalMinor: 10n, invoiceTaxMinor: 1n, paidBeforeMinor: 0n, collectedTaxBeforeMinor: 2n }],
    ["an overpayment", { paymentMinor: 11n, invoiceTotalMinor: 10n, invoiceTaxMinor: 1n, paidBeforeMinor: 0n, collectedTaxBeforeMinor: 0n }],
  ];

  for (const [name, input] of refusals) {
    expect("reason" in taxCloudPaymentTaxOf(input), `the share refuses ${name}`);
  }
}

async function checkPaymentWrite(): Promise<void> {
  const fixture = fixtureOf();
  const payment: TaxCloudPaymentTaxRow = {
    companyId: COMPANY,
    paymentId: PAYMENT_ID,
    invoiceId: INVOICE_ID,
    amountMinor: 333_300n,
    taxMinor: 0n,
    status: "captured",
    version: 2,
  };

  fixture.store.seedPayment(payment);

  const stored = await recordPaymentTax(
    {
      actor: ownerActor(),
      companyId: COMPANY,
      paymentId: PAYMENT_ID,
      invoiceId: INVOICE_ID,
      paymentMinor: 333_300n,
      paymentStatus: "captured",
      paymentVersion: 2,
      invoiceTotalMinor: 1_000_000n,
      invoiceTaxMinor: 62_500n,
      paidBeforeMinor: 0n,
      collectedTaxBeforeMinor: 0n,
      nowEpochMs: NOW,
    },
    fixture.options,
  );

  expectEqual(stored.status, "stored", "a captured payment records the tax it collected");
  expectEqual(stored.status === "stored" ? stored.taxMinor : null, 20_831n, "its share, exactly");
  expectEqual(fixture.audit.entries.length, 1, "with one audit entry");
  expectEqual(fixture.audit.entries[0]?.action, "taxcloud.payment_tax_stored", "named for the fact");
  expectEqual(fixture.audit.entries[0]?.entityType, "payment", "against the payment");
  expectEqual(fixture.audit.entries[0]?.entityId, PAYMENT_ID, "and the payment's id");
  expectEqual(fixture.audit.entries[0]?.payload["tax_minor"], "20831", "with the tax as digits");
  expectEqual(fixture.audit.entries[0]?.payload["invoice_id"], INVOICE_ID, "and the invoice it belongs to");
  expectEqual((await fixture.store.readPayment(COMPANY, PAYMENT_ID))?.taxMinor, 20_831n, "and the row moved");

  const unchanged = await recordPaymentTax(
    {
      actor: ownerActor(),
      companyId: COMPANY,
      paymentId: PAYMENT_ID,
      invoiceId: INVOICE_ID,
      paymentMinor: 333_300n,
      paymentStatus: "captured",
      paymentVersion: 3,
      invoiceTotalMinor: 1_000_000n,
      invoiceTaxMinor: 62_500n,
      paidBeforeMinor: 0n,
      collectedTaxBeforeMinor: 0n,
      nowEpochMs: NOW,
    },
    fixture.options,
  );

  expectEqual(unchanged.status, "unchanged", "the same share again writes nothing");
  expectEqual(fixture.audit.entries.length, 1, "and audits nothing");

  const settled = await recordPaymentTax(
    {
      actor: ownerActor(),
      companyId: COMPANY,
      paymentId: PAYMENT_ID,
      invoiceId: INVOICE_ID,
      paymentMinor: 333_300n,
      paymentStatus: "settled",
      paymentVersion: 3,
      invoiceTotalMinor: 1_000_000n,
      invoiceTaxMinor: 62_500n,
      paidBeforeMinor: 0n,
      collectedTaxBeforeMinor: 0n,
      nowEpochMs: NOW,
    },
    fixture.options,
  );

  expectEqual(settled.status, "refused", "a settled payment's tax is not rewritten");
  expectEqual(settled.status === "refused" ? settled.reason : "", "the tax of a settled payment is collected money and is not rewritten", "with the sentence that says why");

  const otherInvoice = await recordPaymentTax(
    {
      actor: ownerActor(),
      companyId: COMPANY,
      paymentId: PAYMENT_ID,
      invoiceId: OTHER_INVOICE_ID,
      paymentMinor: 333_300n,
      paymentStatus: "captured",
      paymentVersion: 3,
      invoiceTotalMinor: 1_000_000n,
      invoiceTaxMinor: 62_500n,
      paidBeforeMinor: 0n,
      collectedTaxBeforeMinor: 0n,
      nowEpochMs: NOW,
    },
    fixture.options,
  );

  expectEqual(otherInvoice.status, "refused", "a payment of another invoice is refused");
  expectEqual(otherInvoice.status === "refused" ? otherInvoice.reason : "", "the payment belongs to another invoice", "with the sentence that says why");

  const wrongAmount = await recordPaymentTax(
    {
      actor: ownerActor(),
      companyId: COMPANY,
      paymentId: PAYMENT_ID,
      invoiceId: INVOICE_ID,
      paymentMinor: 333_301n,
      paymentStatus: "captured",
      paymentVersion: 3,
      invoiceTotalMinor: 1_000_000n,
      invoiceTaxMinor: 62_500n,
      paidBeforeMinor: 0n,
      collectedTaxBeforeMinor: 0n,
      nowEpochMs: NOW,
    },
    fixture.options,
  );

  expectEqual(wrongAmount.status, "refused", "a payment whose amount is not the recorded one is refused");

  const unknown = await recordPaymentTax(
    {
      actor: ownerActor(),
      companyId: COMPANY,
      paymentId: "ef607182-93a4-45b6-c7d8-e9f0a1b2c3d4",
      invoiceId: INVOICE_ID,
      paymentMinor: 333_300n,
      paymentStatus: "captured",
      paymentVersion: 1,
      invoiceTotalMinor: 1_000_000n,
      invoiceTaxMinor: 62_500n,
      paidBeforeMinor: 0n,
      collectedTaxBeforeMinor: 0n,
      nowEpochMs: NOW,
    },
    fixture.options,
  );

  expectEqual(unknown.status, "refused", "a payment that does not exist is refused");
  expectEqual(unknown.status === "refused" ? unknown.reason : "", "no payment of this merchant has that id", "with the sentence that says why");

  // A settled row is frozen by the store as well, so a caller that skipped the check cannot write it.
  const frozen = fixtureOf();

  frozen.store.seedPayment({ ...payment, status: "settled", taxMinor: 20_831n });

  const frozenWrite = await frozen.store.writePaymentTax({
    companyId: COMPANY,
    paymentId: PAYMENT_ID,
    taxMinor: 1n,
    expectedVersion: 2,
    nowEpochMs: NOW,
  });

  expectEqual(frozenWrite, false, "the store refuses a settled payment's tax too");

  const staleVersion = await fixture.store.writePaymentTax({
    companyId: COMPANY,
    paymentId: PAYMENT_ID,
    taxMinor: 1n,
    expectedVersion: 1,
    nowEpochMs: NOW,
  });

  expectEqual(staleVersion, false, "a stale payment version writes nothing");

  const otherMerchant = await fixture.store.readPayment(OTHER_COMPANY, PAYMENT_ID);

  expectEqual(otherMerchant, null, "another merchant cannot read the payment");
}

/* ---- section 6: the rest adapter ---- */

interface Recorded {
  readonly calls: readonly { readonly method: string; readonly table: string; readonly query: string; readonly body: unknown }[];
}

interface RecordedAnswers {
  readonly invoiceVersions?: readonly number[];
  readonly lineRows?: readonly Readonly<Record<string, unknown>>[];
  readonly paymentRows?: readonly Readonly<Record<string, unknown>>[];
}

function restRecorderOf(answers: RecordedAnswers = {}): { readonly rest: RestClient; readonly recorded: Recorded } {
  const calls: { method: string; table: string; query: string; body: unknown }[] = [];
  let invoiceRead = 0;

  const rest: RestClient = {
    async select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
      calls.push({ method: "select", table, query, body: null });

      if (table === "invoices") {
        const versions = answers.invoiceVersions ?? [4];

        invoiceRead += 1;

        return [{ id: INVOICE_ID, company_id: COMPANY, tax_minor: "21000", version: versions[Math.min(invoiceRead - 1, versions.length - 1)] }] as unknown as readonly TRow[];
      }

      if (table === "invoice_tax_lines") return (answers.lineRows ?? []) as unknown as readonly TRow[];

      return (answers.paymentRows ?? [
        { id: PAYMENT_ID, company_id: COMPANY, invoice_id: INVOICE_ID, amount_minor: "333300", tax_minor: "0", status: "captured", version: 2 },
      ]) as unknown as readonly TRow[];
    },
    async insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      calls.push({ method: "insert", table, query: "", body: rows });
    },
    async insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
    ): Promise<readonly TRow[]> {
      calls.push({ method: "insertReturning", table, query: "", body: rows });

      return rows as unknown as readonly TRow[];
    },
    async update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      calls.push({ method: "update", table, query, body: values });
    },
    async rpc(name: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      calls.push({ method: "rpc", table: name, query: "", body: arguments_ });

      return null;
    },
  };

  return { rest, recorded: { calls } };
}

function callsOf(recorded: Recorded, method: string, table: string): readonly { readonly method: string; readonly table: string; readonly query: string; readonly body: unknown }[] {
  return recorded.calls.filter((call) => call.method === method && call.table === table);
}

async function checkRestAdapter(): Promise<void> {
  const recorder = restRecorderOf();
  const store = createTaxCloudTaxLineRestStore(recorder.rest);
  const fixture = fixtureOf();
  const result = await recordInvoiceTax(inputOf(), { store, audit: fixture.audit });
  const calls = recorder.recorded.calls;

  expectEqual(result.status, "stored", "the adapter stores through the rest client");
  expectEqual(calls.length, 6, "two reads, three writes and the read that proves the version");
  expectEqual(calls[0]?.method, "select", "the first call reads the invoice");
  expectEqual(calls[0]?.table, "invoices", "from the invoice table");
  expectEqual((calls[0]?.query ?? "").includes("tax_minor"), true, "asking for the tax it may already carry");
  expectEqual(calls[1]?.table, "invoice_tax_lines", "the second reads the lines it may already carry");

  const deletions = callsOf(recorder.recorded, "update", "invoice_tax_lines");

  expectEqual(deletions.length, 1, "one statement soft deletes the live lines");
  expect(deletions[0]?.query.includes(`invoice_id=eq.${INVOICE_ID}`) ?? false, "scoped to the invoice");
  expectEqual((deletions[0]?.body as Record<string, unknown>)["deleted_at"], new Date(NOW).toISOString(), "stamping the instant");

  const inserts = callsOf(recorder.recorded, "insert", "invoice_tax_lines");

  expectEqual(inserts.length, 1, "one statement inserts the new lines");
  expectEqual((inserts[0]?.body as readonly unknown[]).length, 2, "one row per line");
  expectEqual(((inserts[0]?.body as readonly Record<string, unknown>[])[0] ?? {})["tax_minor"], "13000", "with the tax as digits");
  expectEqual(((inserts[0]?.body as readonly Record<string, unknown>[])[0] ?? {})["rate_bp"], 813, "and the rate in basis points");

  const invoiceWrites = callsOf(recorder.recorded, "update", "invoices");

  expectEqual(invoiceWrites.length, 1, "one statement writes the invoice");
  expect(invoiceWrites[0]?.query.includes("version=eq.3") ?? false, "under the version that was read");
  expectEqual((invoiceWrites[0]?.body as Record<string, unknown>)["tax_minor"], "21000", "with the tax as digits");

  expectEqual(calls[5]?.method, "select", "the last call reads the invoice back");
  expectEqual(calls[5]?.table, "invoices", "to see whether the version moved");

  const conflicted = restRecorderOf({ invoiceVersions: [3] });
  const conflictedStore = createTaxCloudTaxLineRestStore(conflicted.rest);
  const conflictedFixture = fixtureOf();
  const lost = await recordInvoiceTax(inputOf(), { store: conflictedStore, audit: conflictedFixture.audit });
  const compensations = callsOf(conflicted.recorded, "update", "invoice_tax_lines");

  expectEqual(lost.status, "conflict", "a version that did not move is a conflict");
  expectEqual(lost.status === "conflict" ? conflictedFixture.audit.entries.length : -1, 0, "and audits nothing");
  expectEqual(compensations.length, 2, "the adapter compensates the rows it already wrote");
  expect(compensations[1]?.query.includes("calculated_at=eq.") ?? false, "targeting exactly those rows");
  expectEqual((compensations[1]?.body as Record<string, unknown>)["deleted_at"], new Date(NOW).toISOString(), "and soft deletes them");

  const readOnly = restRecorderOf({
    invoiceVersions: [7],
    lineRows: [
      {
        id: "row-1",
        company_id: COMPANY,
        invoice_id: INVOICE_ID,
        invoice_item_id: LINE_ONE,
        line_index: 0,
        tic: null,
        taxable_minor: "161250",
        tax_minor: "13000",
        rate_bp: 813,
        currency: "USD",
        provider_key: "taxcloud",
        calculated_at: new Date(NOW).toISOString(),
        version: 1,
      },
    ],
  });
  const readBack = await createTaxCloudTaxLineRestStore(readOnly.rest).readTax(COMPANY, INVOICE_ID);

  expectEqual(readBack.taxMinor, 21_000n, "the adapter reads the invoice's tax");
  expectEqual(readBack.lines.length, 1, "and its live lines");
  expectEqual(readBack.lines[0]?.taxMinor, 13_000n, "with their amounts");
  expectEqual(readBack.lines[0]?.rateBp, 813, "and their rates");

  const paymentRow = await createTaxCloudTaxLineRestStore(restRecorderOf().rest).readPayment(COMPANY, PAYMENT_ID);

  expectEqual(paymentRow?.paymentId, PAYMENT_ID, "the adapter reads the payment");
  expectEqual(paymentRow?.amountMinor, 333_300n, "with its amount");
  expectEqual(paymentRow?.status, "captured", "and its status");

  const writer = restRecorderOf({
    paymentRows: [
      { id: PAYMENT_ID, company_id: COMPANY, invoice_id: INVOICE_ID, amount_minor: "333300", tax_minor: "20831", status: "captured", version: 3 },
    ],
  });
  const wrote = await createTaxCloudTaxLineRestStore(writer.rest).writePaymentTax({
    companyId: COMPANY,
    paymentId: PAYMENT_ID,
    taxMinor: 20_831n,
    expectedVersion: 2,
    nowEpochMs: NOW,
  });

  expectEqual(wrote, true, "a payment whose version moved is written");
  expect(writer.recorded.calls[0]?.query.includes("version=eq.2") ?? false, "under the version that was read");
}

/* ---- section 7: the audit vocabulary and the source ---- */

function checkVocabularyAndSource(): void {
  expectEqual(TAXCLOUD_TAX_LINE_AUDIT_ACTIONS.join(","), "taxcloud.tax_line_stored,taxcloud.tax_line_cleared,taxcloud.payment_tax_stored", "three actions, one per fact");
  expectEqual(TAXCLOUD_TAX_LINE_STATUSES.join(","), "stored,cleared,unchanged,refused,conflict", "five answers");

  for (const action of TAXCLOUD_TAX_LINE_AUDIT_ACTIONS) {
    expect(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(action), `the action ${action} is a dotted lower case name`);
  }

  const source = readFileSync(new URL("./taxcloud-tax-line.ts", import.meta.url), "utf8");

  for (const method of ["log", "error", "warn", "info"]) {
    expectEqual(source.includes(["console", method].join(".")), false, `the source never calls console.${method}`);
  }

  expectEqual(source.includes("sandbox"), false, "the word the documentation refuses appears nowhere");
  expectEqual(source.includes("Authorization"), false, "the source builds no Authorization header");
  expectEqual(source.includes("fetch("), false, "the module makes no network call of its own");
  expectEqual(source.includes("interval="), false, "no client can ask for a tax it did not read");
  expectEqual(source.includes('"invoice_tax_lines"'), true, "the table is named once, as a constant");
  expect(source.includes("deleted_at: now"), "the soft delete is the only removal, because the table is history");

  const runtime = readFileSync(new URL("./taxcloud-tax-line-runtime.ts", import.meta.url), "utf8");

  expectEqual(runtime.includes(["console", "log"].join(".")), false, "the runtime never logs");
  expect(runtime.includes("getAuthRuntime"), "the runtime uses the platform's one rest client");
  expect(runtime.includes("createTaxCloudTaxLineRestStore"), "and the adapter above");
}

/* ---- running ---- */

checkMigration();
checkRate();
checkRows();
await checkWriter();
checkPaymentShare();
await checkPaymentWrite();
await checkRestAdapter();
checkVocabularyAndSource();

if (failures.length > 0) {
  process.stderr.write(
    `taxcloud tax line gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `taxcloud tax line gate passed: ${checks} checks (the tax is stored on the invoice's own tax column and on one row per line in a new table whose checks bound every amount, rate, TIC and currency, the breakdown is frozen once the invoice leaves draft by a database guard rather than a habit, a recalculation replaces the live rows instead of stacking a second answer, a lost version writes neither the rows nor an audit entry and the rest adapter compensates the two statements it already sent, the payment records the share of the tax it collected with the final payment taking the remainder so the parts are the whole, and a settled payment's collected tax is refused by the service and by the table)\n`,
);
